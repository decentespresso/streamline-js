import test from 'node:test';
import assert from 'node:assert/strict';
import {
    readTimeToReadyFrame,
    heatingSecondsLeft,
    TTR_STALE_MS,
    TTR_OVERRUN_MS,
    TTR_CAP_S,
} from '../src/modules/heating-countdown.js';

const NOW = 1_700_000_000_000;

test('a heating frame becomes an absolute deadline', () => {
    assert.deepEqual(
        readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 42_000 }, NOW),
        { deadline: NOW + 42_000, at: NOW },
    );
});

test('non-heating and zero-remaining frames carry no estimate of their own', () => {
    for (const frame of [
        { status: 'reached', remainingTimeMs: 0 },
        { status: 'heating', remainingTimeMs: 0 },
        { status: 'idle' },
        undefined,
    ]) {
        assert.equal(readTimeToReadyFrame(frame, NOW), null);
    }
});

test('an unusable frame keeps the estimate instead of flipping to plain "Heating"', () => {
    const est = readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 42_000 }, NOW);

    // The ttr socket mixes these in while the DE1 snapshot still says heating.
    let held = est;
    for (const [elapsed, frame] of [
        [1_000, { status: 'reached', remainingTimeMs: 0 }],
        [2_000, { status: 'heating', remainingTimeMs: 0 }],
        [3_000, { status: 'idle' }],
    ]) {
        held = readTimeToReadyFrame(frame, NOW + elapsed, held);
        assert.equal(held.deadline, est.deadline);           // same deadline
        assert.equal(held.at, NOW + elapsed);                // socket is alive
        assert.equal(heatingSecondsLeft(held, NOW + elapsed), 42 - elapsed / 1000);
    }
});

test('frames keep a live socket from expiring past the stale window', () => {
    let held = readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 300_000 }, NOW);
    for (let elapsed = 1_000; elapsed <= 20_000; elapsed += 1_000) {
        held = readTimeToReadyFrame({ status: 'idle' }, NOW + elapsed, held);
        assert.ok(heatingSecondsLeft(held, NOW + elapsed) > 0, `expired at ${elapsed}ms`);
    }
});

test('countdown ticks down between ttr frames instead of freezing', () => {
    const est = readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 42_000 }, NOW);
    assert.equal(heatingSecondsLeft(est, NOW), 42);
    assert.equal(heatingSecondsLeft(est, NOW + 3_000), 39);
});

test('estimate is capped at 5 minutes and only moves once the real one drops under it', () => {
    // As the socket does it: a fresh frame roughly every second.
    const frameAt = (elapsedMs, remainingMs) =>
        heatingSecondsLeft(readTimeToReadyFrame({ status: 'heating', remainingTimeMs: remainingMs }, NOW + elapsedMs), NOW + elapsedMs);

    assert.equal(frameAt(0, 20 * 60_000), TTR_CAP_S);          // 20 min out -> 300s
    assert.equal(frameAt(60_000, 19 * 60_000), TTR_CAP_S);     // 19 min out -> still 300s
    assert.equal(frameAt(19 * 60_000, 60_000), 60);            // under the cap -> real value
});

test('a stale estimate is dropped rather than counted down', () => {
    const est = readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 42_000 }, NOW);
    assert.equal(heatingSecondsLeft(est, NOW + TTR_STALE_MS), 42 - TTR_STALE_MS / 1000);
    assert.equal(heatingSecondsLeft(est, NOW + TTR_STALE_MS + 1), 0);
});

test('a just-passed deadline holds at 1s, an overrun one reads as 0 (plain "Heating")', () => {
    assert.equal(heatingSecondsLeft(null, NOW), 0);

    // Socket stays alive (so staleness is not what ends the countdown) but stops
    // producing numbers: the machine is heating longer than it predicted.
    const alive = (elapsed, held) => readTimeToReadyFrame({ status: 'idle' }, NOW + elapsed, held);
    let held = readTimeToReadyFrame({ status: 'heating', remainingTimeMs: 1_000 }, NOW);

    held = alive(4_000, held);
    assert.equal(heatingSecondsLeft(held, NOW + 4_000), 1);

    const lastGood = 1_000 + TTR_OVERRUN_MS;
    held = alive(lastGood, held);
    assert.equal(heatingSecondsLeft(held, NOW + lastGood), 1);

    held = alive(lastGood + 1, held);
    assert.equal(heatingSecondsLeft(held, NOW + lastGood + 1), 0);
});
