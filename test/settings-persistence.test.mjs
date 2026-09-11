// UI preferences must survive an app update: WebView storage (localStorage,
// IndexedDB) belongs to the WebView's origin and is gone after a reinstall or a
// data-directory swap, so src/modules/settingsSync.js mirrors them into
// Decaid's KV store and pulls them back on boot.
// Run: node --test test/settings-persistence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrate, installMirror, createWriteGate, SYNCED_KEYS, SETTINGS_NAMESPACE } from '../src/modules/settingsSync.js';

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
