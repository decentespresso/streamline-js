import test from 'node:test';
import assert from 'node:assert/strict';
import { nextOptionIndex } from '../src/modules/custom-select.js';

test('arrow keys skip disabled options and stop at the ends', () => {
    const disabled = [false, true, false, false];
    assert.equal(nextOptionIndex(disabled, 0, 'ArrowDown'), 2);
    assert.equal(nextOptionIndex(disabled, 2, 'ArrowUp'), 0);
    assert.equal(nextOptionIndex(disabled, 3, 'ArrowDown'), 3);
    assert.equal(nextOptionIndex(disabled, 0, 'ArrowUp'), 0);
});

test('Home and End land on the first and last enabled option', () => {
    const disabled = [true, false, false, true];
    assert.equal(nextOptionIndex(disabled, 2, 'Home'), 1);
    assert.equal(nextOptionIndex(disabled, 1, 'End'), 2);
});

test('nothing selected yet: ArrowDown picks the first enabled option', () => {
    assert.equal(nextOptionIndex([true, false], -1, 'ArrowDown'), 1);
    assert.equal(nextOptionIndex([false], 0, 'a'), null);
});
