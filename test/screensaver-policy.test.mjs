// One tap on the sleep button slept the machine and woke it 46 ms later.
//
// PUT /machine/state/sleeping  15:53:55.035
// PUT /machine/state/idle      15:53:55.081   <- the screensaver's teardown
//
// The teardown (deactivateScreensaver) emitted setMachineState('idle') as part of
// hiding the overlay. The sleep button raised the overlay optimistically; the next
// snapshot still said 'idle'; app.js's "the machine is awake, tidy the overlay
// away" branch tore it down — and the teardown woke the machine.
//
// These tests pin the invariant that makes that impossible: the screensaver action
// derived from a machine snapshot is PAINT-ONLY, and a hide never carries a wake.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    deriveDisplayAction,
    deriveReturnWake,
    deriveScreensaverAction,
    deriveSleepButtonAction,
    isMachineAsleep,
    mayTapWakeMachine,
    isWakePending,
    isScreensaverSuppressed,
    setScreensaverSuppressed,
    WAKE_CONFIRM_GRACE_MS,
} from '../src/modules/screensaver-policy.js';

// --- deriveScreensaverAction: a snapshot may paint, never command ---------------

test('the derived screensaver action is paint-only — "show" | "hide" | "none", never a command', () => {
    const states = ['idle', 'sleeping', 'espresso', 'steam', 'hotWater', 'heating', 'error', '', null, undefined];
    const allowed = new Set(['show', 'hide', 'none']);

    for (const machineState of states) {
        for (const screensaverActive of [true, false]) {
            for (const screensaverEnabled of [true, false]) {
                for (const wakePending of [true, false]) {
                    const action = deriveScreensaverAction({ machineState, screensaverActive, screensaverEnabled, wakePending });
                    assert.ok(allowed.has(action), `${machineState}/${screensaverActive}/${screensaverEnabled}/${wakePending} -> ${action}`);
                    // The point of the whole fix: no reachable input produces a wake.
                    assert.notEqual(action, 'idle');
                    assert.notEqual(action, 'wake');
                }
            }
        }
    }
});

test('machine confirms SLEEPING with the overlay down -> show it', () => {
    assert.equal(deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: false }), 'show');
});

test('machine confirms SLEEPING with the overlay already up -> do nothing', () => {
    assert.equal(deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: true }), 'none');
});

test('screensaver setting off: a sleeping machine does NOT raise the overlay', () => {
    assert.equal(
        deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: false, screensaverEnabled: false }),
        'none'
    );
});

test('THE BUG: an awake machine with the overlay up -> HIDE (a paint), not a wake', () => {
    // This is the exact branch that fired 46 ms after the sleep press, when the
    // stale snapshot still reported 'idle' and the overlay was optimistically up.
    // It must resolve to a hide — and hiding, in ui.js, sends nothing.
    assert.equal(deriveScreensaverAction({ machineState: 'idle', screensaverActive: true }), 'hide');
});

test('an awake machine with the overlay already down -> do nothing', () => {
    assert.equal(deriveScreensaverAction({ machineState: 'idle', screensaverActive: false }), 'none');
});

test('state matching is case-insensitive and null-safe', () => {
    assert.equal(deriveScreensaverAction({ machineState: 'SLEEPING', screensaverActive: false }), 'show');
    assert.equal(deriveScreensaverAction({ machineState: null, screensaverActive: true }), 'hide');
    assert.equal(deriveScreensaverAction(), 'none');
});

// --- the wake path: an optimistic HIDE must not be undone by a stale frame -------
//
// The mirror of the show-side race: that one was an optimistic SHOW undone by a stale 'idle' frame -
// and, back then, the teardown that followed woke the machine. This is an
// optimistic HIDE undone by a stale 'sleeping' frame: the user taps to wake, we
// take the overlay down at once, and for the next frame or three the machine still
// honestly reports 'sleeping' because the PUT has not round-tripped — so the
// overlay flashed back up for ~100–300 ms, right as the user reached for the
// machine. Same class of bug, opposite direction.

test('THE WAKE FLICKER: a stale "sleeping" frame does NOT re-raise the overlay we just hid', () => {
    // Exactly the frame that arrives ~100 ms after a tap-to-wake: the overlay is
    // down (we hid it), the machine still says 'sleeping', our 'idle' is in flight.
    assert.equal(
        deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: false, wakePending: true }),
        'none'
    );
});

test('and WITHOUT a wake in flight that very same frame still raises it', () => {
    // The discriminator: it is the pending wake that changes the answer, nothing
    // else. A machine that is asleep of its own accord must still show the overlay.
    assert.equal(
        deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: false, wakePending: false }),
        'show'
    );
});

test('the suppression CANNOT latch the screensaver off — it expires with the grace window', () => {
    // isWakePending is what app.js feeds in, and it goes false once the grace runs
    // out. A wake that is lost or refused therefore just lets the overlay come back.
    const sentAt = 10_000;
    const expired = isWakePending(sentAt, sentAt + WAKE_CONFIRM_GRACE_MS);

    assert.equal(expired, false, 'the grace window must close');
    assert.equal(
        deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: false, wakePending: expired }),
        'show',
        'once the wake has expired, a still-sleeping machine gets its overlay back'
    );
});

test('isWakePending: none / in-flight / expired', () => {
    assert.equal(isWakePending(0), false, 'no wake was ever sent');
    assert.equal(isWakePending(null), false);
    assert.equal(isWakePending(undefined), false);

    const sentAt = 50_000;
    assert.equal(isWakePending(sentAt, sentAt), true, 'just sent');
    assert.equal(isWakePending(sentAt, sentAt + 300), true, 'a normal round-trip is well inside the window');
    assert.equal(isWakePending(sentAt, sentAt + WAKE_CONFIRM_GRACE_MS - 1), true);
    assert.equal(isWakePending(sentAt, sentAt + WAKE_CONFIRM_GRACE_MS), false, 'boundary is exclusive');
    assert.equal(isWakePending(sentAt, sentAt + WAKE_CONFIRM_GRACE_MS + 1), false);
});

test('a pending wake never suppresses a HIDE - the show-side invariant is untouched', () => {
    // The show-side fix rests on an awake machine tidying the overlay away. wakePending
    // must not interfere with that branch at all: it only ever declines to SHOW.
    for (const machineState of ['idle', 'espresso', 'steam', 'heating']) {
        assert.equal(
            deriveScreensaverAction({ machineState, screensaverActive: true, wakePending: true }),
            'hide',
            `${machineState} with the overlay up must still hide it`
        );
    }
});

test('a pending wake does not override the user turning the screensaver off', () => {
    assert.equal(
        deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: false, screensaverEnabled: false, wakePending: true }),
        'none'
    );
});

test('wakePending defaults to false — an omitted flag never suppresses', () => {
    assert.equal(deriveScreensaverAction({ machineState: 'sleeping', screensaverActive: false }), 'show');
});

test('isMachineAsleep is case-insensitive and null-safe', () => {
    assert.equal(isMachineAsleep('sleeping'), true);
    assert.equal(isMachineAsleep('SLEEPING'), true);
    assert.equal(isMachineAsleep('Sleeping'), true);
    assert.equal(isMachineAsleep('idle'), false);
    assert.equal(isMachineAsleep(''), false);
    assert.equal(isMachineAsleep(null), false);
    assert.equal(isMachineAsleep(undefined), false);
});

// --- deriveSleepButtonAction ---------------------------------------------------

test('sleep button on an AWAKE machine: sends "sleeping", and nothing else', () => {
    const action = deriveSleepButtonAction({ machineState: 'idle', screensaverActive: false });
    assert.deepEqual(action, { command: 'sleeping', hideScreensaver: false });
});

test('THE RACE: the sleep button does NOT raise the screensaver optimistically', () => {
    // The old handler called activateScreensaver() right after PUT sleeping. That
    // opened the 46 ms window in which a stale 'idle' snapshot could tear the
    // overlay back down (and, back then, wake the machine). The screensaver now has
    // exactly one source of truth: the machine's CONFIRMED state, applied in app.js.
    const action = deriveSleepButtonAction({ machineState: 'idle', screensaverActive: false });
    assert.equal(action.command, 'sleeping');
    assert.ok(!('showScreensaver' in action), 'the button has no optimistic-show outcome at all');
});

test('sleep button on a SLEEPING machine: one wake, and the overlay comes down', () => {
    const action = deriveSleepButtonAction({ machineState: 'sleeping', screensaverActive: true });
    assert.deepEqual(action, { command: 'idle', hideScreensaver: true });
});

test('sleep button on a SLEEPING machine with no overlay up: still exactly one wake', () => {
    // Previously this path sent 'idle' twice — once itself, once via
    // deactivateScreensaver()'s baked-in wake.
    const action = deriveSleepButtonAction({ machineState: 'sleeping', screensaverActive: false });
    assert.deepEqual(action, { command: 'idle', hideScreensaver: false });
});

test('INVARIANT: a hide is never accompanied by a wake unless the machine is ASLEEP', () => {
    // "Nothing that is not a wake may emit a wake". The only input that
    // may yield command 'idle' is a machine that is genuinely sleeping — i.e. the
    // user pressing the button to wake it. Any awake state must yield 'sleeping',
    // no matter what the overlay is doing.
    for (const machineState of ['idle', 'espresso', 'steam', 'hotWater', 'heating', 'ready', '', null, undefined]) {
        for (const screensaverActive of [true, false]) {
            const action = deriveSleepButtonAction({ machineState, screensaverActive });
            assert.equal(action.command, 'sleeping', `state ${machineState} must never derive a wake`);
        }
    }

    for (const screensaverActive of [true, false]) {
        const action = deriveSleepButtonAction({ machineState: 'sleeping', screensaverActive });
        assert.equal(action.command, 'idle');
    }
});

test('sleep button derivation is pure — repeated calls give the same answer', () => {
    // The in-flight guard in ui.js is what stops a double-tap re-deriving against a
    // stale state; the derivation itself must not carry hidden state.
    const input = { machineState: 'idle', screensaverActive: false };
    assert.deepEqual(deriveSleepButtonAction(input), deriveSleepButtonAction(input));
    assert.deepEqual(deriveSleepButtonAction(input), { command: 'sleeping', hideScreensaver: false });
});

// --- deriveDisplayAction: a dim must always have something that undoes it -------
//
// reaprime#519: the DE1 dropped off BLE while asleep. The dim was applied on the
// 'sleeping' transition and only an 'idle' transition released it — which a machine
// that is no longer there never sends. The tablet stayed dark for the rest of the
// session, with the settings brightness slider (invisible on a dark panel) the only
// way back.

test('a machine that drops off BLE while asleep releases the dim', () => {
    assert.equal(deriveDisplayAction('idle', 'sleeping'), 'dim');
    assert.equal(deriveDisplayAction('sleeping', 'error'), 'restore');
});

test('every state that can follow a dim eventually restores — no dead end', () => {
    // Whatever the machine does next after we dimmed it, there must be a path back
    // to a lit panel. The only states that legitimately follow 'sleeping' are a wake
    // ('idle') and a disconnect ('error'); both restore.
    for (const next of ['idle', 'error']) {
        assert.equal(deriveDisplayAction('sleeping', next), 'restore', `${next} must undo the dim`);
    }
});

test('the display action is transition-only — a repeated state does nothing', () => {
    // The snapshot feed repeats the same state at ~10 Hz. Acting on every frame would
    // re-dim over a brightness the user just picked on the settings slider.
    for (const state of ['sleeping', 'idle', 'error', 'espresso']) {
        assert.equal(deriveDisplayAction(state, state), 'none');
    }
});

test('states that are neither sleep nor a wake nor a drop leave brightness alone', () => {
    for (const next of ['espresso', 'steam', 'hotWater', 'heating', 'flush', 'booting']) {
        assert.equal(deriveDisplayAction('idle', next), 'none');
    }
});

test('the first frame after boot dims if the machine is already asleep', () => {
    // previousMachineState starts undefined; an already-sleeping machine must still dim.
    assert.equal(deriveDisplayAction(undefined, 'sleeping'), 'dim');
    assert.equal(deriveDisplayAction(undefined, 'idle'), 'restore');
});

// --- plugin screensaver button: a plugin control tap never wakes ----------------

test('a tap on the overlay wakes; a tap on a plugin control or an idle overlay does not', () => {
    assert.equal(mayTapWakeMachine({ screensaverActive: true, onPluginControl: false }), true);
    assert.equal(mayTapWakeMachine({ screensaverActive: true, onPluginControl: true }), false);
    assert.equal(mayTapWakeMachine({ screensaverActive: false }), false);
    assert.equal(mayTapWakeMachine(), false);
});

// --- return from a long-press sleep exit ---------------------------------------

test('returning wakes a sleeping, idle or unknown machine and leaves a busy one alone', () => {
    assert.equal(deriveReturnWake('sleeping'), 'wake');
    assert.equal(deriveReturnWake('idle'), 'wake');
    assert.equal(deriveReturnWake(undefined), 'wake');
    assert.equal(deriveReturnWake(null), 'wake');
    assert.equal(deriveReturnWake('espresso'), 'skip');
});

// --- suppression is owned: two holders can overlap -----------------------------

test('a release only counts from the owner, so a sleep-exit cannot unsuppress a firmware flash', () => {
    setScreensaverSuppressed(true, 'firmware');
    setScreensaverSuppressed(true, 'sleepExit');
    // The sleep-exit path returns and releases its own hold; the flash is still running.
    setScreensaverSuppressed(false, 'sleepExit');
    assert.equal(isScreensaverSuppressed(), true);
    setScreensaverSuppressed(false, 'firmware');
    assert.equal(isScreensaverSuppressed(), false);
    // The default owner keeps the original firmware call sites working unchanged.
    setScreensaverSuppressed(true);
    assert.equal(isScreensaverSuppressed(), true);
    setScreensaverSuppressed(false);
    assert.equal(isScreensaverSuppressed(), false);
});
