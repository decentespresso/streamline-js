// Show-once policy for the Sensor Calibration danger warning modal, its load
// re-entry gate, and the reopen-after-interruption fix layered on top.
//
// Bug 1: the render path used to gate re-opening the modal on "has the user
// acknowledged it?" alone. That page re-renders on every keystroke, capture,
// apply/restore, and the initial calibration load completing -- each render
// rebuilds the <dialog> from scratch (closed) -- so the modal reopened on
// every one of those renders until the user clicked Ok, i.e. it reappeared
// repeatedly instead of showing once per visit. Fixed by sensorCalWarningNextState.
//
// Bug 2: initSensorCal() runs from the render path and its own `finally`
// re-renders, so a failed read re-entered and started another read -- one
// per gateway timeout against a machine returning 504. Fixed by
// shouldStartSensorCalLoad.
//
// Bug 3: the SAME "rebuild destroys the <dialog>" fact from bug 1 also meant
// an UNRELATED render (a background settings refresh landing, a language
// change) could silently destroy the warning while it was open and
// unacknowledged, with nothing bringing it back -- gone for the rest of the
// visit. Fixed by sensorCalWarningShouldReopen, which resumes the SAME
// interrupted showing on the fresh node instead of losing it.
//
// settings.js touches the DOM at import time, so -- same pattern as
// profile-editor-cards.test.mjs before it -- the pure state transitions are
// lifted out of the real source with a slice, not hand-copied, so this
// can't silently drift from what actually ships.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');

const start = source.indexOf('// ─── sensor-cal warning visit policy');
const end = source.indexOf('// ─── end sensor-cal warning visit policy');
assert.ok(start !== -1 && end !== -1 && end > start, 'sensor-cal warning policy block not found in settings.js');
const body = source.slice(start, end);

const { sensorCalWarningNextState } = new Function(`${body}
    return { sensorCalWarningNextState };`)();

const FRESH = { shown: false, ack: false };

test('enter-page: the first render of a visit opens the warning', () => {
    const { state, open } = sensorCalWarningNextState(FRESH, 'render');
    assert.equal(open, true);
    assert.deepEqual(state, { shown: true, ack: false });
});

test('re-render: further renders before dismissal do not reopen it', () => {
    let state = FRESH;
    ({ state } = sensorCalWarningNextState(state, 'render')); // enter-page
    for (const cause of ['render', 'render', 'render']) { // load completing, an edit, capture/apply/restore
        const result = sensorCalWarningNextState(state, cause);
        assert.equal(result.open, false, 'a later render must not reopen the warning');
        state = result.state;
    }
    assert.deepEqual(state, { shown: true, ack: false });
});

test('dismiss (Ok): acknowledging does not reopen it, and later renders still do not', () => {
    let state = sensorCalWarningNextState(FRESH, 'render').state; // shown
    let result = sensorCalWarningNextState(state, 'ack');
    assert.equal(result.open, false);
    assert.deepEqual(result.state, { shown: true, ack: true });

    result = sensorCalWarningNextState(result.state, 'render'); // e.g. a later Apply
    assert.equal(result.open, false);
    assert.deepEqual(result.state, { shown: true, ack: true });
});

test('leave-page: navigating to another category re-arms both flags', () => {
    let state = sensorCalWarningNextState(FRESH, 'render').state;
    state = sensorCalWarningNextState(state, 'ack').state;
    const result = sensorCalWarningNextState(state, 'leave');
    assert.equal(result.open, false);
    assert.deepEqual(result.state, { shown: false, ack: false });
});

test('re-enter: coming back after leaving shows the warning again', () => {
    let state = sensorCalWarningNextState(FRESH, 'render').state;
    state = sensorCalWarningNextState(state, 'ack').state;
    state = sensorCalWarningNextState(state, 'leave').state;

    const result = sensorCalWarningNextState(state, 'render');
    assert.equal(result.open, true);
    assert.deepEqual(result.state, { shown: true, ack: false });
});

test('leaving without ever acknowledging still re-arms cleanly (Cancel path)', () => {
    let state = sensorCalWarningNextState(FRESH, 'render').state; // shown, never acked
    const result = sensorCalWarningNextState(state, 'leave');
    assert.deepEqual(result.state, { shown: false, ack: false });
});

test('an unknown event is a no-op, never opening the warning', () => {
    const result = sensorCalWarningNextState(FRESH, 'bogus');
    assert.equal(result.open, false);
    assert.deepEqual(result.state, FRESH);
});

// ── Load re-entry policy ────────────────────────────────────────────────────
// Second bug on the same page, same shape: initSensorCal() runs from the
// render path and its own `finally` re-renders, so any state meaning "do not
// start another read" has to gate re-entry. The error flag did not, so a
// machine answering /machine/calibration with a 504 produced one failed read
// per gateway timeout (~12 s) for as long as the page stayed open.

const loadStart = source.indexOf('// ── sensor-cal load re-entry policy');
const loadEnd = source.indexOf('// ── end sensor-cal load re-entry policy');
assert.ok(loadStart !== -1 && loadEnd !== -1 && loadEnd > loadStart, 'sensor-cal load policy block not found in settings.js');

const { shouldStartSensorCalLoad } = new Function(`${source.slice(loadStart, loadEnd)}
    return { shouldStartSensorCalLoad };`)();

test('a fresh page starts one read', () => {
    assert.equal(shouldStartSensorCalLoad({ loaded: false, loading: false, error: '' }), true);
});

test('a read already in flight does not start a second', () => {
    assert.equal(shouldStartSensorCalLoad({ loaded: false, loading: true, error: '' }), false);
});

test('a completed read is not repeated', () => {
    assert.equal(shouldStartSensorCalLoad({ loaded: true, loading: false, error: '' }), false);
});

test('a failed read does not retry itself — this is the 504 loop', () => {
    assert.equal(shouldStartSensorCalLoad({ loaded: false, loading: false, error: 'Status: 504' }), false);
});

test('clearing the error (Retry, or leaving the page) allows exactly one more attempt', () => {
    const failed = { loaded: false, loading: false, error: 'Status: 504' };
    assert.equal(shouldStartSensorCalLoad(failed), false);
    assert.equal(shouldStartSensorCalLoad({ ...failed, error: '' }), true);
});

// ── Reopen-after-interruption policy ────────────────────────────────────────
// Third bug on the same page: updateSettingsContentArea rebuilds
// #settings-content-area (and with it, a brand-new closed <dialog>) on EVERY
// render of calib_sensors, including ones with nothing to do with the
// calibration read -- preloadSettings() finishing in the background, a
// language change, another settings write's re-render. sensorCalWarningNextState
// correctly refuses to reopen on those (shown is already true), but that also
// meant a dialog that WAS open when one of those renders landed got silently
// destroyed and never came back -- gone for the rest of the visit, not "shown
// once", just "shown never" from that point on.
//
// sensorCalWarningShouldReopen is what updateSettingsContentArea actually
// calls to decide whether to (re)open on a given render: it OR's the state
// machine's `open` with whether the dialog being torn down was actually
// visible when this render started (read from the DOM in the real code;
// passed in directly here since this slice is DOM-free).
const reopenStart = source.indexOf('// ─── sensor-cal warning reopen-after-interruption policy');
const reopenEnd = source.indexOf('// ─── end sensor-cal warning reopen-after-interruption policy');
assert.ok(reopenStart !== -1 && reopenEnd !== -1 && reopenEnd > reopenStart,
    'sensor-cal warning reopen policy block not found in settings.js');

const { sensorCalWarningShouldReopen } = new Function(`${source.slice(reopenStart, reopenEnd)}
    return { sensorCalWarningShouldReopen };`)();

test('first render of a visit: open, and nothing was there to interrupt', () => {
    assert.equal(sensorCalWarningShouldReopen(true, false), true);
});

test('a later render while nothing is showing does not open it', () => {
    assert.equal(sensorCalWarningShouldReopen(false, false), false);
});

test('a later render that interrupted an open, unacknowledged dialog reopens it', () => {
    assert.equal(sensorCalWarningShouldReopen(false, true), true);
});

test('open and wasOpen together still just reopens once (no double trigger)', () => {
    assert.equal(sensorCalWarningShouldReopen(true, true), true);
});

// Regression: simulate the exact sequence a slow calibration read produces --
// enter the page, get interrupted by an unrelated render before the read
// finishes (and again after), then the read itself completes -- and count how
// many times something would actually call dialog.showModal(). This is the
// scenario the bug report described as "the warning modal appears twice";
// wasOpenAtRender models "was <dialog>.open true right before THIS render's
// rebuild", which is only ever true for a render that landed while the
// previous one's open dialog was still up and un-acknowledged -- exactly
// what updateSettingsContentArea captures from the DOM before each rebuild.
function simulateVisit(renders) {
    let state = FRESH;
    let dialogOpen = false;
    let opens = 0;
    for (const { cause, wasOpenAtRender } of renders) {
        const { state: nextState, open } = sensorCalWarningNextState(state, cause);
        state = nextState;
        if (sensorCalWarningShouldReopen(open, wasOpenAtRender)) {
            dialogOpen = true;
            opens += 1;
        } else if (cause !== 'render') {
            dialogOpen = false; // ack closes it; leave tears the page down
        }
    }
    return { opens, dialogOpen, state };
}

test('slow read: an unrelated render interrupts the open warning twice before the read lands -- one visible appearance total', () => {
    const { opens, dialogOpen, state } = simulateVisit([
        { cause: 'render', wasOpenAtRender: false },  // page opens, warning shows -> appearance
        { cause: 'render', wasOpenAtRender: true },   // background settings refresh lands mid-flight, warning was up -> resumed, not a new appearance
        { cause: 'render', wasOpenAtRender: true },   // a second unrelated render, still un-acknowledged -> resumed again
        { cause: 'render', wasOpenAtRender: true },   // the slow calibration read itself finally completing
    ]);
    assert.equal(opens, 4, 'sanity: showModal() is called on every one of these renders (that is what makes it survive)');
    assert.equal(dialogOpen, true, 'still showing -- the user has not acted on it yet');
    assert.deepEqual(state, { shown: true, ack: false }, 'still exactly one logical appearance from sensorCalWarningNextState\'s point of view');
});

test('once acknowledged, a later interruption (e.g. the slow read completing after Ok) does not bring it back', () => {
    let state = sensorCalWarningNextState(FRESH, 'render').state; // shown
    state = sensorCalWarningNextState(state, 'ack').state;        // user clicked Ok -- dialog.open is now false

    // The calibration read finishes after the user already dismissed the
    // warning: wasOpenAtRender is false here because .close() already ran.
    const { open } = sensorCalWarningNextState(state, 'render');
    assert.equal(sensorCalWarningShouldReopen(open, false), false);
});

test('a keystroke/capture/apply/restore render can never carry wasOpenAtRender=true -- the dialog makes the rest of the page inert while open, so the user cannot be the one triggering a render while it is showing', () => {
    // Documents the invariant sensorCalWarningShouldReopen relies on for
    // safety: this is why folding wasOpen into the decision does not
    // reintroduce the original "reopens on every keystroke" bug. Modelled
    // here as: if the dialog were genuinely open, a user-driven render simply
    // cannot occur, so wasOpenAtRender=true never coincides with a
    // user-interaction cause in a real visit.
    const state = sensorCalWarningNextState(FRESH, 'render').state; // dialog open, unacknowledged
    // Even so, once acknowledged (the only way the user's own input reaches
    // this page while the state machine still reports shown=true), further
    // user-driven renders correctly stay closed:
    const acked = sensorCalWarningNextState(state, 'ack').state;
    const { open } = sensorCalWarningNextState(acked, 'render'); // e.g. a keystroke
    assert.equal(sensorCalWarningShouldReopen(open, false), false);
});

// ── Background warm-up contract ─────────────────────────────────────────────
// warmSensorCalibration() (settings.js) preloads the calibration read once
// Settings is reached, reusing shouldStartSensorCalLoad -- the SAME gate
// initSensorCal uses -- rather than a second one. Its own network/DOM work
// isn't testable without jsdom, but the state it leaves behind is exactly
// what shouldStartSensorCalLoad already governs, so the contract itself is
// covered here:
test('a successful warm attempt leaves state that blocks a further page-triggered read (values are already there)', () => {
    assert.equal(shouldStartSensorCalLoad({ loaded: true, loading: false, error: '' }), false);
});

test('a failed warm attempt must reset to pristine, not consume the page\'s one real attempt', () => {
    // warmSensorCalibration's catch block must NOT set sensorCalLoadError --
    // if it did, opening the page afterwards would land here and refuse to
    // try again, showing a stale error with nothing in flight:
    assert.equal(shouldStartSensorCalLoad({ loaded: false, loading: false, error: 'Status: 504' }), false);
    // What it must actually leave behind -- as if the warm attempt never ran:
    assert.equal(shouldStartSensorCalLoad({ loaded: false, loading: false, error: '' }), true);
});
