// Is the visualizer.reaplugin account usable? The plugin owns the credentials;
// the skin only reads its settings to decide whether to offer an upload at all.
// DOM-free so node:test can import it.

export const VISUALIZER_PLUGIN_ID = 'visualizer.reaplugin';

/**
 * Did the user log in successfully? A secure password comes back as `{ isSet }`
 * state rather than plaintext (decaid #588), and an older decaid still returns
 * the string, so both spellings count. `Enabled: false` means the account is
 * there but switched off, which is not a login we may upload through.
 */
export function visualizerAccountConfigured(settings) {
    const password = settings?.Password;
    const passwordSet = password == null ? false
        : typeof password === 'object' ? password.isSet === true
        : !!password; // legacy cleartext from older decaid
    return settings?.Enabled !== false && !!(settings?.Username && passwordSet);
}
