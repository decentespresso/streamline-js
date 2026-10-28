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
// The exception is a machine sitting on exactly what Decaid writes when it
// connects: that value was lost to the reset rather than chosen. See
// RESET_ON_CONNECT below.
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

// What Decaid writes to the machine every time it connects, whatever the API
// was told (decaid#1027): the fan threshold, and the refill kit to auto, which
// the API reports as 2 (De1RefillKitSettings.auto). A machine found on one of
// these lost the user's value to that reset, so it is put back; anything else
// is somebody's decision and is adopted instead.
//
// The fan has two values because Decaid asks for 55 and a real DE1's register
// write clamps it to 50 (MMRItem.fanThreshold, max 50) while a simulated one
// reports the 55 back. Either reading is the reset, not a choice.
//
// decaid#1043 makes Decaid keep what was last written through the API, so this
// exception can go once a release carrying it is what people run. It was merged
// after v0.9.1-beta.1, so no release has it yet.
export const RESET_ON_CONNECT = Object.freeze({
    de1: Object.freeze({ fan: Object.freeze([50, 55]) }),
    de1Advanced: Object.freeze({ refillKitSetting: Object.freeze([2]) }),
});

// Sorts the differences into the ones to write back and the ones to keep.
export function splitDifferences(differences) {
    const restore = [];
    const adopt = [];
    for (const difference of differences) {
        const resets = RESET_ON_CONNECT[difference.scope]?.[difference.key] || [];
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

