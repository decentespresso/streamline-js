import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createSteamTimer,
    foldSteamFrame,
    isSteamDelivering,
    steamAuditFrame,
    steamElapsedSeconds,
    STEAM_SESSION_GAP_MS,
} from '../src/modules/steam-timer.js';

// Drive a timeline of [state, substate, millisecondsSinceStart] frames through
// the timer and read the counter at the end, the way the status line does.
function run(frames, { readAt } = {}) {
    const start = 1_000_000;
    let timer = createSteamTimer();
    let last = start;
    for (const [state, substate, at] of frames) {
        last = start + at;
        timer = foldSteamFrame(timer, { state, substate, now: last });
    }
    return steamElapsedSeconds(timer, readAt === undefined ? last : start + readAt);
}

// The DE1's firmware `steaming` substate reaches the skin as `pouring`
// (decaid#1107); everything else it reports inside MachineState.steam is the
// boiler warming or the wand clearing, not milk being steamed.
test('only steam/pouring is delivery', () => {
    assert.equal(isSteamDelivering('steam', 'pouring'), true);
    assert.equal(isSteamDelivering('steam', 'puffing'), false);
    assert.equal(isSteamDelivering('steam', 'pouringDone'), false);
    assert.equal(isSteamDelivering('steam', 'pausedSteam'), false);
    assert.equal(isSteamDelivering('steam', 'preparingForShot'), false);
    assert.equal(isSteamDelivering('steam', 'idle'), false, 'the filler substate is not delivery');
    assert.equal(isSteamDelivering('espresso', 'pouring'), false, 'espresso pours too');
    assert.equal(isSteamDelivering('steam', undefined), false);
});

// #188: a 20 s steam read 38 s because the old timer ran for as long as the
// machine stayed in MachineState.steam, tail included.
test('the tail after delivery does not count', () => {
    const seconds = run([
        ['steam', 'preparingForShot', 0],
        ['steam', 'pouring', 1000],
        ['steam', 'pouring', 21000],
        ['steam', 'puffing', 21100],
        ['steam', 'puffing', 35000],
        ['steam', 'pouringDone', 39000],
    ]);
    assert.equal(seconds, 20, 'the 18 s of puffing and clearing are not steam');
});

test('warming the boiler before delivery does not count', () => {
    const seconds = run([
        ['steam', 'preparingForShot', 0],
        ['steam', 'preparingForShot', 9000],
        ['steam', 'pouring', 10000],
        ['steam', 'pouring', 15000],
    ]);
    assert.equal(seconds, 5);
});

// A pause is a gap in one session, not the end of it: the barista repositioned
// the pitcher, they did not start a second steam.
test('a pause holds the count and delivery resumes it', () => {
    const frames = [
        ['steam', 'pouring', 0],
        ['steam', 'pouring', 6000],
        ['steam', 'pausedSteam', 6000],
        ['steam', 'pausedSteam', 16000],
        ['steam', 'pouring', 16000],
        ['steam', 'pouring', 20000],
    ];
    assert.equal(run(frames.slice(0, 4)), 6, 'frozen at six while paused');
    assert.equal(run(frames), 10, 'and continues from six, not from zero');
});

test('a steam that genuinely runs long reports its real length', () => {
    const seconds = run([
        ['steam', 'pouring', 0],
        ['steam', 'pouring', 45000],
    ]);
    assert.equal(seconds, 45, 'never capped at the configured duration');
});

// #60: a dropped or odd frame used to restart the count at zero.
test('a single non-steam blip does not restart the count', () => {
    const seconds = run([
        ['steam', 'pouring', 0],
        ['steam', 'pouring', 8000],
        ['idle', 'idle', 8200],
        ['steam', 'pouring', 8400],
        ['steam', 'pouring', 12000],
    ]);
    assert.equal(seconds, 11, 'the 200 ms gap is not counted, and the session is not reset');
});

test('a real second steam starts from zero', () => {
    const seconds = run([
        ['steam', 'pouring', 0],
        ['steam', 'pouring', 10000],
        ['idle', 'idle', 10100],
        ['idle', 'idle', 60000],
        ['steam', 'pouring', 60100],
        ['steam', 'pouring', 63100],
    ]);
    assert.equal(seconds, 3);
});

test('the session boundary sits at the documented gap', () => {
    const atGap = run([
        ['steam', 'pouring', 0],
        ['steam', 'pouring', 5000],
        ['idle', 'idle', 5100],
        ['steam', 'pouring', 5100 + STEAM_SESSION_GAP_MS],
        ['steam', 'pouring', 6100 + STEAM_SESSION_GAP_MS],
    ]);
    assert.equal(atGap, 6, 'away for exactly the gap is still the same session');

    const pastGap = run([
        ['steam', 'pouring', 0],
        ['steam', 'pouring', 5000],
        ['idle', 'idle', 5100],
        ['steam', 'pouring', 5101 + STEAM_SESSION_GAP_MS],
        ['steam', 'pouring', 6101 + STEAM_SESSION_GAP_MS],
    ]);
    assert.equal(pastGap, 1, 'a millisecond longer away is a new one');
});

// The status line is repainted by other events too (a language change replays
// the last frame), and reading between frames must not stall the display.
test('the counter keeps running between frames while delivering', () => {
    const seconds = run([
        ['steam', 'pouring', 0],
        ['steam', 'pouring', 2000],
    ], { readAt: 7000 });
    assert.equal(seconds, 7);
});

test('reading long after a frozen session returns the frozen value', () => {
    const seconds = run([
        ['steam', 'pouring', 0],
        ['steam', 'pouring', 9000],
        ['steam', 'puffing', 9000],
    ], { readAt: 120000 });
    assert.equal(seconds, 9);
});

// ── Steam debug trail (issue #192) ──────────────────────────────────────────

// Drive frames through the audit decision the way updateMachineStatus does,
// carrying the key forward, and collect the lines a submitted log would hold.
function trail(frames) {
    let key = null;
    const lines = [];
    for (const [state, substate, seconds] of frames) {
        const out = steamAuditFrame(key, { state, substate, seconds });
        if (!out) continue;
        key = out.nextKey;
        lines.push(out.line);
    }
    return lines;
}

test('the trail reports one line per substate change, plus the exit', () => {
    // The #193 capture's shape: delivery, then the Two Tap Stop tail.
    assert.deepEqual(trail([
        ['idle', 'idle', 0],
        ['steam', 'preparingForShot', 0],
        ['steam', 'pouring', 0],
        ['steam', 'pouring', 6],
        ['steam', 'puffing', 18],
        ['steam', 'pouringDone', 18],
        ['idle', 'idle', 18],
        ['idle', 'idle', 18],
    ]), [
        'steam/preparingForShot 0s',
        'steam/pouring 0s',
        'steam/puffing 18s',
        'steam/pouringDone 18s',
        'idle/idle 18s',
    ]);
});

test('a steam that never delivers still leaves a trail saying so', () => {
    // #192: the counter stayed at 0. Whether pouring ever arrived is the whole
    // question, and this is the line that answers it.
    assert.deepEqual(trail([
        ['steam', 'preparingForShot', 0],
        ['steam', 'preparingForShot', 0],
        ['idle', 'idle', 0],
    ]), ['steam/preparingForShot 0s', 'idle/idle 0s']);
});

test('frames outside steam are silent once the session has been closed out', () => {
    assert.equal(steamAuditFrame(null, { state: 'idle', substate: 'idle', seconds: 0 }), null);
    assert.equal(steamAuditFrame(null, { state: 'espresso', substate: 'pouring', seconds: 0 }), null);
    assert.equal(steamAuditFrame(null, { state: undefined, substate: undefined, seconds: 0 }), null,
        'a disconnect paint carries no state at all');
});

test('the exit line closes the session so the next steam opens a new trail', () => {
    const exit = steamAuditFrame('steam/pouringDone', { state: 'idle', substate: 'idle', seconds: 9 });
    assert.deepEqual(exit, { line: 'idle/idle 9s', nextKey: null });
});

test('folding is pure', () => {
    const timer = createSteamTimer();
    const next = foldSteamFrame(timer, { state: 'steam', substate: 'pouring', now: 5 });
    assert.deepEqual(timer, createSteamTimer(), 'the input is untouched');
    assert.notDeepEqual(next, timer);
    assert.equal(steamElapsedSeconds(undefined, 1000), 0, 'an absent timer reads as zero');
});
