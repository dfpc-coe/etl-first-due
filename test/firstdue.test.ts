import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import FirstDue, { nextLink } from '../lib/firstdue.js';
import type { Token } from '../lib/firstdue.js';

test('nextLink', () => {
    const current = new URL('https://sizeup.firstduesizeup.com/fd-api/v1/get-units-by-dispatches?active_only=true&page=1');
    const params = { active_only: 'true' };

    assert.equal(nextLink(null, current, params), null);
    assert.equal(nextLink('', current, params), null);

    const header = '<https://sizeup.firstduesizeup.com/fd-api/v1/get-units-by-dispatches?page=2>; rel="next", <https://sizeup.firstduesizeup.com/fd-api/v1/get-units-by-dispatches?page=7>; rel="last"';
    const next = nextLink(header, current, params);
    assert.ok(next);
    assert.equal(next.pathname, '/fd-api/v1/get-units-by-dispatches');
    assert.equal(next.searchParams.get('page'), '2');
    assert.equal(next.searchParams.get('active_only'), 'true');

    // Only a last relation => final page
    assert.equal(nextLink('<https://sizeup.firstduesizeup.com/fd-api/v1/get-units-by-dispatches?page=7>; rel="last"', current, params), null);

    // Relative links resolve against the current page
    const relative = nextLink('</fd-api/v1/get-units-by-dispatches?page=3&since=2019-02-16T00:00:00Z>; rel="next"', current, params);
    assert.ok(relative);
    assert.equal(relative.origin, current.origin);
    assert.equal(relative.searchParams.get('page'), '3');
    assert.equal(relative.searchParams.get('since'), '2019-02-16T00:00:00Z');

    assert.throws(() => {
        nextLink('<https://evil.example.com/fd-api/v1/get-units-by-dispatches?page=2>; rel="next"', current, params);
    }, /different origin/);
});

test('FirstDue - caches issued tokens & skips malformed records', async () => {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.url === '/fd-api/v1/auth/token') {
            return res.end(JSON.stringify({ access_token: 'token-1', expires_in: 7200 }));
        }

        res.end(JSON.stringify([
            { id: 1, type: 'fire', latitude: '38.1', units: [{ email: 'r@example.com' }] },
            { type: 'no id' },
            { id: 2, unit_codes: { code: 'E1' } },
            'garbage',
            null
        ]));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        const tokens: Token[] = [];

        const api = new FirstDue({
            // No trailing slash & an expired token
            url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/fd-api/v1`,
            email: 'api@example.com',
            password: 'secret',
            token: { access_token: 'expired', expires: +new Date() - 1000 },
            onToken: async (token) => {
                tokens.push(token);
            }
        });

        assert.deepEqual(await api.active(), [{ id: 1, type: 'fire', latitude: '38.1' }]);

        assert.equal(tokens.length, 1);
        assert.equal(tokens[0].access_token, 'token-1');

        // A 2 hour token is refreshed an hour early
        const remaining = tokens[0].expires - +new Date();
        assert.ok(remaining > 59 * 60 * 1000 && remaining <= 60 * 60 * 1000);

        await api.active();
        assert.equal(tokens.length, 1);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
