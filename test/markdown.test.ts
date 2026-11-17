import test from 'node:test';
import assert from 'node:assert';
import { remarks } from '../lib/markdown.js';

test('remarks', () => {
    assert.equal(remarks(['a', null, 'b']), 'a\nb');
    assert.equal(remarks([null]), '');
});
