// Per-profile tile edits (dose / yield / grind / brew temp / steam duration /
// steam flow) live in Decaid's KV store, not on the profile record's metadata:
// Decaid replaces that map when it re-seeds a bundled profile, which silently
// wiped the user's numbers.
// Run: node --test test/profile-overrides.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    OVERRIDES_NAMESPACE,
    setKvClient,
    loadProfileOverrides,
    saveProfileOverride,
    clearProfileOverride,
    getProfileOverride,
    applyOverridesToRecords,
} from '../src/modules/profile-overrides.js';

function fakeKv(initial = {}) {
    const store = { ...initial };
    const calls = [];
    setKvClient({
        getKVAll: async (ns) => { calls.push(['getAll', ns]); return { ...store }; },
        setKVValue: async (ns, key, value) => { calls.push(['set', ns, key, value]); store[encodeURIComponent(key)] = value; },
        deleteKVValue: async (ns, key) => { calls.push(['delete', ns, key]); delete store[encodeURIComponent(key)]; },
    });
    return { store, calls };
}

test('a saved edit is written to KV under the profile id', async () => {
    const kv = fakeKv();
    await loadProfileOverrides();
    await saveProfileOverride('profile:abc', { targetDoseWeight: 18 });
    assert.deepEqual(kv.calls.at(-1), ['set', OVERRIDES_NAMESPACE, 'profile:abc', { targetDoseWeight: 18 }]);
});

test('later edits merge rather than replace', async () => {
    fakeKv();
    await loadProfileOverrides();
    await saveProfileOverride('profile:abc', { targetDoseWeight: 18 });
    await saveProfileOverride('profile:abc', { targetYield: 36 });
    const merged = await saveProfileOverride('profile:abc', { grinderSetting: '1.40' });
    assert.deepEqual(merged, { targetDoseWeight: 18, targetYield: 36, grinderSetting: '1.40' });
});

test('only known tile values are stored — never Decaid\'s own metadata', async () => {
    fakeKv();
    await loadProfileOverrides();
    const saved = await saveProfileOverride('profile:abc', {
        targetDoseWeight: 18, brewTemperature: 92, targetSteamDuration: 20, targetSteamFlow: 1.2,
        source: 'bundled', filename: 'x.json', targetYield: undefined,
    });
    assert.deepEqual(saved, { targetDoseWeight: 18, brewTemperature: 92, targetSteamDuration: 20, targetSteamFlow: 1.2 });
});

test('keys come back percent-encoded from Decaid and are decoded on load', async () => {
    fakeKv({ 'profile%3Aabc': { targetYield: 36 }, 'profile%3Adef': { grinderSetting: '2.0' } });
    await loadProfileOverrides();
    assert.deepEqual(getProfileOverride('profile:abc'), { targetYield: 36 });
    assert.deepEqual(getProfileOverride('profile:def'), { grinderSetting: '2.0' });
});

test('junk values in the namespace are ignored, not crashed on', async () => {
    fakeKv({ 'profile%3Aabc': null, 'profile%3Adef': 'nope', 'profile%3Aghi': { targetYield: 36 } });
    await loadProfileOverrides();
    assert.equal(getProfileOverride('profile:abc'), null);
    assert.equal(getProfileOverride('profile:def'), null);
    assert.deepEqual(getProfileOverride('profile:ghi'), { targetYield: 36 });
});

test('a KV failure leaves the app running with no overrides', async () => {
    setKvClient({ getKVAll: async () => { throw new Error('no decaid'); } });
    assert.deepEqual(await loadProfileOverrides(), {});
});

test('overrides win over the numbers Decaid left on the record', async () => {
    fakeKv({ 'profile%3Aabc': { targetDoseWeight: 20, grinderSetting: '3.50' } });
    await loadProfileOverrides();
    const records = {
        'profile:abc': { metadata: { source: 'bundled', filename: 'x.json', targetDoseWeight: 18 } },
        'profile:zzz': { metadata: { source: 'bundled' } },
    };
    applyOverridesToRecords(records);
    assert.deepEqual(records['profile:abc'].metadata, {
        source: 'bundled', filename: 'x.json', targetDoseWeight: 20, grinderSetting: '3.50',
    });
    assert.deepEqual(records['profile:zzz'].metadata, { source: 'bundled' }, 'untouched profiles keep their metadata');
});

test('a record with no metadata at all still gets its overrides', async () => {
    fakeKv({ 'profile%3Aabc': { targetYield: 36 } });
    await loadProfileOverrides();
    const records = { 'profile:abc': {} };
    applyOverridesToRecords(records);
    assert.deepEqual(records['profile:abc'].metadata, { targetYield: 36 });
});

test('reset removes the override from KV and memory', async () => {
    const kv = fakeKv({ 'profile%3Aabc': { targetYield: 36 } });
    await loadProfileOverrides();
    await clearProfileOverride('profile:abc');
    assert.equal(getProfileOverride('profile:abc'), null);
    assert.deepEqual(kv.store, {});
});
