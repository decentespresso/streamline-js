// Per-profile flow calibration: Decaid's multipliers are app-wide, so a
// profile's own numbers are pushed into POST /settings when it becomes active
// and the user's baseline is put back when a profile without them is picked.
// Run: node --test test/flow-calibration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FLOW_CAL_DEFAULTS,
    FLOW_CAL_NAMESPACE,
    FLOW_CAL_STATE_KEY,
    pickFlowCalibration,
    resolveFlowCalibration,
    applyFlowCalibrationForProfile,
    getFlowCalibrationBaseline,
    setFlowCalibrationClient,
    resetFlowCalibrationState,
} from '../src/modules/flow-calibration.js';
import { setKvClient, loadProfileOverrides } from '../src/modules/profile-overrides.js';

const GLOBAL = { weightFlowMultiplier: 1, volumeFlowMultiplier: 0.3 };

// ─── The decision itself ────────────────────────────────────────────────────

test('a profile with no calibration leaves the machine alone', () => {
    const r = resolveFlowCalibration({ current: GLOBAL, state: null, override: null });
    assert.equal(r.write, false);
    assert.deepEqual(r.desired, GLOBAL);
    assert.deepEqual(r.baseline, GLOBAL, 'the live value becomes the baseline on the first run');
});

test("a profile's own numbers are pushed, and the live value is kept as the baseline", () => {
    const r = resolveFlowCalibration({
        current: GLOBAL, state: null,
        override: { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5 },
    });
    assert.equal(r.write, true);
    assert.deepEqual(r.desired, { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5 });
    assert.deepEqual(r.state.baseline, GLOBAL);
    assert.deepEqual(r.state.applied, r.desired);
});

test('switching to a profile without a calibration restores the baseline', () => {
    const applied = { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5 };
    const r = resolveFlowCalibration({
        current: applied,
        state: { baseline: GLOBAL, applied },
        override: null,
    });
    assert.equal(r.write, true);
    assert.deepEqual(r.desired, GLOBAL, 'back to the number that held before any profile override');
    assert.deepEqual(r.state.applied, GLOBAL);
});

test('one overridden key still restores the other from the baseline', () => {
    const applied = { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5 };
    const r = resolveFlowCalibration({
        current: applied,
        state: { baseline: { weightFlowMultiplier: 1.1, volumeFlowMultiplier: 0.25 }, applied },
        override: { weightFlowMultiplier: 0.9 },
    });
    assert.deepEqual(r.desired, { weightFlowMultiplier: 0.9, volumeFlowMultiplier: 0.25 });
});

test('switching between two calibrated profiles keeps the original baseline', () => {
    const first = { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5 };
    const r = resolveFlowCalibration({
        current: first,
        state: { baseline: GLOBAL, applied: first },
        override: { weightFlowMultiplier: 0.8, volumeFlowMultiplier: 0.2 },
    });
    assert.deepEqual(r.desired, { weightFlowMultiplier: 0.8, volumeFlowMultiplier: 0.2 });
    assert.deepEqual(r.state.baseline, GLOBAL, 'the baseline is the user value, not the last profile value');
});

test('an edit on the global Flow calibration page becomes the new baseline', () => {
    const applied = { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5 };
    // The user moved the global page while a profile override was applied:
    // the live value is no longer what we wrote, so it is theirs, not ours.
    const edited = { weightFlowMultiplier: 1.2, volumeFlowMultiplier: 0.5 };
    const r = resolveFlowCalibration({
        current: edited,
        state: { baseline: GLOBAL, applied },
        override: null,
    });
    assert.deepEqual(r.baseline, edited);
    assert.equal(r.write, false, 'nothing to push — the user value is already live');
});

test('re-applying the same profile is a no-op, not a repeated write', () => {
    const applied = { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5 };
    const r = resolveFlowCalibration({
        current: applied,
        state: { baseline: GLOBAL, applied },
        override: applied,
    });
    assert.equal(r.write, false);
});

test('float noise from the settings round-trip is not read as a user edit', () => {
    const applied = { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.30000000000000004 };
    const r = resolveFlowCalibration({
        current: applied,
        state: { baseline: GLOBAL, applied: { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.3 } },
        override: null,
    });
    assert.deepEqual(r.baseline, GLOBAL, 'baseline survives; 0.3 and 0.30000000000000004 are the same number');
});

test('settings without the keys fall back to Decaid defaults, and junk is ignored', () => {
    assert.deepEqual(resolveFlowCalibration({ current: {}, state: null, override: null }).baseline,
        { ...FLOW_CAL_DEFAULTS });
    assert.deepEqual(pickFlowCalibration({ weightFlowMultiplier: 'x', volumeFlowMultiplier: 0.4, gatewayMode: 'full' }),
        { volumeFlowMultiplier: 0.4 });
});

// ─── Wiring: what actually reaches Decaid ───────────────────────────────────

function stubApi({ settings = { ...GLOBAL }, store = {} } = {}) {
    const posted = [];
    const written = [];
    setFlowCalibrationClient({
        getReaSettings: async () => ({ ...settings }),
        setReaSettings: async (next) => { posted.push(next); Object.assign(settings, next); },
        getValueFromStore: async (ns, key) => store[`${ns}/${key}`] ?? null,
        setValueInStore: async (ns, key, value) => { written.push([ns, key, value]); store[`${ns}/${key}`] = value; },
    });
    resetFlowCalibrationState();
    return { settings, posted, written, store };
}

async function seedOverrides(entries) {
    setKvClient({ getKVAll: async () => entries });
    await loadProfileOverrides();
}

test('picking a calibrated profile posts its numbers and stores the baseline', async () => {
    const api = stubApi();
    await seedOverrides({ 'profile%3Aa': { targetDoseWeight: 18, weightFlowMultiplier: 1.4 } });

    await applyFlowCalibrationForProfile('profile:a');

    assert.deepEqual(api.posted, [{ weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.3 }]);
    assert.deepEqual(api.store[`${FLOW_CAL_NAMESPACE}/${FLOW_CAL_STATE_KEY}`], {
        baseline: GLOBAL,
        applied: { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.3 },
    });
});

test('the next profile without a calibration gets the baseline back', async () => {
    const api = stubApi();
    await seedOverrides({ 'profile%3Aa': { weightFlowMultiplier: 1.4 }, 'profile%3Ab': { targetYield: 36 } });

    await applyFlowCalibrationForProfile('profile:a');
    await applyFlowCalibrationForProfile('profile:b');

    assert.deepEqual(api.posted.at(-1), GLOBAL);
    assert.deepEqual(api.settings, GLOBAL);
});

test('a profile switch survives Decaid being unreachable', async () => {
    setFlowCalibrationClient({
        getReaSettings: async () => { throw new Error('no decaid'); },
        setReaSettings: async () => { throw new Error('no decaid'); },
        getValueFromStore: async () => { throw new Error('no decaid'); },
        setValueInStore: async () => { throw new Error('no decaid'); },
    });
    resetFlowCalibrationState();
    await seedOverrides({});
    assert.equal(await applyFlowCalibrationForProfile('profile:a'), null);
});

// Regression: both calls used to read /settings before either POST landed, so
// the second decided against a stale reading and left the machine on the first
// profile's multiplier.
test('a fast switch away is not overtaken by the profile it replaced', async () => {
    const api = stubApi();
    await seedOverrides({ 'profile%3Aa': { weightFlowMultiplier: 1.4 }, 'profile%3Ab': { targetYield: 36 } });

    const first = applyFlowCalibrationForProfile('profile:a');
    const second = applyFlowCalibrationForProfile('profile:b');
    assert.equal(await first, null, 'the superseded switch does nothing at all');
    await second;

    assert.deepEqual(api.posted, [], 'nothing to write: b wants the baseline, which is already live');
    assert.deepEqual(api.settings, GLOBAL);
});

test('each switch still applies when they do not overlap', async () => {
    const api = stubApi();
    await seedOverrides({ 'profile%3Aa': { weightFlowMultiplier: 1.4 }, 'profile%3Ab': { targetYield: 36 } });
    await applyFlowCalibrationForProfile('profile:a');
    await applyFlowCalibrationForProfile('profile:b');
    assert.deepEqual(api.posted, [{ weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.3 }, GLOBAL]);
});

test('the editor reads the baseline, not whatever profile is currently applied', async () => {
    const applied = { weightFlowMultiplier: 1.4, volumeFlowMultiplier: 0.5 };
    const api = stubApi({
        settings: { ...applied },
        store: { [`${FLOW_CAL_NAMESPACE}/${FLOW_CAL_STATE_KEY}`]: { baseline: GLOBAL, applied } },
    });
    await seedOverrides({});
    assert.deepEqual(await getFlowCalibrationBaseline(), GLOBAL);
    assert.deepEqual(api.posted, [], 'reading the baseline never writes to the machine');
});
