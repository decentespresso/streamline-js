import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
    new URL('../src/settings/settings.js', import.meta.url),
    'utf8',
);

test('scale settings show device metadata exposed by Decaid', () => {
    assert.match(source, /device\.deviceInfo/);
    assert.match(source, /firmwareVersion/);
    assert.match(source, /batteryLevel/);
    assert.match(source, /powerSource === 'usb'/);
    assert.match(source, /deviceInfo\.powerSource !== 'usb'/);
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
