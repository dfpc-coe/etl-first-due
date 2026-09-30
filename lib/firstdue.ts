import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { fetch } from '@tak-ps/etl';

export const DEFAULT_BASE_URL = 'https://sizeup.firstduesizeup.com/fd-api/v1/';

// Documented token lifetime is 1209600s (14 days) - refresh an hour early
const TOKEN_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000;

const ACTIVE_PATH = 'get-units-by-dispatches';
const DISPATCHES_PATH = 'dispatches';
const DEVICES_PATH = 'device-locations';
const MAX_PAGES = 50;

const Nullable = <T extends TSchema>(type: T) => Type.Union([Type.Null(), type]);

/**
 * Dispatch record as returned by GET /get-units-by-dispatches - the nested
 * `units` array (user names, emails & status history) is intentionally not
 * modelled and is never forwarded to the map
 */
export const Dispatch = Type.Object({
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

/** Fields of a GET /dispatches record that the active call endpoint omits */
export const DispatchDetail = Type.Pick(Dispatch, [
    'id',
    'cross_streets',
    'radio_channel',
    'alarm_level',
    'fire_zone',
    'fire_stations'
]);

/** AVL record as returned by GET /device-locations */
export const DeviceLocation = Type.Object({
    id: Type.Union([Type.Integer(), Type.String()]),
    name: Type.Optional(Nullable(Type.String())),
    type: Type.Optional(Nullable(Type.String())),
    latitude: Type.Optional(Nullable(Type.Union([Type.Number(), Type.String()]))),
    longitude: Type.Optional(Nullable(Type.Union([Type.Number(), Type.String()]))),
    status_code: Type.Optional(Nullable(Type.String())),
    updated_at: Type.Optional(Nullable(Type.String())),
    responder_status: Type.Optional(Nullable(Type.String())),
    responder_status_code: Type.Optional(Nullable(Type.String())),
    responding_address: Type.Optional(Nullable(Type.String())),
    responding_dispatch_place_location: Type.Optional(Nullable(Type.String())),
    fire_station_id: Type.Optional(Nullable(Type.Union([Type.Integer(), Type.String()]))),
    fire_station_name_or_number: Type.Optional(Nullable(Type.String()))
});

const TokenResponse = Type.Object({
    access_token: Type.String(),
    token_type: Type.Optional(Type.String()),
    expires_in: Type.Optional(Type.Integer()),
    scope: Type.Optional(Type.String())
});

export type Token = {
    access_token: string;
    expires: number;
};

export type FirstDueOptions = {
    url?: string;
    email: string;
    password: string;
    debug?: boolean;
    // Previously issued token - ignored once expired
    token?: Partial<Token>;
    // Called with every newly issued token so that it can be cached
    onToken?: (token: Token) => Promise<void>;
};

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

/**
 * Thin client over the First Due REST API dispatch & AVL endpoints this task uses
 */
export default class FirstDue {
    base: URL;
    email: string;
    password: string;
    debug: boolean;
    token?: string;
    refreshed = false;
    onToken?: (token: Token) => Promise<void>;

    constructor(opts: FirstDueOptions) {
        this.base = new URL(opts.url || DEFAULT_BASE_URL);
        if (!this.base.pathname.endsWith('/')) this.base.pathname = `${this.base.pathname}/`;

        this.email = opts.email;
        this.password = opts.password;
        this.debug = opts.debug ?? false;
        this.onToken = opts.onToken;

        if (opts.token?.access_token && opts.token.expires && opts.token.expires > +new Date()) {
            this.token = opts.token.access_token;
        }
    }

    /** Active calls - GET /get-units-by-dispatches?active_only=true */
    async active(): Promise<Array<Static<typeof Dispatch>>> {
        return await this.list(ACTIVE_PATH, Dispatch, { active_only: 'true' });
    }

    /**
     * GET /dispatches carries cross streets, radio channel & alarm level which
     * the active call endpoint omits. It only filters on creation time
     */
    async dispatches(since: Date): Promise<Array<Static<typeof DispatchDetail>>> {
        return await this.list(DISPATCHES_PATH, DispatchDetail, {
            since: since.toISOString().replace(/\.\d{3}Z$/, 'Z')
        });
    }

    /** AVL device locations - GET /device-locations */
    async devices(): Promise<Array<Static<typeof DeviceLocation>>> {
        return await this.list(DEVICES_PATH, DeviceLocation, {});
    }

    /** Request a Bearer Token, expiring it an hour before First Due does */
    async authenticate(): Promise<string> {
        console.log('ok - requesting new token');

        const res = await fetch(new URL('auth/token', this.base), {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                email: this.email,
                password: this.password
            }),
            safeUrlAllow: [this.base.origin]
        });

        if (!res.ok) {
            throw new Error(`First Due Authentication Failed: ${res.status} ${await res.text()}`);
        }

        const token = await res.typed(TokenResponse);

        const lifetime = token.expires_in ? token.expires_in * 1000 : TOKEN_LIFETIME_MS;
        const margin = Math.min(TOKEN_REFRESH_MARGIN_MS, lifetime / 2);

        this.token = token.access_token;

        if (this.onToken) {
            await this.onToken({
                access_token: token.access_token,
                expires: +new Date() + lifetime - margin
            });
        }

        return this.token;
    }

    /** Authenticated GET - a single re-authentication is attempted if the token is rejected */
    async get(url: URL) {
        let res = await this.request(url, this.token ?? await this.authenticate());

        if (res.status === 401 && !this.refreshed) {
            console.log('ok - cached token rejected, re-authenticating');
            this.refreshed = true;
            res = await this.request(url, await this.authenticate());
        }

        return res;
    }

    /**
     * Follow Link header pagination for a collection endpoint, returning every
     * record that conforms to the schema. Any page failure throws so that a
     * partial snapshot is never returned
     */
    async list<T extends TSchema>(
        path: string,
        schema: T,
        params: Record<string, string>
    ): Promise<Array<Static<T>>> {
        const records: Array<Static<T>> = [];

        let url: URL | null = new URL(path, this.base);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        const visited = new Set<string>();

        for (let page = 0; url && page < MAX_PAGES; page++) {
            if (visited.has(url.toString())) {
                throw new Error(`First Due pagination loop detected at ${url}`);
            }
            visited.add(url.toString());

            const res = await this.get(url);

            if (!res.ok) {
                throw new Error(`First Due ${path} Failed: ${res.status} ${await res.text()}`);
            }

            const body = await res.json() as unknown;

            if (this.debug) console.error(`DEBUG - ${url}: ${JSON.stringify(body)}`);

            if (!Array.isArray(body)) {
                throw new Error(`First Due ${path} returned an unexpected response shape`);
            }

            for (const record of body) {
                try {
                    records.push(Value.Parse(schema, record));
                } catch (err) {
                    console.error(`not ok - skipping malformed ${path} record: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            url = nextLink(res.headers.get('link'), url, params);

            if (url && page === MAX_PAGES - 1) {
                console.log(`ok - MAX_PAGES (${MAX_PAGES}) reached, ${path} results were truncated`);
            }
        }

        return records;
    }

    private async request(url: URL, token: string) {
        return await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`
            },
            safeUrlAllow: [this.base.origin]
        });
    }
}
