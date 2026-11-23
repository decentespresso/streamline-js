import test from 'node:test';
import assert from 'node:assert/strict';
import { stepValue, stepWithin, formatRatio } from '../src/modules/value-format.js';

test('stepValue drops float noise', () => {
    assert.equal(stepValue(16.4, 1, -1), 15.4);
    assert.equal(stepValue(16.3, 1, 1), 17.3);
    assert.equal(stepValue(0.1, 0.2, 1), 0.3);
});

test('formatRatio keeps the second decimal only when it matters', () => {
    assert.equal(formatRatio(41 / 16.3), '2.52');
    assert.equal(formatRatio(2), '2.0');
    assert.equal(formatRatio(2.5), '2.5');
    assert.equal(formatRatio(36 / 18), '2.0');
});

test('stepWithin: -/+ never step from a tile that shows no number', () => {
    assert.equal(stepWithin(NaN, 0.1, 1, 0, null), null, 'a dash or a text reading never becomes NaN');
    assert.equal(stepWithin(NaN, 0.1, -1, 0, null), null);
    assert.equal(stepWithin(16.4, 1, 1, 0, null), 17.4);
    assert.equal(stepWithin(16.4, 1, -1, 0, null), 15.4);
    assert.equal(stepWithin(49.5, 1, 1, 0, 50), 50, 'held to the ceiling');
    assert.equal(stepWithin(0.5, 1, -1, 0, null), 0, 'held to the floor');
    assert.equal(stepWithin(0, 1, -1, 0, null), null, 'nowhere to go below the floor');
});
