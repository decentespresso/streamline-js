import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveStatusStateKey, isActionTailSubstate, offerRefillRetry } from '../src/modules/machine-status-policy.js';

// Recorded [status, substate] frames. app.js builds the status from the MachineState
// and never appends the filler `idle` substate, so the substate arrives separately.
const espresso = [
    ['Espresso', 'idle'], ['Espresso', 'preparingForShot'], ['Espresso', 'preinfusion'],
    ['Espresso', 'pouring'], ['Espresso', 'pouringDone'], ['Espresso', 'idle'],
];
const steam = [['Steam', 'idle'], ['Steam', 'pouring'], ['Steam', 'puffing'], ['Steam', 'idle']];

test('no frame of an action state resolves to idle', () => {
    for (const [status, substate] of [...espresso, ...steam]) {
        assert.notEqual(resolveStatusStateKey(status, substate), 'idle', `${status}/${substate}`);
    }
});

test('action substates still resolve from the substate', () => {
    assert.equal(resolveStatusStateKey('Espresso', 'preinfusion'), 'preinfusion');
    assert.equal(resolveStatusStateKey('Espresso', 'pouring'), 'pouring');
    assert.equal(resolveStatusStateKey('Steam', 'pouring'), 'pouring');
});

test('state-level keys never resolve from the substate', () => {
    for (const substate of ['idle', 'sleeping', 'disconnected', 'error', 'heating']) {
        assert.equal(resolveStatusStateKey('Espresso', substate), '', substate);
    }
});

test('state-level keys still resolve from the status', () => {
    assert.equal(resolveStatusStateKey('Idle', 'idle'), 'idle');
    assert.equal(resolveStatusStateKey('Sleeping', ''), 'sleeping');
    assert.equal(resolveStatusStateKey('Disconnected', undefined), 'disconnected');
    assert.equal(resolveStatusStateKey('Heating 12s', 'idle'), 'heating');
    assert.equal(resolveStatusStateKey('Error', 'idle'), 'error');
});

test('the tail predicate is true for pouringDone and puffing only', () => {
    assert.equal(isActionTailSubstate('pouringDone'), true);
    assert.equal(isActionTailSubstate('puffing'), true);
    for (const substate of ['pouring', 'idle', 'pausedSteam', 'preinfusion', undefined]) {
        assert.equal(isActionTailSubstate(substate), false, String(substate));
    }
});

// ── Retry for a refill kit that has stopped (issue #178) ────────────────────
//
// needsWater on a machine with a kit is not only "the tank is empty": the kit
// covers a normal fill, and the same state is where the machine waits after the
// kit has stopped. de1app's page sends start_refill_kit on any tap and gates
// only the hint on the DE1 substate; decaid collapses that substate into `idle`
// (decaid#1062), so the retry follows the state, gated on the kit.

test('the refill retry is offered through needsWater on a machine with a kit', () => {
    assert.equal(offerRefillRetry('needsWater', true), true);
});

test('no refill retry without a kit, or before machine info is read', () => {
    // Without a kit nothing is waiting to be told to try again; null is the
    // "not read yet" value isRefillKitPresent() returns before the first fetch.
    assert.equal(offerRefillRetry('needsWater', false), false);
    assert.equal(offerRefillRetry('needsWater', null), false);
    assert.equal(offerRefillRetry('needsWater', undefined), false);
});

test('no refill retry outside needsWater', () => {
    for (const state of ['idle', 'espresso', 'steam', 'sleeping', 'heating', '', undefined]) {
        assert.equal(offerRefillRetry(state, true), false, String(state));
    }
});

// The markup and the lookup are written apart in ui.js, and a mismatch between
// them would render a Retry that silently does nothing.
const uiSource = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');

test('the retry element id is written once and used by both halves', () => {
    const id = uiSource.match(/const REFILL_RETRY_ID = '([^']+)'/)?.[1];
    assert.equal(id, 'refill-retry-indicator');
    assert.match(uiSource, /id="\$\{REFILL_RETRY_ID\}"/, 'the markup uses the constant');
    assert.match(uiSource, /getElementById\(REFILL_RETRY_ID\)/, 'the handler looks up the constant');
    // The retry must send the state decaid turns into the firmware's Refill
    // request; any other state would do something else entirely.
    assert.match(uiSource, /setMachineState\(MachineState\.NEEDS_WATER\)/);
});
