import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as grinderSync from '../src/modules/grinder-sync.js';

const { deviceSetting, parseDeviceNumber, readingText, grindTileDisplay, followDecision, canSendGrind, grinderSettingString, sendDecision, workflowGrindStep, workflowGrindRange, grindDecimals } = grinderSync;

const numeric = { kind: 'numeric', min: 0, max: 40, step: 0.5 };
const info = { capabilities: ['grindSetting'], controls: { grindSetting: numeric } };

test('deviceSetting: setting, else observedSetting, strings only', () => {
    assert.equal(deviceSetting({ setting: '200', observedSetting: '5' }), '200');
    assert.equal(deviceSetting({ observedSetting: '12.5' }), '12.5');
    assert.equal(deviceSetting({ state: 'idle' }), null);
    assert.equal(deviceSetting({ setting: 200 }), null);
    assert.equal(deviceSetting(null), null);
});

test('parseDeviceNumber: bare numbers only, never a number with a unit', () => {
    assert.equal(parseDeviceNumber('200'), 200);
    assert.equal(parseDeviceNumber(' 5.2 '), 5.2);
    assert.equal(parseDeviceNumber('83'), 83);
    assert.equal(parseDeviceNumber('827 ddValueDum'), null);
    assert.equal(parseDeviceNumber('3 B'), null);
    assert.equal(parseDeviceNumber('12.5 mm'), null);
    assert.equal(parseDeviceNumber('espresso/A'), null);
    assert.equal(parseDeviceNumber('5A'), null);
    assert.equal(parseDeviceNumber('1e3'), null);
    assert.equal(parseDeviceNumber(''), null);
    assert.equal(parseDeviceNumber(7), null);
});

test('readingText: the reading as the grinder reports it, trimmed', () => {
    assert.equal(readingText(' 827 ddValueDum '), '827 ddValueDum');
    assert.equal(readingText(' 5.25 '), '5.25');
    assert.equal(readingText('83'), '83');
    assert.equal(readingText(' espresso/A '), 'espresso/A');
    assert.equal(readingText('   '), null);
    assert.equal(readingText(null), null);
});

test('grindTileDisplay: the workflow grind wins, else the grinder reading, else a dash', () => {
    assert.deepEqual(grindTileDisplay('15.00', '83'), { text: '15', fromGrinder: false });
    assert.deepEqual(grindTileDisplay('5.25', null), { text: '5.3', fromGrinder: false });
    assert.deepEqual(grindTileDisplay(null, '827 ddValueDum'), { text: '827 ddValueDum', fromGrinder: true });
    assert.deepEqual(grindTileDisplay(null, '83'), { text: '83', fromGrinder: true });
    assert.deepEqual(grindTileDisplay(undefined, 'espresso/A'), { text: 'espresso/A', fromGrinder: true });
    assert.deepEqual(grindTileDisplay('', '83'), { text: '83', fromGrinder: true });
    assert.deepEqual(grindTileDisplay(null, null), { text: '—', fromGrinder: false });
    assert.deepEqual(grindTileDisplay(null, ' '), { text: '—', fromGrinder: false });
});

test('follow: applies on a change, never when unchanged or already on the tile', () => {
    assert.equal(followDecision({ deviceValue: 18, lastDevice: null, tileValue: 56.4 }), 18);
    assert.equal(followDecision({ deviceValue: 18, lastDevice: 17, tileValue: 56.4 }), 18);
    assert.equal(followDecision({ deviceValue: 18, lastDevice: 18, tileValue: 56.4 }), null); // user's edit stands
    assert.equal(followDecision({ deviceValue: 18, lastDevice: 17, tileValue: 18 }), null);
    assert.equal(followDecision({ deviceValue: 18.001, lastDevice: 17, tileValue: 18 }), null);
    assert.equal(followDecision({ deviceValue: NaN, lastDevice: 17, tileValue: 18 }), null);
});

test('canSendGrind: needs the command and a numeric range', () => {
    assert.equal(canSendGrind(info), true);
    assert.equal(canSendGrind({ capabilities: ['rpmControl'], controls: { grindSetting: numeric } }), false);
    assert.equal(canSendGrind({ capabilities: ['grindSetting'], controls: { grindSetting: { kind: 'opaque' } } }), false);
    assert.equal(canSendGrind({ capabilities: ['grindSetting'], controls: { grindSetting: { kind: 'enumerated', values: ['a'] } } }), false);
    assert.equal(canSendGrind({ capabilities: ['grindSetting'] }), false);
    assert.equal(canSendGrind({ capabilities: ['grindSetting'], controls: { grindSetting: { kind: 'numeric', min: 5, max: 1 } } }), false);
    assert.equal(canSendGrind(null), false);
});

test('grinderSettingString: clamped, precision of the step', () => {
    assert.equal(grinderSettingString(12.5, numeric), '12.5');
    assert.equal(grinderSettingString(12, numeric), '12');
    assert.equal(grinderSettingString(99, numeric), '40');
    assert.equal(grinderSettingString(-3, numeric), '0');
    assert.equal(grinderSettingString(12.456, { kind: 'numeric', min: 0, max: 40 }), '12.46');
    assert.equal(grinderSettingString(12.3, { kind: 'numeric', min: 0, max: 40, step: 1 }), '12');
    assert.equal(grinderSettingString(5, { kind: 'opaque' }), null);
    assert.equal(grinderSettingString(NaN, numeric), null);
});

test('send: only a changed tile, never what the grinder already shows', () => {
    assert.equal(sendDecision({ tileValue: 20, lastTile: 18, deviceValue: 18, info }), '20');
    assert.equal(sendDecision({ tileValue: 20, lastTile: 20, deviceValue: 18, info }), null); // unchanged
    assert.equal(sendDecision({ tileValue: 20, lastTile: 18, deviceValue: 20, info }), null); // echo of a follow
    assert.equal(sendDecision({ tileValue: 20, lastTile: 18, deviceValue: null, info: { capabilities: [] } }), null);
    assert.equal(sendDecision({ tileValue: 60, lastTile: 18, deviceValue: 18, info }), '40');
});

test('grindStepFromInfo: the declared numeric step of a settable grinder, else null', async () => {
    const { grindStepFromInfo } = grinderSync;
    assert.equal(grindStepFromInfo(info), 0.5);
    assert.equal(grindStepFromInfo({ capabilities: ['grindSetting'], controls: { grindSetting: { kind: 'numeric', min: 1, max: 80, step: 1 } } }), 1);
    assert.equal(grindStepFromInfo({ capabilities: ['grindSetting'], controls: { grindSetting: { kind: 'numeric', min: 1, max: 80 } } }), null);
    assert.equal(grindStepFromInfo({ capabilities: ['rpmControl'], controls: { grindSetting: numeric } }), null);
    assert.equal(grindStepFromInfo({ capabilities: ['grindSetting'], controls: { grindSetting: { kind: 'opaque' } } }), null);
    assert.equal(grindStepFromInfo({ capabilities: ['grindSetting'], controls: { grindSetting: { kind: 'numeric', min: 0, max: 9, step: 0 } } }), null);
    assert.equal(grindStepFromInfo(null), null);
});

test('workflowGrindStep: numeric grinders with a sane small step only', () => {
    assert.equal(workflowGrindStep({ settingType: 'numeric', settingSmallStep: 0.2 }), 0.2);
    assert.equal(workflowGrindStep({ settingSmallStep: 0.25 }), 0.25);
    assert.equal(workflowGrindStep({ settingType: 'preset', settingSmallStep: 0.2 }), null);
    for (const bad of [null, 0, -0.1, 101, NaN, '0.2', undefined]) {
        assert.equal(workflowGrindStep({ settingType: 'numeric', settingSmallStep: bad }), null);
    }
    assert.equal(workflowGrindStep(null), null);
});

test('grindDecimals: the step\'s own places, one to two', () => {
    assert.equal(grindDecimals(0.1), 1);
    assert.equal(grindDecimals(0.25), 2);
    assert.equal(grindDecimals(0.125), 2);
});

// --- the -/+ bounds the workflow's grinder declares (DYE2 writes them to extras) ---------

test('a numeric grinder declaring a range hands the tile both bounds', () => {
    assert.deepEqual(workflowGrindRange({ settingType: 'numeric', extras: { settingMin: 0, settingMax: 50 } }),
        { min: 0, max: 50 });
    assert.deepEqual(workflowGrindRange({ extras: { settingMin: 0, settingMax: 50 } }),
        { min: 0, max: 50 }, 'settingType defaults to numeric, as it does for the step');
    assert.deepEqual(workflowGrindRange({ extras: { settingMax: 50 } }),
        { min: null, max: 50 }, 'one bound alone is a bound: the other stays the tile default');
});

test('no declared range leaves the tile on its own bounds', () => {
    for (const g of [null, undefined, {}, { extras: {} }, { extras: { settingMin: null } }]) {
        assert.deepEqual(workflowGrindRange(g), { min: null, max: null });
    }
    assert.deepEqual(workflowGrindRange({ extras: { settingMin: '0', settingMax: '50' } }),
        { min: null, max: null }, 'a string is not a declared bound');
});

test('a preset grinder declares no numeric range', () => {
    // Its positions are named (settingValues), so a min and max over them mean nothing.
    assert.deepEqual(workflowGrindRange({ settingType: 'preset', extras: { settingMin: 1, settingMax: 9 } }),
        { min: null, max: null });
});

test('a reversed range is ignored rather than trusted', () => {
    // DYE2's grinders page refuses to save one; a row written by another client must not be
    // able to make the tile unusable by pinning its floor above its ceiling.
    assert.deepEqual(workflowGrindRange({ extras: { settingMin: 50, settingMax: 0 } }),
        { min: null, max: null });
});

// --- grinder-runtime.js: the snapshot socket, the switches and the tile ---------------------

function runtime({ info = null, follow = false, send = false, workflow = {} } = {}) {
    const store = new Map([['grinder-follow', follow ? '1' : '0'], ['grinder-send', send ? '1' : '0']]);
    const events = new EventTarget();
    const h = { readings: [], applied: [], sent: [], sockets: [], workflowListeners: [], connectionListeners: [], info, workflow };
    const deps = {
        ...grinderSync,
        localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
        document: events,
        Event,
        logger: { warn() {} },
        getGrinderInfo: async () => (h.nextInfo ? h.nextInfo() : h.info),
        getWorkflow: async () => h.workflow,
        setGrinderSetting: async setting => { h.sent.push(setting); },
        onWorkflowUpdated: listener => h.workflowListeners.push(listener),
        subscribeGrinderConnectionChanges: listener => h.connectionListeners.push(listener),
        connectGrinderSnapshot: (onSnapshot, onOpen) => {
            const socket = { onSnapshot, closed: false, close() { socket.closed = true; } };
            h.sockets.push(socket);
            onOpen?.();
            return socket;
        },
        applyPluginSetAsync: async (field, value) => { h.applied.push([field, value]); },
        setGrinderGrindStep: () => {},
        setGrinderReading: text => h.readings.push(text),
    };
    const source = readFileSync(new URL('../src/modules/grinder-runtime.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const api = new Function(...Object.keys(deps), `${source}\nreturn { initGrinderSync, setGrinderSync };`)(...Object.values(deps));
    return Object.assign(h, api, {
        socket: () => h.sockets.at(-1),
        async snapshot(data) { await h.socket().onSnapshot(data); await settle(); },
        async reconnect(next) { h.info = next; for (const listener of h.connectionListeners) await listener(); await settle(); },
    });
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const readOnlyGrinder = { deviceId: 'grinder-1', capabilities: [], observations: ['setting'] };

test('runtime: a read-only grinder\'s reading reaches the tile with Follow off, the workflow untouched', async () => {
    const h = runtime({ info: readOnlyGrinder });
    h.initGrinderSync();
    await settle();
    assert.equal(h.sockets.length, 1, 'a connected grinder opens the snapshot socket without any switch');
    await h.snapshot({ state: 'idle', observedSetting: '83' });
    assert.deepEqual(h.readings, ['83']);
    assert.deepEqual(h.applied, [], 'Follow off: the workflow keeps its own grind');
    await h.reconnect(null);
    assert.equal(h.readings.at(-1), null, 'a grinder that goes away takes its reading off the tile');
    assert.equal(h.socket().closed, true, 'and, with both switches off, its socket');
});

test('runtime: no grinder and no switch keeps the socket closed', async () => {
    const h = runtime();
    h.initGrinderSync();
    await settle();
    assert.equal(h.sockets.length, 0);
});

test('runtime: Follow writes only a bare number; a unit or words are shown, never written', async () => {
    const h = runtime({ info: readOnlyGrinder, follow: true, workflow: { context: {} } });
    h.initGrinderSync();
    await settle();
    for (const reading of ['827 ddValueDum', '3 B', 'espresso/A']) await h.snapshot({ state: 'idle', observedSetting: reading });
    assert.deepEqual(h.applied, []);
    assert.deepEqual(h.readings, ['827 ddValueDum', '3 B', 'espresso/A']);
    await h.snapshot({ state: 'idle', observedSetting: '83' });
    assert.deepEqual(h.applied, [['grinderSetting', 83]]);
});

test('runtime: a grinder-info request that fails keeps the reading and the socket', async () => {
    const h = runtime({ info: readOnlyGrinder });
    h.initGrinderSync();
    await settle();
    await h.snapshot({ state: 'idle', observedSetting: '83' });
    await h.reconnect(undefined);
    assert.equal(h.socket().closed, false);
    assert.deepEqual(h.readings, ['83']);
    await h.reconnect(null);
    assert.equal(h.readings.at(-1), null, 'Decaid saying no grinder still clears it');
});

test('runtime: an answer to a socket reopen cannot overwrite a newer connection check', async () => {
    const h = runtime({ info: readOnlyGrinder });
    h.initGrinderSync();
    await settle();
    let answerOpen;
    const answers = [new Promise(resolve => { answerOpen = resolve; }), Promise.resolve(readOnlyGrinder)];
    h.nextInfo = () => answers.shift();
    h.setGrinderSync('follow', true);
    const [listener] = h.connectionListeners;
    await listener();
    answerOpen(null);
    await settle();
    h.setGrinderSync('follow', false);
    assert.equal(h.readings.includes(null), false);
    assert.equal(h.socket().closed, false, 'the grinder is still known, so its socket stays');
});

test('runtime: Send stays off for a grinder without a settable control', async () => {
    const h = runtime({ info: readOnlyGrinder, send: true, workflow: { context: { grinderSetting: '10.00' } } });
    h.initGrinderSync();
    await settle();
    for (const listener of h.workflowListeners) listener({ context: { grinderSetting: '12.00' } });
    await settle();
    assert.deepEqual(h.sent, []);
});

test('runtime: Send still writes a settable numeric grinder', async () => {
    const h = runtime({ info, send: true, workflow: { context: { grinderSetting: '10.00' } } });
    h.initGrinderSync();
    await settle();
    for (const listener of h.workflowListeners) listener({ context: { grinderSetting: '12.00' } });
    await settle();
    assert.deepEqual(h.sent, ['12']);
});

test('runtime: turning Follow on takes the grinder\'s current reading, socket already open', async () => {
    const h = runtime({ info, workflow: { context: { grinderSetting: '10.00' } } });
    h.initGrinderSync();
    await settle();
    await h.snapshot({ state: 'idle', setting: '18' });
    assert.deepEqual(h.applied, []);
    h.setGrinderSync('follow', true);
    await settle();
    assert.equal(h.sockets.length, 2, 'the socket reopens, so Decaid replays the current snapshot');
    assert.equal(h.sockets[0].closed, true);
    await h.snapshot({ state: 'idle', setting: '18' });
    assert.deepEqual(h.applied, [['grinderSetting', 18]]);
});

test('runtime: a late answer from an older connection check does not undo a newer one', async () => {
    const h = runtime({ info: readOnlyGrinder });
    h.initGrinderSync();
    await settle();
    let answerDisconnect;
    const answers = [new Promise(resolve => { answerDisconnect = resolve; }), Promise.resolve(readOnlyGrinder)];
    h.nextInfo = () => answers.shift();
    const [listener] = h.connectionListeners;
    const disconnect = listener();
    await listener();
    answerDisconnect(null);
    await disconnect;
    await settle();
    assert.equal(h.socket().closed, false, 'the reconnected grinder keeps its socket');
    assert.equal(h.readings.includes(null), false, 'and its reading');
});
