import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Event } from '@tak-ps/etl';
import { Feature } from '@tak-ps/node-cot'
import ETL, { SchemaType, handler as internal, local, DataFlowType, InvocationType, fetch } from '@tak-ps/etl';

const Nullable = <T extends TSchema>(type: T) => Type.Union([Type.Null(), type]);

const DEFAULT_BASE_URL = 'https://sizeup.firstduesizeup.com/fd-api/v1/';

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

/**
 * Dispatch record as returned by GET /get-units-by-dispatches - the nested
 * `units` array (user names, emails & status history) is intentionally not
 * modelled and is never forwarded to the map
 */
const Dispatch = Type.Object({
    id: Type.Union([Type.Integer(), Type.String()]),
    xref_id: Type.Optional(Nullable(Type.String())),
    type: Type.Optional(Nullable(Type.String())),
    status_code: Type.Optional(Nullable(Type.String())),
    incident_type_code: Type.Optional(Nullable(Type.String())),
    unit_codes: Type.Optional(Nullable(Type.Array(Type.String()))),
    created_at: Type.Optional(Nullable(Type.String())),
    place_name: Type.Optional(Nullable(Type.String())),
    address: Type.Optional(Nullable(Type.String())),
    address2: Type.Optional(Nullable(Type.String())),
    city: Type.Optional(Nullable(Type.String())),
    state_code: Type.Optional(Nullable(Type.String())),
    location: Type.Optional(Nullable(Type.String())),
    latitude: Type.Optional(Nullable(Type.Union([Type.Number(), Type.String()]))),
    longitude: Type.Optional(Nullable(Type.Union([Type.Number(), Type.String()]))),
    message: Type.Optional(Nullable(Type.String())),
    call_notes: Type.Optional(Nullable(Type.String())),
    // Only present on GET /dispatches - merged in when EnrichDispatches is enabled
    cross_streets: Type.Optional(Nullable(Type.String())),
    radio_channel: Type.Optional(Nullable(Type.String())),
    alarm_level: Type.Optional(Nullable(Type.String())),
    fire_zone: Type.Optional(Nullable(Type.String())),
    fire_stations: Type.Optional(Nullable(Type.Array(Type.String())))
});

const OutputSchema = Type.Composite([
    Type.Omit(Dispatch, ['latitude', 'longitude']),
    Type.Object({
        located: Type.Boolean({ description: 'False when the call had no verified coordinates and was placed at FallbackCoordinates' })
    })
]);

const TokenResponse = Type.Object({
    access_token: Type.String(),
    token_type: Type.Optional(Type.String()),
    expires_in: Type.Optional(Type.Integer()),
    scope: Type.Optional(Type.String())
});

// Documented token lifetime is 1209600s (14 days) - refresh an hour early
const TOKEN_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000;

const ACTIVE_PATH = 'get-units-by-dispatches';
const DISPATCHES_PATH = 'dispatches';
const MAX_PAGES = 50;

type Unknowns = Record<string, unknown>;

function isObject(value: unknown): value is Unknowns {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

/**
 * Resolve the rel="next" target of an RFC 5988 Link header against the page
 * that returned it. Only same-origin targets are followed and the active_only
 * filter is re-applied as the documented examples omit it
 */
export function nextLink(header: string | null | undefined, current: URL, params: Record<string, string>): URL | null {
    if (!header) return null;

    const pattern = /<([^>]+)>\s*;\s*rel="([^"]+)"/g;

    for (const match of header.matchAll(pattern)) {
        if (!match[2].split(/\s+/).includes('next')) continue;

        const next = new URL(match[1], current);
        if (next.origin !== current.origin) {
            throw new Error(`Refusing to follow pagination link to a different origin: ${next.origin}`);
        }

        for (const [key, value] of Object.entries(params)) {
            next.searchParams.set(key, value);
        }

        return next;
    }

    return null;
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
    ): Promise<TSchema> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) {
                return InputSchema;
            } else {
                return OutputSchema;
            }
        } else {
            return Type.Object({});
        }
    }

    async control(): Promise<void> {
        const env = await this.env(InputSchema);

        const base = new URL(env.BaseURL || DEFAULT_BASE_URL);
        if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;

        const records = await this.controlPages(env, base, ACTIVE_PATH, { active_only: 'true' });

        // Calls can shift between pages while paginating - keep the first copy
        const dispatches = new Map<string, Static<typeof Dispatch>>();

        for (const record of records) {
            let dispatch: Static<typeof Dispatch>;

            try {
                dispatch = this.type(Dispatch, record);
            } catch (err) {
                console.error(`not ok - skipping malformed dispatch: ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }

            const id = text(dispatch.id);
            if (id && !dispatches.has(id)) dispatches.set(id, dispatch);
        }

        if (env.EnrichDispatches && dispatches.size) {
            await this.controlEnrich(env, base, dispatches);
        }

        const opts: FeatureOptions = {
            includeNotes: env.IncludeNotes,
            fallback: fallback(env.FallbackCoordinates),
            staleMinutes: env.StaleMinutes
        };

        const fc: Static<typeof Feature.InputFeatureCollection> = {
            type: 'FeatureCollection',
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
     * GET /dispatches carries cross streets, radio channel & alarm level which
     * the active call endpoint omits. It only filters on creation time so the
     * oldest active call bounds the query
     */
    async controlEnrich(
        env: Static<typeof InputSchema>,
        base: URL,
        dispatches: Map<string, Static<typeof Dispatch>>
    ): Promise<void> {
        let since: Date | null = null;

        for (const dispatch of dispatches.values()) {
            const created = timestamp(dispatch.created_at, new Date());
            if (!since || created < since) since = created;
        }

        if (!since) return;

        const params: Record<string, string> = {
            since: since.toISOString().replace(/\.\d{3}Z$/, 'Z')
        };

        let matched = 0;

        for (const record of await this.controlPages(env, base, DISPATCHES_PATH, params)) {
            const id = text(record.id);
            const dispatch = id ? dispatches.get(id) : undefined;
            if (!dispatch) continue;

            matched++;

            for (const key of ['cross_streets', 'radio_channel', 'alarm_level', 'fire_zone', 'fire_stations'] as const) {
                const value = record[key];

                if (key === 'fire_stations') {
                    if (Array.isArray(value)) dispatch.fire_stations = value.filter((v): v is string => typeof v === 'string');
                } else if (typeof value === 'string') {
                    dispatch[key] = value;
                }
            }
        }

        console.log(`ok - enriched ${matched}/${dispatches.size} dispatches`);
    }

    /**
     * Obtain a Bearer Token, reusing the cached token until an hour before it expires
     */
    async controlToken(env: Static<typeof InputSchema>, base: URL, force = false): Promise<string> {
        const layer = await this.fetchLayer();
        const ephemeral = layer.incoming?.ephemeral ?? {};

        if (
            !force
            && ephemeral.access_token
            && ephemeral.access_token_expires
            && Number(ephemeral.access_token_expires) > +new Date()
        ) {
            return String(ephemeral.access_token);
        }

        console.log('ok - requesting new token');

        const res = await fetch(new URL('auth/token', base), {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                email: env.Email,
                password: env.Password
            }),
            safeUrlAllow: [base.origin]
        });

        if (!res.ok) {
            throw new Error(`First Due Authentication Failed: ${res.status} ${await res.text()}`);
        }

        const token = await res.typed(TokenResponse);

        const lifetime = token.expires_in ? token.expires_in * 1000 : TOKEN_LIFETIME_MS;
        const margin = Math.min(TOKEN_REFRESH_MARGIN_MS, lifetime / 2);

        await this.setEphemeral({
            access_token: token.access_token,
            access_token_expires: String(+new Date() + lifetime - margin)
        });

        return token.access_token;
    }

    /**
     * Follow Link header pagination for a collection endpoint, returning every
     * record. A single re-authentication is attempted if the cached token is
     * rejected. Any page failure aborts the poll so a partial snapshot is never
     * submitted
     */
    async controlPages(
        env: Static<typeof InputSchema>,
        base: URL,
        path: string,
        params: Record<string, string>
    ): Promise<Unknowns[]> {
        const records: Unknowns[] = [];

        let token = await this.controlToken(env, base);
        let refreshed = false;

        let url: URL | null = new URL(path, base);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        const visited = new Set<string>();

        for (let page = 0; url && page < MAX_PAGES; page++) {
            if (visited.has(url.toString())) {
                throw new Error(`First Due pagination loop detected at ${url}`);
            }
            visited.add(url.toString());

            let res = await this.controlPage(base, url, token);

            if (res.status === 401 && !refreshed) {
                console.log('ok - cached token rejected, re-authenticating');
                refreshed = true;
                token = await this.controlToken(env, base, true);
                res = await this.controlPage(base, url, token);
            }

            if (!res.ok) {
                throw new Error(`First Due ${path} Failed: ${res.status} ${await res.text()}`);
            }

            const body = await res.json() as unknown;

            if (env.DEBUG) console.error(`DEBUG - ${url}: ${JSON.stringify(body)}`);

            if (!Array.isArray(body)) {
                throw new Error(`First Due ${path} returned an unexpected response shape`);
            }

            records.push(...body.filter(isObject));

            url = nextLink(res.headers.get('link'), url, params);

            if (url && page === MAX_PAGES - 1) {
                console.log(`ok - MAX_PAGES (${MAX_PAGES}) reached, ${path} results were truncated`);
            }
        }

        return records;
    }

    async controlPage(base: URL, url: URL, token: string) {
        return await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`
            },
            safeUrlAllow: [base.origin]
        });
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(await Task.init(import.meta.url), event);
}
