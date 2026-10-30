// Brightness semantics the settings panel has to explain.
//
// Kept DOM-free and separate from settings.js on purpose: AGENTS.md keeps that
// file off the boot path and wants decision logic in a tested helper, and
// node:test cannot import a module that touches document at load.
//
// The strings are used directly as `data-i18n-key`, so they must stay static and
// free of interpolation or HTML-special characters -- translatePage() sets
// textContent from getTranslation(key), which would flatten an interpolated
// number on the next language change.

/**
 * A brightness of 100 hands control to the operating system rather than asking
 * for maximum output. api.js relies on that meaning in restoreDisplay();
 * presenting 100 as "the brightest" is what makes the control misleading.
 */
export const SYSTEM_MANAGED_BRIGHTNESS = 100;

export const SYSTEM_MANAGED_NOTICE =
    'At 100% the system controls screen brightness and the level actually used may differ from the slider.';

/** dimDisplay() sends getSaverBrightness() on sleep: the configured screen
 *  saver level for the image saver (SAVER_BRIGHTNESS_DEFAULT, 10, until one is
 *  set), and 0 for the black screen saver. */
export const SAVER_DIM_NOTICE =
    'The screen saver dims the screen to your screen saver level. Your brightness returns when you wake the screen.';

export const SAVER_BLACK_NOTICE =
    'With the black screen saver the screen goes dark rather than dim, and tapping it restores your brightness.';

/** REA caps brightness at 20 while lowBatteryBrightnessActive (websocket_v1.yml DisplayState,
 *  rest_v1.yml lowBatteryBrightnessLimit). The toggle lives in Settings under Machine, USB with the label
 *  "Dim the screen when low battery"; the slider snaps to the cap on the next display frame. */
export const LOW_BATTERY_NOTICE =
    'Brightness is limited to 20% while the battery is low. Turn off Dim the screen when low battery under Machine, USB in Settings to remove the limit.';

/** Shown when a brightness write could not be sent because the display socket was down;
 *  the queued command goes out when it reconnects. */
export const QUEUED_NOTICE = 'Will apply when the display reconnects';

/** Label of the jump link under the low-battery notice, and the settings-tree
 *  `settingsCategory` (Machine, USB) that renders the lowBatteryBrightnessLimit toggle. */
export const GO_TO_SETTING_LABEL = 'Go to setting';
export const LOW_BATTERY_SETTING_CATEGORY = 'usbchargermode';

/** Translation key / template for the requested-vs-applied readout. The numbers are
 *  substituted after translation, so the key itself stays static and markup-free. */
export const REQUESTED_APPLIED_TEMPLATE = 'Requested {requested}% \u00b7 applied {applied}%';

/**
 * Secondary readout shown when REA applies a level other than the one requested
 * (DisplayState.requestedBrightness vs brightness). Null when there is nothing to
 * say: either value missing or non-numeric, or both round to the same percent.
 * `template` is the translated REQUESTED_APPLIED_TEMPLATE.
 */
export function requestedBrightnessReadout({ requested, applied } = {}, template = REQUESTED_APPLIED_TEMPLATE) {
    if (typeof requested !== 'number' || typeof applied !== 'number') return null;
    if (!Number.isFinite(requested) || !Number.isFinite(applied)) return null;
    const requestedPct = Math.round(requested);
    const appliedPct = Math.round(applied);
    if (requestedPct === appliedPct) return null;
    return template
        .replace('{requested}', String(requestedPct))
        .replace('{applied}', String(appliedPct));
}

export function isSystemManagedBrightness(value) {
    return Number.isFinite(value) && value >= SYSTEM_MANAGED_BRIGHTNESS;
}

/**
 * Notice texts to show under the brightness slider, in render order.
 *
 * `blackScreenSaver` is the user's saved preference (isBlackScreenSaver()), not
 * whether the saver is engaged right now: settings is a routed subpage, so the
 * saver is never showing while this panel is open.
 */
export function brightnessNotices({ brightness, blackScreenSaver = false, lowBatteryActive = false } = {}) {
    const notices = [];
    if (isSystemManagedBrightness(brightness)) notices.push(SYSTEM_MANAGED_NOTICE);
    if (lowBatteryActive === true) notices.push(LOW_BATTERY_NOTICE);
    notices.push(blackScreenSaver ? SAVER_BLACK_NOTICE : SAVER_DIM_NOTICE);
    return notices;
}
