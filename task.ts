import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Event, NamedSchema } from '@tak-ps/etl';
import { Feature } from '@tak-ps/node-cot'
import ETL, { SchemaType, handler as internal, local, DataFlowType, InvocationType, SubmitFeatureCollection } from '@tak-ps/etl';
import FirstDue, { Dispatch, DEFAULT_BASE_URL } from './lib/firstdue.js';

const SCHEMA_DISPATCH = 'dispatch';

const InputSchema = Type.Object({
    Email: Type.String({
        description: 'Email of the First Due API service account'
    }),
    Password: Type.String({
        description: 'Password of the First Due API service account'
    }),
    BaseURL: Type.String({
        default: DEFAULT_BASE_URL,
        description: 'Base URL of the First Due REST API'
    }),
    IncludeNotes: Type.Boolean({
        default: true,
        description: 'Include the CAD dispatch message and call notes in the marker remarks'
    }),
    EnrichDispatches: Type.Boolean({
        default: false,
        description: 'Also query GET /dispatches to add cross streets, radio channel and alarm level to each call - roughly doubles the number of API requests per poll'
    }),
    FallbackCoordinates: Type.Optional(Type.String({
        description: 'Latitude,Longitude used to place calls that have no verified coordinates - ie 38.8419,-105.0522. Unlocated calls are skipped when unset'
    })),
    StaleMinutes: Type.Integer({
        default: 10,
        minimum: 2,
        description: 'Minutes after the last successful poll before a call marker is shown as stale on TAK clients'
    }),
    DEBUG: Type.Boolean({
        default: false,
        description: 'Print raw API responses in the layer logs'
    })
});

const OutputSchema = Type.Composite([
    Type.Omit(Dispatch, ['latitude', 'longitude']),
    Type.Object({
        located: Type.Boolean({ description: 'False when the call had no verified coordinates and was placed at FallbackCoordinates' })
    })
]);

const Ephemeral = Type.Object({
    access_token: Type.Optional(Type.String()),
    access_token_expires: Type.Optional(Type.String())
});

function text(value: unknown): string | null {
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

export function toCoordinate(value: unknown): number | null {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

/**
 * Verified WGS84 point from the record or null - 0,0 and out of range values
 * are treated as unlocated rather than plotted
 */
export function coordinates(record: { latitude?: unknown; longitude?: unknown }): [number, number] | null {
    const lat = toCoordinate(record.latitude);
    const lon = toCoordinate(record.longitude);

    if (lat === null || lon === null) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    if (lat === 0 && lon === 0) return null;

    return [lon, lat];
}

export function fallback(value?: string): [number, number] | null {
    if (!value) return null;

    const [lat, lon] = value.split(',').map((part) => toCoordinate(part.trim()));

    if (lat === null || lat === undefined || lon === null || lon === undefined) {
        console.error(`not ok - invalid FallbackCoordinates: ${value}`);
        return null;
    }

    return [lon, lat];
}

function timestamp(value: unknown, fallback: Date): Date {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function addressLine(dispatch: Static<typeof Dispatch>): string | null {
    const street = [text(dispatch.address), text(dispatch.address2)].filter((part) => part !== null).join(' ');
    const parts = [street || null, text(dispatch.city), text(dispatch.state_code)].filter((part) => part !== null);
    return parts.length ? parts.join(', ') : text(dispatch.location);
}

function remarks(lines: Array<string | null>): string | undefined {
    const body = lines.filter((line) => line !== null).join('\n');
    return body || undefined;
}

export type FeatureOptions = {
    includeNotes: boolean;
    fallback: [number, number] | null;
    staleMinutes: number;
    now?: Date;
};

/**
 * Map a single active dispatch to a CoT Feature - returns null for closed
 * calls and for unlocated calls when no FallbackCoordinates are configured
 */
export function dispatchFeature(
    dispatch: Static<typeof Dispatch>,
    opts: FeatureOptions
): Static<typeof Feature.InputFeature> | null {
    const id = text(dispatch.id);
    if (!id) return null;

    if (text(dispatch.status_code) && text(dispatch.status_code) !== 'open') {
        return null;
    }

    let geometry = coordinates(dispatch);
    const located = geometry !== null;

    if (!geometry) {
        geometry = opts.fallback;
        if (!geometry) {
            console.log(`ok - skipping unlocated dispatch ${id}`);
            return null;
        }
    }

    const now = opts.now ?? new Date();
    const start = timestamp(dispatch.created_at, now);

    const reference = text(dispatch.xref_id) ?? id;
    const type = text(dispatch.type) ?? text(dispatch.incident_type_code) ?? 'Dispatch';
    const units = (dispatch.unit_codes ?? []).map((unit) => unit.trim()).filter((unit) => unit);
    const address = addressLine(dispatch);

    const metadata: Static<typeof OutputSchema> = {
        id: dispatch.id,
        xref_id: text(dispatch.xref_id),
        type: text(dispatch.type),
        status_code: text(dispatch.status_code),
        incident_type_code: text(dispatch.incident_type_code),
        unit_codes: units,
        created_at: start.toISOString(),
        place_name: text(dispatch.place_name),
        address: text(dispatch.address),
        address2: text(dispatch.address2),
        city: text(dispatch.city),
        state_code: text(dispatch.state_code),
        location: text(dispatch.location),
        message: opts.includeNotes ? text(dispatch.message) : null,
        call_notes: opts.includeNotes ? text(dispatch.call_notes) : null,
        cross_streets: text(dispatch.cross_streets),
        radio_channel: text(dispatch.radio_channel),
        alarm_level: text(dispatch.alarm_level),
        fire_zone: text(dispatch.fire_zone),
        fire_stations: dispatch.fire_stations ?? null,
        located
    };

    return {
        id: `first-due-${id}`,
        type: 'Feature',
        properties: {
            callsign: `${located ? '' : 'UNLOCATED - '}${type} (${reference})`,
            type: 'a-f-G-U-i',
            how: 'h-g-i-g-o',
            time: start.toISOString(),
            start: start.toISOString(),
            stale: new Date(now.getTime() + opts.staleMinutes * 60 * 1000).toISOString(),
            remarks: remarks([
                `Call: ${reference}`,
                text(dispatch.xref_id) ? `First Due ID: ${id}` : null,
                `Type: ${type}`,
                metadata.incident_type_code && metadata.incident_type_code !== type ? `Incident Code: ${metadata.incident_type_code}` : null,
                metadata.status_code ? `Status: ${metadata.status_code}` : null,
                metadata.alarm_level ? `Alarm Level: ${metadata.alarm_level}` : null,
                `Created: ${start.toISOString()}`,
                located ? null : 'Location: UNVERIFIED - no coordinates provided by CAD',
                metadata.place_name ? `Place: ${metadata.place_name}` : null,
                address ? `Address: ${address}` : null,
                metadata.cross_streets ? `Cross Streets: ${metadata.cross_streets}` : null,
                metadata.radio_channel ? `Radio: ${metadata.radio_channel}` : null,
                units.length ? `Units: ${units.join(', ')}` : null,
                metadata.fire_stations && metadata.fire_stations.length ? `Stations: ${metadata.fire_stations.join(', ')}` : null,
                metadata.message ? `\nMessage:\n${metadata.message}` : null,
                metadata.call_notes ? `\nCall Notes:\n${metadata.call_notes}` : null
            ]),
            metadata
        },
        geometry: {
            type: 'Point',
            coordinates: geometry
        }
    };
}

export default class Task extends ETL {
    static name = 'etl-first-due'
    static flow = [ DataFlowType.Incoming ];
    static invocation = [ InvocationType.Schedule ];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming
    ): Promise<TSchema | Array<NamedSchema>> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) {
                return InputSchema;
            } else {
                return [{ id: SCHEMA_DISPATCH, schema: OutputSchema }];
            }
        } else {
            return Type.Object({});
        }
    }

    async control(): Promise<void> {
        const env = await this.env(InputSchema);
        const ephemeral = await this.ephemeral(Ephemeral);

        const api = new FirstDue({
            url: env.BaseURL,
            email: env.Email,
            password: env.Password,
            debug: env.DEBUG,
            token: {
                access_token: ephemeral.access_token,
                expires: Number(ephemeral.access_token_expires)
            },
            onToken: async (token) => {
                await this.setEphemeral({
                    access_token: token.access_token,
                    access_token_expires: String(token.expires)
                });
            }
        });

        // Calls can shift between pages while paginating - keep the first copy
        const dispatches = new Map<string, Static<typeof Dispatch>>();

        for (const dispatch of await api.active()) {
            const id = text(dispatch.id);
            if (id && !dispatches.has(id)) dispatches.set(id, dispatch);
        }

        if (env.EnrichDispatches && dispatches.size) {
            await this.controlEnrich(api, dispatches);
        }

        const opts: FeatureOptions = {
            includeNotes: env.IncludeNotes,
            fallback: fallback(env.FallbackCoordinates),
            staleMinutes: env.StaleMinutes
        };

        const fc: Static<typeof SubmitFeatureCollection> = {
            type: 'FeatureCollection',
            schema: SCHEMA_DISPATCH,
            features: []
        };

        for (const dispatch of dispatches.values()) {
            const feat = dispatchFeature(dispatch, opts);
            if (feat) fc.features.push(feat);
        }

        console.log(`ok - obtained ${fc.features.length} active calls from ${dispatches.size} dispatches`);

        await this.submit(fc);
    }

    /**
     * GET /dispatches only filters on creation time so the oldest active call
     * bounds the query
     */
    async controlEnrich(
        api: FirstDue,
        dispatches: Map<string, Static<typeof Dispatch>>
    ): Promise<void> {
        let since: Date | null = null;

        for (const dispatch of dispatches.values()) {
            const created = timestamp(dispatch.created_at, new Date());
            if (!since || created < since) since = created;
        }

        if (!since) return;

        let matched = 0;

        for (const detail of await api.dispatches(since)) {
            const id = text(detail.id);
            const dispatch = id ? dispatches.get(id) : undefined;
            if (!dispatch) continue;

            matched++;

            dispatch.cross_streets = detail.cross_streets ?? dispatch.cross_streets;
            dispatch.radio_channel = detail.radio_channel ?? dispatch.radio_channel;
            dispatch.alarm_level = detail.alarm_level ?? dispatch.alarm_level;
            dispatch.fire_zone = detail.fire_zone ?? dispatch.fire_zone;
            dispatch.fire_stations = detail.fire_stations ?? dispatch.fire_stations;
        }

        console.log(`ok - enriched ${matched}/${dispatches.size} dispatches`);
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(await Task.init(import.meta.url), event);
}
