import test from 'node:test';
import assert from 'node:assert';
import type { CloudTAKAPI } from '@tak-ps/etl';
import { EventSync } from '../lib/events.js';
import type { EventCache, SyncedCall } from '../lib/events.js';

type Recorded = { method: string; args: unknown[] };

type FakeOptions = {
    /** Events returned by the index built on a cache miss */
    events?: Array<{ id: string; external_ids: Record<string, string> }>;
    /** Error thrown by every Timeline upsert */
    upsert?: Error;
};

/**
 * A CloudTAKAPI stand-in recording every call - responses carry only the
 * fields EventSync reads
 */
function fake(calls: Recorded[], opts: FakeOptions = {}): CloudTAKAPI {
    let next = 1;

    const record = <T>(method: string, result: (...args: unknown[]) => T) => async (...args: unknown[]): Promise<T> => {
        calls.push({ method, args });
        return result(...args);
    };

    return {
        Event: {
            list: record('Event.list', () => ({ total: (opts.events ?? []).length, items: opts.events ?? [] })),
            create: record('Event.create', (body) => ({ id: `evt-${next++}`, ...(body as object) })),
            update: record('Event.update', (id, body) => ({ id, ...(body as object) }))
        },
        Assignment: {
            list: record('Assignment.list', () => ({ total: 0, items: [] })),
            create: record('Assignment.create', (event, body) => ({ id: 'asg-1', event, ...(body as object) })),
            update: record('Assignment.update', () => ({})),
            delete: record('Assignment.delete', () => ({ status: 200, message: 'Deleted' }))
        },
        Timeline: {
            upsert: record('Timeline.upsert', (_entity, entries) => {
                if (opts.upsert) throw opts.upsert;
                return { total: (entries as unknown[]).length, items: [] };
            })
        }
    } as unknown as CloudTAKAPI;
}

const methods = (calls: Recorded[]) => calls.map((c) => c.method);

function entry(n: number) {
    return { type: 'unit' as const, author: 'COM7', body: `Entry ${n}`, metadata: { unit: 'E1' }, external_id: `commandlog:${n}` };
}

function call(entries = 2): SyncedCall {
    return {
        external: 'CFS1',
        event: {
            name: 'Fire (CFS1)',
            type: '10034000001100000000',
            priority: 'high',
            geometry: { type: 'Point', coordinates: [-105, 39] },
            location: '1 Main St',
            remarks: 'CFS: CFS1',
            metadata: {}
        },
        assignees: [{ name: 'E1', role: 'En Route' }],
        timeline: Array.from({ length: entries }, (_, i) => entry(i + 1))
    };
}

const opts = { system: 'central-square', marker: 'CentralSquare CAD Unit', expireHours: 1 };

test('EventSync: a new record creates the Event, its Assignments and replays its Timeline once', async () => {
    const calls: Recorded[] = [];
    const cache: EventCache = {};
    const sync = new EventSync(fake(calls), cache, opts);

    await sync.sync(call());

    assert.deepEqual(methods(calls), ['Event.list', 'Event.create', 'Assignment.create', 'Timeline.upsert']);
    assert.equal(calls[3].args[0], 'evt-1');
    assert.deepEqual(calls[3].args[1], [entry(1), entry(2)]);
    assert.equal(cache.CFS1.id, 'evt-1');
    assert.ok(cache.CFS1.hash);
    assert.ok(cache.CFS1.timeline);
    assert.equal(sync.counts.created, 1);
    assert.equal(sync.counts.entries, 2);

    // The same record again costs nothing
    const again = new EventSync(fake(calls), cache, opts);
    calls.length = 0;
    await again.sync(call());

    assert.deepEqual(methods(calls), []);
    assert.equal(again.counts.unchanged, 1);
    assert.equal(again.counts.entries, 0);
});

test('EventSync: a grown Timeline on an unchanged Event only upserts the Timeline', async () => {
    const calls: Recorded[] = [];
    const cache: EventCache = {};
    await new EventSync(fake(calls), cache, opts).sync(call(2));
    const before = cache.CFS1.timeline;

    calls.length = 0;
    const sync = new EventSync(fake(calls), cache, opts);
    await sync.sync(call(3));

    assert.deepEqual(methods(calls), ['Timeline.upsert']);
    assert.deepEqual(calls[0].args[1], [entry(1), entry(2), entry(3)]);
    assert.equal(sync.counts.unchanged, 1);
    assert.equal(sync.counts.updated, 0);
    assert.equal(sync.counts.entries, 3);
    assert.notEqual(cache.CFS1.timeline, before);
});

test('EventSync: no Timeline on the record leaves the Timeline alone', async () => {
    const calls: Recorded[] = [];
    const cache: EventCache = {};
    await new EventSync(fake(calls), cache, opts).sync(call(2));
    const digest = cache.CFS1.timeline;

    calls.length = 0;
    const without = call(2);
    delete without.timeline;
    await new EventSync(fake(calls), cache, opts).sync(without);

    assert.deepEqual(methods(calls), []);
    assert.equal(cache.CFS1.timeline, digest);

    // A record created without a Timeline never calls the Timeline API
    const fresh: EventCache = {};
    calls.length = 0;
    await new EventSync(fake(calls), fresh, opts).sync({ ...without, external: 'CFS2' });
    assert.deepEqual(methods(calls), ['Event.list', 'Event.create', 'Assignment.create']);
    assert.equal(fresh.CFS2.timeline, undefined);
});

test('EventSync: a lost cache rewrites the Event and replays the Timeline, which the API dedups', async () => {
    const calls: Recorded[] = [];
    const sync = new EventSync(fake(calls, { events: [{ id: 'evt-9', external_ids: { 'central-square': 'CFS1' } }] }), {}, opts);

    await sync.sync(call(2));

    assert.deepEqual(methods(calls), ['Event.list', 'Event.update', 'Assignment.list', 'Assignment.create', 'Timeline.upsert']);
    assert.equal(calls[4].args[0], 'evt-9');
    assert.equal(sync.counts.updated, 1);
    assert.equal(sync.counts.entries, 2);
});

test('EventSync: a Timeline longer than one upsert is sent in chunks', async () => {
    const calls: Recorded[] = [];
    const sync = new EventSync(fake(calls), {}, opts);

    await sync.sync(call(1001));

    const upserts = calls.filter((c) => c.method === 'Timeline.upsert');
    assert.equal(upserts.length, 2);
    assert.equal((upserts[0].args[1] as unknown[]).length, 1000);
    assert.equal((upserts[1].args[1] as unknown[]).length, 1);
    assert.equal(sync.counts.entries, 1001);
});

test('EventSync: a failed Timeline upsert is retried on the next poll without rewriting the Event', async () => {
    const calls: Recorded[] = [];
    const cache: EventCache = {};
    const denied = Object.assign(new Error('Forbidden'), { status: 403 });

    const sync = new EventSync(fake(calls, { upsert: denied }), cache, opts);
    await sync.sync(call(2));

    assert.deepEqual(methods(calls), ['Event.list', 'Event.create', 'Assignment.create', 'Timeline.upsert']);
    assert.equal(sync.counts.created, 1);
    assert.equal(sync.counts.failed, 1);
    assert.equal(cache.CFS1.id, 'evt-1');
    assert.equal(cache.CFS1.timeline, undefined);

    calls.length = 0;
    const retry = new EventSync(fake(calls), cache, opts);
    await retry.sync(call(2));

    assert.deepEqual(methods(calls), ['Timeline.upsert']);
    assert.equal(retry.counts.unchanged, 1);
    assert.equal(retry.counts.entries, 2);
    assert.ok(cache.CFS1.timeline);
});

test('EventSync: a Timeline upsert that finds the Event gone recreates it', async () => {
    const calls: Recorded[] = [];
    const cache: EventCache = {};
    await new EventSync(fake(calls), cache, opts).sync(call(2));

    calls.length = 0;
    const gone = Object.assign(new Error('Not Found'), { status: 404 });
    const sync = new EventSync(fake(calls, { upsert: gone }), cache, opts);
    await sync.sync(call(3));

    assert.deepEqual(methods(calls), ['Timeline.upsert', 'Event.create', 'Assignment.create', 'Timeline.upsert']);
    assert.equal(sync.counts.created, 1);
    assert.equal(sync.counts.failed, 1);
});
