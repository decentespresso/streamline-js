import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// The Visualizer plugin maps Decaid machine frames onto visualizer.coffee's
// shot shape. Two of the three temperature series are actuals; the third,
// `goal`, is the one Visualizer draws as the goal line and it must carry the
// PROFILE target (targetGroupTemperature -- the frame's temperature, flat for
// the whole step), not targetMixTemperature.
//
// targetMixTemperature is the DE1's live mix servo setpoint: the firmware moves
// it above and below the frame target to cancel the heat the group and basket
// absorb. Uploaded as `goal` it drew a goal line wandering several °C around a
// flat profile target, and -- because this loop never reads the step's `sensor`
// -- looked identical whether the step was set to coffee or water, so the graph
// could not be used to tell those two modes apart at all.
//
// plugin.js is a Decaid plugin, not an app module: it defines createPlugin(host)
// and can't be imported here. The mapping function is lifted out of the source
// and run with its dependencies injected -- same trick as
// dye2-plugin-source.test.mjs.

const PLUGIN = new URL(
    '../visulizer_REAPLUGIN/visualizer.reaplugin/plugin.js',
    import.meta.url,
);

function liftConverter() {
    const source = readFileSync(PLUGIN, 'utf8');
    const match = source.match(/  function convertReaToVisualizerFormat\(reaShot\) \{[\s\S]*?\r?\n  \}/);
    assert.ok(match, 'plugin.js: convertReaToVisualizerFormat not found');
    return new Function(
        `${match[0]}\nreturn convertReaToVisualizerFormat;`,
    )();
}

// One espresso frame. `targetGroupTemperature` is the profile target the user
// set; `targetMixTemperature` is the servo setpoint swinging around it.
function frame({ targetGroupTemperature, targetMixTemperature, seconds = 0 }) {
    return {
        machine: {
            timestamp: new Date(1700000000000 + seconds * 1000).toISOString(),
            state: { substate: 'pouring' },
            pressure: 9,
            targetPressure: 9,
            flow: 2,
            targetFlow: 2,
            mixTemperature: 93.2,
            groupTemperature: 92.8,
            targetGroupTemperature,
            targetMixTemperature,
        },
        scale: { weight: 18, weightFlow: 1.5 },
    };
}

function shot(measurements) {
    return {
        measurements,
        workflow: { profile: { target_weight: 36, steps: [{ temperature: 93, sensor: 'coffee' }] } },
    };
}

test('goal carries the flat profile target, not the swinging mix setpoint', () => {
    const convert = liftConverter();
    const out = convert(shot([
        frame({ targetGroupTemperature: 93, targetMixTemperature: 91.7, seconds: 0 }),
        frame({ targetGroupTemperature: 93, targetMixTemperature: 94.9, seconds: 1 }),
        frame({ targetGroupTemperature: 93, targetMixTemperature: 93.4, seconds: 2 }),
    ]));

    // The reported bug: a 93 °C profile drew a goal line from 91.7 to ~95.
    assert.deepEqual(out.temperature.goal, [93, 93, 93]);
    assert.deepEqual(out.temperature.mix, [93.2, 93.2, 93.2]);
    assert.deepEqual(out.temperature.basket, [92.8, 92.8, 92.8]);
});

test('goal follows the profile target across a step change', () => {
    const convert = liftConverter();
    const out = convert(shot([
        frame({ targetGroupTemperature: 93, targetMixTemperature: 95.1, seconds: 0 }),
        frame({ targetGroupTemperature: 88, targetMixTemperature: 86.2, seconds: 1 }),
    ]));

    assert.deepEqual(out.temperature.goal, [93, 88]);
});

test('goal falls back to the mix setpoint when the bridge omits the group target', () => {
    const convert = liftConverter();
    const out = convert(shot([
        frame({ targetGroupTemperature: 0, targetMixTemperature: 92.4, seconds: 0 }),
        frame({ targetGroupTemperature: undefined, targetMixTemperature: 93.6, seconds: 1 }),
    ]));

    // An older bridge that doesn't report the field keeps the previous series
    // rather than drawing a blank or zeroed goal line.
    assert.deepEqual(out.temperature.goal, [92.4, 93.6]);
});

test('every series stays aligned with elapsed', () => {
    const convert = liftConverter();
    const out = convert(shot([
        frame({ targetGroupTemperature: 93, targetMixTemperature: 91.7, seconds: 0 }),
        frame({ targetGroupTemperature: 93, targetMixTemperature: 94.9, seconds: 1 }),
    ]));

    const n = out.elapsed.length;
    assert.equal(n, 2);
    for (const series of [out.temperature.goal, out.temperature.mix, out.temperature.basket,
        out.pressure.pressure, out.pressure.goal, out.flow.flow, out.flow.goal]) {
        assert.equal(series.length, n);
    }
});
