import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import type { Static } from '@sinclair/typebox';
import type { Dispatch, DeviceLocation } from '../lib/firstdue.js';
import {
    EVENT_SIDC,
    assignees,
    callOf,
    coordinates,
    deviceFeature,
    isOpen,
    parseBBox,
    parseFallback,
    parseTimestamp,
    text,
    within
} from '../lib/cad.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/active_dispatches.json', import.meta.url), 'utf8')) as Array<Static<typeof Dispatch>>;
const devices = JSON.parse(fs.readFileSync(new URL('./fixtures/device_locations.json', import.meta.url), 'utf8')) as Array<Static<typeof DeviceLocation>>;

const NOW = new Date('2026-09-10T20:10:00Z');

test('text', () => {
    assert.equal(text('  E1 '), 'E1');
    assert.equal(text(900001), '900001');
    assert.equal(text(''), null);
    assert.equal(text('   '), null);
    assert.equal(text(null), null);
    assert.equal(text(undefined), null);
    assert.equal(text(true), null);
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

test('parseFallback', () => {
    assert.equal(parseFallback(undefined), null);
    assert.equal(parseFallback('garbage'), null);
    assert.deepEqual(parseFallback('38.8419,-105.0522'), [-105.0522, 38.8419]);
    assert.deepEqual(parseFallback(' 38.8419 , -105.0522 '), [-105.0522, 38.8419]);
});

test('parseBBox & within', () => {
    assert.equal(parseBBox(undefined), null);
    assert.equal(parseBBox('garbage'), null);
    assert.equal(parseBBox('-104,38,-106,40'), null);

    const box = parseBBox(' -106, 38, -104, 40 ');
    assert.deepEqual(box, [-106, 38, -104, 40]);

    assert.equal(within(box, [-105, 39]), true);
    assert.equal(within(box, [-103, 39]), false);
    assert.equal(within(null, [-103, 39]), true);
});

test('parseTimestamp', () => {
    assert.equal(parseTimestamp('2026-09-10T20:00:00+00:00')?.toISOString(), '2026-09-10T20:00:00.000Z');
    assert.equal(parseTimestamp(null), null);
    assert.equal(parseTimestamp(''), null);
    assert.equal(parseTimestamp('not a date'), null);
});

test('isOpen', () => {
    assert.equal(isOpen({ status_code: 'open' }), true);
    assert.equal(isOpen({ status_code: null }), true);
    assert.equal(isOpen({}), true);
    assert.equal(isOpen({ status_code: 'closed' }), false);
});

test('assignees - one per distinct unit code', () => {
    assert.deepEqual(assignees({ unit_codes: ['E1', ' M2 ', '', 'E1'] }), [
        { name: 'E1', role: '' },
        { name: 'M2', role: '' }
    ]);
    assert.deepEqual(assignees({ unit_codes: null }), []);
    assert.deepEqual(assignees({}), []);
});

test('callOf - located call', () => {
    const call = callOf('900001', fixture[0], [-105.05, 38.95]);

    assert.equal(call.external, '900001');
    assert.equal(call.event.name, 'TRAINING ONLY - medical response (DEMO-2026-001)');
    assert.equal(call.event.type, EVENT_SIDC);
    assert.equal(call.event.priority, 'none');
    assert.deepEqual(call.event.geometry, { type: 'Point', coordinates: [-105.05, 38.95] });
    assert.equal(call.event.location, '100 Example Training Road Training room A, Example City, CO');
    assert.equal(call.event.started, '2026-09-10T20:00:00.000Z');
    assert.match(call.event.remarks, /Call: DEMO-2026-001/);
    assert.match(call.event.remarks, /First Due ID: 900001/);
    assert.match(call.event.remarks, /Call Notes:\n20:00Z Training call created/);
    assert.match(call.event.remarks, /Message:\nEXERCISE ONLY/);
    assert.doesNotMatch(call.event.remarks, /Location:/);
    assert.equal(call.event.metadata.located, true);
    assert.equal(call.event.metadata.xref_id, 'DEMO-2026-001');
    assert.deepEqual(call.event.metadata.unit_codes, ['DEMO-M1']);
    assert.equal('units' in call.event.metadata, false);
    assert.deepEqual(call.assignees, [{ name: 'DEMO-M1', role: '' }]);
    assert.equal(call.timeline, undefined);
});

test('callOf - is stable between polls', () => {
    const record = { ...fixture[0], created_at: null };

    assert.deepEqual(callOf('900001', record, [-105.05, 38.95]), callOf('900001', record, [-105.05, 38.95]));
    assert.equal(callOf('900001', record, [-105.05, 38.95]).event.started, undefined);
});

test('callOf - notes excluded', () => {
    const call = callOf('900001', fixture[0], [-105.05, 38.95], { includeNotes: false });

    assert.doesNotMatch(call.event.remarks, /Call Notes/);
    assert.doesNotMatch(call.event.remarks, /Message:/);
    assert.equal(call.event.metadata.call_notes, null);
    assert.equal(call.event.metadata.message, null);
});

test('callOf - geocoded & fallback locations', () => {
    const geocoded = callOf('900002', fixture[1], [-105.2, 38.7], { source: 'geocoded' });

    assert.equal(geocoded.event.name, 'TRAINING ONLY - location pending (DEMO-2026-002)');
    assert.match(geocoded.event.remarks, /Location: Geocoded from the address/);
    assert.equal(geocoded.event.metadata.located, false);

    const fallback = callOf('900002', fixture[1], [-105.0522, 38.8419], { source: 'fallback' });

    assert.equal(fallback.event.name, 'UNLOCATED - TRAINING ONLY - location pending (DEMO-2026-002)');
    assert.deepEqual(fallback.event.geometry, { type: 'Point', coordinates: [-105.0522, 38.8419] });
    assert.match(fallback.event.remarks, /Location: UNVERIFIED/);
    assert.equal(fallback.event.metadata.located, false);
    assert.deepEqual(fallback.assignees, []);
});

test('callOf - sparse record', () => {
    const call = callOf('900001', { id: 900001 }, [-105.05, 38.95]);

    assert.equal(call.event.name, 'Dispatch (900001)');
    assert.equal(call.event.location, '');
    assert.equal(call.event.remarks, 'Call: 900001\nType: Dispatch');
});

test('callOf - long names are clamped', () => {
    const call = callOf('900001', { ...fixture[0], type: 'A'.repeat(100) }, [-105.05, 38.95]);

    assert.equal(call.event.name.length, 64);
});

test('callOf - enriched fields', () => {
    const call = callOf('900001', {
        ...fixture[0],
        cross_streets: 'MAIN ST / 1ST AVE',
        radio_channel: 'TAC 2',
        alarm_level: '02',
        fire_stations: ['Station 1']
    }, [-105.05, 38.95]);

    assert.match(call.event.remarks, /Cross Streets: MAIN ST \/ 1ST AVE/);
    assert.match(call.event.remarks, /Radio: TAC 2/);
    assert.match(call.event.remarks, /Alarm Level: 02/);
    assert.match(call.event.remarks, /Stations: Station 1/);
    assert.equal(call.event.metadata.cross_streets, 'MAIN ST / 1ST AVE');
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
