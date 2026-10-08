import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    MT80_ID_PREFIX,
    MT80_MODE_KEYS,
    MT80_RANGES,
    findGrinderSensorId,
    grinderAdapterForId,
    isGrinderSensorEntry,
    mt80SensorFromList,
    mt80SettingsPatch,
    nextMt80Value,
    parseMt80Snapshot,
} from '../src/modules/grinder-control.js';

const MT80_ID = `${MT80_ID_PREFIX}AA:BB:CC:DD:EE:FF`;

test('mt80SensorFromList matches a connected sensor by id prefix in the devices feed', () => {
    const devices = [
        { id: 'X', name: 'DE1', type: 'machine', state: 'connected' },
        { id: MT80_ID, name: 'Bookoo MT80', type: 'sensor', state: 'connected', available: true },
    ];
    assert.equal(mt80SensorFromList(devices), MT80_ID);
    assert.equal(mt80SensorFromList({ devices }), MT80_ID);
    assert.equal(findGrinderSensorId({ devices }), MT80_ID);
});

test('mt80SensorFromList ignores disconnected, unavailable, wrong-type and foreign sensors', () => {
    assert.equal(mt80SensorFromList([{ id: MT80_ID, type: 'sensor', state: 'discovered' }]), null);
    assert.equal(mt80SensorFromList([{ id: MT80_ID, type: 'sensor', state: 'connected', available: false }]), null);
    assert.equal(mt80SensorFromList([{ id: MT80_ID, type: 'scale', state: 'connected' }]), null);
    assert.equal(mt80SensorFromList([{ id: 'plugin:other.reaplugin:x:1', type: 'sensor', state: 'connected' }]), null);
    assert.equal(mt80SensorFromList([{ id: 'abc-milkprobe', type: 'sensor', state: 'connected' }]), null);
    assert.equal(mt80SensorFromList(null), null);
    assert.equal(mt80SensorFromList({}), null);
    assert.equal(mt80SensorFromList([null, 42, {}]), null);
});

test('mt80SensorFromList also accepts the GET /sensors shape (registry presence = connected)', () => {
    assert.equal(mt80SensorFromList([{ id: MT80_ID, info: { name: 'x' } }]), MT80_ID);
});

test('adapter lookup and settings-page filter key on the id prefix', () => {
    assert.ok(grinderAdapterForId(MT80_ID));
    assert.equal(grinderAdapterForId('plugin:other:x:1'), null);
    assert.equal(grinderAdapterForId(undefined), null);
    assert.equal(isGrinderSensorEntry({ id: MT80_ID, type: 'sensor' }), true);
    assert.equal(isGrinderSensorEntry({ id: MT80_ID, type: 'scale' }), false);
    assert.equal(isGrinderSensorEntry({ id: 'other', type: 'sensor' }), false);
});

test('parseMt80Snapshot keeps the 13 typed channels and drops unknown or wrongly typed values', () => {
    const frame = {
        feedingRpm: 40, bladeGap: 250, grindRpm: 900, humidity: 41, devState: 'IDLE', netState: 'NONE',
        totalGrinds: 12, cupDetect: true, autoStop: false, fastClean: false, brightness: 3, standbySec: 120, selectPreset: 1,
    };
    assert.deepEqual(parseMt80Snapshot(frame), frame);
    assert.equal(Object.keys(parseMt80Snapshot(frame)).length, 13);

    assert.deepEqual(parseMt80Snapshot({
        bladeGap: 250.5, feedingRpm: '40', grindRpm: NaN, humidity: Infinity, devState: 7, cupDetect: 1,
        timestamp: 'now', temperature: 90, error: 'not found',
    }), {});
    assert.deepEqual(parseMt80Snapshot({ bladeGap: 300, extra: 1 }), { bladeGap: 300 });
    assert.deepEqual(parseMt80Snapshot(null), {});
    assert.deepEqual(parseMt80Snapshot([1, 2]), {});
    assert.deepEqual(parseMt80Snapshot('x'), {});
});

test('nextMt80Value steps by the published step and clamps at every bound', () => {
    for (const [mode, key] of Object.entries(MT80_MODE_KEYS)) {
        const { min, max, step } = MT80_RANGES[key];
        assert.equal(nextMt80Value(mode, min, -1), min, `${mode} min`);
        assert.equal(nextMt80Value(mode, max, 1), max, `${mode} max`);
        assert.equal(nextMt80Value(mode, min, 1), min + step, `${mode} up from min`);
        assert.equal(nextMt80Value(mode, max, -1) < max, true, `${mode} down from max`);
        assert.equal(nextMt80Value(mode, min - 500, 1), min, `${mode} below range snaps into range`);
        assert.equal(nextMt80Value(mode, max + 500, -1), max, `${mode} above range snaps into range`);
    }
    assert.equal(nextMt80Value('feed', 40, 1), 41);
    assert.equal(nextMt80Value('gap', 250, -1), 249);
    assert.equal(nextMt80Value('spd', 900, 1), 910);
    assert.equal(nextMt80Value('spd', 1500, -1), 1490);
});

test('nextMt80Value snaps an off-grid speed onto the 10 rpm grid', () => {
    assert.equal(nextMt80Value('spd', 905, 1), 910);
    assert.equal(nextMt80Value('spd', 905, -1), 900);
});

test('nextMt80Value rejects unusable input instead of guessing', () => {
    assert.equal(nextMt80Value('nope', 10, 1), null);
    assert.equal(nextMt80Value('gap', undefined, 1), null);
    assert.equal(nextMt80Value('gap', NaN, 1), null);
    assert.equal(nextMt80Value('gap', '250', 1), null);
    assert.equal(nextMt80Value('gap', 250, 0), null);
});

test('mt80SettingsPatch emits only integer, in-range, single-key patches', () => {
    assert.deepEqual(mt80SettingsPatch('gap', 250), { bladeGap: 250 });
    assert.deepEqual(mt80SettingsPatch('feed', 40), { feedingRpm: 40 });
    assert.deepEqual(mt80SettingsPatch('spd', 900), { grindRpm: 900 });
    assert.equal(mt80SettingsPatch('gap', 250.5), null);
    assert.equal(mt80SettingsPatch('gap', '250'), null);
    assert.equal(mt80SettingsPatch('gap', 1000), null);
    assert.equal(mt80SettingsPatch('gap', -1), null);
    assert.equal(mt80SettingsPatch('feed', 9), null);
    assert.equal(mt80SettingsPatch('spd', 499), null);
    assert.equal(mt80SettingsPatch('start', 1), null);
});

test('the adapter writes through the sensor setSettings command', () => {
    const adapter = grinderAdapterForId(MT80_ID);
    assert.deepEqual(adapter.writeCommand('feed', 40), { commandId: 'setSettings', params: { feedingRpm: 40 } });
    assert.equal(adapter.writeCommand('feed', 4000), null);
});

// Source invariants (style of test/device-command.test.mjs).

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('ui.js and settings.js keep Decaid transport behind api.js', () => {
    for (const path of ['../src/modules/ui.js', '../src/settings/settings.js']) {
        const source = read(path);
        assert.doesNotMatch(source, /\/sensors\//, `${path} must not call /sensors/ directly`);
        assert.doesNotMatch(source, /ReconnectingWebSocket\(/, `${path} must not open its own socket`);
    }
});

test('the grinder tile never lets the recipe grind path run while connected', () => {
    const ui = read('../src/modules/ui.js');
    // One dispatcher, wired on the existing grind adjuster, decided at click time.
    assert.match(ui, /updateGrindValue, undefined, handleGrinderStep\)/);
    assert.match(ui, /if \(intercept\?\.\(-1\)\) return;/);
    assert.match(ui, /if \(intercept\?\.\(1\)\) return;/);
    const step = ui.match(/function handleGrinderStep\(dir\) \{[\s\S]*?\r?\n\}/)[0];
    assert.doesNotMatch(step, /updateGrindValue|grind-value/);
    assert.match(step, /return true;/);
});

test('api.js gives the grinder sensor its own socket slot, apart from the milk probe', () => {
    const api = read('../src/modules/api.js');
    assert.match(api, /createSocketSlot\('grinder sensor'\)/);
    assert.match(api, /export function connectGrinderSensorSocket\(/);
    assert.match(api, /export function closeGrinderSensorSocket\(/);
    assert.match(api, /export async function executeSensorCommand\(/);
});
