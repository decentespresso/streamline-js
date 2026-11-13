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

const paintSource = extract(/function paintNavLock\(\)[\s\S]*?\n\}/, 'paintNavLock');
const updateSource = extract(/export function updateHistoryNavLock\([\s\S]*?\n\}/, 'updateHistoryNavLock');

function harness({ reviewing = false } = {}) {
    const buttons = {
        'history-prev-btn': { disabled: false, style: {} },
        'history-next-btn': { disabled: false, style: {} },
    };
    const shown = [];
    const document = { getElementById: (id) => buttons[id] ?? null };
    const factory = new Function(
        'document', 'historyNavBlocked', 'isReviewingHistory', 'displayShot', 'logger',
        `let navLocked = false;
         ${paintSource}
         ${updateSource}
         return { updateHistoryNavLock, locked: () => navLocked };`
    );
    const api = factory(
        document,
        historyNavBlocked,
        () => reviewing,
        async (index) => { shown.push(index); },
        { warn() {} },
    );
    return { ...api, buttons, shown };
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

test('locking while a past shot is on screen returns to the newest shot', () => {
    const reviewing = harness({ reviewing: true });
    reviewing.updateHistoryNavLock('espresso');
    assert.deepEqual(reviewing.shown, [0], 'should step back to the newest shot');

    // Already on the newest shot: nothing to repaint.
    const newest = harness({ reviewing: false });
    newest.updateHistoryNavLock('espresso');
    assert.deepEqual(newest.shown, []);
});

test('repeated frames of the same state do no work', () => {
    const h = harness({ reviewing: true });
    h.updateHistoryNavLock('espresso');
    h.updateHistoryNavLock('espresso');
    h.updateHistoryNavLock('espresso');
    // ~10 snapshot frames a second arrive during a shot; only the edge acts.
    assert.deepEqual(h.shown, [0]);
});

test('a socket that falls silent mid-shot releases the lock, and a resumed shot re-takes it', () => {
    // markMachineDisconnected() passes null while frames are absent, because
    // handleData() has stopped running and the state is frozen at `espresso`.
    const h = harness({ reviewing: false });
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

test('unlocking never drags the user off the shot they are reading', () => {
    const h = harness({ reviewing: true });
    h.updateHistoryNavLock('espresso');
    h.shown.length = 0;
    h.updateHistoryNavLock('idle');
    assert.deepEqual(h.shown, []);
});
