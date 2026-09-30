import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Event, NamedSchema } from '@tak-ps/etl';
import type { Feature } from '@tak-ps/node-cot';
import ETL, { SchemaType, handler as internal, local, DataFlowType, InvocationType } from '@tak-ps/etl';
import FirstDue, { Dispatch, DEFAULT_BASE_URL } from './lib/firstdue.js';
import { DispatchSchema, DeviceSchema, dispatchFeature, deviceFeature } from './lib/features.js';
import type { FeatureOptions } from './lib/features.js';
import { text, fallback, timestamp } from './lib/parse.js';

const DATA_TYPE_CAD = 'CAD';
const DATA_TYPE_AVL = 'AVL';

const SCHEMA_DISPATCH = 'dispatch';
const SCHEMA_DEVICE = 'device';

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
        description: 'CAD posts active dispatch locations, AVL posts device locations'
    }),
    IncludeNotes: Type.Boolean({
        default: true,
        description: 'CAD Only: Include the CAD dispatch message and call notes in the marker remarks'
    }),
    EnrichDispatches: Type.Boolean({
        default: false,
        description: 'CAD Only: Also query GET /dispatches to add cross streets, radio channel and alarm level to each call - roughly doubles the number of API requests per poll'
    }),
    FallbackCoordinates: Type.Optional(Type.String({
        description: 'CAD Only: Latitude,Longitude used to place calls that have no verified coordinates - ie 38.8419,-105.0522. Unlocated calls are skipped when unset'
    })),
    StaleMinutes: Type.Integer({
        default: 10,
        minimum: 2,
        description: 'Minutes after the last successful poll before a marker is shown as stale on TAK clients'
    }),
    DEBUG: Type.Boolean({
        default: false,
        description: 'Print raw API responses in the layer logs'
    })
});

const Ephemeral = Type.Object({
    access_token: Type.Optional(Type.String()),
    access_token_expires: Type.Optional(Type.String())
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
            if (type === SchemaType.Input) {
                return InputSchema;
            } else {
                return [
                    { id: SCHEMA_DISPATCH, schema: DispatchSchema },
                    { id: SCHEMA_DEVICE, schema: DeviceSchema }
                ];
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

        const fc: Static<typeof Feature.InputFeatureCollection> = {
            type: 'FeatureCollection',
            features: []
        };

        if (env.DataType === DATA_TYPE_AVL) {
            fc.features = await this.controlDevices(api, env);
        } else {
            fc.features = await this.controlDispatches(api, env);
        }

        await this.submit(fc);
    }

    async controlDevices(
        api: FirstDue,
        env: Static<typeof InputSchema>
    ): Promise<Array<Static<typeof Feature.InputFeature>>> {
        const features = new Map<string, Static<typeof Feature.InputFeature>>();

        const devices = await api.devices();

        for (const device of devices) {
            const feat = deviceFeature(device, { staleMinutes: env.StaleMinutes });
            if (feat && feat.id && !features.has(feat.id)) features.set(feat.id, feat);
        }

        console.log(`ok - obtained ${features.size} active locations from ${devices.length} devices`);

        return Array.from(features.values());
    }

    async controlDispatches(
        api: FirstDue,
        env: Static<typeof InputSchema>
    ): Promise<Array<Static<typeof Feature.InputFeature>>> {
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

        const features: Array<Static<typeof Feature.InputFeature>> = [];

        for (const dispatch of dispatches.values()) {
            const feat = dispatchFeature(dispatch, opts);
            if (feat) features.push(feat);
        }

        console.log(`ok - obtained ${features.length} active calls from ${dispatches.size} dispatches`);

        return features;
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
