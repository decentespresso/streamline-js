// DOM-free policy shared by the display API and saver settings UI.
export const SAVER_BRIGHTNESS_DEFAULT = 10;
export const SAVER_BRIGHTNESS_KEY = 'screensaverBrightness';
export const SAVER_BRIGHTNESS_CUSTOM_KEY = 'screensaverBrightnessCustom';

/** Resolve a custom level without treating 0 (screen off) as absent. */
export function resolveSaverBrightness(setting = {}) {
    const { custom, stored } = setting ?? {};
    if (custom !== true) return SAVER_BRIGHTNESS_DEFAULT;
    if (typeof stored !== 'number' && typeof stored !== 'string') return SAVER_BRIGHTNESS_DEFAULT;
    if (typeof stored === 'string' && stored.trim() === '') return SAVER_BRIGHTNESS_DEFAULT;
    const level = Number(stored);
    return Number.isFinite(level)
        ? Math.min(100, Math.max(0, Math.round(level)))
        : SAVER_BRIGHTNESS_DEFAULT;
}

/** Parse localStorage strings, retaining the saved level even when disabled. */
export function parseSaverBrightnessSetting(customRaw, levelRaw) {
    return {
        custom: customRaw === 'true',
        stored: resolveSaverBrightness({ custom: true, stored: levelRaw }),
    };
}
