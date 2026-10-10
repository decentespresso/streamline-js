import test from 'node:test';
import assert from 'node:assert/strict';
import { selectableBeanScales, buildBeanScaleCapture } from '../src/modules/bean-scale.js';

test('bean selection keeps only explicit scale identities', () => {
    const devices = [{ id: 'aux:1', type: 'scale', connectionRole: 'auxiliary', state: 'connected' }, { id: 'primary:1', type: 'scale', connectionRole: 'primary', state: 'connected' }, { id: 'machine', type: 'machine' }, { type: 'scale' }];
    assert.deepEqual(selectableBeanScales(devices), [{ id: 'aux:1', type: 'scale', connectionRole: 'auxiliary', state: 'connected' }]);
});

test('capture requires explicit role and records raw sample provenance', () => {
    const capture = buildBeanScaleCapture({ deviceId: 'plugin:scale/a', connectionRole: 'auxiliary', sample: { timestamp: '2026-10-11T10:00:00Z', weight: 18.2, batteryLevel: 87, timerValue: 4.2, flow: 1.1 }, capturedAt: '2026-10-11T10:00:01Z', receivedAt: '2026-10-11T10:00:01Z' });
    assert.deepEqual(capture, { deviceId: 'plugin:scale/a', role: 'auxiliary', purpose: 'beans', units: 'g', userConfirmed: true, capturedAt: '2026-10-11T10:00:01Z', receivedAt: '2026-10-11T10:00:01Z', sampleTimestamp: '2026-10-11T10:00:00Z', weight: 18.2, batteryLevel: 87, timerValue: 4.2, flow: 1.1 });
    assert.equal(buildBeanScaleCapture({ deviceId: 'x', sample: { weight: 18 } }), null);
    assert.equal(buildBeanScaleCapture({ deviceId: 'x', connectionRole: 'auxiliary', sample: { weight: 'unknown' } }), null);
});
