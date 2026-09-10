// Bengle LED strip — ambient animation-per-machine-state preferences.
//
// IMPORTANT: this is a LOCAL, forward-looking preference. The Bengle firmware
// (reaprime LedStripCapability) exposes exactly four MMR registers — front/rear
// LED × awake/sleeping — each a single STATIC colour. There is no firmware
// register, REST field, or WebSocket message for a per-operating-state colour
// or for any animation/pattern. `GET/PUT /machine/ledStrip` (see api.js) only
// ever reads/writes the awake/sleeping palette. So nothing here is sent to the
// machine: it is saved locally (and synced via settingsSync.js like any other
// preference) so the settings surface is ready the day firmware support lands.
// The Lighting settings page renders an animated CSS preview only — never a
// live strip preview — for exactly this reason.
//
// Machine-state ids below are a CURATED SUBSET of api.js's `MachineState`
// values (kept as plain strings, not imported, so this module stays DOM-free
// for node:test — api.js touches `window`/`fetch` at module scope). Keep the
// `state` values in sync with `MachineState` in ../modules/api.js by hand;
// states with no ambient-lighting relevance (booting, calibration, selfTest,
// fwUpgrade, error, …) are deliberately left out.
//
// DOM-free on purpose so node:test can import it directly
// (test/led-animation.test.mjs); the Lighting settings page is the consumer.

/** Ordered list of machine states a user can assign an animation to. */
export const LED_ANIMATION_STATES = [
    { id: 'idle', label: 'Idle' },
    { id: 'heating', label: 'Heating' },
    { id: 'ready', label: 'Ready' },
    { id: 'espresso', label: 'Espresso' },
    { id: 'steam', label: 'Steam' },
    { id: 'hotWater', label: 'Hot Water' },
    { id: 'cleaning', label: 'Cleaning' },
];

/** Animation presets offered per state. 'off' keeps the strip on its static colour. */
export const LED_ANIMATION_PRESETS = [
    { id: 'off', label: 'Off' },
    { id: 'pulse', label: 'Pulse' },
    { id: 'breathe', label: 'Breathe' },
    { id: 'rainbow', label: 'Rainbow Cycle' },
    { id: 'chase', label: 'Chase' },
    { id: 'sparkle', label: 'Sparkle' },
];

const STATE_IDS = new Set(LED_ANIMATION_STATES.map((s) => s.id));
const PRESET_IDS = new Set(LED_ANIMATION_PRESETS.map((p) => p.id));

/** True when `id` is one of the states an animation can be assigned to. */
export const isValidLedAnimationState = (id) => STATE_IDS.has(id);

/** True when `id` is one of the offered animation presets. */
export const isValidLedAnimationPreset = (id) => PRESET_IDS.has(id);

/** Every state defaults to 'off' — no behaviour change until the user opts in. */
export const DEFAULT_LED_ANIMATIONS = Object.freeze(
    Object.fromEntries(LED_ANIMATION_STATES.map((s) => [s.id, 'off'])),
);

/** localStorage key (mirrored to KV by settingsSync.js like other `streamline.*` keys). */
export const LED_ANIMATIONS_KEY = 'streamline.ledAnimations';

/**
 * Sanitize an arbitrary value (parsed JSON, possibly from an older/corrupt
 * build) into a complete { stateId: presetId } map: every known state gets a
 * valid preset, unknown states and invalid preset ids are dropped rather than
 * carried through, defaulting the state to 'off'.
 */
export function normalizeLedAnimations(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const out = {};
    for (const { id } of LED_ANIMATION_STATES) {
        const preset = src[id];
        out[id] = isValidLedAnimationPreset(preset) ? preset : 'off';
    }
    return out;
}

/**
 * Stored JSON string → normalized assignments. Malformed/missing JSON falls
 * back to all-off rather than throwing — a corrupt preference must never break
 * the settings page.
 */
export function parseLedAnimations(json) {
    if (!json) return { ...DEFAULT_LED_ANIMATIONS };
    try {
        return normalizeLedAnimations(JSON.parse(json));
    } catch (e) {
        return { ...DEFAULT_LED_ANIMATIONS };
    }
}

/** Normalized assignments → JSON string for storage. */
export function serializeLedAnimations(assignments) {
    return JSON.stringify(normalizeLedAnimations(assignments));
}

/**
 * Pure state transition: assign `presetId` to `stateId` within `assignments`.
 * Returns a NEW object; invalid state/preset ids are ignored and the input
 * (normalized) is returned unchanged, so a bad call can never corrupt storage.
 */
export function setLedAnimation(assignments, stateId, presetId) {
    const current = normalizeLedAnimations(assignments);
    if (!isValidLedAnimationState(stateId) || !isValidLedAnimationPreset(presetId)) return current;
    return { ...current, [stateId]: presetId };
}

/** Assignment lookup with the same "always a valid preset" guarantee. */
export function ledAnimationFor(assignments, stateId) {
    return normalizeLedAnimations(assignments)[stateId] || 'off';
}
