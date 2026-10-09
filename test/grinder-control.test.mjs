import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    MT80_ID_PREFIX,
    MT80_MODES,
    MT80_MODE_KEYS,
    MT80_RANGES,
    findGrinderId,
    grinderAdapterForId,
    isGrinderEntry,
    mt80GrinderFromList,
    mt80SettingsPatch,
    nextMt80Value,
    parseMt80Snapshot,
} from '../src/modules/grinder-control.js';

const MT80_ID = `${MT80_ID_PREFIX}AA:BB:CC:DD:EE:FF`;

test('mt80GrinderFromList matches a connected grinder by id prefix in the devices feed', () => {
    const devices = [
        { id: 'X', name: 'DE1', type: 'machine', state: 'connected' },
        { id: MT80_ID, name: 'Bookoo MT80', type: 'grinder', state: 'connected', available: true },
    ];
    assert.equal(mt80GrinderFromList(devices), MT80_ID);
    assert.equal(mt80GrinderFromList({ devices }), MT80_ID);
    assert.equal(findGrinderId({ devices }), MT80_ID);
});

test('mt80GrinderFromList ignores disconnected, unavailable, wrong-type and foreign devices', () => {
    assert.equal(mt80GrinderFromList([{ id: MT80_ID, type: 'grinder', state: 'discovered' }]), null);
    assert.equal(mt80GrinderFromList([{ id: MT80_ID, type: 'grinder', state: 'connected', available: false }]), null);
    // The plugin used to register this device as a sensor; that no longer counts.
    assert.equal(mt80GrinderFromList([{ id: MT80_ID, type: 'sensor', state: 'connected' }]), null);
    assert.equal(mt80GrinderFromList([{ id: MT80_ID, type: 'scale', state: 'connected' }]), null);
    assert.equal(mt80GrinderFromList([{ id: 'plugin:other.reaplugin:x:1', type: 'grinder', state: 'connected' }]), null);
    assert.equal(mt80GrinderFromList([{ id: 'abc-milkprobe', type: 'sensor', state: 'connected' }]), null);
    assert.equal(mt80GrinderFromList(null), null);
    assert.equal(mt80GrinderFromList({}), null);
    assert.equal(mt80GrinderFromList([null, 42, {}]), null);
});

test('adapter lookup and settings-page filter key on the id prefix', () => {
    assert.ok(grinderAdapterForId(MT80_ID));
    assert.equal(grinderAdapterForId('plugin:other:x:1'), null);
    assert.equal(grinderAdapterForId(undefined), null);
    assert.equal(isGrinderEntry({ id: MT80_ID, type: 'grinder' }), true);
    assert.equal(isGrinderEntry({ id: MT80_ID, type: 'sensor' }), false);
    assert.equal(isGrinderEntry({ id: 'other', type: 'grinder' }), false);
});

test('parseMt80Snapshot maps the grinder snapshot onto the tile keys', () => {
    assert.deepEqual(parseMt80Snapshot({ state: 'idle', setting: '180', rpm: 1290 }), {
        bladeGap: 180,
        grindRpm: 1290,
    });
    // `setting` is a string on the wire and is converted.
    assert.deepEqual(parseMt80Snapshot({ state: 'grinding', setting: '0', rpm: 500 }), {
        bladeGap: 0,
        grindRpm: 500,
    });
});

test('parseMt80Snapshot never invents a value for the Feed row', () => {
    // The grinder contract has no feed channel, so no frame can fill it.
    for (const frame of [
        { state: 'idle', setting: '180', rpm: 1290 },
        { state: 'idle', feedingRpm: 40, setting: '180', rpm: 1290 },
    ]) {
        assert.equal('feedingRpm' in parseMt80Snapshot(frame), false);
    }
});

test('parseMt80Snapshot drops unknown keys and unusable values', () => {
    assert.deepEqual(parseMt80Snapshot({
        state: 'idle', setting: 'abc', rpm: 900.5, temperature: 90, error: 'not found',
    }), {});
    assert.deepEqual(parseMt80Snapshot({ setting: '' }), {});
    assert.deepEqual(parseMt80Snapshot({ setting: '  ' }), {});
    assert.deepEqual(parseMt80Snapshot({ setting: 180 }), {});
    assert.deepEqual(parseMt80Snapshot({ rpm: '1290' }), {});
    assert.deepEqual(parseMt80Snapshot({ setting: '300', extra: 1 }), { bladeGap: 300 });
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

test('mt80SettingsPatch names the grinder field and the wire type it needs', () => {
    // `setting` is a string on the grinder API; `rpm` is an integer.
    assert.deepEqual(mt80SettingsPatch('gap', 250), { field: 'setting', value: '250' });
    assert.deepEqual(mt80SettingsPatch('spd', 900), { field: 'rpm', value: 900 });
    assert.equal(mt80SettingsPatch('gap', 250.5), null);
    assert.equal(mt80SettingsPatch('gap', '250'), null);
    assert.equal(mt80SettingsPatch('gap', 1000), null);
    assert.equal(mt80SettingsPatch('gap', -1), null);
    assert.equal(mt80SettingsPatch('spd', 499), null);
    assert.equal(mt80SettingsPatch('start', 1), null);
});

test('the Feed row has no grinder write at all', () => {
    // feedingRpm is absent from the grinder contract, so the row cannot be
    // stepped and must never produce a write.
    assert.equal(mt80SettingsPatch('feed', 40), null);
    assert.equal(mt80SettingsPatch('feed', 4000), null);
});

test('the adapter writes through the grinder fields', () => {
    const adapter = grinderAdapterForId(MT80_ID);
    assert.deepEqual(adapter.writeCommand('gap', 180), { field: 'setting', value: '180' });
    assert.deepEqual(adapter.writeCommand('spd', 1290), { field: 'rpm', value: 1290 });
    assert.equal(adapter.writeCommand('feed', 40), null);
    assert.equal(adapter.writeCommand('gap', 4000), null);
});

test('the tile keeps its three rows, Feed included', () => {
    assert.deepEqual(MT80_MODES, ['gap', 'feed', 'spd']);
});

// Source invariants (style of test/device-command.test.mjs).

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('ui.js and settings.js keep Decaid transport behind api.js', () => {
    for (const path of ['../src/modules/ui.js', '../src/settings/settings.js']) {
        const source = read(path);
        assert.doesNotMatch(source, /\/sensors\//, `${path} must not call /sensors/ directly`);
        assert.doesNotMatch(source, /\/grinder\//, `${path} must not call /grinder/ directly`);
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

test('api.js gives the grinder its own socket slot, apart from the milk probe', () => {
    const api = read('../src/modules/api.js');
    assert.match(api, /createSocketSlot\('grinder'\)/);
    assert.match(api, /ws\/v1\/grinder\/snapshot/);
    assert.match(api, /export function connectGrinderSocket\(/);
    assert.match(api, /export function closeGrinderSocket\(/);
    assert.match(api, /export async function executeGrinderCommand\(/);
    // The sensor path this replaced must be gone, not merely unused. The
    // remaining /ws/v1/sensors socket in api.js is the Bengle milk probe's and
    // is unrelated to the grinder.
    assert.doesNotMatch(api, /executeSensorCommand/);
});
