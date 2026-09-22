// Per-profile tile edits (dose / yield / grind / brew temp / steam duration /
// steam flow) live in Decaid's KV store, not on the profile record's metadata:
// Decaid replaces that map when it re-seeds a bundled profile, which silently
// wiped the user's numbers.
// Run: node --test test/profile-overrides.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    OVERRIDES_NAMESPACE,
    setKvClient,
    loadProfileOverrides,
    saveProfileOverride,
    clearProfileOverride,
    removeProfileOverrideKeys,
    ensureProfileOverridesLoaded,
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

// Regression: a write replaces the whole KV entry for that profile, so a page
// that edits a profile without the main page's boot behind it (the profile
// editor's flow calibration, for one) would have merged onto an empty map and
// erased every number the profile already had.
test('a write before the namespace is loaded keeps the values already in KV', async () => {
    const kv = fakeKv({ 'profile%3Aabc': { targetSteamDuration: 10, targetSteamFlow: 0.8 } });
    // deliberately NO loadProfileOverrides() first
    const merged = await saveProfileOverride('profile:abc', { weightFlowMultiplier: 1.4 });
    assert.deepEqual(merged, { targetSteamDuration: 10, targetSteamFlow: 0.8, weightFlowMultiplier: 1.4 });
    assert.deepEqual(kv.store['profile%3Aabc'], merged);
});

test('the namespace is pulled in once, not on every write', async () => {
    const kv = fakeKv();
    await ensureProfileOverridesLoaded();
    await ensureProfileOverridesLoaded();
    await saveProfileOverride('profile:abc', { targetYield: 36 });
    assert.equal(kv.calls.filter(c => c[0] === 'getAll').length, 1);
});

test('per-profile flow calibration is stored alongside the tile values', async () => {
    const kv = fakeKv();
    await loadProfileOverrides();
    const saved = await saveProfileOverride('profile:abc', {
        targetDoseWeight: 18, weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5,
    });
    assert.deepEqual(saved, { targetDoseWeight: 18, weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5 });
    assert.deepEqual(kv.store['profile%3Aabc'], saved);
});

// Turning the editor's flow-calibration switch back off has to *remove* the
// keys: saveProfileOverride merges, so writing them as undefined would leave
// the old numbers in place and the profile would keep overriding the global.
test('clearing one group of keys leaves the rest of the override alone', async () => {
    const kv = fakeKv();
    await loadProfileOverrides();
    await saveProfileOverride('profile:abc', {
        targetDoseWeight: 18, weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5,
    });
    const left = await removeProfileOverrideKeys('profile:abc', ['weightFlowMultiplier', 'volumeFlowMultiplier']);
    assert.deepEqual(left, { targetDoseWeight: 18 });
    assert.deepEqual(kv.store['profile%3Aabc'], { targetDoseWeight: 18 });
});

test('removing the last key deletes the KV entry instead of storing an empty object', async () => {
    const kv = fakeKv();
    await loadProfileOverrides();
    await saveProfileOverride('profile:abc', { weightFlowMultiplier: 1.4 });
    await removeProfileOverrideKeys('profile:abc', ['weightFlowMultiplier', 'volumeFlowMultiplier']);
    assert.equal(getProfileOverride('profile:abc'), null);
    assert.deepEqual(kv.store, {});
});

test('removing keys from a profile that has no override is a no-op', async () => {
    const kv = fakeKv();
    await loadProfileOverrides();
    assert.equal(await removeProfileOverrideKeys('profile:zzz', ['weightFlowMultiplier']), null);
    assert.deepEqual(kv.calls.filter(c => c[0] !== 'getAll'), []);
});

test('reset removes the override from KV and memory', async () => {
    const kv = fakeKv({ 'profile%3Aabc': { targetYield: 36 } });
    await loadProfileOverrides();
    await clearProfileOverride('profile:abc');
    assert.equal(getProfileOverride('profile:abc'), null);
    assert.deepEqual(kv.store, {});
});

// Regression: app.js's initMobileValueInputs (the full-screen numpad entry
// point, gated behind shouldUseNumpad() for mobile/tablet) wires steam
// duration/flow straight to their api.js setters without ever calling
// saveContextToActiveProfile — unlike every other field in the same function
// (dose/drink/temp/grind all go through a ui.js helper that already saves).
// A value typed via the full-screen numpad landed on the machine but never
// stuck across a profile switch, while the tile's own +/- and presets (which
// share ui.js's scheduleSteamApi/preset-click paths) worked fine — the two
// entry points silently disagreed. app.js touches window/document at import
// time, so this inspects the real source rather than importing it (same
// technique as test/profile-save-routing.test.mjs and test/profile-drafts.test.mjs).
test('the full-screen numpad path for steam duration/flow saves the per-profile override', () => {
    const appSource = readFileSync(new URL('../src/modules/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const fnSrc = appSource.slice(
        appSource.indexOf('function initMobileValueInputs('),
        appSource.indexOf('\n// Display-label overrides'));
    assert.ok(fnSrc.length > 0, 'initMobileValueInputs must exist in app.js');

    const durationBranch = fnSrc.slice(
        fnSrc.indexOf("else if (type === 'steam-duration')"),
        fnSrc.indexOf("else if (type === 'steam-flow')"));
    const flowBranch = fnSrc.slice(
        fnSrc.indexOf("else if (type === 'steam-flow')"),
        fnSrc.indexOf("else if (type === 'flush')"));

    assert.match(durationBranch, /saveContextToActiveProfile\?\.\(\{\s*targetSteamDuration:/,
        'the numpad steam-duration branch must save its value as a per-profile override');
    assert.match(flowBranch, /saveContextToActiveProfile\?\.\(\{\s*targetSteamFlow:/,
        'the numpad steam-flow branch must save its value as a per-profile override');
});
