// Per-profile flow calibration.
//
// Decaid has no per-profile multiplier. ShotSequencer takes
// weightFlowMultiplier / volumeFlowMultiplier as constructor arguments and
// de1_state_manager.dart builds a fresh sequencer per shot from the app-wide
// settings controller, so the only way to give a profile its own numbers is to
// push them into POST /api/v1/settings *before* the shot arms — i.e. when the
// profile becomes active — and to put the user's own numbers back when a
// profile that carries no calibration of its own becomes active.
//
// Putting them back needs a baseline: the value that holds when no profile
// overrides it. It is captured the first time a profile's numbers are pushed,
// and re-captured whenever the global Settings → Quick Adjustments → Flow
// calibration page is edited behind our back — detectable because the live
// value then differs from the last value this module wrote. Baseline and
// last-written both live in KV, so a reload cannot strand the machine on some
// profile's number with no way home.
//
// The per-profile numbers themselves are ordinary profile overrides
// (profile-overrides.js), keyed by profile id like dose/yield/grind.

import { logger } from './logger.js';
import { getProfileOverride, ensureProfileOverridesLoaded } from './profile-overrides.js';

export const FLOW_CAL_NAMESPACE = 'streamlineFlowCalibration';
export const FLOW_CAL_STATE_KEY = 'state';
export const FLOW_CAL_KEYS = Object.freeze(['weightFlowMultiplier', 'volumeFlowMultiplier']);

// Decaid's own defaults (settings_service.dart): what a fresh install reports,
// and the only sane fallback when /settings answers without these keys.
export const FLOW_CAL_DEFAULTS = Object.freeze({ weightFlowMultiplier: 1, volumeFlowMultiplier: 0.3 });

// The settings round-trip is a JSON double, and the spinners step by 0.05, so
// exact equality would call 0.30000000000000004 a user edit and adopt it as a
// new baseline. One part in a million is far below anything a user can type.
const EPSILON = 1e-6;

let client = null;  // injected in tests; otherwise api.js, imported lazily
let cachedState = null;
let stateLoaded = false;
let applyChain = Promise.resolve();
let requestedProfileId = null;

// api.js pulls in DOM-touching modules — keep this file importable on its own.
async function apiClient() {
    return client ||= await import('./api.js');
}

/** Test seam: swap the api.js surface this module uses. Returns a restore fn. */
export function setFlowCalibrationClient(stub) {
    client = stub;
    return () => { client = null; };
}

/** Test seam: forget the cached KV state between cases. */
export function resetFlowCalibrationState() {
    cachedState = null;
    stateLoaded = false;
    applyChain = Promise.resolve();
    requestedProfileId = null;
}

/** The finite flow-calibration numbers in `source`, and nothing else. */
export function pickFlowCalibration(source) {
    const out = {};
    for (const key of FLOW_CAL_KEYS) {
        const value = Number(source?.[key]);
        if (Number.isFinite(value)) out[key] = value;
    }
    return out;
}

export function sameFlowCalibration(a, b) {
    return FLOW_CAL_KEYS.every(key => Math.abs(Number(a?.[key]) - Number(b?.[key])) < EPSILON);
}

/**
 * Decide what the machine's global multipliers should be now that `override`
 * (the active profile's saved numbers, or null) is in charge.
 *
 * `current` is what /settings reports, `state` is {baseline, applied} as this
 * module last persisted it. Pure — every caller-visible effect is in the result.
 */
export function resolveFlowCalibration({ current, state, override } = {}) {
    const live = { ...FLOW_CAL_DEFAULTS, ...pickFlowCalibration(current) };

    // The live value still being the one we wrote means nobody touched the
    // global page since, so the stored baseline is still the user's own number.
    // Anything else — including the very first run, where nothing was written —
    // means the live value IS the user's number.
    const ours = state?.applied && sameFlowCalibration(state.applied, live);
    const baseline = ours
        ? { ...live, ...pickFlowCalibration(state.baseline) }
        : live;

    const desired = { ...baseline, ...pickFlowCalibration(override) };
    return {
        baseline,
        desired,
        write: !sameFlowCalibration(desired, live),
        state: { baseline, applied: desired }
    };
}

async function loadState() {
    if (stateLoaded) return cachedState;
    try {
        const { getValueFromStore } = await apiClient();
        const raw = await getValueFromStore(FLOW_CAL_NAMESPACE, FLOW_CAL_STATE_KEY);
        cachedState = raw && typeof raw === 'object' ? raw : null;
    } catch (e) {
        // No Decaid, or nothing stored yet: treat the live value as the baseline.
        logger.info(`Flow calibration state unavailable: ${e.message}`);
        cachedState = null;
    }
    stateLoaded = true;
    return cachedState;
}

async function saveState(state) {
    cachedState = state;
    stateLoaded = true;
    try {
        const { setValueInStore } = await apiClient();
        await setValueInStore(FLOW_CAL_NAMESPACE, FLOW_CAL_STATE_KEY, state);
    } catch (e) {
        // In-memory state still carries this session; only a reload loses it.
        logger.warn('Failed to persist flow calibration baseline:', e);
    }
}

/**
 * Push `profileId`'s flow calibration to the machine, or restore the baseline
 * when it has none. Safe to call on every profile switch: it writes only when
 * the live value is wrong, and never throws.
 *
 * Runs one at a time, and a switch that has already been superseded is
 * dropped: two overlapping calls would both read the live value before either
 * POST landed, so the slower one would decide against a stale reading and the
 * machine could end up on the previous profile's multiplier.
 */
export function applyFlowCalibrationForProfile(profileId) {
    requestedProfileId = profileId;
    const run = applyChain.then(() => applyNow(profileId));
    applyChain = run.catch(() => {}); // a failure must not wedge the queue
    return run;
}

async function applyNow(profileId) {
    if (profileId !== requestedProfileId) return null; // a newer switch owns the machine
    try {
        const { getReaSettings, setReaSettings } = await apiClient();
        const [current, state] = await Promise.all([getReaSettings(), loadState(), ensureProfileOverridesLoaded()]);
        const override = profileId ? getProfileOverride(profileId) : null;
        const result = resolveFlowCalibration({ current, state, override: override || null });

        if (result.write) {
            await setReaSettings(result.desired);
            logger.info(`Flow calibration for ${profileId || 'no profile'}:`, result.desired);
        }
        if (!state || !sameFlowCalibration(state.baseline, result.state.baseline)
            || !sameFlowCalibration(state.applied, result.state.applied)) {
            await saveState(result.state);
        }
        return result;
    } catch (e) {
        // A calibration that cannot be pushed must not break a profile switch.
        logger.warn('Failed to apply flow calibration:', e);
        return null;
    }
}

/** The baseline the machine falls back to — for the editor's "global" hint. */
export async function getFlowCalibrationBaseline() {
    try {
        const { getReaSettings } = await apiClient();
        const [current, state] = await Promise.all([getReaSettings(), loadState()]);
        return resolveFlowCalibration({ current, state, override: null }).baseline;
    } catch (e) {
        logger.warn('Failed to read flow calibration baseline:', e);
        return { ...FLOW_CAL_DEFAULTS };
    }
}
