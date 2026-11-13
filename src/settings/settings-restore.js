// What Streamline last knows it put on the machine, kept so a value that
// changes behind its back -- in Decaid's own UI, another skin, on the machine
// itself, or lost to a reset or a firmware update -- can be spotted.
//
// The record is re-read from the machine after every write Streamline makes, so
// anything it disagrees with afterwards came from outside this skin.
//
// Deliberately NOT the settingsBackup written by saveSettingsBackup(): that is a
// snapshot of everything last fetched, which is chronically stale for fields the
// main page edits, and re-applying it would revert the user's own changes. Only
// values the user chose here are recorded, key by key, so nothing is ever
// asserted on the machine that the user did not type.
//
// A difference is nearly always someone's decision, so it is adopted as the new
// remembered value and nothing is written back -- the rule the Workflow resync
// already follows (decideResync, issue #109). Putting the tablet's value back
// meant a fan threshold, purge mode or heater setting changed in Decaid, in
// another skin or by a plugin managing machines remotely was silently reverted
// the next time someone opened this page (issue #172).
//
// The one exception is a machine sitting on exactly what Decaid writes when it
// connects, on a Decaid old enough to overwrite it: that value was lost to the
// reset rather than chosen. See RESET_ON_CONNECT below.
//
// Nothing here writes to the machine; it only sorts the differences.

// Scopes map to the two machine-settings endpoints; `usb` and friends live in
// de1, the MMR-backed values in de1Advanced.
export const RESTORE_SCOPES = Object.freeze(['de1', 'de1Advanced']);

// Heater voltage is excluded: it describes the mains the machine is plugged
// into rather than a preference, only takes effect after a machine restart, and
// re-asserting a stale one from a tablet is the wrong kind of helpful.
export const RESTORE_EXCLUDED_KEYS = Object.freeze({
    de1: Object.freeze([]),
    de1Advanced: Object.freeze(['heaterVoltage']),
});

function isExcluded(scope, key) {
    return (RESTORE_EXCLUDED_KEYS[scope] || []).includes(key);
}

// USB is asked for as 'enable'/'disable' and reported back as a boolean, so the
// raw values never match and every comparison would claim a difference.
// Floats come back from the machine at its own precision, so they compare with
// a tolerance rather than exactly.
const FLOAT_TOLERANCE = 0.005;

export function normalizeSettingValue(key, value) {
    if (key === 'usb') {
        if (value === 'enable' || value === true) return true;
        if (value === 'disable' || value === false) return false;
        return value;
    }
    return value;
}

export function settingValuesMatch(key, saved, actual) {
    const a = normalizeSettingValue(key, saved);
    const b = normalizeSettingValue(key, actual);
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < FLOAT_TOLERANCE;
    return a === b;
}

// The record after a write Streamline just made.
//
// Tracked keys are the ones the user has saved here -- a record covering every
// setting would let the skin assert values they never chose. Their values come
// from what the machine reports afterwards, not from what was asked for, so a
// value the machine clamped, rounded or ignored is stored as the machine
// actually holds it and does not read as an outside change on the next visit.
export function adoptFromMachine(existing, machine, written = {}) {
    const record = { ts: Date.now() };
    for (const scope of RESTORE_SCOPES) {
        const tracked = { ...(existing?.[scope] || {}) };
        for (const [key, value] of Object.entries(written[scope] || {})) {
            if (isExcluded(scope, key)) continue;
            if (value === undefined || value === null) continue;
            tracked[key] = value;
        }
        const actual = machine?.[scope];
        if (actual) {
            for (const key of Object.keys(tracked)) {
                if (actual[key] !== undefined) tracked[key] = actual[key];
            }
        }
        if (Object.keys(tracked).length) record[scope] = tracked;
    }
    return record;
}

// Every recorded setting the machine now disagrees with. A key the machine does
// not report at all is skipped rather than reported as a difference: an older
// firmware that lacks a field has not lost the user's value, it just has no
// opinion about it.
export function diffUserSettings(record, machine) {
    const differences = [];
    for (const scope of RESTORE_SCOPES) {
        const saved = record?.[scope];
        const actual = machine?.[scope];
        if (!saved || !actual) continue;
        for (const [key, value] of Object.entries(saved)) {
            if (isExcluded(scope, key)) continue;
            if (actual[key] === undefined) continue;
            if (!settingValuesMatch(key, value, actual[key])) {
                differences.push({ scope, key, saved: value, actual: actual[key] });
            }
        }
    }
    return differences;
}

// Keys Streamline just asked for that the machine, read back afterwards, does
// not hold. adoptFromMachine records the machine's answer so a refused write
// does not later read as an outside change; this is how the refusal itself is
// surfaced. A key the machine does not report is skipped, as in diffUserSettings.
export function rejectedWrites(written, machine) {
    const rejected = [];
    for (const scope of RESTORE_SCOPES) {
        const actual = machine?.[scope];
        if (!actual) continue;
        for (const [key, asked] of Object.entries(written?.[scope] || {})) {
            if (isExcluded(scope, key)) continue;
            if (asked === undefined || asked === null) continue;
            if (actual[key] === undefined) continue;
            if (!settingValuesMatch(key, asked, actual[key])) {
                rejected.push({ scope, key, asked, actual: actual[key] });
            }
        }
    }
    return rejected;
}

// A numeric setting the machine reports outside the range this page offers for
// it. Lives here rather than in settings.js because it is a decision about a
// value, not about markup, and this module is already DOM-free and covered.
//
// The page shows the real number and marks it, instead of clamping the display:
// a clamped display would claim the machine holds something it does not. Both
// reported sightings were real machine state -- a steam flow of 0 against a
// 0.4-2.5 range, hot water at 40 against 50-95 -- and hiding them is how they
// went unexplained for so long. Editing already clamps (the +/- steppers and
// the numpad both do), so one tap on + is the fix; nothing new is needed to
// resolve it, only to see it.
//
// A value that is absent or unparseable is NOT out of range: nothing known is
// nothing to flag.
export function isOutOfRange(value, min, max) {
    if (!Number.isFinite(value)) return false;
    if (Number.isFinite(min) && value < min) return true;
    if (Number.isFinite(max) && value > max) return true;
    return false;
}

// What a Decaid older than MACHINE_SETTINGS_KEPT_FROM writes to the machine
// every time it connects, whatever the API was told (decaid#1027): the fan
// threshold, and the refill kit to auto, which the API reports as 2
// (De1RefillKitSettings.auto). On those versions a machine found on one of
// these lost the user's value to that reset, so it is put back; anything else
// is somebody's decision and is adopted instead.
//
// The fan has two values because Decaid asks for 55 and a real DE1's register
// write clamps it to 50 (MMRItem.fanThreshold, max 50) while a simulated one
// reports the 55 back. Either reading is the reset, not a choice.
export const RESET_ON_CONNECT = Object.freeze({
    de1: Object.freeze({ fan: Object.freeze([50, 55]) }),
    de1Advanced: Object.freeze({ refillKitSetting: Object.freeze([2]) }),
});

// decaid#1043 makes Decaid remember the fan threshold and refill kit last
// written through the API, per machine, and write those back on connect
// (_setDe1DefaultsFor, machine_settings_store.dart). First release carrying it.
export const MACHINE_SETTINGS_KEPT_FROM = '0.9.1';

// Does this Decaid keep those two values itself? If it does, a machine reading
// 50 or auto was set to it or never changed, and putting the remembered value
// back would undo a deliberate choice -- the very thing issue #172 was about.
//
// An unknown or unparseable version counts as keeping them: adopting a
// difference never destroys a choice, while restoring one can.
export function decaidKeepsMachineSettings(version) {
    const [core, pre] = String(version || '').trim().replace(/^v/i, '').split('+')[0].split('-');
    const nums = core.split('.').map(part => parseInt(part, 10));
    if (!Number.isInteger(nums[0])) return true;
    const wanted = MACHINE_SETTINGS_KEPT_FROM.split('.').map(Number);
    for (let i = 0; i < wanted.length; i++) {
        const d = (nums[i] || 0) - wanted[i];
        if (d !== 0) return d > 0;
    }
    // Exactly MACHINE_SETTINGS_KEPT_FROM: the release has it, its prereleases
    // do not -- decaid#1043 landed after v0.9.1-beta.1.
    return !pre;
}

// Sorts the differences into the ones to write back and the ones to keep.
// `decaidVersion` is what GET /info reports as `version`; see
// decaidKeepsMachineSettings for what an absent one means.
export function splitDifferences(differences, decaidVersion) {
    const restore = [];
    const adopt = [];
    const resetsStillHappen = !decaidKeepsMachineSettings(decaidVersion);
    for (const difference of differences) {
        const resets = resetsStillHappen ? RESET_ON_CONNECT[difference.scope]?.[difference.key] || [] : [];
        const lostToReset = resets.some(reset => settingValuesMatch(difference.key, reset, difference.actual));
        (lostToReset ? restore : adopt).push(difference);
    }
    return { restore, adopt };
}

// The patch that restores the user's values, split by endpoint. Only the keys
// that differ are sent: a restore should touch as little of the machine as it
// can.
export function restorePatches(differences) {
    const patches = {};
    for (const { scope, key, saved } of differences) {
        patches[scope] = patches[scope] || {};
        patches[scope][key] = saved;
    }
    return patches;
}

