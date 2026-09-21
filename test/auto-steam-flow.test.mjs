import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSteamDurationLabel, autoSteamPitcherLabel, autoSteamSelectionSettings, compactAutoSteamTargetLabel,
    shouldKeepAutoSteamMode, steamAdjustmentControls } from '../src/modules/auto-steam-flow.js';

const saved = () => ({
    mode: 'saved',
    adjustable: true,
    defaultCalibrationKey: '0.800@60.000',
    choices: [
        { key: '0.800@60.000', flow: 0.8, targetTemperatureC: 60, targetLabel: '140.0 °F' },
        { key: '1.200@65.000', flow: 1.2, targetTemperatureC: 65, targetLabel: '149.0 °F' },
    ],
});

test('saved calibration choices are validated as opaque selectable capabilities', () => {
    assert.deepEqual(autoSteamSelectionSettings({ flowCalibration: saved() }), {
        kind: 'calibration',
        adjustable: true,
        defaultCalibrationKey: '0.800@60.000',
        choices: saved().choices,
    });
    for (const patch of [
        { choices: [] },
        { defaultCalibrationKey: 'missing' },
        { adjustable: false },
        { choices: [{ ...saved().choices[0], flow: 3 }] },
        { choices: [{ ...saved().choices[0], targetTemperatureC: 0 }] },
        { choices: [{ ...saved().choices[0], targetLabel: '' }] },
    ]) {
        assert.equal(autoSteamSelectionSettings({ flowCalibration: { ...saved(), ...patch } }), null);
    }
});

test('one saved calibration hides adjustment glyphs while two choices wrap in both directions', () => {
    const one = saved();
    one.adjustable = false;
    one.choices = [one.choices[0]];
    assert.equal(autoSteamSelectionSettings({ flowCalibration: one }).adjustable, false);
    assert.equal(steamAdjustmentControls('auto', { adjustableSelection: false, adjustmentKind: 'calibration' }, 'idle').visible, false);
    const state = { adjustableSelection: true, adjustmentKind: 'calibration', configurationReady: true, busy: false };
    assert.deepEqual(steamAdjustmentControls('auto', state, 'idle'), { visible: true, minusDisabled: false, plusDisabled: false });
    assert.equal(steamAdjustmentControls('auto', state, 'steam').plusDisabled, true);
});

test('interpolation keeps 0.1 ml/s controls and measured bounds', () => {
    const flowCalibration = { adjustable: true, mode: 'interpolate', minimum: 0.4, maximum: 2.5, defaultFlow: 0.8, step: 0.1 };
    assert.deepEqual(autoSteamSelectionSettings({ flowCalibration }), {
        kind: 'flow', adjustable: true, minimum: 0.4, maximum: 2.5, defaultFlow: 0.8, step: 0.1,
    });
    for (const patch of [{ minimum: 0.3 }, { maximum: 2.6 }, { minimum: 2.5 }, { defaultFlow: 3 }, { step: 0.2 }]) {
        assert.equal(autoSteamSelectionSettings({ flowCalibration: { ...flowCalibration, ...patch } }), null);
    }
    const state = { adjustableSelection: true, adjustmentKind: 'flow', flow: 0.4, minimumFlow: 0.4, maximumFlow: 2.5, configurationReady: true, busy: false };
    assert.deepEqual(steamAdjustmentControls('auto', state, 'idle'), { visible: true, minusDisabled: true, plusDisabled: false });
    assert.equal(steamAdjustmentControls('auto', { ...state, flow: 2.5 }, 'idle').plusDisabled, true);
});

test('manual steam modes retain their normal controls', () => {
    for (const mode of ['flow', 'time', 'temperature']) {
        assert.deepEqual(steamAdjustmentControls(mode, { busy: false }, 'idle'),
            { visible: true, minusDisabled: false, plusDisabled: false });
    }
});

test('Auto shows truthful timer state except during the brief target preview', () => {
    assert.equal(autoSteamDurationLabel(0), '0s');
    assert.equal(autoSteamDurationLabel(30), '30s');
    assert.equal(autoSteamDurationLabel(0, '140.0 °F'), '140°F');
    assert.equal(compactAutoSteamTargetLabel('140.5 °F'), '140.5°F');
});

test('only the selected pitcher carries the compact target label', () => {
    assert.equal(autoSteamPitcherLabel('small', 'medium', '140.0 °F'), 'S');
    assert.equal(autoSteamPitcherLabel('medium', 'medium', '140.0 °F'), 'M · 140°F');
    assert.equal(autoSteamPitcherLabel('auto', 'auto', '60.0 °C'), 'Auto · 60°C');
});

test('expected calculation rejections stay in Auto while operational failures fall back', () => {
    assert.equal(shouldKeepAutoSteamMode({ status: 422, endpoint: 'calculate', code: 'invalid_milk_weight' }), true);
    assert.equal(shouldKeepAutoSteamMode({ status: 422, endpoint: 'status' }), false);
    assert.equal(shouldKeepAutoSteamMode({ status: 500, endpoint: 'calculate' }), false);
    assert.equal(shouldKeepAutoSteamMode(new Error('timeout')), false);
});
