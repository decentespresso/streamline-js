import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { appUpdateAvailability, compareVersions } from '../src/modules/skin-version.js';

const apiSource = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const apiStart = apiSource.indexOf('export function connectUpdateWebSocket');
const apiEnd = apiSource.indexOf('\n\n', apiSource.indexOf('\n}', apiSource.indexOf('export function sendUpdateCommand', apiStart)) + 2);
assert.notEqual(apiStart, -1);
assert.notEqual(apiEnd, -1);
const apiFunctions = apiSource.slice(apiStart, apiEnd).replaceAll('export ', '');

const loadApi = (socket) => new Function(
    'ReconnectingWebSocket',
    'WebSocket',
    'WS_PROTOCOL',
    'reaHostname',
    'REA_PORT',
    'RECONNECT_POLICY',
    'logger',
    `let updateWebSocket = null;
    let updateWebSocketReady = false;
    ${apiFunctions}
    return { connectUpdateWebSocket, sendUpdateCommand };`,
)(
    function ReconnectingWebSocket() { return socket; },
    { OPEN: 1 },
    'ws:',
    'decaid',
    8080,
    { critical: {}, standard: {}, background: {} },
    { error() {}, info() {}, warn() {} },
);

test('the automatic update check waits for the socket to open', () => {
    let readyState = 0;
    let payload;
    const socket = {
        get readyState() { return readyState; },
        send(value) { payload = value; },
    };
    const { connectUpdateWebSocket, sendUpdateCommand } = loadApi(socket);
    const command = { command: 'check' };

    connectUpdateWebSocket(() => {}, () => sendUpdateCommand(command));
    assert.equal(payload, undefined);

    readyState = 1;
    socket.onopen();
    assert.equal(payload, JSON.stringify(command));
});

test('update commands reject an unavailable socket', () => {
    const api = loadApi({ readyState: 0 });
    api.connectUpdateWebSocket(() => {});
    assert.throws(
        () => api.sendUpdateCommand({ command: 'install' }),
        /Update WebSocket is not connected/,
    );
});

const settingsSource = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const settingsStart = settingsSource.indexOf('function initAppUpdateSection() {');
const settingsEnd = settingsSource.indexOf('\n\n// Render updates settings', settingsStart);
assert.notEqual(settingsStart, -1);
assert.notEqual(settingsEnd, -1);
const initSource = settingsSource.slice(settingsStart, settingsEnd);

const loadInit = () => {
    const settingsCache = { appUpdateState: null };
    const commands = [];
    const toasts = [];
    const window = {};
    const state = { failSend: false, onData: null, onOpen: null };
    const connectUpdateWebSocket = (dataHandler, openHandler) => {
        state.onData = dataHandler;
        state.onOpen = openHandler;
    };
    const sendUpdateCommand = (command) => {
        if (state.failSend) throw new Error('Update WebSocket is not connected');
        commands.push(command);
    };
    new Function(
        'window', 'settingsCache', 'sendUpdateCommand', 'connectUpdateWebSocket',
        'ui', 'document', 'renderAppUpdateBlock',
        `${initSource}\ninitAppUpdateSection();`,
    )(
        window, settingsCache, sendUpdateCommand, connectUpdateWebSocket,
        { showToast: (...args) => toasts.push(args) },
        { getElementById: () => null },
        () => '',
    );
    return { settingsCache, commands, toasts, window, state };
};

// The socket exists for the Android in-app install and its progress; the check on
// open is what populates `installable` there. It is silent by design -- on macOS
// Decaid answers it with nothing at all.
test('the socket opens with a silent check and tracks state frames', () => {
    const { settingsCache, commands, state } = loadInit();

    assert.deepEqual(commands, []);
    state.onOpen();
    assert.deepEqual(commands, [{ command: 'check' }]);

    state.onData({ phase: 'available', installable: true });
    assert.deepEqual(settingsCache.appUpdateState, { phase: 'available', installable: true });
});

test('install reports a socket that is not there', () => {
    const { toasts, window, state } = loadInit();
    state.failSend = true;
    window.installAppUpdate();
    assert.deepEqual(toasts, [['Update WebSocket is not connected', 5000, 'error']]);
});

test('a command-level error reply is surfaced with its url', () => {
    const { toasts, state } = loadInit();
    state.onData({ error: 'In-app install is not supported on this platform', url: 'https://example/releases' });
    assert.equal(toasts.length, 1);
    assert.match(toasts[0][0], /not supported on this platform — https:\/\/example\/releases/);
});

// ─── Decaid update badge ─────────────────────────────────────────────────────
// Decaid is the only source (streamline-js#199): the panel reads the
// AppUpdateState it streams and asks api.github.com nothing. Decaid names
// latestVersion only while an update is available, so there is an "Update
// available" badge and deliberately no "Up to date" one -- see
// appUpdateAvailability for why its payload cannot support that claim.

const blockStart = settingsSource.indexOf('function renderAppUpdateBlock(state) {');
assert.notEqual(blockStart, -1, 'renderAppUpdateBlock not found in settings.js');
const blockEnd = settingsSource.indexOf('\n}\n', blockStart) + 3;

const RELEASES_URL = 'https://github.com/decentespresso/decaid/releases';
// `current` is what settingsCache.appInfo reports (the app this page is talking
// to); everything else is the snapshot Decaid pushed.
const renderBadge = ({ current, latest, state = {} }) => new Function(
    'settingsCache', 'getTranslation', 'DECAID_RELEASES_URL', 'appUpdateAvailability',
    `${settingsSource.slice(blockStart, blockEnd)}\n    return renderAppUpdateBlock;`,
)(
    { appInfo: current ? { version: current } : null },
    (key) => key,
    RELEASES_URL,
    appUpdateAvailability,
)({ currentVersion: current, latestVersion: latest ?? null, ...state });

test('a build older than the version Decaid offers shows "Update available"', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4' });
    assert.ok(html.includes('Update available'));
    assert.ok(!html.includes('Up to date'));
});

test('the offered version is shown next to the badge, without its tag prefix', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4' });
    assert.ok(html.includes('>0.8.4<'));
    assert.ok(!html.includes('>v0.8.4<'));
});

test('no badge at all when Decaid names no newer version', () => {
    // Nothing offered covers three states this payload cannot tell apart --
    // checked and current, never checked, and macOS where Decaid never checks --
    // so the panel says nothing rather than guessing "Up to date".
    for (const latest of [null, undefined, '']) {
        const html = renderBadge({ current: '0.8.3', latest });
        assert.ok(!html.includes('Up to date'), `latest=${latest}`);
        assert.ok(!html.includes('Update available'), `latest=${latest}`);
    }
});

test('a build newer than the offered version is not an update', () => {
    const html = renderBadge({ current: '0.9.0', latest: 'v0.8.4' });
    assert.ok(!html.includes('Update available'));
    assert.ok(!html.includes('Up to date'));
});

test('the install button appears only when Decaid says it can install', () => {
    const outdated = { current: '0.8.3', latest: 'v0.8.4' };
    assert.ok(!renderBadge({ ...outdated, state: { installable: false } }).includes('installAppUpdate'));
    assert.ok(renderBadge({ ...outdated, state: { installable: true } }).includes('installAppUpdate'));
    // Nothing to install when nothing newer is offered.
    assert.ok(!renderBadge({ current: '0.8.4', latest: 'v0.8.4', state: { installable: true } }).includes('installAppUpdate'));
});

test('a download in progress replaces the button with its progress', () => {
    const html = renderBadge({
        current: '0.8.3', latest: 'v0.8.4',
        state: { phase: 'downloading', progress: 0.42, installable: true },
    });
    assert.ok(html.includes('Updating'));
    assert.ok(html.includes('width:42%'));
});

// Only Android can install in place; everywhere else the release page is the way
// through, so that is what the button offers.
test('off Android an available update links to the release Decaid named', () => {
    const html = renderBadge({
        current: '0.8.3', latest: 'v0.8.4',
        state: { installable: false, releaseUrl: 'https://github.com/decentespresso/decaid/releases/tag/v0.8.4' },
    });
    assert.ok(html.includes('href="https://github.com/decentespresso/decaid/releases/tag/v0.8.4"'));
    assert.ok(!html.includes('installAppUpdate'));
});

test('with no release URL in the snapshot the link falls back to the releases page', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4', state: { installable: false } });
    assert.ok(html.includes(`href="${RELEASES_URL}"`));
});

test('Android keeps the in-app install instead of the link', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4', state: { installable: true } });
    assert.ok(html.includes('installAppUpdate'));
    assert.ok(!html.includes('href="https://github.com'));
});

test('nothing offered means no action at all', () => {
    const html = renderBadge({ current: '0.8.4', latest: 'v0.8.4', state: { installable: false } });
    assert.ok(!html.includes(`href="${RELEASES_URL}"`));
    assert.ok(!html.includes('installAppUpdate'));
});

// The badge must not come back through a side door: the page that renders it
// holds no api.github.com URL at all (prose about Decaid's own checks is fine),
// and the cache key it used to keep is only ever removed.
test('settings.js asks GitHub nothing about versions', () => {
    assert.ok(!settingsSource.includes('https://api.github.com'));
    // The dead cache key survives in exactly one place: the line that deletes it.
    assert.deepEqual(settingsSource.match(/githubReleaseChecks/g), ['githubReleaseChecks']);
    assert.ok(settingsSource.includes("removeItem('githubReleaseChecks')"));
});

// The card renders into #app-update-section, which already carries the box
// styling of the Version card beside it -- a second border would double it up.
test('the block renders card contents, not its own card', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4' });
    assert.ok(!html.trimStart().startsWith('<div class="rounded-'));
});
