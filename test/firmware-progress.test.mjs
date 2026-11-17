import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    splitNdjson,
    normalizeFirmwareEvent,
    advanceFirmwareState,
    initialFirmwareState,
    summarizeFirmwareCatalog,
    estimateRemainingSeconds,
    isUploadComplete,
    estimateVerifyRemainingSeconds,
    estimateTotalRemainingSeconds,
    transportFromDeviceId,
    firmwareEstimatedTotalSeconds,
    FIRMWARE_ESTIMATED_SECONDS,
    firmwareDurationNote,
    FIRMWARE_VERIFY_SECONDS,
    FIRMWARE_LAST_TICK_PERCENT,
    formatDuration,
} from '../src/modules/firmware-progress.js';

function loadConsumeFirmwareStream() {
    const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('async function consumeFirmwareStream');
    const end = source.indexOf('export async function uploadFirmware', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    return new Function('splitNdjson', 'advanceFirmwareState', 'initialFirmwareState', `${source.slice(start, end)}; return consumeFirmwareStream;`)(splitNdjson, advanceFirmwareState, initialFirmwareState);
}

/** Feed a stream of decoded chunks through framing + folding, as api.js does. */
function runStream(chunks) {
    let buffer = '';
    let state = initialFirmwareState;
    const seen = [];
    chunks.forEach((chunk, i) => {
        const atEnd = i === chunks.length - 1;
        const { events, rest } = splitNdjson(buffer, chunk, atEnd);
        buffer = rest;
        for (const event of events) {
            state = advanceFirmwareState(state, event);
            seen.push({ ...state });
        }
    });
    return { state, seen };
}

test('lines split across chunk boundaries are reassembled', () => {
    const { seen } = runStream([
        '{"event":"erasing"}\n{"event":"upl',
        'oading","progress":0.5}\n',
        '{"event":"done"}\n',
    ]);
    assert.deepEqual(seen.map(s => s.phase), ['erasing', 'uploading', 'done']);
    assert.deepEqual(seen.map(s => s.percent), [0, 50, 100]);
});

test('a final line without a trailing newline is still parsed', () => {
    const { state } = runStream(['{"event":"erasing"}\n{"event":"done"}']);
    assert.equal(state.phase, 'done');
});

test('a response without a readable progress stream is not success', async () => {
    await assert.rejects(loadConsumeFirmwareStream()({ body: null }), /did not provide a progress stream/);
});

test('blank and malformed lines are skipped, not thrown', () => {
    const { events } = splitNdjson('', '\n{"event":"erasing"}\n{oops\n\n', false);
    assert.deepEqual(events, [{ event: 'erasing' }]);
});

test('phase key is read defensively across spellings', () => {
    for (const event of [{ event: 'uploading' }, { phase: 'uploading' }, { status: 'uploading' }, { state: 'uploading' }]) {
        assert.equal(normalizeFirmwareEvent(event).phase, 'uploading');
    }
    assert.equal(normalizeFirmwareEvent({ event: 'something-else' }).phase, null);
    assert.equal(normalizeFirmwareEvent(null).phase, null);
});

test('the -1.0 error sentinel is not treated as a percentage', () => {
    assert.equal(normalizeFirmwareEvent({ event: 'error', progress: -1.0 }).progress, null);

    const state = advanceFirmwareState({ phase: 'uploading', percent: 98, error: null },
        { event: 'error', progress: -1.0, message: 'CRC mismatch' });
    assert.equal(state.phase, 'error');
    assert.equal(state.error, 'CRC mismatch');
    assert.equal(state.percent, 98); // held, not rewound to 0 or -100
});

test('percent holds through the silent verification phase', () => {
    // Last uploading event can report 1.0 before CRC verification even starts.
    const { seen, state } = runStream([
        '{"event":"erasing"}\n{"event":"uploading","progress":0.99}\n{"event":"uploading","progress":1.0}\n{"event":"done"}\n',
    ]);
    assert.deepEqual(seen.map(s => s.percent), [0, 99, 100, 100]);
    assert.equal(state.phase, 'done');
});

test('unrecognised events leave the state untouched', () => {
    const before = { phase: 'uploading', percent: 42, error: null };
    assert.deepEqual(advanceFirmwareState(before, { hello: 'world' }), before);
});

// ── summarizeFirmwareCatalog ────────────────────────────────────────────────

/** The shape GET /machine/firmware actually returns, minus the noise. */
function catalog({ build, artifactBuild = 1352, updateAvailable, reasons = [], recommended = null, operation = 'idle' }) {
    return {
        artifacts: [{
            id: `de1-${artifactBuild}`, build: artifactBuild, versionLabel: String(artifactBuild),
            releaseNotes: 'Fixed a thing.',
            eligibility: { status: reasons.length ? 'notApplicable' : 'applicable', reasons },
        }],
        machine: build === null ? null : { model: 'DE1Pro', build },
        recommendedArtifactId: recommended,
        updateAvailable,
        operation: { state: operation },
    };
}

test('an offered newer build reads as an update', () => {
    const s = summarizeFirmwareCatalog(catalog({ build: 1340, updateAvailable: true, recommended: 'de1-1352' }));
    assert.equal(s.status, 'updateAvailable');
    assert.equal(s.installedBuild, 1340);
    assert.equal(s.latestBuild, 1352);
    assert.equal(s.artifactId, 'de1-1352');
    assert.equal(s.releaseNotes, 'Fixed a thing.');
});

test('a machine ahead of the bundle reads as up to date, with nothing offered', () => {
    // The live case on a beta machine: build 1357 vs bundled 1352. Nothing to
    // install, so it is the same answer as matching — and it must never offer
    // the older build, which decaid would refuse with 422 anyway.
    const s = summarizeFirmwareCatalog(catalog({ build: 1357, updateAvailable: false, reasons: ['not_newer'] }));
    assert.equal(s.status, 'upToDate');
    assert.equal(s.installedBuild, 1357);
    assert.equal(s.latestBuild, 1352);
});

test('matching the bundled build reads as up to date', () => {
    const s = summarizeFirmwareCatalog(catalog({ build: 1352, updateAvailable: false, reasons: ['not_newer'] }));
    assert.equal(s.status, 'upToDate');
});

test('a null verdict is unknown, never up to date', () => {
    // Offline: no machine, so nothing was actually compared. Reporting this as
    // "up to date" would be the one genuinely harmful answer.
    const s = summarizeFirmwareCatalog(catalog({ build: null, updateAvailable: null, reasons: ['machine_not_connected'] }));
    assert.equal(s.status, 'unknown');
    assert.equal(s.reason, 'machine_not_connected');
    assert.equal(s.installedBuild, null);
});

test('an unreachable service is unknown with a reason', () => {
    const s = summarizeFirmwareCatalog(null);
    assert.equal(s.status, 'unknown');
    assert.equal(s.reason, 'unreachable');
});

test('an in-flight operation is surfaced', () => {
    const s = summarizeFirmwareCatalog(catalog({ build: 1340, updateAvailable: true, operation: 'uploading' }));
    assert.equal(s.operationState, 'uploading');
});

// Channel filtering. The entries the helper above builds carry no `channel` at
// all, which is the older-decaid shape and must keep reading as stable — these
// cases cover a bundle that does label its artifacts.
/** @param {Array<{build: number, channel: string, applicable?: boolean}>} entries */
function channelCatalog(entries, { build, updateAvailable, recommended }) {
    return {
        artifacts: entries.map(e => ({
            id: `de1-${e.build}`, build: e.build, versionLabel: String(e.build), channel: e.channel,
            eligibility: e.applicable
                ? { status: 'applicable', reasons: [] }
                : { status: 'notApplicable', reasons: ['not_newer'] },
        })),
        machine: { model: 'DE1Pro', build },
        recommendedArtifactId: recommended,
        updateAvailable,
        operation: { state: 'idle' },
    };
}

test('a prerelease build is not offered, even when decaid recommends it', () => {
    // decaid ranks the whole bundle: its recommendation is the beta. The page
    // offers the newest STABLE build instead, so Download & Install installs the
    // artifact the pill is talking about.
    const s = summarizeFirmwareCatalog(channelCatalog([
        { build: 1352, channel: 'stable', applicable: true },
        { build: 1360, channel: 'beta', applicable: true },
    ], { build: 1340, updateAvailable: true, recommended: 'de1-1360' }));
    assert.equal(s.status, 'updateAvailable');
    assert.equal(s.artifactId, 'de1-1352');
    assert.equal(s.latestBuild, 1352);
});

test('a bundle whose only newer build is prerelease is not an update', () => {
    // Nothing installable on the stable channel, so the verdict must not light up
    // an Install button that would have to reach for the hidden artifact.
    const s = summarizeFirmwareCatalog(channelCatalog([
        { build: 1352, channel: 'stable', applicable: false },
        { build: 1360, channel: 'beta', applicable: true },
    ], { build: 1352, updateAvailable: true, recommended: 'de1-1360' }));
    assert.equal(s.status, 'upToDate');
    assert.equal(s.latestBuild, 1352, 'names the stable build, not the beta');
});

test('the highest applicable stable build wins', () => {
    const s = summarizeFirmwareCatalog(channelCatalog([
        { build: 1352, channel: 'stable', applicable: true },
        { build: 1358, channel: 'stable', applicable: true },
    ], { build: 1337, updateAvailable: true, recommended: 'de1-1358' }));
    assert.equal(s.artifactId, 'de1-1358');
});

test('an empty catalog does not throw', () => {
    const s = summarizeFirmwareCatalog({ artifacts: [], machine: null, updateAvailable: null, operation: { state: 'idle' } });
    assert.equal(s.status, 'unknown');
    assert.equal(s.latestBuild, null);
});

// ── Upload countdown ────────────────────────────────────────────────────────
// The label counts DOWN through the upload. Times are epoch ms; `startedAt` is
// the first `uploading` event, not the start of the operation (the erase carries
// no percentages and would skew the rate). 0 is the "not started" sentinel, so
// these use a real-looking epoch.
const T0 = 1_700_000_000_000;

test('remaining is extrapolated from the observed upload rate', () => {
    // 20% took 60s => 3s per percent => 80% left = 240s. Upload only; the caller
    // adds the CRC allowance (see firmwareClock in settings.js).
    const remaining = estimateRemainingSeconds({
        startedAt: T0, startPercent: 0, percent: 20, updatedAt: T0 + 60_000, now: T0 + 60_000,
    });
    assert.equal(remaining, 240);
});

test('the percent already done when the clock started is not credited to zero time', () => {
    // First event landed at 10%; 10% -> 30% took 60s => 3s per percent => 70% left.
    assert.equal(estimateRemainingSeconds({
        startedAt: T0, startPercent: 10, percent: 30, updatedAt: T0 + 60_000, now: T0 + 60_000,
    }), 210);
    // Ignoring startPercent would price 30% into 60s and understate the wait.
    assert.equal(estimateRemainingSeconds({
        startedAt: T0, startPercent: 0, percent: 30, updatedAt: T0 + 60_000, now: T0 + 60_000,
    }), 140);
});

test('the countdown falls between events instead of climbing', () => {
    const at = now => estimateRemainingSeconds({
        startedAt: T0, startPercent: 0, percent: 20, updatedAt: T0 + 60_000, now,
    });
    // Same event, three repaints of the 1 Hz label.
    assert.equal(at(T0 + 60_000), 240);
    assert.equal(at(T0 + 70_000), 230);
    assert.equal(at(T0 + 90_000), 210);
});

test('a stalled stream floors at zero rather than going negative', () => {
    assert.equal(estimateRemainingSeconds({
        startedAt: T0, startPercent: 0, percent: 20, updatedAt: T0 + 60_000, now: T0 + 10_000_000,
    }), 0);
});

test('the measured countdown takes over as soon as one percent has been timed', () => {
    // A 1-point span over a long enough sample is already a real measurement:
    // every chunk is the same size at the same cadence. Holding out for 5%
    // meant minutes of showing the fixed ballpark instead of this machine's
    // actual link speed.
    assert.equal(estimateRemainingSeconds({
        startedAt: T0, startPercent: 1, percent: 2, updatedAt: T0 + 30_000, now: T0 + 30_000,
    }), 30 * 98);
});

test('no countdown before the upload or on too short a sample', () => {
    const base = { startedAt: T0, startPercent: 0, updatedAt: T0 + 60_000, now: T0 + 60_000 };
    assert.equal(estimateRemainingSeconds({ ...base, startedAt: 0, percent: 50 }), null,
        'nothing to measure from until the first uploading event');
    assert.equal(estimateRemainingSeconds({ ...base, startPercent: 4, percent: 4 }), null,
        'no span timed yet');
    assert.equal(estimateRemainingSeconds({
        ...base, percent: 2, updatedAt: T0 + 5_000, now: T0 + 5_000,
    }), null, 'a five-second sample swings too wildly to show');
    assert.equal(estimateRemainingSeconds({ ...base, percent: null }), null);
});

// ── End of upload, without an end-of-upload event ───────────────────────────
// The stream never reports 100%: decaid drops any tick within 1% of the last one
// (firmware_handler.dart), and the bundled image is 463872 B = exactly 28992
// 16-byte chunks, so ticks land on chunks 1, 291 ... 28711 (99%) and the final
// onProgress(1.0) at chunk 28992 is 0.97% later — swallowed. Anything keyed on a
// 100% event is therefore dead code; the projection running out is the signal.
test('the bundled image really does stop emitting at 99%', () => {
    const chunks = 463872 / 16;
    assert.equal(chunks, 28992, 'a whole number of 16-byte chunks');
    const step = Math.ceil(0.01 * chunks); // chunks needed for the delta to clear 1%
    let last = 1;
    while (last + step <= chunks) last += step;
    assert.equal(last, 28711);
    assert.equal(Math.round((last / chunks) * 100), 99, 'last percentage on the wire');
    assert.ok(chunks - last < 0.01 * chunks, 'the final 1.0 tick is inside the 1% gate');
});

test('the upload is complete once the measured projection runs out', () => {
    // Last tick at 99% took 99s for 99 points => 1s/point => ~1s of chunks left.
    const at = now => isUploadComplete({
        startedAt: T0, startPercent: 0, percent: 99, updatedAt: T0 + 99_000, now,
    });
    assert.equal(at(T0 + 99_000), false, 'bytes still going out');
    assert.equal(at(T0 + 101_000), true, 'projected last chunk has gone out');
});

test('a stalled upload is late, not complete', () => {
    // The rate decays towards 0 whenever events stop, so an exhausted projection
    // at 40% used to flip the UI to "Check…" and then to "taking longer than
    // usual" with the bytes still mid-flight.
    assert.equal(estimateRemainingSeconds({
        startedAt: T0, startPercent: 0, percent: 40, updatedAt: T0 + 60_000, now: T0 + 10_000_000,
    }), 0, 'the projection really is exhausted');
    assert.equal(isUploadComplete({
        startedAt: T0, startPercent: 0, percent: 40, updatedAt: T0 + 60_000, now: T0 + 10_000_000,
    }), false, 'but verification cannot have started');
    // One point short of the last tick the stream emits is still mid-upload.
    assert.equal(isUploadComplete({
        startedAt: T0, startPercent: 0, percent: FIRMWARE_LAST_TICK_PERCENT - 1,
        updatedAt: T0 + 60_000, now: T0 + 10_000_000,
    }), false);
});

test('a 100% event still counts as complete where one arrives', () => {
    assert.equal(isUploadComplete({ startedAt: T0, percent: 100, updatedAt: T0 + 60_000, now: T0 + 60_000 }), true);
    // ...and nothing is claimed complete before there is anything to measure.
    assert.equal(isUploadComplete({ startedAt: 0, percent: 99, now: T0 }), false);
    assert.equal(isUploadComplete({
        startedAt: T0, startPercent: 0, percent: 2, updatedAt: T0 + 5_000, now: T0 + 5_000,
    }), false, 'unmeasurable is not complete');
});

// ── Verification countdown ──────────────────────────────────────────────────
// The stream is silent from the last chunk to `done`, but the phase is bounded
// by decaid's firmwareVerificationTimeout — a real ceiling, not a guess, so it
// counts down against that instead of the 50-minute ballpark.
test('verification counts down against decaid own timeout', () => {
    assert.equal(estimateVerifyRemainingSeconds(T0, T0), FIRMWARE_VERIFY_SECONDS);
    assert.equal(estimateVerifyRemainingSeconds(T0, T0 + 10_000), FIRMWARE_VERIFY_SECONDS - 10);
});

test('verification countdown is null past the bound, not zero forever', () => {
    // Past here decaid is about to throw 'Timed out waiting for firmware
    // verification' — the caller says "taking longer than usual", not "0:00".
    assert.equal(estimateVerifyRemainingSeconds(T0, T0 + (FIRMWARE_VERIFY_SECONDS + 1) * 1000), null);
    assert.equal(estimateVerifyRemainingSeconds(0, T0), null, 'not verifying yet');
});

// ── Transport, read off the device id ───────────────────────────────────────
// decaid publishes no transport field for a connected machine, but a wired one's
// id is minted from the USB descriptor (serial_reconcile.dart / utils.dart) and
// a BLE one's is the platform handle. That prefix picks the ballpark.
test('a wired machine is recognised from its device id', () => {
    assert.equal(transportFromDeviceId('usb-2e8a-a-8549628789ABCDEF'), 'wired');
    assert.equal(transportFromDeviceId('usb-session-7'), 'wired', 'descriptor-less USB still wired');
    assert.equal(transportFromDeviceId('serial-cu.usbmodem1101'), 'wired', 'desktop fallback id');
});

test('a BLE machine, and anything unrecognised, reads as BLE', () => {
    assert.equal(transportFromDeviceId('1A3AAE9B-A643-5C64-C29B-CAF8664D8BC7'), 'ble', 'Apple UUID');
    assert.equal(transportFromDeviceId('AA:BB:CC:DD:EE:FF'), 'ble', 'Android MAC');
    // Unknown shapes take the slow estimate: over-stating the wait is the safe
    // direction, under-stating it is what makes a live update look hung.
    assert.equal(transportFromDeviceId('MockDe1'), 'ble');
    assert.equal(firmwareEstimatedTotalSeconds(transportFromDeviceId('MockDe1')),
        FIRMWARE_ESTIMATED_SECONDS.ble);
});

// A Bengle never matches the bundled DE1 catalog, so its only start path is the
// manual upload one — the note has to be right from the device id alone, with no
// catalog verdict behind it.
test('the pre-start note names the transport\'s own duration', () => {
    assert.match(firmwareDurationNote(transportFromDeviceId('usb-2e8a-a-8549628789ABCDEF')), /up to 25 minutes/);
    assert.match(firmwareDurationNote(transportFromDeviceId('AA:BB:CC:DD:EE:FF')), /at least 50 minutes/);
    // No machine to classify: keep the slower claim rather than promising half.
    assert.match(firmwareDurationNote(transportFromDeviceId('')), /at least 50 minutes/);
    assert.match(firmwareDurationNote(undefined), /at least 50 minutes/);
    // Both halves of the note, whichever one is shown: the duration AND the
    // don't-pull-the-plug line that is the whole reason it exists.
    for (const note of [firmwareDurationNote('wired'), firmwareDurationNote('ble')]) {
        assert.match(note, /Do not power off the machine and leave this page until it finishes\./);
    }
});

test('no device id means no estimate at all', () => {
    assert.equal(transportFromDeviceId(undefined), null);
    assert.equal(transportFromDeviceId(''), null);
    // ...and the caller shows no clock rather than guessing — see firmwareClock.
    assert.equal(estimateTotalRemainingSeconds(T0, 0, T0), null);
});

test('the ballpark counts down against the transport total', () => {
    const wired = FIRMWARE_ESTIMATED_SECONDS.wired;
    assert.equal(firmwareEstimatedTotalSeconds('wired'), wired);
    assert.equal(estimateTotalRemainingSeconds(T0, wired, T0 + 60_000), wired - 60);
    assert.equal(estimateTotalRemainingSeconds(T0, wired, T0 + (wired + 1) * 1000), null,
        'spent, not negative — the caller says "taking longer than usual"');
    assert.ok(FIRMWARE_ESTIMATED_SECONDS.ble > wired, 'BLE is the slow one');
});

test('the verify bound matches the one decaid actually waits', () => {
    // unified_de1.dart constructs firmwareVerificationTimeout at 120s and nothing
    // overrides it (Bengle doesn't either). It was 30 here, so the label claimed
    // the check had overrun after a quarter of the time decaid allows it.
    assert.equal(FIRMWARE_VERIFY_SECONDS, 120);
});

test('m:ss formatting pads the seconds', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(9), '0:09');
    assert.equal(formatDuration(65), '1:05');
    assert.equal(formatDuration(600), '10:00');
    assert.equal(formatDuration(-5), '0:00');
});
