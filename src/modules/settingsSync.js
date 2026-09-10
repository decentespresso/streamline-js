// Durable home for the user's UI preferences.
//
// Everything in localStorage (and IndexedDB) belongs to the WebView's origin:
// it is lost when the host app is reinstalled, when its data directory is
// replaced, or when the skin ends up served from a different port. Decaid's KV
// store is a Hive box in the app's own data directory — the same place profiles
// and shots live, so it survives an app update, and Decaid's backup export
// walks every KV namespace, so these settings ride along in a backup too.
//
// The shape is deliberately dumb: localStorage stays the working copy that all
// the existing synchronous `localStorage.getItem(...)` call sites read, and KV
// is a mirror behind it. On boot we pull the mirror down; on every write we
// push the key up. No new read API, no call-site changes.

import { logger } from './logger.js';

// Own namespace. NOT 'streamline' — profileManager treats that one as a
// migration source and deletes keys out of it once they are imported.
export const SETTINGS_NAMESPACE = 'streamlineSettings';

// Preferences the user set on purpose and would have to hunt through Settings
// to restore. Machine-side settings (temperatures, flush, steam targets) are
// already Decaid's and are not mirrored here.
//
// Deliberately excluded:
//  - reaHostname: names the Decaid we are talking to, so it cannot come from it.
//  - visualizer credentials: the KV store answers over the LAN (webui binds the
//    WiFi address), and a password in localStorage is at least confined to the
//    WebView. Not worth the trade for skipping one re-login after an update.
//  - smde_*: draft text from the notes editor, not a setting.
export const SYNCED_KEYS = [
    'language',
    'theme',
    'uiZoom',
    'maxStretch',
    'streamlineHelpHidden',
    'streamlineHelpLaunches',
    'screensaverEnabled',
    'screensaverCycleSeconds',
    'blackScreenSaver',
    'wakeLockEnabled',
    'waterTankUnit',
    'waterRefillLevel',
    'keyboardBindings',
    'streamline.steamStopMode',
    'streamline.steamStopModeFallback',
    'streamline.cupWarmerTarget',
    'streamline.dye2Enabled',
    'streamline.dyeStripMode',
    'streamline.ecoSteam',
    'streamline.ledSequences',
    'streamline.settings.location',
    'tempUnit',
    'visualizerEnabled',
    'visualizerAutoUpload',
];

const synced = new Set(SYNCED_KEYS);

// Nothing may be written to KV until the durable copy has been READ at least
// once. This is the invariant that makes the mirror safe, and losing it is what
// wiped users' settings on a Decaid update:
//
// The WebView boots while Decaid's webservice is still starting, so the hydrate
// read below fails. localStorage was already emptied by the update, so the app
// runs on stock defaults — and boot writes them straight back out. initI18n()
// writes `language` on every boot, initHelpLauncher() writes
// `streamlineHelpLaunches` on every boot. With the mirror armed and nothing
// hydrated, those defaults were pushed over the one copy that had survived, so
// the settings did not just look reset for that session: the durable record of
// them was destroyed, and the next boot had nothing left to restore.
//
// A gate that only opens on a successful read fixes that at the source: a
// session that could not read KV simply never writes to it. Anything the user
// changed meanwhile is not lost — hydrate() seeds every key KV is missing from
// whatever localStorage holds at that point.
export function createWriteGate({ push: sendPush, drop: sendDrop }) {
    let open = false;
    return {
        // Called only after a hydrate has actually returned a remote snapshot.
        open() { open = true; },
        get isOpen() { return open; },
        push(key, value) { if (open) sendPush(key, value); },
        // Suppressed while closed for the same reason as push: a removeItem (or
        // a clear()) driven by wiped local storage must not delete the durable
        // copy we have not managed to read.
        drop(key) { if (open) sendDrop(key); },
    };
}

// Mirror writes to KV by wrapping Storage.prototype once, rather than editing
// the ~100 existing setItem call sites. Writes are fire-and-forget: a settings
// change must never block on (or fail because of) the network.
export function installMirror(storageProto, push, drop) {
    if (storageProto.__streamlineMirrored) return;
    const { setItem, removeItem, clear } = storageProto;
    storageProto.setItem = function (key, value) {
        // A hot-path writer (e.g. a per-frame websocket handler) can call
        // setItem with the same value over and over. Push only on a real
        // change — same equality idiom hydrate() already uses — so an
        // unchanged value never becomes a KV write.
        const str = String(value);
        const changed = synced.has(key) && this.getItem(key) !== str;
        setItem.call(this, key, value);
        if (changed) push(key, str);
    };
    storageProto.removeItem = function (key) {
        removeItem.call(this, key);
        if (synced.has(key)) drop(key);
    };
    // clear() is a reset, and a reset the user asked for should clear the
    // durable copy too — otherwise the next boot hydrates it all back.
    storageProto.clear = function () {
        clear.call(this);
        for (const key of synced) drop(key);
    };
    storageProto.__streamlineMirrored = true;
    return () => { Object.assign(storageProto, { setItem, removeItem, clear }); delete storageProto.__streamlineMirrored; };
}

// Pull KV into localStorage, then push up anything KV does not have yet.
// KV wins on conflict: it is the copy that survived, and the local copy after a
// wipe is either absent or a stock default.
// `write` is the *unwrapped* setter — hydrating must not echo straight back to
// the server. Returns what changed, for the caller and for the test.
export async function hydrate(storage, remote, write, push) {
    const applied = {};
    const seeded = {};
    for (const key of SYNCED_KEYS) {
        const value = remote[key];
        const local = storage.getItem(key);
        if (value === undefined || value === null) {
            // Nothing durable yet — protect what this device already has.
            if (local !== null) { seeded[key] = local; push(key, local); }
            continue;
        }
        const str = String(value);
        if (local !== str) { write.call(storage, key, str); applied[key] = str; }
    }
    return { applied, seeded };
}

// How long to keep trying to reach Decaid in the background after the first
// read fails. The boot read itself is never retried inline: settingsReady gates
// app.js's first paint, so a machine with no Decaid at all (browser dev) must
// not pay for the wait.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

// Boot-time wiring. Kept out of hydrate() so the logic above stays testable.
async function boot() {
    // Imported here, not at the top: api.js pulls in the DOM-touching modules,
    // and keeping this file importable on its own is what makes it testable.
    const { getKVAll, setKVValue, deleteKVValue } = await import('./api.js');
    const { openDB, setSetting } = await import('./idb.js');

    const proto = window.Storage.prototype;
    const rawSetItem = proto.setItem;
    const gate = createWriteGate({
        push: (key, value) => setKVValue(SETTINGS_NAMESPACE, key, value)
            .catch(e => logger.info(`settings push ${key} failed: ${e.message}`)),
        drop: (key) => deleteKVValue(SETTINGS_NAMESPACE, key)
            .catch(e => logger.info(`settings drop ${key} failed: ${e.message}`)),
    });
    installMirror(proto, gate.push, gate.drop);

    // Apply a remote snapshot. Also used by the background retry below, so a
    // late restore behaves exactly like an on-time one.
    const apply = async (remote) => {
        const { applied } = await hydrate(
            localStorage, remote, rawSetItem,
            (key, value) => setKVValue(SETTINGS_NAMESPACE, key, value).catch(() => {}),
        );
        // The read succeeded, so writing back is safe from here on.
        gate.open();

        // The theme was already applied by the inline script in index.html, before
        // this ran — re-apply it if KV disagreed.
        if (applied.theme) document.documentElement.setAttribute('data-theme', applied.theme);
        // i18n reads IndexedDB first and only falls back to localStorage, so a stale
        // IDB copy would outrank what we just hydrated. setSetting rejects unless the
        // DB is already open, and this runs before initI18n opens it.
        if (applied.language) {
            await openDB().then(() => setSetting('language', applied.language)).catch(() => {});
        }

        if (Object.keys(applied).length) logger.info(`Restored settings from KV: ${Object.keys(applied).join(', ')}`);
        return applied;
    };

    try {
        await apply(await getKVAll(SETTINGS_NAMESPACE));
        return;
    } catch (e) {
        // No Decaid yet. This is the update case: the WebView is up before the
        // webservice is listening. Boot on what localStorage has, keep the gate
        // shut so this session cannot overwrite the durable copy, and keep
        // trying in the background.
        logger.info(`settings hydrate deferred: ${e.message}`);
    }

    // Deliberately NOT awaited: settingsReady gates app.js's first paint, and a
    // device with no Decaid at all (browser dev) must not wait out the ladder
    // before the app is allowed to render.
    (async () => {
        for (const delay of RETRY_DELAYS_MS) {
            await new Promise(resolve => setTimeout(resolve, delay));
            let applied;
            try {
                applied = await apply(await getKVAll(SETTINGS_NAMESPACE));
            } catch {
                continue;
            }
            // The page has already rendered in whatever language boot fell back
            // to, so unlike the on-time path a write to IndexedDB is not enough
            // — re-translate what the user is looking at.
            if (applied.language) {
                await import('./i18n.js')
                    .then(({ setLanguage, getCurrentLanguage }) =>
                        getCurrentLanguage() === applied.language ? null : setLanguage(applied.language))
                    .catch(e => logger.info(`late language restore failed: ${e.message}`));
            }
            return;
        }
        logger.warn('Settings could not be restored from KV: Decaid never answered. '
            + 'This session will not write settings, so the durable copy stays intact.');
    })();
}

// Await this before reading any synced preference. Resolves either way — a
// hydrate failure must not stop the app booting.
export const settingsReady = typeof window === 'undefined'
    ? Promise.resolve()
    : boot().catch(e => { logger.warn('Settings hydrate failed', e); });
