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

function loadScaleDeviceSetting() {
    const getSetting = extractFunction('getScaleDeviceSetting');
    return new Function(`${getSetting}\nreturn getScaleDeviceSetting;`)();
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
    usbPoweredByDevice = undefined,
    legacyUsbPowered = undefined,
    latestBattery = undefined,
}) {
    const render = extractFunction('renderSingleDeviceList');
    const getScaleDeviceSetting = loadScaleDeviceSetting();
    return new Function(
        'scaleInfoByDeviceId',
        'settingsCache',
        'renderBatteryBadge',
        'escapeHtml',
        'getTranslation',
        'renderScalePopupToggle',
        'getScaleDeviceSetting',
        'window',
        `${render}\nreturn renderSingleDeviceList;`,
    )(
        scaleInfoByDeviceId,
        {
            rea: {
                ...(usbPoweredByDevice !== undefined
                    ? { skalePoweredByUsbByDevice: usbPoweredByDevice }
                    : {}),
                ...(legacyUsbPowered !== undefined
                    ? { skalePoweredByUsb: legacyUsbPowered }
                    : {}),
            },
        },
        level => `<battery>${level}</battery>`,
        value => String(value),
        value => value,
        () => '',
        getScaleDeviceSetting,
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

test('USB badge and battery return to the live metadata path when the map disables the device', () => {
    const metadata = new Map([['A', { firmwareVersion: 'R029', batteryLevel: 77 }]]);
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: metadata,
        usbPoweredByDevice: { A: false },
    });

    const html = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.doesNotMatch(html, />USB</);
    assert.match(html, /<battery>77<\/battery>/);
});

test('legacy USB power state renders with the same ON and OFF semantics', () => {
    const metadata = new Map([['A', { firmwareVersion: 'R029', batteryLevel: 77 }]]);
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: metadata,
        legacyUsbPowered: true,
    });
    const enabledHtml = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.match(enabledHtml, />USB</);
    assert.doesNotMatch(enabledHtml, /<battery>77<\/battery>/);

    const disabledRender = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: metadata,
        legacyUsbPowered: false,
    });
    const disabledHtml = disabledRender([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.doesNotMatch(disabledHtml, />USB</);
    assert.match(disabledHtml, /<battery>77<\/battery>/);
});

test('per-device USB settings remain independent for both enabled and disabled devices', () => {
    const metadata = new Map([
        ['A', { firmwareVersion: 'R029', batteryLevel: 77 }],
        ['B', { firmwareVersion: 'R029', batteryLevel: 66 }],
    ]);
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: metadata,
        usbPoweredByDevice: { A: true },
    });
    const html = render([
        { id: 'A', name: 'Scale A', state: 'connected' },
        { id: 'B', name: 'Scale B', state: 'connected' },
    ], '', '', 'Scale');
    const a = html.slice(html.indexOf('Scale A'), html.indexOf('Scale B'));
    const b = html.slice(html.indexOf('Scale B'));
    assert.match(a, />USB</);
    assert.doesNotMatch(a, /<battery>77<\/battery>/);
    assert.doesNotMatch(b, />USB</);
    assert.match(b, /<battery>66<\/battery>/);
});

function loadUpdateScaleDeviceSetting({
    settingsCache,
    updateReaSetting,
    renderDeviceListFromCache = () => {},
    scaleInfoByDeviceId = new Map(),
}) {
    const update = extractAssignedFunction('updateScaleDeviceSetting');
    return new Function(
        'settingsCache',
        'scaleInfoByDeviceId',
        'renderDeviceListFromCache',
        'updateReaSetting',
        `const updateScaleDeviceSetting = ${update};\nreturn updateScaleDeviceSetting;`,
    )(
        settingsCache,
        scaleInfoByDeviceId,
        renderDeviceListFromCache,
        updateReaSetting,
    );
}

test('staging USB changes updates only the selected device and waits for save before repainting', () => {
    const scaleInfoByDeviceId = new Map([
        ['A', { firmwareVersion: 'R029', batteryLevel: 77 }],
        ['B', { firmwareVersion: 'R029', batteryLevel: 66 }],
    ]);
    const settingsCache = { rea: { skalePoweredByUsbByDevice: { A: true, B: true } } };
    let renderCount = 0;
    const staged = [];
    const update = loadUpdateScaleDeviceSetting({
        settingsCache,
        scaleInfoByDeviceId,
        renderDeviceListFromCache: () => { renderCount += 1; },
        updateReaSetting: (key, value) => {
            staged.push({ key, value });
            settingsCache.rea[key] = value;
        },
    });

    update('skalePoweredByUsbByDevice', 'skalePoweredByUsb', 'B', false);
    assert.deepEqual(settingsCache.rea.skalePoweredByUsbByDevice, { A: true });
    assert.equal(renderCount, 0);
    assert.deepEqual(staged, [{
        key: 'skalePoweredByUsbByDevice',
        value: { A: true },
    }]);
    assert.deepEqual(scaleInfoByDeviceId.get('B'), { firmwareVersion: 'R029', batteryLevel: 66 });
});

test('staging a legacy USB change uses the legacy field without touching device maps', () => {
    const settingsCache = { rea: { skalePoweredByUsb: false } };
    const staged = [];
    const update = loadUpdateScaleDeviceSetting({
        settingsCache,
        updateReaSetting: (key, value) => {
            staged.push({ key, value });
            settingsCache.rea[key] = value;
        },
    });

    update('skalePoweredByUsbByDevice', 'skalePoweredByUsb', 'A', true);
    assert.equal(settingsCache.rea.skalePoweredByUsb, true);
    assert.deepEqual(staged, [{
        key: 'skalePoweredByUsb',
        value: true,
    }]);
});

function loadFlushPendingChanges({
    pendingChanges,
    setReaSettings,
    scaleInfoByDeviceId = new Map(),
    scaleInfoInFlight = new Map(),
    saveSettingsBackup = () => {},
}) {
    const flush = extractFunction('flushPendingChanges');
    return new Function(
        'pendingChanges',
        'setReaSettings',
        'scaleInfoByDeviceId',
        'scaleInfoInFlight',
        'saveSettingsBackup',
        `let scaleInfoRequestGeneration = 0;
         function resetPendingChanges() {
             pendingChanges.rea = {};
             pendingChanges.de1 = {};
             pendingChanges.de1Advanced = {};
             pendingChanges.workflow = {};
         }
         async ${flush}
         return {
             flushPendingChanges,
             get generation() { return scaleInfoRequestGeneration; },
         };`,
    )(
        pendingChanges,
        setReaSettings,
        scaleInfoByDeviceId,
        scaleInfoInFlight,
        saveSettingsBackup,
    );
}

function loadScaleInfoAndSaveLifecycle({
    getScaleInfo,
    deviceStateCache,
    setReaSettings,
}) {
    const infoStart = source.indexOf('const scaleInfoByDeviceId = new Map();');
    const infoEnd = source.indexOf('// Render generic loading state', infoStart);
    const flush = extractFunction('flushPendingChanges');
    return new Function(
        'getScaleInfo',
        'deviceStateCache',
        'logger',
        'setReaSettings',
        'saveSettingsBackup',
        `let pendingChanges = { rea: {}, de1: {}, de1Advanced: {}, workflow: {} };
         function resetPendingChanges() {
             pendingChanges = { rea: {}, de1: {}, de1Advanced: {}, workflow: {} };
         }
         async ${flush}
         ${source.slice(infoStart, infoEnd)}
         return {
             refreshScaleInfo,
             scaleInfoByDeviceId,
             stageUsbSetting(value) {
                 pendingChanges.rea.skalePoweredByUsbByDevice = value;
             },
             flushPendingChanges,
         };`,
    )(
        getScaleInfo,
        deviceStateCache,
        { warn() {}, debug() {} },
        setReaSettings,
        () => {},
    );
}

test('successful save invalidates stale scale metadata requests for map and legacy USB settings', async () => {
    const scaleInfoByDeviceId = new Map([['A', { firmwareVersion: 'stale' }]]);
    const staleRequest = { marker: true };
    const scaleInfoInFlight = new Map([['A', staleRequest]]);
    const pendingChanges = { rea: { skalePoweredByUsb: true }, de1: {}, de1Advanced: {}, workflow: {} };
    const flush = loadFlushPendingChanges({
        pendingChanges,
        scaleInfoByDeviceId,
        scaleInfoInFlight,
        setReaSettings: async changes => {
            assert.deepEqual(changes, { skalePoweredByUsb: true });
        },
    });

    const generation = flush.generation;
    await flush.flushPendingChanges();
    assert.equal(flush.generation, generation + 1);
    assert.equal(scaleInfoByDeviceId.size, 0);
    assert.equal(scaleInfoInFlight.size, 0);
    assert.deepEqual(pendingChanges.rea, {});
});

test('successful save fences an old response before accepting the fresh refetch', async () => {
    const requests = [];
    const lifecycle = loadScaleInfoAndSaveLifecycle({
        deviceStateCache: { devices: [{ id: 'A', state: 'connected' }] },
        getScaleInfo: () => {
            const request = deferred();
            requests.push(request);
            return request.promise;
        },
        setReaSettings: async () => {},
    });

    const oldResponse = lifecycle.refreshScaleInfo('A');
    lifecycle.stageUsbSetting({ A: true });
    await lifecycle.flushPendingChanges();
    const freshResponse = lifecycle.refreshScaleInfo('A');
    assert.equal(requests.length, 2);

    requests[0].resolve({ firmwareVersion: 'stale' });
    await oldResponse;
    assert.equal(lifecycle.scaleInfoByDeviceId.has('A'), false);

    requests[1].resolve({ firmwareVersion: 'fresh' });
    await freshResponse;
    assert.deepEqual(lifecycle.scaleInfoByDeviceId.get('A'), { firmwareVersion: 'fresh' });
});

test('failed save preserves metadata until the setting is actually persisted', async () => {
    const scaleInfoByDeviceId = new Map([['A', { firmwareVersion: 'live' }]]);
    const scaleInfoInFlight = new Map([['A', { marker: true }]]);
    const pendingChanges = { rea: { skalePoweredByUsbByDevice: { A: true } }, de1: {}, de1Advanced: {}, workflow: {} };
    const flush = loadFlushPendingChanges({
        pendingChanges,
        scaleInfoByDeviceId,
        scaleInfoInFlight,
        setReaSettings: async () => { throw new Error('save failed'); },
    });

    await assert.rejects(flush.flushPendingChanges(), /save failed/);
    assert.deepEqual(scaleInfoByDeviceId.get('A'), { firmwareVersion: 'live' });
    assert.equal(scaleInfoInFlight.size, 1);
    assert.deepEqual(pendingChanges.rea, { skalePoweredByUsbByDevice: { A: true } });
});

test('scale setting helper gives the map precedence over legacy state', () => {
    const getSetting = loadScaleDeviceSetting();
    assert.equal(getSetting({
        skalePoweredByUsbByDevice: { A: false },
        skalePoweredByUsb: true,
    }, 'skalePoweredByUsbByDevice', 'skalePoweredByUsb', 'A'), false);
    assert.equal(getSetting({
        skalePoweredByUsbByDevice: { A: false },
        skalePoweredByUsb: true,
    }, 'skalePoweredByUsbByDevice', 'skalePoweredByUsb', 'B'), false);
    assert.equal(getSetting({
        skalePoweredByUsb: true,
    }, 'skalePoweredByUsbByDevice', 'skalePoweredByUsb', 'A'), true);
    assert.equal(getSetting({}, 'skalePoweredByUsbByDevice', 'skalePoweredByUsb', 'A'), undefined);
});

test('scale setting helper does not fall back from a declared empty map to legacy state', () => {
    const getSetting = loadScaleDeviceSetting();
    assert.equal(getSetting({
        skalePoweredByUsbByDevice: {},
        skalePoweredByUsb: true,
    }, 'skalePoweredByUsbByDevice', 'skalePoweredByUsb', 'A'), false);
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
