// Cleaning and descaling progress — machine state/substate → milestone indicator.
//
// PUT /api/v1/machine/state/{cleaning,descaling} hands the entire cycle to the
// firmware; the app only watches it happen. The snapshot socket reports the
// machine state plus a substate naming the current step. Three things make a
// bare `state === procedure.state` check wrong for a status line:
//
//  - Entry is not instant. The PUT returns before the machine reports the new
//    state, so the first frames still say idle/sleeping. Reading that as
//    "not running" flashes a false "finished" the moment you press Start.
//  - Exit is silent. The firmware drops back to idle when the cycle completes;
//    there is no completion event. "Done" is only knowable as: we saw the
//    state, and now we don't.
//  - No snapshot is NOT "not running". A null state means the socket has yet
//    to deliver or has dropped, and the machine may well be mid-cycle. Folding
//    that in as a normal frame times out a running cycle, or reports a finish
//    that never happened. It is tracked as `stale` instead, and neither the
//    timeout nor the done transition advances while blind.
//
// Substate spellings come from the Decaid Dart enum (MachineSubstate in
// lib/src/models/device/machine.dart), NOT from rest_v1.yml — the spec lists
// `cleaingGroup`, a typo that never appears on the wire.
//
// Every milestone label and caption is an existing key in
// `src/ui/de1 gui translation - Sheet1.csv`, so this adds no translation rows.
// Two choices there are not obvious:
//
//  - The completion caption is `Ready`, not `Done`. The sheet's `Done` and
//    `done` are translated for a shot-history "since stop" label ("Terminé
//    depuis", "Angehalten seit"), and the correctly-translated `2) Done` /
//    `3) Done` rows carry a step-number prefix that cannot be stripped
//    uniformly (zh uses a fullwidth `3）`, ar/he put the numeral last).
//    `Ready` is unprefixed and correct in all 18 languages it is filled for.
//  - `Starting` is right in 20 of its 24 filled columns, but the three German
//    variants read "App wird gestartet" (the APP is starting). That is a cell
//    to correct in the sheet, not a reason for a new row.
//
// Only the two failure sentences are new keys, and they are deliberately
// procedure-neutral so one translation covers both cycles.
//
// DOM-free on purpose so `node --test test/` can import it (see test/README.md).

/** How long to wait for the machine to actually enter the state before giving up. */
export const MAINTENANCE_START_TIMEOUT_MS = 20000;

/**
 * Cleaning: cleanInit → cleanFillGroup → cleanSoak → cleanGroup.
 *
 * Decaid collapses BOTH cleanFillGroup and cleanGroup onto the single substate
 * `cleaningGroup` (de1.utils.dart:97-101), so the wire cannot tell fill from
 * flush on its own. Order does: a `cleaningGroup` before the soak is the fill,
 * after it is the flush. Joining a cycle already in progress on a
 * `cleaningGroup` frame is genuinely ambiguous and is shown as the fill.
 */
export const CLEANING_PROCEDURE = Object.freeze({
    state: 'cleaning',
    milestones: Object.freeze(['Starting', 'Filling', 'Soak', 'Flush']),
    milestoneFor(substate, previous) {
        if (substate === 'cleaningStart') return 0;
        if (substate === 'cleanSoaking') return 2;
        if (substate === 'cleaningGroup') return previous >= 2 ? 3 : 1;
        return previous;
    },
});

/**
 * Descaling: descaleInt → descaleFillGroup → descaleReturn (internals) →
 * descaleGroup → descaleSteam.
 *
 * Three milestones, not five: Decaid maps descaleFillGroup, descaleReturn AND
 * descaleGroup all onto `cleaningGroup` (de1.utils.dart:96-101), and unlike the
 * cleaning cycle nothing else arrives in between to separate them by order. The
 * middle of a descale is genuinely one indistinguishable phase over this API.
 */
export const DESCALING_PROCEDURE = Object.freeze({
    state: 'descaling',
    milestones: Object.freeze(['Starting', 'Descaling', 'Steam']),
    milestoneFor(substate, previous) {
        if (substate === 'cleaningStart') return 0;
        if (substate === 'cleaningGroup') return 1;
        if (substate === 'cleaningSteam') return 2;
        return previous;
    },
});

/** Nothing has been started, and nothing observed. */
export function initialProcedureState() {
    return { phase: 'idle', milestone: -1, entered: false, stale: false, waitedMs: 0 };
}

/** The user pressed Start and the PUT went out; the machine has yet to confirm. */
export function startedProcedureState() {
    return { phase: 'waiting', milestone: -1, entered: false, stale: false, waitedMs: 0 };
}

/**
 * Fold one snapshot frame into the cycle state.
 *
 * Observing the procedure's state always means running, whoever started it —
 * pressing Clean or Descale on the machine itself shows up here too, which is
 * why this needs no separate "adopt a run in progress" path at mount.
 *
 * @param {object} previous
 * @param {{state?: string|null, substate?: string|null, tickMs?: number}} frame
 *        state null/undefined = no snapshot available (socket silent)
 * @param {object} procedure CLEANING_PROCEDURE or DESCALING_PROCEDURE
 * @returns {object} previous itself when nothing changed
 */
export function advanceProcedureState(previous, frame, procedure) {
    const prev = previous ?? initialProcedureState();
    const { state = null, substate = null, tickMs = 0 } = frame ?? {};

    // Blind. Only worth flagging while we are actually tracking a cycle.
    if (state == null) {
        if (prev.phase !== 'waiting' && prev.phase !== 'running') return prev;
        return prev.stale ? prev : { ...prev, stale: true };
    }

    if (state === procedure.state) {
        // Never move backwards: a repeated or out-of-order frame must not rewind
        // the strip the user is watching.
        const from = Math.max(prev.milestone, 0);
        const milestone = Math.max(from, procedure.milestoneFor(substate, from));
        if (prev.phase === 'running' && milestone === prev.milestone && !prev.stale) return prev;
        return { phase: 'running', milestone, entered: true, stale: false, waitedMs: 0 };
    }

    // Was running on the previous frame, is not now: the firmware finished.
    if (prev.phase === 'running') {
        return {
            phase: 'done',
            milestone: procedure.milestones.length,
            entered: true,
            stale: false,
            waitedMs: 0,
        };
    }

    if (prev.phase !== 'waiting') return prev.stale ? { ...prev, stale: false } : prev;

    // Count only frames we could actually see, so time spent waiting on the
    // socket does not burn the machine's window to enter the state.
    const waitedMs = prev.waitedMs + tickMs;
    if (waitedMs >= MAINTENANCE_START_TIMEOUT_MS) {
        return { phase: 'timeout', milestone: -1, entered: false, stale: false, waitedMs };
    }
    return { ...prev, stale: false, waitedMs };
}

/** True while the cycle is being tracked — the Start button reads Stop. */
export function isProcedureActive(procedureState) {
    return procedureState?.phase === 'waiting' || procedureState?.phase === 'running';
}

/**
 * Descaling pushes descaler through the steam path, so it must not start
 * against a hot steam boiler: the heater goes off and the boiler has to drop to
 * this temperature first (Decent's descaling instructions).
 */
export const DESCALE_STEAM_MAX_C = 60;

/** How long to wait for the steam boiler to fall before giving up on a descale. */
export const STEAM_COOLDOWN_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Whether the steam boiler is cool enough to descale.
 *
 * A missing reading is NOT "still hot": the snapshot carries no steam
 * temperature at all on some machines, and blocking on a number that will never
 * arrive would make descaling impossible. Unknown proceeds, like the wake path.
 */
export function steamCoolEnoughToDescale(steamTemperature) {
    return typeof steamTemperature !== 'number' || !Number.isFinite(steamTemperature)
        || steamTemperature <= DESCALE_STEAM_MAX_C;
}

/** How long to give the machine to leave `sleeping` before starting anyway. */
export const WAKE_TIMEOUT_MS = 15000;

/**
 * Whether to send a wake before the start request.
 *
 * Only a confirmed `sleeping` earns one. An unknown state (no snapshot yet) does
 * not: a wake there would be guesswork that delays the actual request, and the
 * cycle's own entry timeout already reports a machine that never started.
 */
export function shouldWakeBeforeStart(state) {
    return state === 'sleeping';
}

/** True once the machine has left sleep — the wake landed. */
export function isAwake(state) {
    return state != null && state !== 'sleeping';
}

/**
 * What the milestone strip should look like, or null when there is nothing to
 * show yet — the indicator stays hidden until a cycle is actually under way.
 *
 * The caption names the current milestone and nothing else: the dots already
 * carry the position, which keeps every caption a single existing translation
 * key instead of a composed "Step 2 of 4" that no CSV column can hold.
 *
 * @returns {{milestone: number, labels: readonly string[], caption: string, tone: string}|null}
 *          tone: info | progress | success | error
 */
export function procedureIndicatorView(procedureState, procedure) {
    const phase = procedureState?.phase ?? 'idle';
    if (phase === 'idle') return null;

    const milestone = procedureState.milestone ?? -1;
    const base = { milestone, labels: procedure.milestones };

    if (procedureState.stale && (phase === 'waiting' || phase === 'running')) {
        return { ...base, caption: 'Lost contact with the machine. Reconnecting...', tone: 'error' };
    }

    switch (phase) {
        case 'waiting':
            return { ...base, caption: 'Starting', tone: 'info' };
        case 'running':
            return { ...base, caption: procedure.milestones[milestone], tone: 'progress' };
        case 'done':
            return { ...base, caption: 'Ready', tone: 'success' };
        default:
            return { ...base, caption: 'The machine did not start. Check that it is awake and connected.', tone: 'error' };
    }
}
