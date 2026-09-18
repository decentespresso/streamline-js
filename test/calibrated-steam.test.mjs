import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScaleSampleBuffer, createCalibratedSteamController, isCalibratedSteamAvailable } from '../src/modules/calibrated-steam.js';

test('sample buffer needs new weight frames and retires data on disconnect', () => {
    const buffer = createScaleSampleBuffer();
    buffer.push({ weight: 330, timestamp: 'a' }, 1000);
    buffer.push({ battery: 90 }, 1200);
    buffer.push({ weight: 330, timestamp: 'a' }, 1400);
    assert.equal(buffer.read(1500).length, 1);
    buffer.push({ weight: 330, timestamp: 'b' }, 1500);
    buffer.push({ weight: 330, timestamp: 'c' }, 1800);
    assert.deepEqual(buffer.read(1800).map(s => s.ageMs), [800, 300, 0]);
    buffer.clear();
    assert.deepEqual(buffer.read(1800), []);
});

test('sample buffer rejects invalid readings and expires old data', () => {
    const buffer = createScaleSampleBuffer();
    for (const weight of [null, NaN, Infinity, '330']) buffer.push({ weight }, 0);
    assert.deepEqual(buffer.read(0), []);
    buffer.push({ weight: 330 }, 1000);
    assert.deepEqual(buffer.read(5000), []);
    assert.deepEqual(buffer.read(900), []);
    assert.deepEqual(buffer.read(1000), []);
});

test('only the loaded compatible plugin activates Auto Calc', () => {
    const plugin = { id: 'calibrated-steam.reaplugin', loaded: true, api: [
        { id: 'status', type: 'http' },
        { id: 'calculate', type: 'http' },
    ] };
    assert.equal(isCalibratedSteamAvailable([plugin]), true);
    assert.equal(isCalibratedSteamAvailable([{ ...plugin, loaded: false }]), false);
    assert.equal(isCalibratedSteamAvailable(null), false);
    assert.equal(isCalibratedSteamAvailable([{ ...plugin, api: [] }]), false);
    assert.equal(isCalibratedSteamAvailable([{ ...plugin, api: [{ id: 'calculate', type: 'http' }] }]), false);
});

function harness() {
    let now = 1000;
    let result = { apiVersion: 5, durationSeconds: 30, milkGrams: 180, pitcher: 'small', calibrationRevision: 'v1',
        calibrationKey: 'one', targetTemperatureC: 60, targetLabel: '140.0 °F',
        workflowPatch: { steamSettings: { duration: 30, flow: 1.5 } } };
    let workflow = { id: 'one', profile: { title: 'A' }, steamSettings: { flow: 1.5, targetTemperature: 150, duration: 25, stopAtTemperature: 0 } };
    let state = 'idle';
    let failWrite = false;
    let failCalculation = false;
    const writes = [];
    const controller = createCalibratedSteamController({
        getContext: async () => ({ workflow, machine: { state: { state } } }),
        getSamples: () => [800, 400, 0].map(ageMs => ({ weightGrams: 330, ageMs })),
        calculate: async body => {
            if (failCalculation) throw new Error('Plugin disabled');
            if (body.machineState !== 'idle') throw new Error('Machine not idle');
            return structuredClone(result);
        },
        apply: async result => { if (failWrite) throw new Error('Write failed'); writes.push(result.durationSeconds); },
        now: () => now,
    });
    return { controller, writes, changeResult: value => result = { ...result, ...value },
        changeWorkflow: value => workflow = value, state: value => state = value,
        failWrite: () => failWrite = true, disable: () => failCalculation = true, time: value => now = value };
}

test('preview never writes; applying rechecks and returns the verified calculation', async () => {
    const h = harness();
    const preview = await h.controller.preview('auto', { calibrationKey: 'one', expectedFlow: 1.5 });
    assert.deepEqual(h.writes, []);
    await h.controller.apply(preview);
    assert.deepEqual(h.writes, [30]);
});

test('requested Auto flow is sent on both reads and a different returned flow cannot be applied', async () => {
    const requests = [], writes = [];
    let returnedFlow = 1.1;
    const controller = createCalibratedSteamController({
        getContext: async () => ({ workflow: { steamSettings: { stopAtTemperature: 0 } }, machine: { state: 'idle' } }),
        getSamples: () => [800, 400, 0].map(ageMs => ({ weightGrams: 350, ageMs })),
        calculate: async body => { requests.push(body); return { apiVersion: 5, pitcher: 'small', milkGrams: 200,
            durationSeconds: 20, calibrationRevision: 'one', calibrationKey: null, targetTemperatureC: 60,
            targetLabel: '140.0 °F', workflowPatch: { steamSettings: { flow: returnedFlow, duration: 20 } } }; },
        apply: async result => writes.push(result), now: () => 1000,
    });
    await controller.apply(await controller.preview('small', { flow: 1.1 }));
    assert.deepEqual(requests.map(r => r.flow), [1.1, 1.1]);
    assert.equal(writes.length, 1);
    returnedFlow = 0.4;
    await assert.rejects(controller.preview('small', { flow: 1.1 }), /invalid calculation/);
    assert.equal(writes.length, 1);
});

test('saved calibration key is sent on both reads and stale key results cannot be applied', async () => {
    const requests = [];
    let returnedKey = 'choice-a';
    const controller = createCalibratedSteamController({
        getContext: async () => ({ workflow: { steamSettings: { stopAtTemperature: 0 } }, machine: { state: 'idle' } }),
        getSamples: () => [800, 400, 0].map(ageMs => ({ weightGrams: 350, ageMs })),
        calculate: async body => {
            requests.push(body);
            return { apiVersion: 5, pitcher: 'small', milkGrams: 200, durationSeconds: 20,
                calibrationRevision: 'one', calibrationKey: returnedKey, targetTemperatureC: 60,
                targetLabel: '140.0 °F', workflowPatch: { steamSettings: { flow: 1.2, duration: 20 } } };
        },
        apply: async () => {},
        now: () => 1000,
    });
    await controller.apply(await controller.preview('small', { calibrationKey: 'choice-a', expectedFlow: 1.2 }));
    assert.deepEqual(requests.map(request => request.calibrationKey), ['choice-a', 'choice-a']);
    assert.equal(requests.some(request => Object.hasOwn(request, 'flow')), false);
    returnedKey = 'choice-b';
    await assert.rejects(controller.preview('small', { calibrationKey: 'choice-a', expectedFlow: 1.2 }), /invalid calculation/);
});

test('changed scale, pitcher, settings, workflow or machine state prevents an old preview applying', async () => {
    for (const change of [h => h.changeResult({ milkGrams: 190 }), h => h.changeResult({ pitcher: 'medium' }),
        h => h.changeResult({ calibrationRevision: 'v2' }), h => h.state('steam'),
        h => h.changeWorkflow({ id: 'two', steamSettings: {} }), h => h.disable(), h => h.time(20000)]) {
        const h = harness();
        const preview = await h.controller.preview('auto', { calibrationKey: 'one', expectedFlow: 1.5 });
        change(h);
        await assert.rejects(h.controller.apply(preview));
        assert.deepEqual(h.writes, []);
    }
});

test('failed writes propagate and cannot be reported as success', async () => {
    const h = harness();
    const preview = await h.controller.preview('auto', { calibrationKey: 'one', expectedFlow: 1.5 });
    h.failWrite();
    await assert.rejects(h.controller.apply(preview), /Write failed/);
});

test('cancelling a preview while context is loading prevents stale work', async () => {
    let resolveContext;
    const controller = createCalibratedSteamController({
        getContext: () => new Promise(resolve => { resolveContext = resolve; }),
        getSamples: () => [], calculate: async () => assert.fail('cancelled'), apply: async () => assert.fail('cancelled'),
    });
    const pending = controller.preview();
    controller.cancel();
    resolveContext({ workflow: {}, machine: {} });
    await assert.rejects(pending, /cancelled/i);
});

test('a slow calculation response cannot revive expired observations', async () => {
    let clock = 1000;
    const controller = createCalibratedSteamController({
        getContext: async () => ({ workflow: {}, machine: {} }),
        getSamples: () => [800, 400, 0].map(ageMs => ({ weightGrams: 330, ageMs })),
        calculate: async () => { clock = 2600; return { durationSeconds: 30, milkGrams: 180 }; },
        apply: async () => assert.fail('expired'), now: () => clock,
    });
    await assert.rejects(controller.preview('auto', { flow: 1 }), /expired/i);
});


test('a mismatched calculator contract is rejected before applying', async () => {
    const h = harness();
    h.changeResult({ apiVersion: 3 });
    await assert.rejects(h.controller.preview('small', { calibrationKey: 'one', expectedFlow: 1.5 }), /invalid calculation/);
    assert.deepEqual(h.writes, []);
});

test('out-of-range plugin flow is rejected before any machine write', async () => {
    for (const flow of [0.39, 2.51]) {
        const h = harness();
        h.changeResult({ workflowPatch: { steamSettings: { duration: 30, flow } } });
        await assert.rejects(h.controller.preview('small', { calibrationKey: 'one', expectedFlow: 1.5 }), /invalid calculation/);
        assert.deepEqual(h.writes, []);
    }
});
