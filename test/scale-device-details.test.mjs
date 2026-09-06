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

test('scale settings expose supported Skale controls', () => {
    assert.match(source, /hasOwnProperty\.call\(settings \|\| \{\}, key\)/);
    assert.match(source, /renderScaleToggle\(settings, 'scaleButtonStartsEspresso'/);
    assert.match(source, /renderScaleToggle\(settings, 'skalePoweredByUsb'/);
    assert.match(source, /updateReaSetting\('\$\{key\}'/);
});
