// Which theme the skin paints, and where that answer comes from.
//
// Decaid owns the default: its own settings carry themeMode (system | light |
// dark, GET /api/v1/settings), and a skin that has never been told otherwise
// should match the app it is embedded in rather than always booting light.
//
// A stored 'theme' means the user flipped the skin's own toggle. That outranks
// Decaid for good: it is a deliberate per-user preference and it syncs through
// Decaid's KV, while themeMode is per-device.
//
// Returns null when there is nothing to go on, so the caller keeps whatever is
// already painted instead of flashing a default over it.

// Last theme Decaid asked for, kept so the inline boot script in index.html can
// paint it synchronously. A paint cache, never a preference -- it stays out of
// SYNCED_KEYS, since the machine it describes is not the user.
export const DECAID_THEME_KEY = 'theme-decaid';

export function resolveTheme({ stored, decaidMode, systemDark = false } = {}) {
    if (stored === 'light' || stored === 'dark') return stored;
    if (decaidMode === 'light' || decaidMode === 'dark') return decaidMode;
    if (decaidMode === 'system') return systemDark ? 'dark' : 'light';
    return null;
}
