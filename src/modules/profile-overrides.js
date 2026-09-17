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
export const OVERRIDE_KEYS = ['targetDoseWeight', 'targetYield', 'grinderSetting', 'brewTemperature', 'targetSteamDuration', 'targetSteamFlow'];

let overrides = {};      // profileId -> { targetDoseWeight, targetYield, ... }
let kv = null;           // injected in tests; otherwise api.js, imported lazily

// api.js pulls in the DOM-touching modules — keep this file importable on its own.
async function kvClient() {
    return kv ||= await import('./api.js');
}

export function setKvClient(client) {
    kv = client;
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
        const { getKVAll } = await kvClient();
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
    } catch (e) {
        logger.info(`Profile overrides unavailable: ${e.message}`);
        overrides = {};
    }
    return overrides;
}

/** Merge `fields` into the override for `profileId` and push it up. Returns the merged set. */
export async function saveProfileOverride(profileId, fields) {
    const merged = { ...(overrides[profileId] || {}), ...pick(fields) };
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
