// Per-profile tile edits (dose / yield / grind / brew temp), kept in Decaid's KV
// store and keyed by profile id.
//
// These used to live only on the profile record's `metadata` map. Decaid re-seeds
// its bundled profiles on every boot and *replaces* that map with
// {source, filename} whenever the bundled copy changes (profile_controller.dart
// _loadDefaultProfilesIfNeeded), so a Decaid update silently wiped the user's
// numbers for every default profile. KV is the app's own Hive box: nothing but
// this skin writes it, it survives an app update, and Decaid's backup export
// walks every KV namespace so it rides along in a backup.
//
// Reads stay where they always were — profileManager/profile_selector read
// `record.metadata` — because loadAvailableProfiles() folds these values onto the
// cached records. Metadata is still honoured as the base, so numbers saved by an
// older build keep working until the next edit moves them to KV.

import { logger } from './logger.js';

export const OVERRIDES_NAMESPACE = 'streamlineProfileOverrides';

// The tile values a user can override. Anything else in a record's metadata
// (source, filename, ...) is Decaid's and is never written here.
// The flow multipliers are not tile values: they are app-wide Decaid settings
// (flow-calibration.js pushes them on a profile switch), stored here only
// because "the numbers this profile wants" is exactly what this namespace is.
export const OVERRIDE_KEYS = ['targetDoseWeight', 'targetYield', 'grinderSetting', 'brewTemperature', 'targetSteamDuration', 'targetSteamFlow', 'weightFlowMultiplier', 'volumeFlowMultiplier'];

let overrides = {};      // profileId -> { targetDoseWeight, targetYield, ... }
let loaded = false;      // has the namespace been pulled in at least once?
let kv = null;           // injected in tests; otherwise api.js, imported lazily

// api.js pulls in the DOM-touching modules — keep this file importable on its own.
async function kvClient() {
    return kv ||= await import('./api.js');
}

export function setKvClient(client) {
    kv = client;
    // A different store is a different set of overrides: forget what the old
    // one had, and let the next read/write pull the new one in.
    overrides = {};
    loaded = false;
    return () => { kv = null; };
}

function pick(fields) {
    const out = {};
    for (const key of OVERRIDE_KEYS) {
        const value = fields?.[key];
        if (value !== undefined && value !== null) out[key] = value;
    }
    return out;
}

/**
 * The dial-in context a profile switch sends: this profile's saved overrides,
 * and NOTHING where it has none. The workflow deep-merges, so an omitted field
 * leaves whatever is live alone -- whoever set it, this skin or DYE2 or another
 * tablet.
 *
 * The gap used to be filled from the skin's own localStorage note of "the last
 * number set on a Streamline tile", which no other client ever updated, and the
 * grind was sent as an explicit null when there was nothing to fill it with. So
 * a profile switch after a DYE2 dial-in reinstated the previous recipe's dose
 * and wiped its grind (#189). "The last number the user set" now means anywhere,
 * which is what it reads as.
 *
 * Yield is the exception and is always sent: it IS a profile field, so the
 * profile being switched to answers for it, overridden by the user's own.
 *
 * @param {object} meta  the profile record's metadata, overrides already folded on
 * @param {*} profileTargetWeight  profile.target_weight (may be a legacy TCL string)
 */
export function profileSwitchDial(meta, profileTargetWeight) {
    const dial = {};
    if (meta?.targetDoseWeight != null) dial.targetDoseWeight = meta.targetDoseWeight;
    if (meta?.grinderSetting != null) dial.grinderSetting = meta.grinderSetting;
    const parsedYield = parseFloat(meta?.targetYield ?? profileTargetWeight);
    dial.targetYield = Number.isFinite(parsedYield) ? parsedYield : 0;
    return dial;
}

/** Every saved override, by profile id. */
export function getAllProfileOverrides() {
    return overrides;
}

export function getProfileOverride(profileId) {
    return overrides[profileId] || null;
}

/** Pull the namespace into memory. Resolves either way — no Decaid, no overrides. */
export async function loadProfileOverrides() {
    try {
        // Skip the await when the client is already in hand: awaiting a
        // resolved dynamic import still costs a microtask, and a microtask does
        // not run until the call stack unwinds -- which on the profile selector
        // means after its chart init and first paint. That is what pushed this
        // read past the other two it was meant to run alongside.
        const { getKVAll } = kv || await kvClient();
        const raw = await getKVAll(OVERRIDES_NAMESPACE);
        overrides = {};
        for (const [key, value] of Object.entries(raw || {})) {
            if (!value || typeof value !== 'object') continue;
            // Decaid stores the key exactly as it appears in the URL path, so a
            // profile id comes back percent-encoded ('profile%3Aabc').
            let id = key;
            try { id = decodeURIComponent(key); } catch { /* keep the raw key */ }
            overrides[id] = pick(value);
        }
        loaded = true;
    } catch (e) {
        logger.info(`Profile overrides unavailable: ${e.message}`);
        overrides = {};
    }
    return overrides;
}

/**
 * Pull the namespace in once, if nothing has yet. A write merges onto whatever
 * is in memory and then replaces the whole KV entry, so writing before the
 * first load would silently drop every value this profile already had —
 * reachable from any page that edits a profile without going through the main
 * page's boot (the profile editor, for one).
 */
export async function ensureProfileOverridesLoaded() {
    if (!loaded) await loadProfileOverrides();
    return overrides;
}

/**
 * The override to merge a tile edit onto. The copy loaded at boot can be stale
 * when another tablet saved other fields since, so a successful fresh read wins
 * (a missing key means the profile has no override). Only when the fresh read
 * failed is the in-memory copy used.
 */
export function overrideMergeBase({ readOk, remote, local }) {
    if (readOk) return remote && typeof remote === 'object' ? pick(remote) : {};
    return local || {};
}

// getKVValue reports a missing key as an error whose message ends in the status.
async function readRemoteOverride(profileId) {
    const { getKVValue } = await kvClient();
    if (typeof getKVValue !== 'function') return { readOk: false };
    try {
        return { readOk: true, remote: await getKVValue(OVERRIDES_NAMESPACE, profileId) };
    } catch (e) {
        if (/\b404\b/.test(String(e?.message))) return { readOk: true, remote: null };
        return { readOk: false };
    }
}

// Overlapping read-merge-write cycles for one profile would each merge onto the
// same base and the later write would drop the earlier one's field, so they run
// one after another. Callers outside profileManager's metadata queue hit this.
const writeChains = new Map(); // profileId -> tail promise

function serializePerProfile(profileId, task) {
    const prev = writeChains.get(profileId) || Promise.resolve();
    const run = prev.then(task);
    const tail = run.catch(() => {});
    writeChains.set(profileId, tail);
    tail.then(() => { if (writeChains.get(profileId) === tail) writeChains.delete(profileId); });
    return run;
}

/**
 * Merge `fields` into the override for `profileId` and push it up. Re-reads the
 * stored override first so only the changed fields are applied on top of what
 * other devices saved. Returns the merged set.
 */
export function saveProfileOverride(profileId, fields) {
    return serializePerProfile(profileId, () => saveProfileOverrideNow(profileId, fields));
}

async function saveProfileOverrideNow(profileId, fields) {
    await ensureProfileOverridesLoaded();
    const fresh = await readRemoteOverride(profileId);
    const base = overrideMergeBase({ ...fresh, local: overrides[profileId] });
    const merged = { ...base, ...pick(fields) };
    overrides[profileId] = merged;
    try {
        const { setKVValue } = await kvClient();
        await setKVValue(OVERRIDES_NAMESPACE, profileId, merged);
    } catch (e) {
        // Keep the in-memory value: the tile stays right for this session even
        // if Decaid was briefly unreachable.
        logger.warn(`Failed to save overrides for ${profileId}:`, e);
    }
    return merged;
}

/**
 * Drop `keys` from `profileId`'s override, leaving the rest in place. Needed
 * because saveProfileOverride merges: there is otherwise no way to say "this
 * profile has no flow calibration of its own" once one has been saved.
 */
export function removeProfileOverrideKeys(profileId, keys) {
    return serializePerProfile(profileId, () => removeProfileOverrideKeysNow(profileId, keys));
}

async function removeProfileOverrideKeysNow(profileId, keys) {
    await ensureProfileOverridesLoaded();
    // Same fresh re-read as saveProfileOverride: don't write back a stale boot copy.
    const fresh = await readRemoteOverride(profileId);
    const existing = fresh.readOk ? (overrideMergeBase({ ...fresh, local: null }) || null) : overrides[profileId];
    if (!existing || Object.keys(existing).length === 0) { delete overrides[profileId]; return null; }
    overrides[profileId] = existing;
    const merged = { ...existing };
    for (const key of keys) delete merged[key];
    if (Object.keys(merged).length === Object.keys(existing).length) return existing;
    if (Object.keys(merged).length === 0) {
        await clearProfileOverride(profileId);
        return {};
    }
    overrides[profileId] = merged;
    try {
        const { setKVValue } = await kvClient();
        await setKVValue(OVERRIDES_NAMESPACE, profileId, merged);
    } catch (e) {
        logger.warn(`Failed to save overrides for ${profileId}:`, e);
    }
    return merged;
}

export async function clearProfileOverride(profileId) {
    delete overrides[profileId];
    try {
        const { deleteKVValue } = await kvClient();
        await deleteKVValue(OVERRIDES_NAMESPACE, profileId);
    } catch (e) {
        logger.warn(`Failed to clear overrides for ${profileId}:`, e);
    }
}

/**
 * Fold the saved overrides onto profile records so every existing
 * `record.metadata.targetDoseWeight` read keeps working. Mutates the map it is
 * given (it is the freshly built cache), KV winning over stale metadata.
 */
export function applyOverridesToRecords(records) {
    for (const [profileId, fields] of Object.entries(overrides)) {
        const record = records?.[profileId];
        if (record) record.metadata = { ...(record.metadata || {}), ...fields };
    }
    return records;
}
