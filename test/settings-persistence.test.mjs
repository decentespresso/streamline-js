// UI preferences must survive an app update: WebView storage (localStorage,
// IndexedDB) belongs to the WebView's origin and is gone after a reinstall or a
// data-directory swap, so src/modules/settingsSync.js mirrors them into
// Decaid's KV store and pulls them back on boot.
// Run: node --test test/settings-persistence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEGACY_VISUALIZER_KEYS, LEGACY_VISUALIZER_PURGED_FLAG, legacyKeysToPurge } from '../src/modules/legacy-credentials-purge.js';
import { hydrate, installMirror, createWriteGate, decideMerge, retryDelay, SYNCED_KEYS, SETTINGS_NAMESPACE, shouldReloadForRestore, RESTORE_HANDLED_KEYS, PENDING_KEY, readPending, writePending, addPending, SYNCED_PREFIXES, isSynced, keysToMerge } from '../src/modules/settingsSync.js';

// Stand-in for window.localStorage with a shared prototype to patch, matching
// the browser's Storage/Storage.prototype split.
function makeStorage(initial = {}) {
    class FakeStorage {
        constructor(data) { this._data = { ...data }; }
        getItem(key) { return key in this._data ? this._data[key] : null; }
        setItem(key, value) { this._data[key] = String(value); }
        removeItem(key) { delete this._data[key]; }
        clear() { this._data = {}; }
    }
    return { storage: new FakeStorage(initial), proto: FakeStorage.prototype };
}

test('a synced write is mirrored to KV, an unsynced one is not', () => {
    const { storage, proto } = makeStorage();
    const pushed = [], dropped = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), k => dropped.push(k));

    storage.setItem('theme', 'dark');
    storage.setItem('reaHostname', '10.0.0.5');   // device-specific, never mirrored
    storage.removeItem('theme');

    assert.deepEqual(pushed, [['theme', 'dark']]);
    assert.deepEqual(dropped, ['theme']);
    assert.equal(storage.getItem('reaHostname'), '10.0.0.5', 'the real write still happens');
});

test('a repeated identical value is written locally but never re-pushed to KV', () => {
    // A hot-path writer (e.g. waterTank.js's per-frame websocket handler) can
    // call setItem with the same value on every frame. Only a real change
    // should reach the network — see issue #816 (1400+ POSTs/session for an
    // unchanging waterRefillLevel).
    const { storage, proto } = makeStorage();
    const pushed = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), () => {});

    storage.setItem('waterRefillLevel', '15');
    storage.setItem('waterRefillLevel', '15');
    storage.setItem('waterRefillLevel', '15');

    assert.deepEqual(pushed, [['waterRefillLevel', '15']], 'only the first write is a real change');
    assert.equal(storage.getItem('waterRefillLevel'), '15', 'the local value is still current');
});

test('a genuine change is still pushed after repeats of the old value', () => {
    const { storage, proto } = makeStorage();
    const pushed = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), () => {});

    storage.setItem('waterRefillLevel', '15');
    storage.setItem('waterRefillLevel', '15');
    storage.setItem('waterRefillLevel', '20');   // the user (or Decaid) actually changed it

    assert.deepEqual(pushed, [['waterRefillLevel', '15'], ['waterRefillLevel', '20']]);
});

test('credentials and the hostname stay out of the KV store', () => {
    // KV answers over the LAN (webui binds the WiFi address), localStorage does not.
    for (const key of ['visualizerPassword', 'visualizerUsername', 'reaHostname']) {
        assert.ok(!SYNCED_KEYS.includes(key), `${key} must not be mirrored`);
    }
    assert.notEqual(SETTINGS_NAMESPACE, 'streamline',
        'the legacy namespace is a migration source profileManager deletes keys out of');
});

test('the retired Visualizer switches are no longer mirrored', () => {
    for (const key of ['visualizerEnabled', 'visualizerAutoUpload']) {
        assert.ok(!SYNCED_KEYS.includes(key), `${key} has no consumer left`);
    }
});

test('the legacy Visualizer purge covers the credentials and runs once per device', () => {
    assert.deepEqual([...LEGACY_VISUALIZER_KEYS].sort(),
        ['visualizerAutoUpload', 'visualizerEnabled', 'visualizerPassword', 'visualizerUsername']);
    assert.deepEqual(legacyKeysToPurge(undefined), LEGACY_VISUALIZER_KEYS);
    assert.deepEqual(legacyKeysToPurge(false), LEGACY_VISUALIZER_KEYS);
    assert.deepEqual(legacyKeysToPurge(true), []);
    assert.equal(typeof LEGACY_VISUALIZER_PURGED_FLAG, 'string');
    // The caller gets a copy: mutating it must not widen or shrink the list.
    legacyKeysToPurge(false).push('x');
    assert.equal(LEGACY_VISUALIZER_KEYS.length, 4);
});

test('wake-profile toggle and selection are synced and survive a wipe', async () => {
    // "Load Profile on Wake" (settings.js renderWakeLockSettings) writes these
    // two keys straight to localStorage; persistence depends entirely on them
    // being in SYNCED_KEYS, not on any code of their own.
    assert.ok(SYNCED_KEYS.includes('wakeProfileEnabled'));
    assert.ok(SYNCED_KEYS.includes('wakeProfileId'));

    const { storage, proto } = makeStorage();
    const pushed = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), () => {});
    storage.setItem('wakeProfileEnabled', 'true');
    storage.setItem('wakeProfileId', 'profile-123');
    assert.deepEqual(pushed, [['wakeProfileEnabled', 'true'], ['wakeProfileId', 'profile-123']]);

    // Simulate the wipe-and-restore a Decaid update triggers: fresh localStorage,
    // KV still holding what was pushed above.
    const fresh = makeStorage();
    const { applied } = await hydrate(
        fresh.storage,
        { wakeProfileEnabled: 'true', wakeProfileId: 'profile-123' },
        fresh.proto.setItem, () => {},
    );
    assert.equal(fresh.storage.getItem('wakeProfileEnabled'), 'true');
    assert.equal(fresh.storage.getItem('wakeProfileId'), 'profile-123');
    assert.deepEqual(applied, { wakeProfileEnabled: 'true', wakeProfileId: 'profile-123' });
});

test('screensaver clock format and position mirror to KV and restore after a wipe', async () => {
    const preferences = { screensaverClockFormat: '24', screensaverClockPosition: 'top-right' };
    const { storage, proto } = makeStorage();
    const pushed = [];
    installMirror(proto, (key, value) => pushed.push([key, value]), () => {});
    for (const [key, value] of Object.entries(preferences)) {
        assert.ok(SYNCED_KEYS.includes(key));
        storage.setItem(key, value);
    }
    assert.deepEqual(pushed, Object.entries(preferences));
    const fresh = makeStorage();
    const { applied } = await hydrate(fresh.storage, preferences, fresh.proto.setItem, () => {});
    assert.deepEqual(applied, preferences);
    for (const [key, value] of Object.entries(preferences)) {
        assert.equal(fresh.storage.getItem(key), value);
    }
});

test('clear() also clears the durable copy', () => {
    // Otherwise a reset the user asked for comes straight back on the next boot.
    const { storage, proto } = makeStorage({ theme: 'dark' });
    const dropped = [];
    installMirror(proto, () => {}, k => dropped.push(k));
    storage.clear();
    assert.deepEqual(dropped.sort(), [...SYNCED_KEYS].sort());
});

test('the mirror installs once, so a second call cannot double-push', () => {
    const { storage, proto } = makeStorage();
    const pushed = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), () => {});
    installMirror(proto, (k, v) => pushed.push([k, v]), () => {});
    storage.setItem('theme', 'dark');
    assert.equal(pushed.length, 1);
});

test('after a wipe, boot restores the settings from KV', async () => {
    const { storage, proto } = makeStorage();   // localStorage is empty: fresh install
    const pushed = [];
    const { applied, seeded } = await hydrate(
        storage,
        { theme: 'dark', language: 'de', streamlineHelpHidden: '1' },
        proto.setItem, (k, v) => pushed.push([k, v]),
    );

    assert.equal(storage.getItem('theme'), 'dark');
    assert.equal(storage.getItem('language'), 'de');
    assert.equal(storage.getItem('streamlineHelpHidden'), '1');
    assert.deepEqual(applied, { theme: 'dark', language: 'de', streamlineHelpHidden: '1' });
    assert.deepEqual(seeded, {}, 'nothing local to protect');
    assert.deepEqual(pushed, [], 'hydrating must not echo back to the server');
});

test('the first boot after the update seeds KV from what this device has', async () => {
    // KV is empty and localStorage still holds the real settings — push them up
    // rather than treating the empty store as "no preferences".
    const { storage, proto } = makeStorage({ theme: 'dark', uiZoom: '1.2' });
    const pushed = [];
    const { applied, seeded } = await hydrate(storage, {}, proto.setItem, (k, v) => pushed.push([k, v]));

    assert.deepEqual(applied, {});
    assert.deepEqual(seeded, { theme: 'dark', uiZoom: '1.2' });
    assert.deepEqual(pushed, [['theme', 'dark'], ['uiZoom', '1.2']]);
    assert.equal(storage.getItem('theme'), 'dark', 'local values are left alone');
});

test('KV wins where the two disagree, and untouched keys are left alone', async () => {
    const { storage, proto } = makeStorage({ theme: 'light', uiZoom: '1.0' });
    const writes = [];
    const write = function (key, value) { writes.push(key); proto.setItem.call(this, key, value); };
    const { applied } = await hydrate(storage, { theme: 'dark', uiZoom: '1.0' }, write, () => {});

    assert.equal(storage.getItem('theme'), 'dark');
    assert.deepEqual(applied, { theme: 'dark' });
    assert.deepEqual(writes, ['theme'], 'a matching value must not be rewritten');
});

test('a KV value of null is treated as absent, not as a wipe', async () => {
    // The store answers 200 with null for a key it has never held.
    const { storage, proto } = makeStorage({ theme: 'dark' });
    const { applied, seeded } = await hydrate(storage, { theme: null }, proto.setItem, () => {});
    assert.equal(storage.getItem('theme'), 'dark');
    assert.deepEqual(applied, {});
    assert.deepEqual(seeded, { theme: 'dark' });
});

// ── The write gate ───────────────────────────────────────────────────────────
// The mirror must never write to KV before it has read it. Without this, a boot
// that could not reach Decaid (the WebView is up before the webservice is, which
// is exactly what an app update looks like) pushed post-wipe defaults over the
// one copy that had survived — so the settings were not merely reset for that
// session, the durable record of them was destroyed.

test('nothing reaches KV until a hydrate has actually read it', () => {
    const { storage, proto } = makeStorage();
    const pushed = [], dropped = [];
    const gate = createWriteGate({ push: (k, v) => pushed.push([k, v]), drop: k => dropped.push(k) });
    installMirror(proto, gate.push, gate.drop);

    // Boot on a wiped device with Decaid not answering: these are the writes
    // initI18n() and initHelpLauncher() make on every single startup.
    storage.setItem('language', 'en');
    storage.setItem('streamlineHelpLaunches', '1');
    storage.removeItem('theme');

    assert.deepEqual(pushed, [], 'a session that never read KV must not write to it');
    assert.deepEqual(dropped, [], 'nor delete from it');
    assert.equal(storage.getItem('language'), 'en', 'the local write still happens');
});

test('once the read succeeds the mirror writes through again', () => {
    const { storage, proto } = makeStorage();
    const pushed = [], dropped = [];
    const gate = createWriteGate({ push: (k, v) => pushed.push([k, v]), drop: k => dropped.push(k) });
    installMirror(proto, gate.push, gate.drop);

    storage.setItem('theme', 'dark');       // pre-hydrate, suppressed
    gate.open();
    storage.setItem('theme', 'light');      // post-hydrate, mirrored
    storage.removeItem('uiZoom');

    assert.equal(gate.isOpen, true);
    assert.deepEqual(pushed, [['theme', 'light']]);
    assert.deepEqual(dropped, ['uiZoom']);
});

test('a setting changed before a late hydrate is still seeded, not lost', async () => {
    // The gate drops the push, so the value only survives because hydrate()
    // seeds every key KV is missing from whatever localStorage holds by then.
    const { storage, proto } = makeStorage();
    const pushed = [];
    const gate = createWriteGate({ push: () => {}, drop: () => {} });
    installMirror(proto, gate.push, gate.drop);

    storage.setItem('uiZoom', '1.4');       // user changes it while KV is unreachable
    const { seeded } = await hydrate(storage, {}, proto.setItem, (k, v) => pushed.push([k, v]));

    assert.deepEqual(seeded, { uiZoom: '1.4' });
    assert.deepEqual(pushed, [['uiZoom', '1.4']]);
});

test('a late hydrate still lets KV win over a default written this session', async () => {
    // initI18n() writes language='en' on a wiped device before KV answers. That
    // write is a fallback, not a choice, so the restored value must beat it —
    // the documented "KV wins a conflict" rule, which is why the gate discards
    // pre-hydrate writes rather than replaying them afterwards.
    const { storage, proto } = makeStorage();
    const gate = createWriteGate({ push: () => {}, drop: () => {} });
    installMirror(proto, gate.push, gate.drop);

    storage.setItem('language', 'en');
    const { applied } = await hydrate(storage, { language: 'de' }, proto.setItem, () => {});

    assert.equal(storage.getItem('language'), 'de');
    assert.deepEqual(applied, { language: 'de' });
});

// ── The help button's implicit "hidden" state ────────────────────────────────
// help-launcher.js imports ui.js, so it cannot be imported here — lift the two
// pure rules out of the source instead (same trick as settings-sync.test.mjs).
const helpRules = (() => {
    const source = readFileSync(new URL('../src/modules/help-launcher.js', import.meta.url), 'utf8');
    const body = [
        /export function helpHiddenFrom\(preference, launches\) \{[\s\S]*?\r?\n\}/,
        /export function shouldPromoteHidden\(preference, launches\) \{[\s\S]*?\r?\n\}/,
    ].map(pattern => {
        const match = source.match(pattern);
        assert.ok(match, `help-launcher.js: no match for ${pattern}`);
        return match[0].replace('export ', '');
    }).join('\n');
    return new Function(`${body}\nreturn { helpHiddenFrom, shouldPromoteHidden };`)();
})();

test('the help button retires on the 3rd launch and that becomes a real preference', () => {
    const { helpHiddenFrom, shouldPromoteHidden } = helpRules;

    assert.equal(helpHiddenFrom(null, '1'), false, 'first runs still show it');
    assert.equal(shouldPromoteHidden(null, '1'), false, 'nothing to record yet');

    assert.equal(helpHiddenFrom(null, '3'), true, 'auto-hidden from the 3rd startup on');
    assert.equal(shouldPromoteHidden(null, '3'), true, 'the user let it go: write it down');
});

test('an explicit help-button choice is never overwritten by the launch count', () => {
    const { helpHiddenFrom, shouldPromoteHidden } = helpRules;

    // Turned back on from Settings, then kept using the app: the counter passes
    // the threshold but the user's '0' still stands.
    assert.equal(helpHiddenFrom('0', '99'), false);
    assert.equal(shouldPromoteHidden('0', '99'), false, 'a real choice is left alone');

    // Already hidden explicitly — nothing to promote.
    assert.equal(helpHiddenFrom('1', '0'), true);
    assert.equal(shouldPromoteHidden('1', '0'), false);
});

test('a wiped launch counter cannot resurrect a help button the user retired', () => {
    // The bug this closes: after an update localStorage is empty, so the counter
    // restarts at 0 and the button came back. With the preference promoted it is
    // in SYNCED_KEYS, so it is restored from KV and still reads as hidden.
    const { helpHiddenFrom } = helpRules;
    assert.equal(helpHiddenFrom(null, null), false, 'counter alone: the button is back');
    assert.equal(helpHiddenFrom('1', null), true, 'the restored preference still hides it');
    assert.ok(SYNCED_KEYS.includes('streamlineHelpHidden'), 'and it is mirrored into KV');
});

// ── Late hydrate: what the user changed this session wins ────────────────────
test('decideMerge: KV wins untouched keys, local wins locally-changed ones', () => {
    assert.equal(decideMerge('en', 'de', false), 'apply');
    assert.equal(decideMerge(null, 'de', false), 'apply');
    assert.equal(decideMerge('de', 'de', false), 'keep');
    assert.equal(decideMerge('en', 'de', true), 'seed');
    assert.equal(decideMerge('de', 'de', true), 'keep');
    assert.equal(decideMerge('1.4', 1.4, false), 'keep', 'remote non-strings compare as strings');
    // Missing in KV: seed what we have, otherwise nothing.
    assert.equal(decideMerge('x', undefined, false), 'seed');
    assert.equal(decideMerge('x', null, true), 'seed');
    assert.equal(decideMerge(null, undefined, false), 'keep');
    assert.equal(decideMerge(undefined, null, true), 'keep');
});

test('a key changed while the gate was shut survives a late hydrate and is pushed', async () => {
    const { storage, proto } = makeStorage();
    const gate = createWriteGate({ push: () => {}, drop: () => {} });
    installMirror(proto, gate.push, gate.drop);

    storage.setItem('uiZoom', '1.0');   // boot default on a wiped store: first write, not a choice
    storage.setItem('language', 'en');  // boot default
    storage.setItem('uiZoom', '1.4');   // the user's change
    assert.deepEqual([...gate.dirtyKeys()], ['uiZoom']);

    const pushed = [];
    const { applied, seeded } = await hydrate(
        storage, { uiZoom: '1.2', language: 'de', theme: 'dark' }, proto.setItem,
        (k, v) => pushed.push([k, v]), gate.dirtyKeys(),
    );
    assert.equal(storage.getItem('uiZoom'), '1.4');
    assert.equal(storage.getItem('language'), 'de');
    assert.deepEqual(applied, { language: 'de', theme: 'dark' });
    assert.deepEqual(seeded, { uiZoom: '1.4' });
    assert.deepEqual(pushed, [['uiZoom', '1.4']]);

    gate.clearDirty();
    assert.equal(gate.dirtyKeys().size, 0);
});

test('an open gate does not track dirty keys', () => {
    const pushed = [];
    const gate = createWriteGate({ push: (k, v) => pushed.push([k, v]), drop: () => {} });
    gate.open();
    gate.push('theme', 'dark', 'light');
    assert.equal(gate.dirtyKeys().size, 0);
    assert.deepEqual(pushed, [['theme', 'dark']]);
});

test('hydrate tolerates empty or garbage remote snapshots', async () => {
    for (const remote of [undefined, null, 'oops', 42, {}]) {
        const { storage, proto } = makeStorage();
        storage.setItem('theme', 'dark');
        const pushed = [];
        const { applied } = await hydrate(storage, remote, proto.setItem, (k, v) => pushed.push([k, v]));
        assert.deepEqual(applied, {});
        assert.deepEqual(pushed, [['theme', 'dark']]);
    }
});

test('retryDelay climbs the ladder, then settles at a capped steady interval', () => {
    assert.equal(retryDelay(0), 1000);
    assert.equal(retryDelay(4), 15000);
    assert.equal(retryDelay(5), 60000);
    assert.equal(retryDelay(500), 60000);
});

// A late restore reloads the page once so every boot-time reader sees the
// hydrated values -- but only when something the live repaint paths do not
// cover changed, and only while a reload costs the user nothing.
const idle = { armed: true, machineBusy: false, alreadyReloaded: false };

test('a late restore carrying an unhandled key reloads when armed and idle', () => {
    assert.equal(shouldReloadForRestore({ ...idle, applied: { uiZoom: '1.2', theme: 'dark' } }), true);
});

test('a late restore of only self-repainting keys does not reload', () => {
    const applied = Object.fromEntries(RESTORE_HANDLED_KEYS.map(k => [k, 'x']));
    assert.equal(shouldReloadForRestore({ ...idle, applied }), false);
});

test('an empty restore does not reload', () => {
    assert.equal(shouldReloadForRestore({ ...idle, applied: {} }), false);
});

test('no reload once the user has interacted', () => {
    assert.equal(shouldReloadForRestore({ ...idle, armed: false, applied: { uiZoom: '1.2' } }), false);
});

test('no reload while the machine is busy', () => {
    assert.equal(shouldReloadForRestore({ ...idle, machineBusy: true, applied: { uiZoom: '1.2' } }), false);
});

test('no second reload in the same session', () => {
    assert.equal(shouldReloadForRestore({ ...idle, alreadyReloaded: true, applied: { uiZoom: '1.2' } }), false);
});


// ── A change the gate could not push must outlive the session ────────────────
// The reverting dark theme: the user picks dark while Decaid's webservice is
// still starting, so the gate is shut and the push is only remembered in
// memory. Leaving the skin threw that away, and the next boot read an older KV
// value and applied it over the local one ("KV wins on conflict"). The dirty
// set is now written down, so the next hydrate seeds the change instead.
test('a change made while the gate was shut is remembered for the next boot', () => {
    const { storage, proto } = makeStorage({ theme: 'light' });
    const gate = createWriteGate({
        push: () => {}, drop: () => {},
        onDirty: key => addPending(storage, key),
    });
    installMirror(proto, gate.push, gate.drop);

    storage.setItem('theme', 'dark');

    assert.deepEqual([...readPending(storage)], ['theme']);
    assert.equal(storage.getItem(PENDING_KEY), '["theme"]', 'survives as plain JSON in localStorage');
});

test('a remembered change wins the next session, where the dirty set is empty', async () => {
    const { storage, proto } = makeStorage({ theme: 'dark' });   // chosen last session
    writePending(storage, new Set(['theme']));
    const gate = createWriteGate({ push: () => {}, drop: () => {} });
    installMirror(proto, gate.push, gate.drop);

    const pushed = [];
    const dirty = new Set([...gate.dirtyKeys(), ...readPending(storage)]);
    const { applied, seeded } = await hydrate(
        storage, { theme: 'light' }, proto.setItem, (k, v) => pushed.push([k, v]), dirty,
    );

    assert.equal(storage.getItem('theme'), 'dark', 'the stale KV value must not revert it');
    assert.deepEqual(applied, {});
    assert.deepEqual(seeded, { theme: 'dark' });
    assert.deepEqual(pushed, [['theme', 'dark']]);

    writePending(storage, []);                       // consumed by the hydrate
    assert.equal(storage.getItem(PENDING_KEY), null);
});

test('only synced keys are remembered, and garbage is ignored', () => {
    const { storage } = makeStorage();
    addPending(storage, 'reaHostname');               // never mirrored
    assert.equal(readPending(storage).size, 0);
    addPending(storage, 'theme');
    addPending(storage, 'theme');                     // no duplicates
    assert.deepEqual([...readPending(storage)], ['theme']);
    storage.setItem(PENDING_KEY, 'not json');
    assert.equal(readPending(storage).size, 0);
});

// ── No stock value may masquerade as a choice ────────────────────────────────
// Recording the fallback is what put 'light' in KV for users who never picked
// it: hydrate() then seeded that default and KV went on to win every conflict.
test('the boot script paints the fallback theme without recording it', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const inline = html.match(/<script>[\s\S]*?<\/script>/)?.[0];
    assert.ok(inline, 'inline boot script not found');
    assert.match(inline, /setAttribute\(\s*\n?\s*'data-theme'/);
    assert.doesNotMatch(html, /localStorage\.setItem\('theme'/, 'the fallback must not be persisted');
});

test('the theme toggle persists a user change only', () => {
    const ui = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
    const body = ui.match(/export function initThemeToggle\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(body, 'initThemeToggle not found');
    const [beforeChange, afterChange] = body.split("addEventListener('change'");
    assert.ok(afterChange, "the change listener is gone");
    assert.doesNotMatch(beforeChange, /localStorage\.setItem/, 'the init path must not write');
    assert.match(afterChange, /localStorage\.setItem\('theme', theme\)/);
});


// ── Settings-page toggles that used to live only on the device ───────────────
test('the Grinder page sync toggles are mirrored to KV', () => {
    // Keys come from grinder-runtime.js; assert against the source so renaming
    // one there without updating SYNCED_KEYS fails here instead of in the field.
    const runtime = readFileSync(new URL('../src/modules/grinder-runtime.js', import.meta.url), 'utf8');
    const keys = [...(runtime.match(/const KEYS = \{([^}]*)\}/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.deepEqual(keys, ['grinder-follow', 'grinder-send']);
    for (const key of keys) assert.ok(SYNCED_KEYS.includes(key), `${key} is not mirrored to KV`);
});

// ── Key families: preferences whose key carries an id ────────────────────────
test('a family key is mirrored, a near-miss is not', () => {
    const { storage, proto } = makeStorage();
    const pushed = [], dropped = [];
    installMirror(proto, (k, v) => pushed.push([k, v]), k => dropped.push(k));

    storage.setItem('plugin-stepsize:dose', '0.5');
    storage.setItem('plugin-mode-presets:dye2:grind', '[1,2]');
    storage.setItem('plugin-stepsizes', 'x');          // not the family
    storage.setItem('plugin-mode-presets', 'x');       // prefix needs the colon
    storage.removeItem('plugin-stepsize:dose');

    assert.deepEqual(pushed, [['plugin-stepsize:dose', '0.5'], ['plugin-mode-presets:dye2:grind', '[1,2]']]);
    assert.deepEqual(dropped, ['plugin-stepsize:dose']);
    assert.equal(isSynced('plugin-stepsizes'), false);
    assert.ok(SYNCED_PREFIXES.every(prefix => prefix.endsWith(':')), 'a prefix must end at a separator');
});

test('a family key in KV is restored, and one changed here is seeded', async () => {
    const { storage, proto } = makeStorage({ 'plugin-stepsize:dose': '0.1' });
    const pushed = [];
    const remote = { 'plugin-stepsize:dose': '0.5', 'plugin-mode-presets:dye2:grind': '[3]' };

    // Nothing enumerates the families, so hydrate has to pick them up from the
    // snapshot (and from `dirty` for a change this device could not push).
    assert.ok(keysToMerge(remote).has('plugin-mode-presets:dye2:grind'));
    assert.ok(keysToMerge({}, new Set(['plugin-stepsize:yield'])).has('plugin-stepsize:yield'));

    const { applied, seeded } = await hydrate(storage, remote, proto.setItem, (k, v) => pushed.push([k, v]));
    assert.deepEqual(applied, remote, 'both restored over the local copy');
    assert.deepEqual(seeded, {});
    assert.equal(storage.getItem('plugin-mode-presets:dye2:grind'), '[3]');

    // Same snapshot, but the step size was changed here while KV was unreachable.
    const local = makeStorage({ 'plugin-stepsize:dose': '0.2' });
    const pushed2 = [];
    const { applied: applied2, seeded: seeded2 } = await hydrate(
        local.storage, remote, local.proto.setItem, (k, v) => pushed2.push([k, v]),
        new Set(['plugin-stepsize:dose']),
    );
    assert.deepEqual(seeded2, { 'plugin-stepsize:dose': '0.2' });
    assert.deepEqual(applied2, { 'plugin-mode-presets:dye2:grind': '[3]' });
    assert.deepEqual(pushed2, [['plugin-stepsize:dose', '0.2']]);
});

test('a family key is remembered as pending like any other', () => {
    const { storage } = makeStorage();
    addPending(storage, 'plugin-stepsize:dose');
    addPending(storage, 'plugin-stepsizes');          // not the family
    assert.deepEqual([...readPending(storage)], ['plugin-stepsize:dose']);
});


// Decaid keeps the key as the path spelled it, so an escaped character survives
// into the ?full=1 listing. Found live: 'plugin-stepsize:dose' was stored as
// 'plugin-stepsize%3Adose', which hydrate() could never match to its local twin.
test('the KV snapshot reports keys under the name the skin wrote', async () => {
    const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
    const body = [
        /export function decodeKVKey\(key\) \{[\s\S]*?\n\}/,
        /export async function getKVAll\(namespace\) \{[\s\S]*?\n\}/,
        /export async function getKVValue\(namespace, key\) \{[\s\S]*?\n\}/,
    ].map(pattern => {
        const match = source.match(pattern);
        assert.ok(match, `no match for ${pattern}`);
        return match[0].replace('export ', '');
    }).join('\n');

    const asked = [];
    const run = (respond) => new Function('fetch', 'API_BASE_URL',
        `${body}\nreturn getKVAll('streamlineSettings');`)(
        async (url) => { asked.push(url); return respond(url); }, 'http://d/api/v1');

    const stored = { 'plugin-stepsize%3Adose': '0.5', theme: 'dark' };
    assert.deepEqual(
        await run(() => ({ ok: true, json: async () => stored })),
        { 'plugin-stepsize:dose': '0.5', theme: 'dark' },
    );

    // Older Decaid: a bare key array, each value fetched separately. The escaped
    // name must not be escaped twice on the way back out.
    asked.length = 0;
    const perKey = await run(url => url.endsWith('?full=1')
        ? { ok: true, json: async () => ['plugin-stepsize%3Adose'] }
        : { ok: true, json: async () => '0.5' });
    assert.deepEqual(perKey, { 'plugin-stepsize:dose': '0.5' });
    assert.ok(asked.some(url => url.endsWith('/plugin-stepsize%3Adose')), asked.join(' '));
    assert.ok(!asked.some(url => url.includes('%253A')), 'double-escaped');
});
