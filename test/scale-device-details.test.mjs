import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
    new URL('../src/settings/settings.js', import.meta.url),
    'utf8',
);

function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} was not found`);
    let depth = 0;
    let bodyStarted = false;
    for (let index = source.indexOf('{', start); index < source.length; index += 1) {
        if (source[index] === '{') {
            depth += 1;
            bodyStarted = true;
        } else if (source[index] === '}') {
            depth -= 1;
            if (bodyStarted && depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(`Could not extract ${name}`);
}

function extractAssignedFunction(name) {
    const start = source.indexOf(`window.${name} = function(`);
    assert.notEqual(start, -1, `${name} was not found`);
    let depth = 0;
    let bodyStarted = false;
    for (let index = source.indexOf('{', start); index < source.length; index += 1) {
        if (source[index] === '{') {
            depth += 1;
            bodyStarted = true;
        } else if (source[index] === '}') {
            depth -= 1;
            if (bodyStarted && depth === 0) {
                return source.slice(source.indexOf('function', start), index + 1);
            }
        }
    }
    throw new Error(`Could not extract ${name}`);
}

function loadScaleInfoLifecycle({ getScaleInfo, deviceStateCache, renderDeviceListFromCache = () => {} }) {
    const start = source.indexOf('const scaleInfoByDeviceId = new Map();');
    const end = source.indexOf('// Render generic loading state', start);
    assert.ok(start >= 0 && end > start);
    return new Function(
        'getScaleInfo',
        'deviceStateCache',
        'renderDeviceListFromCache',
        'logger',
        `${source.slice(start, end)}
         return { refreshScaleInfo, scaleInfoByDeviceId, scaleInfoInFlight };`,
    )(getScaleInfo, deviceStateCache, renderDeviceListFromCache, { warn() {}, debug() {} });
}

function loadRenderSingleDeviceList({
    scaleInfoByDeviceId,
    usbPoweredByDevice = {},
    latestBattery = undefined,
}) {
    const render = extractFunction('renderSingleDeviceList');
    return new Function(
        'scaleInfoByDeviceId',
        'settingsCache',
        'renderBatteryBadge',
        'escapeHtml',
        'getTranslation',
        'renderScalePopupToggle',
        'window',
        `${render}\nreturn renderSingleDeviceList;`,
    )(
        scaleInfoByDeviceId,
        { rea: { skalePoweredByUsbByDevice: usbPoweredByDevice } },
        level => `<battery>${level}</battery>`,
        value => String(value),
        value => value,
        () => '',
        { getLatestScaleBattery: () => latestBattery },
    );
}

function deferred() {
    let resolve;
    const promise = new Promise(result => { resolve = result; });
    return { promise, resolve };
}

test('scale settings use connected-scale metadata and per-device controls', () => {
    assert.match(source, /getScaleInfo/);
    assert.match(source, /scaleInfoByDeviceId/);
    assert.match(source, /firmwareVersion/);
    assert.match(source, /batteryLevel/);
    assert.match(source, /scaleButtonStartsEspressoByDevice/);
    assert.match(source, /skalePoweredByUsbByDevice/);
    assert.doesNotMatch(source, /deviceInfo\.powerSource/);
    assert.doesNotMatch(source, /getDevices\(\)[\s\S]*deviceInfo/);
});

test('repeated renders share one in-flight scale info request', async () => {
    const pending = deferred();
    let calls = 0;
    const deviceStateCache = { devices: [{ id: 'A', state: 'connected' }] };
    const lifecycle = loadScaleInfoLifecycle({
        deviceStateCache,
        getScaleInfo: () => {
            calls += 1;
            return pending.promise;
        },
    });

    const first = lifecycle.refreshScaleInfo('A');
    const second = lifecycle.refreshScaleInfo('A');
    assert.equal(calls, 1);
    pending.resolve({ firmwareVersion: 'R029' });
    await Promise.all([first, second]);
    assert.deepEqual(lifecycle.scaleInfoByDeviceId.get('A'), { firmwareVersion: 'R029' });
});

test('scale info is fenced across A to B to A and disconnect transitions', async () => {
    const requests = [];
    const deviceStateCache = { devices: [{ id: 'A', state: 'connected' }] };
    const lifecycle = loadScaleInfoLifecycle({
        deviceStateCache,
        getScaleInfo: () => {
            const request = deferred();
            requests.push(request);
            return request.promise;
        },
    });

    const firstA = lifecycle.refreshScaleInfo('A');
    deviceStateCache.devices = [{ id: 'B', state: 'connected' }];
    const b = lifecycle.refreshScaleInfo('B');
    deviceStateCache.devices = [{ id: 'A', state: 'connected' }];
    const secondA = lifecycle.refreshScaleInfo('A');
    assert.equal(requests.length, 3);

    requests[0].resolve({ firmwareVersion: 'stale-A' });
    requests[1].resolve({ firmwareVersion: 'stale-B' });
    await Promise.all([firstA, b]);
    assert.equal(lifecycle.scaleInfoByDeviceId.has('A'), false);
    assert.equal(lifecycle.scaleInfoByDeviceId.has('B'), false);

    requests[2].resolve({ firmwareVersion: 'fresh-A' });
    await secondA;
    assert.deepEqual(lifecycle.scaleInfoByDeviceId.get('A'), { firmwareVersion: 'fresh-A' });

    deviceStateCache.devices = [];
    await lifecycle.refreshScaleInfo(null);
    assert.equal(lifecycle.scaleInfoByDeviceId.size, 0);
});

test('an unavailable scale-info endpoint leaves metadata unknown', async () => {
    const deviceStateCache = { devices: [{ id: 'A', state: 'connected' }] };
    const lifecycle = loadScaleInfoLifecycle({
        deviceStateCache,
        getScaleInfo: async () => {
            const error = new Error('endpoint unavailable');
            error.status = 503;
            throw error;
        },
    });

    await lifecycle.refreshScaleInfo('A');
    assert.deepEqual(lifecycle.scaleInfoByDeviceId.get('A'), {});
});

test('stale metadata is not rendered for disconnected scales or unknown batteries', () => {
    const metadata = new Map([['A', { firmwareVersion: 'R029', batteryLevel: null }]]);
    const render = loadRenderSingleDeviceList({ scaleInfoByDeviceId: metadata, latestBattery: 77 });
    const html = render([{ id: 'A', name: 'Scale A', state: 'disconnected' }], '', '', 'Scale');
    assert.doesNotMatch(html, /R029|77/);

    const connectedHtml = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.doesNotMatch(connectedHtml, /77/);
});

test('USB power state is rendered from the per-device setting and suppresses battery', () => {
    const metadata = new Map([['A', { firmwareVersion: 'R029', batteryLevel: 77 }]]);
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: metadata,
        usbPoweredByDevice: { A: true },
    });

    const html = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.match(html, />USB</);
    assert.doesNotMatch(html, /<battery>77<\/battery>/);
});

test('USB badge and battery return to the live metadata path when disabled', () => {
    const metadata = new Map([['A', { firmwareVersion: 'R029', batteryLevel: 77 }]]);
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: metadata,
        usbPoweredByDevice: { A: false },
    });

    const html = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.doesNotMatch(html, />USB</);
    assert.match(html, /<battery>77<\/battery>/);
});

test('changing USB power clears cached metadata and repaints the device list', () => {
    const scaleInfoByDeviceId = new Map([['A', { firmwareVersion: 'R029', batteryLevel: 77 }]]);
    const settingsCache = { rea: { skalePoweredByUsbByDevice: {} } };
    let renderCount = 0;
    let staged;
    const update = new Function(
        'settingsCache',
        'scaleInfoByDeviceId',
        'renderDeviceListFromCache',
        'updateReaSetting',
        `const updateScaleDeviceSetting = ${extractAssignedFunction('updateScaleDeviceSetting')};\nreturn updateScaleDeviceSetting;`,
    )(
        settingsCache,
        scaleInfoByDeviceId,
        () => { renderCount += 1; },
        (key, value) => { staged = { key, value }; settingsCache.rea[key] = value; },
    );

    update('skalePoweredByUsbByDevice', 'skalePoweredByUsb', 'A', true);
    assert.equal(settingsCache.rea.skalePoweredByUsbByDevice.A, true);
    assert.equal(scaleInfoByDeviceId.has('A'), false);
    assert.equal(renderCount, 1);
    assert.deepEqual(staged, {
        key: 'skalePoweredByUsbByDevice',
        value: { A: true },
    });
});

test('scale settings put supported controls in a device popup', () => {
    assert.match(source, /openScaleDeviceSettings/);
    assert.match(source, /scale-device-settings-modal/);
    assert.match(source, /scaleButtonStartsEspressoByDevice/);
    assert.match(source, /skalePoweredByUsbByDevice/);
    assert.match(source, /'scaleButtonStartsEspresso'/);
    assert.match(source, /'skalePoweredByUsb'/);
    assert.match(source, /data-device-id=/);
    assert.doesNotMatch(source, /renderScaleToggle\(settings/);
});

test('device settings are indexed and updated by the selected device ID', () => {
    assert.match(source, /settings\?\.\[key\]\?\.\[deviceId\] === true/);
    assert.match(source, /values\[deviceId\] = true/);
    assert.match(source, /delete values\[deviceId\]/);
});
