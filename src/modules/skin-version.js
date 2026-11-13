// Version policy for "is something newer out there", in one DOM-free place:
//
//  * compareVersions -- semver-ish ordering used by the skin cards, the Decaid
//    app-update badge, and the reload prompt.
//  * the GitHub release-check cache: which repos we may ask about, what GitHub
//    last answered, and how long we must stay quiet after it refused.
//  * shouldPromptReload -- the disk-newer-than-running test behind the
//    "tap to reload" toast.
//
// No fetch, no localStorage, no window: callers own the I/O and the storage, so
// this stays node-testable (test/skin-version.test.mjs).
//
// Why the cache exists: api.github.com allows 60 unauthenticated requests an
// hour for the whole tablet, and that budget is shared with Decaid's own
// periodic checks for the app, its skins and its plugins. Decaid gates its side
// behind a shared GithubRateLimit (decaid #987/#989/#1067); a browser that asks
// GitHub directly on every settings visit spends the same budget without
// telling anyone, which is what exhausted it in decaid #1118.
//
// This cache is the stopgap. Decaid #1152 asks for availableVersion /
// lastChecked / lastError on WebUIReaMetadata -- the fields plugins already
// have, which is why dyeStrip.js never calls GitHub. Once those land, the
// lookups here go away and the badge becomes a read of Decaid's own state.

export const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;   // a release tag is news at most this often
export const FAILURE_TTL_MS = 10 * 60 * 1000;       // offline / 5xx: retry sooner, but not instantly
export const DEFAULT_LIMIT_MS = 60 * 60 * 1000;     // 403/429 with no reset header: GitHub's window is an hour
export const MAX_LIMIT_MS = 2 * 60 * 60 * 1000;     // never trust a reset header into next week
export const MAX_REPOS = 20;                        // bounded: a tablet cannot have hundreds of skins

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

// Accepts whatever came back out of storage -- including null, a truncated
// write, or a shape from an older build -- and returns a usable state.
export function normalizeReleaseState(saved) {
    const repos = {};
    const src = saved && typeof saved === 'object' && saved.repos && typeof saved.repos === 'object'
        ? saved.repos : {};
    for (const [slug, entry] of Object.entries(src)) {
        if (!slug || !entry || typeof entry !== 'object') continue;
        const checkedAt = Number(entry.checkedAt);
        if (!Number.isFinite(checkedAt)) continue;
        repos[slug] = {
            tag: typeof entry.tag === 'string' && entry.tag ? entry.tag : null,
            checkedAt,
            ok: !!entry.ok,
        };
    }
    const limitedUntil = Number(saved?.limitedUntil);
    return { repos, limitedUntil: Number.isFinite(limitedUntil) ? limitedUntil : 0 };
}

export function isRateLimited(state, now = Date.now()) {
    return Number(state?.limitedUntil) > now;
}

// Milliseconds until the cooldown ends, 0 when there is none. For logging and
// for a caller that wants to say when the answer will be available again.
export function limitRemainingMs(state, now = Date.now()) {
    const until = Number(state?.limitedUntil);
    return Number.isFinite(until) && until > now ? until - now : 0;
}

export function shouldCheck(state, slug, now = Date.now()) {
    if (!slug || !state) return false;
    if (isRateLimited(state, now)) return false;      // never retry through an active cooldown
    const entry = state.repos?.[slug];
    if (!entry) return true;
    return now - entry.checkedAt >= (entry.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS);
}

function prune(state) {
    const entries = Object.entries(state.repos);
    if (entries.length <= MAX_REPOS) return;
    entries.sort((a, b) => b[1].checkedAt - a[1].checkedAt);
    state.repos = Object.fromEntries(entries.slice(0, MAX_REPOS));
}

export function recordSuccess(state, slug, tag, now = Date.now()) {
    state.repos[slug] = { tag: typeof tag === 'string' && tag ? tag : null, checkedAt: now, ok: true };
    prune(state);
    return state;
}

// Offline, DNS failure, 404 (repo has no releases), 5xx. Keeps any tag an
// earlier check established -- a 30-second network blip must not turn a known
// answer into an unknown one -- but marks the entry for an earlier retry.
export function recordFailure(state, slug, now = Date.now()) {
    state.repos[slug] = { tag: state.repos?.[slug]?.tag ?? null, checkedAt: now, ok: false };
    prune(state);
    return state;
}

// GitHub refused for quota: 403 with the rate-limit headers, or 429. Stops every
// repo, not just this one, because the budget is per-IP. `reset` is
// x-ratelimit-reset (epoch seconds), `retryAfter` is Retry-After (seconds).
export function recordRateLimit(state, { reset, retryAfter } = {}, now = Date.now()) {
    const resetMs = Number(reset) * 1000;
    const retryMs = Number(retryAfter) * 1000;
    let until;
    if (Number.isFinite(resetMs) && resetMs > now) until = resetMs;
    else if (Number.isFinite(retryMs) && retryMs > 0) until = now + retryMs;
    else until = now + DEFAULT_LIMIT_MS;
    until = Math.min(until, now + MAX_LIMIT_MS);
    state.limitedUntil = Math.max(Number(state.limitedUntil) || 0, until);
    return state;
}

// What the UI may say. `known` false means we have no answer -- never checked,
// the check failed, or the quota ran out -- and the caller must not render
// "Up to date" off it. Only a tag GitHub actually returned counts.
export function getTag(state, slug) {
    const entry = slug ? state?.repos?.[slug] : null;
    const tag = entry?.tag || null;
    return { tag, known: !!tag };
}

// The files Decaid serves are newer than the bundle this page is running, so a
// reload picks up a version the user already has on disk. Strictly newer only:
// a dev build ahead of disk must not nag.
export function shouldPromptReload({ running, disk } = {}) {
    if (!running || !disk) return false;
    return compareVersions(running, disk) < 0;
}
