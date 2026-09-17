import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Persistence of the user's main-page settings: the shared KV record that
// outranks a drifted workflow (milk stop, plus the resync rule every tile value
// shares), the after-boot drift check on incoming shotSettings frames, and the
// per-profile brew-temp override.
//
// api.js / app.js / profileManager.js can't be imported under node (browser
// globals), so the functions under test are lifted out of the source and run
// with their dependencies injected -- same trick as settings-write-cache.test.mjs.

function lift(module, patterns) {
    const source = readFileSync(new URL(`../src/modules/${module}`, import.meta.url), 'utf8');
    return patterns.map(pattern => {
        const match = source.match(pattern);
        assert.ok(match, `${module}: no match for ${pattern}`);
        return match[0].replace('export ', '');
    }).join('\n');
}

// ── Milk stop + the shared KV resync rule (api.js) ───────────────────────────
{
    const body = lift('api.js', [
        /export const MILK_STOP_LAST_VALUE_KEY = .*;/,
        /export async function readSharedValue\(key\) \{[\s\S]*?\r?\n\}/,
        /export async function resyncIfDrifted\(key, fetchedValue, pushFn\) \{[\s\S]*?\r?\n\}/,
        /export async function resyncMilkStopIfDrifted\(stopAtTemperature\) \{[\s\S]*?\r?\n\}/,
        /export async function setStopAtTemperature\(celsius\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = (remembered) => {
        const kvWrites = [];
        const workflowWrites = [];
        const api = new Function(
            'logger', 'persistSharedValue', 'updateWorkflow', 'getValueFromStore', 'openDB', 'getSetting',
            `${body}\nreturn { setStopAtTemperature, resyncMilkStopIfDrifted, resyncIfDrifted };`,
        )(
            { warn() {}, error() {} },
            async (key, value) => { kvWrites.push([key, value]); },
            async (patch) => { workflowWrites.push(patch); },
            async () => remembered,
            async () => {},
            async () => remembered,
        );
        return { api, kvWrites, workflowWrites };
    };

    test('an armed milk stop is remembered in KV before it reaches the machine', async () => {
        const { api, kvWrites, workflowWrites } = build(null);
        await api.setStopAtTemperature(60);
        assert.deepEqual(kvWrites, [['last-milk-stop', 60]]);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 60 } }]);
    });

    test('turning the stop off writes the machine but never the KV record', async () => {
        // 0 = off (user toggle, or a probe that vanished). Persisting it would erase
        // the temperature the user tuned.
        const { api, kvWrites, workflowWrites } = build(null);
        await api.setStopAtTemperature(0);
        assert.deepEqual(kvWrites, []);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 0 } }]);
    });

    test('a drifted armed stop is re-pushed from the KV record', async () => {
        const { api, kvWrites, workflowWrites } = build(60);
        await api.resyncMilkStopIfDrifted(55);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 60 } }]);
        assert.deepEqual(kvWrites, [['last-milk-stop', 60]]);
    });

    test('an agreeing armed stop is left alone', async () => {
        const { api, workflowWrites } = build(60);
        await api.resyncMilkStopIfDrifted(60);
        assert.deepEqual(workflowWrites, []);
    });

    test('a stop that is off is never re-armed by the remembered target', async () => {
        const { api, workflowWrites } = build(60);
        await api.resyncMilkStopIfDrifted(0);
        await api.resyncMilkStopIfDrifted(undefined);
        assert.deepEqual(workflowWrites, []);
    });

    test('a stored value above the API ceiling is clamped on the way out', async () => {
        // rest_v1.yml SteamSettings.stopAtTemperature documents range 0..80; the tile
        // used to allow 85, so an older KV record can still hold one.
        const { api, kvWrites, workflowWrites } = build(85);
        await api.resyncMilkStopIfDrifted(60);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 80 } }]);
        assert.deepEqual(kvWrites, [['last-milk-stop', 80]]);
    });

    test('a remembered value is pushed even when the workflow has no value at all', async () => {
        // The user's setting wins over an absent machine value -- a missing field is
        // the strongest reason to push what they asked for, not a reason to drop it.
        const pushed = [];
        const { api } = build(45);
        await api.resyncIfDrifted('last-anything', undefined, async (v) => { pushed.push(v); });
        await api.resyncIfDrifted('last-anything', null, async (v) => { pushed.push(v); });
        assert.deepEqual(pushed, [45, 45]);
    });

    test('the pushed value is returned so the caller can repaint its tile', async () => {
        // Pushing alone leaves the tile on the drifted workflow value. Steam flow,
        // the milk stop and the flush duration are in no websocket payload, so
        // nothing else would ever correct them.
        const { api } = build(45);
        assert.equal(await api.resyncIfDrifted('last-anything', 30, async () => {}), 45);
        assert.equal(await api.resyncMilkStopIfDrifted(55), 45);
    });

    test('an agreeing value returns nothing to repaint', async () => {
        const { api } = build(45);
        assert.equal(await api.resyncIfDrifted('last-anything', 45, async () => {}), null);
        assert.equal(await api.resyncMilkStopIfDrifted(45), null);
        // A disarmed stop never reaches the comparison at all.
        assert.equal(await api.resyncMilkStopIfDrifted(0), null);
    });

    test('with nothing remembered the machine value stands', async () => {
        const pushed = [];
        const { api } = build(null);
        await api.resyncIfDrifted('last-anything', 30, async (v) => { pushed.push(v); });
        await api.resyncIfDrifted('last-anything', undefined, async (v) => { pushed.push(v); });
        assert.deepEqual(pushed, []);
    });
}

// ── Steam duration 0 = steam off, heater included (api.js) ──────────────────
{
    const body = lift('api.js', [
        /export const STEAM_DURATION_LAST_VALUE_KEY = .*;/,
        /export const STEAM_TEMP_LAST_VALUE_KEY = .*;/,
        /export async function readSharedValue\(key\) \{[\s\S]*?\r?\n\}/,
        /export async function setTargetSteamTemp\(temp\) \{[\s\S]*?\r?\n\}/,
        /async function steamHeaterFor\(duration\) \{[\s\S]*?\r?\n\}/,
        /export async function setTargetSteamDuration\(duration\) \{[\s\S]*?\r?\n\}/,
    ]);

    // `remembered` is the KV record of the last enabled temperature; `machineTemp`
    // is what the workflow currently holds.
    const build = (remembered, machineTemp = 150) => {
        const kvWrites = [];
        const workflowWrites = [];
        const api = new Function(
            'logger', 'persistSharedValue', 'updateWorkflow', 'getWorkflow', 'getValueFromStore', 'openDB', 'getSetting',
            `${body}\nreturn { setTargetSteamDuration, setTargetSteamTemp };`,
        )(
            { warn() {}, error() {} },
            async (key, value) => { kvWrites.push([key, value]); },
            async (patch) => { workflowWrites.push(patch); },
            async () => ({ steamSettings: { targetTemperature: machineTemp } }),
            async () => remembered,
            async () => {},
            async () => remembered,
        );
        return { api, kvWrites, workflowWrites };
    };

    test('duration 0 switches the heater off too', async () => {
        // rest_v1.yml: SteamSettings.duration "does not control steam-heater
        // preheating" -- only targetTemperature 0 does. Sending duration alone
        // left the boiler heating for a user who asked for steam off.
        const { api, kvWrites, workflowWrites } = build(null, 150);
        await api.setTargetSteamDuration(0);
        assert.deepEqual(workflowWrites, [{ steamSettings: { duration: 0, targetTemperature: 0 } }]);
        // The temperature it was switched off from is remembered, not lost.
        assert.deepEqual(kvWrites, [['last-steam-duration', 0], ['last-steam-temp', 150]]);
    });

    test('re-arming steam restores the remembered temperature', async () => {
        const { api, workflowWrites } = build(150, 0);
        await api.setTargetSteamDuration(30);
        assert.deepEqual(workflowWrites, [{ steamSettings: { duration: 30, targetTemperature: 150 } }]);
    });

    test('with nothing remembered the machine keeps whatever temperature it has', async () => {
        const { api, workflowWrites } = build(null, 150);
        await api.setTargetSteamDuration(30);
        assert.deepEqual(workflowWrites, [{ steamSettings: { duration: 30 } }]);
    });

    test('an already-off machine has no temperature worth remembering', async () => {
        const { api, kvWrites } = build(null, 0);
        await api.setTargetSteamDuration(0);
        assert.deepEqual(kvWrites, [['last-steam-duration', 0]]);
    });

    test('only enabled steam temperatures are remembered', async () => {
        const on = build(null);
        await on.api.setTargetSteamTemp(155);
        assert.deepEqual(on.kvWrites, [['last-steam-temp', 155]]);
        assert.deepEqual(on.workflowWrites, [{ steamSettings: { targetTemperature: 155 } }]);

        const off = build(null);
        await off.api.setTargetSteamTemp(0);
        assert.deepEqual(off.kvWrites, []);
        assert.deepEqual(off.workflowWrites, [{ steamSettings: { targetTemperature: 0 } }]);
    });
}

// ── Hot water: the store records intent before the machine does (api.js) ─────
{
    const body = lift('api.js', [
        /export const HOT_WATER_VOLUME_LAST_VALUE_KEY = .*;/,
        /export const HOT_WATER_TEMP_LAST_VALUE_KEY = .*;/,
        /export async function setTargetHotWaterVolume\(volume\) \{[\s\S]*?\r?\n\}/,
        /export async function setTargetHotWaterTemp\(temp\) \{[\s\S]*?\r?\n\}/,
    ]);

    // One ordered log of both sides, so "which happened first" is the assertion.
    const build = ({ putFails = false } = {}) => {
        const order = [];
        const api = new Function(
            'logger', 'persistSharedValue', 'updateWorkflow',
            `${body}\nreturn { setTargetHotWaterVolume, setTargetHotWaterTemp };`,
        )(
            { warn() {}, error() {} },
            async (key, value) => { order.push(['kv', key, value]); },
            async (patch) => {
                order.push(['workflow', patch]);
                if (putFails) throw new Error('503 Workflow request queue timed out');
                return patch;
            },
        );
        return { api, order };
    };

    test('the hot-water target is remembered in KV before it reaches the machine', async () => {
        // Storing afterwards left the store holding the OLD value while the
        // workflow and the machine already held the new one. Hot water is echoed
        // back by a shotSettings frame, so resyncDriftedShotSettings ran inside
        // that window, read the user's own change as drift, and pushed the old
        // value back -- the tile flashed the new number and snapped back.
        const temp = build();
        await temp.api.setTargetHotWaterTemp(67);
        assert.deepEqual(temp.order, [
            ['kv', 'last-hot-water-temp', 67],
            ['workflow', { hotWaterData: { targetTemperature: 67 } }],
        ]);

        const vol = build();
        await vol.api.setTargetHotWaterVolume(120);
        assert.deepEqual(vol.order, [
            ['kv', 'last-hot-water-volume', 120],
            ['workflow', { hotWaterData: { volume: 120 } }],
        ]);
    });

    test('a push that never lands still leaves the intent recorded', async () => {
        // PUT /workflow can queue for 30s and come back 503. With nothing stored,
        // the next drift check would replay the stale value over what the user
        // asked for; with it stored, the same check restores their setting.
        for (const [call, key, value] of [
            ['setTargetHotWaterTemp', 'last-hot-water-temp', 67],
            ['setTargetHotWaterVolume', 'last-hot-water-volume', 120],
        ]) {
            const { api, order } = build({ putFails: true });
            await assert.rejects(api[call](value));
            assert.deepEqual(order[0], ['kv', key, value]);
        }
    });

    test('a string from a preset or the numpad is stored as a number', async () => {
        const { api, order } = build();
        await api.setTargetHotWaterTemp('67');
        await api.setTargetHotWaterVolume('120');
        assert.deepEqual(order.filter(([kind]) => kind === 'kv'), [
            ['kv', 'last-hot-water-temp', 67],
            ['kv', 'last-hot-water-volume', 120],
        ]);
    });
}

// ── After-boot drift check on shotSettings frames (app.js) ───────────────────
{
    const body = lift('app.js', [
        /const SHOT_SETTINGS_KV_FIELDS = \[[\s\S]*?\r?\n\];/,
        /const lastSeenShotSettings = \{\};/,
        /const RESYNC_COOLDOWN_MS = .*;/,
        /const lastResyncAt = \{\};/,
        /function resyncDriftedShotSettings\(data\) \{[\s\S]*?\r?\n\}/,
    ]);

    // `pushes` is what resyncIfDrifted decides to write back; null means it found
    // nothing to correct. Time is injected so the cooldown can be stepped over
    // without the test sleeping for it.
    const build = (pushes = 'corrected') => {
        const checked = [];
        const clock = { now: 1_000_000 };
        const api = {
            STEAM_DURATION_LAST_VALUE_KEY: 'last-steam-duration',
            HOT_WATER_VOLUME_LAST_VALUE_KEY: 'last-hot-water-volume',
            HOT_WATER_TEMP_LAST_VALUE_KEY: 'last-hot-water-temp',
            setTargetSteamDuration: () => {},
            setTargetHotWaterVolume: () => {},
            setTargetHotWaterTemp: () => {},
            resyncIfDrifted: async (key, value) => { checked.push([key, value]); return pushes; },
        };
        const fn = new Function('api', 'logger', 'Date',
            `${body}\nreturn resyncDriftedShotSettings;`)(api, { warn() {} }, { now: () => clock.now });
        return { fn, checked, clock };
    };

    // The cooldown is released on the microtask that resolves resyncIfDrifted.
    const settle = () => new Promise(resolve => setImmediate(resolve));

    test('only the three KV-backed ShotSettings fields are checked', () => {
        const { fn, checked } = build();
        fn({ targetSteamDuration: 30, targetHotWaterVolume: 120, targetHotWaterTemp: 85, groupTemp: 92, targetShotVolume: 36 });
        assert.deepEqual(checked, [
            ['last-steam-duration', 30],
            ['last-hot-water-volume', 120],
            ['last-hot-water-temp', 85],
        ]);
    });

    test('a repeated frame is not re-checked', () => {
        // A machine that refuses a pushed value keeps sending the same number; without
        // this the check would fire on every snapshot forever.
        const { fn, checked } = build();
        const frame = { targetSteamDuration: 30 };
        fn(frame);
        fn({ ...frame });
        fn({ ...frame });
        assert.deepEqual(checked, [['last-steam-duration', 30]]);
    });

    test('a machine alternating between two values is corrected once, not per frame', async () => {
        // decaid gh-678. The DE1 reported 54 C and 75 C alternately while our
        // correction was in flight; because each frame differed from the last,
        // the repeat-check above never fired and every frame became a workflow
        // PUT -- 190 of them in 27 s, which took the BLE link down mid-shot.
        const { fn, checked } = build();
        for (let i = 0; i < 20; i++) fn({ targetHotWaterTemp: i % 2 ? 75 : 54 });
        await settle();
        assert.deepEqual(checked, [['last-hot-water-temp', 54]]);
    });

    test('the field is correctable again once the cooldown has passed', async () => {
        const { fn, checked, clock } = build();
        fn({ targetHotWaterTemp: 54 });
        await settle();
        clock.now += 30_000;
        fn({ targetHotWaterTemp: 75 });
        await settle();
        assert.deepEqual(checked.map(([, v]) => v), [54, 75]);
    });

    test('a check that corrects nothing does not delay the next one', async () => {
        // Nothing remembered, or already in agreement: no write went out, so
        // there is no storm to throttle and a real drift must not have to wait.
        const { fn, checked } = build(null);
        fn({ targetSteamDuration: 30 });
        await settle();
        fn({ targetSteamDuration: 45 });
        await settle();
        assert.deepEqual(checked.map(([, v]) => v), [30, 45]);
    });

    test('each field gets its own cooldown', async () => {
        const { fn, checked } = build();
        fn({ targetSteamDuration: 30, targetHotWaterVolume: 120, targetHotWaterTemp: 85 });
        await settle();
        fn({ targetSteamDuration: 45, targetHotWaterVolume: 150, targetHotWaterTemp: 90 });
        await settle();
        assert.deepEqual(checked.map(([, v]) => v), [30, 120, 85]);
    });

    test('absent fields are skipped, zero is not', () => {
        const { fn, checked } = build();
        fn({ targetHotWaterVolume: 0 });
        fn({});
        assert.deepEqual(checked, [['last-hot-water-volume', 0]]);
    });
}

// ── Per-profile brew-temp override (profileManager.js) ───────────────────────
{
    const withSavedBrewTemp = new Function(
        `${lift('profileManager.js', [/export function withSavedBrewTemp\(profile, metadata\) \{[\s\S]*?\r?\n\}/])}
         return withSavedBrewTemp;`)();

    const profile = { title: 'Classic', steps: [{ temperature: 92, name: 'infuse' }, { temperature: 88, name: 'decline' }] };

    test('a saved brew temp is applied to every step', () => {
        const out = withSavedBrewTemp(profile, { brewTemperature: 94 });
        assert.deepEqual(out.steps.map(s => s.temperature), [94, 94]);
        assert.equal(out.title, 'Classic');
        assert.equal(out.steps[1].name, 'decline'); // other step fields survive
    });

    test('the cached record is never mutated', () => {
        withSavedBrewTemp(profile, { brewTemperature: 94 });
        assert.deepEqual(profile.steps.map(s => s.temperature), [92, 88]);
    });

    test('no saved override leaves the profile exactly as it was', () => {
        for (const meta of [undefined, null, {}, { brewTemperature: null }, { brewTemperature: 'hot' }, { brewTemperature: NaN }]) {
            assert.equal(withSavedBrewTemp(profile, meta), profile);
        }
    });

    test('a profile with no steps is returned untouched', () => {
        const stepless = { title: 'Odd' };
        assert.equal(withSavedBrewTemp(stepless, { brewTemperature: 94 }), stepless);
        assert.equal(withSavedBrewTemp(null, { brewTemperature: 94 }), null);
    });
}
