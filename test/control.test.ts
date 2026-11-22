import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Static } from '@sinclair/typebox';
import type { Feature } from '@tak-ps/node-cot';
import type { CloudTAKAPI, CoreEventCreate } from '@tak-ps/etl';
import type { Dispatch, DeviceLocation } from '../lib/firstdue.js';

process.env.ETL_API = process.env.ETL_API || 'http://localhost:5001';
process.env.ETL_LAYER = process.env.ETL_LAYER || '1';
process.env.ETL_TOKEN = process.env.ETL_TOKEN || 'etl.test-token';

const { default: Task } = await import('../task.js');

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/active_dispatches.json', import.meta.url), 'utf8')) as Array<Static<typeof Dispatch>>;
const devices = JSON.parse(fs.readFileSync(new URL('./fixtures/device_locations.json', import.meta.url), 'utf8')) as Array<Static<typeof DeviceLocation>>;

type Mock = {
    base: string;
    requests: Array<{ method: string; url: string; auth: string | undefined }>;
    tokens: number;
    rejectFirst: boolean;
    close: () => Promise<void>;
};

/**
 * Minimal First Due API - token endpoint, a two page active dispatch feed,
 * a dispatches endpoint carrying the enrichment fields & an AVL device feed
 */
async function mock(opts: { rejectFirst?: boolean } = {}): Promise<Mock> {
    const state: Mock = {
        base: '',
        requests: [],
        tokens: 0,
        rejectFirst: opts.rejectFirst ?? false,
        close: async () => {}
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        state.requests.push({ method: req.method || '', url: req.url || '', auth: req.headers.authorization });

        const json = (code: number, body: unknown, headers: Record<string, string> = {}) => {
            res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify(body));
        };

        if (req.method === 'POST' && url.pathname === '/fd-api/v1/auth/token') {
            let body = '';
            req.on('data', (chunk: Buffer) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                const parsed = JSON.parse(body) as { grant_type?: string; email?: string; password?: string };
                if (parsed.grant_type !== 'client_credentials' || parsed.email !== 'api@example.com' || parsed.password !== 'secret') {
                    json(401, { code: 0, message: 'Incorrect email/password combination.' });
                    return;
                }
                state.tokens++;
                json(200, { access_token: `token-${state.tokens}`, expires_in: 1209600, scope: 'api web', token_type: 'bearer' });
            });
            return;
        }

        if (req.headers.authorization !== `Bearer token-${state.tokens}` || (state.rejectFirst && req.headers.authorization === 'Bearer stale-token')) {
            json(401, { code: 0, message: 'Your request was made with invalid credentials.' });
            return;
        }

        if (url.pathname === '/fd-api/v1/get-units-by-dispatches') {
            assert.equal(url.searchParams.get('active_only'), 'true');
            const page = Number(url.searchParams.get('page') || '1');

            if (page === 1) {
                json(200, [
                    { ...fixture[0], units: [{ id: 1, name: 'Responder Name', email: 'r@example.com', statuses: [] }] }
                ], {
                    // Documented example omits active_only on the link
                    Link: `<${state.base}/fd-api/v1/get-units-by-dispatches?page=2>; rel="next", <${state.base}/fd-api/v1/get-units-by-dispatches?page=2>; rel="last"`
                });
                return;
            }

            json(200, [
                fixture[1],
                { ...fixture[0], call_notes: 'duplicate across pages - should be ignored' },
                { id: 900003, xref_id: 'DEMO-2026-003', type: 'closed call', status_code: 'closed', latitude: 38.9, longitude: -105.1 }
            ], {
                Link: `<${state.base}/fd-api/v1/get-units-by-dispatches?page=1>; rel="first"`
            });
            return;
        }

        if (url.pathname === '/fd-api/v1/dispatches') {
            assert.equal(url.searchParams.get('since'), '2026-09-10T20:00:00Z');
            json(200, [
                { id: 900001, cross_streets: 'MAIN ST / 1ST AVE', radio_channel: 'TAC 2', alarm_level: '01', fire_stations: ['Station 1'] },
                { id: 123456, cross_streets: 'unrelated' }
            ]);
            return;
        }

        if (url.pathname === '/fd-api/v1/device-locations') {
            json(200, [...devices, devices[0]]);
            return;
        }

        json(404, { code: 0, message: 'not found' });
    });

    await once(server.listen(0, '127.0.0.1'), 'listening');
    state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    state.close = async () => {
        await once(server.close(), 'close');
    };

    return state;
}

type Recorded = { method: string; args: unknown[] };

type RunOptions = {
    ephemeral?: Record<string, unknown>;
    permissions?: string[];
    /** Location returned by the CloudTAK Search API for any address */
    geocode?: { x: number; y: number };
};

/**
 * A CloudTAKAPI stand-in recording every call - responses carry only the
 * fields EventSync reads
 */
function fake(calls: Recorded[]): CloudTAKAPI {
    let next = 1;

    const record = <T>(method: string, result: (...args: unknown[]) => T) => async (...args: unknown[]): Promise<T> => {
        calls.push({ method, args });
        return result(...args);
    };

    return {
        Event: {
            list: record('Event.list', () => ({ total: 0, items: [] })),
            create: record('Event.create', (body) => ({ id: `evt-${next++}`, ...(body as object) })),
            update: record('Event.update', (id, body) => ({ id, ...(body as object) }))
        },
        Assignment: {
            list: record('Assignment.list', () => ({ total: 0, items: [] })),
            create: record('Assignment.create', (event, body) => ({ id: 'asg-1', event, ...(body as object) })),
            update: record('Assignment.update', () => ({})),
            delete: record('Assignment.delete', () => ({ status: 200, message: 'Deleted' }))
        }
    } as unknown as CloudTAKAPI;
}

async function run(env: Record<string, unknown>, opts: RunOptions = {}) {
    const task = await Task.init();

    const layer = {
        id: 1,
        connection: 1,
        task: 'etl-first-due-v1.0.0',
        permissions: opts.permissions ?? [],
        incoming: { environment: env, ephemeral: opts.ephemeral ?? {} }
    };

    // @ts-expect-error partial layer for testing
    task.fetchLayer = async () => layer;
    // @ts-expect-error partial layer for testing
    task.layer = layer;

    task.setEphemeral = async (ephem: Record<string, unknown>) => {
        layer.incoming.ephemeral = ephem;
    };

    const calls: Recorded[] = [];
    task.api = fake(calls);

    const searches: string[] = [];
    task.fetch = async (url: string | URL) => {
        const search = new URL(url);
        searches.push(`${search.pathname}?query=${search.searchParams.get('query')}`);

        if (search.pathname === '/api/search/suggest') {
            return { items: opts.geocode ? [{ text: search.searchParams.get('query'), magicKey: 'key' }] : [] };
        }

        return { items: opts.geocode ? [{ address: 'matched', location: opts.geocode, score: 100 }] : [] };
    };

    const submissions: Array<Static<typeof Feature.InputFeatureCollection>> = [];
    task.submit = async (fc: Static<typeof Feature.InputFeatureCollection>) => {
        submissions.push(fc);
        return true;
    };

    await task.control();

    return { submitted: submissions.at(-1) ?? null, calls, searches, ephemeral: layer.incoming.ephemeral };
}

const created = (calls: Recorded[]) => calls
    .filter((c) => c.method === 'Event.create')
    .map((c) => c.args[0] as CoreEventCreate);

function environment(api: Mock, values: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        Email: 'api@example.com',
        Password: 'secret',
        BaseURL: `${api.base}/fd-api/v1/`,
        IncludeNotes: true,
        EnrichDispatches: false,
        MaxAgeHours: 0,
        ExpireHours: 1,
        StaleMinutes: 10,
        DEBUG: false,
        ...values
    };
}

test('control - paginates, dedupes, drops closed & skips unlocated', async () => {
    const api = await mock();

    try {
        const { submitted, calls, searches, ephemeral } = await run(environment(api));

        assert.equal(api.tokens, 1);
        assert.equal(ephemeral.access_token, 'token-1');
        assert.ok(Number(ephemeral.access_token_expires) > Date.now());

        assert.deepEqual(api.requests.map((r) => r.url), [
            '/fd-api/v1/auth/token',
            '/fd-api/v1/get-units-by-dispatches?active_only=true',
            '/fd-api/v1/get-units-by-dispatches?page=2&active_only=true'
        ]);

        assert.equal(submitted, null);
        assert.deepEqual(searches, []);
        assert.deepEqual(calls.map((c) => c.method), ['Event.list', 'Event.create', 'Assignment.create']);

        const [event] = created(calls);
        assert.deepEqual(event.external_id, { system: 'first-due', value: '900001' });
        assert.equal(event.name, 'TRAINING ONLY - medical response (DEMO-2026-001)');
        assert.match(event.remarks, /20:00Z Training call created/);
        assert.equal('units' in event.metadata, false);
        assert.ok(event.ended);

        assert.deepEqual(calls[2].args, ['evt-1', { name: 'DEMO-M1', role: '', remarks: 'First Due CAD Unit' }]);

        const events = ephemeral.events as Record<string, { id: string }>;
        assert.deepEqual(Object.keys(events), ['900001']);
        assert.equal(events['900001'].id, 'evt-1');
    } finally {
        await api.close();
    }
});

test('control - open dispatches older than MaxAgeHours are ignored & their Events ended', async () => {
    const api = await mock();

    try {
        const first = await run(environment(api));
        assert.deepEqual(Object.keys(first.ephemeral.events as object), ['900001']);

        const second = await run(environment(api, { MaxAgeHours: 24 }), { ephemeral: first.ephemeral });

        const feed = new URL(api.requests.at(-1)?.url ?? '', api.base);
        assert.equal(feed.searchParams.get('active_only'), 'true');
        assert.match(feed.searchParams.get('since') ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

        assert.deepEqual(second.calls, [{ method: 'Event.update', args: ['evt-1', { active: false }] }]);
        assert.deepEqual(second.ephemeral.events, {});
    } finally {
        await api.close();
    }
});

test('control - an unchanged call costs no CloudTAK writes & a call leaving the active feed is ended', async () => {
    const api = await mock();

    try {
        const first = await run(environment(api, { FallbackCoordinates: '38.8419,-105.0522' }));
        assert.deepEqual(Object.keys(first.ephemeral.events as object), ['900001', '900002']);

        const second = await run(environment(api, { FallbackCoordinates: '38.8419,-105.0522' }), { ephemeral: first.ephemeral });
        assert.deepEqual(second.calls, []);
        assert.equal(api.tokens, 1);

        // Without FallbackCoordinates the unlocated call is no longer synced
        const third = await run(environment(api), { ephemeral: second.ephemeral });
        assert.deepEqual(third.calls, [{ method: 'Event.update', args: ['evt-2', { active: false }] }]);
        assert.deepEqual(Object.keys(third.ephemeral.events as object), ['900001']);
        assert.equal(third.ephemeral.access_token, 'token-1');
    } finally {
        await api.close();
    }
});

test('control - reuses cached token & re-authenticates once on 401', async () => {
    const api = await mock({ rejectFirst: true });

    try {
        const { calls, ephemeral } = await run(environment(api, { FallbackCoordinates: '38.8419,-105.0522' }), {
            ephemeral: {
                access_token: 'stale-token',
                access_token_expires: String(Date.now() + 60 * 60 * 1000)
            }
        });

        assert.equal(api.tokens, 1);
        assert.equal(ephemeral.access_token, 'token-1');

        assert.deepEqual(api.requests.map((r) => `${r.url} ${r.auth}`), [
            '/fd-api/v1/get-units-by-dispatches?active_only=true Bearer stale-token',
            '/fd-api/v1/auth/token undefined',
            '/fd-api/v1/get-units-by-dispatches?active_only=true Bearer token-1',
            '/fd-api/v1/get-units-by-dispatches?page=2&active_only=true Bearer token-1'
        ]);

        const events = created(calls);
        assert.equal(events.length, 2);

        const unlocated = events.find((e) => e.external_id?.value === '900002');
        assert.ok(unlocated);
        assert.deepEqual(unlocated.geometry, { type: 'Point', coordinates: [-105.0522, 38.8419] });
        assert.match(unlocated.name, /^UNLOCATED - /);
        assert.equal(unlocated.metadata.located, false);
    } finally {
        await api.close();
    }
});

test('control - unlocated calls are geocoded when the layer has search:read', async () => {
    const api = await mock();

    try {
        const { calls, searches } = await run(environment(api, {
            BoundingBox: '-106,38,-104,40',
            FallbackCoordinates: '38.8419,-105.0522'
        }), {
            permissions: ['search:read'],
            geocode: { x: -105.2, y: 38.7 }
        });

        assert.deepEqual(searches, [
            '/api/search/suggest?query=Fictional location pending verification, Example City, CO',
            '/api/search/forward?query=Fictional location pending verification, Example City, CO'
        ]);

        const geocoded = created(calls).find((e) => e.external_id?.value === '900002');
        assert.ok(geocoded);
        assert.deepEqual(geocoded.geometry, { type: 'Point', coordinates: [-105.2, 38.7] });
        assert.doesNotMatch(geocoded.name, /UNLOCATED/);
        assert.match(geocoded.remarks, /Location: Geocoded from the address/);
        assert.equal(geocoded.metadata.located, false);
    } finally {
        await api.close();
    }
});

test('control - enrichment merges GET /dispatches fields', async () => {
    const api = await mock();

    try {
        const { calls } = await run(environment(api, { IncludeNotes: false, EnrichDispatches: true }));

        assert.ok(api.requests.some((r) => r.url.startsWith('/fd-api/v1/dispatches?since=')));

        const [event] = created(calls);
        assert.equal(event.metadata.cross_streets, 'MAIN ST / 1ST AVE');
        assert.equal(event.metadata.radio_channel, 'TAC 2');
        assert.equal(event.metadata.alarm_level, '01');
        assert.match(event.remarks, /Cross Streets: MAIN ST \/ 1ST AVE/);
        assert.doesNotMatch(event.remarks, /Call Notes/);
    } finally {
        await api.close();
    }
});

test('control - AVL posts located & active devices', async () => {
    const api = await mock();

    try {
        const { submitted, calls } = await run(environment(api, {
            DataType: 'AVL',
            EnrichDispatches: true,
            FallbackCoordinates: '38.8419,-105.0522'
        }));

        assert.deepEqual(api.requests.map((r) => r.url), [
            '/fd-api/v1/auth/token',
            '/fd-api/v1/device-locations'
        ]);

        assert.deepEqual(calls, []);
        assert.ok(submitted);
        assert.equal('schema' in submitted, false);
        assert.equal(submitted.features.length, 1);
        assert.equal(submitted.features[0].id, 'first-due-device-1');
        assert.equal(submitted.features[0].properties.callsign, 'DEMO-E1');
        assert.deepEqual(submitted.features[0].geometry.coordinates, [-105.05, 38.95]);
    } finally {
        await api.close();
    }
});

test('control - bad credentials fail the poll without writing', async () => {
    const api = await mock();

    try {
        await assert.rejects(run(environment(api, { Password: 'wrong' })), /First Due Authentication Failed: 401/);
    } finally {
        await api.close();
    }
});
