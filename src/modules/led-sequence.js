// Bengle LED strip — user-defined colour step sequences.
//
// Unlike the per-machine-state animation concept this module replaces, a step
// sequence is a REAL capability: the firmware has no animation or per-state
// palette support, but the strip can be repainted on demand, so a sequence
// runner is just that write made repeatedly on a timer — a real A→B→C→D...
// pattern actually driven onto the physical strip.
//
// That write is `PUT /machine/ledStrip` (api.js `setLedStrip`), the same call
// the Save path uses. There is no preview endpoint: the firmware exposes one
// palette and renders the bank matching the machine's wake state, so painting
// a colour means writing it into that bank and writing the real palette back
// when playback stops. See `ledLiveWriteState` in led-color.js for the payload
// and led-strip-runner.js for the baseline capture/restore that goes with it.
//
// This module holds only the DOM-free, testable parts: step validation and
// normalization, the ordered-list edit operations, JSON (de)serialization for
// the `streamline.ledSequences` synced preference, the pure step-advance/loop
// state machine, and machine-state trigger resolution. The runner in
// src/modules/led-strip-runner.js (a browser module, not DOM-free -- it talks
// to api.js) owns the timer, the machine writes, and cross-owner arbitration
// between a manual test run (Settings) and a state-triggered run (app.js);
// src/settings/settings.js owns the editor DOM.
//
// DOM-free on purpose so node:test can import it directly
// (test/led-sequence.test.mjs).

import { ledHexToRgb, ledRgbToColor16 } from './led-color.js';

// Curated subset of the machine states a sequence can trigger on. Kept as
// plain strings, not imported, so this module stays DOM-free for node:test --
// api.js touches `window`/`localStorage` at module scope. Keep these in sync
// BY HAND with MachineState in ../modules/api.js; states with no ambient-
// lighting relevance (booting, calibration, selfTest, fwUpgrade, error, …) are
// deliberately left out, same as the removed led-animation.js.
//
// Every id here MUST be a state the machine actually reports. api.js's
// `MachineState` also carries a synthetic `READY: 'ready'`, flagged in its own
// comment as "not in the official API doc" and used only by app.js's
// shot-completion check; the wire enum in rest_v1.yml has no `ready`, and
// `currentMachineState` is assigned straight from the socket frame, so the
// trigger path (app.js → ledStripOnMachineStateChange) can never observe it.
// A sequence mapped to 'ready' could therefore never fire, so it is not
// offered. `normalizeTriggerStates` drops it from anything already persisted.
export const LED_TRIGGER_STATES = [
    { id: 'idle', label: 'Idle' },
    { id: 'heating', label: 'Heating' },
    { id: 'espresso', label: 'Espresso' },
    { id: 'steam', label: 'Steam' },
    { id: 'hotWater', label: 'Hot Water' },
    { id: 'cleaning', label: 'Cleaning' },
];
const TRIGGER_STATE_IDS = new Set(LED_TRIGGER_STATES.map((s) => s.id));

/** True when `id` is one of the states a sequence can be set to trigger on. */
export function isValidTriggerState(id) {
    return TRIGGER_STATE_IDS.has(id);
}

/** Arbitrary value → a deduped array of valid trigger-state ids only. */
export function normalizeTriggerStates(list) {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter(isValidTriggerState))];
}

/** Step-rate floor: a BLE-backed REST round trip realistically takes on the
 *  order of 100-300ms; going much faster than this risks steps overlapping
 *  or the strip never actually reaching a step before the next write lands. */
export const MIN_STEP_DURATION_MS = 500;
/** Step-rate ceiling: purely a sanity bound against a fat-fingered value
 *  turning "a lighting effect" into "a colour that sits for a minute". */
export const MAX_STEP_DURATION_MS = 60000;
export const DEFAULT_STEP_DURATION_MS = 1000;

/** localStorage key (mirrored to KV by settingsSync.js like other `streamline.*` keys). */
export const LED_SEQUENCE_KEY = 'streamline.ledSequences';

/** User-entered/stored duration → whole ms clamped into [MIN,MAX]; NaN/falsy → the default. */
export function clampStepDurationMs(value) {
    // null/undefined/'' are "missing", not the number zero -- Number(null) is
    // 0, which would otherwise silently clamp up to the floor instead of
    // falling back to the default.
    if (value === null || value === undefined || value === '') return DEFAULT_STEP_DURATION_MS;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_STEP_DURATION_MS;
    return Math.max(MIN_STEP_DURATION_MS, Math.min(MAX_STEP_DURATION_MS, n));
}

const HEX8_RE = /^#?[0-9A-Fa-f]{6}$/;

/** True for a '#RRGGBB' (hash optional) colour string. */
export function isValidHex8(hex) {
    return typeof hex === 'string' && HEX8_RE.test(hex);
}

function normalizeHex8(hex, fallback = '#000000') {
    if (!isValidHex8(hex)) return fallback;
    const bare = hex.startsWith('#') ? hex.slice(1) : hex;
    return '#' + bare.toUpperCase();
}

/** Arbitrary value → a complete, valid { frontColor, rearColor, durationMs } step. */
export function normalizeStep(step) {
    return {
        frontColor: normalizeHex8(step?.frontColor),
        rearColor: normalizeHex8(step?.rearColor),
        durationMs: clampStepDurationMs(step?.durationMs),
    };
}

/** Arbitrary value → an array of normalized steps (non-arrays become empty). */
export function normalizeSteps(steps) {
    return Array.isArray(steps) ? steps.map(normalizeStep) : [];
}

export const DEFAULT_SEQUENCE = Object.freeze({ steps: [], loop: false, triggerStates: [] });

/** Arbitrary value → a complete { steps, loop, triggerStates } sequence. */
export function normalizeSequence(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    return {
        steps: normalizeSteps(src.steps),
        loop: src.loop === true,
        triggerStates: normalizeTriggerStates(src.triggerStates),
    };
}

/** Pure toggle: add/drop `stateId` from a sequence's trigger list. Invalid ids are ignored. */
export function toggleTriggerState(sequence, stateId, enabled) {
    const s = normalizeSequence(sequence);
    if (!isValidTriggerState(stateId)) return s;
    const set = new Set(s.triggerStates);
    if (enabled) set.add(stateId); else set.delete(stateId);
    return { ...s, triggerStates: normalizeTriggerStates([...set]) };
}

/**
 * The machine just entered `stateId` -- does this sequence auto-run for it?
 * Returns `{ steps, loop }` (never the raw sequence, so a caller can't
 * accidentally hand the trigger list itself off to the playback runner) when
 * the state is in `triggerStates` AND there is at least one step to play,
 * otherwise `null`.
 */
export function resolveTriggerSequence(sequence, stateId) {
    const s = normalizeSequence(sequence);
    if (!s.steps.length) return null;
    if (!s.triggerStates.includes(stateId)) return null;
    return { steps: s.steps, loop: s.loop };
}

/** Stored JSON string → normalized sequence. Malformed/missing JSON → empty, never throws. */
export function parseLedSequence(json) {
    if (!json) return { ...DEFAULT_SEQUENCE };
    try {
        return normalizeSequence(JSON.parse(json));
    } catch (e) {
        return { ...DEFAULT_SEQUENCE };
    }
}

/** Normalized sequence → JSON string for storage. */
export function serializeLedSequence(sequence) {
    return JSON.stringify(normalizeSequence(sequence));
}

// ── Ordered-list edit operations (pure — each returns a NEW steps array) ────

/** Append a step (defaults fill in for anything missing/invalid). */
export function addStep(steps, step = {}) {
    return [...normalizeSteps(steps), normalizeStep(step)];
}

/** Drop the step at `index`; out-of-range is a no-op (returns the normalized input). */
export function removeStep(steps, index) {
    const s = normalizeSteps(steps);
    if (!Number.isInteger(index) || index < 0 || index >= s.length) return s;
    return s.filter((_, i) => i !== index);
}

/** Merge `patch` into the step at `index`; out-of-range is a no-op. */
export function updateStep(steps, index, patch) {
    const s = normalizeSteps(steps);
    if (!Number.isInteger(index) || index < 0 || index >= s.length) return s;
    return s.map((step, i) => (i === index ? normalizeStep({ ...step, ...patch }) : step));
}

/** Move the step at `fromIndex` to `toIndex`; either index out of range (or equal) is a no-op. */
export function moveStep(steps, fromIndex, toIndex) {
    const s = normalizeSteps(steps);
    const inRange = (i) => Number.isInteger(i) && i >= 0 && i < s.length;
    if (!inRange(fromIndex) || !inRange(toIndex) || fromIndex === toIndex) return s;
    const copy = s.slice();
    const [item] = copy.splice(fromIndex, 1);
    copy.splice(toIndex, 0, item);
    return copy;
}

// ── Playback state machine ───────────────────────────────────────────────
// led-strip-runner.js owns the timer; this decides what index plays next
// given how many steps exist, what is playing now, and the loop flag.

/**
 * `currentIndex` → the next step index to play, or `null` when playback
 * should STOP (no steps, or the end of a non-looping sequence).
 * `currentIndex` of -1 (nothing played yet) advances to step 0.
 */
export function nextStepIndex(stepCount, currentIndex, loop) {
    if (!Number.isInteger(stepCount) || stepCount <= 0) return null;
    const next = (Number.isInteger(currentIndex) ? currentIndex : -1) + 1;
    if (next < stepCount) return next;
    return loop ? 0 : null;
}

/** A normalized step → the 16-bit wire colours to drive onto the strip. */
export function stepPreviewColors(step) {
    const s = normalizeStep(step);
    return {
        front: ledRgbToColor16(ledHexToRgb(s.frontColor)),
        back: ledRgbToColor16(ledHexToRgb(s.rearColor)),
    };
}

// ── Sequence library (several saved sequences, one of them active) ────────
// Stored under the same LED_SEQUENCE_KEY as before. The value used to BE a
// single sequence; normalizeLibrary() migrates that shape into one preset so
// an existing strip keeps its steps and triggers across the upgrade.
//
// Only the ACTIVE preset plays and only its triggerStates fire -- the others
// are saved, not armed -- so two sequences can never fight over the strip.
// `enabled` gates the auto-run path only: the Settings Play button still
// works with it off, which is how you build a sequence before arming it.

export const MAX_PRESET_NAME_LENGTH = 40;

/** Arbitrary value → a trimmed, length-capped preset name ('' when unusable). */
export function normalizePresetName(name) {
    return typeof name === 'string' ? name.trim().slice(0, MAX_PRESET_NAME_LENGTH) : '';
}

/** Arbitrary value → a complete { id, name, steps, loop, triggerStates } preset. */
export function normalizePreset(raw, index = 0) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const id = typeof src.id === 'string' && src.id ? src.id : `s${index + 1}`;
    return { id, name: normalizePresetName(src.name), ...normalizeSequence(src) };
}

/** An id no preset in `presets` already uses. Deterministic, so it is testable. */
export function nextPresetId(presets) {
    const used = new Set((Array.isArray(presets) ? presets : []).map((p) => p?.id));
    let n = 1;
    while (used.has(`s${n}`)) n += 1;
    return `s${n}`;
}

export const DEFAULT_LIBRARY = Object.freeze({ enabled: true, activeId: '', presets: [] });

/**
 * Arbitrary value → a complete { enabled, activeId, presets } library.
 * Accepts the pre-library single-sequence shape and migrates it. Duplicate
 * ids are re-issued, and activeId always names a preset that exists (or '' when
 * there are none), so callers never have to guard either.
 */
export function normalizeLibrary(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const legacy = !Array.isArray(src.presets) && (Array.isArray(src.steps) || 'loop' in src || 'triggerStates' in src);
    const list = legacy ? [src] : (Array.isArray(src.presets) ? src.presets : []);
    const presets = [];
    for (const item of list) {
        const preset = normalizePreset(item, presets.length);
        if (presets.some((p) => p.id === preset.id)) preset.id = nextPresetId(presets);
        presets.push(preset);
    }
    const activeId = presets.some((p) => p.id === src.activeId) ? src.activeId : (presets[0]?.id || '');
    // Missing `enabled` means a store written before the switch existed, whose
    // triggers were live -- default on so an upgrade changes nothing.
    return { enabled: src.enabled !== false, activeId, presets };
}

/** The preset currently in use, or null when the library is empty. */
export function getActivePreset(library) {
    const lib = normalizeLibrary(library);
    return lib.presets.find((p) => p.id === lib.activeId) || null;
}

/** Append a preset and make it the active one. */
export function addPreset(library, preset = {}) {
    const lib = normalizeLibrary(library);
    const added = { ...normalizePreset(preset, lib.presets.length), id: nextPresetId(lib.presets) };
    return { ...lib, presets: [...lib.presets, added], activeId: added.id };
}

/** Drop a preset; the active one moves to its neighbour. Unknown id is a no-op. */
export function removePreset(library, id) {
    const lib = normalizeLibrary(library);
    const index = lib.presets.findIndex((p) => p.id === id);
    if (index < 0) return lib;
    const presets = lib.presets.filter((p) => p.id !== id);
    if (lib.activeId !== id) return { ...lib, presets };
    const neighbour = presets[index] || presets[index - 1] || presets[0];
    return { ...lib, presets, activeId: neighbour?.id || '' };
}

/** Rename a preset. Unknown id is a no-op. */
export function renamePreset(library, id, name) {
    const lib = normalizeLibrary(library);
    return { ...lib, presets: lib.presets.map((p) => (p.id === id ? { ...p, name: normalizePresetName(name) } : p)) };
}

/** Make `id` the active preset. Unknown id is a no-op. */
export function selectPreset(library, id) {
    const lib = normalizeLibrary(library);
    return lib.presets.some((p) => p.id === id) ? { ...lib, activeId: id } : lib;
}

/** Merge `patch` (steps/loop/triggerStates/name) into the active preset. */
export function updateActivePreset(library, patch) {
    const lib = normalizeLibrary(library);
    return {
        ...lib,
        presets: lib.presets.map((p) => (p.id === lib.activeId ? normalizePreset({ ...p, ...patch }) : p)),
    };
}

/** Turn the auto-run switch on or off. */
export function setSequencesEnabled(library, enabled) {
    return { ...normalizeLibrary(library), enabled: enabled === true };
}

/**
 * The machine just entered `stateId` -- what should auto-run, if anything?
 * `{ steps, loop }` only when the switch is on and the ACTIVE preset is mapped
 * to that state; otherwise null.
 */
export function resolveLibraryTrigger(library, stateId) {
    const lib = normalizeLibrary(library);
    if (!lib.enabled) return null;
    const active = getActivePreset(lib);
    return active ? resolveTriggerSequence(active, stateId) : null;
}

/** Stored JSON string → normalized library. Malformed/missing → empty, never throws. */
export function parseLedLibrary(json) {
    if (!json) return normalizeLibrary(null);
    try {
        return normalizeLibrary(JSON.parse(json));
    } catch (e) {
        return normalizeLibrary(null);
    }
}

/** Normalized library → JSON string for storage. */
export function serializeLedLibrary(library) {
    return JSON.stringify(normalizeLibrary(library));
}
