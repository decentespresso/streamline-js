// Screensaver policy — who may command the machine, and who may only paint.
//
// One tap on the sleep button put the machine to sleep and then woke it
// again 46 ms later. The cause was a conflation of a UI action with a machine
// command: ui.deactivateScreensaver() hid the overlay AND sent
// setMachineState('idle'). The sleep button optimistically raised the
// screensaver before the machine had confirmed the sleep; the next (still stale)
// snapshot said "idle", so app.js's "the machine is awake, tidy the overlay away"
// branch called deactivateScreensaver() — and that teardown woke the machine.
//
// The rules this module encodes:
//
//   1. The screensaver is a pure function of the machine's CONFIRMED state. The
//      skin never raises it optimistically, so a stale frame can never "undo" it.
//   2. Nothing that is not a wake may emit a wake. Hiding an overlay, changing a
//      display setting, or receiving a snapshot must never send 'idle'. Only the
//      user tapping the screensaver, or the user pressing the sleep button while
//      the machine is asleep, may wake it from this skin.
//
// deriveScreensaverAction() therefore returns only 'show' | 'hide' | 'none' — it
// is structurally incapable of asking for a machine command. The two callers
// (app.js's snapshot handler and ui.js's sleep button) are the enforcement points.
//
// DOM-free on purpose so `node --test test/` can import it (see test/README.md).

/** Machine states the policy cares about. Anything else counts as "awake". */
const SLEEPING = 'sleeping';

/** Is this CONFIRMED machine state a sleeping one? Case-insensitive, null-safe. */
export function isMachineAsleep(machineState) {
    return String(machineState || '').toLowerCase() === SLEEPING;
}

// ── Suppression while the machine is busy on our behalf ──────────────────────
//
// A firmware flash puts the DE1 to sleep for the minutes it takes, so the
// snapshot honestly reports 'sleeping' — and the overlay goes up (and the panel
// dims) over the progress bar the user is watching. The state is real, so the
// "confirmed state only" rule can't fix this; what's wrong is that a sleep WE
// caused for a foreground operation isn't an idle machine.
//
// ponytail: one module-global boolean — the firmware endpoint 409s a second
// concurrent update, so there is never more than one thing suppressing.
let suppressed = false;

/** Suppress the screensaver + panel dim for the duration of a foreground op. */
export function setScreensaverSuppressed(value) {
    suppressed = !!value;
}

/** Is the screensaver currently suppressed? */
export function isScreensaverSuppressed() {
    return suppressed;
}

/**
 * How long a wake WE asked for may go unconfirmed before we stop believing in it.
 *
 * A wake round-trips in ~100–300 ms (PUT, then the machine's next snapshot). This
 * is deliberately far longer, because the only cost of being generous is that a
 * genuinely-refused wake leaves the overlay down a little longer; and the only
 * cost of being stingy is the flicker we are here to remove.
 */
export const WAKE_CONFIRM_GRACE_MS = 3000;

/**
 * Is a wake we requested still in flight?
 *
 * Bounded on purpose. If the PUT is lost, or the machine refuses it, the grace
 * expires and the screensaver goes back to being a pure function of the machine's
 * confirmed state — which, if the machine really is still asleep, means the
 * overlay comes back. The suppression can never latch the overlay off.
 *
 * @param {number} wakeRequestedAt - Date.now() when the wake was sent; 0 = none.
 */
export function isWakePending(wakeRequestedAt, now = Date.now(), graceMs = WAKE_CONFIRM_GRACE_MS) {
    if (!wakeRequestedAt) return false;
    return (now - wakeRequestedAt) < graceMs;
}

/**
 * What the screensaver overlay should do, given the machine's CONFIRMED state.
 *
 * Never returns a machine command — a snapshot arriving, or an overlay being
 * torn down, is not a user asking for anything.
 *
 * @param {boolean} wakePending - we have sent 'idle' and the machine has not yet
 *   confirmed it. See the note on the 'show' branch below.
 * @returns {'show'|'hide'|'none'}
 */
export function deriveScreensaverAction({ machineState, screensaverActive, screensaverEnabled = true, wakePending = false } = {}) {
    if (isMachineAsleep(machineState)) {
        // The mirror of the previous race. That one was an optimistic SHOW undone by a stale
        // frame; this is an optimistic HIDE undone by one. The user tapped to wake,
        // so we took the overlay down and sent 'idle' — but for the next frame or
        // three the machine still honestly reports 'sleeping', because our PUT has
        // not round-tripped yet. Raising the overlay on those frames flashes it
        // back into the user's face for ~100–300 ms, right as they are reaching for
        // the machine.
        //
        // "Confirmed state is the only source of truth" is the right rule and it is
        // untouched: we are not painting a state we invented, we are declining to
        // repaint a state we have already asked the machine to leave. The wake is
        // still the ONLY thing that commands, and the suppression is time-bounded,
        // so an unconfirmed wake cannot hold the overlay down.
        if (wakePending) return 'none';

        // Only raise it if the user hasn't turned the feature off.
        return (screensaverEnabled && !screensaverActive) ? 'show' : 'none';
    }
    // Machine is awake. Take the overlay down if it is up — as a PAINT, not a command.
    return screensaverActive ? 'hide' : 'none';
}

/**
 * What the sleep button should do, given the machine's CONFIRMED state.
 *
 * `command` is the only machine command in this file, and it is only ever 'idle'
 * when the machine is genuinely asleep and the user pressed the button to wake
 * it — an explicit, user-initiated wake. Hiding the overlay is reported
 * separately (`hideScreensaver`) precisely so that hiding can never smuggle a
 * wake along with it.
 *
 * Note there is no "show the screensaver" outcome: the button does not raise the
 * overlay optimistically. app.js raises it when the machine CONFIRMS 'sleeping',
 * which is the 46 ms race closed at the source.
 *
 * @returns {{ command: 'idle'|'sleeping', hideScreensaver: boolean }}
 */
export function deriveSleepButtonAction({ machineState, screensaverActive = false } = {}) {
    if (isMachineAsleep(machineState)) {
        // Asleep -> the user wants it awake. One command, and take the overlay
        // down ourselves (the hide is a paint; the wake is this explicit command).
        return { command: 'idle', hideScreensaver: screensaverActive };
    }
    // Awake -> the user wants it asleep. No overlay work: app.js raises the
    // screensaver when the machine confirms it is sleeping.
    return { command: 'sleeping', hideScreensaver: false };
}

/**
 * What the panel brightness should do on a machine state TRANSITION.
 *
 * 'error' means the DE1 fell off BLE. It has to release the dim, because the only
 * other thing that does is an 'idle' frame and a machine that is gone never sends
 * one: a drop while the machine was asleep used to leave the tablet dark for the
 * rest of the session, recoverable only by the settings slider the user could not
 * see (reaprime#519). If it comes back still asleep, the sleeping transition dims
 * it again.
 *
 * Transition-only by design — the snapshot feed repeats the same state at ~10 Hz,
 * and re-dimming on every frame would clobber a brightness the user just chose.
 *
 * @returns {'dim'|'restore'|'none'}
 */
export function deriveDisplayAction(previousState, currentState) {
    if (previousState === currentState) return 'none';
    if (isMachineAsleep(currentState)) return 'dim';
    if (currentState === 'idle' || currentState === 'error') return 'restore';
    return 'none';
}
