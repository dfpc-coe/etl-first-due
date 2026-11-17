import test from 'node:test';
import assert from 'node:assert';
import { SchemaType, DataFlowType } from '@tak-ps/etl';

// task.ts calls Task.init() at module scope which requires an ETL environment,
// so these must be set before the dynamic import below
process.env.ETL_API = process.env.ETL_API || 'http://localhost:5001';
process.env.ETL_LAYER = process.env.ETL_LAYER || '1';
process.env.ETL_TOKEN = process.env.ETL_TOKEN || 'etl.test-token';

const { default: Task } = await import('../task.js');

type ObjectSchema = {
    type: string;
    properties: Record<string, { default?: unknown; enum?: unknown } | undefined>;
};

function objectSchema(schema: unknown): ObjectSchema {
    assert.ok(typeof schema === 'object' && schema !== null && 'type' in schema && 'properties' in schema);
    return schema as ObjectSchema;
}

test('Task static config', () => {
    assert.equal(Task.name, 'etl-first-due');
    assert.deepEqual(Task.flow, [DataFlowType.Incoming]);
});

test('Incoming Input schema', async () => {
    const task = await Task.init();
    const schema = objectSchema(await task.schema(SchemaType.Input, DataFlowType.Incoming));

    assert.equal(schema.type, 'object');

    for (const key of ['Email', 'Password', 'BaseURL', 'DataType', 'IncludeNotes', 'EnrichDispatches', 'BoundingBox', 'FallbackCoordinates', 'ExpireHours', 'StaleMinutes', 'DEBUG']) {
        assert.ok(schema.properties[key], `Env schema missing property: ${key}`);
    }

    assert.equal(schema.properties.DataType?.default, 'CAD');
    assert.deepEqual(schema.properties.DataType?.enum, ['CAD', 'AVL']);
    assert.equal(schema.properties.IncludeNotes?.default, true);
    assert.equal(schema.properties.EnrichDispatches?.default, false);
    assert.equal(schema.properties.ExpireHours?.default, 1);
    assert.equal(schema.properties.StaleMinutes?.default, 10);
});

test('Incoming Output schema', async () => {
    const task = await Task.init();
    const schemas = await task.schema(SchemaType.Output, DataFlowType.Incoming);

    assert.ok(Array.isArray(schemas));
    assert.deepEqual(schemas.map((named) => named.id), ['dispatch', 'device']);

    const schema = objectSchema(schemas[0].schema);

    assert.equal(schema.type, 'object');
    for (const key of ['id', 'xref_id', 'type', 'status_code', 'unit_codes', 'call_notes', 'message', 'cross_streets', 'located']) {
        assert.ok(schema.properties[key], `Output schema missing property: ${key}`);
    }
    assert.ok(!schema.properties.latitude);
    assert.ok(!schema.properties.units);

    const device = objectSchema(schemas[1].schema);

    assert.equal(device.type, 'object');
    for (const key of ['id', 'name', 'type', 'status_code', 'updated_at', 'responder_status', 'fire_station_name_or_number']) {
        assert.ok(device.properties[key], `Device schema missing property: ${key}`);
    }
    assert.ok(!device.properties.latitude);
});
