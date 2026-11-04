import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideResync } from '../src/modules/resync-policy.js';
import { profileAtBrewTemp } from '../src/modules/brew-temp.js';
import { selectedRecipeSteam } from '../src/modules/dye-selection.js';
import { isSteamOff, steamOffPatch, steamOnPatch, steamDurationWrite, MIN_STEAM_DURATION_S } from '../src/modules/steam-mode.js';

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

// The own-push tracking resyncIfDrifted and the KV-first setters share.
const TRACKING = [
    /const lastOwnPush = new Map\(\);/,
    /const pendingPushKey = .*;/,
    /async function readPendingPush\(key\) \{[\s\S]*?\r?\n\}/,
    /async function pushRemembered\(key, value, send\) \{[\s\S]*?\r?\n\}/,
];

// Module state readSharedValue needs: the namespace it reads from, and its
// short-lived read cache. Lifted with it everywhere -- without the namespace
// the KV branch throws a ReferenceError that the function's own catch swallows,
// so every test silently measured the IndexedDB fallback instead.
const SHARED_VALUE_CACHE = [
    /const SETTINGS_NAMESPACE = .*;/,
    /const inFlightGets = new Map\(\);/,
    /function dedupedGet\(key, request\) \{[\s\S]*?\r?\n\}/,
    /const SHARED_VALUE_TTL_MS = .*;/,
    /const sharedValueCache = new Map\(\);.*/,
];

// ── Milk stop + the shared KV resync rule (api.js) ───────────────────────────
{
    const body = lift('api.js', [
        /export const MILK_STOP_LAST_VALUE_KEY = .*;/,
        ...SHARED_VALUE_CACHE,
        /export async function readSharedValue\(key\) \{[\s\S]*?\r?\n\}/,
        ...TRACKING,
        /export async function resyncIfDrifted\(key, fetchedValue, pushFn\) \{[\s\S]*?\r?\n\}/,
        /export async function resyncMilkStopIfDrifted\(stopAtTemperature\) \{[\s\S]*?\r?\n\}/,
        /export async function setStopAtTemperature\(celsius\) \{[\s\S]*?\r?\n\}/,
    ]);

    // `pending` is the per-device marker of a push of ours that never landed.
    const build = (remembered, { pending = null } = {}) => {
        const kvWrites = [];
        const workflowWrites = [];
        const pendingWrites = [];
        const api = new Function(
            'logger', 'persistSharedValue', 'persistLastValue', 'updateWorkflow', 'getValueFromStore', 'openDB', 'getSetting', 'decideResync',
             `const isAutoSteamActive = () => false; ${body}\nreturn { setStopAtTemperature, resyncMilkStopIfDrifted, resyncIfDrifted };`,
        )(
            { warn() {}, error() {} },
            async (key, value) => { kvWrites.push([key, value]); },
            async (key, value) => { pendingWrites.push([key, value]); },
            async (patch) => { workflowWrites.push(patch); },
            async () => remembered,
            async () => {},
            async (key) => (key.startsWith('pending-') ? pending : remembered),
            decideResync,
        );
        return { api, kvWrites, workflowWrites, pendingWrites };
    };

    test('an armed milk stop is remembered in KV before it reaches the machine', async () => {
        const { api, kvWrites, workflowWrites, pendingWrites } = build(null);
        await api.setStopAtTemperature(60);
        assert.deepEqual(kvWrites, [['last-milk-stop', 60]]);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 60 } }]);
        // Marked pending before the PUT, cleared once it landed.
        assert.deepEqual(pendingWrites, [['pending-last-milk-stop', 60], ['pending-last-milk-stop', null]]);
    });

    test('turning the stop off writes the machine but never the KV record', async () => {
        // 0 = off (user toggle, or a probe that vanished). Persisting it would erase
        // the temperature the user tuned.
        const { api, kvWrites, workflowWrites } = build(null);
        await api.setStopAtTemperature(0);
        assert.deepEqual(kvWrites, []);
        assert.deepEqual(workflowWrites, [{ steamSettings: { stopAtTemperature: 0 } }]);
    });

    test('an armed stop changed by another writer is adopted, not pushed back (#105)', async () => {
        const { api, kvWrites, workflowWrites } = build(60);
        assert.equal(await api.resyncMilkStopIfDrifted(55), null);
        assert.deepEqual(workflowWrites, []);
        assert.deepEqual(kvWrites, [['last-milk-stop', 55]]);
    });

    test('an armed stop whose own push never landed is re-pushed', async () => {
        const { api, kvWrites, workflowWrites } = build(60, { pending: 60 });
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
        const { api, kvWrites, workflowWrites } = build(85, { pending: 85 });
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
        const { api } = build(45, { pending: 45 });
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

    test('a value some other writer set is adopted and not repainted or pushed', async () => {
        const pushed = [];
        const { api, kvWrites } = build(45);
        assert.equal(await api.resyncIfDrifted('last-anything', 30, async (v) => { pushed.push(v); }), null);
        assert.deepEqual(pushed, []);
        assert.deepEqual(kvWrites, [['last-anything', 30]]);
    });

    test('a push that fails stays pending so it can be retried after a reload', async () => {
        const kvWrites = [];
        const pendingWrites = [];
        const failing = new Function(
            'persistSharedValue', 'persistLastValue', 'openDB', 'getSetting', 'logger',
            `${body}\nreturn pushRemembered;`,
        )(
            async (key, value) => { kvWrites.push([key, value]); },
            async (key, value) => { pendingWrites.push([key, value]); },
            async () => {}, async () => null, { warn() {} },
        );
        await assert.rejects(failing('last-milk-stop', 60, async () => { throw new Error('503'); }));
        assert.deepEqual(kvWrites, [['last-milk-stop', 60]]);
        assert.deepEqual(pendingWrites, [['pending-last-milk-stop', 60]]);
    });

    test('with nothing remembered the machine value stands', async () => {
        const pushed = [];
        const { api } = build(null);
        await api.resyncIfDrifted('last-anything', 30, async (v) => { pushed.push(v); });
        await api.resyncIfDrifted('last-anything', undefined, async (v) => { pushed.push(v); });
        assert.deepEqual(pushed, []);
    });

    // resyncDriftedShotSettings re-checks drift on every shotSettings frame that
    // moves a field, and releases its cooldown whenever a check found nothing to
    // push -- so an unguarded readSharedValue was one /store GET per field per
    // frame. The cache is what keeps that at one round trip per field.
    {
        const buildCounted = (values) => {
            const reads = [];
            const api = new Function(
                'logger', 'persistSharedValue', 'persistLastValue', 'updateWorkflow', 'getValueFromStore', 'openDB', 'getSetting', 'decideResync',
                `const isAutoSteamActive = () => false; ${body}\nreturn { readSharedValue };`,
            )(
                { warn() {}, error() {} },
                async () => {}, async () => {}, async () => {},
                async (_ns, key) => { reads.push(key); return values[key] ?? null; },
                async () => {}, async () => null, decideResync,
            );
            return { api, reads };
        };

        test('a repeated shared-value read inside the TTL costs one store round trip', async () => {
            const { api, reads } = buildCounted({ 'last-steam-flow': 2.1 });
            assert.equal(await api.readSharedValue('last-steam-flow'), 2.1);
            assert.equal(await api.readSharedValue('last-steam-flow'), 2.1);
            assert.equal(await api.readSharedValue('last-steam-flow'), 2.1);
            assert.deepEqual(reads, ['last-steam-flow']);
        });

        test('each key is cached on its own, and a never-set key caches its null', async () => {
            const { api, reads } = buildCounted({ 'last-steam-flow': 2.1 });
            assert.equal(await api.readSharedValue('last-steam-flow'), 2.1);
            // null is a real answer ("never set"), so it must cache too -- the
            // boot resync asks for keys the user has never touched.
            assert.equal(await api.readSharedValue('last-milk-stop'), null);
            assert.equal(await api.readSharedValue('last-milk-stop'), null);
            assert.deepEqual(reads, ['last-steam-flow', 'last-milk-stop']);
        });
    }
}

// ── Steam duration 0 = the heater off; one rule for every way in (api.js) ───
{
    const body = lift('api.js', [
        /export const STEAM_DURATION_LAST_VALUE_KEY = .*;/,
        /export const STEAM_FLOW_LAST_VALUE_KEY = .*;/,
        /export const STEAM_TEMP_LAST_VALUE_KEY = .*;/,
        ...SHARED_VALUE_CACHE,
        /export async function readSharedValue\(key\) \{[\s\S]*?\r?\n\}/,
        ...TRACKING,
        /export async function setTargetSteamTemp\(temp\) \{[\s\S]*?\r?\n\}/,
        /async function steamHeaterFor\(on\) \{[\s\S]*?\r?\n\}/,
        /export async function setTargetSteamDuration\(duration, \{ rearm = false \} = \{\}\) \{[\s\S]*?\r?\n\}/,
        /export async function setSteamHeaterEnabled\(enabled\) \{[\s\S]*?\r?\n\}/,
    ]);

    // `remembered` is the KV record of the values to come back to (a bare number
    // is the temperature, the common case); `machine` is what the workflow
    // currently holds.
    const build = (remembered, machine = { targetTemperature: 150 }, dye = {}) => {
        const kv = typeof remembered === 'object' && remembered !== null ? remembered : { temp: remembered };
        const stored = {
            'last-steam-temp': kv.temp ?? null,
            'last-steam-duration': kv.duration ?? null,
            'last-steam-flow': kv.flow ?? null,
        };
        const steamSettings = typeof machine === 'number' ? { targetTemperature: machine } : machine;
        const kvWrites = [];
        const workflowWrites = [];
        const writerTags = [];
        const api = new Function(
            'logger', 'persistSharedValue', 'persistLastValue', 'updateWorkflow', 'getWorkflow', 'getValueFromStore', 'openDB', 'getSetting',
            'localStorage', 'getKVValue', 'getDye2KvArray', 'DYE2_KV_NAMESPACE', 'selectedRecipeSteam',
            'isSteamOff', 'steamOffPatch', 'steamOnPatch', 'steamDurationWrite', 'MIN_STEAM_DURATION_S',
            `const isAutoSteamActive = () => false; ${body}\nreturn { setTargetSteamDuration, setSteamHeaterEnabled, setTargetSteamTemp };`,
        )(
            { warn() {}, error() {} },
            async (key, value) => { kvWrites.push([key, value]); },
            async () => {},
            async (patch, writer) => { workflowWrites.push(patch); writerTags.push(writer); },
            async () => ({ steamSettings }),
            async (_namespace, key) => stored[key] ?? null,
            async () => {},
            async (key) => stored[key] ?? null,
            { getItem: () => (dye.enabled ? 'true' : null) },
            async () => dye.selection ?? null,
            async () => dye.recipes ?? null,
            'dye2.reaplugin',
            selectedRecipeSteam,
            isSteamOff, steamOffPatch, steamOnPatch, steamDurationWrite, MIN_STEAM_DURATION_S,
        );
        return { api, kvWrites, workflowWrites, writerTags };
    };

    test('duration 0 switches the heater off and is never remembered as a duration', async () => {
        // 0 has one meaning now: off. The last-* keys hold what we switch back
        // ON to, so a 0 must not land in them.
        const { api, kvWrites, workflowWrites } = build(null, { targetTemperature: 150, duration: 25 });
        await api.setTargetSteamDuration(0);
        assert.deepEqual(workflowWrites, [{ steamSettings: { targetTemperature: 0, duration: 0 } }]);
        assert.deepEqual(kvWrites, [['last-steam-temp', 150], ['last-steam-duration', 25]]);
    });

    test('the user setting a duration on an off machine brings the temperature back', async () => {
        // The tile reads the duration and the Settings toggle reads the
        // temperature. Sending the duration alone left the tile counting
        // seconds for a heater the toggle still (correctly) reported as off.
        const { api, workflowWrites, writerTags } = build({ temp: 150, duration: 45 }, 0);
        await api.setTargetSteamDuration(30, { rearm: true });
        assert.deepEqual(workflowWrites, [{ steamSettings: { targetTemperature: 150, duration: 30 } }],
            'the duration asked for wins over the remembered one');
        // Carrying the temperature makes this the heater writer's write, not
        // the duration writer's -- workflow-fields.js enforces that split.
        assert.deepEqual(writerTags, ['api.steamHeater']);
    });

    test('a background replay does not wake a heater the user switched off', async () => {
        // A drift resync or a profile's saved steam settings. Nothing is
        // written -- not the workflow, and not the KV key, which would
        // otherwise disagree with the workflow for good and have the drift
        // check replaying this on every cooldown.
        const { api, kvWrites, workflowWrites } = build({ temp: 150, duration: 45 }, 0);
        assert.equal(await api.setTargetSteamDuration(30), null);
        assert.deepEqual(workflowWrites, []);
        assert.deepEqual(kvWrites, []);
    });

    test('with the heater on, a duration write still sends the duration alone', async () => {
        const { api, workflowWrites } = build(150, { targetTemperature: 150 });
        await api.setTargetSteamDuration(30, { rearm: true });
        assert.deepEqual(workflowWrites, [{ steamSettings: { duration: 30 } }]);
    });

    test('switching the heater off zeroes both and remembers both', async () => {
        const { api, kvWrites, workflowWrites } = build(null, { targetTemperature: 150, duration: 45 });
        await api.setSteamHeaterEnabled(false);
        assert.deepEqual(workflowWrites, [{ steamSettings: { targetTemperature: 0, duration: 0 } }]);
        assert.deepEqual(kvWrites, [['last-steam-temp', 150], ['last-steam-duration', 45]]);
    });

    test('switching the heater on restores the remembered temperature and duration', async () => {
        const { api, workflowWrites } = build({ temp: 150, duration: 45 }, 0);
        await api.setSteamHeaterEnabled(true);
        assert.deepEqual(workflowWrites, [{ steamSettings: { targetTemperature: 150, duration: 45 } }]);
    });

    test('switching on with no remembered duration uses the documented default', async () => {
        const { api, workflowWrites } = build(150, 0);
        await api.setSteamHeaterEnabled(true);
        assert.deepEqual(workflowWrites, [{ steamSettings: { targetTemperature: 150, duration: 30 } }]);
    });

    test('a temperature set outside Streamline while steam is on is not overridden (#143)', async () => {
        const { api, workflowWrites } = build(150, 140);
        await api.setSteamHeaterEnabled(true);
        assert.deepEqual(workflowWrites, [{ steamSettings: {} }]);
    });

    test('a selected recipe beats the remembered values on re-arm, per field', async () => {
        const recipes = [{ id: '2', dashboardVariables: { steamTempC: 140, steamTimeS: 12 } }];
        const dye = { enabled: true, selection: { kind: 'recipe', id: '2' }, recipes };
        const { api, workflowWrites } = build({ temp: 150, duration: 45 }, 0, dye);
        await api.setSteamHeaterEnabled(true);
        assert.deepEqual(workflowWrites, [{ steamSettings: { targetTemperature: 140, duration: 12 } }]);
    });

    test('a recipe carrying only a temperature still gets the remembered duration', async () => {
        const recipes = [{ id: '2', dashboardVariables: { steamTempC: 140 } }];
        const dye = { enabled: true, selection: { kind: 'recipe', id: '2' }, recipes };
        const { api, workflowWrites } = build({ temp: 150, duration: 45 }, 0, dye);
        await api.setSteamHeaterEnabled(true);
        assert.deepEqual(workflowWrites, [{ steamSettings: { targetTemperature: 140, duration: 45 } }]);
    });

    test('DYE2 disabled or nothing selected falls back to the remembered values', async () => {
        const recipes = [{ id: '2', dashboardVariables: { steamTempC: 140 } }];
        const expected = [{ steamSettings: { targetTemperature: 150, duration: 45 } }];
        const off = build({ temp: 150, duration: 45 }, 0, { enabled: false, selection: { kind: 'recipe', id: '2' }, recipes });
        await off.api.setSteamHeaterEnabled(true);
        assert.deepEqual(off.workflowWrites, expected);
        const none = build({ temp: 150, duration: 45 }, 0, { enabled: true, recipes });
        await none.api.setSteamHeaterEnabled(true);
        assert.deepEqual(none.workflowWrites, expected);
    });

    test('a recipe steam temperature does not override a heater already on (#143)', async () => {
        const dye = { enabled: true, selection: { kind: 'recipe', id: '2' }, recipes: [{ id: '2', dashboardVariables: { steamTempC: 140 } }] };
        const { api, workflowWrites } = build(150, 145, dye);
        await api.setSteamHeaterEnabled(true);
        assert.deepEqual(workflowWrites, [{ steamSettings: {} }]);
    });

    test('switching on a heater that is already on changes nothing', async () => {
        const { api, workflowWrites } = build(null, 150);
        await api.setSteamHeaterEnabled(true);
        assert.deepEqual(workflowWrites, [{ steamSettings: {} }]);
    });

    test('an already-off machine has nothing worth remembering', async () => {
        const { api, kvWrites } = build(null, { targetTemperature: 0, duration: 0 });
        await api.setSteamHeaterEnabled(false);
        assert.deepEqual(kvWrites, []);
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
        ...TRACKING,
        /export async function setTargetHotWaterVolume\(volume\) \{[\s\S]*?\r?\n\}/,
        /export async function setTargetHotWaterTemp\(temp\) \{[\s\S]*?\r?\n\}/,
    ]);

    // One ordered log of both sides, so "which happened first" is the assertion.
    const build = ({ putFails = false } = {}) => {
        const order = [];
        const api = new Function(
            'logger', 'persistSharedValue', 'persistLastValue', 'openDB', 'getSetting', 'updateWorkflow',
            `${body}\nreturn { setTargetHotWaterVolume, setTargetHotWaterTemp };`,
        )(
            { warn() {}, error() {} },
            async (key, value) => { order.push(['kv', key, value]); },
            async () => {},
            async () => {},
            async () => null,
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
        'profileAtBrewTemp',
        `${lift('profileManager.js', [/export function withSavedBrewTemp\(profile, metadata\) \{[\s\S]*?\r?\n\}/])}
         return withSavedBrewTemp;`)(profileAtBrewTemp);

    const profile = { title: 'Classic', steps: [{ temperature: 92, name: 'infuse' }, { temperature: 88, name: 'decline' }] };

    test('a saved brew temp moves the whole curve and keeps the profile shape', () => {
        const out = withSavedBrewTemp(profile, { brewTemperature: 94 });
        assert.deepEqual(out.steps.map(s => s.temperature), [94, 90]); // 92 -> 88 shifted by +2
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


test('the transient Auto steam session remains device-local', () => {
    const source = readFileSync(new URL('../src/modules/settingsSync.js', import.meta.url), 'utf8');
    const syncedKeys = source.match(/export const SYNCED_KEYS = \[[\s\S]*?\];/)?.[0];
    assert.ok(syncedKeys, 'SYNCED_KEYS declaration not found');
    assert.doesNotMatch(syncedKeys, /streamline\.autoSteamSession/);
});

// Main-page quick presets used to live in IndexedDB, which the WebView loses on
// every Decaid app update -- a user's favourite 14:28 ratio had to be re-entered
// each time. They now go through localStorage so the KV mirror carries them.
test('every main-page preset key is mirrored to KV', () => {
    const ui = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
    const sync = readFileSync(new URL('../src/modules/settingsSync.js', import.meta.url), 'utf8');
    const syncedKeys = sync.match(/export const SYNCED_KEYS = \[[\s\S]*?\];/)?.[0];
    assert.ok(syncedKeys, 'SYNCED_KEYS declaration not found');

    const presetKeys = [...ui.matchAll(/^const [A-Z_]*PRESETS?[A-Z_]*_KEY = '([^']+)';$/gm)].map(m => m[1]);
    assert.ok(presetKeys.length >= 9, `expected the preset keys, found ${presetKeys.length}`);
    for (const key of presetKeys) {
        assert.match(syncedKeys, new RegExp(`'${key}'`), `${key} is not mirrored to KV`);
    }
});

test('preset writes do not go back to IndexedDB', () => {
    const ui = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
    assert.doesNotMatch(ui, /\bsetSetting\(\s*[A-Z_]*PRESET/);
});

// A hydrate that lands after the page painted (Decaid answered on the retry
// ladder) has to tell the UI, or the buttons keep showing pre-restore values.
test('a late restore announces the keys it applied', () => {
    const sync = readFileSync(new URL('../src/modules/settingsSync.js', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');

    assert.match(sync, /export const SETTINGS_RESTORED_EVENT = '[^']+';/);
    // Fired only when something actually changed, and carrying what changed.
    assert.match(sync, /if \(Object\.keys\(applied\)\.length\) \{[\s\S]*?dispatchEvent\(new CustomEvent\(SETTINGS_RESTORED_EVENT, \{ detail: applied \}\)\)/);

    // ui.js listens and re-runs a loader for every preset key it persists.
    assert.match(ui, /addEventListener\(SETTINGS_RESTORED_EVENT/);
    const handler = ui.match(/function initPresetRestoreListener\(\) \{[\s\S]*?\r?\n\}/)?.[0];
    assert.ok(handler, 'initPresetRestoreListener not found');
    for (const key of [...ui.matchAll(/^const ([A-Z_]*PRESETS?[A-Z_]*_KEY) = '[^']+';$/gm)].map(m => m[1])) {
        // The selected-index and model keys are bookkeeping, not button labels.
        if (/INDEX|MODEL/.test(key)) continue;
        assert.match(handler, new RegExp(`\\[${key}\\]`), `${key} has no restore repaint`);
    }
    assert.match(ui, /initPresetRestoreListener\(\);/);
});

// ── Consumer-side ordering (#168) ───────────────────────────────────────────
//
// hydrate() being correct is not enough: a reader that runs before it finishes gets the
// DEFAULT, and nothing repainted the surface afterwards. dyeStrip is the case that bit --
// `streamline.dye2Enabled` is on SYNCED_KEYS, and index.html starts initDyeStrip from its
// own DOMContentLoaded listener, separate from app.js's gated one, so on a second client (or
// any client after an app update, which wipes WebView storage) the DYE button stayed missing
// for the whole session while Settings showed the extension enabled.

test('the DYE2 boot reader waits for hydration, and still listens for a late restore', () => {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const init = source.slice(source.indexOf('export async function initDyeStrip('));
    const body = init.slice(0, init.indexOf('\n}\n'));

    assert.ok(body.includes('await settingsReady'), 'the flag is read behind settingsReady');
    assert.ok(body.indexOf('await settingsReady') < body.indexOf('const on = isDye2Enabled()'),
        'and the await comes first, or the read answers with the pre-hydration default');
    // settingsReady resolves even when Decaid never answered, so the gate alone is not
    // enough: the real value then arrives through the retry ladder's restore event.
    assert.ok(/addEventListener\(SETTINGS_RESTORED_EVENT/.test(body), 'a late restore is heard');
    assert.ok(body.indexOf('addEventListener(SETTINGS_RESTORED_EVENT') < body.indexOf('await settingsReady'),
        'registered before the await: the on-time hydrate dispatches while settingsReady is pending');
    assert.ok(body.includes('ENABLED_KEY in (event.detail || {})'),
        'and only reacts to its own key');
});

function buildDyeUi() {
    const calls = [];
    const body = lift('dyeStrip.js', [/async function applyDye2Ui\([\s\S]*?\r?\n\}/]);
    const api = new Function('enableDye2Ui', 'disableDye2Ui',
        `let dye2UiOn = null;\n${body}\nreturn { applyDye2Ui, shown: () => dye2UiOn };`
    )(async () => { calls.push('enable'); }, () => { calls.push('disable'); });
    return { api, calls };
}

// disableDye2Ui() bumps applySeq, clears the armed item, forgets the parked selection and
// releases DYE2's selection, so running it on a restore that only confirms what the header
// already shows would throw away live state.
test('the surface is only touched when it actually changes', async () => {
    const { api, calls } = buildDyeUi();
    await api.applyDye2Ui(false);          // boot, flag off
    await api.applyDye2Ui(false);          // a restore confirming off
    assert.deepEqual(calls, ['disable'], 'the confirming restore is a no-op');
    await api.applyDye2Ui(true);           // the late restore that fixes #168
    assert.deepEqual(calls, ['disable', 'enable']);
    assert.equal(api.shown(), true);
    await api.applyDye2Ui(true);
    assert.deepEqual(calls, ['disable', 'enable'], 'and so is a confirming restore when on');
});

test('an unhydrated boot that turns out to be enabled shows the surface once', async () => {
    const { api, calls } = buildDyeUi();
    await api.applyDye2Ui(true);
    assert.deepEqual(calls, ['enable'], 'no spurious disable first');
});

// settingsSync cannot import ui.js, so RESTORE_HANDLED_KEYS is a copy of its
// preset keys; a preset ui.js repaints but this list lacks would force a reload.
test('the late-restore handled keys cover every preset ui.js repaints', () => {
    const ui = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
    const sync = readFileSync(new URL('../src/modules/settingsSync.js', import.meta.url), 'utf8');
    const handled = sync.match(/export const RESTORE_HANDLED_KEYS = \[[\s\S]*?\];/)?.[0];
    assert.ok(handled, 'RESTORE_HANDLED_KEYS declaration not found');
    const byKey = ui.match(/const byKey = \{([\s\S]*?)\n    \};/)?.[1];
    assert.ok(byKey, 'byKey map not found');
    const presetKeys = [...byKey.matchAll(/\[([A-Z_]+_KEY)\]/g)].map(m =>
        ui.match(new RegExp(`const ${m[1]} = '([^']+)';`))?.[1]);
    assert.ok(presetKeys.length >= 8 && presetKeys.every(Boolean));
    for (const key of presetKeys) assert.match(handled, new RegExp(`'${key}'`), `${key} missing`);
});
