import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseSensorCalInput,
    previewCalibration,
    absoluteSetCorrection,
    formatCalValue,
    sensorCalTarget,
    snapshotReading,
    averageReadings,
    correctionBlocked,
    SENSOR_CAL_TARGETS,
    SENSOR_CAL_MIN,
    SENSOR_CAL_MAX,
    SENSOR_CAL_SAMPLE_WINDOW_MS,
    clampFlowMultiplier,
    FLOW_MULTIPLIER_MIN,
    FLOW_MULTIPLIER_MAX,
    FLOW_MULTIPLIER_DEFAULT,
    FLOW_MULTIPLIER_STEP,
} from '../src/modules/sensor-cal.js';

// --- input parsing ----------------------------------------------------------

test('parseSensorCalInput: accepts decimals and negatives', () => {
    assert.equal(parseSensorCalInput('9.5'), 9.5);
    assert.equal(parseSensorCalInput(' 92 '), 92);
    assert.equal(parseSensorCalInput('-1.25'), -1.25);
    assert.equal(parseSensorCalInput(0), 0);
});

test('parseSensorCalInput: blank and unparseable are null, not 0', () => {
    for (const bad of ['', '   ', null, undefined, 'abc', '9,5', NaN, Infinity]) {
        assert.equal(parseSensorCalInput(bad), null, `${String(bad)} must not parse`);
    }
});

// Decaid 400s anything outside the signed Q16.16 range, so the page has to
// stop it at the input rather than round-trip a rejection.
test('parseSensorCalInput: rejects values outside the Q16.16 range', () => {
    assert.equal(parseSensorCalInput(SENSOR_CAL_MIN), SENSOR_CAL_MIN);
    assert.equal(parseSensorCalInput(SENSOR_CAL_MAX), SENSOR_CAL_MAX);
    assert.equal(parseSensorCalInput(SENSOR_CAL_MIN - 1), null);
    assert.equal(parseSensorCalInput(40000), null);
});

// --- the firmware's own arithmetic ------------------------------------------

test('previewCalibration: ratio multiplies, offset adds', () => {
    // gauge read 9.5 where the DE1 said 9.0, on a stored 1.0 multiplier
    assert.equal(previewCalibration('ratio', 1, 9, 9.5).toFixed(4), '1.0556');
    // thermometer read 90.5 where the DE1 said 92, on a stored 0 offset
    assert.equal(previewCalibration('offset', 0, 92, 90.5), -1.5);
});

test('previewCalibration: folds into a calibration that is already non-default', () => {
    assert.equal(previewCalibration('ratio', 1.1, 10, 11), 1.2100000000000002);
    assert.equal(previewCalibration('offset', -1.5, 92, 91), -2.5);
});

test('previewCalibration: not computable returns null, never a wrong number', () => {
    assert.equal(previewCalibration('ratio', 1, 0, 9.5), null);
    assert.equal(previewCalibration('ratio', null, 9, 9.5), null);
    assert.equal(previewCalibration('offset', 0, 92, undefined), null);
});

// This is the whole reason the page previews and then clears its inputs: the
// same pair applied twice is a different, wrong calibration.
test('previewCalibration: a correction applied twice compounds', () => {
    const once = previewCalibration('ratio', 1, 1, 1.05);
    const twice = previewCalibration('ratio', once, 1, 1.05);
    assert.equal(once, 1.05);
    assert.equal(twice.toFixed(4), '1.1025');
});

// --- absolute set (used by factory reset) -----------------------------------

test('absoluteSetCorrection: lands exactly on the wanted value, both kinds', () => {
    const fromRatio = absoluteSetCorrection(1.1025, 1.0);
    assert.deepEqual(fromRatio, { de1ReportedValue: 1.1025, measuredValue: 1.0 });
    assert.equal(previewCalibration('ratio', 1.1025, fromRatio.de1ReportedValue, fromRatio.measuredValue), 1.0);

    const fromOffset = absoluteSetCorrection(-2.5, 0);
    assert.equal(previewCalibration('offset', -2.5, fromOffset.de1ReportedValue, fromOffset.measuredValue), 0);
});

test('absoluteSetCorrection: repeating it is a no-op (safe to press twice)', () => {
    const again = absoluteSetCorrection(1.0, 1.0);
    assert.equal(previewCalibration('ratio', 1.0, again.de1ReportedValue, again.measuredValue), 1.0);
    assert.equal(previewCalibration('offset', 0, 0, 0), 0);
});

// --- display ----------------------------------------------------------------

test('formatCalValue: multipliers get 4 decimals, offsets get a sign', () => {
    assert.equal(formatCalValue('ratio', 1), '1.0000');
    assert.equal(formatCalValue('offset', 0), '+0.00');
    assert.equal(formatCalValue('offset', -1.5), '-1.50');
    assert.equal(formatCalValue('ratio', null), '—');
});

test('sensorCalTarget: the three firmware targets, and nothing else', () => {
    assert.deepEqual(SENSOR_CAL_TARGETS.map((t) => t.id), ['temperature', 'pressure', 'flow']);
    assert.equal(sensorCalTarget('flow').kind, 'ratio');
    assert.equal(sensorCalTarget('temperature').kind, 'offset');
    assert.equal(sensorCalTarget('nope'), null);
});

// --- live capture (the "DE1 reads" column) ----------------------------------

// de1ReportedValue means what the DE1's SENSOR reported. The target* fields
// are frame setpoints, and in a frame controlling the other variable they
// carry that frame's limiter — reading them here writes a correction the
// sensor error never justified.
test('snapshotReading: reads the sensor, never the frame setpoint', () => {
    const frame = { groupTemperature: 90.3, targetGroupTemperature: 92,
                    pressure: 6.1, targetPressure: 10, flow: 2.1, targetFlow: 8 };
    assert.equal(snapshotReading(sensorCalTarget('temperature'), frame), 90.3);
    assert.equal(snapshotReading(sensorCalTarget('pressure'), frame), 6.1);
    assert.equal(snapshotReading(sensorCalTarget('flow'), frame), 2.1);
});

test('snapshotReading: no target* field is ever the source', () => {
    for (const target of SENSOR_CAL_TARGETS) {
        assert.ok(!target.readingKey.startsWith('target'), `${target.id} reads ${target.readingKey}`);
    }
});

// No frame yet = machine asleep or disconnected. Capture has to say so
// rather than quietly hand a correction a 0 for what the DE1 reported.
test('snapshotReading: no frame or missing field reads null, never 0', () => {
    assert.equal(snapshotReading(sensorCalTarget('flow'), null), null);
    assert.equal(snapshotReading(sensorCalTarget('flow'), {}), null);
    assert.equal(snapshotReading(sensorCalTarget('flow'), { flow: null }), null);
    assert.equal(snapshotReading(null, { flow: 2 }), null);
});

// One 1 Hz frame lands wherever the pump was in its cycle, so a capture
// averages the window instead of trusting a single tick.
test('averageReadings: means the samples inside the window', () => {
    const now = 10_000;
    const samples = [
        { value: 8.8, at: now - 3000 },
        { value: 9.0, at: now - 2000 },
        { value: 9.2, at: now - 1000 },
    ];
    assert.equal(averageReadings(samples, now).toFixed(4), '9.0000');
});

test('averageReadings: drops samples older than the window', () => {
    const now = 10_000;
    const samples = [
        { value: 2, at: now - (SENSOR_CAL_SAMPLE_WINDOW_MS + 1) },
        { value: 9, at: now - 500 },
    ];
    assert.equal(averageReadings(samples, now), 9);
});

test('averageReadings: an empty or unusable window is null, not 0', () => {
    assert.equal(averageReadings([], 10_000), null);
    assert.equal(averageReadings(null, 10_000), null);
    assert.equal(averageReadings([{ value: 9, at: 0 }], 10_000), null);
    assert.equal(averageReadings([{ value: NaN, at: 9_900 }], 10_000), null);
});

// --- zero guards ------------------------------------------------------------

// An idle machine targets nothing: every goal reads 0. Correcting against
// it divides by zero (ratio) or shoves the whole reading into the offset.
test('correctionBlocked: a zero goal is refused for every target', () => {
    assert.ok(correctionBlocked('ratio', 0, 9.5).length > 0);
    assert.ok(correctionBlocked('offset', 0, 90.5).length > 0);
});

test('correctionBlocked: a measured zero is refused only where it multiplies', () => {
    assert.ok(correctionBlocked('ratio', 9, 0).length > 0);
    assert.equal(correctionBlocked('offset', 92, 0), '');
    assert.equal(correctionBlocked('ratio', 9, 9.5), '');
});

// --- sanity band -------------------------------------------------------------

// The arithmetic will happily write any multiplier. A pressure or flow
// sensor out by a third is broken hardware or a mis-capture, and either way
// the user should be stopped before the firmware folds it in.
test('correctionBlocked: refuses ratio corrections outside the sanity band', () => {
    // the limiter bug this guards: captured 10 bar (a frame's pressure
    // maximum) against a gauge reading the 6.1 bar the group actually held
    assert.ok(correctionBlocked('ratio', 10, 6.1).length > 0);
    // and its flow twin: an 8 ml/s frame limiter against 2.05 measured
    assert.ok(correctionBlocked('ratio', 8, 2.05).length > 0);
    assert.ok(correctionBlocked('ratio', 9, 4.5).length > 0);
    assert.ok(correctionBlocked('ratio', 9, 18).length > 0);
});

test('correctionBlocked: a plausible few-percent correction passes', () => {
    assert.equal(correctionBlocked('ratio', 9, 9.5), '');
    assert.equal(correctionBlocked('ratio', 9, 8.5), '');
    assert.equal(correctionBlocked('ratio', 2.1, 2.4), '');
});

test('correctionBlocked: the band does not apply to the temperature offset', () => {
    assert.equal(correctionBlocked('offset', 92, 20), '');
});

// --- flow estimation multiplier ---------------------------------------------

test('clampFlowMultiplier keeps a value inside the range', () => {
    assert.equal(clampFlowMultiplier(1.0), 1);
    assert.equal(clampFlowMultiplier(0.87), 0.87);
    assert.equal(FLOW_MULTIPLIER_DEFAULT, 1.0);
});

test('clampFlowMultiplier clamps below the minimum and above the maximum', () => {
    assert.equal(clampFlowMultiplier(0.05), FLOW_MULTIPLIER_MIN);
    assert.equal(clampFlowMultiplier(-3), FLOW_MULTIPLIER_MIN);
    assert.equal(clampFlowMultiplier(2.5), FLOW_MULTIPLIER_MAX);
});

test('clampFlowMultiplier accepts numeric strings from the input box', () => {
    assert.equal(clampFlowMultiplier('1.25'), 1.25);
    assert.equal(clampFlowMultiplier(' 0.5 '), 0.5);
    assert.equal(clampFlowMultiplier('9'), FLOW_MULTIPLIER_MAX);
});

test('clampFlowMultiplier returns null for anything that is not a finite number', () => {
    for (const bad of [null, undefined, '', '   ', 'abc', NaN, Infinity]) {
        assert.equal(clampFlowMultiplier(bad), null, String(bad));
    }
});

test('repeated +0.01 steps stay at 2 decimal places', () => {
    let v = 0.13;
    for (let i = 0; i < 187; i++) v = clampFlowMultiplier(v + FLOW_MULTIPLIER_STEP);
    assert.equal(v, 2);
    v = 1;
    for (let i = 0; i < 30; i++) v = clampFlowMultiplier(v + FLOW_MULTIPLIER_STEP);
    assert.equal(v, 1.3);
    assert.equal(String(v), '1.3');
});
