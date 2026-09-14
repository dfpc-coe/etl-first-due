import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Static } from '@sinclair/typebox';
import type { Feature } from '@tak-ps/node-cot';

process.env.ETL_API = process.env.ETL_API || 'http://localhost:5001';
process.env.ETL_LAYER = process.env.ETL_LAYER || '1';
process.env.ETL_TOKEN = process.env.ETL_TOKEN || 'etl.test-token';

const { default: Task } = await import('../task.js');

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/active_dispatches.json', import.meta.url), 'utf8'));

type Mock = {
    base: string;
    requests: Array<{ method: string; url: string; auth: string | undefined }>;
    tokens: number;
    rejectFirst: boolean;
    close: () => Promise<void>;
};

/**
 * Minimal First Due API - token endpoint, a two page active dispatch feed &
 * a dispatches endpoint carrying the enrichment fields
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
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                const parsed = JSON.parse(body);
                if (parsed.grant_type !== 'client_credentials' || parsed.email !== 'api@example.com' || parsed.password !== 'secret') {
                    return json(401, { code: 0, message: 'Incorrect email/password combination.' });
                }
                state.tokens++;
                json(200, { access_token: `token-${state.tokens}`, expires_in: 1209600, scope: 'api web', token_type: 'bearer' });
            });
            return;
        }

        if (req.headers.authorization !== `Bearer token-${state.tokens}` || (state.rejectFirst && req.headers.authorization === 'Bearer stale-token')) {
            return json(401, { code: 0, message: 'Your request was made with invalid credentials.' });
        }

        if (url.pathname === '/fd-api/v1/get-units-by-dispatches') {
            assert.equal(url.searchParams.get('active_only'), 'true');
            const page = Number(url.searchParams.get('page') || '1');

            if (page === 1) {
                return json(200, [
                    { ...fixture[0], units: [{ id: 1, name: 'Responder Name', email: 'r@example.com', statuses: [] }] }
                ], {
                    // Documented example omits active_only on the link
                    Link: `<${state.base}/fd-api/v1/get-units-by-dispatches?page=2>; rel="next", <${state.base}/fd-api/v1/get-units-by-dispatches?page=2>; rel="last"`
                });
            } else {
                return json(200, [
                    fixture[1],
                    { ...fixture[0], call_notes: 'duplicate across pages - should be ignored' },
                    { id: 900003, xref_id: 'DEMO-2026-003', type: 'closed call', status_code: 'closed', latitude: 38.9, longitude: -105.1 }
                ], {
                    Link: `<${state.base}/fd-api/v1/get-units-by-dispatches?page=1>; rel="first"`
                });
            }
        }

        if (url.pathname === '/fd-api/v1/dispatches') {
            assert.equal(url.searchParams.get('since'), '2026-09-10T20:00:00Z');
            return json(200, [
                { id: 900001, cross_streets: 'MAIN ST / 1ST AVE', radio_channel: 'TAC 2', alarm_level: '01', fire_stations: ['Station 1'] },
                { id: 123456, cross_streets: 'unrelated' }
            ]);
        }

        json(404, { code: 0, message: 'not found' });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    state.close = () => new Promise((resolve) => server.close(() => resolve()));

    return state;
}

async function run(api: Mock, environment: Record<string, unknown>, ephemeral: Record<string, unknown> = {}) {
    const task = await Task.init();

    const layer = {
        id: 1,
        connection: 1,
        task: 'etl-first-due-v1.0.0',
        incoming: { environment, ephemeral }
    };

    // @ts-expect-error partial layer for testing
    task.fetchLayer = async () => layer;
    // @ts-expect-error private in base
    task.layer = layer;

    task.setEphemeral = async (ephem: Record<string, unknown>) => {
        layer.incoming.ephemeral = ephem;
    };

    let submitted: Static<typeof Feature.InputFeatureCollection> | null = null;
    task.submit = async (fc: Static<typeof Feature.InputFeatureCollection>) => {
        submitted = fc;
        return true;
    };

    await task.control();

    return { submitted, ephemeral: layer.incoming.ephemeral };
}

test('control - paginates, dedupes, drops closed & skips unlocated', async () => {
    const api = await mock();

    try {
        const { submitted, ephemeral } = await run(api, {
            Email: 'api@example.com',
            Password: 'secret',
            BaseURL: `${api.base}/fd-api/v1/`,
            IncludeNotes: true,
            EnrichDispatches: false,
            StaleMinutes: 10,
            DEBUG: false
        });

        assert.equal(api.tokens, 1);
        assert.equal(ephemeral.access_token, 'token-1');
        assert.ok(Number(ephemeral.access_token_expires) > +new Date());

        const paths = api.requests.map((r) => r.url);
        assert.deepEqual(paths, [
            '/fd-api/v1/auth/token',
            '/fd-api/v1/get-units-by-dispatches?active_only=true',
            '/fd-api/v1/get-units-by-dispatches?page=2&active_only=true'
        ]);

        assert.ok(submitted);
        assert.equal(submitted.features.length, 1);
        assert.equal(submitted.features[0].id, 'first-due-900001');
        assert.match(submitted.features[0].properties.remarks, /20:00Z Training call created/);
        assert.equal('units' in submitted.features[0].properties.metadata, false);
    } finally {
        await api.close();
    }
});

test('control - reuses cached token & re-authenticates once on 401', async () => {
    const api = await mock({ rejectFirst: true });

    try {
        const { submitted, ephemeral } = await run(api, {
            Email: 'api@example.com',
            Password: 'secret',
            BaseURL: `${api.base}/fd-api/v1/`,
            IncludeNotes: true,
            EnrichDispatches: false,
            FallbackCoordinates: '38.8419,-105.0522',
            StaleMinutes: 10,
            DEBUG: false
        }, {
            access_token: 'stale-token',
            access_token_expires: String(+new Date() + 60 * 60 * 1000)
        });

        assert.equal(api.tokens, 1);
        assert.equal(ephemeral.access_token, 'token-1');

        assert.deepEqual(api.requests.map((r) => `${r.url} ${r.auth}`), [
            '/fd-api/v1/get-units-by-dispatches?active_only=true Bearer stale-token',
            '/fd-api/v1/auth/token undefined',
            '/fd-api/v1/get-units-by-dispatches?active_only=true Bearer token-1',
            '/fd-api/v1/get-units-by-dispatches?page=2&active_only=true Bearer token-1'
        ]);

        assert.equal(submitted.features.length, 2);
        const unlocated = submitted.features.find((f) => f.id === 'first-due-900002');
        assert.ok(unlocated);
        assert.deepEqual(unlocated.geometry.coordinates, [-105.0522, 38.8419]);
        assert.equal(unlocated.properties.metadata.located, false);
    } finally {
        await api.close();
    }
});

test('control - enrichment merges GET /dispatches fields', async () => {
    const api = await mock();

    try {
        const { submitted } = await run(api, {
            Email: 'api@example.com',
            Password: 'secret',
            BaseURL: `${api.base}/fd-api/v1/`,
            IncludeNotes: false,
            EnrichDispatches: true,
            StaleMinutes: 10,
            DEBUG: false
        });

        assert.ok(api.requests.some((r) => r.url.startsWith('/fd-api/v1/dispatches?since=')));

        const feat = submitted.features[0];
        assert.equal(feat.properties.metadata.cross_streets, 'MAIN ST / 1ST AVE');
        assert.equal(feat.properties.metadata.radio_channel, 'TAC 2');
        assert.equal(feat.properties.metadata.alarm_level, '01');
        assert.match(feat.properties.remarks, /Cross Streets: MAIN ST \/ 1ST AVE/);
        assert.doesNotMatch(feat.properties.remarks, /Call Notes/);
    } finally {
        await api.close();
    }
});

test('control - bad credentials fail the poll without submitting', async () => {
    const api = await mock();

    try {
        await assert.rejects(run(api, {
            Email: 'api@example.com',
            Password: 'wrong',
            BaseURL: `${api.base}/fd-api/v1/`,
            IncludeNotes: true,
            EnrichDispatches: false,
            StaleMinutes: 10,
            DEBUG: false
        }), /First Due Authentication Failed: 401/);
    } finally {
        await api.close();
    }
});
