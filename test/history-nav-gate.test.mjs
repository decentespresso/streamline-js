import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HISTORY_NAV_BLOCKING_STATES, historyNavBlocked } from '../src/modules/history-nav-gate.js';

test('only espresso locks the shot-history arrows', () => {
    assert.deepEqual(HISTORY_NAV_BLOCKING_STATES, ['espresso']);
    assert.equal(historyNavBlocked('espresso'), true);
    // These draw no live shot on the main chart, so reading a past shot is fine.
    for (const state of ['idle', 'ready', 'steam', 'steamRinse', 'flush', 'hotWater', 'heating', 'sleeping', 'cleaning']) {
        assert.equal(historyNavBlocked(state), false, state);
    }
    // Unknown state means the snapshot socket is down, not a machine mid-shot;
    // locking there would kill history navigation whenever the socket hiccups.
    for (const state of [null, undefined, '', 0, {}, 'ESPRESSO']) {
        assert.equal(historyNavBlocked(state), false, String(state));
    }
});

// --- The lock itself, lifted out of history.js (DOM-touching module) --------
// Same approach as profile-send-gate.test.mjs: extract the two functions and
// run them against a stub document, so the behaviour is covered without jsdom.
const historySource = readFileSync(new URL('../src/modules/history.js', import.meta.url), 'utf8');

function extract(pattern, label) {
    const match = historySource.match(pattern);
    assert.ok(match, `${label} not found in history.js`);
    return match[0].replace(/^export /, '');
}

const labelSource = extract(/export function setHistoryLabel\([\s\S]*?\n\}/, 'setHistoryLabel');
const paintSource = extract(/function paintNavLock\(\)[\s\S]*?\n\}/, 'paintNavLock');
const endReviewSource = extract(/export function endHistoryReview\([\s\S]*?\n\}/, 'endHistoryReview');
const updateSource = extract(/export function updateHistoryNavLock\([\s\S]*?\n\}/, 'updateHistoryNavLock');
const displayShotSource = extract(/async function displayShot\([\s\S]*?\n\}/, 'displayShot');

function harness({ index = 0 } = {}) {
    const buttons = {
        'history-prev-btn': { disabled: false, style: {} },
        'history-next-btn': { disabled: false, style: {} },
    };
    const label = { textContent: 'HISTORY', setAttribute(name, value) { this[name] = value; } };
    const suspended = [];
    const elements = { ...buttons, 'shot-history-label': label };
    const document = { getElementById: (id) => elements[id] ?? null };
    const factory = new Function(
        'document', 'historyNavBlocked', 'setPaintSuspended', 'getTranslation', 'startIndex',
        `let navLocked = false;
         let currentShotIndex = startIndex;
         let paintedShotId = 'drawn';
         function isReviewingHistory() { return currentShotIndex > 0; }
         ${labelSource}
         ${paintSource}
         ${endReviewSource}
         ${updateSource}
         return {
             updateHistoryNavLock,
             endHistoryReview,
             selectPastShot: (next) => { currentShotIndex = next; },
             locked: () => navLocked,
             index: () => currentShotIndex,
             painted: () => paintedShotId,
         };`
    );
    const api = factory(
        document,
        historyNavBlocked,
        (on) => { suspended.push(on); },
        (key) => key,
        index,
    );
    return { ...api, buttons, label, suspended };
}

test('entering espresso disables and dims both arrows; leaving it restores them', () => {
    const h = harness();
    h.updateHistoryNavLock('espresso');
    assert.equal(h.locked(), true);
    for (const id of ['history-prev-btn', 'history-next-btn']) {
        assert.equal(h.buttons[id].disabled, true, id);
        assert.equal(h.buttons[id].style.opacity, '0.25', id);
    }

    h.updateHistoryNavLock('idle');
    assert.equal(h.locked(), false);
    for (const id of ['history-prev-btn', 'history-next-btn']) {
        assert.equal(h.buttons[id].disabled, false, id);
        // Cleared, not forced: the arrows' own `invisible` class still rules
        // whether there is a shot to step to.
        assert.equal(h.buttons[id].style.opacity, '', id);
    }
});

test('locking while a past shot is on screen ends the review without plotting', () => {
    const reviewing = harness({ index: 4 });
    reviewing.updateHistoryNavLock('espresso');
    assert.equal(reviewing.index(), 0, 'the review must end, or app.js holds the live chart back');
    assert.deepEqual(reviewing.suspended, [false], 'the data panel paints the running shot again');
    assert.equal(reviewing.label.textContent, 'NEWEST');
    assert.equal(reviewing.label['data-i18n-key'], 'NEWEST', 'a later translatePage must keep the label');
    // No displayShot/plotHistoricalShot: this runs from handleData(), so the
    // past shot's curves would still be on the chart when the live frames of
    // the shot now starting append to them.
    assert.equal(reviewing.painted(), null, 'the drawn-shot guard must not hold a stale id');

    // Already on the newest shot: nothing to reset.
    const newest = harness({ index: 0 });
    newest.updateHistoryNavLock('espresso');
    assert.equal(newest.index(), 0);
    assert.deepEqual(newest.suspended, []);
    assert.equal(newest.label.textContent, 'HISTORY', 'app.js owns the label when no review was open');
});

test('repeated frames of the same state do no work', () => {
    const h = harness({ index: 4 });
    h.updateHistoryNavLock('espresso');
    h.suspended.length = 0;
    h.updateHistoryNavLock('espresso');
    h.updateHistoryNavLock('espresso');
    // ~10 snapshot frames a second arrive during a shot; only the edge acts.
    assert.deepEqual(h.suspended, []);
});

test('a socket that falls silent mid-shot releases the lock, and a resumed shot re-takes it', () => {
    // markMachineDisconnected() passes null while frames are absent, because
    // handleData() has stopped running and the state is frozen at `espresso`.
    const h = harness({ index: 0 });
    h.updateHistoryNavLock('espresso');
    assert.equal(h.locked(), true);
    h.updateHistoryNavLock(null);
    assert.equal(h.locked(), false, 'arrows must not stay dead while the socket is silent');
    assert.equal(h.buttons['history-prev-btn'].disabled, false);

    // Frames resume on the same `espresso` the socket froze at, so an
    // edge-only caller would never re-lock. The per-frame call does.
    h.updateHistoryNavLock('espresso');
    assert.equal(h.locked(), true);
    assert.equal(h.buttons['history-prev-btn'].disabled, true);
});

test('a review opened after the lock is still ended when the shot starts', () => {
    const h = harness();
    h.updateHistoryNavLock('espresso');
    h.selectPastShot(2);
    assert.equal(h.endHistoryReview(), true);
    assert.equal(h.index(), 0);
    assert.equal(h.label.textContent, 'NEWEST');
    assert.equal(h.endHistoryReview(), false, 'nothing left to end');
});

test('shot start always clears the chart, whatever the history panel was showing', () => {
    const appSource = readFileSync(new URL('../src/modules/app.js', import.meta.url), 'utf8');
    const shotStart = appSource.match(/shotGeneration\+\+;[\s\S]*?startPerfShot\(\);/);
    assert.ok(shotStart, 'shot-start block not found in app.js');
    assert.doesNotMatch(shotStart[0], /isReviewingHistory/);
    assert.match(shotStart[0], /endHistoryReview\(\)[\s\S]*chart\.clearChart\(\)/);
});

test('a locked panel refuses past shots but still shows the newest', async () => {
    const reached = new Error('passed the lock');
    const run = new Function(
        'navLocked', 'setPaintSuspended',
        `let currentShotIndex = 0;
         const shots = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
         const logger = { warn() {} };
         ${displayShotSource}
         return displayShot;`
    );
    const stop = () => { throw reached; };

    await run(true, stop)(2);
    await assert.rejects(run(true, stop)(0), reached);
    await assert.rejects(run(false, stop)(2), reached);
});

test('unlocking never drags the user off the shot they are reading', () => {
    const h = harness({ index: 4 });
    h.updateHistoryNavLock('espresso');
    h.suspended.length = 0;
    h.updateHistoryNavLock('idle');
    assert.deepEqual(h.suspended, [], 'releasing the lock touches no shot selection');
});
