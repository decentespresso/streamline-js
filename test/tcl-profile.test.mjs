// Legacy de1app/Visualizer .tcl profile → this app's JSON profile shape.
// src/modules/tcl-profile.js is DOM-free, so it's imported directly rather
// than source-sliced like the tests for profile_editor.js itself.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTclProfile, isLikelyTclProfile } from '../src/modules/tcl-profile.js';

// Mirrors validateProfileStructure()'s requiredKeys in profileManager.js
// (not imported here — that module touches the DOM at load time).
const REQUIRED_PROFILE_KEYS = [
    'title', 'author', 'notes', 'beverage_type', 'steps', 'version',
    'target_volume', 'target_weight', 'target_volume_count_start', 'tank_temperature',
];

function assertValidatesAsProfile(profile) {
    for (const key of REQUIRED_PROFILE_KEYS) {
        assert.ok(Object.prototype.hasOwnProperty.call(profile, key), `missing required key "${key}"`);
    }
    assert.ok(Array.isArray(profile.steps), '"steps" must be an array');
}

// ─── Synthetic fixture builder ─────────────────────────────────────────────
// Real de1app dumps use braces only where a value contains whitespace; bare
// words are fine for everything these edge-case fixtures need.

const BASE_STEP_FIELDS = {
    name: 'Step1',
    pump: 'flow',
    transition: 'fast',
    temperature: '93.0',
    sensor: 'coffee',
    flow: '6.0',
    pressure: '0',
    seconds: '10',
    weight: '0',
    volume: '0',
    exit_if: '0',
    exit_type: 'pressure_over',
    exit_pressure_over: '0',
    exit_pressure_under: '0',
    exit_flow_over: '0',
    exit_flow_under: '0',
    max_flow_or_pressure: '0',
    max_flow_or_pressure_range: '0.6',
};

function buildStep(overrides = {}) {
    const fields = { ...BASE_STEP_FIELDS, ...overrides };
    const removed = new Set(Object.keys(overrides).filter((k) => overrides[k] === undefined));
    const pairs = Object.entries(fields)
        .filter(([k]) => !removed.has(k))
        .map(([k, v]) => `${k} ${v}`);
    return `{${pairs.join(' ')}}`;
}

function buildProfile(topOverrides = {}, steps = [buildStep()]) {
    const top = {
        profile_title: '{Test Profile}',
        author: 'Tester',
        profile_notes: '{Some notes}',
        beverage_type: 'espresso',
        final_desired_shot_volume: '30',
        final_desired_shot_weight: '30',
        final_desired_shot_volume_advanced_count_start: '1',
        tank_desired_water_temperature: '0',
        settings_profile_type: 'settings_2c',
        advanced_shot: `{${steps.join(' ')}}`,
        ...topOverrides,
    };
    const removed = new Set(Object.keys(topOverrides).filter((k) => topOverrides[k] === undefined));
    return Object.entries(top)
        .filter(([k]) => !removed.has(k))
        .map(([k, v]) => `${k} ${v}`)
        .join('\n');
}

// ─── Real sample file, end to end ──────────────────────────────────────────

test('parses the bundled real Visualizer .tcl sample end to end', () => {
    const text = readFileSync(
        new URL('../shots/Visualizer_JW ASL 2 from Visualizer.tcl', import.meta.url),
        'utf8',
    );
    const profile = parseTclProfile(text);
    assertValidatesAsProfile(profile);

    assert.equal(profile.title, 'Visualizer/JW ASL 2');
    assert.equal(profile.author, 'JW');
    assert.equal(profile.beverage_type, 'espresso');
    assert.equal(profile.version, '2');
    assert.equal(profile.target_volume, 32);
    assert.equal(profile.target_weight, 32);
    assert.equal(profile.target_volume_count_start, 0);
    assert.equal(profile.tank_temperature, 0);
    assert.equal(profile.type, 'advanced');
    assert.equal(profile.legacy_profile_type, 'settings_2c');
    assert.ok(profile.notes.includes('advanced spring lever profile'));
    assert.ok(profile.notes.includes('Downloaded from Visualizer'));

    assert.equal(profile.steps.length, 4);

    const [infuse, riseAndHold, decline, flowLimit] = profile.steps;

    assert.deepEqual(infuse, {
        name: 'infuse', pump: 'flow', transition: 'fast', temperature: 96,
        sensor: 'coffee', seconds: 10, weight: 0, volume: 0,
        exit: { type: 'pressure', condition: 'over', value: 6 },
        limiter: null, flow: 8,
    });

    // exit_if 0: exit_type/exit_pressure_over are present but must not surface.
    assert.deepEqual(riseAndHold, {
        name: 'rise and hold', pump: 'pressure', transition: 'fast', temperature: 96,
        sensor: 'coffee', seconds: 3, weight: 0, volume: 0,
        exit: null, limiter: null, pressure: 9,
    });

    // A pressure step's limiter is a flow limit (max_flow_or_pressure_range carried through).
    assert.deepEqual(decline, {
        name: 'decline', pump: 'pressure', transition: 'smooth', temperature: 96,
        sensor: 'coffee', seconds: 30, weight: 0, volume: 0,
        exit: { type: 'pressure', condition: 'under', value: 6 },
        limiter: { value: 1.5, range: 0.6 }, pressure: 6,
    });

    // A flow step's limiter is a pressure limit.
    assert.deepEqual(flowLimit, {
        name: 'flow limit', pump: 'flow', transition: 'smooth', temperature: 96,
        sensor: 'coffee', seconds: 30, weight: 0, volume: 0,
        exit: null, limiter: { value: 6, range: 0.6 }, flow: 1.5,
    });
});

// ─── settings_profile_type variants ────────────────────────────────────────

test('settings_profile_type maps to type: settings_2a→pressure, 2b→flow, 2c→advanced, unknown→advanced', () => {
    const typeOf = (settingsProfileType) => {
        const text = settingsProfileType === undefined
            ? buildProfile({ settings_profile_type: undefined })
            : buildProfile({ settings_profile_type: settingsProfileType });
        return parseTclProfile(text).type;
    };
    assert.equal(typeOf('settings_2a'), 'pressure');
    assert.equal(typeOf('settings_2b'), 'flow');
    assert.equal(typeOf('settings_2c'), 'advanced');
    assert.equal(typeOf('settings_9z_unknown'), 'advanced');
    assert.equal(typeOf(undefined), 'advanced');

    // legacy_profile_type carries the raw value through for round-trip fidelity,
    // but is omitted entirely rather than invented when the file has none.
    const noType = parseTclProfile(buildProfile({ settings_profile_type: undefined }));
    assert.equal('legacy_profile_type' in noType, false);
    const withType = parseTclProfile(buildProfile({ settings_profile_type: 'settings_2a' }));
    assert.equal(withType.legacy_profile_type, 'settings_2a');
});

// ─── Exit condition mapping ─────────────────────────────────────────────────

test('exit_type selects channel and direction from the matching exit_<channel>_<condition> field', () => {
    const cases = [
        ['pressure_over',  'exit_pressure_over',  '7.5', { type: 'pressure', condition: 'over',  value: 7.5 }],
        ['pressure_under', 'exit_pressure_under', '2.5', { type: 'pressure', condition: 'under', value: 2.5 }],
        ['flow_over',      'exit_flow_over',      '3.0', { type: 'flow',     condition: 'over',  value: 3 }],
        ['flow_under',     'exit_flow_under',     '1.0', { type: 'flow',     condition: 'under', value: 1 }],
    ];
    for (const [exitType, thresholdKey, thresholdVal, expected] of cases) {
        const step = buildStep({ exit_if: '1', exit_type: exitType, [thresholdKey]: thresholdVal });
        const profile = parseTclProfile(buildProfile({}, [step]));
        assert.deepEqual(profile.steps[0].exit, expected, `exit_type ${exitType}`);
    }
});

test('exit_if 0 and unrecognized exit_type both produce exit: null rather than a guess', () => {
    const disabled = buildStep({ exit_if: '0', exit_type: 'pressure_over', exit_pressure_over: '9' });
    assert.equal(parseTclProfile(buildProfile({}, [disabled])).steps[0].exit, null);

    const garbage = buildStep({ exit_if: '1', exit_type: 'nonsense', exit_pressure_over: '9' });
    assert.equal(parseTclProfile(buildProfile({}, [garbage])).steps[0].exit, null);

    // exit_if 1 but the matching threshold key itself is blank/missing
    // ('{}' is de1app's own convention for an explicitly-empty value —
    // see e.g. `maximum_flow_range {}` in the bundled sample file).
    const noThreshold = buildStep({ exit_if: '1', exit_type: 'flow_over', exit_flow_over: '{}' });
    assert.equal(parseTclProfile(buildProfile({}, [noThreshold])).steps[0].exit, null);
});

// ─── Limiter ─────────────────────────────────────────────────────────────

test('max_flow_or_pressure 0 or absent is no limiter; a positive value builds one on the opposite axis', () => {
    const zero = buildStep({ max_flow_or_pressure: '0' });
    assert.equal(parseTclProfile(buildProfile({}, [zero])).steps[0].limiter, null);

    const missing = buildStep({ max_flow_or_pressure: undefined });
    assert.equal(parseTclProfile(buildProfile({}, [missing])).steps[0].limiter, null);

    // pump=flow → limiter is a pressure limit.
    const flowStepWithLimiter = buildStep({ pump: 'flow', flow: '5', max_flow_or_pressure: '4', max_flow_or_pressure_range: '0.3' });
    assert.deepEqual(
        parseTclProfile(buildProfile({}, [flowStepWithLimiter])).steps[0].limiter,
        { value: 4, range: 0.3 },
    );

    // pump=pressure → limiter is a flow limit, and a missing range falls back
    // to this app's own DEFAULT_LIMITER_RANGE (0.6).
    const pressureStepWithLimiter = buildStep({ pump: 'pressure', pressure: '6', flow: undefined, max_flow_or_pressure: '3', max_flow_or_pressure_range: undefined });
    assert.deepEqual(
        parseTclProfile(buildProfile({}, [pressureStepWithLimiter])).steps[0].limiter,
        { value: 3, range: 0.6 },
    );
});

// ─── Numeric clamping ───────────────────────────────────────────────────────

test('numeric fields clamp to profile-field-limits bounds instead of trusting the file', () => {
    const hot = buildStep({ temperature: '999' });
    assert.equal(parseTclProfile(buildProfile({}, [hot])).steps[0].temperature, 105); // FIELD_LIMITS.temperature.max

    const overFlow = buildStep({ pump: 'flow', flow: '999', pressure: undefined });
    assert.equal(parseTclProfile(buildProfile({}, [overFlow])).steps[0].flow, 15); // FIELD_LIMITS.flow.max

    const overPressure = buildStep({ pump: 'pressure', pressure: '999', flow: undefined });
    assert.equal(parseTclProfile(buildProfile({}, [overPressure])).steps[0].pressure, 12); // FIELD_LIMITS.pressure.max

    // Exit-condition ceilings are lower than pump-target ceilings (flow: 8 vs 15).
    const overExit = buildStep({ exit_if: '1', exit_type: 'flow_over', exit_flow_over: '999' });
    assert.equal(parseTclProfile(buildProfile({}, [overExit])).steps[0].exit.value, 8); // EXIT_MAX_MAP.flow

    // A limiter clamps to the opposite axis's bound (pressure limit on a flow step maxes at 12).
    const overLimiter = buildStep({ pump: 'flow', flow: '5', max_flow_or_pressure: '999' });
    assert.equal(parseTclProfile(buildProfile({}, [overLimiter])).steps[0].limiter.value, 12); // FIELD_LIMITS.pressureLimit.max
});

// ─── Failure modes ──────────────────────────────────────────────────────────

test('malformed or non-profile input raises rather than returning junk', () => {
    assert.throws(() => parseTclProfile(''), /empty/i);
    assert.throws(() => parseTclProfile('   '), /empty/i);
    assert.throws(() => parseTclProfile(123), /empty/i); // non-string
    assert.throws(() => parseTclProfile('{unbalanced'), /Unbalanced/i);
    assert.throws(() => parseTclProfile('key1 val1 key2'), /odd number/i); // dangling key

    assert.throws(
        () => parseTclProfile(buildProfile({ profile_title: undefined })),
        /profile_title/,
    );
    assert.throws(
        () => parseTclProfile(buildProfile({ advanced_shot: undefined })),
        /advanced_shot/,
    );
    assert.throws(
        () => parseTclProfile(buildProfile({ advanced_shot: '{}' })),
        /no steps/i,
    );
    assert.throws(
        () => parseTclProfile(buildProfile({}, [buildStep({ pump: 'nonsense' })])),
        /pump/i,
    );
    assert.throws(
        () => parseTclProfile(buildProfile({}, [buildStep({ pump: 'flow', flow: undefined })])),
        /flow/i,
    );
    assert.throws(
        () => parseTclProfile(buildProfile({}, [buildStep({ pump: 'pressure', pressure: 'not-a-number' })])),
        /non-numeric/i,
    );
    assert.throws(
        () => parseTclProfile(buildProfile({}, [buildStep({ temperature: undefined })])),
        /temperature/i,
    );
});

// ─── Format sniff used by the upload handler ───────────────────────────────

test('isLikelyTclProfile sniffs on the first non-whitespace character', () => {
    assert.equal(isLikelyTclProfile('profile_title {Foo}\nauthor bar'), true);
    assert.equal(isLikelyTclProfile('  \n  advanced_shot {{}}'), true);
    assert.equal(isLikelyTclProfile('{"title": "Foo"}'), false);
    assert.equal(isLikelyTclProfile('   {"title": "Foo"}'), false);
    assert.equal(isLikelyTclProfile(''), false);
    assert.equal(isLikelyTclProfile(null), false);
    assert.equal(isLikelyTclProfile(undefined), false);
});
