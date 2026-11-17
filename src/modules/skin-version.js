// Version policy for skins and for the Decaid app, in one DOM-free place:
//
//  * compareVersions -- semver-ish ordering used by the skin cards, the Decaid
//    app-update badge, and the reload prompt.
//  * shouldPromptReload -- the disk-newer-than-running test behind the
//    "tap to reload" toast.
//  * skinUpdateOutcome -- what a "Check for updates" run actually changed.
//  * appUpdateAvailability -- what the Decaid app-update badge may claim.
//  * switchSkinNatively -- the accept/refuse rule for Decaid's switch hook.
//
// No fetch, no localStorage, no window: callers own the I/O and the storage, so
// this stays node-testable (test/skin-version.test.mjs).
//
// Decaid owns remote update discovery (streamline-js#199). This skin never asks
// api.github.com anything: installed versions come from GET /webui/skins, app
// update state from GET /api/v1/update and ws/v1/update, and installing is
// Decaid's POST /webui/skins/update. The browser-side release-tag cache that
// used to live here -- per-repo GitHub polling against a shared 60/h budget,
// which is what exhausted it in decaid#1118 -- is gone with it.

export function compareVersions(a, b) {
    const parse = (v) => {
        const [core, pre] = String(v || '').trim().replace(/^v/i, '').split('-');
        return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
    };
    const pa = parse(a), pb = parse(b);
    const len = Math.max(pa.nums.length, pb.nums.length);
    for (let i = 0; i < len; i++) {
        const d = (pa.nums[i] || 0) - (pb.nums[i] || 0);
        if (d !== 0) return d < 0 ? -1 : 1;
    }
    // Equal core: a release outranks a prerelease (1.0.0 > 1.0.0-beta.1).
    if (pa.pre && !pb.pre) return -1;
    if (!pa.pre && pb.pre) return 1;
    if (pa.pre && pb.pre) {
        const c = pa.pre.localeCompare(pb.pre, undefined, { numeric: true });
        return c < 0 ? -1 : c > 0 ? 1 : 0;
    }
    return 0;
}

// The files Decaid serves are newer than the bundle this page is running, so a
// reload picks up a version the user already has on disk. Strictly newer only:
// a dev build ahead of disk must not nag.
export function shouldPromptReload({ running, disk } = {}) {
    if (!running || !disk) return false;
    return compareVersions(running, disk) < 0;
}

// What a "Check for updates" run actually did, by comparing the installed
// skins before it with the installed skins after it.
//
// This is a diff and not a read of the response because `POST
// /webui/skins/update` does not report per-skin outcomes: it answers
// `{message: 'Skin update check completed'}` on success and HTTP 500 with a
// plain-language error on any failure, partial completion included (checked
// against decaid's webui_handler.dart, assets/api/rest_v1.yml, and a live call).
// The installed versions it leaves behind are the only per-skin truth available,
// and they are what the cards show anyway.
//
// A skin absent from `before` counts as unchanged: that call only updates skins
// already installed, so an id we have never seen is a first read, not an update.
export function skinUpdateOutcome(before, after) {
    const prior = new Map((before || []).map((s) => [s?.id, s?.version || '']));
    return (after || []).reduce((changes, s) => {
        if (!s?.id || !prior.has(s.id)) return changes;
        const to = s.version || '';
        if (prior.get(s.id) === to) return changes;
        changes.push({ id: s.id, name: s.name || s.id, to });
        return changes;
    }, []);
}

// What the Decaid app-update badge may claim, from an AppUpdateState snapshot
// (GET /api/v1/update, ws/v1/update).
//
// Decaid sets `latestVersion` only while an update is actually available and
// unskipped (`_snapshot` reads `availableUpdate?.version`), so its presence is
// the signal; the version comparison is a guard against a stale snapshot naming
// a release the running build has already caught up with.
//
// There is deliberately no "up to date" answer. `AppUpdateState` carries no
// `lastChecked`, no `hasCompletedCheck` and no `canCheck`, so an idle phase with
// no `latestVersion` means EITHER "checked, nothing new" OR "never checked" --
// and on macOS, or when the install is externally managed, Decaid never checks
// at all (`UpdateCheckService.checkForUpdate` returns at its `_isMacOS` guard,
// Sparkle owns macOS). Claiming "Up to date" off that is the guess decaid#1118
// called out, so the caller shows no badge instead.
export function appUpdateAvailability(state, runningVersion) {
    const latest = state?.latestVersion || '';
    const current = runningVersion || state?.currentVersion || '';
    const available = !!latest && (!current || compareVersions(current, latest) < 0);
    return {
        available,
        latest: latest.replace(/^v/i, ''),
        releaseUrl: state?.releaseUrl || '',
    };
}

// Ask Decaid's host to switch the active skin, and report whether it took it.
//
// `window.decentApp.switchSkin(skinId)` is synchronous and returns true only
// when the host accepted the request: it checks host context, a native-issued
// nonce and the trusted main-frame SkinView first, then drives the navigation
// and persists the new default in-process (decaid#1108). So the call is its own
// feature probe -- a plain browser, an iframe, and a host older than the hook
// all answer falsy, and no token is involved either way.
//
// Anything other than a literal `true` is a refusal, including a truthy value
// from some future host: the caller must not treat "maybe" as a switch in
// flight, because nothing else will tell it the switch is not coming.
//
// Takes the host object rather than reading `window` so this file stays
// DOM-free; settings.js passes `window.decentApp`.
export const switchSkinNatively = (host, skinId) =>
    !!skinId && typeof host?.switchSkin === 'function' && host.switchSkin(skinId) === true;

// Decaid gates POST /webui/skins/update behind an `extensions:manage` bearer
// token (decaid #1163). The skin holds no token, and the tokenless exception
// made for the embedded skin admits only a same-device loopback caller, on a
// Decaid new enough to carry it (0.9.2+3191 has the gate but not the
// exception). Both refusals arrive as 401 "Missing or malformed bearer token",
// which tells the user neither what happened nor what to do -- and the way out
// is not in this skin at all, it is Decaid's own Skins page, which runs the
// same check in-process with no token involved.
//
// Everything else already answers in plain language: GitHub quota, a partial
// update, and the 30-second tokenless throttle ("An update check just ran;
// retry in N seconds") all arrive as a sentence worth showing as-is.
export const SKIN_UPDATE_TOKEN_REFUSED =
    'Decaid would not run this check from the skin. Update from the Decaid app instead: Skins > Check for updates.';

// `translate` is the caller's getTranslation: this module stays DOM-free and
// i18n-free, and the English text above is the CSV key.
export function skinUpdateFailureText(error, translate = (text) => text) {
    if (error?.status === 401) return translate(SKIN_UPDATE_TOKEN_REFUSED);
    const reason = error?.message || String(error ?? 'unknown error');
    return `Failed to update skin: ${reason}`;
}
