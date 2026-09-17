import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/settings/settings-data.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replaceAll('export ', '');

function createSettingsData({ getReaSettings = async () => ({}), setReaSettings, getSetting = async () => undefined, setSetting = async () => undefined }) {
    return new Function(
        'getReaSettings', 'setReaSettings', 'openDB', 'getSetting', 'setSetting',
        `${source}\nreturn { getSnapshot, getPendingReaChanges, updateReaSetting, saveSettingsData, startSettingsData };`
    )(
        getReaSettings,
        setReaSettings,
        async () => {},
        getSetting,
        setSetting
    );
}

test('an edit made during save remains pending', async () => {
    const finishes = [];
    const sent = [];
    const settings = createSettingsData({ setReaSettings: changes => {
        sent.push(changes);
        return new Promise(resolve => { finishes.push(resolve); });
    } });

    settings.updateReaSetting('weightFlowMultiplier', 1.1);
    const save = settings.saveSettingsData();
    settings.updateReaSetting('weightFlowMultiplier', 1.2);
    assert.deepEqual(settings.getPendingReaChanges(), { weightFlowMultiplier: 1.2 });
    assert.equal(settings.getSnapshot().rea.weightFlowMultiplier, 1.2);
    finishes[0]();
    await new Promise(resolve => setImmediate(resolve));
    finishes[1]();
    await save;

    assert.deepEqual(sent, [{ weightFlowMultiplier: 1.1 }, { weightFlowMultiplier: 1.2 }]);
    assert.deepEqual(settings.getPendingReaChanges(), {});
    assert.equal(settings.getSnapshot().rea.weightFlowMultiplier, 1.2);
    assert.equal(settings.getSnapshot().dirty, false);
});

test('overlapping saves are serialized and persist the newest edit last', async () => {
    const sent = [];
    const finishes = [];
    const settings = createSettingsData({
        setReaSettings: changes => new Promise(resolve => {
            sent.push(changes);
            finishes.push(resolve);
        })
    });

    settings.updateReaSetting('weightFlowMultiplier', 1.1);
    const first = settings.saveSettingsData();
    settings.updateReaSetting('weightFlowMultiplier', 1.2);
    const second = settings.saveSettingsData();

    assert.strictEqual(second, first);
    assert.deepEqual(sent, [{ weightFlowMultiplier: 1.1 }]);
    finishes[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, [{ weightFlowMultiplier: 1.1 }, { weightFlowMultiplier: 1.2 }]);
    finishes[1]();
    await Promise.all([first, second]);
    assert.equal(settings.getSnapshot().rea.weightFlowMultiplier, 1.2);
    assert.equal(settings.getSnapshot().dirty, false);
});

test('startup refresh cannot overwrite a successful save', async () => {
    let finishRefresh;
    const writes = [];
    const settings = createSettingsData({
        getReaSettings: () => new Promise(resolve => { finishRefresh = resolve; }),
        setReaSettings: async () => {},
        setSetting: async (key, value) => { writes.push([key, value]); }
    });

    const { refresh } = settings.startSettingsData();
    settings.updateReaSetting('weightFlowMultiplier', 1.2);
    await settings.saveSettingsData();
    finishRefresh({ weightFlowMultiplier: 1 });
    await refresh;

    assert.equal(settings.getSnapshot().rea.weightFlowMultiplier, 1.2);
    assert.equal(writes.filter(([key]) => key === 'settings-rea').at(-1)[1].weightFlowMultiplier, 1.2);
});

test('startup hydration cannot overwrite a successful save', async () => {
    let finishHydration;
    let settingsBackupReads = 0;
    const settings = createSettingsData({
        getReaSettings: () => new Promise(() => {}),
        setReaSettings: async () => {},
        getSetting: async key => {
            if (key !== 'settingsBackup' || settingsBackupReads++ > 0) return undefined;
            return new Promise(resolve => { finishHydration = resolve; });
        }
    });

    const { hydration } = settings.startSettingsData();
    settings.updateReaSetting('weightFlowMultiplier', 1.2);
    await settings.saveSettingsData();
    finishHydration({ ts: Date.now(), rea: { weightFlowMultiplier: 1 } });
    await hydration;

    assert.equal(settings.getSnapshot().rea.weightFlowMultiplier, 1.2);
});

test('failed startup refresh preserves a valid cached setting', async () => {
    let finishHydration;
    const writes = [];
    const settings = createSettingsData({
        getReaSettings: async () => null,
        setReaSettings: async () => {},
        getSetting: async key => key === 'settingsBackup'
            ? undefined
            : new Promise(resolve => { finishHydration = resolve; }),
        setSetting: async (key, value) => { writes.push([key, value]); }
    });

    const { hydration, refresh } = settings.startSettingsData();
    await refresh;
    finishHydration({ weightFlowMultiplier: 1.2, volumeFlowMultiplier: 0.4 });
    await hydration;

    assert.deepEqual(settings.getSnapshot().rea, { weightFlowMultiplier: 1.2, volumeFlowMultiplier: 0.4 });
    assert.equal(writes.some(([key, value]) => key === 'settings-rea' && value === null), false);
    assert.match(settings.getSnapshot().error, /returned no data/);
});

// ── A background refresh must not discard unsaved edits ─────────────────────
//
// The settings page renders from an IDB-backed cache immediately and fetches
// from the network in the background, so the page is editable before the fetch
// lands. `rea` merged its staged edits over the fetched values; `de1`,
// `de1Advanced` and the workflow blocks did not, so a preload arriving mid-edit
// reset the displayed value to the machine's. The Fan Threshold stepper reads
// the displayed number, so the next tap stepped from the wrong base and saved a
// value the user never chose. While the DE1 is unreachable the page re-preloads
// every 3 seconds, which made this near-certain rather than a narrow race.

const settingsSource = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
const mergeStagedOverFetched = (() => {
    const match = settingsSource.match(/export function mergeStagedOverFetched\(fetched, staged\) \{[\s\S]*?\r?\n\}/);
    assert.ok(match, 'mergeStagedOverFetched not found in settings.js');
    return new Function(`${match[0].replace('export ', '')}\nreturn mergeStagedOverFetched;`)();
})();

test('a staged edit survives a slower fetch that started before it', () => {
    const merged = mergeStagedOverFetched({ fan: 40, flushTemp: 90 }, { fan: 45 });
    assert.equal(merged.fan, 45);
    assert.equal(merged.flushTemp, 90, 'untouched fields still come from the machine');
});

test('with nothing staged the fetched settings are used as they are', () => {
    const fetched = { fan: 40 };
    assert.equal(mergeStagedOverFetched(fetched, {}), fetched);
});

test('a failed fetch is passed through rather than turned into an object', () => {
    // The caller distinguishes null (unreachable, show the retry page) from an
    // empty object, so merging must not manufacture one.
    assert.equal(mergeStagedOverFetched(null, { fan: 45 }), null);
    assert.equal(mergeStagedOverFetched(undefined, { fan: 45 }), undefined);
});

test('a staged zero is kept, not treated as absent', () => {
    // 0 is a real value here: fan threshold 0 and steam target 0 both mean
    // something, so a falsy check instead of a key check would drop them.
    assert.equal(mergeStagedOverFetched({ fan: 40 }, { fan: 0 }).fan, 0);
});
