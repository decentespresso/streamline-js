import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { autoSteamPitcherLabel, steamAdjustmentControls } from '../src/modules/auto-steam-flow.js';

// Exercise the actual render/state functions without importing the browser app.
const source = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
const display = source.match(/^function updateSteamPresetDisplay\(\) \{[\s\S]*?^\}/m)[0];
const machine = source.match(/^export function updateSleepButton\(state\) \{[\s\S]*?^\}/m)[0].replace('export ', '');
const sidebar = source.slice(source.indexOf('const SIDEBAR_GROUPS ='), source.indexOf('export function updateGhcStopButton')).replaceAll('export ', '');

function element(pitcher) {
    const classes = new Set();
    return {
        dataset: { autoPitcher: pitcher }, style: {}, attributes: {},
        classList: {
            add(name) { classes.add(name); },
            toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
            contains(name) { return classes.has(name); },
        },
        setAttribute(name, value) { this.attributes[name] = value; },
    };
}

function fixture() {
    const ids = ['steam-section', 'steam-presets', 'steam-flow-presets', 'steam-auto-presets'];
    const elements = Object.fromEntries(ids.map(id => [id, element()]));
    const buttons = ['small', 'medium', 'large', 'auto'].map(element);
    const context = vm.createContext({
        document: {
            getElementById: id => elements[id] || null,
            querySelectorAll: () => buttons,
        },
        steamMode: 'auto', currentMachineState: null,
        calibratedSteam: { observeMachine() {} },
        calibratedSteamPitcher: 'medium',
        calibratedSteamPitchers: ['small', 'medium', 'large', 'auto'],
        calibratedSteamApplying: false, calibratedSteamConfigured: true,
        calibratedSteamState: { adjustmentKind: 'calibration', targetLabel: '140 °F' },
        announceAutoSteamChange() {}, autoSteamPitcherLabel, steamAdjustmentControls,
        getTranslation: value => value,
    });
    vm.runInContext(`${display}\n${machine}\n${sidebar}`, context);
    return {
        context, elements, buttons,
        transition(state) {
            context.updateSleepButton(state);
            context.updateSidebarOverlay(state);
        },
    };
}

test('espresso dims and locks Auto Steam presets, then idle restores the selected pitcher', () => {
    const ui = fixture();
    ui.transition('idle');
    const labels = ui.buttons.map(button => button.textContent);
    assert.ok(ui.buttons.every(button => !button.disabled));

    ui.transition('espresso');
    for (const id of ['steam-section', 'steam-auto-presets']) {
        assert.equal(ui.elements[id].style.opacity, '0.25');
        assert.equal(ui.elements[id].style.pointerEvents, 'none');
    }
    assert.ok(ui.buttons.every(button => button.disabled));
    assert.equal(ui.buttons[1].attributes['aria-pressed'], 'true');

    ui.transition('idle');
    assert.equal(ui.elements['steam-auto-presets'].style.opacity, '');
    assert.equal(ui.elements['steam-auto-presets'].style.pointerEvents, '');
    assert.ok(ui.buttons.every(button => !button.disabled));
    assert.deepEqual(ui.buttons.map(button => button.textContent), labels);
    assert.equal(ui.buttons[1].classList.contains('preset-active'), true);
});

test('pitcher selection requires idle, including when the steam group remains visible', () => {
    for (const state of ['steam', 'steamRinse', 'flush', 'hotWater', 'sleeping', 'unknown', null]) {
        const ui = fixture();
        ui.transition('idle');
        ui.transition(state);
        assert.ok(ui.buttons.every(button => button.disabled), String(state));
        if (state === 'steam' || state === 'steamRinse') {
            assert.equal(ui.elements['steam-auto-presets'].style.opacity, '');
        }
    }
});

test('returning to idle preserves busy and configuration restrictions', () => {
    for (const restriction of ['busy', 'unconfigured']) {
        const ui = fixture();
        ui.transition('espresso');
        ui.context.calibratedSteamApplying = restriction === 'busy';
        ui.context.calibratedSteamConfigured = restriction !== 'unconfigured';
        ui.transition('idle');
        assert.ok(ui.buttons.every(button => button.disabled), restriction);
        ui.context.calibratedSteamApplying = false;
        ui.context.calibratedSteamConfigured = true;
        ui.context.updateSteamPresetDisplay();
        assert.ok(ui.buttons.every(button => !button.disabled));
    }
});
