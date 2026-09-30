import test from 'node:test';
import assert from 'node:assert';
import { text, coordinates, fallback, timestamp } from '../lib/parse.js';

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

test('fallback', () => {
    assert.equal(fallback(undefined), null);
    assert.equal(fallback('garbage'), null);
    assert.deepEqual(fallback('38.8419,-105.0522'), [-105.0522, 38.8419]);
    assert.deepEqual(fallback(' 38.8419 , -105.0522 '), [-105.0522, 38.8419]);
});

test('timestamp', () => {
    const now = new Date('2026-09-10T20:10:00Z');

    assert.equal(timestamp('2026-09-10T20:00:00+00:00', now).toISOString(), '2026-09-10T20:00:00.000Z');
    assert.equal(timestamp(null, now), now);
    assert.equal(timestamp('', now), now);
    assert.equal(timestamp('not a date', now), now);
});
