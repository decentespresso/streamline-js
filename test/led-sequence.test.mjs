// Bengle LED strip step-sequence — pure validation, list-edit, and playback
// state-machine coverage. This drives a REAL capability (repeated
// POST /machine/ledStrip/preview writes — see led-sequence.js header), so
// unlike the superseded per-state preset feature these tests lock behaviour
// that actually reaches the machine, not just a CSS preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MIN_STEP_DURATION_MS,
    MAX_STEP_DURATION_MS,
    DEFAULT_STEP_DURATION_MS,
    LED_SEQUENCE_KEY,
    clampStepDurationMs,
    isValidHex8,
    normalizeStep,
    normalizeSteps,
    DEFAULT_SEQUENCE,
    normalizeSequence,
    parseLedSequence,
    serializeLedSequence,
    addStep,
    removeStep,
    updateStep,
    moveStep,
    nextStepIndex,
    stepPreviewColors,
} from '../src/modules/led-sequence.js';

test('localStorage key is stable (renaming orphans persisted sequences)', () => {
    assert.equal(LED_SEQUENCE_KEY, 'streamline.ledSequences');
});

// ── clampStepDurationMs ──────────────────────────────────────────────────
test('clampStepDurationMs enforces the BLE/REST round-trip floor', () => {
    assert.equal(clampStepDurationMs(0), MIN_STEP_DURATION_MS);
    assert.equal(clampStepDurationMs(1), MIN_STEP_DURATION_MS);
    assert.equal(clampStepDurationMs(499), MIN_STEP_DURATION_MS);
    assert.equal(clampStepDurationMs(500), 500);
    assert.equal(clampStepDurationMs(-100), MIN_STEP_DURATION_MS);
});

test('clampStepDurationMs enforces the sanity ceiling', () => {
    assert.equal(clampStepDurationMs(60000), 60000);
    assert.equal(clampStepDurationMs(60001), MAX_STEP_DURATION_MS);
    assert.equal(clampStepDurationMs(1e9), MAX_STEP_DURATION_MS);
});

test('clampStepDurationMs: NaN/missing/non-numeric falls back to the default', () => {
    assert.equal(clampStepDurationMs(NaN), DEFAULT_STEP_DURATION_MS);
    assert.equal(clampStepDurationMs(undefined), DEFAULT_STEP_DURATION_MS);
    assert.equal(clampStepDurationMs(null), DEFAULT_STEP_DURATION_MS);
    assert.equal(clampStepDurationMs('not a number'), DEFAULT_STEP_DURATION_MS);
});

test('clampStepDurationMs rounds fractional input', () => {
    assert.equal(clampStepDurationMs(1200.6), 1201);
});

// ── isValidHex8 / normalizeStep ──────────────────────────────────────────
test('isValidHex8 accepts #RRGGBB with hash optional, rejects everything else', () => {
    assert.equal(isValidHex8('#FFAA55'), true);
    assert.equal(isValidHex8('ffaa55'), true);
    assert.equal(isValidHex8('#FFF'), false);
    assert.equal(isValidHex8('not-a-color'), false);
    assert.equal(isValidHex8(''), false);
    assert.equal(isValidHex8(null), false);
    assert.equal(isValidHex8(undefined), false);
});

test('normalizeStep upper-cases valid colours and hash-prefixes them', () => {
    assert.deepEqual(normalizeStep({ frontColor: 'ffaa55', rearColor: '#00c2d1', durationMs: 800 }),
        { frontColor: '#FFAA55', rearColor: '#00C2D1', durationMs: 800 });
});

test('normalizeStep falls back invalid colours to black and invalid duration to default', () => {
    assert.deepEqual(normalizeStep({ frontColor: 'nope', rearColor: null, durationMs: 'x' }),
        { frontColor: '#000000', rearColor: '#000000', durationMs: DEFAULT_STEP_DURATION_MS });
});

test('normalizeStep tolerates a missing/non-object input', () => {
    assert.deepEqual(normalizeStep(undefined),
        { frontColor: '#000000', rearColor: '#000000', durationMs: DEFAULT_STEP_DURATION_MS });
    assert.deepEqual(normalizeSteps('garbage'), []);
    assert.deepEqual(normalizeSteps(null), []);
});

// ── normalizeSequence / parse / serialize ────────────────────────────────
test('normalizeSequence defaults loop to false and normalizes every step', () => {
    const out = normalizeSequence({ steps: [{ frontColor: 'ff0000', durationMs: 10 }] });
    assert.equal(out.loop, false);
    assert.equal(out.steps.length, 1);
    assert.equal(out.steps[0].durationMs, MIN_STEP_DURATION_MS);
});

test('normalizeSequence: loop must be exactly true to enable it', () => {
    assert.equal(normalizeSequence({ loop: true }).loop, true);
    assert.equal(normalizeSequence({ loop: 'true' }).loop, false); // truthy string is not `true`
    assert.equal(normalizeSequence({ loop: 1 }).loop, false);
});

test('parseLedSequence: malformed/missing JSON falls back to empty, never throws', () => {
    assert.deepEqual(parseLedSequence(null), { ...DEFAULT_SEQUENCE });
    assert.deepEqual(parseLedSequence(''), { ...DEFAULT_SEQUENCE });
    assert.deepEqual(parseLedSequence('{not json'), { ...DEFAULT_SEQUENCE });
    assert.deepEqual(parseLedSequence('42'), { ...DEFAULT_SEQUENCE });
});

test('parseLedSequence / serializeLedSequence round trip', () => {
    const seq = normalizeSequence({ loop: true, steps: [{ frontColor: '#ff0000', rearColor: '#00ff00', durationMs: 750 }] });
    assert.deepEqual(parseLedSequence(serializeLedSequence(seq)), seq);
});

// ── addStep / removeStep / updateStep / moveStep ─────────────────────────
test('addStep appends a normalized step without mutating the input', () => {
    const base = [];
    const next = addStep(base, { frontColor: '#ff0000', rearColor: '#0000ff', durationMs: 900 });
    assert.equal(base.length, 0);
    assert.equal(next.length, 1);
    assert.deepEqual(next[0], { frontColor: '#FF0000', rearColor: '#0000FF', durationMs: 900 });
});

test('removeStep drops only the targeted index; out-of-range is a no-op', () => {
    const steps = [addStep([], { frontColor: '#111111' })[0], addStep([], { frontColor: '#222222' })[0]];
    const next = removeStep(steps, 0);
    assert.equal(next.length, 1);
    assert.equal(next[0].frontColor, '#222222');
    assert.deepEqual(removeStep(steps, 5), normalizeSteps(steps));
    assert.deepEqual(removeStep(steps, -1), normalizeSteps(steps));
});

test('updateStep merges a patch into one step, preserving its other fields', () => {
    const steps = addStep([], { frontColor: '#111111', rearColor: '#222222', durationMs: 1000 });
    const next = updateStep(steps, 0, { frontColor: '#abcdef' });
    assert.equal(next[0].frontColor, '#ABCDEF');
    assert.equal(next[0].rearColor, '#222222'); // untouched
    assert.equal(next[0].durationMs, 1000);     // untouched
});

test('updateStep with an out-of-range index is a no-op', () => {
    const steps = addStep([], { frontColor: '#111111' });
    assert.deepEqual(updateStep(steps, 9, { frontColor: '#ffffff' }), normalizeSteps(steps));
});

test('moveStep reorders; out-of-range or equal indices are a no-op', () => {
    let steps = [];
    steps = addStep(steps, { frontColor: '#111111' });
    steps = addStep(steps, { frontColor: '#222222' });
    steps = addStep(steps, { frontColor: '#333333' });
    const moved = moveStep(steps, 0, 2);
    assert.deepEqual(moved.map((s) => s.frontColor), ['#222222', '#333333', '#111111']);
    assert.deepEqual(moveStep(steps, 0, 0), normalizeSteps(steps));
    assert.deepEqual(moveStep(steps, 0, 9), normalizeSteps(steps));
    assert.deepEqual(moveStep(steps, -1, 1), normalizeSteps(steps));
});

// ── nextStepIndex (playback state machine) ───────────────────────────────
test('nextStepIndex starts at 0 from -1 (nothing played yet)', () => {
    assert.equal(nextStepIndex(3, -1, false), 0);
});

test('nextStepIndex advances through the list and stops at the end when not looping', () => {
    assert.equal(nextStepIndex(3, 0, false), 1);
    assert.equal(nextStepIndex(3, 1, false), 2);
    assert.equal(nextStepIndex(3, 2, false), null); // end of sequence, no loop -> stop
});

test('nextStepIndex wraps to 0 at the end when looping', () => {
    assert.equal(nextStepIndex(3, 2, true), 0);
});

test('nextStepIndex with zero or invalid step count always stops', () => {
    assert.equal(nextStepIndex(0, -1, true), null);
    assert.equal(nextStepIndex(0, -1, false), null);
    assert.equal(nextStepIndex(null, 0, true), null);
    assert.equal(nextStepIndex(undefined, 0, true), null);
});

test('nextStepIndex: a single-step loop keeps returning 0', () => {
    assert.equal(nextStepIndex(1, 0, true), 0);
    assert.equal(nextStepIndex(1, -1, true), 0);
});

// ── stepPreviewColors ─────────────────────────────────────────────────────
test('stepPreviewColors converts hex8 colours to the 16-bit wire format', () => {
    assert.deepEqual(stepPreviewColors({ frontColor: '#FFAA55', rearColor: '#000000' }),
        { front: 'FFFFAAAA5555', back: '000000000000' });
});

test('stepPreviewColors normalizes an invalid/partial step before converting', () => {
    assert.deepEqual(stepPreviewColors({ frontColor: 'nope' }),
        { front: '000000000000', back: '000000000000' });
});
