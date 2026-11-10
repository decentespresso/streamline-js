import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceSetting, parseDeviceNumber, followDecision, canSendGrind, grinderSettingString, sendDecision, workflowGrindStep, workflowGrindRange, grindDecimals } from '../src/modules/grinder-sync.js';

const numeric = { kind: 'numeric', min: 0, max: 40, step: 0.5 };
const info = { capabilities: ['grindSetting'], controls: { grindSetting: numeric } };

test('deviceSetting: setting, else observedSetting, strings only', () => {
    assert.equal(deviceSetting({ setting: '200', observedSetting: '5' }), '200');
    assert.equal(deviceSetting({ observedSetting: '12.5' }), '12.5');
    assert.equal(deviceSetting({ state: 'idle' }), null);
    assert.equal(deviceSetting({ setting: 200 }), null);
    assert.equal(deviceSetting(null), null);
});

test('parseDeviceNumber: plain numbers only', () => {
    assert.equal(parseDeviceNumber('200'), 200);
    assert.equal(parseDeviceNumber(' 5.2 '), 5.2);
    assert.equal(parseDeviceNumber('espresso/A'), null);
    assert.equal(parseDeviceNumber('1e3'), null);
    assert.equal(parseDeviceNumber(''), null);
    assert.equal(parseDeviceNumber(7), null);
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
    const { grindStepFromInfo } = await import('../src/modules/grinder-sync.js');
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
