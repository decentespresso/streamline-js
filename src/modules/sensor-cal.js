// Pure helpers for the DE1 sensor calibration page (temperature, pressure,
// flow), which drives Decaid's GET|PUT /api/v1/machine/calibration/{target}.
//
// The one thing that has to be right here: A WRITE IS A CORRECTION, NOT A
// SET. The firmware folds the write into the value it already holds —
// flow/pressure multiply the stored calibration by
// measuredValue / de1ReportedValue, temperature adds
// measuredValue - de1ReportedValue. Send the same pair twice and the
// correction lands twice, so the page previews the outcome before writing
// and drops its inputs after a successful one. This module holds the
// DOM-free parts so the node:test suite can lock them in (see
// test/sensor-cal.test.mjs and test/README.md).

// Both values ride the wire as signed Q16.16; Decaid 400s anything outside.
export const SENSOR_CAL_MIN = -32768;
export const SENSOR_CAL_MAX = 32767.9999;

// `kind` is how the firmware folds a write in: 'ratio' multiplies (flow,
// pressure), 'offset' adds (temperature). It also says how to read the
// stored value — a multiplier around 1.0, or a °C offset around 0.0.
//
// `readingKey` is the snapshot field the DE1's OWN SENSOR reports, which is
// what `de1ReportedValue` means. It is deliberately not the matching
// target* field: those are frame setpoints, and in a frame that controls
// the other variable they carry that frame's LIMITER — a flow-controlled
// step reports its maximum pressure in targetPressure while the group sits
// well below it. Correcting against a limiter writes a multiplier the
// sensor error never justified.
export const SENSOR_CAL_TARGETS = [
    {
        id: 'temperature',
        label: 'Temperature',
        kind: 'offset',
        unit: '°C',
        readingKey: 'groupTemperature',
    },
    {
        id: 'pressure',
        label: 'Pressure',
        kind: 'ratio',
        unit: 'bar',
        readingKey: 'pressure',
    },
    {
        id: 'flow',
        label: 'Flow',
        kind: 'ratio',
        unit: 'ml/s',
        readingKey: 'flow',
    },
];

export function sensorCalTarget(id) {
    return SENSOR_CAL_TARGETS.find((t) => t.id === id) || null;
}

/**
 * Parse one calibration input box.
 * @returns {number|null} null when blank, unparseable, or outside the
 *   Q16.16 range Decaid accepts — the caller keeps the Apply button off.
 */
export function parseSensorCalInput(raw) {
    if (raw === null || raw === undefined) return null;
    const trimmed = String(raw).trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return null;
    if (value < SENSOR_CAL_MIN || value > SENSOR_CAL_MAX) return null;
    return value;
}

/**
 * What the stored calibration becomes if this correction is written —
 * the firmware's own arithmetic, so the page can show it before the write.
 * @returns {number|null} null when the correction is not computable (a
 *   ratio correction divides by de1ReportedValue).
 */
export function previewCalibration(kind, current, de1ReportedValue, measuredValue) {
    if (![current, de1ReportedValue, measuredValue].every(Number.isFinite)) return null;
    if (kind === 'offset') return current + (measuredValue - de1ReportedValue);
    if (de1ReportedValue === 0) return null;
    return current * (measuredValue / de1ReportedValue);
}

/**
 * The correction that lands ON an absolute value: read the current
 * calibration C, then write {C, desired}. Ratio gives C * (desired/C),
 * offset gives C + (desired - C) — both land on `desired` exactly, and
 * repeating it is a no-op, which is what makes "reset to factory" safe to
 * press twice.
 */
export function absoluteSetCorrection(current, desired) {
    return { de1ReportedValue: current, measuredValue: desired };
}

/** Display form: multipliers get 4 decimals, the °C offset gets a sign. */
export function formatCalValue(kind, value) {
    if (!Number.isFinite(value)) return '—';
    if (kind === 'offset') return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
    return value.toFixed(4);
}

/**
 * What the DE1's sensor is reporting right now — the `de1ReportedValue`
 * half of a correction, so the user only ever types the measured half.
 * @returns {number|null} null when there is no frame yet (machine asleep or
 *   disconnected) or the field is missing. 0 while idle, which
 *   correctionBlocked() refuses.
 */
export function snapshotReading(target, snapshot) {
    if (!target || !snapshot || typeof snapshot !== 'object') return null;
    const value = snapshot[target.readingKey];
    return Number.isFinite(value) ? value : null;
}

// A capture averages the frames seen in this window rather than trusting one
// snapshot tick, which lands wherever the pump happened to be in its cycle.
export const SENSOR_CAL_SAMPLE_WINDOW_MS = 5000;

/**
 * Mean of the samples inside the window, newest-anchored at `now`.
 * @param {Array<{value: number, at: number}>} samples
 * @returns {number|null} null when the window holds nothing usable — the
 *   caller must refuse to capture rather than invent a reading.
 */
export function averageReadings(samples, now, windowMs = SENSOR_CAL_SAMPLE_WINDOW_MS) {
    if (!Array.isArray(samples)) return null;
    const fresh = samples.filter(
        (s) => s && Number.isFinite(s.value) && Number.isFinite(s.at) && now - s.at <= windowMs,
    );
    if (fresh.length === 0) return null;
    return fresh.reduce((sum, s) => sum + s.value, 0) / fresh.length;
}

// ponytail: one hard band, no warn-then-confirm tier. A DE1 pressure or flow
// sensor that is out by a third is broken hardware or a mis-capture, not a
// calibration job, and the arithmetic would write the number regardless.
// Widen it if a real sensor is ever found outside — do not remove it.
export const SENSOR_CAL_RATIO_MIN = 0.75;
export const SENSOR_CAL_RATIO_MAX = 1.33;

/**
 * Why this correction cannot be sent, or '' when it can. A ratio correction
 * divides by de1ReportedValue and multiplies the stored calibration by the
 * measured one, so a zero on either side is either a division by zero or a
 * calibration of zero that nothing can be corrected away from afterwards —
 * and capturing an idle machine reads exactly 0.00 bar / 0.00 ml/s.
 */
export function correctionBlocked(kind, de1ReportedValue, measuredValue) {
    // An idle machine reports nothing, so a capture there reads 0. Correcting
    // against it would divide by zero (ratio) or shove the whole reading
    // into the offset (temperature).
    if (de1ReportedValue === 0) return 'The machine was not running when this was captured — capture again while it runs';
    if (kind !== 'ratio') return '';
    if (measuredValue === 0) return 'A measured zero cannot be calibrated';
    const ratio = measuredValue / de1ReportedValue;
    if (ratio < SENSOR_CAL_RATIO_MIN || ratio > SENSOR_CAL_RATIO_MAX) {
        return `That is ${ratio.toFixed(2)}x what the machine reported — check the capture and the measurement`;
    }
    return '';
}
