import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoSteamSession } from '../src/modules/auto-steam-session.js';

const exactCalibration = (flow = 0.8, key = `${flow.toFixed(3)}@60.000`, label = '140.0 °F') => ({
    mode: 'saved',
    adjustable: false,
    defaultCalibrationKey: key,
    choices: [{ key, flow, targetTemperatureC: 60, targetLabel: label }],
});

const exactStatus = ({ flow = 0.8, pitchers = ['small', 'medium', 'large', 'auto'], ready = true, calibrationActive = false } = {}) => ({
    apiVersion: 5,
    ready,
    calibrationActive,
    availablePitchers: pitchers,
    settings: {},
    flowCalibration: exactCalibration(flow),
});

function harness(saved = null, initialHeater = 150, rememberedHeater = null) {
    let machine = 'idle';
    let workflow = { steamSettings: { duration: 45, flow: 0.6, targetTemperature: initialHeater, stopAtTemperature: 0 } };
    let fail = false;
    let status = exactStatus();
    const writes = [];
    let stored = saved;
    const session = createAutoSteamSession({
        saved,
        getContext: async () => ({ workflow: structuredClone(workflow), machine: { state: machine }, calibrationActive: status.calibrationActive }),
        getStatus: async () => status,
        getHeaterTemperature: async () => rememberedHeater,
        write: async steam => { writes.push(structuredClone(steam)); workflow.steamSettings = { ...workflow.steamSettings, ...steam }; },
        calculate: async (pitcher, selection) => {
            if (fail) throw new Error('Unstable scale');
            const selectedFlow = selection.flow ?? selection.expectedFlow;
            return { pitcher, milkGrams: 180, durationSeconds: 30, calibrationKey: selection.calibrationKey ?? null,
                workflowPatch: { steamSettings: { duration: 30, flow: selectedFlow } } };
        },
        persist: value => { stored = structuredClone(value); },
        onChange: () => {},
    });
    return { session, writes, workflow: () => structuredClone(workflow), status: value => { status = value; }, stored: () => stored, machine: value => { machine = value; return session.observeMachine(value); }, fail: () => fail = true };
}

test('Auto enters Off at calibration flow, remembers manual settings and restores them on exit', async () => {
    const h = harness();
    await h.session.enter();
    assert.deepEqual(h.writes[0], { duration: 0, stopAtTemperature: 0, flow: 0.8 });
    assert.equal(h.workflow().steamSettings.targetTemperature, 150);
    assert.equal(h.stored().active, true);
    await h.session.leave();
    assert.deepEqual(h.writes.at(-1), { duration: 45, flow: 0.6, targetTemperature: 150, stopAtTemperature: 0 });
    assert.equal(h.stored().active, false);
});

const multiStatus = () => ({ apiVersion: 5, ready: true, availablePitchers: ['small', 'medium'],
    settings: {},
    flowCalibration: { mode: 'interpolate', adjustable: true, minimum: 0.4, maximum: 2.5, defaultFlow: 0.8, step: 0.1 } });

test('multiple Auto flow changes write Off at the selected flow and require a new pitcher calculation', async () => {
    const h = harness(); h.status(multiStatus());
    await h.session.enter(); await h.session.select('small');
    await h.session.adjustSelection(0.1);
    assert.equal(h.writes.at(-1).flow, 0.9);
    assert.equal(h.writes.at(-1).duration, 0);
    assert.equal(h.session.snapshot().ready, false);
    await h.session.select('small');
    assert.equal(h.writes.at(-1).flow, 0.9);
    assert.equal(h.writes.at(-1).duration, 30);
    assert.equal(h.session.snapshot().ready, true);
    await h.session.invalidate();
    assert.equal(h.writes.at(-1).flow, 0.9);
    await h.session.leave();
    assert.equal(h.writes.at(-1).flow, 0.6);
    assert.equal(h.writes.at(-1).duration, 45);
});

test('Auto adjustments are bounded, fixed calibrations cannot change, and busy machines refuse writes', async () => {
    const h = harness(); await h.session.enter();
    await assert.rejects(h.session.adjustSelection(0.1), /more than one/);
    h.status(multiStatus());
    await h.session.adjustSelection(10); assert.equal(h.session.snapshot().flow, 2.5);
    await h.session.adjustSelection(-10); assert.equal(h.session.snapshot().flow, 0.4);
    await h.machine('steam'); const count = h.writes.length;
    await assert.rejects(h.session.adjustSelection(0.1), /idle/);
    assert.equal(h.writes.length, count);
});

test('selected interpolation flow survives reload and a compatible settings refresh', async () => {
    const h = harness(); h.status(multiStatus()); await h.session.enter(); await h.session.adjustSelection(0.2);
    const resumed = harness(h.stored()); resumed.status(multiStatus()); await resumed.session.enter();
    assert.equal(resumed.writes.at(-1).flow, 1);
    const status = multiStatus(); status.settings.temperatureUnit = 'C'; status.flowCalibration.defaultFlow = 1.5;
    resumed.status(status); resumed.session.updateStatus(status); await resumed.session.invalidate({ verify: true });
    assert.equal(resumed.writes.at(-1).flow, 1);
});

test('saved calibrations cycle, wrap and retain the last opaque key across reloads', async () => {
    const choices = [
        { key: 'first', flow: 0.8, targetTemperatureC: 55, targetLabel: '131.0 °F' },
        { key: 'second', flow: 1.2, targetTemperatureC: 60, targetLabel: '140.0 °F' },
        { key: 'third', flow: 1.6, targetTemperatureC: 65, targetLabel: '149.0 °F' },
    ];
    const status = { apiVersion: 5, ready: true, availablePitchers: ['small'], settings: {},
        flowCalibration: { mode: 'saved', adjustable: true, defaultCalibrationKey: 'first', choices } };
    const h = harness(); h.status(status); await h.session.enter();
    assert.equal(h.session.snapshot().calibrationKey, 'first');
    assert.equal(h.session.snapshot().targetLabel, '131.0 °F');
    await h.session.adjustSelection(-1);
    assert.equal(h.session.snapshot().calibrationKey, 'third');
    assert.equal(h.writes.at(-1).flow, 1.6);
    await h.session.adjustSelection(1);
    assert.equal(h.session.snapshot().calibrationKey, 'first');
    await h.session.adjustSelection(1);
    const resumed = harness(h.stored()); resumed.status(status); await resumed.session.enter();
    assert.equal(resumed.session.snapshot().calibrationKey, 'second');
    assert.equal(resumed.writes.at(-1).flow, 1.2);
});

test('each preset tap calculates even when already selected, and a failed calculation remains Off', async () => {
    const h = harness();
    await h.session.enter();
    await h.session.select('medium');
    await h.session.select('medium');
    assert.equal(h.writes.filter(w => w.duration === 30).length, 2);
    assert.equal(h.stored().pitcher, 'medium');
    h.fail();
    await assert.rejects(h.session.select('medium'), /Unstable/);
    assert.equal(h.writes.at(-1).duration, 0);
    assert.equal(h.session.snapshot().ready, false);
});

test('completed steam resets Off only after the machine becomes idle', async () => {
    const h = harness();
    await h.session.enter();
    await h.session.select('small');
    const before = h.writes.length;
    await h.machine('steam');
    await h.machine('flush');
    assert.equal(h.writes.length, before);
    await h.machine('idle');
    assert.equal(h.writes.at(-1).duration, 0);
    assert.equal(Object.hasOwn(h.writes.at(-1), 'targetTemperature'), false);
    assert.equal(h.workflow().steamSettings.targetTemperature, 150);
    await h.machine('idle');
    assert.equal(h.writes.length, before + 1);
});

test('resuming Auto after reload retains the backup and resets the timer', async () => {
    const h = harness({ active: true, pitcher: 'large', manual: { duration: 60, flow: 0.5, targetTemperature: 145, stopAtTemperature: 0 } });
    await h.session.enter();
    assert.equal(h.session.snapshot().pitcher, 'large');
    assert.equal(h.writes.at(-1).duration, 0);
    await h.session.leave();
    assert.equal(h.writes.at(-1).duration, 60);
});

test('busy machines reject mode changes and calculations without writes', async () => {
    const h = harness();
    await h.machine('steam');
    await assert.rejects(h.session.enter(), /idle/);
    assert.deepEqual(h.writes, []);
});

test('disabling during steam defers restoration until idle', async () => {
    const h = harness();
    await h.session.enter();
    await h.session.select('small');
    await h.machine('steam');
    const before = h.writes.length;
    await h.session.disable();
    assert.equal(h.writes.length, before);
    await h.machine('idle');
    assert.equal(h.session.snapshot().active, false);
    assert.equal(h.writes.at(-1).flow, 0.6);
});

test('session serializes repeated taps while a setting write is pending', async () => {
    let release;
    const session = createAutoSteamSession({
        getContext: async () => ({ machine: { state: 'idle' }, workflow: { steamSettings: { duration: 45, flow: 0.6, targetTemperature: 150 } } }),
        getStatus: async () => exactStatus(),
        write: () => new Promise(resolve => { release = resolve; }),
        calculate: async () => assert.fail('not yet entered'), persist: () => {}, onChange: () => {},
    });
    const entering = session.enter();
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(session.enter(), /Wait/);
    await assert.rejects(session.select('small'), /Wait/);
    release();
    await entering;
});

test('settings refresh resets an armed timer and preserves the selected pitcher', async () => {
    const h = harness();
    await h.session.enter();
    await h.session.select('large');
    await h.session.invalidate();
    assert.equal(h.writes.at(-1).duration, 0);
    assert.equal(h.stored().pitcher, 'large');
});


test('unconfigured Auto stays Off and exposes no pitcher presets', async () => {
    const h = harness();
    h.status(exactStatus({ ready: false, pitchers: [] }));
    await h.session.enter();
    assert.equal(h.writes.at(-1).duration, 0);
    assert.equal(h.session.snapshot().configurationReady, false);
    assert.deepEqual(h.session.snapshot().availablePitchers, []);
    await assert.rejects(h.session.select('small'), /calibration/);
    assert.equal(h.writes.at(-1).duration, 0);
    await h.session.leave();
    assert.equal(h.writes.at(-1).duration, 45);
});

test('removed saved pitcher falls back to configured default and cannot be calculated', async () => {
    const h = harness({ pitcher: 'auto' });
    const status = exactStatus({ pitchers: ['medium'] });
    status.settings.defaultPitcher = 'medium';
    h.status(status);
    await h.session.enter();
    assert.equal(h.session.snapshot().pitcher, 'medium');
    assert.deepEqual(h.session.snapshot().availablePitchers, ['medium']);
    await assert.rejects(h.session.select('auto'), /configured pitcher/);
    assert.equal(h.writes.at(-1).duration, 0);
    await h.session.select('medium');
    assert.equal(h.writes.at(-1).duration, 30);
});


test('Auto keeps the normal heater hot while waiting and calculating', async () => {
    for (const temperature of [135, 145, 160]) {
        const h = harness(null, temperature);
        await h.session.enter();
        assert.equal(Object.hasOwn(h.writes.at(-1), 'targetTemperature'), false);
        assert.equal(h.workflow().steamSettings.targetTemperature, temperature);
        await h.session.select('small');
        assert.equal(h.writes.at(-1).targetTemperature, temperature);
        assert.equal(h.writes.at(-1).duration, 30);
    }
});

test('entering from manual Off uses the normal remembered heater and preserves manual Off on exit', async () => {
    const h = harness(null, 0, 145);
    await h.session.enter();
    await h.session.select('small');
    assert.equal(h.writes.at(-1).targetTemperature, 145);
    await h.session.leave();
    assert.equal(h.writes.at(-1).targetTemperature, 0);
});

test('missing normal heater setting never invents one or arms the timer', async () => {
    const h = harness(null, 0);
    await h.session.enter();
    await assert.rejects(h.session.select('small'), /normal Steam settings/);
    assert.equal(h.writes.at(-1).duration, 0);
    assert.equal(Object.hasOwn(h.writes.at(-1), 'targetTemperature'), false);
    assert.equal(h.workflow().steamSettings.targetTemperature, 0);
});


test('guided calibration blocks Auto entry, recalculation, reset and manual restoration', async () => {
    const h = harness();
    await h.session.enter();
    h.status(exactStatus({ calibrationActive: true, pitchers: ['small'] }));
    const before = h.writes.length;
    for (const action of [() => h.session.enter(), () => h.session.select('small'), () => h.session.leave()]) {
        await assert.rejects(action(), /guided calibration/);
    }
    await h.session.invalidate({ verify: true });
    assert.equal(h.writes.length, before);
});

test('repeated navigation while already Off performs no additional reads or writes', async () => {
    let reads = 0;
    let steam = { duration: 30, flow: 1, targetTemperature: 145, stopAtTemperature: 0 };
    const writes = [];
    const session = createAutoSteamSession({ getContext: async () => { reads++; return { machine: { state: 'idle' }, workflow: { steamSettings: steam } }; },
        getStatus: async () => exactStatus({ flow: 0.4, pitchers: ['small'] }),
        write: async value => { steam = value; writes.push(value); }, calculate: async () => {}, persist() {}, onChange() {} });
    await session.enter(); const before = reads;
    await Promise.all(Array.from({ length: 12 }, () => session.invalidate()));
    assert.equal(reads, before); assert.equal(writes.length, 1);
});

test('idle telemetry racing a navigation reset shares one operation', async () => {
    const h = harness(); await h.session.enter(); await h.session.select('small');
    const before = h.writes.length;
    await Promise.all([h.session.invalidate(), h.machine('idle'), h.session.invalidate(), h.machine('idle')]);
    assert.equal(h.writes.length, before + 1);
    assert.equal(h.writes.at(-1).duration, 0);
});

test('revalidation reads live settings but skips a redundant Off write', async () => {
    const h = harness(); await h.session.enter(); const before = h.writes.length;
    await h.session.invalidate({ verify: true });
    assert.equal(h.writes.length, before);
    h.status(exactStatus({ flow: 1.2, pitchers: ['small'] }));
    await h.session.invalidate({ verify: true });
    assert.equal(h.writes.at(-1).flow, 1.2);
    assert.equal(h.writes.length, before + 1);
});

test('navigation during a slow calculation cancels arming without a contention error', async () => {
    let release;
    let steam = { duration: 30, flow: 1, targetTemperature: 145, stopAtTemperature: 0 };
    const writes = [];
    const session = createAutoSteamSession({ getContext: async () => ({ machine: { state: 'idle' }, workflow: { steamSettings: steam } }),
        getStatus: async () => exactStatus({ flow: 0.4, pitchers: ['small'] }),
        write: async value => { steam = value; writes.push(value); },
        calculate: async () => { await new Promise(resolve => { release = resolve; }); return { workflowPatch: { steamSettings: { duration: 20, flow: 0.4 } } }; }, persist() {}, onChange() {} });
    await session.enter(); const selecting = session.select('small');
    await new Promise(resolve => setImmediate(resolve));
    const resetting = session.invalidate(); release();
    assert.equal(await selecting, null); await resetting;
    assert.equal(writes.some(value => value.duration === 20), false);
    assert.equal(steam.duration, 0);
});

test('a failed background reset is reported once and is not retried on each navigation', async () => {
    let failing = false, writes = 0;
    let steam = { duration: 30, flow: 1, targetTemperature: 145, stopAtTemperature: 0 };
    const session = createAutoSteamSession({ getContext: async () => ({ machine: { state: 'idle' }, workflow: { steamSettings: steam } }),
        getStatus: async () => exactStatus({ flow: 0.4, pitchers: ['small'] }),
        write: async value => { writes++; if (failing) throw new Error('Machine write failed'); steam = value; },
        calculate: async () => ({ workflowPatch: { steamSettings: { duration: 20, flow: 0.4 } } }), persist() {}, onChange() {} });
    await session.enter(); await session.select('small'); failing = true;
    await assert.rejects(session.invalidate(), /Machine write failed/); const before = writes;
    await session.invalidate(); await session.observeMachine('idle'); await session.invalidate();
    assert.equal(writes, before);
    failing = false; await session.invalidate({ verify: true }); assert.equal(steam.duration, 0);
});

test('a pending Off reset survives rapid navigation and coalesces further requests', async () => {
    let release, delay = false;
    let steam = { duration: 30, flow: 1, targetTemperature: 145, stopAtTemperature: 0 };
    const writes = [];
    const session = createAutoSteamSession({ getContext: async () => ({ machine: { state: 'idle' }, workflow: { steamSettings: steam } }),
        getStatus: async () => exactStatus({ flow: 0.4, pitchers: ['small'] }),
        write: async value => { writes.push(value); if (delay) await new Promise(resolve => { release = resolve; }); steam = value; },
        calculate: async () => ({ workflowPatch: { steamSettings: { duration: 20, flow: 0.4 } } }), persist() {}, onChange() {} });
    await session.enter(); await session.select('small'); delay = true;
    const first = session.invalidate(); await new Promise(resolve => setImmediate(resolve));
    const second = session.invalidate(); const idle = session.observeMachine('idle');
    delay = false; release(); await Promise.all([first, second, idle]);
    assert.equal(writes.filter(value => value.duration === 0).length, 2);
    assert.equal(steam.duration, 0);
});

test('plugin loss restores manual settings without calling the missing plugin', async () => {
    let steam = { duration: 0, flow: 0.8, targetTemperature: 0, stopAtTemperature: 0 };
    const writes = [];
    const session = createAutoSteamSession({
        saved: { active: true, pitcher: 'small', manual: { duration: 45, flow: 0.6, targetTemperature: 150, stopAtTemperature: 0 } },
        getContext: async () => { throw new Error('Plugin unavailable'); },
        getRestoreContext: async () => ({ machine: { state: 'idle' }, workflow: { steamSettings: steam } }),
        getStatus: async () => { throw new Error('Plugin unavailable'); },
        write: async value => { steam = value; writes.push(value); },
        calculate: async () => assert.fail('calculation should not run'),
        persist() {},
        onChange() {},
    });
    await session.disable();
    assert.equal(session.snapshot().active, false);
    assert.deepEqual(writes, [{ duration: 45, flow: 0.6, targetTemperature: 150, stopAtTemperature: 0 }]);
});
