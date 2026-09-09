import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    CLEANING_PROCEDURE,
    DESCALING_PROCEDURE,
    MAINTENANCE_START_TIMEOUT_MS,
    WAKE_TIMEOUT_MS,
    advanceProcedureState,
    initialProcedureState,
    isAwake,
    isProcedureActive,
    procedureIndicatorView,
    shouldWakeBeforeStart,
    startedProcedureState,
    steamCoolEnoughToDescale,
} from '../src/modules/maintenance-progress.js';

const TICK = 1000;

/** Feed n frames of the same shape. */
function run(state, frame, procedure, count = 1) {
    for (let i = 0; i < count; i += 1) {
        state = advanceProcedureState(state, { tickMs: TICK, ...frame }, procedure);
    }
    return state;
}

const caption = (state, procedure) => procedureIndicatorView(state, procedure)?.caption;

test('nothing is shown until a cycle is under way', () => {
    for (const procedure of [CLEANING_PROCEDURE, DESCALING_PROCEDURE]) {
        assert.equal(procedureIndicatorView(initialProcedureState(), procedure), null);
        assert.notEqual(procedureIndicatorView(startedProcedureState(), procedure), null);
    }
});

test('the lag between the PUT and the machine confirming does not read as finished', () => {
    for (const procedure of [CLEANING_PROCEDURE, DESCALING_PROCEDURE]) {
        const state = run(startedProcedureState(), { state: 'idle', substate: 'idle' }, procedure, 3);
        assert.equal(state.phase, 'waiting');
        assert.equal(caption(state, procedure), 'Starting');
    }
});

test('waiting expires when the machine never enters the state', () => {
    for (const procedure of [CLEANING_PROCEDURE, DESCALING_PROCEDURE]) {
        const state = run(startedProcedureState(), { state: 'sleeping' }, procedure, MAINTENANCE_START_TIMEOUT_MS / TICK);
        assert.equal(state.phase, 'timeout');
        assert.equal(procedureIndicatorView(state, procedure).tone, 'error');
    }
});

// Decaid maps cleanFillGroup and cleanGroup onto the same `cleaningGroup`
// substate, so fill vs flush is only recoverable from the order they arrive in.
test('cleaning: four milestones advance in firmware order across the collapsed substate', () => {
    let state = startedProcedureState();
    const seen = [];
    const step = substate => {
        state = run(state, { state: 'cleaning', substate }, CLEANING_PROCEDURE);
        seen.push(caption(state, CLEANING_PROCEDURE));
    };

    step('cleaningStart');
    step('cleaningGroup');   // fill: before the soak
    step('cleanSoaking');
    step('cleaningGroup');   // flush: after the soak

    assert.deepEqual(seen, ['Starting', 'Filling', 'Soak', 'Flush']);

    state = run(state, { state: 'idle', substate: 'idle' }, CLEANING_PROCEDURE);
    assert.equal(state.phase, 'done');
    assert.equal(state.milestone, CLEANING_PROCEDURE.milestones.length, 'every dot ticked when finished');
    assert.equal(caption(state, CLEANING_PROCEDURE), 'Ready');
});

// descaleFillGroup, descaleReturn AND descaleGroup all map to `cleaningGroup`,
// with nothing arriving in between to separate them — so three milestones is
// the honest maximum this API supports for a descale.
test('descaling: three milestones, with the indistinguishable middle as one phase', () => {
    let state = startedProcedureState();
    const seen = [];
    const step = substate => {
        state = run(state, { state: 'descaling', substate }, DESCALING_PROCEDURE);
        seen.push(caption(state, DESCALING_PROCEDURE));
    };

    step('cleaningStart');
    step('cleaningGroup');   // fill group
    step('cleaningGroup');   // internals
    step('cleaningGroup');   // group
    step('cleaningSteam');

    assert.deepEqual(seen, ['Starting', 'Descaling', 'Descaling', 'Descaling', 'Steam']);

    state = run(state, { state: 'idle' }, DESCALING_PROCEDURE);
    assert.equal(state.phase, 'done');
    assert.equal(state.milestone, DESCALING_PROCEDURE.milestones.length);
    assert.equal(caption(state, DESCALING_PROCEDURE), 'Ready');
});

test('the two procedures do not answer to each other\'s machine state', () => {
    const cleaningFrame = { state: 'cleaning', substate: 'cleanSoaking' };
    assert.equal(run(startedProcedureState(), cleaningFrame, DESCALING_PROCEDURE).phase, 'waiting');
    assert.equal(run(startedProcedureState(), cleaningFrame, CLEANING_PROCEDURE).phase, 'running');
});

test('milestones never move backwards', () => {
    let state = run(startedProcedureState(), { state: 'cleaning', substate: 'cleanSoaking' }, CLEANING_PROCEDURE);
    assert.equal(state.milestone, 2);
    state = run(state, { state: 'cleaning', substate: 'cleaningStart' }, CLEANING_PROCEDURE);
    assert.equal(state.milestone, 2);
});

test('cleaningSteam is a descale-path substate and holds position in a clean', () => {
    let state = run(startedProcedureState(), { state: 'cleaning', substate: 'cleanSoaking' }, CLEANING_PROCEDURE);
    state = run(state, { state: 'cleaning', substate: 'cleaningSteam' }, CLEANING_PROCEDURE);
    assert.equal(state.milestone, 2);
});

// The bug this module was rewritten for: no snapshot socket means state is null
// forever, and folding that in as a normal frame timed out a running machine.
test('a silent socket is reported as lost contact, never as a timeout', () => {
    const state = run(startedProcedureState(), { state: null }, CLEANING_PROCEDURE, (MAINTENANCE_START_TIMEOUT_MS / TICK) * 3);
    assert.equal(state.phase, 'waiting');
    assert.equal(state.stale, true);
    assert.equal(caption(state, CLEANING_PROCEDURE), 'Lost contact with the machine. Reconnecting...');
});

test('time spent blind does not burn the machine window to enter the state', () => {
    let state = run(startedProcedureState(), { state: null }, DESCALING_PROCEDURE, 60);
    state = run(state, { state: 'descaling', substate: 'cleaningStart' }, DESCALING_PROCEDURE);
    assert.equal(state.phase, 'running');
    assert.equal(state.stale, false);
});

test('losing the socket mid-cycle does not report a finish that never happened', () => {
    let state = run(startedProcedureState(), { state: 'cleaning', substate: 'cleanSoaking' }, CLEANING_PROCEDURE);
    state = run(state, { state: null }, CLEANING_PROCEDURE, 5);
    assert.equal(state.phase, 'running');
    assert.equal(state.stale, true);
    assert.equal(state.milestone, 2, 'the strip holds its place while blind');

    // ...and the real finish still lands once frames come back.
    state = run(state, { state: 'idle' }, CLEANING_PROCEDURE);
    assert.equal(state.phase, 'done');
});

test('a cycle started on the machine itself is picked up from idle', () => {
    const state = run(initialProcedureState(), { state: 'descaling', substate: 'cleaningGroup' }, DESCALING_PROCEDURE);
    assert.equal(state.phase, 'running');
    assert.equal(state.entered, true);
    assert.equal(caption(state, DESCALING_PROCEDURE), 'Descaling');
});

test('joining a clean on the ambiguous cleaningGroup frame shows the fill, not the flush', () => {
    const state = run(initialProcedureState(), { state: 'cleaning', substate: 'cleaningGroup' }, CLEANING_PROCEDURE);
    assert.equal(caption(state, CLEANING_PROCEDURE), 'Filling');
});

test('idle ignores a silent socket — nothing is being tracked yet', () => {
    const state = run(initialProcedureState(), { state: null }, CLEANING_PROCEDURE, 10);
    assert.equal(state.phase, 'idle');
    assert.equal(state.stale, false);
    assert.equal(procedureIndicatorView(state, CLEANING_PROCEDURE), null);
});

test('an unmapped substate holds the last milestone rather than resetting', () => {
    let state = run(startedProcedureState(), { state: 'cleaning', substate: 'cleanSoaking' }, CLEANING_PROCEDURE);
    // rest_v1.yml spells this one `cleaingGroup`; that typo is not on the wire.
    state = run(state, { state: 'cleaning', substate: 'cleaingGroup' }, CLEANING_PROCEDURE);
    assert.equal(state.milestone, 2);
});

test('an unchanged running frame returns the same object so the UI can skip a repaint', () => {
    const frame = { state: 'cleaning', substate: 'cleanSoaking' };
    const running = run(startedProcedureState(), frame, CLEANING_PROCEDURE);
    assert.equal(advanceProcedureState(running, frame, CLEANING_PROCEDURE), running);
});

test('isProcedureActive gates the Stop label to the phases that still change', () => {
    assert.equal(isProcedureActive(startedProcedureState()), true);
    assert.equal(isProcedureActive(initialProcedureState()), false);
    assert.equal(isProcedureActive({ phase: 'running' }), true);
    assert.equal(isProcedureActive({ phase: 'done' }), false);
    assert.equal(isProcedureActive({ phase: 'timeout' }), false);
});

// A sleeping DE1 drops the cleaning request, so the page wakes it first. Only a
// confirmed sleep earns a wake: guessing on an unknown state would just delay
// the real request.
test('a wake is sent only for a confirmed sleeping machine', () => {
    assert.equal(shouldWakeBeforeStart('sleeping'), true);
    assert.equal(shouldWakeBeforeStart('idle'), false);
    assert.equal(shouldWakeBeforeStart('heating'), false);
    assert.equal(shouldWakeBeforeStart('cleaning'), false);
    assert.equal(shouldWakeBeforeStart(null), false, 'no snapshot yet is not a known sleep');
    assert.equal(shouldWakeBeforeStart(undefined), false);
});

test('the wake is only complete once the machine reports a state that is not sleep', () => {
    assert.equal(isAwake('idle'), true);
    assert.equal(isAwake('heating'), true);
    assert.equal(isAwake('sleeping'), false);
    // Null is a silent socket, not proof of waking — keep waiting instead.
    assert.equal(isAwake(null), false);
    assert.equal(isAwake(undefined), false);
});

test('the wake wait is bounded, so a machine that never reports awake still starts', () => {
    assert.ok(WAKE_TIMEOUT_MS > 0);
    assert.ok(WAKE_TIMEOUT_MS < MAINTENANCE_START_TIMEOUT_MS + 10000);
});

// Every user-visible string should be a key the translation sheet already
// carries, so the two cycles read the same way in every language. Anything that
// is not must be declared here — which is what stops a new untranslated string
// slipping in unnoticed.
//
// Only the two failure sentences are new; every label and every other caption
// reuses a row the sheet already has.
const INTENTIONAL_NEW_KEYS = new Set([
    'Lost contact with the machine. Reconnecting...',
    'The machine did not start. Check that it is awake and connected.',
    'The steam boiler did not cool down. Try again once it is cold.',
]);

test('milestone labels and captions are translation-sheet keys, or declared new', () => {
    const csv = readFileSync(new URL('../src/ui/de1 gui translation - Sheet1.csv', import.meta.url), 'utf8');
    const keys = new Set(csv.split('\n').map(line => line.split(',')[0].trim().toLowerCase()));

    const strings = new Set([
        ...CLEANING_PROCEDURE.milestones,
        ...DESCALING_PROCEDURE.milestones,
        ...['waiting', 'running', 'done', 'timeout'].map(phase =>
            procedureIndicatorView({ phase, milestone: 0, stale: false }, CLEANING_PROCEDURE).caption),
    ]);

    for (const string of strings) {
        if (INTENTIONAL_NEW_KEYS.has(string)) continue;
        assert.ok(keys.has(string.toLowerCase()), `"${string}" is neither in the translation sheet nor declared as a new key`);
    }
});

// `Done` and `done` are in the sheet, but translated for a shot-history
// "since stop" label — "Terminé depuis", "Angehalten seit". The completion
// caption uses `Ready` instead; reaching back for `Done` because it reads
// better in English is the mistake this test exists to catch.
test('completion does not reuse the shot-history Done rows', () => {
    const captions = ['waiting', 'running', 'done', 'timeout'].map(phase =>
        procedureIndicatorView({ phase, milestone: 0, stale: false }, CLEANING_PROCEDURE).caption);

    assert.ok(!captions.includes('Done'), '`Done` is translated for another screen');
    assert.ok(!captions.includes('done'), '`done` is translated for another screen');
    assert.ok(captions.includes('Ready'), 'completion should read Ready');
});

// A descale must not start against a hot steam boiler. The unknown case is the
// one worth pinning: machines that report no steam temperature would otherwise
// never be able to descale.
test('the steam cooldown gate blocks only a reading that is actually hot', () => {
    assert.equal(steamCoolEnoughToDescale(90), false);
    assert.equal(steamCoolEnoughToDescale(60.5), false);
    assert.equal(steamCoolEnoughToDescale(60), true);
    assert.equal(steamCoolEnoughToDescale(21), true);
    assert.equal(steamCoolEnoughToDescale(null), true);
    assert.equal(steamCoolEnoughToDescale(undefined), true);
    assert.equal(steamCoolEnoughToDescale(NaN), true);
});
