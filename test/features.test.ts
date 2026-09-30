import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { dispatchFeature, deviceFeature } from '../lib/features.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/active_dispatches.json', import.meta.url), 'utf8'));
const devices = JSON.parse(fs.readFileSync(new URL('./fixtures/device_locations.json', import.meta.url), 'utf8'));

const NOW = new Date('2026-09-10T20:10:00Z');

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

test('deviceFeature - located device', () => {
    const feat = deviceFeature(devices[0], { staleMinutes: 10, now: NOW });

    assert.ok(feat);
    assert.equal(feat.id, 'first-due-device-1');
    assert.deepEqual(feat.geometry, { type: 'Point', coordinates: [-105.05, 38.95] });
    assert.equal(feat.properties.callsign, 'DEMO-E1');
    assert.equal(feat.properties.type, 'a-f-G-E-V');
    assert.equal(feat.properties.time, '2026-09-10T20:05:00.000Z');
    assert.equal(feat.properties.stale, '2026-09-10T20:20:00.000Z');
    assert.match(feat.properties.remarks, /Unit: DEMO-E1/);
    assert.match(feat.properties.remarks, /Type: Fire Department Engine/);
    assert.match(feat.properties.remarks, /Status: Responding/);
    assert.match(feat.properties.remarks, /Responding To: 100 Example Training Road, Example City, CO/);
    assert.match(feat.properties.remarks, /Station: Training Station 1/);
    assert.equal(feat.properties.metadata.fire_station_id, 113);
    assert.equal('latitude' in feat.properties.metadata, false);
});

test('deviceFeature - unlocated, inactive & malformed', () => {
    assert.equal(deviceFeature(devices[1], { staleMinutes: 10, now: NOW }), null);
    assert.equal(deviceFeature(devices[2], { staleMinutes: 10, now: NOW }), null);
    assert.equal(deviceFeature({ ...devices[0], id: '' }, { staleMinutes: 10, now: NOW }), null);

    // No name falls back to the device id and no updated_at falls back to now
    const feat = deviceFeature({ id: 9, latitude: 38.95, longitude: -105.05 }, { staleMinutes: 10, now: NOW });
    assert.ok(feat);
    assert.equal(feat.properties.callsign, 'Device 9');
    assert.equal(feat.properties.time, NOW.toISOString());
    assert.doesNotMatch(feat.properties.remarks, /Status/);
});
