import { getReaSettings, setReaSettings } from '../modules/api.js';
import { openDB, getSetting, setSetting } from '../modules/idb.js';

const DEFAULT_REA = Object.freeze({
    weightFlowMultiplier: 1,
    volumeFlowMultiplier: 0.3
});

let state = Object.freeze({
    rea: DEFAULT_REA,
    loading: false,
    error: null
});
let committedRea = DEFAULT_REA;
let pendingRea = Object.freeze({});
let hydrationPromise = null;
let refreshPromise = null;
let savePromise = null;
let networkApplied = false;
let mutationRevision = 0;
const listeners = new Set();

function publish(nextState) {
    state = Object.freeze(nextState);
    listeners.forEach(listener => listener(getSnapshot()));
}

function applyRea(rea, commit = true) {
    if (!rea) return;
    if (commit) committedRea = Object.freeze({ ...DEFAULT_REA, ...rea });
    publish({
        ...state,
        rea: Object.freeze({ ...committedRea, ...pendingRea })
    });
}

async function hydrateInternal() {
    const revision = mutationRevision;
    try {
        await openDB();
        const backup = await getSetting('settingsBackup');
        const freshBackup = backup?.ts && Date.now() - backup.ts < 30 * 24 * 60 * 60 * 1000;
        const rea = freshBackup ? backup.rea : await getSetting('settings-rea');
        if (!networkApplied && revision === mutationRevision) applyRea(rea);
    } catch (error) {
        console.warn('Settings cache hydration failed:', error);
    }
}

async function refreshInternal() {
    const revision = mutationRevision;
    publish({ ...state, loading: true, error: null });
    try {
        const rea = await getReaSettings();
        if (!rea || typeof rea !== 'object' || Array.isArray(rea)) {
            throw new Error('REA settings request returned no data');
        }
        if (revision !== mutationRevision) return;
        networkApplied = true;
        applyRea(rea);
        try {
            await openDB();
            await setSetting('settings-rea', rea);
        } catch (error) {
            console.warn('Settings cache write failed:', error);
        }
    } catch (error) {
        publish({ ...state, error: error?.message || 'Failed to load settings' });
    } finally {
        publish({ ...state, loading: false });
    }
}

export function getSnapshot() {
    return {
        rea: { ...state.rea },
        loading: state.loading,
        error: state.error,
        dirty: Object.keys(pendingRea).length > 0
    };
}

export function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function startSettingsData() {
    hydrationPromise ||= hydrateInternal();
    refreshPromise ||= refreshInternal().finally(() => {
        refreshPromise = null;
    });
    return { hydration: hydrationPromise, refresh: refreshPromise };
}

export function resetSettingsSession() {
    pendingRea = Object.freeze({});
    publish({ ...state, rea: committedRea });
}

export function getPendingReaChanges() {
    return { ...pendingRea };
}

export function updateReaSetting(key, value) {
    if (!Number.isFinite(value)) return;
    pendingRea = Object.freeze({ ...pendingRea, [key]: value });
    publish({
        ...state,
        rea: Object.freeze({ ...state.rea, [key]: value })
    });
}

async function savePendingSettings() {
    while (Object.keys(pendingRea).length > 0) {
        const sent = { ...pendingRea };
        await setReaSettings(sent);
        mutationRevision += 1;
        committedRea = Object.freeze({ ...committedRea, ...sent });
        pendingRea = Object.freeze(Object.fromEntries(
            Object.entries(pendingRea).filter(([key, value]) => !Object.is(sent[key], value))
        ));
        const savedRea = { ...committedRea };
        try {
            await openDB();
            const backup = await getSetting('settingsBackup');
            await Promise.all([
                setSetting('settings-rea', savedRea),
                setSetting('settingsBackup', {
                    ...(backup || {}),
                    ts: Date.now(),
                    rea: savedRea
                })
            ]);
        } catch (error) {
            console.warn('Settings backup write failed:', error);
        }
        publish({ ...state, rea: Object.freeze({ ...committedRea, ...pendingRea }) });
    }
}

export function saveSettingsData() {
    if (Object.keys(pendingRea).length === 0) return Promise.resolve();
    savePromise ||= savePendingSettings().finally(() => {
        savePromise = null;
    });
    return savePromise;
}
