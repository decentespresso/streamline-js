// Pure helpers for the Bengle load-cell calibration wizard.
//
// The wizard UI lives in src/settings/settings.js and drives Decaid's
// PUT /api/v1/machine/scaleCalibration (two-point firmware cal: zero the
// empty platform, then latch the SAME known mass on the LEFT and RIGHT
// halves; the firmware auto-detects the cell and solves both per-cell
// gains). That call only *starts* a step and answers 202 immediately, so
// the wizard polls GET /api/v1/machine/scaleCalibration until the step
// leaves its busy phase. This module holds the DOM-free logic —
// reference-mass clamping, the request-body wire shape, the state
// classifier used by the poll loop, and the action-area state map — so the
// node:test suite can lock it in (see test/loadcell-cal.test.mjs and
// test/README.md).

export const CAL_WEIGHT_MIN_G = 1;
export const CAL_WEIGHT_MAX_G = 10000;
export const CAL_WEIGHT_DEFAULT_G = 500;

/**
 * Clamp a reference-mass entry to an integer 1–10000 g.
 * Accepts numbers or numeric strings (the numpad dispatches a change event
 * with a string value). Unparseable input returns null — callers keep the
 * previous mass rather than corrupting it.
 */
export function clampCalWeight(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (isNaN(n)) return null;
    return Math.max(CAL_WEIGHT_MIN_G, Math.min(CAL_WEIGHT_MAX_G, Math.round(n)));
}

/**
 * Build the ScaleCalibrationCommandRequest body. The API takes three
 * commands — 'zero', 'latch' and 'abort'; there is no left/right pair, the
 * same 'latch' runs once per cell and the firmware auto-detects which one
 * is loaded. `weightGrams` is required for 'latch' and must not be sent
 * with the other two.
 * @param {'zero'|'latch'|'abort'} command
 * @param {number} [grams]
 */
export function buildCalibrateBody(command, grams) {
    const body = { command };
    if (command === 'latch' && grams != null) body.weightGrams = grams;
    return body;
}

// Steps where the firmware is still settling/averaging — keep polling.
const CAL_BUSY_STEPS = ['zeroing', 'calLatch', 'taring'];

// `status` is the result of the last LATCH attempt (rest_v1.yml), not of
// the step just run: it survives a zero. 'ok' is a solved cell,
// 'incomplete' is the first latch of the ordered pair (one cell solved,
// awaiting the other) and 'none' means no latch was attempted.
// Everything else is a failure the user has to act on — but only when the
// step that just finished was itself a latch; see checkStatus below.
const CAL_STATUS_MESSAGES = {
    noZero: 'Zero the empty platform first',
    notSettled: 'The scale never settled — keep the machine still and retry',
    badWeight: 'The mass on the cell does not match the entered weight',
    badDelta: 'Weight change too small — put the mass on a bare load cell',
    illConditioned: 'Could not solve the cell gains — reseat the mass and retry',
    outOfRange: 'Load-cell reading out of range',
    notIsolated: 'The mass is not isolated on one cell — remove the platform',
};

/**
 * Classify a ScaleCalibrationState into what the wizard needs: keep
 * polling, finished, or failed with a message to show.
 * @param {{step?: string, subState?: string, status?: string}} state
 * @param {boolean} [checkStatus] read `status` as this step's result. True
 *   only for 'latch'. A zero leaves the previous latch's status parked in
 *   the register, so reading it after a zero reports a stale failure for a
 *   step that worked — which is exactly the failed-latch -> Start Over ->
 *   Zero path.
 * @returns {{busy: boolean, done: boolean, error: string}}
 */
export function classifyCalState(state, checkStatus = true) {
    if (!state || typeof state !== 'object') {
        return { busy: false, done: false, error: 'No calibration state returned' };
    }
    if (CAL_BUSY_STEPS.includes(state.step)) {
        return { busy: true, done: false, error: '' };
    }
    const statusError = checkStatus ? CAL_STATUS_MESSAGES[state.status] : null;
    if (statusError) return { busy: false, done: false, error: statusError };
    if (state.step === 'error' || state.subState === 'error') {
        return { busy: false, done: false, error: 'The machine reported a calibration error' };
    }
    return { busy: false, done: true, error: '' };
}

/**
 * Resolve the wizard action area's state -> {status, statusText, label,
 * action, primary}. ONE button that swaps label/action in place, plus a
 * fixed-height status slot, so the card height stays constant and buttons
 * never jump (the errorLine/doneRow first cut was rejected for jumping):
 *   done  -> status '✓ Done',   button 'Next'  (primary)  -> next step
 *   busy  -> status busyLabel,  button 'Cancel' (secondary) -> abort
 *   error -> status the error,  button runLabel (primary)  -> retry the step
 *   idle  -> status blank,      button runLabel (primary)  -> run the step
 * `done` wins over `busy`/`error`;
 * a step that succeeded always offers Next.
 */
export function calActionState({ busy, error, done, runLabel, busyLabel }) {
    if (done) {
        return { status: 'done', statusText: '', label: 'Next', action: 'next', primary: true };
    }
    if (busy) {
        return { status: 'busy', statusText: busyLabel, label: 'Cancel', action: 'cancel', primary: false };
    }
    if (error) {
        return { status: 'error', statusText: error, label: runLabel, action: 'run', primary: true };
    }
    return { status: 'idle', statusText: '', label: runLabel, action: 'run', primary: true };
}
