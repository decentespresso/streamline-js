// Converts a legacy de1app `.tcl` profile (the flat Tcl key/value "savevars"
// dump de1app writes for a profile, and that the Visualizer exports in the
// same shape) into this app's JSON profile shape — the same shape
// validateProfileStructure() checks and reloadEditorWithProfile() consumes.
//
// Pure, DOM-free module: no `window`, `document`, `localStorage`, or
// IndexedDB access, so `node --test` can import it directly. profile_editor.js
// is the only caller; it must not see Tcl.
//
// ─── Format ─────────────────────────────────────────────────────────────────
// A de1app profile dump is a flat sequence of `key value key value ...`
// tokens (a Tcl list). A value is either a bare word or a `{...}`-braced
// span — braces can nest and can contain literal newlines (e.g. multi-line
// notes), so this does not parse line-by-line; it tokenizes the whole file as
// one Tcl list.
//
// `advanced_shot`'s value is itself a Tcl list of one `{...}` per step, and
// each step is itself a flat key/value dict. Steps are read from
// `advanced_shot` whenever it has any.
//
// ─── Simple (settings_2a/settings_2b) profiles ─────────────────────────────
// A de1app "simple" pressure/flow profile can ship with `advanced_shot {}`
// empty — the shot only exists as the simple-mode knobs (`preinfusion_time`,
// `espresso_pressure`, `espresso_hold_time`, `espresso_decline_time`,
// `pressure_end`, `flow_profile_*`, `maximum_flow`/`maximum_pressure`, …).
// Every read-only profile de1app bundles is like this, including "Best
// overall pressure profile". de1app expands those knobs into frames at load
// time (profile.tcl, pressure_to_advanced_list / flow_to_advanced_list);
// expandSimpleShot() below mirrors that expansion frame for frame, so such a
// file imports as the same shot de1app would run instead of being rejected
// for having no steps.
//
// ─── Required vs. defaulted fields ─────────────────────────────────────────
// Throws (abort, no partial import) when a field has no honest default:
//   - profile_title missing/empty — nothing to call the profile.
//   - advanced_shot missing/empty *and* the profile is not a simple
//     (settings_2a/settings_2b) one we can expand — no shot to run.
//   - a step's `pump` is not exactly "pressure" or "flow" — can't tell which
//     target field (pressure/flow) applies.
//   - the target field implied by that pump (`pressure` or `flow`) is
//     missing/blank/non-numeric — no safe number to invent for "how hard the
//     pump runs".
//   - a step's `temperature` is missing/blank/non-numeric — de1app writes
//     this on every step it has ever produced; its absence means the file
//     was hand-truncated or is not really this format.
//
// Defaulted, because de1app itself either always omits these or already uses
// the same sentinel we default to:
//   - author, profile_notes → '' (a de1app profile can legitimately have
//     never had either filled in; the editor already treats '' as "unset").
//   - version → '2' (de1app has no such concept; every JSON profile shipped
//     in src/profiles/ carries "version": "2", including ones converted from
//     this exact Tcl format).
//   - tank_desired_water_temperature, final_desired_shot_weight,
//     final_desired_shot_volume → 0 (0 is de1app's own "no override"/"no
//     target" sentinel for these fields, not a fabricated number).
//   - final_desired_shot_volume_advanced_count_start → 0 (0 = "None", the
//     same sentinel target_volume_count_start already uses in this app).
//   - a step's name/transition/sensor/seconds/weight/volume → '', 'fast',
//     'coffee', 0, 0, 0 respectively — de1app's own UI defaults, and 0 is
//     already this app's "off" sentinel for seconds/weight/volume (see
//     profile_editor.js's offWhenZero step fields).
//   - exit_if enabled but exit_type doesn't parse to a recognized
//     "<pressure|flow>_<over|under>", or its matching exit_<channel>_<cond>
//     value is missing/non-numeric → exit: null. We decline to guess which
//     channel/direction was meant rather than fabricate a live exit
//     condition the file did not clearly specify (see readExitDef's comment
//     in profile_editor.js for why a fabricated exit is actively harmful).
//   - max_flow_or_pressure missing or <= 0 → limiter: null (0 is de1app's
//     own "no limiter" sentinel, matching this app's own convention).
//   - max_flow_or_pressure_range missing/non-numeric while a limiter *is*
//     present → DEFAULT_LIMITER_RANGE (this app's own fallback for "a
//     limiter with no recorded tolerance").
//
// Not mapped at all: `popup` (a step-level de1app popup message; this app has
// no equivalent surface) and every "simple mode" knob listed above.

import { FIELD_LIMITS, EXIT_MAX_MAP, DEFAULT_LIMITER_RANGE } from './profile-field-limits.js';

const BEVERAGE_TYPES = ['espresso', 'calibrate', 'cleaning', 'manual', 'pourover'];

// settings_profile_type → this app's informational type/legacy_profile_type
// fields. Both are stripped by api.js before any save/upload (sanitizeProfileForRea
// and updateWorkflow both delete them), so this is purely for round-trip
// fidelity with what a real exported JSON profile carries — it has no effect
// on how the profile behaves. settings_2c is de1app's "advanced" (full step
// list) mode; settings_2a/settings_2b are its "simple" pressure/flow modes.
// Unrecognized or absent falls back to 'advanced', since steps are always
// read from advanced_shot regardless of the declared mode.
const PROFILE_TYPE_MAP = {
    settings_2a: 'pressure',
    settings_2b: 'flow',
    settings_2c: 'advanced',
};

// Pre-v2 spellings de1app still accepts (profile.tcl's fix_profile_type).
const LEGACY_TYPE_ALIASES = {
    settings_2: 'settings_2a',
    settings_profile_pressure: 'settings_2a',
    settings_profile_flow: 'settings_2b',
};

// ─── Tokenizer ──────────────────────────────────────────────────────────────
// Tokenizes a Tcl list: whitespace-separated words, where a `{...}` span
// (braces may nest, and may contain literal whitespace/newlines) is one
// token. This is the one grammar de1app's savevars dumps use for both the
// top-level file and every nested dict (advanced_shot, and each step inside
// it), so a single tokenizer serves both.
function tokenizeTclList(str) {
    const tokens = [];
    const n = str.length;
    let i = 0;
    while (i < n) {
        const c = str[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        if (c === '{') {
            let depth = 1;
            const start = i + 1;
            i++;
            while (i < n && depth > 0) {
                if (str[i] === '{') depth++;
                else if (str[i] === '}') depth--;
                if (depth > 0) i++;
            }
            if (depth !== 0) {
                throw new Error('Unbalanced { in TCL profile.');
            }
            tokens.push(str.slice(start, i));
            i++; // consume the closing brace
            continue;
        }
        const start = i;
        while (i < n && !/\s/.test(str[i])) i++;
        tokens.push(str.slice(start, i));
    }
    return tokens;
}

// A Tcl list of `key value key value ...` → { key: rawValueString }.
function parseTclDict(str) {
    const tokens = tokenizeTclList(str);
    if (tokens.length % 2 !== 0) {
        throw new Error('TCL profile has an odd number of key/value tokens.');
    }
    const dict = {};
    for (let i = 0; i < tokens.length; i += 2) {
        dict[tokens[i]] = tokens[i + 1];
    }
    return dict;
}

// ─── Small read helpers ─────────────────────────────────────────────────────

function clampField(value, lim) {
    if (lim.min !== undefined && value < lim.min) return lim.min;
    if (lim.max !== undefined && value > lim.max) return lim.max;
    return value;
}

function getNum(raw, fallback) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
}

function requireNum(raw, label) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        throw new Error(`TCL profile is missing a value for ${label}.`);
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) {
        throw new Error(`TCL profile has a non-numeric value for ${label}: "${raw}".`);
    }
    return n;
}

function mapBeverageType(raw) {
    const v = (raw || '').trim().toLowerCase();
    return BEVERAGE_TYPES.includes(v) ? v : 'espresso';
}

// exit_if 1 selects exit_type (e.g. "pressure_over"), whose threshold lives in
// the matching exit_<channel>_<condition> key (e.g. exit_pressure_over) — the
// other three exit_*_over/under keys on the step are stale/irrelevant.
function parseExit(step, ctx) {
    const enabled = getNum(step.exit_if, 0) === 1;
    if (!enabled) return null;

    const rawType = (step.exit_type || '').trim().toLowerCase();
    const match = /^(pressure|flow)_(over|under)$/.exec(rawType);
    if (!match) return null; // unrecognized exit_type: decline to guess a channel/direction

    const [, channel, condition] = match;
    const raw = step[`exit_${channel}_${condition}`];
    if (raw === undefined || String(raw).trim() === '') return null;
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) return null;

    return {
        type: channel,
        condition,
        value: clampField(value, { min: 0, max: EXIT_MAX_MAP[channel] }),
    };
}

// max_flow_or_pressure is a flow limit on a pressure step, or a pressure
// limit on a flow step — same axis-flip the editor's own LIM_LIM uses.
function parseLimiter(step, pump) {
    const value = getNum(step.max_flow_or_pressure, 0);
    if (value <= 0) return null; // 0/absent is de1app's own "no limiter" sentinel
    const lim = pump === 'flow' ? FIELD_LIMITS.pressureLimit : FIELD_LIMITS.flowLimit;
    const range = getNum(step.max_flow_or_pressure_range, DEFAULT_LIMITER_RANGE);
    return { value: clampField(value, lim), range };
}

function parseStep(rawStepStr, index) {
    return parseStepDict(parseTclDict(rawStepStr), index);
}

function parseStepDict(step, index) {
    const ctx = `step ${index + 1}`;

    const pump = (step.pump || '').trim().toLowerCase();
    if (pump !== 'pressure' && pump !== 'flow') {
        throw new Error(`TCL profile ${ctx} has no valid "pump" (expected pressure or flow).`);
    }

    const transition = (step.transition || '').trim().toLowerCase() === 'smooth' ? 'smooth' : 'fast';
    const sensor = (step.sensor || '').trim().toLowerCase() === 'water' ? 'water' : 'coffee';

    const temperature = clampField(requireNum(step.temperature, `${ctx} temperature`), FIELD_LIMITS.temperature);

    const targetLim = pump === 'flow' ? FIELD_LIMITS.flow : FIELD_LIMITS.pressure;
    const target = clampField(requireNum(step[pump], `${ctx} ${pump}`), targetLim);

    const out = {
        name: step.name !== undefined ? step.name : '',
        pump,
        transition,
        temperature,
        sensor,
        seconds: clampField(getNum(step.seconds, 0), FIELD_LIMITS.seconds),
        weight: clampField(getNum(step.weight, 0), FIELD_LIMITS.weight),
        volume: clampField(getNum(step.volume, 0), FIELD_LIMITS.volume),
        exit: parseExit(step, ctx),
        limiter: parseLimiter(step, pump),
    };
    // Exclusive target field, matching this app's own step shape (see
    // profile_editor.js's pump-mode toggle, which deletes the other one).
    if (pump === 'flow') out.flow = target;
    else out.pressure = target;

    return out;
}

// ─── Simple-profile expansion ───────────────────────────────────────────────
// Mirrors de1app profile.tcl's pressure_to_advanced_list (settings_2a) and
// flow_to_advanced_list (settings_2b): the frames de1app itself builds from
// the simple-mode knobs when it loads such a profile. Returns
// { steps, countStart } of step dicts in parseStepDict()'s input shape.
//
// Deliberate deviation: de1app guards its flow-profile decline frame on
// espresso_hold_time (a copy/paste slip — every other branch guards on its
// own duration), which both drops the decline of a hold-less flow profile and
// appends a 0-second decline when decline_time is 0. We guard on
// espresso_decline_time, so what you see is the shot the knobs describe.
function expandSimpleShot(top, kind) {
    const steps = [];
    let countStart = 0;

    const tempSteps = getNum(top.espresso_temperature_steps_enabled, 0) === 1;
    const baseTemp = getNum(top.espresso_temperature, 90);
    const temp = (n) => (tempSteps ? getNum(top[`espresso_temperature_${n}`], baseTemp) : baseTemp);

    const preinfusionTime = getNum(top.preinfusion_time, 0);
    const bump = tempSteps ? getNum(top.temp_bump_time_seconds, 2) : 0;
    const boostLen = bump;
    const preinfusionLen = Math.max(0, preinfusionTime - bump);

    // The limiter knob flips axis with the pump: a flow cap on pressure
    // frames, a pressure cap on flow frames. 0/absent means "no limit".
    const limitValue = kind === 'pressure' ? getNum(top.maximum_flow, 0) : getNum(top.maximum_pressure, 0);
    const limitRange = kind === 'pressure'
        ? getNum(top.maximum_flow_range_default, DEFAULT_LIMITER_RANGE)
        : getNum(top.maximum_pressure_range_default, DEFAULT_LIMITER_RANGE);
    const limited = (step) => (limitValue > 0
        ? { ...step, max_flow_or_pressure: limitValue, max_flow_or_pressure_range: limitRange }
        : step);

    const preinfusion = (name, seconds, temperature) => ({
        name, temperature, sensor: 'coffee', pump: 'flow', transition: 'fast',
        flow: getNum(top.preinfusion_flow_rate, 0), seconds, volume: 0, weight: 0,
        exit_if: 1, exit_type: 'pressure_over',
        exit_pressure_over: getNum(top.preinfusion_stop_pressure, 0),
    });

    if (boostLen > 0) {
        steps.push(preinfusion(kind === 'pressure' ? 'preinfusion temp boost' : 'preinfusion boost', boostLen, temp(0)));
        countStart++;
    }
    if (preinfusionLen > 0) {
        steps.push(preinfusion('preinfusion', preinfusionLen, temp(1)));
        countStart++;
    }

    let holdTime = getNum(top.espresso_hold_time, 0);
    let declineTime = getNum(top.espresso_decline_time, 0);

    if (kind === 'pressure') {
        const rise = (temperature) => limited({
            name: 'forced rise', temperature, sensor: 'coffee', pump: 'pressure', transition: 'fast',
            pressure: getNum(top.espresso_pressure, 0), seconds: 3, volume: 0, weight: 0, exit_if: 0,
        });
        if (holdTime > 0) {
            if (holdTime > 3) {
                // Pressurising the headspace, not pouring: counts as preinfusion
                // so stop-at-volume does not start counting during the rise.
                steps.push(rise(temp(2)));
                countStart++;
                holdTime -= 3;
            }
            steps.push(limited({
                name: 'rise and hold', temperature: temp(2), sensor: 'coffee', pump: 'pressure', transition: 'fast',
                pressure: getNum(top.espresso_pressure, 0), seconds: holdTime, volume: 0, weight: 0, exit_if: 0,
            }));
        }
        if (declineTime > 0) {
            if (holdTime < 3 && declineTime > 3) { // decline-first profile: it still has to get up to pressure
                steps.push(rise(temp(3)));
                countStart++;
                declineTime -= 3;
            }
            steps.push(limited({
                name: 'decline', temperature: temp(3), sensor: 'coffee', pump: 'pressure', transition: 'smooth',
                pressure: getNum(top.pressure_end, 0), seconds: declineTime, volume: 0, weight: 0, exit_if: 0,
            }));
        }
    } else {
        if (holdTime > 0) {
            steps.push(limited({
                name: 'hold', temperature: temp(2), sensor: 'coffee', pump: 'flow', transition: 'fast',
                flow: getNum(top.flow_profile_hold, 0), seconds: holdTime, volume: 0, weight: 0, exit_if: 0,
            }));
        }
        if (declineTime > 0) {
            steps.push(limited({
                name: 'decline', temperature: temp(3), sensor: 'coffee', pump: 'flow', transition: 'smooth',
                flow: getNum(top.flow_profile_decline, 0), seconds: declineTime, volume: 0, weight: 0, exit_if: 0,
            }));
        }
    }

    if (steps.length === 0) {
        // de1app's own placeholder for "every duration is zero" — an importable
        // profile the user can edit, rather than a failed import.
        steps.push({
            name: 'empty', temperature: 90, sensor: 'coffee', pump: 'flow', transition: 'smooth',
            flow: 0, seconds: 0, volume: 0, weight: 0, exit_if: 0,
        });
        countStart = 0;
    }

    return { steps, countStart };
}

/**
 * Parse a de1app/Visualizer-format `.tcl` profile's text into this app's JSON
 * profile shape. Throws with a descriptive message on any malformed or
 * non-profile input rather than returning a partial/guessed result.
 *
 * @param {string} text - raw contents of the uploaded .tcl file.
 * @returns {object} a profile object shaped like validateProfileStructure() expects.
 */
export function parseTclProfile(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('TCL profile file is empty.');
    }

    const top = parseTclDict(text);

    const title = (top.profile_title || '').trim();
    if (!title) {
        throw new Error('TCL profile is missing "profile_title".');
    }

    const rawType = (top.settings_profile_type || '').trim();
    const settingsProfileType = LEGACY_TYPE_ALIASES[rawType] || rawType;
    const type = PROFILE_TYPE_MAP[settingsProfileType] || 'advanced';

    const stepStrings = top.advanced_shot === undefined ? [] : tokenizeTclList(top.advanced_shot);
    let steps;
    let countStart = Math.trunc(getNum(top.final_desired_shot_volume_advanced_count_start, 0));
    if (stepStrings.length > 0) {
        steps = stepStrings.map((s, i) => parseStep(s, i));
    } else if (type === 'pressure' || type === 'flow') {
        // Simple profile with no stored frames: build the ones de1app builds.
        const expanded = expandSimpleShot(top, type);
        steps = expanded.steps.map((s, i) => parseStepDict(s, i));
        countStart = expanded.countStart;
    } else if (top.advanced_shot === undefined) {
        throw new Error('TCL profile is missing "advanced_shot" (no steps found).');
    } else {
        throw new Error('TCL profile\'s "advanced_shot" contains no steps.');
    }

    const profile = {
        title,
        author: top.author !== undefined ? top.author : '',
        notes: top.profile_notes !== undefined ? top.profile_notes : '',
        beverage_type: mapBeverageType(top.beverage_type),
        steps,
        version: '2',
        target_volume: getNum(top.final_desired_shot_volume, 0),
        target_weight: getNum(top.final_desired_shot_weight, 0),
        target_volume_count_start: countStart,
        tank_temperature: getNum(top.tank_desired_water_temperature, 0),
    };
    if (settingsProfileType) profile.legacy_profile_type = settingsProfileType;
    profile.type = type;

    return profile;
}

// Cheap format sniff for the upload handler: a JSON profile's first
// non-whitespace character is always '{'; a de1app Tcl dump's never is (its
// first token is a bare key like "advanced_shot" or "profile_title").
export function isLikelyTclProfile(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trimStart();
    return trimmed.length > 0 && trimmed[0] !== '{';
}
