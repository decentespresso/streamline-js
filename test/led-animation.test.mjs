// Bengle LED ambient-animation preferences — pure state/validation helpers.
// This is a LOCAL preference (see led-animation.js header): the firmware has
// no per-state or animation capability today, so these tests lock the
// storage/validation contract, not any machine write.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LED_ANIMATION_STATES,
    LED_ANIMATION_PRESETS,
    isValidLedAnimationState,
    isValidLedAnimationPreset,
    DEFAULT_LED_ANIMATIONS,
    LED_ANIMATIONS_KEY,
    normalizeLedAnimations,
    parseLedAnimations,
    serializeLedAnimations,
    setLedAnimation,
    ledAnimationFor,
} from '../src/modules/led-animation.js';

test('localStorage key is stable (renaming orphans persisted assignments)', () => {
    assert.equal(LED_ANIMATIONS_KEY, 'streamline.ledAnimations');
});

test('every default assignment is off', () => {
    for (const { id } of LED_ANIMATION_STATES) {
        assert.equal(DEFAULT_LED_ANIMATIONS[id], 'off');
    }
    assert.equal(Object.keys(DEFAULT_LED_ANIMATIONS).length, LED_ANIMATION_STATES.length);
});

test('isValidLedAnimationState / isValidLedAnimationPreset', () => {
    assert.equal(isValidLedAnimationState('espresso'), true);
    assert.equal(isValidLedAnimationState('booting'), false); // curated subset excludes internal states
    assert.equal(isValidLedAnimationState(''), false);
    assert.equal(isValidLedAnimationState(undefined), false);

    assert.equal(isValidLedAnimationPreset('rainbow'), true);
    assert.equal(isValidLedAnimationPreset('strobe'), false); // not an offered preset
    assert.equal(isValidLedAnimationPreset(null), false);
});

test('normalizeLedAnimations fills every state and drops invalid presets', () => {
    const out = normalizeLedAnimations({ idle: 'pulse', espresso: 'not-a-real-preset' });
    assert.equal(out.idle, 'pulse');
    assert.equal(out.espresso, 'off'); // invalid preset falls back to off
    assert.equal(out.heating, 'off');  // missing state defaults to off
    assert.equal(Object.keys(out).length, LED_ANIMATION_STATES.length);
});

test('normalizeLedAnimations drops unknown state keys and tolerates non-objects', () => {
    const out = normalizeLedAnimations({ notAState: 'pulse', idle: 'chase' });
    assert.equal(out.notAState, undefined);
    assert.equal(out.idle, 'chase');
    assert.deepEqual(normalizeLedAnimations(null), { ...DEFAULT_LED_ANIMATIONS });
    assert.deepEqual(normalizeLedAnimations(undefined), { ...DEFAULT_LED_ANIMATIONS });
    assert.deepEqual(normalizeLedAnimations('garbage'), { ...DEFAULT_LED_ANIMATIONS });
});

test('parseLedAnimations: malformed/missing JSON falls back to all-off, never throws', () => {
    assert.deepEqual(parseLedAnimations(null), { ...DEFAULT_LED_ANIMATIONS });
    assert.deepEqual(parseLedAnimations(''), { ...DEFAULT_LED_ANIMATIONS });
    assert.deepEqual(parseLedAnimations('{not json'), { ...DEFAULT_LED_ANIMATIONS });
    assert.deepEqual(parseLedAnimations('42'), { ...DEFAULT_LED_ANIMATIONS });
});

test('parseLedAnimations / serializeLedAnimations round trip', () => {
    const assignments = setLedAnimation(DEFAULT_LED_ANIMATIONS, 'steam', 'sparkle');
    const json = serializeLedAnimations(assignments);
    assert.deepEqual(parseLedAnimations(json), assignments);
});

test('setLedAnimation returns a new object and only touches the given state', () => {
    const next = setLedAnimation(DEFAULT_LED_ANIMATIONS, 'espresso', 'breathe');
    assert.notEqual(next, DEFAULT_LED_ANIMATIONS); // original untouched
    assert.equal(next.espresso, 'breathe');
    assert.equal(next.idle, 'off');
    assert.equal(DEFAULT_LED_ANIMATIONS.espresso, 'off'); // frozen default unchanged
});

test('setLedAnimation ignores an invalid state or preset id', () => {
    const base = setLedAnimation(DEFAULT_LED_ANIMATIONS, 'idle', 'pulse');
    assert.deepEqual(setLedAnimation(base, 'notAState', 'chase'), base);
    assert.deepEqual(setLedAnimation(base, 'idle', 'not-a-preset'), base);
});

test('ledAnimationFor always resolves to a valid preset', () => {
    const assignments = setLedAnimation(DEFAULT_LED_ANIMATIONS, 'cleaning', 'chase');
    assert.equal(ledAnimationFor(assignments, 'cleaning'), 'chase');
    assert.equal(ledAnimationFor(assignments, 'idle'), 'off');
    assert.equal(ledAnimationFor({}, 'idle'), 'off');
    assert.equal(ledAnimationFor(null, 'idle'), 'off');
});

test('LED_ANIMATION_STATES matches the machine states this feature targets', () => {
    // Kept in sync BY HAND with api.js MachineState — see the module header.
    assert.deepEqual(LED_ANIMATION_STATES.map((s) => s.id),
        ['idle', 'heating', 'ready', 'espresso', 'steam', 'hotWater', 'cleaning']);
});

test('LED_ANIMATION_PRESETS starts with off', () => {
    assert.equal(LED_ANIMATION_PRESETS[0].id, 'off');
    assert.equal(new Set(LED_ANIMATION_PRESETS.map((p) => p.id)).size, LED_ANIMATION_PRESETS.length);
});
