import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
    const types = source.match(/const EXIT_TYPES\s*=\s*\[([^\]]*)\]/)[1]
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
const limiterMatch = source.match(/const DEFAULT_LIMITER_RANGE[\s\S]*?\nfunction newLimiterRange\(pump\) \{[\s\S]*?\r?\n\}/);
const toleranceMatch = source.match(/const rangeControl = \(pump, unit\) => \{[\s\S]*?\r?\n        \};/);
assert.ok(limiterMatch && toleranceMatch, 'limiter tolerance source not found in profile_editor.js');

// SETTINGS builds each spinner through rangeControl(pump, unit); stub
// createSpinner to capture what a real render would have shown.
function limiterEditor(steps) {
    const editorState = { profile: { steps } };
    const createSpinner = (value, _step, unit, onChange, opts) => ({ value, unit, onChange, ...opts });
    const api = new Function(
        'editorState', 'createSpinner', 'getTranslation',
        `${limiterMatch[0]}\n${toleranceMatch[0]}\nreturn { rangeControl, newLimiterRange, limiterRangeOf };`
    )(editorState, createSpinner, (x) => x);
    const fields = {
        'bar-field': api.rangeControl('flow', 'bar'),
        'mls-field': api.rangeControl('pressure', 'mL/s'),
    };
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

// ── SCRIPT tab: which sentences a step produces (buildStepScript) ────────────
// The prose half of the redesigned SCRIPT tab (Figma node 2662-803) decides
// which lines a step gets, in what order, and with which temperature verb.
// Extracted the same way as everything above, so it can't drift from what the
// tab actually renders. readExitDef is passed in rather than duplicated — the
// exit line's presence is exactly its "is this really off?" answer.
const scriptStart = source.indexOf('// ─── Pure script-line composition');
const scriptEnd = source.indexOf('// ─── End pure script-line composition');
assert.ok(scriptStart !== -1 && scriptEnd !== -1 && scriptEnd > scriptStart, 'pure script-line block not found in profile_editor.js');
const S = new Function('readExitDef', `${source.slice(scriptStart, scriptEnd)}
    return { SCRIPT_MAX_FIELDS, temperatureVerb, buildStepScript, scriptValueFormat };`)(readExitDef);

const kinds = (lines) => lines.map((l) => l.kind);
// A step with nothing optional set: no volume marker, no limiter, no ceilings
// and no exit — so only the two lines every step always has.
const bareStep = (over = {}) => ({ pump: 'flow', flow: 6, temperature: 93, ...over });

test('every step opens with its temperature then its pump line', () => {
    assert.deepEqual(kinds(S.buildStepScript(bareStep(), 0, {}, null)), ['temperature', 'pump']);
});

test('the opening step Sets its temperature; there is nothing to compare it to', () => {
    const [temp] = S.buildStepScript(bareStep({ temperature: 93 }), 0, {}, null);
    assert.equal(temp.verb, 'Set');
});

test('the verb tracks the previous step: Maintain, Increase, Decrease', () => {
    const verbFor = (prev, now) => S.buildStepScript(
        bareStep({ temperature: now }), 1, {}, bareStep({ temperature: prev }),
    )[0].verb;
    assert.equal(verbFor(93, 93), 'Maintain');
    assert.equal(verbFor(88, 93), 'Increase');
    assert.equal(verbFor(93, 88), 'Decrease');
});

test('a previous step with no temperature of its own reads as Set, not Maintain', () => {
    // temperatureVerb takes only a real number as a comparison point —
    // undefined must not compare equal and claim the target is unchanged.
    assert.equal(S.temperatureVerb(undefined, 93), 'Set');
    assert.equal(S.temperatureVerb(null, 93), 'Set');
    assert.equal(S.temperatureVerb(93, 93), 'Maintain');
});

test('an unset limiter, ceiling or exit states nothing — the line is left out', () => {
    const lines = kinds(S.buildStepScript(
        bareStep({ limiter: { value: 0 }, seconds: 0, volume: 0, weight: 0, exit: null }), 0, {}, null,
    ));
    assert.deepEqual(lines, ['temperature', 'pump']);
});

test('a set limiter and a real exit each add their own line', () => {
    const lines = kinds(S.buildStepScript(
        bareStep({ limiter: { value: 3, range: 0.6 }, exit: { type: 'pressure', condition: 'over', value: 4 } }),
        0, {}, null,
    ));
    assert.deepEqual(lines, ['temperature', 'pump', 'limit', 'exit']);
});

test('an exit that readExitDef calls off adds no line', () => {
    // The exit line is the only place a step says "move on if", so it has to
    // agree with readExitDef rather than testing step.exit for truthiness — a
    // legacy { type: 'weight' } exit is off, but it is not falsy.
    const lines = kinds(S.buildStepScript(bareStep({ exit: { type: 'weight', value: 30 } }), 0, {}, null));
    assert.equal(lines.includes('exit'), false);
});

test('the ceilings collapse into one line, in the CARDS row order, skipping unset ones', () => {
    assert.deepEqual(S.SCRIPT_MAX_FIELDS.map((f) => f.key), ['weight', 'seconds', 'volume']);
    const [max] = S.buildStepScript(bareStep({ seconds: 12, volume: 100 }), 0, {}, null)
        .filter((l) => l.kind === 'maximum');
    assert.deepEqual(max.keys, ['seconds', 'volume']);
    const [all] = S.buildStepScript(bareStep({ weight: 36, seconds: 12, volume: 100 }), 0, {}, null)
        .filter((l) => l.kind === 'maximum');
    assert.deepEqual(all.keys, ['weight', 'seconds', 'volume']);
});

// ── Volume-tracking marker placement ────────────────────────────────────────
// target_volume_count_start is "preinfusion ends after step N", 1-based with
// 0 meaning none — so the marker belongs on the step AFTER it.

test('the marker lands on the step after the one preinfusion ends on', () => {
    const profile = { target_volume_count_start: 3 };
    const at = (i) => kinds(S.buildStepScript(bareStep(), i, profile, bareStep()));
    assert.equal(at(2).includes('volumeStart'), false); // step 3 itself — still preinfusion
    assert.equal(at(3)[0], 'volumeStart');              // step 4 — tracking starts here
    assert.equal(at(4).includes('volumeStart'), false);
});

test('"none" puts no marker on step 1, which shares its index-0 falsy value', () => {
    for (const profile of [{}, { target_volume_count_start: 0 }, { target_volume_count_start: null }]) {
        assert.equal(kinds(S.buildStepScript(bareStep(), 0, profile, null)).includes('volumeStart'), false);
    }
});

// ── Value formatting ────────────────────────────────────────────────────────

test('every value keeps one decimal, so a whole number reads 93.0 and not 93', () => {
    assert.equal(S.scriptValueFormat('°C')(93), '93.0 °C');
    assert.equal(S.scriptValueFormat('sec')(2), '2.0 sec');
    assert.equal(S.scriptValueFormat('mL/s')(8.25), '8.3 mL/s');
    assert.equal(S.scriptValueFormat('')(5), '5.0');
});
