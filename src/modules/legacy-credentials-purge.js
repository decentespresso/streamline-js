// The skin used to keep the user's Visualizer login in localStorage (the
// password only base64-encoded) and re-send it at every boot. The skin no
// longer has any Visualizer code -- the visualizer.reaplugin plugin owns the
// account -- so those keys are dead weight that still holds a secret. This is
// the DOM-free half of the one-time clean-up; the localStorage and flag writes
// live at the call site in app.js.
export const LEGACY_VISUALIZER_KEYS = [
    'visualizerUsername',
    'visualizerPassword',
    'visualizerEnabled',
    'visualizerAutoUpload',
];

// IndexedDB settings flag recording that this device has been cleaned.
export const LEGACY_VISUALIZER_PURGED_FLAG = 'legacy-visualizer-purged';

// The localStorage keys to remove: none once the flag is set, all of them
// before. Removing an absent key is a no-op, so no presence check is needed.
export function legacyKeysToPurge(alreadyPurged) {
    return alreadyPurged ? [] : [...LEGACY_VISUALIZER_KEYS];
}
