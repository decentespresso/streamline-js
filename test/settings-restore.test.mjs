import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
    RESTORE_EXCLUDED_KEYS,
    adoptFromMachine,
    diffUserSettings,
    restorePatches,
    settingValuesMatch,
} from '../src/settings/settings-restore.js';

// ── What gets recorded ──────────────────────────────────────────────────────
//
// The record is what Streamline last knows it put on the machine: tracked keys
// are the ones the user saved here, and their values are re-read from the
// machine afterwards. That is what makes a later difference mean "changed from
// outside this skin" rather than "changed at all".

test('only the keys the user saved are tracked', () => {
    // A record covering every setting would let the skin assert values the user
    // never chose.
    const record = adoptFromMachine(null, { de1: { fan: 45, tankTemp: 60 } }, { de1: { fan: 45 } });
    assert.deepEqual(record.de1, { fan: 45 });
    assert.equal(record.de1Advanced, undefined);
});

test('a later save adds to the record instead of replacing it', () => {
    const machine = { de1: { fan: 45, tankTemp: 60 } };
    const first = adoptFromMachine(null, machine, { de1: { fan: 45 } });
    const second = adoptFromMachine(first, machine, { de1: { tankTemp: 60 } });
    assert.deepEqual(second.de1, { fan: 45, tankTemp: 60 });
});

test('the machine read-back wins over the value that was asked for', () => {
    // A machine that clamps or rounds a write would otherwise disagree with the
    // record the moment it was written, and the next visit would report the
    // skin's own write as an outside change.
    const record = adoptFromMachine(null, { de1: { fan: 40 } }, { de1: { fan: 45 } });
    assert.equal(record.de1.fan, 40);
    assert.deepEqual(diffUserSettings(record, { de1: { fan: 40 } }), []);
});

test('a tracked key the machine stops reporting keeps its recorded value', () => {
    const first = adoptFromMachine(null, { de1: { fan: 45 } }, { de1: { fan: 45 } });
    const second = adoptFromMachine(first, { de1: {} });
    assert.equal(second.de1.fan, 45);
});

test('a reset to defaults is adopted, not queried back at the user', () => {
    // Resetting is this skin's own doing; the defaults become the known state.
    const before = adoptFromMachine(null, { de1: { fan: 45 } }, { de1: { fan: 45 } });
    const afterReset = adoptFromMachine(before, { de1: { fan: 40 } });
    assert.deepEqual(diffUserSettings(afterReset, { de1: { fan: 40 } }), []);
});

test('heater voltage is never tracked', () => {
    // It describes the mains the machine is plugged into, takes effect only
    // after a restart, and must not be re-asserted from a tablet.
    assert.deepEqual(RESTORE_EXCLUDED_KEYS.de1Advanced, ['heaterVoltage']);
    const record = adoptFromMachine(null, { de1Advanced: { heaterVoltage: 1, steamPurgeMode: 2 } },
        { de1Advanced: { heaterVoltage: 1, steamPurgeMode: 2 } });
    assert.deepEqual(record.de1Advanced, { steamPurgeMode: 2 });
});

test('a null or undefined value is not recorded as an intent', () => {
    const record = adoptFromMachine(null, null, { de1: { fan: 45, tankTemp: null, flushTemp: undefined } });
    assert.deepEqual(record.de1, { fan: 45 });
});

// ── What counts as a difference ─────────────────────────────────────────────

test('a machine that lost a saved value is reported', () => {
    const diff = diffUserSettings({ de1: { fan: 45 } }, { de1: { fan: 40 } });
    assert.deepEqual(diff, [{ scope: 'de1', key: 'fan', saved: 45, actual: 40 }]);
});

test('a machine that agrees reports nothing', () => {
    assert.deepEqual(diffUserSettings({ de1: { fan: 45 } }, { de1: { fan: 45 } }), []);
});

test('usb compares across the enable/disable and boolean forms', () => {
    // It is written as 'enable'/'disable' and read back as a boolean, so a raw
    // comparison would claim a difference on every single check.
    assert.ok(settingValuesMatch('usb', 'enable', true));
    assert.ok(settingValuesMatch('usb', 'disable', false));
    assert.ok(!settingValuesMatch('usb', 'enable', false));
    assert.deepEqual(diffUserSettings({ de1: { usb: 'enable' } }, { de1: { usb: true } }), []);
});

test('a float the machine echoes at its own precision is not a difference', () => {
    assert.ok(settingValuesMatch('flushFlow', 2, 2.0001));
    assert.ok(!settingValuesMatch('flushFlow', 2, 2.5));
});

test('a key the machine does not report at all is skipped', () => {
    // Older firmware without a field has not lost the value; it has no opinion.
    assert.deepEqual(diffUserSettings({ de1: { fan: 45 } }, { de1: {} }), []);
});

test('nothing is reported when there is no record or no machine reading', () => {
    assert.deepEqual(diffUserSettings(null, { de1: { fan: 40 } }), []);
    assert.deepEqual(diffUserSettings({ de1: { fan: 45 } }, null), []);
});

// ── Acting on the answer ────────────────────────────────────────────────────

test('a restore writes only the keys that differ, split per endpoint', () => {
    // Restoring should touch as little of the machine as it can.
    const patches = restorePatches([
        { scope: 'de1', key: 'fan', saved: 45, actual: 40 },
        { scope: 'de1Advanced', key: 'steamPurgeMode', saved: 2, actual: 0 },
    ]);
    assert.deepEqual(patches, { de1: { fan: 45 }, de1Advanced: { steamPurgeMode: 2 } });
});

test('keeping an outside change adopts it, so it is asked about once', () => {
    const record = { de1: { fan: 45, tankTemp: 60 } };
    const machine = { de1: { fan: 40, tankTemp: 60 } };
    assert.equal(diffUserSettings(record, machine).length, 1);
    const next = adoptFromMachine(record, machine);
    assert.equal(next.de1.fan, 40);
    assert.equal(next.de1.tankTemp, 60, 'settings that matched are left alone');
    assert.deepEqual(diffUserSettings(next, machine), []);
});

// ── The DE1's own ceiling on the fan threshold ──────────────────────────────
//
// MMRItem.fanThreshold in Decaid declares min 0, max 50. A higher write is
// accepted (202) and silently clamped: the machine keeps 50 and reports 50
// back, while the page went on showing what was typed. The Fan Threshold page
// advertised "Range: 0 – 100°C" and its steppers walked to 100, so a user could
// set 60, save, and find their value had not applied.

const settingsSource = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');

test('the fan threshold ceiling matches the machine, not the old 0-100 range', () => {
    assert.match(settingsSource, /const FAN_THRESHOLD_MAX = 50;/);
});

test('every fan control and its copy uses that ceiling', () => {
    // A stepper, a numpad range, an input element and two sentences all stated
    // the range separately; one left at 100 puts the bug straight back.
    const fanClamps = settingsSource.match(/Math\.min\(FAN_THRESHOLD_MAX, newValue\)/g) || [];
    assert.equal(fanClamps.length, 2, 'both the calibration and quick steppers clamp');
    assert.match(settingsSource, /calibFanInput:\s*\{[^}]*max: FAN_THRESHOLD_MAX/);
    assert.match(settingsSource, /min="0" max="\$\{FAN_THRESHOLD_MAX\}"/);
    assert.doesNotMatch(settingsSource, /Range: 0 – 100°C/);
    assert.doesNotMatch(settingsSource, /fan turns on \(0–100°C\)/);
});

test('the fan numpad is labelled in degrees, not percent', () => {
    // It was '%', which also made the numpad skip the °C/°F conversion that
    // attachSettingsNumpad applies to temperature fields.
    assert.match(settingsSource, /calibFanInput:\s*\{[^}]*unit: '°C'/);
});
