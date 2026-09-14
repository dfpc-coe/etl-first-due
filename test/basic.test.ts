import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { SchemaType, DataFlowType } from '@tak-ps/etl';

// task.ts calls Task.init() at module scope which requires an ETL environment,
// so these must be set before the dynamic import below
process.env.ETL_API = process.env.ETL_API || 'http://localhost:5001';
process.env.ETL_LAYER = process.env.ETL_LAYER || '1';
process.env.ETL_TOKEN = process.env.ETL_TOKEN || 'etl.test-token';

const { default: Task, coordinates, fallback, nextLink, dispatchFeature } = await import('../task.js');

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/active_dispatches.json', import.meta.url), 'utf8'));

const NOW = new Date('2026-09-10T20:10:00Z');

test('Task static config', () => {
    assert.equal(Task.name, 'etl-first-due');
    assert.deepEqual(Task.flow, [DataFlowType.Incoming]);
});

test('Incoming Input schema', async () => {
    const task = await Task.init();
    const schema = await task.schema(SchemaType.Input, DataFlowType.Incoming);

    assert.equal(schema.type, 'object');

    for (const key of ['Email', 'Password', 'BaseURL', 'IncludeNotes', 'EnrichDispatches', 'FallbackCoordinates', 'StaleMinutes', 'DEBUG']) {
        assert.ok(schema.properties[key], `Env schema missing property: ${key}`);
    }

    assert.equal(schema.properties.IncludeNotes.default, true);
    assert.equal(schema.properties.EnrichDispatches.default, false);
    assert.equal(schema.properties.StaleMinutes.default, 10);
});

test('Incoming Output schema', async () => {
    const task = await Task.init();
    const schema = await task.schema(SchemaType.Output, DataFlowType.Incoming);

    assert.equal(schema.type, 'object');
    for (const key of ['id', 'xref_id', 'type', 'status_code', 'unit_codes', 'call_notes', 'message', 'cross_streets', 'located']) {
        assert.ok(schema.properties[key], `Output schema missing property: ${key}`);
    }
    assert.ok(!schema.properties.latitude);
    assert.ok(!schema.properties.units);
});

test('coordinates', () => {
    assert.deepEqual(coordinates({ latitude: 38.95, longitude: -105.05 }), [-105.05, 38.95]);
    assert.deepEqual(coordinates({ latitude: '38.95', longitude: '-105.05' }), [-105.05, 38.95]);
    assert.equal(coordinates({ latitude: null, longitude: null }), null);
    assert.equal(coordinates({}), null);
    assert.equal(coordinates({ latitude: 0, longitude: 0 }), null);
    assert.equal(coordinates({ latitude: 95, longitude: -105 }), null);
    assert.equal(coordinates({ latitude: 38, longitude: -181 }), null);
    assert.equal(coordinates({ latitude: 'abc', longitude: -105 }), null);
    assert.equal(coordinates({ latitude: true, longitude: -105 }), null);
});

test('fallback', () => {
    assert.equal(fallback(undefined), null);
    assert.equal(fallback('garbage'), null);
    assert.deepEqual(fallback('38.8419,-105.0522'), [-105.0522, 38.8419]);
    assert.deepEqual(fallback(' 38.8419 , -105.0522 '), [-105.0522, 38.8419]);
});

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

test('dispatchFeature - located call', () => {
    const feat = dispatchFeature(fixture[0], { includeNotes: true, fallback: null, staleMinutes: 10, now: NOW });

    assert.ok(feat);
    assert.equal(feat.id, 'first-due-900001');
    assert.deepEqual(feat.geometry, { type: 'Point', coordinates: [-105.05, 38.95] });
    assert.equal(feat.properties.callsign, 'TRAINING ONLY - medical response (DEMO-2026-001)');
    assert.equal(feat.properties.type, 'a-f-G-U-i');
    assert.equal(feat.properties.start, '2026-09-10T20:00:00.000Z');
    assert.equal(feat.properties.stale, '2026-09-10T20:20:00.000Z');
    assert.match(feat.properties.remarks, /Call: DEMO-2026-001/);
    assert.match(feat.properties.remarks, /First Due ID: 900001/);
    assert.match(feat.properties.remarks, /Address: 100 Example Training Road Training room A, Example City, CO/);
    assert.match(feat.properties.remarks, /Units: DEMO-M1/);
    assert.match(feat.properties.remarks, /Call Notes:\n20:00Z Training call created/);
    assert.match(feat.properties.remarks, /Message:\nEXERCISE ONLY/);
    assert.equal(feat.properties.metadata.located, true);
    assert.equal(feat.properties.metadata.xref_id, 'DEMO-2026-001');
    assert.deepEqual(feat.properties.metadata.unit_codes, ['DEMO-M1']);
    assert.equal('units' in feat.properties.metadata, false);
});

test('dispatchFeature - notes excluded', () => {
    const feat = dispatchFeature(fixture[0], { includeNotes: false, fallback: null, staleMinutes: 10, now: NOW });

    assert.ok(feat);
    assert.doesNotMatch(feat.properties.remarks, /Call Notes/);
    assert.doesNotMatch(feat.properties.remarks, /Message:/);
    assert.equal(feat.properties.metadata.call_notes, null);
    assert.equal(feat.properties.metadata.message, null);
});

test('dispatchFeature - unlocated call', () => {
    assert.equal(dispatchFeature(fixture[1], { includeNotes: true, fallback: null, staleMinutes: 10, now: NOW }), null);

    const feat = dispatchFeature(fixture[1], { includeNotes: true, fallback: [-105.0522, 38.8419], staleMinutes: 10, now: NOW });

    assert.ok(feat);
    assert.equal(feat.id, 'first-due-900002');
    assert.deepEqual(feat.geometry, { type: 'Point', coordinates: [-105.0522, 38.8419] });
    assert.equal(feat.properties.callsign, 'UNLOCATED - TRAINING ONLY - location pending (DEMO-2026-002)');
    assert.match(feat.properties.remarks, /Location: UNVERIFIED/);
    assert.equal(feat.properties.metadata.located, false);
});

test('dispatchFeature - closed & malformed', () => {
    assert.equal(dispatchFeature({ ...fixture[0], status_code: 'closed' }, { includeNotes: true, fallback: null, staleMinutes: 10, now: NOW }), null);
    assert.equal(dispatchFeature({ ...fixture[0], id: '' }, { includeNotes: true, fallback: null, staleMinutes: 10, now: NOW }), null);

    // No xref_id falls back to the First Due id and no created_at falls back to now
    const feat = dispatchFeature({ ...fixture[0], xref_id: null, created_at: null, status_code: null }, { includeNotes: true, fallback: null, staleMinutes: 10, now: NOW });
    assert.ok(feat);
    assert.equal(feat.properties.callsign, 'TRAINING ONLY - medical response (900001)');
    assert.equal(feat.properties.start, NOW.toISOString());
    assert.doesNotMatch(feat.properties.remarks, /First Due ID/);
});

test('dispatchFeature - enriched fields', () => {
    const feat = dispatchFeature({
        ...fixture[0],
        cross_streets: 'MAIN ST / 1ST AVE',
        radio_channel: 'TAC 2',
        alarm_level: '02',
        fire_stations: ['Station 1']
    }, { includeNotes: true, fallback: null, staleMinutes: 10, now: NOW });

    assert.ok(feat);
    assert.match(feat.properties.remarks, /Cross Streets: MAIN ST \/ 1ST AVE/);
    assert.match(feat.properties.remarks, /Radio: TAC 2/);
    assert.match(feat.properties.remarks, /Alarm Level: 02/);
    assert.match(feat.properties.remarks, /Stations: Station 1/);
    assert.equal(feat.properties.metadata.cross_streets, 'MAIN ST / 1ST AVE');
});
