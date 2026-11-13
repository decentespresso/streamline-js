import {
    compareVersions, normalizeReleaseState, shouldCheck, recordSuccess, recordFailure,
    recordRateLimit, getTag, isRateLimited, limitRemainingMs, shouldPromptReload,
    SUCCESS_TTL_MS, FAILURE_TTL_MS, DEFAULT_LIMIT_MS, MAX_LIMIT_MS, MAX_REPOS,
} from '../src/modules/skin-version.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// decaid #1118: a 2026-11-06 log shows the tablet's unauthenticated GitHub quota
// (60/h, shared with Decaid's own app/skin/plugin checks) exhausted, after which
// the settings page cached every refused lookup as "no tag" and rendered
// "Up to date" anyway, and POST /webui/skins/update's 500 reached the user as
// "500 Internal Server Error" instead of Decaid's cooldown message.
// streamline-js #196: Decaid updates skin files on disk in the background, and
// the running WebView keeps the old modules until something reloads the page.
// What is checked here:
//   - a check is never retried through an active cooldown, and a 403/429 stops
//     every repo (the quota is per-IP), honouring the reset header;
//   - an unknown or failed answer never reads as a known tag, so no caller can
//     turn it into "Up to date";
//   - the cache survives a round trip through storage, tolerates junk, and stays
//     bounded;
//   - updateSkins surfaces Decaid's JSON `error` and falls back to the HTTP
//     status for a non-JSON body;
//   - the reload prompt fires only when the disk build is strictly newer.

const T0 = 1_700_000_000_000;
const fresh = () => normalizeReleaseState(null);

// ── compareVersions ─────────────────────────────────────────────────────────
test('compareVersions orders releases, prereleases and v-prefixes', () => {
    assert.equal(compareVersions('0.2.20', '0.2.21'), -1);
    assert.equal(compareVersions('0.2.20', 'v0.2.20'), 0);
    assert.equal(compareVersions('0.3.0', '0.2.99'), 1);
    assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
    assert.equal(compareVersions('0.2.9', '0.2.10'), -1);
});

// ── cooldown policy ─────────────────────────────────────────────────────────
test('a never-checked repo is checkable; a fresh success is not', () => {
    const state = fresh();
    assert.equal(shouldCheck(state, 'owner/repo', T0), true);

    recordSuccess(state, 'owner/repo', 'v1.2.3', T0);
    assert.equal(shouldCheck(state, 'owner/repo', T0 + 60_000), false);
    assert.equal(shouldCheck(state, 'owner/repo', T0 + SUCCESS_TTL_MS), true);
});

test('a failed check retries sooner than a successful one, and keeps the old tag', () => {
    const state = fresh();
    recordSuccess(state, 'owner/repo', 'v1.2.3', T0);
    recordFailure(state, 'owner/repo', T0 + SUCCESS_TTL_MS);

    assert.equal(shouldCheck(state, 'owner/repo', T0 + SUCCESS_TTL_MS + 60_000), false);
    assert.equal(shouldCheck(state, 'owner/repo', T0 + SUCCESS_TTL_MS + FAILURE_TTL_MS), true);
    // A network blip must not throw away an answer GitHub already gave.
    assert.deepEqual(getTag(state, 'owner/repo'), { tag: 'v1.2.3', known: true });
});

test('403/429 stops every repo until GitHub\'s reset time', () => {
    const state = fresh();
    const reset = Math.floor((T0 + 25 * 60_000) / 1000); // x-ratelimit-reset, epoch seconds
    recordRateLimit(state, { reset }, T0);

    assert.equal(isRateLimited(state, T0), true);
    assert.equal(shouldCheck(state, 'owner/repo', T0), false);
    assert.equal(shouldCheck(state, 'other/repo', T0), false);
    assert.equal(limitRemainingMs(state, T0), 25 * 60_000);
    // Past the reset, checks resume.
    assert.equal(shouldCheck(state, 'owner/repo', T0 + 25 * 60_000 + 1), true);
    assert.equal(limitRemainingMs(state, T0 + 25 * 60_000 + 1), 0);
});

test('rate limit falls back to Retry-After, then to an hour, and never trusts a wild reset', () => {
    const retry = fresh();
    recordRateLimit(retry, { retryAfter: '120' }, T0);
    assert.equal(limitRemainingMs(retry, T0), 120_000);

    const bare = fresh();
    recordRateLimit(bare, {}, T0);
    assert.equal(limitRemainingMs(bare, T0), DEFAULT_LIMIT_MS);

    const stale = fresh();
    recordRateLimit(stale, { reset: Math.floor((T0 - 60_000) / 1000) }, T0); // already past
    assert.equal(limitRemainingMs(stale, T0), DEFAULT_LIMIT_MS);

    const wild = fresh();
    recordRateLimit(wild, { reset: Math.floor((T0 + 40 * 24 * 3600_000) / 1000) }, T0);
    assert.equal(limitRemainingMs(wild, T0), MAX_LIMIT_MS);
});

test('a longer cooldown is never shortened by a later refusal', () => {
    const state = fresh();
    recordRateLimit(state, { retryAfter: '3600' }, T0);
    recordRateLimit(state, { retryAfter: '60' }, T0);
    assert.equal(limitRemainingMs(state, T0), 3600_000);
});

// ── no false "Up to date" ───────────────────────────────────────────────────
test('unknown answers never read as a known tag', () => {
    const state = fresh();
    // Never checked.
    assert.deepEqual(getTag(state, 'owner/repo'), { tag: null, known: false });
    // No slug at all (skin not installed from a GitHub release).
    assert.deepEqual(getTag(state, null), { tag: null, known: false });
    // Checked and refused.
    recordFailure(state, 'owner/repo', T0);
    assert.equal(getTag(state, 'owner/repo').known, false);
    // 200 with no release on the repo.
    recordSuccess(state, 'empty/repo', null, T0);
    assert.equal(getTag(state, 'empty/repo').known, false);
    // Rate-limited with nothing cached stays unknown rather than reassuring.
    recordRateLimit(state, {}, T0);
    assert.equal(getTag(state, 'never/asked').known, false);
});

// This is the badge decision the settings page makes, lifted to its policy: an
// unknown tag must produce neither "Update available" nor "Up to date".
test('badge state is three-way: newer, same, or nothing to say', () => {
    const state = fresh();
    recordSuccess(state, 'a/one', 'v0.3.0', T0);
    recordSuccess(state, 'a/two', 'v0.2.20', T0);

    const badge = (slug, installed) => {
        const { tag, known } = getTag(state, slug);
        if (!known || !installed) return '';
        return compareVersions(installed, tag) < 0 ? 'Update available' : 'Up to date';
    };

    assert.equal(badge('a/one', '0.2.20'), 'Update available');
    assert.equal(badge('a/two', '0.2.20'), 'Up to date');
    assert.equal(badge('a/three', '0.2.20'), '');   // never checked
    assert.equal(badge('a/one', null), '');         // no installed version reported
});

// ── storage round trip and bounds ───────────────────────────────────────────
test('state survives a JSON round trip and tolerates junk', () => {
    const state = fresh();
    recordSuccess(state, 'owner/repo', 'v1.0.0', T0);
    recordRateLimit(state, { retryAfter: '600' }, T0);

    const back = normalizeReleaseState(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(getTag(back, 'owner/repo'), { tag: 'v1.0.0', known: true });
    assert.equal(limitRemainingMs(back, T0), 600_000);

    for (const junk of [null, undefined, 'nope', 42, [], { repos: 'x' }, { repos: { 'a/b': null } },
                        { repos: { 'a/b': { tag: 'v1', checkedAt: 'soon' } }, limitedUntil: 'never' }]) {
        const safe = normalizeReleaseState(junk);
        assert.deepEqual(safe.repos, {});
        assert.equal(safe.limitedUntil, 0);
        assert.equal(shouldCheck(safe, 'a/b', T0), true);
    }
});

test('the cache stays bounded, keeping the most recently checked repos', () => {
    const state = fresh();
    for (let i = 0; i < MAX_REPOS + 5; i++) recordSuccess(state, `owner/repo${i}`, `v1.0.${i}`, T0 + i * 1000);

    assert.equal(Object.keys(state.repos).length, MAX_REPOS);
    assert.equal(getTag(state, 'owner/repo0').known, false);                 // oldest dropped
    assert.equal(getTag(state, `owner/repo${MAX_REPOS + 4}`).known, true);   // newest kept
});

// ── updateSkins error surfacing (api.js) ────────────────────────────────────
// api.js can't be imported under node (browser globals), so the function under
// test is lifted out of the source and run with fetch injected -- same trick as
// dye2-plugin-source.test.mjs.
{
    const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
    const match = source.match(/export async function updateSkins\(\) \{[\s\S]*?\r?\n\}/);
    assert.ok(match, 'api.js: updateSkins not found');
    const body = match[0].replace('export ', '');

    const build = (response) => {
        const calls = [];
        const { updateSkins } = new Function(
            'API_BASE_URL', 'fetch',
            `${body}\nreturn { updateSkins };`
        )('http://x:8080/api/v1', async (url, opts) => {
            calls.push({ url, opts });
            return response;
        });
        return { updateSkins, calls };
    };

    test('updateSkins posts to the update endpoint and returns the body', async () => {
        const { updateSkins, calls } = build({
            ok: true, status: 200, statusText: 'OK',
            json: async () => ({ message: 'Skin update check completed' }),
        });
        const result = await updateSkins();

        assert.equal(calls[0].url, 'http://x:8080/api/v1/webui/skins/update');
        assert.equal(calls[0].opts.method, 'POST');
        assert.equal(result.message, 'Skin update check completed');
    });

    test('updateSkins shows Decaid\'s error, not the bare HTTP status', async () => {
        const reason = 'GitHub rate limit exceeded; retry after 17:52';
        const { updateSkins } = build({
            ok: false, status: 500, statusText: 'Internal Server Error',
            json: async () => ({ error: reason }),
        });
        await assert.rejects(updateSkins(), new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    test('updateSkins falls back to the status when the body is not usable JSON', async () => {
        for (const json of [
            async () => { throw new SyntaxError('Unexpected token <'); },  // HTML error page
            async () => ({ error: '   ' }),                                 // blank message
            async () => ({ message: 'nope' }),                              // no error field
            async () => null,
        ]) {
            const { updateSkins } = build({ ok: false, status: 500, statusText: 'Internal Server Error', json });
            await assert.rejects(updateSkins(), /500 Internal Server Error/);
        }
    });
}

// ── reload prompt (streamline-js #196) ─────────────────────────────────────
test('the reload prompt fires only when the build on disk is strictly newer', () => {
    assert.equal(shouldPromptReload({ running: '0.2.20', disk: '0.2.25' }), true);
    assert.equal(shouldPromptReload({ running: '0.2.25', disk: '0.2.25' }), false);
    // A dev build ahead of what Decaid has on disk must not nag.
    assert.equal(shouldPromptReload({ running: '0.3.0', disk: '0.2.25' }), false);
    // Nothing to compare against: Decaid unreachable, or the skin not registered.
    assert.equal(shouldPromptReload({ running: '0.2.20', disk: undefined }), false);
    assert.equal(shouldPromptReload({ running: '0.2.20', disk: '' }), false);
    assert.equal(shouldPromptReload({}), false);
    assert.equal(shouldPromptReload(), false);
});
