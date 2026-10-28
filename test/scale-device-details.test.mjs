import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createScaleInfoLifecycle,
    getScaleDeviceSetting,
    hasSkaleUsbSetting,
    shouldInvalidateScaleInfoAfterWrite,
} from '../src/settings/scale-device-details.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function lifecycle(options = {}) {
    const deviceState = options.deviceState || { devices: [{ id: 'A', state: 'connected' }] };
    return createScaleInfoLifecycle({
        getDeviceState: () => deviceState,
        logger: { warn() {} },
        ...options,
    });
}

test('per-device USB settings ignore the legacy global key', () => {
    assert.equal(getScaleDeviceSetting({ skalePoweredByUsbByDevice: { A: true } }, 'skalePoweredByUsbByDevice', 'A'), true);
    assert.equal(getScaleDeviceSetting({ skalePoweredByUsbByDevice: { A: true } }, 'skalePoweredByUsbByDevice', 'B'), false);
    assert.equal(getScaleDeviceSetting({ skalePoweredByUsb: true }, 'skalePoweredByUsbByDevice', 'A'), undefined);
});

test('USB controls are limited to supported Skale devices and map shapes', () => {
    assert.equal(hasSkaleUsbSetting({ skalePoweredByUsbByDevice: {} }, { name: 'Skale 2' }), true);
    assert.equal(hasSkaleUsbSetting({ skalePoweredByUsbByDevice: {} }, { name: 'Acaia Lunar' }), false);
    assert.equal(hasSkaleUsbSetting({ skalePoweredByUsbByDevice: [] }, { name: 'Skale 2' }), false);
    assert.equal(hasSkaleUsbSetting({ skalePoweredByUsb: true }, { name: 'Skale 2' }), false);
});

test('only a successful REA USB write invalidates metadata', () => {
    assert.equal(shouldInvalidateScaleInfoAfterWrite({ reaSucceeded: true, usbPowerSettingsChanged: true }), true);
    assert.equal(shouldInvalidateScaleInfoAfterWrite({ reaSucceeded: false, usbPowerSettingsChanged: true }), false);
    assert.equal(shouldInvalidateScaleInfoAfterWrite({ reaSucceeded: true, usbPowerSettingsChanged: false }), false);
});

test('repeated renders share one in-flight scale-info request', async () => {
    const pending = deferred();
    let calls = 0;
    const info = lifecycle({ getScaleInfo: () => { calls += 1; return pending.promise; } });
    const first = info.refreshScaleInfo('A');
    const second = info.refreshScaleInfo('A');
    assert.equal(calls, 1);
    pending.resolve({ firmwareVersion: 'R029' });
    await Promise.all([first, second]);
    assert.deepEqual(info.scaleInfoByDeviceId.get('A'), { firmwareVersion: 'R029' });
});

test('device identity and generation fence stale A to B to A responses', async () => {
    const requests = [];
    const deviceState = { devices: [{ id: 'A', state: 'connected' }] };
    const info = lifecycle({ deviceState, getScaleInfo: () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
    } });
    const firstA = info.refreshScaleInfo('A');
    deviceState.devices = [{ id: 'B', state: 'connected' }];
    const b = info.refreshScaleInfo('B');
    deviceState.devices = [{ id: 'A', state: 'connected' }];
    const secondA = info.refreshScaleInfo('A');
    requests[0].resolve({ firmwareVersion: 'stale-A' });
    requests[1].resolve({ firmwareVersion: 'stale-B' });
    await Promise.all([firstA, b]);
    assert.equal(info.scaleInfoByDeviceId.has('A'), false);
    assert.equal(info.scaleInfoByDeviceId.has('B'), false);
    requests[2].resolve({ firmwareVersion: 'fresh-A' });
    await secondA;
    assert.deepEqual(info.scaleInfoByDeviceId.get('A'), { firmwareVersion: 'fresh-A' });
});

test('disconnect clears metadata and never starts a request', async () => {
    let calls = 0;
    const info = lifecycle({ getScaleInfo: async () => { calls += 1; return {}; } });
    await info.refreshScaleInfo(null);
    assert.equal(calls, 0);
    assert.equal(info.scaleInfoByDeviceId.size, 0);
});

test('unmounted settings list does not fetch scale info', async () => {
    let calls = 0;
    const info = lifecycle({ isMounted: () => false, getScaleInfo: async () => { calls += 1; return {}; } });
    await info.refreshScaleInfo('A');
    assert.equal(calls, 0);
});

test('all failures are cached and retried only after 30 seconds', async () => {
    let calls = 0;
    let now = 1000;
    const info = lifecycle({
        now: () => now,
        getScaleInfo: async () => {
            calls += 1;
            throw Object.assign(new Error('offline'), { status: 500 });
        },
    });
    await info.refreshScaleInfo('A');
    await info.refreshScaleInfo('A');
    assert.equal(calls, 1);
    now += 29_999;
    await info.refreshScaleInfo('A');
    assert.equal(calls, 1);
    now += 1;
    await info.refreshScaleInfo('A');
    assert.equal(calls, 2);
    assert.deepEqual(info.scaleInfoByDeviceId.get('A'), {});
});

test('unsupported endpoint failures remain unknown without warning spam', async () => {
    let warnings = 0;
    const info = lifecycle({
        logger: { warn() { warnings += 1; } },
        getScaleInfo: async () => { throw Object.assign(new Error('not found'), { status: 404 }); },
    });
    await info.refreshScaleInfo('A');
    await info.refreshScaleInfo('A');
    assert.deepEqual(info.scaleInfoByDeviceId.get('A'), {});
    assert.equal(warnings, 0);
});

test('a successful write invalidates stale metadata and in-flight state', async () => {
    const info = lifecycle({ getScaleInfo: () => new Promise(() => {}) });
    info.scaleInfoByDeviceId.set('A', { firmwareVersion: 'stale' });
    info.scaleInfoInFlight.set('A', Promise.resolve());
    const before = info.generation;
    info.invalidate();
    assert.equal(info.generation, before + 1);
    assert.equal(info.scaleInfoByDeviceId.size, 0);
    assert.equal(info.scaleInfoInFlight.size, 0);
});

test('accepted metadata rerenders only after the response still matches the connected device', async () => {
    let renders = 0;
    const info = lifecycle({
        renderDeviceListFromCache: () => { renders += 1; },
        getScaleInfo: async () => ({ firmwareVersion: 'R029', batteryLevel: 77 }),
    });
    await info.refreshScaleInfo('A');
    assert.equal(renders, 1);
    assert.deepEqual(info.scaleInfoByDeviceId.get('A'), { firmwareVersion: 'R029', batteryLevel: 77 });
});
