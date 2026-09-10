// Bengle LED strip step-sequence — pure validation, list-edit, and playback
// state-machine coverage. This drives a REAL capability (repeated
// PUT /machine/ledStrip writes — see led-sequence.js header), so unlike the
// superseded per-state preset feature these tests lock behaviour that actually
// reaches the machine, not just a CSS preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    MIN_STEP_DURATION_MS,
    MAX_STEP_DURATION_MS,
    DEFAULT_STEP_DURATION_MS,
    LED_SEQUENCE_KEY,
    LED_TRIGGER_STATES,
    isValidTriggerState,
    normalizeTriggerStates,
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
    toggleTriggerState,
    resolveTriggerSequence,
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

// ── Machine-state trigger resolution ─────────────────────────────────────
test('LED_TRIGGER_STATES matches the machine states this feature targets', () => {
    // Kept in sync BY HAND with api.js MachineState -- see the module header.
    assert.deepEqual(LED_TRIGGER_STATES.map((s) => s.id),
        ['idle', 'heating', 'espresso', 'steam', 'hotWater', 'cleaning']);
});

test('every trigger state is one the machine can actually report', () => {
    // Regression guard for a trigger the machine can never emit. 'ready' was
    // offered here for a while: api.js's MachineState carries a synthetic
    // READY:'ready' for app.js's shot-completion check, but the wire enum has
    // no such value and `currentMachineState` comes straight off the socket
    // frame, so a sequence mapped to it could never fire. Checking the ids
    // against the REST contract catches the next one automatically.
    const spec = readFileSync(new URL('../rest_v1.yml', import.meta.url), 'utf8');
    const block = /^ {4}MachineState:\n(?: {6}.*\n| *\n)*? {6}enum:\n {8}\[\n([\s\S]*?)\n {8}\]/m.exec(spec);
    assert.ok(block, 'could not find the MachineState enum in rest_v1.yml');
    const wireStates = new Set(block[1].split(',').map((s) => s.trim()).filter(Boolean));
    assert.ok(wireStates.has('espresso'), 'sanity: enum parsed');
    assert.equal(wireStates.has('ready'), false, 'sanity: the wire enum has no "ready"');

    for (const { id } of LED_TRIGGER_STATES) {
        assert.ok(wireStates.has(id), `trigger state "${id}" is not a MachineState the machine reports`);
    }
});

test('isValidTriggerState / normalizeTriggerStates', () => {
    assert.equal(isValidTriggerState('espresso'), true);
    assert.equal(isValidTriggerState('booting'), false); // curated subset excludes internal states
    assert.equal(isValidTriggerState(''), false);
    assert.equal(isValidTriggerState(undefined), false);

    assert.deepEqual(normalizeTriggerStates(['idle', 'espresso', 'not-a-state', 'idle']), ['idle', 'espresso']); // dedup + drop invalid
    assert.deepEqual(normalizeTriggerStates(null), []);
    assert.deepEqual(normalizeTriggerStates('garbage'), []);
});

test('normalizeSequence normalizes triggerStates alongside steps/loop', () => {
    const out = normalizeSequence({ triggerStates: ['idle', 'nope', 'idle', 'steam'] });
    assert.deepEqual(out.triggerStates, ['idle', 'steam']);
    assert.deepEqual(normalizeSequence({}).triggerStates, []);
});

test('toggleTriggerState adds and removes without touching steps/loop', () => {
    const base = normalizeSequence({ steps: [{ frontColor: '#ff0000' }], loop: true, triggerStates: ['idle'] });
    const added = toggleTriggerState(base, 'espresso', true);
    assert.deepEqual(added.triggerStates, ['idle', 'espresso']);
    assert.equal(added.loop, true);
    assert.equal(added.steps.length, 1);

    const removed = toggleTriggerState(added, 'idle', false);
    assert.deepEqual(removed.triggerStates, ['espresso']);
});

test('toggleTriggerState ignores an invalid state id', () => {
    const base = normalizeSequence({ triggerStates: ['idle'] });
    assert.deepEqual(toggleTriggerState(base, 'not-a-state', true), base);
});

test('toggleTriggerState is idempotent (adding twice, removing twice)', () => {
    let seq = normalizeSequence({});
    seq = toggleTriggerState(seq, 'steam', true);
    seq = toggleTriggerState(seq, 'steam', true);
    assert.deepEqual(seq.triggerStates, ['steam']);
    seq = toggleTriggerState(seq, 'steam', false);
    seq = toggleTriggerState(seq, 'steam', false);
    assert.deepEqual(seq.triggerStates, []);
});

test('resolveTriggerSequence returns { steps, loop } when the state is mapped and steps exist', () => {
    const sequence = { steps: [{ frontColor: '#ff0000' }], loop: true, triggerStates: ['espresso'] };
    assert.deepEqual(resolveTriggerSequence(sequence, 'espresso'),
        { steps: normalizeSteps(sequence.steps), loop: true });
});

test('resolveTriggerSequence returns null for an unmapped state', () => {
    const sequence = { steps: [{ frontColor: '#ff0000' }], loop: false, triggerStates: ['espresso'] };
    assert.equal(resolveTriggerSequence(sequence, 'idle'), null);
    assert.equal(resolveTriggerSequence(sequence, 'not-a-real-state'), null);
});

test('resolveTriggerSequence returns null when mapped but there are no steps', () => {
    const sequence = { steps: [], loop: true, triggerStates: ['espresso'] };
    assert.equal(resolveTriggerSequence(sequence, 'espresso'), null);
});

test('resolveTriggerSequence never hands back the trigger list itself', () => {
    const sequence = { steps: [{ frontColor: '#ff0000' }], loop: false, triggerStates: ['idle'] };
    const resolved = resolveTriggerSequence(sequence, 'idle');
    assert.equal(resolved.triggerStates, undefined);
    assert.deepEqual(Object.keys(resolved).sort(), ['loop', 'steps']);
});
