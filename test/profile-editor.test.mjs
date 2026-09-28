import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITER_RANGE } from '../src/modules/profile-field-limits.js';

// profile_editor.js pulls in browser-only modules, so lift the function out of
// the source the same way the other editor tests do.
const source = readFileSync(new URL('../src/modules/profile_editor.js', import.meta.url), 'utf8');
const match = source.match(/export function pushChannel\([\s\S]*?\r?\n\}/);
assert.ok(match, 'pushChannel not found in profile_editor.js');
const pushChannel = new Function(`${match[0].replace('export ', '')}\nreturn pushChannel;`)();

function channel(steps) {
    const x = [], y = [];
    let prev = 0;
    let t = 0;
    for (const s of steps) {
        pushChannel(x, y, t, t + s.dur, prev, s.target, s.transition);
        prev = s.target;
        t += s.dur;
    }
    return { x, y };
}

test('smooth ramps from zero on the opening step', () => {
    const smooth = channel([{ dur: 10, target: 6, transition: 'smooth' }]);
    const fast   = channel([{ dur: 10, target: 6, transition: 'fast' }]);
    // The bug: both plotted as a flat line at 6 because smooth emitted no
    // opening point and step 1 has no earlier point to slope up from.
    assert.deepEqual(smooth.y, [0, 6]);
    assert.deepEqual(fast.y,   [6, 6]);
    assert.notDeepEqual(smooth.y, fast.y);
});

test('smooth ramps from the previous step target, fast jumps', () => {
    const steps = (transition) => [
        { dur: 10, target: 3, transition: 'fast' },
        { dur: 20, target: 9, transition },
    ];
    assert.deepEqual(channel(steps('smooth')).y, [3, 3, 3, 9]);
    assert.deepEqual(channel(steps('fast')).y,   [3, 3, 9, 9]);
});

test('the ramp spans the whole frame, not a capped fraction of it', () => {
    const { x } = channel([{ dur: 30, target: 8, transition: 'smooth' }]);
    assert.deepEqual(x, [0, 30]);
});

test('x and y stay equal length on every path', () => {
    for (const transition of ['smooth', 'fast', undefined]) {
        const { x, y } = channel([{ dur: 5, target: 2, transition }, { dur: 5, target: 2, transition }]);
        assert.equal(x.length, y.length);
    }
});

// ── readExitDef ─────────────────────────────────────────────────────────────
const exitMatch = source.match(/function readExitDef\(step\) \{[\s\S]*?\r?\n\}/);
assert.ok(exitMatch, 'readExitDef not found in profile_editor.js');
const readExitDef = new Function(`${exitMatch[0]}\nreturn readExitDef;`)();

test('a step with no exit reads as off, not as a 0-bar pressure exit', () => {
    assert.deepEqual(readExitDef({}), { type: 'off', condition: 'over', value: 0 });
    assert.deepEqual(readExitDef({ exit: null }), { type: 'off', condition: 'over', value: 0 });
});

test('legacy and UI-only exit types collapse to off', () => {
    // api.js:934 drops anything that is not pressure/flow at the write boundary,
    // so the editor must not present those as live exits either.
    for (const type of ['off', 'weight', 'time', 'bogus']) {
        assert.equal(readExitDef({ exit: { type, condition: 'under', value: 5 } }).type, 'off');
    }
});

test('a real exit is passed through, with defaults filled in', () => {
    assert.deepEqual(
        readExitDef({ exit: { type: 'flow', condition: 'under', value: 2 } }),
        { type: 'flow', condition: 'under', value: 2 },
    );
    assert.deepEqual(
        readExitDef({ exit: { type: 'pressure' } }),
        { type: 'pressure', condition: 'over', value: 0 },
    );
});

test('off is reachable and leavable in the type cycle', () => {
    // EXIT_TYPES moved into profile-field-limits.js so the legacy-TCL profile
    // importer can share it without importing this DOM-touching module.
    const limitsSource = readFileSync(new URL('../src/modules/profile-field-limits.js', import.meta.url), 'utf8');
    const types = limitsSource.match(/export const EXIT_TYPES\s*=\s*\[([^\]]*)\]/)[1]
        .split(',').map((t) => t.trim().replace(/'/g, ''));
    assert.ok(types.includes('off'), 'off must stay in the cycle so an exit can be cleared');
    // Both tabs cycle with the same modulo step, so every type is reachable.
    const seen = new Set();
    let i = types.indexOf('off');
    for (let n = 0; n < types.length; n++) { i = (i + 1) % types.length; seen.add(types[i]); }
    assert.equal(seen.size, types.length);
});

// ── Exit-off round trip ─────────────────────────────────────────────────────
// Reported bug: set "Exit if" to Off, save, reopen — the step came back reading
// "Pressure is over 0.0 bar". Trace the whole path the profile actually takes.
const apiSource = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const sanMatch = apiSource.match(/function sanitizeProfileForRea\(profileData\) \{[\s\S]*?\n\}/);
assert.ok(sanMatch, 'sanitizeProfileForRea not found in api.js');
const sanitizeProfileForRea = new Function(`${sanMatch[0]}\nreturn sanitizeProfileForRea;`)();

const normMatch = source.match(/function normalizeLegacySteps\(profile\) \{[\s\S]*?\r?\n\}\r?\n/);
assert.ok(normMatch, 'normalizeLegacySteps not found in profile_editor.js');
const normalizeLegacySteps = new Function(`${normMatch[0]}\nreturn normalizeLegacySteps;`)();

test('an exit turned off stays off across save and reload', () => {
    // What the editor holds after tapping the Exit type toggle round to Off.
    const edited = { steps: [{ pump: 'flow', flow: 6, exit: { type: 'off', condition: 'over', value: 0 } }] };

    // Save: the write boundary drops any non-pressure/flow exit.
    const saved = sanitizeProfileForRea(edited);
    assert.equal(saved.steps[0].exit, null);

    // Reload: what comes back off the wire, through the legacy coercion.
    const reloaded = normalizeLegacySteps(JSON.parse(JSON.stringify(saved)));

    // Render: this is where the bug lived — a falsy exit used to fall through to
    // a { pressure, over, 0 } default and display as a live pressure exit.
    assert.deepEqual(readExitDef(reloaded.steps[0]), { type: 'off', condition: 'over', value: 0 });
});

test('a server that omits the exit key entirely also reads as off', () => {
    assert.equal(readExitDef(normalizeLegacySteps({ steps: [{ pump: 'flow', flow: 6 }] }).steps[0]).type, 'off');
});

test('a real exit still survives the same round trip', () => {
    const edited = { steps: [{ pump: 'pressure', pressure: 9, exit: { type: 'flow', condition: 'under', value: 2 } }] };
    const reloaded = normalizeLegacySteps(JSON.parse(JSON.stringify(sanitizeProfileForRea(edited))));
    assert.deepEqual(readExitDef(reloaded.steps[0]), { type: 'flow', condition: 'under', value: 2 });
});

// ── Limiter Tolerance ────────────────────────────────────────────────────────
// Two profile-wide spinners, one per pump type, over a field that lives on each
// step. Three things have to hold: the number shown belongs to a step that
// really carries a limiter; editing it never creates one on a step that had
// none; and a limiter added from a step card inherits the profile's tolerance
// instead of a hardcoded 0.6.
// DEFAULT_LIMITER_RANGE moved into profile-field-limits.js (imported above) so
// the legacy-TCL importer can share it; it's injected below the same way the
// other stubbed dependencies (addFieldTo, createSpinner, ...) are.
const limiterMatch = source.match(/function limitedSteps\(pump\) \{[\s\S]*?\nfunction newLimiterRange\(pump\) \{[\s\S]*?\r?\n\}/);
const toleranceMatch = source.match(/const toleranceField = \(pump, label, unit\) => \{[\s\S]*?\r?\n        \};/);
assert.ok(limiterMatch && toleranceMatch, 'limiter tolerance source not found in profile_editor.js');

// The tab builds the field through addFieldTo/createSpinner; stub both to
// capture what a real render would have shown.
function limiterEditor(steps) {
    const editorState = { profile: { steps } };
    const fields = {};
    const createSpinner = (value, _step, unit, onChange, opts) => ({ value, unit, onChange, ...opts });
    const addFieldTo = (_col, label, spinner) => { fields[label] = spinner; };
    const api = new Function(
        'editorState', 'addFieldTo', 'createSpinner', 'getTranslation', 'leftCol', 'DEFAULT_LIMITER_RANGE',
        `${limiterMatch[0]}\n${toleranceMatch[0]}\nreturn { toleranceField, newLimiterRange, limiterRangeOf };`
    )(editorState, addFieldTo, createSpinner, (x) => x, null, DEFAULT_LIMITER_RANGE);
    api.toleranceField('flow', 'bar-field', 'bar');
    api.toleranceField('pressure', 'mls-field', 'mL/s');
    return { steps, fields, newLimiterRange: api.newLimiterRange };
}

// Live from the shipped library: only step 3 limits, and it holds range 3.0.
const extractamundo = () => [
    { name: 'preinfusion start', pump: 'pressure', limiter: { value: 0.0, range: 1.0 } },
    { name: 'preinfusion',       pump: 'pressure', limiter: { value: 0.0, range: 1.0 } },
    { name: 'dynamic bloom',     pump: 'flow',     limiter: { value: 0.0, range: 1.0 } },
    { name: '6 bar',             pump: 'pressure', limiter: { value: 1.0, range: 3.0 } },
];

test('the tolerance shows the live limiter, not the first step of the pump type', () => {
    const { fields } = limiterEditor(extractamundo());
    assert.equal(fields['mls-field'].value, 3.0);  // was 1.0, step 0's dead limiter
    assert.equal(fields['bar-field'].value, 1.0);
});

test('a profile whose first steps carry no limiter still shows the real one', () => {
    const { fields } = limiterEditor([
        { pump: 'flow', limiter: null },
        { pump: 'pressure', limiter: null },
        { pump: 'pressure', limiter: { value: 4.0, range: 1.0 } },
    ]);
    assert.equal(fields['mls-field'].value, 1.0);  // was the fabricated 0.6
    assert.equal(fields['mls-field'].disabled, false);
});

test('no limiter on a pump type shows 0, disabled — not a 0.6 nobody chose', () => {
    const { fields } = limiterEditor([{ pump: 'flow' }, { pump: 'pressure' }]);
    for (const key of ['bar-field', 'mls-field']) {
        assert.equal(fields[key].value, 0);
        assert.equal(fields[key].disabled, true);
    }
});

test('one pump type can be live while the other is dead', () => {
    const { fields } = limiterEditor([
        { pump: 'flow', limiter: { value: 6.0, range: 0.9 } },
        { pump: 'pressure', limiter: null },
    ]);
    assert.equal(fields['bar-field'].disabled, false);
    assert.equal(fields['bar-field'].value, 0.9);
    assert.equal(fields['mls-field'].disabled, true);
    assert.equal(fields['mls-field'].value, 0);
});

test('editing the tolerance never creates a limiter on a step that had none', () => {
    const steps = [
        { pump: 'pressure', limiter: null },
        { pump: 'pressure', limiter: { value: 4.0, range: 1.0 } },
    ];
    limiterEditor(steps).fields['mls-field'].onChange(2.5);
    assert.equal(steps[0].limiter, null);
    assert.equal(steps[1].limiter.range, 2.5);
    assert.equal(steps[1].limiter.value, 4.0);
});

test('editing one tolerance leaves the other pump and every limiter value alone', () => {
    const steps = extractamundo();
    limiterEditor(steps).fields['mls-field'].onChange(2.0);
    assert.deepEqual(steps.map(s => s.limiter.range), [2.0, 2.0, 1.0, 2.0]);
    assert.deepEqual(steps.map(s => s.limiter.value), [0.0, 0.0, 0.0, 1.0]);
    assert.equal(limiterEditor(steps).fields['mls-field'].value, 2.0);
});

test('a limiter added from a step card inherits the profile tolerance', () => {
    // Gentle and sweet: pressure steps limit at range 1.0. A limiter added to
    // step 0 used to arrive at 0.6, leaving the profile with two ranges.
    const { newLimiterRange } = limiterEditor([
        { pump: 'pressure', limiter: null },
        { pump: 'pressure', limiter: { value: 4.0, range: 1.0 } },
    ]);
    assert.equal(newLimiterRange('pressure'), 1.0);
});

test('with nothing to inherit a new limiter takes the DE1 band, not the 0 on screen', () => {
    // 0 is a real setting — decaid hard-clamps on range <= 0 — so the "none"
    // placeholder must not become the default for a freshly added limiter.
    const { fields, newLimiterRange } = limiterEditor([{ pump: 'flow' }, { pump: 'pressure' }]);
    assert.equal(fields['bar-field'].value, 0);
    assert.equal(newLimiterRange('flow'), 0.6);
});

// ── New-step insertion seeds from the neighbor it's inserted next to ────────
{
    const defaultStepMatch = source.match(/const DEFAULT_STEP = \{[\s\S]*?\r?\n\};/);
    const makeNewStepMatch = source.match(/function makeNewStep\(neighbor\) \{[\s\S]*?\r?\n\}/);
    const insertStepAfterMatch = source.match(/function insertStepAfter\(index\) \{[\s\S]*?\r?\n\}/);
    assert.ok(defaultStepMatch, 'DEFAULT_STEP not found in profile_editor.js');
    assert.ok(makeNewStepMatch, 'makeNewStep not found in profile_editor.js');
    assert.ok(insertStepAfterMatch, 'insertStepAfter not found in profile_editor.js');

    const build = (steps, target_volume_count_start = 0) => {
        const editorState = { profile: { steps, target_volume_count_start } };
        const insertStepAfter = new Function(
            'editorState',
            `const PUMP_SEED_FLOW = 6.0;\n${defaultStepMatch[0]}\n${makeNewStepMatch[0]}\n${insertStepAfterMatch[0]}\nreturn insertStepAfter;`
        )(editorState);
        return { insertStepAfter, editorState };
    };

    test("inserting after a step seeds the new one from that step's values, not the generic default", () => {
        const { insertStepAfter, editorState } = build([
            { name: 'Preinfusion', pump: 'pressure', transition: 'smooth', pressure: 3, temperature: 88, sensor: 'water', seconds: 10, weight: 0, volume: 0, exit: null, limiter: { value: 2, range: 1 } },
        ]);
        insertStepAfter(0);
        const inserted = editorState.profile.steps[1];
        assert.equal(inserted.pump, 'pressure');
        assert.equal(inserted.pressure, 3);
        assert.equal(inserted.temperature, 88);
        assert.equal(inserted.sensor, 'water');
        assert.deepEqual(inserted.limiter, { value: 2, range: 1 });
    });

    test("the inserted step's own name resets, so two steps don't share a label", () => {
        const { insertStepAfter, editorState } = build([{ name: 'Preinfusion' }]);
        insertStepAfter(0);
        assert.equal(editorState.profile.steps[1].name, 'New Step');
    });

    test('inserting a first step into an empty profile falls back to the generic default', () => {
        const { insertStepAfter, editorState } = build([]);
        insertStepAfter(-1); // the "Insert a step" button passes numSteps - 1, which is -1 when empty
        assert.equal(editorState.profile.steps.length, 1);
        assert.equal(editorState.profile.steps[0].pump, 'flow');
        assert.equal(editorState.profile.steps[0].temperature, 93);
    });

    test('mutating the inserted step does not mutate the step it was copied from', () => {
        const { insertStepAfter, editorState } = build([
            { name: 'Preinfusion', pump: 'flow', flow: 2 },
        ]);
        insertStepAfter(0);
        editorState.profile.steps[1].flow = 99;
        assert.equal(editorState.profile.steps[0].flow, 2);
    });
}
