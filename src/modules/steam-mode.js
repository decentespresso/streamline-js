// Steam-mode resolvers — pure and DOM-free so the node:test suite can import
// them (see test/steam-mode.test.mjs and test/README.md). ui.js and
// settings.js consume these; keep browser globals out of this module.

// Machine-model-specific defaults for steam flow (ml/s). Resolved at boot via
// ui.js setSteamFlowPresetsFromMachineModel(). The midGroup/highGroup model
// strings ("Bengle 10A" / "Bengle 15A") are forward-looking — today the app
// serializes exactly "Bengle" — keep them with their comments.
export const STEAM_FLOW_PRESETS_BY_MODEL = {
    standard: [0.4, 0.5, 0.6, 0.8],  // DE1Pro, DE1XL, Bengle (default)
    midGroup: [0.5, 0.8, 1.0, 1.2],  // Bengle 10A, DE1 XXL
    highGroup: [0.8, 1.0, 1.2, 1.5], // Bengle 15A
};

// Main-page Milk-mode stop-target presets (°C) — the temperature counterpart
// of the Time presets (15/30/45/60 s). Applied via the same stopAtTemperature
// path as every other milk-stop write, so values must sit inside the 30–80 °C
// clamp shared by the tile's +/- buttons and the settings page (80 = the
// documented API ceiling, rest_v1.yml SteamSettings.stopAtTemperature).
export const MILK_STOP_PRESETS = [55, 60, 65, 70];

/** Baseline steam-flow preset group for a machine-model string. */
export function resolveSteamFlowPresetsForModel(model) {
    const m = String(model || '').toLowerCase();
    if (m.includes('15a')) return STEAM_FLOW_PRESETS_BY_MODEL.highGroup;
    if (m.includes('10a') || m.includes('xxl')) return STEAM_FLOW_PRESETS_BY_MODEL.midGroup;
    return STEAM_FLOW_PRESETS_BY_MODEL.standard;
}

/**
 * Index of the steam-flow preset to highlight for a given flow value, or -1
 * when the flow matches no preset (no highlight — the honest state for a
 * hand-dialed flow). Matching is at the tile's 0.1 ml/s display precision.
 *
 * The highlight is DERIVED from the current flow value, read-only in both
 * directions: this function never yields a flow value and callers must never
 * write one when applying it (the old boot path did the reverse, pushing
 * the persisted tap-index's VALUE into the workflow, silently resetting a
 * hand-dialed flow on every app load).
 * @param {number[]} presets  resolved steam-flow presets (baseline or user-edited)
 * @param {*} flow  current steam flow (workflow.steamSettings.flow)
 * @returns {number}  matching preset index, or -1 for none
 */
export function steamFlowHighlightIndex(presets, flow) {
    if (!Array.isArray(presets) || typeof flow !== 'number' || !isFinite(flow)) return -1;
    return presets.findIndex(p =>
        typeof p === 'number' && isFinite(p) && p.toFixed(1) === flow.toFixed(1));
}

// Steam-stop mode is a skin-side concept: reaprime stores only the independent
// `stopAtTemperature` field (0 = off), not a mode enum. We derive 'temperature'
// from a non-zero milk target; 'time' vs 'off' (both stopAtTemperature = 0) is
// disambiguated by a skin-local preference. 'temperature' is never valid off a
// Bengle.
/**
 * Resolve the settings-page steam-stop mode.
 * @param {number} stopTemp  workflow.steamSettings.stopAtTemperature (0 = off)
 * @param {string|null} storedMode  skin-local preference ('off'|'time'|'temperature')
 * @param {boolean} isBengle  connected machine is a Bengle
 * @returns {'off'|'time'|'temperature'}
 */
export function resolveSteamStopMode(stopTemp, storedMode, isBengle) {
    if (stopTemp > 0) return isBengle ? 'temperature' : 'time';
    if (storedMode === 'off') return 'off';
    if (storedMode === 'time') return 'time';
    if (storedMode === 'temperature') return isBengle ? 'temperature' : 'time';
    return 'time';
}

// ── Eco steam ────────────────────────────────────────────────────────────────
// Idle energy saver, ported from de1app (settings eco_steam, gui.tcl
// do_eco_steam, binary.tcl return_de1_packed_steam_hotwater_settings): after a
// spell with no interaction the steam target is dropped to just above the
// heater's cutoff, and any interaction puts it back.

/**
 * Target the steam boiler is parked at while eco steam is active.
 *
 * 136, not 135, is deliberate: the DE1 turns the steam heater off entirely
 * BELOW 135 (de1app binary.tcl:184; Decaid's De1Controller._writeSteamSettings
 * applies the same >= 135 rule), so eco parks one degree above the cutoff --
 * barely heated rather than cold, so steam comes back quickly.
 */
export const ECO_STEAM_TEMP = 136;

/** Idle time before the boiler is parked (de1app steam_eco_delay_seconds 600). */
export const ECO_STEAM_DELAY_MS = 10 * 60 * 1000;

/** Lowest steam target that means "steam is armed" -- below it the heater is off. */
export const STEAM_ENABLED_MIN_TEMP = 135;

/**
 * May eco steam take the boiler down right now?
 *
 * @param {object} o
 * @param {boolean} o.enabled  the user's eco steam setting
 * @param {string|null} o.machineState  latest confirmed machine state
 * @param {*} o.configuredTemp  the workflow's steam target
 * @returns {boolean}
 */
export function shouldEnterEcoSteam({ enabled, machineState, configuredTemp }) {
    if (!enabled) return false;
    // Only from a machine that is doing nothing. Steaming, pulling a shot or
    // flushing all mean the boiler is in use; asleep means the heater is already
    // off and there is nothing to save.
    if (machineState !== 'idle') return false;
    // Steam already off -> nothing to park, and entering would ARM a heater the
    // user turned off.
    return typeof configuredTemp === 'number' && configuredTemp >= STEAM_ENABLED_MIN_TEMP;
}

// ── Milk-probe presence ──────────────────────────────────────────────────────
// Snapshot contract: milkTemperature is real °C; 0 (or an absent field) means
// no probe / no reading. A probe must not flicker out on a single 0 frame, so
// presence drops only after a sustained interval without a positive reading.

/** How long milkTemperature must stay 0/absent before the probe counts as gone. */
export const MILK_PROBE_ABSENT_AFTER_MS = 5000;

/**
 * Fold one snapshot milkTemperature reading into a probe-presence state.
 * Present from the first positive reading; stays present through brief 0
 * glitches; absent after MILK_PROBE_ABSENT_AFTER_MS without a positive
 * reading. Starts (and stays, if never positive) absent — never fake a probe.
 * @param {{present:boolean,lastPositiveMs:number|null}|null} prev  previous state
 * @param {*} tempC  snapshot milkTemperature (any type — non-finite = absent)
 * @param {number} nowMs  current epoch ms
 * @returns {{present:boolean,lastPositiveMs:number|null}}
 */
export function resolveMilkProbePresence(prev, tempC, nowMs) {
    if (typeof tempC === 'number' && isFinite(tempC) && tempC > 0) {
        return { present: true, lastPositiveMs: nowMs };
    }
    const lastPositiveMs = prev?.lastPositiveMs ?? null;
    return {
        present: lastPositiveMs !== null && (nowMs - lastPositiveMs) < MILK_PROBE_ABSENT_AFTER_MS,
        lastPositiveMs,
    };
}

// The reaprime name a Bengle's onboard milk probe registers under once
// attached (BengleMilkProbe.info.name in reaprime, auto-registered by
// BengleProbeBridge — GET /api/v1/sensors is empty until then). Matched on
// name rather than vendor because the sensor list's `id` is an opaque,
// undocumented reaprime implementation detail (`${machineDeviceId}-milkprobe`)
// that must not be relied on as a stable contract.
const MILK_PROBE_SENSOR_NAME = 'Bengle Milk Probe';

/**
 * Pick the milk-probe sensor id out of a GET /api/v1/sensors response, if any
 * is currently registered. Returns null (never fakes an id) when the list is
 * empty, malformed, or has no matching entry — e.g. no Bengle connected, or a
 * Bengle connected with the probe not physically attached.
 * @param {Array<{id?:string, info?:{name?:string}}>} sensors  GET /api/v1/sensors response
 * @returns {string|null}
 */
export function selectMilkProbeSensorId(sensors) {
    if (!Array.isArray(sensors)) return null;
    const match = sensors.find((s) => s?.info?.name === MILK_PROBE_SENSOR_NAME && typeof s?.id === 'string' && s.id);
    return match?.id ?? null;
}

/**
 * Gate a resolved steam-stop mode on probe presence: 'temperature' is only
 * offerable with a probe attached; without one it falls back to the
 * previously-set non-temperature mode ('time' or 'off'; anything else → 'time').
 * Non-temperature modes pass through untouched.
 * @param {'off'|'time'|'temperature'} mode  from resolveSteamStopMode
 * @param {boolean} probePresent
 * @param {string|null} fallbackMode  skin-local record of the last non-temperature mode
 * @returns {'off'|'time'|'temperature'}
 */
export function applyMilkProbeGate(mode, probePresent, fallbackMode) {
    if (mode !== 'temperature' || probePresent) return mode;
    return fallbackMode === 'off' ? 'off' : 'time';
}

/**
 * Validates the main page's top-telemetry-row Milk field reading (live milk
 * probe temperature, shown after Weight). The field only EXISTS while the
 * probe is present: null means hide it entirely — no dashes, no placeholder.
 * A present probe with no usable reading yet (0 / non-finite / garbage) also
 * hides it, so the row never shows a fake temperature.
 * @param {boolean} present  debounced probe presence (resolveMilkProbePresence)
 * @param {*} tempC  latest positive reading (any type — non-finite = unusable)
 * @returns {number|null}  the raw Celsius reading, or null to hide the field
 */
export function milkTelemetryValue(present, tempC) {
    if (!present || typeof tempC !== 'number' || !isFinite(tempC) || tempC <= 0) return null;
    return tempC;
}

/**
 * Text for the main page's top-telemetry-row Milk field, always in °C.
 * Kept for callers that don't need unit-aware formatting; ui.js's live
 * telemetry row uses milkTelemetryValue() + units.js formatTemp() instead so
 * it can honor the user's C/F preference.
 * @param {boolean} present
 * @param {*} tempC
 * @returns {string|null}  e.g. "43.2°c", or null to hide the field
 */
export function milkTelemetryText(present, tempC) {
    const v = milkTelemetryValue(present, tempC);
    return v === null ? null : `${v.toFixed(1)}°c`;
}

/**
 * Resolve the MAIN-PAGE steam tile's display mode against milk availability
 * (Bengle machine + probe present) and the armed milk stop
 * (workflow stopAtTemperature > 0). Re-run whenever either input changes.
 *
 * With milk available the tile offers Milk|Flow: an armed stop pins Milk
 * ('temperature'); otherwise 'temperature' (just disarmed) and 'time' (not in
 * this pair) land on 'flow' — an un-armed stop never jumps back to Milk on its
 * own, so after a probe round-trip the mode stays on the fallback until the
 * user re-selects Milk. Without milk the tile offers Time|Flow: leaving
 * 'temperature' falls back to the user's recorded non-temperature stop mode —
 * 'off' shows the flow knob (no auto-stop → duration is meaningless), anything
 * else the duration knob ('time'); non-temperature modes pass through.
 * @param {'time'|'flow'|'temperature'} currentMode  the tile's current mode
 * @param {boolean} milkAvailable  Bengle with the milk probe present
 * @param {boolean} milkStopArmed  workflow stopAtTemperature > 0
 * @param {string|null} fallbackMode  skin-local record of the last non-temperature stop mode
 * @returns {'time'|'flow'|'temperature'}
 */
export function resolveSteamTileMode(currentMode, milkAvailable, milkStopArmed, fallbackMode) {
    if (milkAvailable) {
        if (milkStopArmed) return 'temperature';
        return (currentMode === 'temperature' || currentMode === 'time') ? 'flow' : currentMode;
    }
    if (currentMode === 'temperature') return fallbackMode === 'off' ? 'flow' : 'time';
    return currentMode;
}

// ── Steam push sync state ────────────────────────────────────────────────────
// A steam write goes through Rea's workflow queue, which can wedge and 503 the
// request 30s later (decaid#634). The tile has already painted the new number
// by then, so without tracking this it silently displays a value the machine
// never received. This fold owns "which field is unsynced, and how many retries
// are left"; ui.js owns the timer and the red styling.

/** Retries allowed after a failed steam push before the tile stops chasing it. */
export const STEAM_SYNC_RETRY_LIMIT = 3;

/** Clean (everything the user set is on the machine) sync state. */
export const STEAM_SYNC_SYNCED = { field: null, retriesLeft: 0 };

/**
 * Which steam tile field a push belongs to. The tile renders duration AND the
 * milk stop in the same element (steam-duration-value) and flow in the other,
 * so the mark follows the tile mode, not the API call that failed.
 * @param {'time'|'flow'|'temperature'} mode  current tile mode
 * @returns {'duration'|'flow'}
 */
export function steamSyncField(mode) {
    return mode === 'flow' ? 'flow' : 'duration';
}

/**
 * Fold one push outcome into the tile's sync state.
 *
 * A 'push-ok' only clears a mark left by the SAME field: a successful flow
 * write says nothing about a duration that never landed, and clearing on it
 * would hide the stale number again. 'retry-ok' clears unconditionally because
 * the retry reconciles every steam field at once (api.resyncSteamFromStore).
 * @param {{field:string|null, retriesLeft:number}} prev
 * @param {{type:'push-ok'|'push-failed'|'retry-ok'|'retry-failed', field?:string}} event
 * @returns {{field:string|null, retriesLeft:number}}
 */
export function foldSteamSyncState(prev, event) {
    const state = prev || STEAM_SYNC_SYNCED;
    switch (event?.type) {
        case 'push-failed':
            return { field: event.field, retriesLeft: STEAM_SYNC_RETRY_LIMIT };
        case 'push-ok':
            return state.field === event.field ? { ...STEAM_SYNC_SYNCED } : state;
        case 'retry-ok':
            return { ...STEAM_SYNC_SYNCED };
        case 'retry-failed':
            return { field: state.field, retriesLeft: Math.max(0, state.retriesLeft - 1) };
        default:
            return state;
    }
}

/** Whether a retry is still owed for the current sync state. */
export function shouldRetrySteamSync(state) {
    return !!state && state.field !== null && state.retriesLeft > 0;
}
