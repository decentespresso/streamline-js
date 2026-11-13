import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoSteamLifecycle } from '../src/modules/auto-steam-lifecycle.js';

function fixture() {
    let reads = 0, changed = false, fail = false;
    const resets = [], errors = [];
    const session = { snapshot: () => ({ active: true }), updateStatus: () => changed,
        invalidate: async options => { resets.push(options); if (fail) throw new Error('Machine write failed'); },
        disable: async () => {}, connectionLost() {}, observeMachine: async () => {} };
    const lifecycle = createAutoSteamLifecycle({ session, getPlugins: async () => { reads++; return []; }, getStatus: async () => ({}),
        isAvailable: () => true, onAvailability() {}, onChange() {}, onError: error => errors.push(error.message) });
    return { lifecycle, resets, errors, reads: () => reads, changed: () => { changed = true; }, fail: () => { fail = true; } };
}

test('leaving the main page invalidates Auto and returning only repaints cached state', async () => {
    const f = fixture(); await f.lifecycle.initialize();
    assert.deepEqual(f.resets, [{ verify: true }]);
    await f.lifecycle.mainHidden();
    assert.deepEqual(f.resets, [{ verify: true }, undefined]);
    for (let i = 0; i < 9; i++) { f.lifecycle.mainShown(); await f.lifecycle.mainHidden(); }
    f.lifecycle.mainShown();
    assert.equal(f.reads(), 1);
    assert.equal(f.resets.length, 11);
    assert.equal(f.errors.length, 0);
});

test('unchanged settings do not force reset and changed settings do', async () => {
    const f = fixture(); await f.lifecycle.initialize();
    await f.lifecycle.settingsChanged(); assert.equal(f.resets.length, 1);
    f.changed(); await f.lifecycle.settingsChanged(); assert.deepEqual(f.resets.at(-1), { verify: true });
    assert.equal(f.resets.length, 2);
});

test('actual background failures are deferred until the user returns', async () => {
    const f = fixture(); await f.lifecycle.initialize(); f.fail();
    await f.lifecycle.mainHidden(); assert.deepEqual(f.errors, []);
    f.lifecycle.mainShown(); assert.deepEqual(f.errors, ['Machine write failed']);
    f.lifecycle.mainShown(); assert.equal(f.errors.length, 1);
});

test('reconnect waits for telemetry then revalidates once', async () => {
    const f = fixture(); await f.lifecycle.initialize();
    f.lifecycle.connectionChanged(); assert.equal(f.reads(), 1);
    await f.lifecycle.observeMachine('idle'); await f.lifecycle.observeMachine('idle');
    assert.equal(f.reads(), 2); assert.equal(f.resets.length, 2);
});

test('missing capability disables Auto without reporting an error', async () => {
    let disabled = 0;
    const availability = [];
    const session = {
        snapshot: () => ({ active: true }),
        updateStatus: () => false,
        invalidate: async () => {},
        disable: async () => { disabled++; },
        connectionLost() {},
        observeMachine: async () => {},
    };
    const lifecycle = createAutoSteamLifecycle({
        session,
        getPlugins: async () => [],
        getStatus: async () => assert.fail('status is not queried without the capability'),
        isAvailable: () => false,
        onAvailability: value => availability.push(value),
        onChange() {},
        onError: error => assert.fail(error),
    });
    await lifecycle.initialize();
    assert.deepEqual(availability, [false]);
    assert.equal(disabled, 1);
});

test('a failed capability query visibly fails safe to manual', async () => {
    let disabled = 0;
    const availability = [];
    const errors = [];
    const session = {
        snapshot: () => ({ active: true }),
        updateStatus: () => false,
        invalidate: async () => {},
        disable: async () => { disabled++; },
        connectionLost() {},
        observeMachine: async () => {},
    };
    const lifecycle = createAutoSteamLifecycle({
        session,
        getPlugins: async () => null,
        getStatus: async () => assert.fail('status is not queried after a failed capability query'),
        isAvailable: () => true,
        onAvailability: value => availability.push(value),
        onChange() {},
        onError: error => errors.push(error.message),
    });
    await lifecycle.initialize();
    assert.deepEqual(availability, [false]);
    assert.equal(disabled, 1);
    assert.match(errors[0], /Using manual steam/);
});
