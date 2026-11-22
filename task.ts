import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Event, NamedSchema } from '@tak-ps/etl';
import type { Feature } from '@tak-ps/node-cot';
import ETL, { SchemaType, handler as internal, local, DataFlowType, InvocationType } from '@tak-ps/etl';
import FirstDue, { Dispatch, DEFAULT_BASE_URL } from './lib/firstdue.js';
import { EventCacheSchema, EventSync } from './lib/events.js';
import type { EventCache } from './lib/events.js';
import Geocoder from './lib/geocode.js';
import {
    DispatchSchema,
    DeviceSchema,
    addressLine,
    callOf,
    coordinates,
    deviceFeature,
    dispatchId,
    isOpen,
    isRecent,
    parseBBox,
    parseFallback,
    parseTimestamp
} from './lib/cad.js';
import type { Coordinate, LocationSource } from './lib/cad.js';

const DATA_TYPE_CAD = 'CAD';
const DATA_TYPE_AVL = 'AVL';

const SCHEMA_DISPATCH = 'dispatch';
const SCHEMA_DEVICE = 'device';

/** External ID system dispatch IDs are filed under on CloudTAK Events */
const EXTERNAL_SYSTEM = 'first-due';

/** Marks the Assignments this task manages so people added by users are left alone */
const ASSIGNMENT_REMARKS = 'First Due CAD Unit';

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
    DataType: Type.String({
        default: DATA_TYPE_CAD,
        enum: [DATA_TYPE_CAD, DATA_TYPE_AVL],
        description: 'CAD writes active dispatches to CloudTAK Events with their units as Assignments, AVL posts device locations'
    }),
    IncludeNotes: Type.Boolean({
        default: true,
        description: 'CAD Only: Include the CAD dispatch message and call notes in the Event remarks'
    }),
    EnrichDispatches: Type.Boolean({
        default: false,
        description: 'CAD Only: Also query GET /dispatches to add cross streets, radio channel and alarm level to each call - roughly doubles the number of API requests per poll'
    }),
    BoundingBox: Type.Optional(Type.String({
        description: 'CAD Only: Bounding Box of acceptable geocoded locations as minLon,minLat,maxLon,maxLat - ie -105.4,39.5,-104.6,40.0. Geocoded results outside of this box are discarded'
    })),
    FallbackCoordinates: Type.Optional(Type.String({
        description: 'CAD Only: Latitude,Longitude used to place calls that have no verified coordinates (and that could not be geocoded) - ie 38.8419,-105.0522. Unlocated calls are skipped when unset'
    })),
    MaxAgeHours: Type.Number({
        default: 24,
        minimum: 0,
        description: 'CAD Only: Ignore dispatches created more than this many hours ago, even if First Due still reports them as open - 0 disables the limit'
    }),
    ExpireHours: Type.Number({
        default: 1,
        minimum: 0.25,
        description: 'CAD Only: Hours after the last poll at which a dispatch Event ends on its own if this layer stops reporting - every poll of an active call pushes the expiry out again'
    }),
    StaleMinutes: Type.Integer({
        default: 10,
        minimum: 2,
        description: 'AVL Only: Minutes after the last successful poll before a device is shown as stale on TAK clients'
    }),
    DEBUG: Type.Boolean({
        default: false,
        description: 'Print raw API responses in the layer logs'
    })
});

/** The cached First Due token and the Event cache share the ephemeral store */
const Ephemeral = Type.Object({
    access_token: Type.Optional(Type.String()),
    access_token_expires: Type.Optional(Type.String()),
    events: Type.Optional(Type.Unknown())
});

export default class Task extends ETL {
    static name = 'etl-first-due'
    static flow = [ DataFlowType.Incoming ];
    static invocation = [ InvocationType.Schedule ];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming
    ): Promise<TSchema | Array<NamedSchema>> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) return InputSchema;

            return [
                { id: SCHEMA_DISPATCH, schema: DispatchSchema },
                { id: SCHEMA_DEVICE, schema: DeviceSchema }
            ];
        }

        return Type.Object({});
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
                await this.patchEphemeral({
                    access_token: token.access_token,
                    access_token_expires: String(token.expires)
                });
            }
        });

        if (env.DataType === DATA_TYPE_AVL) {
            await this.controlDevices(api, env);
        } else {
            await this.controlCalls(api, env, this.eventCache(ephemeral.events));
        }
    }

    /**
     * AVL device locations are posted to the map as CoT
     */
    async controlDevices(api: FirstDue, env: Static<typeof InputSchema>): Promise<void> {
        const features = new Map<string, Static<typeof Feature.InputFeature>>();

        const devices = await api.devices();

        for (const device of devices) {
            const feat = deviceFeature(device, { staleMinutes: env.StaleMinutes });
            if (feat && feat.id && !features.has(feat.id)) features.set(feat.id, feat);
        }

        console.log(`ok - obtained ${features.size} active locations from ${devices.length} devices`);

        await this.submit({
            type: 'FeatureCollection',
            features: Array.from(features.values())
        });
    }

    /**
     * Active dispatches are written to CloudTAK Events - one per First Due
     * dispatch ID - with the units dispatched to each call as Assignments.
     * Calls that are no longer active are ended
     */
    async controlCalls(api: FirstDue, env: Static<typeof InputSchema>, cache: EventCache): Promise<void> {
        // Calls can shift between pages while paginating - keep the first copy
        const dispatches = new Map<string, Static<typeof Dispatch>>();

        const since = env.MaxAgeHours > 0 ? new Date(Date.now() - env.MaxAgeHours * 60 * 60 * 1000) : undefined;

        let aged = 0;

        for (const dispatch of await api.active(since)) {
            const id = dispatchId(dispatch);
            if (!id || !isOpen(dispatch) || dispatches.has(id)) continue;

            if (!isRecent(dispatch, since)) {
                aged++;
                continue;
            }

            dispatches.set(id, dispatch);
        }

        if (aged > 0) console.log(`ok - ignored ${aged} open dispatches older than ${env.MaxAgeHours} hours`);

        if (env.EnrichDispatches && dispatches.size > 0) {
            await this.controlEnrich(api, dispatches);
        }

        const sync = new EventSync(this.api, cache, {
            system: EXTERNAL_SYSTEM,
            marker: ASSIGNMENT_REMARKS,
            expireHours: env.ExpireHours
        });

        const geocoder = await this.hasPermission('search:read')
            ? new Geocoder({
                api: this.etl.api,
                fetch: (url) => this.fetch(url),
                bbox: parseBBox(env.BoundingBox),
                debug: env.DEBUG
            })
            : null;

        const fallback = parseFallback(env.FallbackCoordinates);

        for (const [id, dispatch] of dispatches) {
            const located = await this.locate(env, geocoder, id, dispatch, fallback);

            if (!located) {
                console.log(`ok - skipping unlocated dispatch ${id}`);
                continue;
            }

            try {
                await sync.sync(callOf(id, dispatch, located.geometry, {
                    includeNotes: env.IncludeNotes,
                    source: located.source
                }));
            } catch (err) {
                console.error(`not ok - skipping dispatch ${id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        await sync.end();

        await this.patchEphemeral({ events: sync.cache });

        console.log(`ok - ${sync.summary()}`);
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
            const created = parseTimestamp(dispatch.created_at) ?? new Date();
            if (!since || created < since) since = created;
        }

        if (!since) return;

        let matched = 0;

        for (const detail of await api.dispatches(since)) {
            const id = dispatchId(detail);
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

    /**
     * Coordinates on the dispatch, then a geocode of its address, then the
     * configured fallback
     */
    async locate(
        env: Static<typeof InputSchema>,
        geocoder: Geocoder | null,
        id: string,
        dispatch: Static<typeof Dispatch>,
        fallback: Coordinate | null
    ): Promise<{ geometry: Coordinate; source: LocationSource } | null> {
        let geometry = coordinates(dispatch);
        if (geometry) return { geometry, source: 'cad' };

        const address = addressLine(dispatch);

        if (address && geocoder) {
            if (env.DEBUG) console.error(`DEBUG - dispatch ${id} has no coordinates - geocoding "${address}"`);
            geometry = await geocoder.locate(address);
            if (geometry) return { geometry, source: 'geocoded' };
        }

        if (env.DEBUG) console.error(`DEBUG - dispatch ${id} has no coordinates${fallback ? ' - using fallback' : ''}`);

        return fallback ? { geometry: fallback, source: 'fallback' } : null;
    }

    eventCache(events: unknown): EventCache {
        try {
            return this.type(EventCacheSchema, events ?? {});
        } catch {
            return {};
        }
    }

    /**
     * The ephemeral store is replaced on every write - merge so the cached
     * token and the Event cache never clobber each other
     */
    async patchEphemeral(values: Record<string, unknown>): Promise<void> {
        const layer = await this.fetchLayer();
        const ephemeral = { ...layer.incoming?.ephemeral, ...values };

        await this.setEphemeral(ephemeral);

        if (layer.incoming) layer.incoming.ephemeral = ephemeral;
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}): ReturnType<typeof internal> {
    return internal(await Task.init(import.meta.url), event);
}
