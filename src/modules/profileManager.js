import { logger } from './logger.js';
import { updateWorkflow,sendProfile, getWorkflow, getValueFromStore, setValueInStore, getProfiles, deleteProfile, updateProfileVisibility, uploadProfile, uploadProfileWithParent, updateProfile, updateProfileMetadata, getShots, getKVKeys, getKVValue, deleteKVValue, setTargetSteamDuration, setTargetSteamFlow } from './api.js';
import { updateProfileName, updateTemperatureDisplay, updateDrinkOut, updateDrinkRatio, updateDoseInDisplay, updateGrindDisplay, updateSteamDisplay, updateHotWaterDisplay, updateFlushDisplay, showToast, setupPressAndHold} from './ui.js';
import { openContextMenu } from './context-menu.js';
import { openDB, getSetting, setSetting } from './idb.js';
import { loadPage } from './router.js'; // Singular and correctly formatted import
import { getTranslation, fitTextToBox } from './i18n.js';
import { resolveProfileKeyByTitle } from './active-profile.js';
import { loadProfileOverrides, saveProfileOverride, clearProfileOverride, applyOverridesToRecords } from './profile-overrides.js';

/**
 * Rename a profile by ID
 * @param {string} profileId - The profile ID
 * @param {string} newTitle - The new title for the profile
 * @returns {Promise} - Resolves when rename is complete
 */
export async function renameProfile(profileId, newTitle) {
    try {
        // Get the current profile data
        const profiles = await getProfiles();
        const profileData = profiles.find(p => p.id === profileId);
        
        if (!profileData) {
            throw new Error(`Profile with ID ${profileId} not found`);
        }
        
        // Update the title
        profileData.profile.title = newTitle;
        
        // Save to API
        await updateProfile(profileId, profileData.profile);
        
        // Update local cache
        if (availableProfiles[profileId]) {
            availableProfiles[profileId].profile.title = newTitle;
            await setSetting(PROFILES_CACHE_KEY, availableProfiles);
        }
        
        logger.info(`Profile renamed to: ${newTitle}`);
        return { success: true, title: newTitle };
    } catch (error) {
        logger.error('Failed to rename profile:', error);
        throw error;
    }
}

const FAV_COUNT = 5;
const PROFILES_PATH = 'profiles/';

const SETTINGS_NAMESPACE = 'streamline-app';
const FAVORITES_KEY = 'favorite-profiles';
const FAVORITES_INITIALIZED_KEY = 'favorite-profiles-initialized';
const UPLOADED_PROFILES_KEY = 'uploaded-profiles';
const DEFAULT_PROFILES_KEY = 'default-profiles';
const DEFAULT_PROFILES_MIGRATED_KEY = 'default-profiles-migrated';
const PROFILES_CACHE_KEY = 'available-profiles-cache';
const DRAFTS_KEY = 'profile-drafts';
let favoriteButtons = [];
export let availableProfiles = {};
export let favoriteAssignments = {};
// Local-only "copy now, edit later" profiles: kept in the streamline-app KV
// bucket instead of POST /profiles, because POST is content-addressed
// (ProfileController.create) and a duplicate with unedited content would just
// dedup back onto the profile it was copied from (see forkDeduped in
// profile_editor.js). A draft only reaches the server once its content
// actually diverges and the user saves.
export let profileDrafts = {};
let activeProfileId = null;

function validateButtonIndices() {
    const validAssignments = {};
    let hasInvalid = false;
    for (let i = 0; i < FAV_COUNT; i++) {
        if (favoriteAssignments.hasOwnProperty(i)) {
            validAssignments[i] = favoriteAssignments[i];
        }
    }
    for (const key of Object.keys(favoriteAssignments)) {
        if (!Number.isInteger(+key) || +key < 0 || +key >= FAV_COUNT) {
            hasInvalid = true;
            logger.warn(`Removing invalid button index: ${key}`);
        }
    }
    const changed = hasInvalid || Object.keys(validAssignments).length !== Object.keys(favoriteAssignments).length;
    if (changed) {
        favoriteAssignments = validAssignments;
        logger.info('Validated and normalized button assignments to valid indices (0-' + (FAV_COUNT - 1) + ')');
    }
    return changed;
}

// Global flag to prevent duplicate execution of profile updates
let profileUpdateInProgress = false;

// --- Helper Functions ---

/**
 * Translates a profile title if a translation exists.
 * Looks for a translation key in the format "profile:{title}".
 * If no translation is found, returns the original title.
 * @param {string} title The profile title to translate
 * @returns {string} The translated or original title
 */
export function translateProfileTitle(title) {
    if (!title) return title;
    
    // Try to find a translation for the profile title
    // Translation key format: "profile:{title}"
    
    // Sanitize the title to create a valid translation key
    
    const translatedTitle = getTranslation(title);
    logger.info(`Translating profile title. Original: '${title}', Translation key: '${title}', Translated: '${translatedTitle}'`);
    // If the translation is the same as the key, it means no translation was found
    // Return the original title in that case
    return translatedTitle === title ? title : translatedTitle;
}

const KV_MIGRATED_FLAG = 'kv-profiles-migrated';

// One-time migration: move legacy user profiles out of the private `streamline`
// KV namespace and into the shared /api/v1/profiles store so every skin sees
// them. Idempotent — guarded by a persisted flag; only flips the flag once all
// records moved, so a partial failure retries on next load. KV records are
// deleted only after a successful POST, so nothing is lost on error.
async function migrateKvProfilesToRest() {
    if (await getSetting(KV_MIGRATED_FLAG)) return;

    let kvKeys = [];
    try {
        kvKeys = await getKVKeys('streamline');
    } catch (e) {
        // No KV namespace or server unreachable — nothing to migrate now.
        return;
    }
    if (!kvKeys || kvKeys.length === 0) {
        await setSetting(KV_MIGRATED_FLAG, true);
        return;
    }

    let migrated = 0;
    for (const key of kvKeys) {
        try {
            const rec = await getKVValue('streamline', key);
            if (!rec || !rec.profile) { migrated++; continue; } // nothing usable — count as handled
            // Only carry a parentId that points at a real REST profile id (defaults), not a kv: id.
            const parent = rec.parentId && !String(rec.parentId).startsWith('kv:') ? rec.parentId : null;
            const saved = await uploadProfileWithParent(rec.profile, parent);
            if (rec.metadata && Object.keys(rec.metadata).length) {
                try { await updateProfileMetadata(saved.id, rec.metadata); } catch (_) {}
            }
            await deleteKVValue('streamline', key);
            migrated++;
        } catch (e) {
            logger.warn(`KV→REST migrate failed for ${key}; leaving KV record intact.`, e);
        }
    }
    logger.info(`Migrated ${migrated}/${kvKeys.length} legacy KV profile(s) to /profiles.`);
    if (migrated === kvKeys.length) await setSetting(KV_MIGRATED_FLAG, true);
}

// Repoint any favorite slot holding oldId to newId. Called after an edit whose
// content-hash id changed, so the favorite follows the edited profile.
export async function remapFavorite(oldId, newId) {
    let changed = false;
    for (const [slot, id] of Object.entries(favoriteAssignments)) {
        if (id === oldId) { favoriteAssignments[slot] = newId; changed = true; }
    }
    if (changed) await saveAssignments({ markUserInitialized: false });
}

export async function loadAvailableProfiles() {
    try {
        // Move legacy KV profiles into /profiles first so getProfiles() returns them.
        await migrateKvProfilesToRest();

        logger.info('Attempting to load profiles from API...');
        const profilesFromApi = await getProfiles(); // This is an array of ProfileRecords

        // Process and populate in-memory cache
        availableProfiles = {};
        for (const profileRecord of profilesFromApi) {
            // DELETE is a soft delete (visibility='deleted'); includeHidden=true
            // still returns those records, so drop them or they reappear on reload.
            // 'hidden' is a superseded version kept for the editor's revert history
            // (see saveProfile) — it must stay out of the visible list too.
            if (profileRecord.visibility === 'deleted' || profileRecord.visibility === 'hidden') continue;
            availableProfiles[profileRecord.id] = profileRecord;
        }

        logger.info(`Successfully loaded ${Object.keys(availableProfiles).length} profiles from API.`);

        // Local-only duplicates, merged in before overrides are folded on — a
        // draft's saved tile edits are keyed to its draft id, so the record
        // has to already be in availableProfiles or applyOverridesToRecords
        // below has nothing to attach them to.
        await loadProfileDrafts();

        // The user's tile edits live in KV, not on the record — fold them on so
        // every `record.metadata.targetDoseWeight` read below sees them.
        await loadProfileOverrides();
        applyOverridesToRecords(availableProfiles);

        // Sync to IndexedDB as a fallback
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);
        logger.info('Successfully synced profiles to IndexedDB cache.');

        return { profilesFrom: 'API' };

    } catch (apiError) {
        logger.warn('API failed. Attempting to load profiles from IndexedDB fallback.', apiError);

        try {
            const profilesFromCache = await getSetting(PROFILES_CACHE_KEY);
            if (profilesFromCache && Object.keys(profilesFromCache).length > 0) {
                availableProfiles = profilesFromCache;
                await loadProfileDrafts();
                await loadProfileOverrides();
                applyOverridesToRecords(availableProfiles);
                logger.info(`Successfully loaded ${Object.keys(availableProfiles).length} profiles from IndexedDB cache.`);
                return { profilesFrom: 'IDB_CACHE' };
            } else {
                logger.error('API failed and IndexedDB cache is empty. No profiles could be loaded.');
                availableProfiles = {};
                return { profilesFrom: 'NONE' };
            }
        } catch (idbError) {
            logger.error('CRITICAL: API failed and also failed to read from IndexedDB cache.', idbError);
            availableProfiles = {};
            return { profilesFrom: 'NONE' };
        }
    }
}

// --- Local profile drafts (copy now, edit later) ---

// crypto.randomUUID() needs a secure context, which some WebView builds don't
// grant even on 127.0.0.1 — this app targets both, so stay with a plain
// timestamp+random id (same style as handleProfileClick's callId above).
function newDraftId() {
    return `draft:${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function draftRecord({ id, profile, parentId }) {
    return { id, profile, parentId: parentId ?? null, isDraft: true, isDefault: false, visibility: 'visible' };
}

async function persistDrafts() {
    await setValueInStore(SETTINGS_NAMESPACE, DRAFTS_KEY, profileDrafts);
}

export async function loadProfileDrafts() {
    try {
        const stored = await getValueFromStore(SETTINGS_NAMESPACE, DRAFTS_KEY);
        profileDrafts = (stored && typeof stored === 'object') ? stored : {};
    } catch (e) {
        logger.warn('Could not load profile drafts from KV:', e);
        profileDrafts = {};
    }
    for (const [id, record] of Object.entries(profileDrafts)) {
        availableProfiles[id] = record;
    }
}

// Suffix `baseTitle` with " (n)" until it no longer collides with any known
// profile or draft title (excluding `excludeId`, so renaming a record in
// place doesn't collide with itself).
export function uniqueProfileTitle(baseTitle, excludeId) {
    const taken = new Set(
        Object.entries(availableProfiles)
            .filter(([id]) => id !== excludeId)
            .map(([, r]) => r.profile?.title)
            .filter(Boolean)
    );
    if (!taken.has(baseTitle)) return baseTitle;
    let n = 2;
    while (taken.has(`${baseTitle} (${n})`)) n++;
    return `${baseTitle} (${n})`;
}

// Duplicate an existing profile (real or already a draft) into a brand-new
// local-only draft. Give it a distinct title up front so it doesn't render as
// an exact duplicate of its source in the list before the user has touched it.
export async function duplicateProfileAsDraft(sourceId) {
    const source = availableProfiles[sourceId];
    if (!source?.profile) throw new Error('Profile not found');
    const id = newDraftId();
    // No excludeId: this is a new record, so the source's own title counts as
    // taken too — otherwise an untouched duplicate would keep its exact title.
    const title = uniqueProfileTitle(source.profile.title || 'Untitled', null);
    const profile = { ...JSON.parse(JSON.stringify(source.profile)), title };
    // Chain to the nearest real (server-backed) ancestor, not an intermediate
    // draft — draft ids aren't valid parentIds once this is eventually POSTed.
    const parentId = source.isDraft ? (source.parentId ?? null) : sourceId;
    const record = draftRecord({ id, profile, parentId });
    profileDrafts[id] = record;
    availableProfiles[id] = record;
    await persistDrafts();
    return record;
}

// Create a new draft, or overwrite an existing one in place (draftId given),
// from the editor's "Save as Draft" action.
export async function createOrUpdateDraft({ draftId, profile, parentId }) {
    const id = draftId || newDraftId();
    const record = draftRecord({ id, profile, parentId });
    profileDrafts[id] = record;
    availableProfiles[id] = record;
    await persistDrafts();
    return record;
}

export async function deleteProfileDraft(draftId) {
    delete profileDrafts[draftId];
    delete availableProfiles[draftId];
    await persistDrafts();
}

// A share-code (or other) import dedupes on the backend by content hash: if the
// imported profile's content matches one already on the device, REA silently
// returns that EXISTING record instead of creating a new one -- including one
// that is currently 'hidden' (a superseded revision kept for the editor's undo
// history) or 'deleted' (soft-deleted). loadAvailableProfiles() filters both
// out of `availableProfiles`, so a dedup hit on either would otherwise look
// exactly like "profile not found" to the importer even though nothing failed.
// Restore it to 'visible' and return it instead of leaving it invisible.
export async function resolveImportedProfile(profileId) {
    if (availableProfiles[profileId]) return availableProfiles[profileId];

    const allRecords = await getProfiles(); // includeHidden=true, see getProfiles()
    const record = allRecords.find((r) => r.id === profileId);
    if (!record) return null;

    const resolved = (record.visibility === 'hidden' || record.visibility === 'deleted')
        ? await updateProfileVisibility(profileId, 'visible')
        : record;

    availableProfiles[profileId] = resolved;
    await setSetting(PROFILES_CACHE_KEY, availableProfiles);
    return resolved;
}

function isValidAssignments(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}

async function getFavoritesInitializedFlag() {
    try {
        const reaFlag = await getValueFromStore(SETTINGS_NAMESPACE, FAVORITES_INITIALIZED_KEY);
        if (reaFlag === true) return true;
    } catch (e) {
        logger.warn('Could not read favorites-initialized flag from REA store:', e);
    }
    try {
        const idbFlag = await getSetting(FAVORITES_INITIALIZED_KEY);
        if (idbFlag === true) return true;
    } catch (e) {
        logger.warn('Could not read favorites-initialized flag from IDB:', e);
    }
    return false;
}

export async function loadAssignments() {
    logger.info('Loading assignments...');
    try {
        // 1. Try to fetch from the primary source (REA store)
        const reaAssignments = await getValueFromStore(SETTINGS_NAMESPACE, FAVORITES_KEY);

        if (isValidAssignments(reaAssignments)) {
            logger.info('Loaded assignments from REA store.');
            favoriteAssignments = reaAssignments;
            const changed = validateButtonIndices();
            // REA already has this data — only write back (REA round trip + IDB)
            // when validation actually changed something. Otherwise it's a
            // pointless ~200ms round trip writing back what we just read.
            if (changed) {
                await setValueInStore(SETTINGS_NAMESPACE, FAVORITES_KEY, favoriteAssignments);
                await setSetting(FAVORITES_KEY, favoriteAssignments);
            }
            return favoriteAssignments;
        }

        // 2. If REA has no data, try the local backup (IndexedDB)
        logger.warn('No assignments in REA store, checking IndexedDB backup...');
        const idbAssignments = await getSetting(FAVORITES_KEY);

        if (isValidAssignments(idbAssignments)) {
            logger.info('Loaded assignments from IndexedDB backup.');
            favoriteAssignments = idbAssignments;
            validateButtonIndices();
            // Save validated data back to REA store AND local backup to prevent stale data on next load
            await setValueInStore(SETTINGS_NAMESPACE, FAVORITES_KEY, favoriteAssignments);
            await setSetting(FAVORITES_KEY, favoriteAssignments);
            return favoriteAssignments;
        }

        // 3. If neither source has data, leave slots null so init() auto-populates from history/fallbacks.
        logger.info('No assignments found in REA or IDB. Deferring to auto-populate.');
        favoriteAssignments = {};
        for (let i = 0; i < FAV_COUNT; i++) {
            favoriteAssignments[i] = null;
        }

    } catch (error) {
        // This catch block handles network failures when trying to reach the REA store.
        logger.error('Failed to load from REA store. Falling back to IndexedDB.', error);
        try {
            const idbAssignments = await getSetting(FAVORITES_KEY);
            if (isValidAssignments(idbAssignments)) {
                logger.info('Successfully loaded from IndexedDB backup during fallback.');
                favoriteAssignments = idbAssignments;
                validateButtonIndices();
                await setValueInStore(SETTINGS_NAMESPACE, FAVORITES_KEY, favoriteAssignments);
                await setSetting(FAVORITES_KEY, favoriteAssignments);
            } else {
                 // Both stores empty — leave slots null so init() auto-populates.
                 logger.warn('IndexedDB backup is also empty. Deferring to auto-populate.');
                 favoriteAssignments = {};
                 for (let i = 0; i < FAV_COUNT; i++) {
                     favoriteAssignments[i] = null;
                 }
            }
        } catch (idbError) {
            logger.error('CRITICAL: Failed to load from both REA store and IndexedDB backup.', idbError);
        }
    }
    return favoriteAssignments;
}

async function saveAssignments({ markUserInitialized = true } = {}) {
    logger.info('Saving assignments to REA store and IndexedDB backup...');

    // markUserInitialized: when true, persist a flag indicating user has intentionally
    // set assignments (even an all-empty state via clearing slots). init() reads this
    // to decide whether to auto-populate defaults. autoPopulate passes false so a
    // failed first-run populate can retry on the next launch.
    const tasks = [
        setValueInStore(SETTINGS_NAMESPACE, FAVORITES_KEY, favoriteAssignments),
        setSetting(FAVORITES_KEY, favoriteAssignments)
    ];
    if (markUserInitialized) {
        tasks.push(setValueInStore(SETTINGS_NAMESPACE, FAVORITES_INITIALIZED_KEY, true));
        tasks.push(setSetting(FAVORITES_INITIALIZED_KEY, true));
    }
    const results = await Promise.allSettled(tasks);

    if (results[0].status === 'fulfilled') {
        logger.info('Assignments saved to REA store successfully.');
    } else {
        logger.error('Failed to save assignments to REA store:', results[0].reason);
    }

    if (results[1].status === 'fulfilled') {
        logger.info('Assignments saved to IndexedDB backup successfully.');
    } else {
        logger.error('Failed to save assignments to IndexedDB backup:', results[1].reason);
    }
}

export function setActiveProfile(profileId) {
    activeProfileId = profileId;
}

// Bind activeProfileId to the profile the machine has loaded, by title.
//
// Tile edits are saved onto the active record's metadata, and until this
// existed the id was only ever set by tapping a favourite / picking in the
// selector, plus a boot-time match that scanned ONLY the five favourite slots.
// So after a reload with a profile that is not on a favourite button, every
// dose/yield/grind/temp edit was written to the workflow and then dropped on
// the floor -- and the next profile switch showed the profile's own numbers
// again. Called on every loadInitialData, which is also the path a profile
// switch made elsewhere goes through.
export function syncActiveProfileFromTitle(title) {
    const key = resolveProfileKeyByTitle(availableProfiles, title, translateProfileTitle);
    if (key) {
        activeProfileId = key;
        logger.info(`Active profile bound to ${key} ("${title}")`);
    } else {
        activeProfileId = null;
        logger.warn(`No stored profile matches loaded profile "${title}" — tile edits will not persist.`);
    }
    return key;
}

export function getActiveProfileRecord() {
    if (!activeProfileId || !availableProfiles[activeProfileId]) return null;
    return availableProfiles[activeProfileId];
}

export function getActiveProfileId() {
    return availableProfiles[activeProfileId] ? activeProfileId : null;
}

// Serialize override read-modify-write so concurrent edits and resets can't
// clobber each other. Without this, two writers read the same base values and
// the last write to resolve wins — silently dropping the other's user-entered
// numbers. Each task re-reads the overrides inside the chain, after the prior write.
// ponytail: single global chain; fine because all writes target the one active
// profile. Per-id queues only if multiple profiles ever mutate concurrently.
let metadataWriteChain = Promise.resolve();
function queueMetadataWrite(task) {
    const run = metadataWriteChain.then(task, task);
    metadataWriteChain = run.catch(() => {}); // keep the queue alive past failures
    return run;
}

// Write an override for `profileId` to KV, then fold it onto the cached record
// so the metadata reads elsewhere (and the IDB fallback cache) agree with it.
function mutateProfileOverrides(profileId, fields) {
    return queueMetadataWrite(async () => {
        const merged = await saveProfileOverride(profileId, fields);
        const record = availableProfiles[profileId];
        if (!record) return null;
        record.metadata = { ...(record.metadata || {}), ...merged };
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);
        return record;
    });
}

// Drop every saved override for `profileId`: KV first, then the cached record.
// Numbers written by an older build still sit in the profile's server-side
// metadata, so strip those too or the reset comes back on the next reload.
const OVERRIDE_METADATA_KEYS = ['targetDoseWeight', 'targetYield', 'grinderSetting', 'brewTemperature', 'targetSteamDuration', 'targetSteamFlow'];
function dropProfileOverrides(profileId) {
    return queueMetadataWrite(async () => {
        await clearProfileOverride(profileId);
        const record = availableProfiles[profileId];
        if (!record) return null;
        const meta = record.metadata || {};
        const { targetDoseWeight, targetYield, grinderSetting, brewTemperature, targetSteamDuration, targetSteamFlow, ...rest } = meta;
        record.metadata = rest;
        if (OVERRIDE_METADATA_KEYS.some(key => key in meta)) {
            try {
                availableProfiles[profileId] = await updateProfileMetadata(profileId, rest);
            } catch (e) {
                logger.warn(`Failed to strip legacy metadata overrides for ${profileId}:`, e);
            }
        }
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);
        return availableProfiles[profileId];
    });
}

// Fold the user's saved brew temperature onto a COPY of a profile. The tile's
// editor writes every step at once (ui.js updateTemperatureValue), so one saved
// number restores the whole profile; a profile with no saved override, or with
// no steps, comes back untouched. Never mutates the cached record.
export function withSavedBrewTemp(profile, metadata) {
    const temp = metadata?.brewTemperature;
    if (!Number.isFinite(temp) || !Array.isArray(profile?.steps)) return profile;
    return { ...profile, steps: profile.steps.map(step => ({ ...step, temperature: temp })) };
}

export async function saveContextToActiveProfile(fields) {
    // Last-ditch bind: the machine's profile is on screen even when nothing has
    // set the id this session. Better than dropping the user's number.
    if (!activeProfileId || !availableProfiles[activeProfileId]) {
        syncActiveProfileFromTitle(document.getElementById('profile-name')?.textContent);
    }
    if (!activeProfileId || !availableProfiles[activeProfileId]) {
        logger.warn('No active profile — tile edit not persisted:', fields);
        return;
    }
    const profileId = activeProfileId; // pin target across the async queue wait
    try {
        // Straight to KV, keyed by profile id: Decaid replaces a bundled
        // profile's metadata map wholesale when it re-seeds it, and used to take
        // the user's numbers with it.
        await mutateProfileOverrides(profileId, fields);
        logger.info(`Saved context to profile ${profileId}:`, fields);
    } catch (error) {
        logger.error('Failed to save context to profile:', error);
    }
}

// Push a stored profile onto the machine using its own dose/yield defaults.
// Used by the wake-lock "load profile on wake" setting, so it targets an
// arbitrary profileId rather than activeProfileId.
export async function loadProfileForWake(profileId) {
    const profile = availableProfiles[profileId]?.profile;
    if (!profile) {
        logger.warn(`Wake profile ${profileId} not found — skipping.`);
        return false;
    }
    const parsedDose = parseFloat(profile.dose_weight);
    const defaultDose = isNaN(parsedDose) ? 18 : parsedDose;
    const parsedYield = parseFloat(profile.target_weight);
    const displayYield = isNaN(parsedYield) ? 0 : parsedYield;
    try {
        await updateWorkflow({ profile, context: { targetDoseWeight: defaultDose, targetYield: displayYield, grinderSetting: null } });
        setActiveProfile(profileId);
        logger.info(`Wake profile loaded: ${profileId}`);
        return true;
    } catch (error) {
        logger.error('Failed to load wake profile:', error);
        return false;
    }
}

// Strip the user's saved overrides (dose/yield/grind) from the active profile's
// metadata and re-apply the profile's own baked-in numbers to the machine + UI.
export async function resetActiveProfileToDefaults() {
    if (!activeProfileId || !availableProfiles[activeProfileId]) return false;
    const profileId = activeProfileId; // pin target across the async queue wait
    const profile = availableProfiles[profileId].profile;
    if (!profile) return false;

    // Drop override keys, going through the same write queue as edits so a
    // reset and an in-flight edit can't clobber each other. Strip is computed
    // against the freshest metadata (spread-merge can't delete, so rebuild).
    try {
        await dropProfileOverrides(profileId);
    } catch (error) {
        logger.error('Failed to clear profile overrides:', error);
        return false;
    }

    // If the user switched profiles while we were queued, the machine/UI now
    // reflect a different profile — don't stomp it with these defaults.
    if (activeProfileId !== profileId) return true;

    // Re-send the profile using its own defaults (no metadata overrides).
    // WorkflowContext requires numeric targetDoseWeight/targetYield (schema:
    // number/double); profile.dose_weight is a legacy TCL field that may be a
    // string, so coerce both rather than passing through raw.
    const parsedDose = parseFloat(profile.dose_weight);
    const defaultDose = isNaN(parsedDose) ? 18 : parsedDose;
    const parsedYield = parseFloat(profile.target_weight);
    const displayYield = isNaN(parsedYield) ? 0 : parsedYield;
    try {
        await updateWorkflow({ profile, context: { targetDoseWeight: defaultDose, targetYield: displayYield, grinderSetting: null } });
    } catch (error) {
        logger.error('Failed to re-apply profile defaults to workflow:', error);
        return false;
    }

    updateDoseInDisplay(defaultDose);
    updateDrinkOut(displayYield);
    updateDrinkRatio();
    if (profile.steps?.length > 0) updateTemperatureDisplay(profile.steps[0].temperature);
    const grindEl = document.getElementById('grind-value');
    if (grindEl) grindEl.textContent = '0';
    logger.info(`Reset profile ${activeProfileId} to its default numbers.`);
    return true;
}

export async function saveGrindToActiveProfile(grindValue) {
    console.log(`[saveGrindToActiveProfile] grindValue=${grindValue} activeProfileId=${activeProfileId} profileFound=${!!availableProfiles[activeProfileId]}`);
    return saveContextToActiveProfile({ grinderSetting: String(grindValue) });
}

// Favourite-profile button text follows skin.tcl exactly: one fixed size, wrap
// only. skin.tcl:263 loads Inter-Bold13 -- load_font size 13, so int(0.65 * 13)
// = 8pt = 24px at the 1920x1200 / fontm 0.65 reference -- and skin.tcl:2255 sets
// dbutton_label width 300 canvas px = 225 here, which is the button's content
// box. dui has no shrink-to-fit, so neither do we; long titles wrap and, past
// what fits, clip. Size and wrap width live in index.html on the buttons.

export function updateButtonUI() {
    const mainPage = document.getElementById('main-page');
    if (mainPage && mainPage.style.display === 'none') return;
    for (let i = 0; i < FAV_COUNT; i++) {
        const button = favoriteButtons[i];
        const profileKey = favoriteAssignments[i];
        const profileRecord = availableProfiles[profileKey];

        if (button && profileRecord && profileRecord.profile) {
            let translatedTitle = translateProfileTitle(profileRecord.profile.title);
            // Strip category prefix: any " / " (space-slash-space) is treated as a
            // category delimiter — keep only the tail. Covers "A. Espresso-Advanced /",
            // "A-Flow /", "B. Espresso-Pressure /" etc.
            if (translatedTitle && translatedTitle.includes(' / ')) {
                translatedTitle = translatedTitle.split(' / ').pop();
            }
            // Strip short uppercase tag prefix like "GHC/", "DE1/" without spaces.
            // Requires 2+ uppercase/digit chars so "A/B testing" or "Light/Medium" stay intact.
            if (translatedTitle) {
                translatedTitle = translatedTitle.replace(/^[A-Z][A-Z0-9]+\s*\/\s*/, '');
            }
            // Any remaining "/" (e.g. "Tea portafilter/Yunnan green") is treated as a
            // category delimiter too — keep only the tail so long category+name
            // combos don't get shrunk illegibly small on the button.
            if (translatedTitle && translatedTitle.includes('/')) {
                translatedTitle = translatedTitle.split('/').pop().trim();
            }
            button.textContent = translatedTitle || 'Untitled';
            fitTextToBox(button); // long names wrap past the fixed 98px box
            if (activeProfileId && profileKey === activeProfileId) {
                button.classList.remove('text-[var(--mimoja-blue)]', 'text-[var(--profile-button-text-color)]', 'bg-[var(--profile-button-background-color)]');
                button.classList.add('text-white', 'bg-[var(--mimoja-blue-v2)]');
            } else {
                button.classList.remove('text-white', 'bg-[var(--mimoja-blue-v2)]');
                button.classList.add('text-[var(--mimoja-blue)]', 'text-[var(--profile-button-text-color)]', 'bg-[var(--profile-button-background-color)]');
            }
        }
        else if (button) {
            button.textContent = '';
            fitTextToBox(button); // clears any shrink left by a previous long name
            button.classList.remove('text-white', 'bg-[var(--mimoja-blue-v2)]');
            button.classList.add('text-[var(--mimoja-blue)]', 'text-[var(--profile-button-text-color)]', 'bg-[var(--profile-button-background-color)]');
        }
    }
}

export async function verifyProfileChange(sentProfileTitle, retries = 5, delay = 300) {
    if (retries <= 0) {
        logger.error(`Profile verification failed after multiple retries. Sent '${sentProfileTitle}'.`);
        return false;
    }

    const currentWorkflow = await getWorkflow();
    const activeProfileTitle = currentWorkflow?.profile?.title;

    if (sentProfileTitle === activeProfileTitle) {
        logger.info('Verification successful. Active profile matches sent profile.');
        return true;
    } else {
        logger.warn(`Verification attempt failed. Retrying... (${retries - 1} left). Sent: '${sentProfileTitle}', Active: '${activeProfileTitle}'`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return verifyProfileChange(sentProfileTitle, retries - 1, delay);
    }
}

async function handleProfileClick(index) {
    if (index < 0 || index >= FAV_COUNT) {
        logger.error(`Invalid button index ${index} in handleProfileClick - must be between 0 and ${FAV_COUNT - 1}`);
        return;
    }

    // Empty slot: route straight to selector for assignment instead of nagging with a toast
    if (!favoriteAssignments[index] || !availableProfiles[favoriteAssignments[index]]) {
        logger.info(`Tap on unassigned favorite button ${index}. Navigating to profile selector.`);
        sessionStorage.setItem('pendingAssignmentIndex', index);
        loadPage('src/profiles/profile_selector.html');
        return;
    }

    // Add a unique identifier to track this specific call
    const callId = Date.now() + Math.random();
    logger.info(`handleProfileClick called with index ${index}, callId: ${callId}, profileUpdateInProgress: ${profileUpdateInProgress}`);

    // Check the global flag to prevent duplicate execution
    if (profileUpdateInProgress) {
        logger.warn(`Profile update already in progress. Skipping duplicate call with callId: ${callId}`);
        return;
    }

    // Set the global flag to indicate a profile update is in progress
    profileUpdateInProgress = true;

    // Get the button element to apply waiting state
    const button = favoriteButtons[index];

    // Apply waiting state to the button by replacing the background class
    if (button) {
        button.classList.remove('bg-[var(--profile-button-background-color)]');
        button.classList.add('bg-[var(--fav-button-wait)]');
    }

    const profileKey = favoriteAssignments[index];
    const profileRecord = availableProfiles[profileKey];

    const profile = profileRecord.profile;

    logger.info(`Sending profile '${profile.title}' to REA (callId: ${callId})...`);
    let profileSuccessfullySet = false;
    const meta = profileRecord.metadata || {};
    const savedGrind = meta.grinderSetting ?? null;
    const grindContext = savedGrind != null ? { grinderSetting: savedGrind } : { grinderSetting: null };
    const effectiveDose  = meta.targetDoseWeight  ?? (profile.dose_weight   || 18);
    const effectiveYield = meta.targetYield        ?? parseFloat(profile.target_weight);
    const displayYield = Number.isFinite(effectiveYield) ? effectiveYield : 0;
    // The UI yield override lives in metadata (targetYield), but on non-autonomous
    // machines Rea's stop-at-weight reads profile.target_weight — so a metadata-only
    // yield never reaches the machine's stop and the shot runs past it. Fold the
    // override into a *copy* of the profile (don't mutate the cached record) so the
    // sent target_weight matches the number the user set.
    // Brew temp is a saved override like dose/yield/grind -- without this the
    // cached record's baked-in temperature would silently undo the user's edit
    // every time they switch away and back.
    const profileToSend = withSavedBrewTemp(
        displayYield > 0 ? { ...profile, target_weight: displayYield } : profile, meta);
    try {
        // Skip the sendProfile call since updateWorkflow can handle sending the profile
        logger.info(`Skipping sendProfile call, using updateWorkflow directly (callId: ${callId})`);

        const workflowResponse = await updateWorkflow({
            profile: profileToSend,
            context: { targetDoseWeight: effectiveDose, targetYield: displayYield, ...grindContext }
        });
        updateDrinkOut(displayYield);
        updateDoseInDisplay(effectiveDose);
        updateDrinkRatio();

        // Use the response from updateWorkflow to confirm the profile was set
        if (workflowResponse && workflowResponse.profile && workflowResponse.profile.title === profile.title) {
            profileSuccessfullySet = true;
            logger.info(`Profile successfully set (callId: ${callId})`);
            const translatedTitle = translateProfileTitle(profile.title);
            updateProfileName(translatedTitle);
            if (profileToSend.steps && profileToSend.steps.length > 0) {
                updateTemperatureDisplay(profileToSend.steps[0].temperature);
            }

            if (savedGrind != null) {
                updateGrindDisplay({ grinderSetting: savedGrind });
            } else {
                const grindEl = document.getElementById('grind-value');
                if (grindEl) grindEl.textContent = '0';
            }

            // Steam duration/flow aren't profile fields (they live on the
            // workflow, not profile.steps), so unlike dose/yield/grind they
            // can't ride along in the updateWorkflow call above — they need
            // their own setter calls, which also carry the heater on/off side
            // effect for duration (see setTargetSteamDuration). Only push when
            // this profile actually has a saved value; with no record, leave
            // whatever the machine is currently set to alone.
            const savedSteamDuration = meta.targetSteamDuration;
            const savedSteamFlow = meta.targetSteamFlow;
            if (savedSteamDuration != null || savedSteamFlow != null) {
                try {
                    // Sequential, not Promise.all: both PUT the same workflow
                    // record's steamSettings sub-object, and duration's own
                    // write already does a read-modify-write of targetTemperature
                    // (steamHeaterFor) — running them concurrently risks one
                    // write clobbering the other depending on Decaid's merge
                    // order. One extra await here is once per profile switch.
                    if (savedSteamDuration != null) await setTargetSteamDuration(savedSteamDuration);
                    if (savedSteamFlow != null) await setTargetSteamFlow(savedSteamFlow);
                    updateSteamDisplay({
                        ...(savedSteamDuration != null && { targetSteamDuration: savedSteamDuration }),
                        ...(savedSteamFlow != null && { targetSteamFlow: savedSteamFlow }),
                    });
                } catch (e) {
                    logger.warn(`Failed to apply saved steam settings for profile (callId: ${callId}):`, e);
                }
            }

            activeProfileId = profileKey;

            favoriteButtons.forEach((btn, i) => {
                const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                const activeTextClass = 'text-white';
                const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                const defaultBgClass = 'bg-[var(--profile-button-background-color)]';

                if (i === index) {
                    btn.classList.add(activeBgClass, activeTextClass);
                    btn.classList.remove(inactiveTextClass, defaultTextClass, defaultBgClass);
                } else {
                    btn.classList.remove(activeBgClass, activeTextClass);
                    btn.classList.add(inactiveTextClass, defaultTextClass, defaultBgClass);
                }
            });
        } else {
            logger.warn(`Profile may not have been set correctly (callId: ${callId}). Response did not match expected profile.`);
        }
    }
    catch (error) {
        logger.error(`Failed to update profile (callId: ${callId}):`, error);
    } finally {
        // Always reset the flag in the finally block to ensure it gets reset even if there's an error
        profileUpdateInProgress = false;
        // Remove the waiting state from the button and restore original background only on failure
        if (button) {
            button.classList.remove('bg-[var(--fav-button-wait)]');
            if (!profileSuccessfullySet) {
                button.classList.add('bg-[var(--profile-button-background-color)]');
            }
        }
        logger.info(`handleProfileClick completed (callId: ${callId}), reset profileUpdateInProgress flag`);
    }
}

// Reports what actually happened, so callers can pick the right toast:
//   'assigned'  - a new assignment was made; show a success toast
//   'rejected'  - refused because the profile is already on a favourite (any of
//                 them, the pressed one included); this function has already shown
//                 the error toast naming that button, so the caller must not
//                 overwrite it with a success message of its own
//   'unchanged' - no-op: invalid button index
export async function assignProfile(buttonIndex, profileKey) {
    if (buttonIndex < 0 || buttonIndex >= FAV_COUNT) {
        logger.error(`Invalid button index ${buttonIndex} passed to assignProfile - must be between 0 and ${FAV_COUNT - 1}`);
        return 'unchanged';
    }

    // Reject if profileKey is already on ANY favorite button — including the one
    // being pressed. Re-assigning to the same button is a no-op, but staying silent
    // there reads as "nothing happened", so it is reported the same as any other
    // duplicate: the user always gets told which button already holds the profile.
    if (profileKey) {
        for (let i = 0; i < FAV_COUNT; i++) {
            if (favoriteAssignments[i] === profileKey) {
                logger.info(`Rejecting assign: profile '${profileKey}' already on button ${i}.`);
                const title = translateProfileTitle(availableProfiles[profileKey]?.profile?.title);
                showToast(`${title ? `'${title}'` : 'Profile'} already assigned to favorite ${i + 1}`, 3000, 'error');
                document.getElementById('profile_modal')?.close();
                return 'rejected';
            }
        }
    }

    logger.info(`Assigning profile '${profileKey}' to button ${buttonIndex}`);
    favoriteAssignments[buttonIndex] = profileKey;
    await saveAssignments();
    updateButtonUI();
    document.getElementById('profile_modal')?.close();
    return 'assigned';
}

function openProfileSelectionModal(buttonIndex) {
    currentButtonIndex = buttonIndex;
    const modal = document.getElementById('profile_modal');
    const container = document.getElementById('profile-list-container');
    if (!modal || !container) return;

    container.innerHTML = ''; // Clear previous list

    for (const profileKey in availableProfiles) {
        const profileRecord = availableProfiles[profileKey];
        if (profileRecord && profileRecord.profile) {
            const item = document.createElement('button');
            item.className = 'btn btn-ghost justify-start';
            const translatedTitle = translateProfileTitle(profileRecord.profile.title);
            item.textContent = translatedTitle;
            item.addEventListener('click', () => {
                assignProfile(buttonIndex, profileKey);
            });
            container.appendChild(item);
        }
    }

    modal.showModal();
}

function openFavoriteContextMenu(button, index) {
    const profileKey = favoriteAssignments[index];
    const profileRecord = profileKey ? availableProfiles[profileKey] : null;
    const assigned = !!profileRecord;
    const title = assigned ? translateProfileTitle(profileRecord.profile.title) : null;

    const items = assigned
        ? [
            { label: `${getTranslation('Edit')} "${title}"`, onSelect: () => {
                window.__pendingEditProfile = profileRecord;
                loadPage('src/profiles/profile_editor.html');
            } },
            { label: getTranslation('Replace with'), onSelect: () => {
                sessionStorage.setItem('pendingAssignmentIndex', index);
                loadPage('src/profiles/profile_selector.html');
            } },
            { divider: true },
            { label: getTranslation('Clear button'), danger: true, onSelect: async () => {
                favoriteAssignments[index] = null;
                await saveAssignments();
                updateButtonUI();
                showToast(`Favorite ${index + 1} cleared`, 2000, 'info');
            } },
        ]
        : [
            { label: getTranslation('Browse Profiles'), onSelect: () => {
                sessionStorage.setItem('pendingAssignmentIndex', index);
                loadPage('src/profiles/profile_selector.html');
            } },
        ];

    openContextMenu(button, items);
}

export async function handleProfileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const fileContent = await file.text();
        const profile = JSON.parse(fileContent);

        // Enhanced client-side validation before sending
        const validationResult = validateProfileStructure(profile);
        if (!validationResult.isValid) {
            throw new Error(validationResult.errorMessage);
        }

        logger.info(`Uploading new profile: ${profile.title}`);

        // Try API, then update local cache on success
        const newProfileRecord = await uploadProfile(profile);

        // API call succeeded, now update local state and cache
        availableProfiles[newProfileRecord.id] = newProfileRecord;
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);

        logger.info(`Profile '${newProfileRecord.profile.title}' uploaded successfully with ID ${newProfileRecord.id}.`);
        showToast(`Profile '${translateProfileTitle(newProfileRecord.profile.title)}' uploaded.`, 3000, 'success');

        // Dispatch a custom event to notify the UI that the profile list has been updated.
        // The page-specific JS (e.g., profile_selector.js) should listen for this.
        document.dispatchEvent(new CustomEvent('profiles-updated'));

    } catch (error) {
        logger.error('Failed to upload profile:', error);
        showToast(`Error uploading profile: ${error.message}`,5000,'error');
    } finally {
        // Reset the input so the user can upload the same file again
        event.target.value = '';
    }
}

// Enhanced validation function to check for specific missing fields
export function validateProfileStructure(profile) {
    // Check if profile is a valid object
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        return {
            isValid: false,
            errorMessage: 'Uploaded file does not contain a valid profile object.'
        };
    }

    // Define required keys for a valid profile
    const requiredKeys = [
        'title',
        'author',
        'notes',
        'beverage_type',
        'steps',
        'version',
        'target_volume',
        'target_weight',
        'target_volume_count_start',
        'tank_temperature'
    ];

    // Find missing keys
    const missingKeys = requiredKeys.filter(key => !Object.prototype.hasOwnProperty.call(profile, key));

    if (missingKeys.length > 0) {
        const missingKeysString = missingKeys.join(', ');
        return {
            isValid: false,
            errorMessage: `Uploaded profile is missing required field(s): ${missingKeysString}.`
        };
    }

    // Validate that 'steps' is an array
    if (!Array.isArray(profile.steps)) {
        return {
            isValid: false,
            errorMessage: "Uploaded profile's 'steps' property is not an array."
        };
    }

    // If all validations pass
    return {
        isValid: true,
        errorMessage: null
    };
}

export async function deleteOrHideProfile(profileId, { forceHide = false } = {}) {
    const profileRecord = availableProfiles[profileId];
    if (!profileRecord) {
        logger.error(`Profile with ID ${profileId} not found in local cache.`);
        showToast(`Error: Profile not found.`, 5000, 'error');
        return;
    }
    // forceHide: always hide (long-press menu) regardless of default vs user-created
    const isDefault = profileRecord.isDefault;

    logger.info(`Requesting action for profile ID: ${profileId}. Is default: ${isDefault}, forceHide: ${forceHide}`);

    if (isDefault || forceHide) {
        // HIDE a default profile
        try {
            const updatedProfile = await updateProfileVisibility(profileId, 'hidden');
            availableProfiles[profileId] = updatedProfile;
            await setSetting(PROFILES_CACHE_KEY, availableProfiles);

            logger.info(`Profile ${profileId} successfully hidden.`);
            document.dispatchEvent(new CustomEvent('profiles-updated'));
            showToast('Profile hidden.', 3000, 'success');
        } catch (error) {
            logger.error(`Failed to hide profile ${profileId}:`, error);
            showToast(`Error hiding profile: ${error.message}`, 5000, 'error');
        }
    } else {
        // DELETE a user-uploaded profile
        try {
            await deleteProfile(profileId);

            delete availableProfiles[profileId];

            await setSetting(PROFILES_CACHE_KEY, availableProfiles);

            logger.info(`Profile ${profileId} successfully deleted from backend and removed from local cache.`);

            document.dispatchEvent(new CustomEvent('profiles-updated'));
            showToast('Profile deleted.', 3000, 'success');

        } catch (error) {
            logger.error(`Failed to delete profile ${profileId}:`, error);
            showToast(`Error deleting profile: ${error.message}`, 5000, 'error');
        }
    }
}

export async function unhideProfile(profileId) {
    logger.info(`Requesting to unhide profile ID: ${profileId}`);
    try {
        // The new record is returned on success
        const updatedProfileRecord = await updateProfileVisibility(profileId, "visible");

        // Update local cache with the returned record
        availableProfiles[profileId] = updatedProfileRecord;

        // Update IndexedDB cache
        await setSetting(PROFILES_CACHE_KEY, availableProfiles);

        logger.info(`Profile ${profileId} successfully unhidden.`);

        // Dispatch event to notify UI
        document.dispatchEvent(new CustomEvent('profiles-updated'));
        showToast('Profile restored.', 3000, 'success');

    } catch (error) {
        logger.error(`Failed to unhide profile ${profileId}:`, error);
        showToast(`Error: ${error.message}`, 5000, 'error');
    }
}

export function getHiddenProfiles() {
    return Object.values(availableProfiles).filter(p => p.visibility === 'hidden');
}

// --- Auto-populate favorites from shot history "default" "best_practice" "80s_Espresso" "rao_allonge" "Gentle and sweet"---

const FALLBACK_PROFILE_TITLES = [
    'Default',
    'Best practice (light roast)',
    "80's Espresso",
    'Rao Allongé',
    'Gentle and sweet',
];

function findProfileKeyByTitle(title) {
    return resolveProfileKeyByTitle(availableProfiles, title, translateProfileTitle);
}

async function autoPopulateFavoritesFromHistory() {
    const THREE_WEEKS_MS = 21 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - THREE_WEEKS_MS).toISOString();

    let shots = [];
    try {
        const data = await getShots({ limit: 200, order: 'desc' });
        shots = (data.items ?? []).filter(s => s.timestamp >= cutoff);
    } catch (e) {
        logger.warn('autoPopulateFavoritesFromHistory: could not fetch shots, using fallbacks', e);
        shots = [];
    }
    if (shots.length === 0) {
        logger.info('autoPopulateFavoritesFromHistory: no history, assigning FALLBACK_PROFILE_TITLES by position');
        for (let i = 0; i < FAV_COUNT; i++) {
            const title = FALLBACK_PROFILE_TITLES[i];
            favoriteAssignments[i] = title ? (findProfileKeyByTitle(title) || null) : null;
        }
    } else {
        // Count frequency by profile key from shot history.
        const freq = new Map();
        for (const shot of shots) {
            const title = shot.workflow?.profile?.title;
            if (!title) continue;
            const key = findProfileKeyByTitle(title);
            if (!key) continue;
            freq.set(key, (freq.get(key) || 0) + 1);
        }

        const topKeys = [...freq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, FAV_COUNT)
            .map(([k]) => k);

        logger.info('autoPopulateFavoritesFromHistory: top by frequency',
            topKeys.map(k => ({ key: k, title: availableProfiles[k]?.profile?.title, count: freq.get(k) })));

        for (let i = 0; i < FAV_COUNT; i++) {
            favoriteAssignments[i] = topKeys[i] || null;
        }
    }

    // Secondary fallback: if all assignments are still null (named profiles not found,
    // or history profiles unresolvable), fill with first FAV_COUNT profiles alphabetically.
    const allStillNull = Object.values(favoriteAssignments).every(v => v === null || v === undefined);
    if (allStillNull) {
        logger.warn('autoPopulateFavoritesFromHistory: named/history profiles not found, falling back to first available profiles');
        const sortedKeys = Object.keys(availableProfiles)
            .filter(k => availableProfiles[k]?.profile?.title)
            .sort((a, b) => (availableProfiles[a].profile.title).localeCompare(availableProfiles[b].profile.title));
        for (let i = 0; i < FAV_COUNT; i++) {
            favoriteAssignments[i] = sortedKeys[i] || null;
        }
    }

    await saveAssignments({ markUserInitialized: false });
    updateButtonUI();

    // Best-effort: recipe sidebar pre-fill from the most recent shot.
    const latest = shots[0];
    if (latest?.workflow) applyWorkflowToMainPageUI(latest.workflow, { updateName: false });
}

export function applyWorkflowToMainPageUI(workflow, { updateName = true } = {}) {
    if (!workflow) return;
    const context = workflow.context;

    const dose = context?.targetDoseWeight ?? workflow.doseData?.doseIn;
    const yield_ = context?.targetYield ?? workflow.doseData?.drinkOut;
    const grind = context?.grinderSetting ?? workflow.grinderData?.setting;
    const brewTemp = workflow.profile?.steps?.[0]?.temperature;
    const steamDuration = workflow.steamSettings?.duration;
    const steamFlow = workflow.steamSettings?.flow;
    const hotWaterVol = workflow.hotWaterData?.volume;
    const hotWaterTemp = workflow.hotWaterData?.targetTemperature;
    const flushDuration = workflow.rinseData?.duration;

    if (updateName && workflow.profile?.title) updateProfileName(workflow.profile.title);

    if (dose != null) updateDoseInDisplay(dose);
    if (yield_ != null) { updateDrinkOut(yield_); updateDrinkRatio(); }
    if (grind != null) updateGrindDisplay({ grinderSetting: String(grind) });
    if (brewTemp != null) updateTemperatureDisplay(brewTemp);
    if (steamDuration != null || steamFlow != null) {
        updateSteamDisplay({
            ...(steamDuration != null && { targetSteamDuration: steamDuration }),
            ...(steamFlow != null && { targetSteamFlow: steamFlow }),
        });
    }
    if (hotWaterVol != null || hotWaterTemp != null) {
        updateHotWaterDisplay({
            ...(hotWaterVol != null && { targetHotWaterVolume: hotWaterVol }),
            ...(hotWaterTemp != null && { targetHotWaterTemp: hotWaterTemp }),
        });
    }
    if (flushDuration != null) updateFlushDisplay(flushDuration);
}

// --- Initialization ---

export async function init() {
    logger.info('Profile Manager init started.');
    let profileLoadStatus = {};

    try {
        // Clear the existing button array to ensure we're working with fresh DOM elements
        favoriteButtons = [];

        for (let i = 0; i < FAV_COUNT; i++) {
            const button = document.getElementById(`fav-profile-btn-${i}`);
            if (button) {
                favoriteButtons.push(button);
            } else {
                logger.warn(`Favorite button fav-profile-btn-${i} not found in DOM`);
            }
        }

        await openDB(); // Still needed for the backup functionality

        profileLoadStatus = await loadAvailableProfiles();
        // Independent REA reads — no data dependency between them, so run
        // concurrently instead of paying two sequential round trips.
        const [, userInitialized] = await Promise.all([
            loadAssignments(),
            getFavoritesInitializedFlag(),
        ]);

        const allEmpty = Object.values(favoriteAssignments).every(v => v === null || v === undefined);
        // If user has previously saved assignments (even all-empty via clearing slots),
        // respect that choice and skip auto-populate.
        if (allEmpty && !userInitialized) {
            logger.info('No favorite assignments found — auto-populating from shot history.');
            await autoPopulateFavoritesFromHistory();
        } else {
            if (allEmpty) logger.info('All favorites empty but user-initialized marker set — skipping auto-populate.');
            updateButtonUI();
        }

        document.addEventListener('streamline:languagechange', () => updateButtonUI());

        // Only attach event listeners to buttons that were found in the DOM
        favoriteButtons.forEach((originalButton, index) => {
            // Remove any existing listeners first to prevent duplicates by cloning the element
            const clonedButton = originalButton.cloneNode(true);
            originalButton.parentNode.replaceChild(clonedButton, originalButton);

            // Update our reference to point to the cloned button
            favoriteButtons[index] = clonedButton;

            clonedButton.classList.add('no-select', 'has-context-menu');
            // Clear the dataset flag so setupPressAndHold re-wires after the cloneNode
            delete clonedButton.dataset.pressHoldInit;

            const clickCallback = () => {
                handleProfileClick(index).catch(err => logger.error('handleProfileClick failed', err));
            };

            const longPressCallback = () => {
                openFavoriteContextMenu(clonedButton, index);
            };

            setupPressAndHold(clonedButton, clickCallback, longPressCallback);
        });

        // Note: This assumes a specific DOM structure which may not exist on all pages using this module.
        const uploadButton = document.getElementById('upload-profile-btn');
        const fileInput = document.getElementById('profile-upload-input');
        if (uploadButton && fileInput) {
            // Remove existing listeners to prevent duplicates by cloning the element
            const newUploadButton = uploadButton.cloneNode(true);
            uploadButton.parentNode.replaceChild(newUploadButton, uploadButton);

            newUploadButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                fileInput.click();
            });
            fileInput.addEventListener('change', handleProfileUpload);
        }

    } catch (error) {
        logger.error('CRITICAL: Error during Profile Manager initialization:', error);
    }

    logger.info('Profile Manager initialized.');
    return profileLoadStatus;
}