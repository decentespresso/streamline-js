import {
    compareVersions, shouldPromptReload, skinUpdateFailureText, SKIN_UPDATE_TOKEN_REFUSED,
    switchSkinNatively, skinUpdateOutcome, appUpdateAvailability,
} from '../src/modules/skin-version.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// streamline-js #199: Decaid owns remote update discovery. This skin shows the
// versions Decaid reports as installed and never asks api.github.com anything,
// so the browser-side release-tag cache that used to be tested here is gone --
// with it went the "Up to date" badge it fed, which decaid #1118 showed could be
// rendered off a refused lookup.
// streamline-js #196: Decaid updates skin files on disk in the background, and
// the running WebView keeps the old modules until something reloads the page.
// What is checked here:
//   - version ordering across releases, prereleases and v-prefixes;
//   - what a "Check for updates" run changed, read off the installed versions
//     because POST /webui/skins/update reports no per-skin outcome;
//   - the app-update badge claims "available" only on Decaid's own evidence and
//     never claims "up to date", which its payload cannot support;
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

// ── what an update run changed ──────────────────────────────────────────────
// POST /webui/skins/update answers "Skin update check completed" and nothing
// per-skin, so the installed versions before and after are the only evidence.

test('an update run reports the skins whose installed version moved', () => {
    const before = [
        { id: 'streamline', name: 'Streamline', version: '0.1.33' },
        { id: 'overdose', name: 'OverDose', version: '0.0.13' },
        { id: 'decal', name: 'Decal', version: '0.1.0' },
    ];
    const after = [
        { id: 'streamline', name: 'Streamline', version: '0.1.34' },
        { id: 'overdose', name: 'OverDose', version: '0.0.13' },
        { id: 'decal', name: 'Decal', version: '0.1.0' },
    ];
    assert.deepEqual(skinUpdateOutcome(before, after),
        [{ id: 'streamline', name: 'Streamline', to: '0.1.34' }]);
});

test('a run that changed nothing reports nothing', () => {
    const skins = [{ id: 'overdose', name: 'OverDose', version: '0.0.13' }];
    assert.deepEqual(skinUpdateOutcome(skins, skins), []);
    assert.deepEqual(skinUpdateOutcome([], []), []);
    assert.deepEqual(skinUpdateOutcome(null, undefined), []);
});

test('a skin absent before the run is a first read, not an update', () => {
    // That call only updates skins already installed, so an id we have never
    // seen must not be announced as "Updated".
    assert.deepEqual(skinUpdateOutcome([], [{ id: 'new', name: 'New', version: '1.0.0' }]), []);
});

test('a skin that lost or gained a reported version still counts as changed', () => {
    // Decaid reporting no version is itself a change worth repainting for; the
    // card falls back to showing none rather than a stale number.
    assert.deepEqual(
        skinUpdateOutcome([{ id: 'x', name: 'X', version: '1.0.0' }], [{ id: 'x', name: 'X' }]),
        [{ id: 'x', name: 'X', to: '' }]);
    assert.deepEqual(
        skinUpdateOutcome([{ id: 'x', name: 'X' }], [{ id: 'x', name: 'X', version: '1.0.0' }]),
        [{ id: 'x', name: 'X', to: '1.0.0' }]);
});

test('an update run falls back to the skin id when Decaid reports no name', () => {
    assert.deepEqual(
        skinUpdateOutcome([{ id: 'x', version: '1' }], [{ id: 'x', version: '2' }]),
        [{ id: 'x', name: 'x', to: '2' }]);
});

// ── the Decaid app-update badge ─────────────────────────────────────────────
// Decaid sets latestVersion only while an update is available and unskipped, so
// its presence is the whole signal. There is no "up to date" answer to give: an
// idle phase with no latestVersion is "checked, nothing new" OR "never checked"
// (every run on macOS, and every externally managed install).

test('app update: a named latest version newer than the running build is available', () => {
    const got = appUpdateAvailability({ phase: 'available', currentVersion: '0.9.2', latestVersion: '0.9.3' });
    assert.equal(got.available, true);
    assert.equal(got.latest, '0.9.3');
});

test('app update: the running build wins over the snapshot\'s own currentVersion', () => {
    // settingsCache.appInfo is the app this page is talking to; the snapshot may
    // be older than the running build after an in-place install.
    assert.equal(appUpdateAvailability({ currentVersion: '0.9.0', latestVersion: '0.9.1' }, '0.9.2').available, false);
    assert.equal(appUpdateAvailability({ currentVersion: '0.9.2', latestVersion: '0.9.3' }, '0.9.1').available, true);
});

test('app update: no latest version is never an update, whatever the phase', () => {
    // idle on a tablet that just checked, idle on macOS where Decaid never
    // checks, and mid-check all look the same from here -- so: nothing claimed.
    for (const phase of ['idle', 'checking', 'error', undefined]) {
        const got = appUpdateAvailability({ phase, currentVersion: '0.9.2', latestVersion: null });
        assert.equal(got.available, false, `phase=${phase}`);
        assert.equal(got.latest, '');
    }
    assert.equal(appUpdateAvailability(null, '0.9.2').available, false);
    assert.equal(appUpdateAvailability(undefined, undefined).available, false);
});

test('app update: an equal or older latest version is not an update', () => {
    // A stale snapshot, or a release the running build has already caught up
    // with, must not keep the badge lit.
    assert.equal(appUpdateAvailability({ currentVersion: '0.9.3', latestVersion: '0.9.3' }).available, false);
    assert.equal(appUpdateAvailability({ currentVersion: '0.9.4', latestVersion: '0.9.3' }).available, false);
});

test('app update: the offered version drops a tag prefix, and the release URL is passed through', () => {
    const got = appUpdateAvailability({ currentVersion: '0.9.2', latestVersion: 'v0.9.3', releaseUrl: 'https://x/releases/tag/v0.9.3' });
    assert.equal(got.latest, '0.9.3');
    assert.equal(got.releaseUrl, 'https://x/releases/tag/v0.9.3');
    assert.equal(appUpdateAvailability({ latestVersion: '1.0.0' }).releaseUrl, '');
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

// The prompt is the toast itself: there is no button in it, so the toast has to
// read as the thing to tap. A solid alert-info fill read as a plain notice.
test('a toast with an onClick is painted as an invitation to tap', () => {
    const ui = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/css/main.css', import.meta.url), 'utf8');

    assert.match(ui, /classList\.toggle\('toast-tappable', !!toastClickFn\)/,
        'only a toast that does something gets the treatment');
    assert.match(ui, /classList\.remove\('toast-tappable'\)/,
        'and it is dropped when the toast hides, so the next one starts clean');

    const rule = css.match(/\.alert\.toast-tappable \{[^}]*\}/);
    assert.ok(rule, 'two classes, so it beats .alert-info whatever the sheet order');
    assert.match(rule[0], /color: var\(--status-clickable-color\)/,
        "the skin's own blue for 'you can tap this'");
    assert.match(rule[0], /cursor: pointer/);
});

// ── skin update refusals (decaid #1163) ────────────────────────────────────
test('a 401 points at the Decaid app, anything else keeps the server sentence', () => {
    const refused = Object.assign(new Error('Missing or malformed bearer token'), { status: 401 });
    const text = skinUpdateFailureText(refused);
    assert.ok(!text.includes('bearer'), 'Decaid\'s wording tells the user nothing');
    assert.match(text, /Check for updates/, 'it names the way out instead');

    // The throttle, GitHub quota and partial-update messages are already
    // sentences a user can act on, so they are shown as they arrived.
    const throttled = Object.assign(new Error('An update check just ran; retry in 12 seconds'), { status: 429 });
    assert.equal(skinUpdateFailureText(throttled), 'Failed to update skin: An update check just ran; retry in 12 seconds');
    assert.equal(skinUpdateFailureText(new Error('500 Internal Server Error')), 'Failed to update skin: 500 Internal Server Error');
    // A thrown non-Error (a rejected fetch, a string) must still say something.
    assert.equal(skinUpdateFailureText(null), 'Failed to update skin: unknown error');

    // The English text is the CSV key; settings.js passes getTranslation in.
    assert.equal(skinUpdateFailureText(refused, () => 'translated'), 'translated');
    const csv = readFileSync(new URL('../src/ui/de1 gui translation - Sheet1.csv', import.meta.url), 'utf8');
    assert.ok(csv.split('\r\n').some(line => line.startsWith(SKIN_UPDATE_TOKEN_REFUSED + ',')),
        'the key has a row to translate into');
});

test('updateSkins carries the status so the caller can tell a refusal from a failure', () => {
    const api = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
    const start = api.indexOf('export async function updateSkins()');
    const body = api.slice(start, api.indexOf('\n}\n', start));
    assert.match(body, /error\.status = response\.status/);
});

// ── native skin switching (decaid#1108, streamline-js#186) ────────────────
// The hook is the only switch mechanism that works on a current Decaid: the
// REST chain it replaced is gated on `extensions:manage`, which the skin's
// account-proxy token does not carry. Since the call is also the feature probe,
// these lock what counts as "the host took it".

test('native switch: a host that accepts the request reports a switch in flight', () => {
    const calls = [];
    const host = { switchSkin: (id) => { calls.push(id); return true; } };
    assert.equal(switchSkinNatively(host, 'decaid-skin-42'), true);
    // Exactly once, with the skin ID -- not its name, URL or repo slug.
    assert.deepEqual(calls, ['decaid-skin-42']);
});

test('native switch: a refusal is reported, so the caller can say so instead of waiting', () => {
    // false = no host context, no nonce, not the trusted main-frame SkinView,
    // or an unknown skin. Decaid navigates nothing, so nothing is in flight.
    assert.equal(switchSkinNatively({ switchSkin: () => false }, 'skin-1'), false);
    // Only a literal true is acceptance: a future host answering with some
    // other truthy value must not be read as a switch that is under way.
    assert.equal(switchSkinNatively({ switchSkin: () => 'accepted' }, 'skin-1'), false);
    assert.equal(switchSkinNatively({ switchSkin: () => 1 }, 'skin-1'), false);
});

test('native switch: no hook at all is a refusal, not a crash', () => {
    // A plain browser (no decentApp), and a host older than the hook.
    assert.equal(switchSkinNatively(undefined, 'skin-1'), false);
    assert.equal(switchSkinNatively(null, 'skin-1'), false);
    assert.equal(switchSkinNatively({}, 'skin-1'), false);
    assert.equal(switchSkinNatively({ switchSkin: 'not a function' }, 'skin-1'), false);
});

test('native switch: a missing skin ID never reaches the host', () => {
    let called = false;
    const host = { switchSkin: () => { called = true; return true; } };
    assert.equal(switchSkinNatively(host, ''), false);
    assert.equal(switchSkinNatively(host, undefined), false);
    assert.equal(called, false, 'an empty ID is our bug, not something to ask the host about');
});
