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
import { SAVER_BRIGHTNESS_KEY, SAVER_BRIGHTNESS_CUSTOM_KEY } from './saver-brightness.js';

// Own namespace. NOT 'streamline' — profileManager treats that one as a
// migration source and deletes keys out of it once they are imported.
export const SETTINGS_NAMESPACE = 'streamlineSettings';

// Fired on window after a hydrate actually applied something, with
// `detail: { [key]: value }` for the keys that changed. The on-time hydrate
// runs before any page mounts and nobody is listening — this exists for the
// retry ladder below, where a Decaid that answers seconds late would otherwise
// leave the already-painted page showing the pre-restore values.
export const SETTINGS_RESTORED_EVENT = 'streamline-settings-restored';

// Preferences the user set on purpose and would have to hunt through Settings
// to restore. Machine-side settings (temperatures, flush, steam targets) are
// already Decaid's and are not mirrored here.
//
// Deliberately excluded:
//  - reaHostname: names the Decaid we are talking to, so it cannot come from it.
//  - smde_*: draft text from the notes editor, not a setting.
export const SYNCED_KEYS = [
    'language',
    'theme',
    'uiZoom',
    'maxStretch',
    'chartLineWidth',
    'streamlineHelpHidden',
    'streamlineHelpLaunches',
    'screensaverEnabled',
    SAVER_BRIGHTNESS_KEY,
    SAVER_BRIGHTNESS_CUSTOM_KEY,
    'screensaverCycleSeconds',
    'screensaverClockFormat',
    'screensaverClockPosition',
    'screensaverDateFormat',
    'blackScreenSaver',
    'screensaverShowClock',
    'wakeLockEnabled',
    'wakeProfileEnabled',
    'wakeProfileId',
    'waterTankUnit',
    'waterRefillLevel',
    'keyboardBindings',
    'lastGrinderSetting',
    'lastTargetDoseWeight',
    'streamline.steamStopMode',
    'streamline.steamStopModeFallback',
    'streamline.cupWarmerTarget',
    'streamline.dye2Enabled',
    'streamline.dyeStripMode',
    'streamline.ecoSteam',
    'streamline.ledSequences',
    'streamline.settings.location',
    'tempUnit',
    // Main-page quick presets. The values the buttons SET are Decaid's, but the
    // button labels are the user's own shortcuts — re-entering a favourite
    // 14:28 ratio after every app update is exactly the loss this mirror exists
    // to stop. Written as JSON by src/modules/ui.js.
    'drink-out-presets-user',
    'brew-temp-presets-user',
    'flush-presets-user',
    'hot-water-temp-presets-user',
    'hot-water-vol-presets-user',
    'steam-time-presets-user',
    'steam-flow-presets-user',
    'steam-flow-preset-selected-index',
    'steam-flow-presets-model',
    'milk-stop-presets-user',
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
//
// Keys the user CHANGED while the gate was shut are remembered (`dirty`), so a
// late hydrate can let them win over KV instead of reverting them. Only a change
// of an already-present local value counts: on a wiped store the first write of
// a key is a boot default (language, help launch count), and that must lose to
// the durable copy.
export function createWriteGate({ push: sendPush, drop: sendDrop }) {
    let open = false;
    const dirty = new Set();
    return {
        // Called only after a hydrate has actually returned a remote snapshot.
        open() { open = true; },
        get isOpen() { return open; },
        // Keys changed locally while closed; hydrate() consumes them.
        dirtyKeys() { return new Set(dirty); },
        clearDirty() { dirty.clear(); },
        push(key, value, previous = null) {
            if (open) sendPush(key, value);
            else if (previous !== null && previous !== undefined) dirty.add(key);
        },
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
        const previous = this.getItem(key);
        const changed = synced.has(key) && previous !== str;
        setItem.call(this, key, value);
        if (changed) push(key, str, previous);
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

// Merge decision for one key. KV wins on conflict (it is the copy that
// survived; the local copy after a wipe is absent or a stock default) EXCEPT
// for keys the user changed locally while the write gate was shut: that is a
// deliberate edit made after the wipe, newer than anything in KV.
//   'apply' - write KV's value locally
//   'seed'  - push the local value up (KV missing it, or a locally-changed key)
//   'keep'  - already equal / nothing to do
export function decideMerge(local, remote, locallyChanged = false) {
    const hasRemote = remote !== undefined && remote !== null;
    const hasLocal = local !== undefined && local !== null;
    if (!hasRemote) return hasLocal ? 'seed' : 'keep';
    if (locallyChanged && hasLocal) return String(remote) === local ? 'keep' : 'seed';
    return hasLocal && local === String(remote) ? 'keep' : 'apply';
}

// Pull KV into localStorage, then push up anything KV does not have yet (and
// anything the user changed while the gate was shut: `dirty`, a Set of keys).
// `write` is the *unwrapped* setter — hydrating must not echo straight back to
// the server. Returns what changed, for the caller and for the test.
export async function hydrate(storage, remote, write, push, dirty = new Set()) {
    const applied = {};
    const seeded = {};
    const snapshot = remote && typeof remote === 'object' ? remote : {};
    for (const key of SYNCED_KEYS) {
        const value = snapshot[key];
        const local = storage.getItem(key);
        const action = decideMerge(local, value, dirty.has(key));
        if (action === 'seed') {
            // Nothing durable yet, or a deliberate local change — protect it.
            seeded[key] = local; push(key, local);
        } else if (action === 'apply') {
            const str = String(value);
            write.call(storage, key, str); applied[key] = str;
        }
    }
    return { applied, seeded };
}

// How long to keep trying to reach Decaid in the background after the first
// read fails. The boot read itself is never retried inline: settingsReady gates
// app.js's first paint, so a machine with no Decaid at all (browser dev) must
// not pay for the wait.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
// After the ladder, keep trying at this cadence for the rest of the session: a
// Decaid that takes minutes to come up must not leave the gate shut forever
// (every change that session would never be pushed and would revert on reboot).
const RETRY_STEADY_MS = 60000;

// Delay before retry number `attempt` (0-based): the ladder, then steady.
export function retryDelay(attempt) {
    return attempt < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[attempt] : RETRY_STEADY_MS;
}

// Keys whose late restore already repaints the live page, so they never justify
// a reload on their own:
//  - theme / language: apply() sets data-theme and the retry path calls
//    setLanguage().
//  - the user preset arrays: the SETTINGS_RESTORED_EVENT listener in
//    src/modules/ui.js (its `byKey` map) re-runs each loader. These strings are
//    copied from the *_PRESETS_KEY constants there; ui.js cannot be imported
//    (it touches the DOM at load), so a preset key added to `byKey` but not here
//    would trigger a needless reload. test/settings-sync.test.mjs fails if the
//    two drift.
//  - streamline.dye2Enabled: the listener in src/modules/dyeStrip.js.
// Every other synced key (zoom, units, screensaver, bindings, ...) is read once
// at boot and stays stale until the page reloads.
export const RESTORE_HANDLED_KEYS = [
    'theme',
    'language',
    'drink-out-presets-user',
    'brew-temp-presets-user',
    'flush-presets-user',
    'hot-water-temp-presets-user',
    'hot-water-vol-presets-user',
    'steam-time-presets-user',
    'milk-stop-presets-user',
    'steam-flow-presets-user',
    'streamline.dye2Enabled',
];

// Should a late restore reload the page? A restore that lands after first paint
// (the app-update case: Decaid's webservice was not up yet, and the WebView's
// localStorage was wiped too, so everything painted as stock defaults) leaves
// anything not in RESTORE_HANDLED_KEYS showing defaults for the whole session.
// A per-key re-apply registry was rejected: initScaling()/initEcoSteam() bind
// listeners on every call, initUnits() lets an IndexedDB copy outrank
// localStorage, and it would only cover keys someone remembered. One reload
// re-boots from the now-hydrated localStorage and covers all of them.
// Every guard exists so the reload can never cost the user anything:
//  - applied: nothing unhandled changed, so there is nothing to fix.
//  - armed: the user has not touched the page yet, so no input is lost.
//  - machineBusy: never yank the UI mid-shot/steam/flush.
//  - alreadyReloaded: at most one reload per session, so a key that is
//    re-applied every time cannot loop.
export function shouldReloadForRestore({ applied, handledKeys = RESTORE_HANDLED_KEYS, armed, machineBusy, alreadyReloaded }) {
    if (!armed || machineBusy || alreadyReloaded) return false;
    const handled = new Set(handledKeys);
    return Object.keys(applied || {}).some(key => !handled.has(key));
}

const RELOADED_FLAG = 'streamline.settingsRestoreReloaded';

// sessionStorage can throw (private mode, blocked site data). Every failure
// reads as "already reloaded": no reload is the safe side.
function reloadedThisSession() {
    try { return sessionStorage.getItem(RELOADED_FLAG) === '1'; } catch { return true; }
}
function markReloaded() {
    try { sessionStorage.setItem(RELOADED_FLAG, '1'); return true; } catch { return false; }
}

// Busy unless the machine state is known and does not block profile sends.
// Imported lazily for the same reason boot() imports api.js lazily.
async function machineIsBusy() {
    try {
        const { currentMachineState } = await import('./api.js');
        const { profileSendBlocked } = await import('./profile-send-gate.js');
        return profileSendBlocked(currentMachineState);
    } catch {
        return true;
    }
}

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
        // Keys the user changed while the gate was shut win over KV and are
        // pushed up by hydrate(); everything else follows KV.
        const dirty = gate.dirtyKeys();
        const { applied } = await hydrate(
            localStorage, remote, rawSetItem,
            (key, value) => setKVValue(SETTINGS_NAMESPACE, key, value)
                .catch(e => logger.info(`settings push ${key} failed: ${e.message}`)),
            dirty,
        );
        // The read succeeded, so writing back is safe from here on.
        gate.open();
        gate.clearDirty();

        // The theme was already applied by the inline script in index.html, before
        // this ran — re-apply it if KV disagreed.
        if (applied.theme) document.documentElement.setAttribute('data-theme', applied.theme);
        // i18n reads IndexedDB first and only falls back to localStorage, so a stale
        // IDB copy would outrank what we just hydrated. setSetting rejects unless the
        // DB is already open, and this runs before initI18n opens it.
        if (applied.language) {
            await openDB().then(() => setSetting('language', applied.language)).catch(() => {});
        }

        if (Object.keys(applied).length) {
            logger.info(`Restored settings from KV: ${Object.keys(applied).join(', ')}`);
            window.dispatchEvent(new CustomEvent(SETTINGS_RESTORED_EVENT, { detail: applied }));
        }
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

    // The page painted from defaults, so a late restore may need a reload (see
    // shouldReloadForRestore). Armed only here: on the on-time path nothing has
    // painted yet. The first touch disarms it, because a reload after that could
    // discard what the user is doing.
    let armed = true;
    const disarm = () => {
        armed = false;
        window.removeEventListener('pointerdown', disarm, true);
        window.removeEventListener('keydown', disarm, true);
    };
    const listen = { capture: true, passive: true, once: true };
    window.addEventListener('pointerdown', disarm, listen);
    window.addEventListener('keydown', disarm, listen);

    // Deliberately NOT awaited: settingsReady gates app.js's first paint, and a
    // device with no Decaid at all (browser dev) must not wait out the ladder
    // before the app is allowed to render.
    (async () => {
        for (let attempt = 0; ; attempt++) {
            if (attempt === RETRY_DELAYS_MS.length) {
                logger.warn('Settings could not be restored from KV yet: Decaid has not answered. '
                    + 'Still retrying; until then this session does not overwrite the durable copy.');
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay(attempt)));
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
            // Flag first, so a failed or repeated reload can never loop.
            if (shouldReloadForRestore({
                applied, armed,
                machineBusy: armed ? await machineIsBusy() : true,
                alreadyReloaded: reloadedThisSession(),
            }) && armed && markReloaded()) {
                disarm();
                logger.info('Late settings restore: reloading to apply it everywhere');
                window.location.reload();
            }
            return;
        }
    })();
}

// Await this before reading any synced preference. Resolves either way — a
// hydrate failure must not stop the app booting.
export const settingsReady = typeof window === 'undefined'
    ? Promise.resolve()
    : boot().catch(e => { logger.warn('Settings hydrate failed', e); });
