import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
    MACHINE_SETTINGS_KEPT_FROM,
    RESET_ON_CONNECT,
    RESTORE_EXCLUDED_KEYS,
    adoptFromMachine,
    decaidKeepsMachineSettings,
    diffUserSettings,
    isOutOfRange,
    rejectedWrites,
    restorePatches,
    settingValuesMatch,
    splitDifferences,
} from '../src/settings/settings-restore.js';

// A Decaid that still resets the fan threshold and the refill kit on connect,
// which is what makes the exception apply at all.
const OLD_DECAID = '0.9.0';

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

// ── Which differences are written back ─────────────────────────────────────
//
// Nearly all of them are somebody's decision -- made in Decaid, in another
// skin, on the machine, or by a plugin managing machines remotely -- and
// writing the tablet's value back silently reverted it (issue #172). Only a
// machine sitting on exactly what Decaid writes on connect lost the value to a
// reset rather than to a choice.

test('a setting changed elsewhere is kept, not written back', () => {
    const { restore, adopt } = splitDifferences([
        { scope: 'de1Advanced', key: 'steamPurgeMode', saved: 2, actual: 0 },
        { scope: 'de1', key: 'fan', saved: 45, actual: 30 },
        { scope: 'de1Advanced', key: 'refillKitSetting', saved: 1, actual: 0 },
    ], OLD_DECAID);
    assert.deepEqual(restore, [], 'nothing is asserted over a deliberate change');
    assert.deepEqual(adopt.map(d => d.key), ['steamPurgeMode', 'fan', 'refillKitSetting']);
});

test('a value an older Decaid resets on connect is put back', () => {
    // The refill kit set to auto (2), and the fan threshold Decaid asks for as
    // 55: a real DE1 clamps that to 50, a simulated one reports 55 (decaid#1027
    // and MMRItem.fanThreshold). Every one of them is a loss, not a choice.
    assert.deepEqual([...RESET_ON_CONNECT.de1.fan], [50, 55]);
    for (const actual of RESET_ON_CONNECT.de1.fan) {
        const { restore, adopt } = splitDifferences([{ scope: 'de1', key: 'fan', saved: 45, actual }], OLD_DECAID);
        assert.deepEqual(adopt, [], `fan ${actual} is the reset value`);
        assert.deepEqual(restorePatches(restore), { de1: { fan: 45 } });
    }
    const kit = splitDifferences([
        { scope: 'de1Advanced', key: 'refillKitSetting', saved: 1, actual: 2 },
    ], OLD_DECAID);
    assert.deepEqual(kit.adopt, []);
    assert.deepEqual(restorePatches(kit.restore), { de1Advanced: { refillKitSetting: 1 } });
});

test('the reset exception covers only its own keys, and not a saved reset value', () => {
    // steamPurgeMode is reset on connect too, but to the Workflow's value
    // rather than a fixed one, so there is no reset value to recognise.
    const { restore } = splitDifferences([
        { scope: 'de1Advanced', key: 'steamPurgeMode', saved: 2, actual: 50 },
        { scope: 'de1Advanced', key: 'fan', saved: 45, actual: 50 },  // fan lives in de1, not here
    ], OLD_DECAID);
    assert.deepEqual(restore, []);
    // A user who chose the reset value themselves has no difference to sort at
    // all, so the exception can never fight their own choice.
    assert.deepEqual(diffUserSettings({ de1: { fan: 50 } }, { de1: { fan: 50 } }), []);
});

test('a restore of a reset value leaves the adopted change to the record', () => {
    // One page load can see both: the write covers the reset key, and the
    // read-back that follows adopts the rest.
    const record = { de1: { fan: 45 }, de1Advanced: { steamPurgeMode: 2 } };
    const machine = { de1: { fan: 50 }, de1Advanced: { steamPurgeMode: 0 } };
    const { restore, adopt } = splitDifferences(diffUserSettings(record, machine), OLD_DECAID);
    assert.deepEqual(restorePatches(restore), { de1: { fan: 45 } });
    assert.deepEqual(adopt.map(d => d.key), ['steamPurgeMode']);
    // What the machine reports after that write is what gets recorded.
    const next = adoptFromMachine(record, { de1: { fan: 45 }, de1Advanced: { steamPurgeMode: 0 } });
    assert.deepEqual(diffUserSettings(next, { de1: { fan: 45 }, de1Advanced: { steamPurgeMode: 0 } }), []);
});

// ── Which Decaid resets them ────────────────────────────────────────────────
//
// decaid#1043 makes Decaid remember the fan threshold and the refill kit last
// written through the API and write those back on connect, so from the first
// release carrying it there is no reset to repair: a machine reading 50 or auto
// was set to it, and putting the remembered value back would undo a deliberate
// choice (issue #179).

test('the exception stops at the Decaid that keeps those values itself', () => {
    const fan = { scope: 'de1', key: 'fan', saved: 45, actual: 50 };
    const kit = { scope: 'de1Advanced', key: 'refillKitSetting', saved: 1, actual: 2 };
    const { restore, adopt } = splitDifferences([fan, kit], MACHINE_SETTINGS_KEPT_FROM);
    assert.deepEqual(restore, [], 'nothing is written back on a Decaid that keeps them');
    assert.deepEqual(adopt.map(d => d.key), ['fan', 'refillKitSetting']);
});

test('decaidKeepsMachineSettings draws the line at the release, not its betas', () => {
    assert.equal(MACHINE_SETTINGS_KEPT_FROM, '0.9.1');
    for (const version of ['0.9.1', 'v0.9.1', '0.9.1+3027', '0.9.2', '0.10.0', '1.0.0']) {
        assert.equal(decaidKeepsMachineSettings(version), true, version);
    }
    // decaid#1043 landed after v0.9.1-beta.1, so the prereleases of the very
    // release that carries it do not have it.
    for (const version of ['0.9.1-beta.1', '0.9.0', '0.9.0-beta.2', '0.8.8']) {
        assert.equal(decaidKeepsMachineSettings(version), false, version);
    }
});

test('an unreadable Decaid version adopts rather than restores', () => {
    // Adopting a difference never destroys a choice; restoring one can. /info
    // failing is not a reason to risk the destructive half.
    for (const version of [undefined, null, '', 'unknown', 'dev']) {
        assert.equal(decaidKeepsMachineSettings(version), true, String(version));
    }
    const { restore } = splitDifferences([{ scope: 'de1', key: 'fan', saved: 45, actual: 50 }]);
    assert.deepEqual(restore, []);
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

test('rejectedWrites reports a usb enable the machine reports back as off', () => {
    const found = rejectedWrites({ de1: { usb: 'enable' } }, { de1: { usb: false } });
    assert.deepEqual(found, [{ scope: 'de1', key: 'usb', asked: 'enable', actual: false }]);
});

test('rejectedWrites ignores a value the machine reports identically', () => {
    assert.deepEqual(rejectedWrites({ de1: { usb: 'enable' } }, { de1: { usb: true } }), []);
});

test('rejectedWrites skips a key the machine does not report', () => {
    assert.deepEqual(rejectedWrites({ de1: { usb: 'enable' }, de1Advanced: { fooBar: 1 } }, { de1: {}, de1Advanced: {} }), []);
});

test('rejectedWrites tolerates a float the machine rounds within FLOAT_TOLERANCE', () => {
    assert.deepEqual(rejectedWrites({ de1Advanced: { flushTemp: 80.001 } }, { de1Advanced: { flushTemp: 80 } }), []);
});

test('isOutOfRange flags the reported steam flow of 0 against a 0.4-2.5 range', () => {
    assert.equal(isOutOfRange(0, 0.4, 2.5), true);
});

test('isOutOfRange flags hot water at 40 against a 50-95 range', () => {
    assert.equal(isOutOfRange(40, 50, 95), true);
});

test('isOutOfRange flags a value above the maximum', () => {
    // Decaid's own HotWaterData default is flow 10 while this skin offers 0.1-8,
    // so this is the disagreement the hint has to surface rather than hide.
    assert.equal(isOutOfRange(10, 0.1, 8), true);
});

test('isOutOfRange accepts the boundaries themselves', () => {
    assert.equal(isOutOfRange(0.4, 0.4, 2.5), false);
    assert.equal(isOutOfRange(2.5, 0.4, 2.5), false);
});

test('isOutOfRange treats an unknown value as nothing to flag', () => {
    for (const v of [undefined, null, NaN, '']) assert.equal(isOutOfRange(v, 0.4, 2.5), false);
});
