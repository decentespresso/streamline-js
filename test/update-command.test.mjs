import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareVersions, getTag, normalizeReleaseState, recordSuccess } from '../src/modules/skin-version.js';

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
// Same badge as the skin cards, same comparison: the running build against the
// newest release tag in Decaid's repo. Driving it off Decaid's own state machine
// left it blank on macOS, where UpdateCheckService returns at its `if (_isMacOS)`
// guard and never looks.

const blockStart = settingsSource.indexOf('function renderAppUpdateBlock(state) {');
assert.notEqual(blockStart, -1, 'renderAppUpdateBlock not found in settings.js');
const blockEnd = settingsSource.indexOf('\n}\n', blockStart) + 3;

// compareVersions and the release-tag cache live in skin-version.js (decaid
// #1118), so the badge reads a real cache here: a tag is known only after a
// successful check recorded it.
const RELEASES_URL = 'https://github.com/decentespresso/decaid/releases';
const renderBadge = ({ current, latest, state = {} }) => {
    const releases = normalizeReleaseState(null);
    if (latest) recordSuccess(releases, 'decentespresso/decaid', latest);
    return new Function(
        'settingsCache', 'getTranslation', 'maybeCheckLatestRelease', 'DECAID_REPO', 'DECAID_RELEASES_URL',
        'compareVersions', 'getTag', 'releaseState',
        `${settingsSource.slice(blockStart, blockEnd)}\n    return renderAppUpdateBlock;`,
    )(
        { appInfo: current ? { version: current } : null },
        (key) => key,
        () => {},
        'decentespresso/decaid',
        RELEASES_URL,
        compareVersions,
        getTag,
        () => releases,
    )(state);
};

test('an older build than the newest release shows "Update available"', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4' });
    assert.ok(html.includes('Update available'));
    assert.ok(!html.includes('Up to date'));
});

test('the offered version is shown next to the badge, without its tag prefix', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4' });
    assert.ok(html.includes('>0.8.4<'));
    assert.ok(!html.includes('>v0.8.4<'));
});

test('matching the newest release shows "Up to date"', () => {
    const html = renderBadge({ current: '0.8.4', latest: 'v0.8.4' });
    assert.ok(html.includes('Up to date'));
    assert.ok(!html.includes('Update available'));
});

test('a build newer than the newest release is not an update', () => {
    const html = renderBadge({ current: '0.9.0', latest: 'v0.8.4' });
    assert.ok(html.includes('Up to date'));
});

test('no badge at all until the release tag is known', () => {
    // Still fetching, offline, or rate-limited: saying "Up to date" there would be
    // the guess this replaced.
    for (const latest of [null, undefined, '']) {
        const html = renderBadge({ current: '0.8.3', latest });
        assert.ok(!html.includes('Up to date'), `latest=${latest}`);
        assert.ok(!html.includes('Update available'), `latest=${latest}`);
    }
    assert.ok(!renderBadge({ current: '', latest: 'v0.8.4' }).includes('Up to date'));
});

test('the install button appears only when Decaid says it can install', () => {
    const outdated = { current: '0.8.3', latest: 'v0.8.4' };
    assert.ok(!renderBadge({ ...outdated, state: { installable: false } }).includes('installAppUpdate'));
    assert.ok(renderBadge({ ...outdated, state: { installable: true } }).includes('installAppUpdate'));
    // Nothing to install when already current.
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
test('off Android an available update links to the release page', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4', state: { installable: false } });
    assert.ok(html.includes(`href="${RELEASES_URL}"`));
    assert.ok(!html.includes('installAppUpdate'));
});

test('Android keeps the in-app install instead of the link', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4', state: { installable: true } });
    assert.ok(html.includes('installAppUpdate'));
    assert.ok(!html.includes(`href="${RELEASES_URL}"`));
});

test('being current offers no action at all', () => {
    const html = renderBadge({ current: '0.8.4', latest: 'v0.8.4', state: { installable: false } });
    assert.ok(!html.includes(`href="${RELEASES_URL}"`));
    assert.ok(!html.includes('installAppUpdate'));
});

// The card renders into #app-update-section, which already carries the box
// styling of the Version card beside it -- a second border would double it up.
test('the block renders card contents, not its own card', () => {
    const html = renderBadge({ current: '0.8.3', latest: 'v0.8.4' });
    assert.ok(!html.trimStart().startsWith('<div class="rounded-'));
});
