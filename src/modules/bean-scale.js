/** Pure helpers for explicit bean-scale selection and shot/plugin provenance. */
export const BEAN_SCALE_PURPOSE = 'beans';

export function selectableBeanScales(devices) {
    return Array.isArray(devices)
        ? devices.filter(device => (
            device?.type === 'scale'
            && device?.connectionRole === 'auxiliary'
            && (device.state === 'connected' || device.connectionState === 'connected' || device.connected === true)
            && typeof device.id === 'string'
            && device.id.length > 0
        ))
        : [];
}

function validIso(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function buildBeanScaleCapture({ deviceId, connectionRole, purpose = BEAN_SCALE_PURPOSE, sample, capturedAt = new Date().toISOString(), receivedAt = capturedAt } = {}) {
    if (!String(deviceId || '').trim() || connectionRole !== 'auxiliary' || purpose !== BEAN_SCALE_PURPOSE) return null;
    if (!sample || typeof sample !== 'object' || typeof sample.weight !== 'number' || !Number.isFinite(sample.weight) || sample.weight <= 0) return null;
    if (!validIso(capturedAt) || !validIso(receivedAt) || (sample.timestamp != null && !validIso(sample.timestamp))) return null;
    return {
        deviceId: String(deviceId), role: connectionRole, purpose, units: 'g', userConfirmed: true,
        capturedAt, receivedAt, weight: sample.weight,
        ...(sample.timestamp ? { sampleTimestamp: sample.timestamp } : {}),
        ...(sample.batteryLevel != null ? { batteryLevel: sample.batteryLevel } : {}),
        ...(sample.timerValue != null ? { timerValue: sample.timerValue } : {}),
        ...(sample.flow != null ? { flow: sample.flow } : {}),
    };
}
