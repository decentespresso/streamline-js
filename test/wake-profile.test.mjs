// Run: node --test test/wake-profile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepProfileMark, shouldApplyWakeProfile, createSleepMarkStore, wakeProfileChoices, workflowHoldsProfile, sleepTransition, SLEEP_PROFILE_KEY } from '../src/modules/wake-profile.js';

const a = { title: 'Londinium', target_weight: 36, steps: [{ name: 'fill', temperature: 90 }] };
const b = { title: 'Blooming', target_weight: 40, steps: [{ name: 'bloom', temperature: 92 }] };

test('wake profile loads when the profile is unchanged since sleep, even if brew temperature moved', () => {
    const mark = sleepProfileMark({ profile: a });
    assert.equal(shouldApplyWakeProfile(mark, { profile: a }), true);
    assert.equal(shouldApplyWakeProfile(mark, { profile: { ...a, steps: [{ ...a.steps[0], temperature: 94 }] } }), true);
});

test('a profile chosen while asleep is not replaced', () => {
    assert.equal(shouldApplyWakeProfile(sleepProfileMark({ profile: a }), { profile: b }), false);
});

test('no mark or no readable workflow keeps the old behaviour (load it)', () => {
    assert.equal(shouldApplyWakeProfile(null, { profile: b }), true);
    assert.equal(shouldApplyWakeProfile(sleepProfileMark({ profile: a }), {}), true);
    assert.equal(sleepProfileMark(null), null);
});

test('a yield changed while asleep is not a different profile', () => {
    const mark = sleepProfileMark({ profile: a });
    assert.equal(shouldApplyWakeProfile(mark, { profile: { ...a, target_weight: 42 } }), true);
});

test('a sleep mark taken with a 0 limiter matches the live profile reporting null', () => {
    const zero = { ...a, steps: [{ ...a.steps[0], limiter: { value: 0, range: 0.6 } }] };
    const none = { ...a, steps: [{ ...a.steps[0], limiter: null }] };
    assert.equal(shouldApplyWakeProfile(sleepProfileMark({ profile: zero }), { profile: none }), true);
});

// ── Sleep-mark bookkeeping ──────────────────────────────────────────────────

function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: k => map.delete(k),
        get size() { return map.size; },
    };
}

test('a sleep that cannot read the workflow clears the previous sleep mark', () => {
    const storage = fakeStorage({ [SLEEP_PROFILE_KEY]: sleepProfileMark({ profile: a }) });
    const store = createSleepMarkStore(() => storage);
    store.beginSleep()(null); // workflow read failed
    assert.equal(store.peek(), null);
    // Without the clear, this stale mark would skip the wake profile for good.
    assert.equal(shouldApplyWakeProfile(store.takeOnWake(), { profile: b }), true);
});

test('a sleep mark that resolves after the machine already woke is dropped', () => {
    const storage = fakeStorage();
    const store = createSleepMarkStore(() => storage);
    const commit = store.beginSleep();        // machine sleeps, workflow read in flight
    assert.equal(store.takeOnWake(), null);   // it wakes before the read resolves
    assert.equal(commit(sleepProfileMark({ profile: a })), false);
    assert.equal(store.peek(), null);
});

test('the mark is consumed on every wake, so it cannot answer for a later sleep', () => {
    const storage = fakeStorage();
    const store = createSleepMarkStore(() => storage);
    store.beginSleep()(sleepProfileMark({ profile: a }));
    assert.equal(store.takeOnWake(), sleepProfileMark({ profile: a }));
    assert.equal(store.takeOnWake(), null);
    assert.equal(storage.size, 0);
});

test('an unusable sessionStorage never throws out of the store', () => {
    const store = createSleepMarkStore(() => { throw new Error('private mode'); });
    assert.equal(store.beginSleep()('mark'), true);
    assert.equal(store.takeOnWake(), null);
    const absent = createSleepMarkStore(() => undefined);
    assert.equal(absent.beginSleep()('mark'), true);
    assert.equal(absent.takeOnWake(), null);
});

// ── Which profiles the picker may offer ─────────────────────────────────────

const records = {
    v2: { id: 'v2', profile: { title: 'Londinium' } },                        // the edited copy
    v1: { id: 'v1', visibility: 'hidden', profile: { title: 'Londinium' } },  // retired by that edit
    bl: { id: 'bl', profile: { title: 'Blooming' } },
};

test('retired (hidden) records are not offered as the wake profile', () => {
    assert.deepEqual(wakeProfileChoices(records, 'v2').map(r => r.id), ['bl', 'v2']);
});

test('the chosen record stays listed even once it is hidden', () => {
    assert.deepEqual(wakeProfileChoices(records, 'v1').map(r => r.id), ['bl', 'v2', 'v1']);
});

test('choices sort by the title actually shown, not by record order', () => {
    const translated = wakeProfileChoices(records, '', r => (r.id === 'v2' ? 'Alpha' : r.profile.title));
    assert.deepEqual(translated.map(r => r.id), ['v2', 'bl']);
});

test('a missing or empty record set yields no choices', () => {
    assert.deepEqual(wakeProfileChoices(null, 'v1'), []);
    assert.deepEqual(wakeProfileChoices({}, 'v1'), []);
});

test('workflowHoldsProfile ignores yield and per-step temperature, rejects another profile', () => {
    assert.equal(workflowHoldsProfile({ profile: { ...a, target_weight: 50 } }, a), true);
    assert.equal(workflowHoldsProfile({ profile: b }, a), false);
    assert.equal(workflowHoldsProfile(null, a), false);
});

test('sleepTransition sees a wake through a disconnect during sleep', () => {
    assert.equal(sleepTransition('idle', 'sleeping'), 'sleep');
    assert.equal(sleepTransition('sleeping', 'sleeping'), null);
    assert.equal(sleepTransition('sleeping', 'error'), null);
    assert.equal(sleepTransition('sleeping', 'booting'), 'wake');
    assert.equal(sleepTransition('idle', 'error'), null);
    assert.equal(sleepTransition(null, 'sleeping'), 'sleep');
    assert.equal(sleepTransition(null, 'idle'), null);
});
