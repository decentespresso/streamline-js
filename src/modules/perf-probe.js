// Device profiling for the live-shot path (#161, fork#4 / fork#6 / fork#13).
//
// The open findings there are all "it depends on the tablet": a layout read and
// a few allocations per frame, cheap on a desktop and unknown on an Android 12
// device. Nobody can answer them from a laptop, and nobody has a profiler on the
// tablet either -- so the measurement has to come back the way every other field
// report does, inside the log a user attaches to in-app feedback.
//
// Timing is therefore ALWAYS ON, and every shot leaves one compact line behind.
// Nobody has to switch anything on: the skin runs in Decaid's WebView, which has
// no address bar, so a flag only a developer can set would collect data from
// developers' machines -- the exact hardware the question is not about. The cost
// is seven performance.now() pairs per frame against a frame that already does
// about a millisecond of work.
//
// ?perf=1 (or localStorage `perfProbe` = '1') adds verbose reporting: the full
// table every REPORT_EVERY_MS, shot or no shot. That is for a dev server or a
// tablet with remote debugging, where an address bar exists.
//
// Everything goes to logger.audit, the one channel that is always on -- logger.info
// is a no-op in every build.

import { logger } from './logger.js';

export const PERF_PROBE_KEY = 'perfProbe';
export const REPORT_EVERY_MS = 10000;
/** Shorter than this is a flush or a false start, not a shot worth a log line. */
export const MIN_REPORTED_SHOT_S = 5;

let enabled = false;
let reportTimer = 0;
let windowStartedAt = 0;
let deviceLineSent = false;
const stats = new Map();

/** Whether the probe is running. */
export function isPerfProbeEnabled() {
    return enabled;
}

/**
 * One timing. Keeps count, total and the worst single call -- a mean alone hides
 * the frame that actually dropped, and a full histogram is more than a log line
 * can carry.
 */
export function record(label, ms) {
    const entry = stats.get(label);
    if (entry) {
        entry.count += 1;
        entry.total += ms;
        if (ms > entry.max) entry.max = ms;
        return;
    }
    stats.set(label, { count: 1, total: ms, max: ms });
}

/**
 * Time `fn` under `label`. Returns whatever `fn` returns, and never swallows a
 * throw: a profiled build has to behave exactly like an unprofiled one.
 */
export function measure(label, fn) {
    const startedAt = performance.now();
    try {
        return fn();
    } finally {
        record(label, performance.now() - startedAt);
    }
}

/**
 * The report, as lines. Pure, so the shape is testable without a browser.
 *
 * Sorted by total time: the question these findings ask is which segment owns
 * the frame, not which single call was slowest. `share` is of the measured
 * total, not of wall time -- the frame also waits on the socket and the browser.
 *
 * @param {Map<string, {count: number, total: number, max: number}>} entries
 * @param {number} windowMs wall time the window covered
 * @returns {string[]}
 */
export function summarize(entries, windowMs) {
    const rows = [...entries.entries()].map(([label, { count, total, max }]) => ({
        label, count, total, max, mean: total / count,
    }));
    if (!rows.length) return [`perf: nothing measured in ${Math.round(windowMs)} ms`];

    rows.sort((a, b) => b.total - a.total);
    const measured = rows.reduce((sum, row) => sum + row.total, 0);
    const per = (ms, n) => (n ? ms / n : 0);

    return [
        `perf: ${Math.round(windowMs)} ms window, ${measured.toFixed(1)} ms measured`,
        ...rows.map(row => [
            row.label,
            `n=${row.count}`,
            `total=${row.total.toFixed(1)}ms`,
            `mean=${row.mean.toFixed(3)}ms`,
            `max=${row.max.toFixed(3)}ms`,
            `share=${(100 * per(row.total, measured)).toFixed(0)}%`,
        ].join(' ')),
    ];
}

/**
 * What the numbers were measured on. A frame budget means nothing without it,
 * and the whole point of this exercise is an older Android 12 tablet rather than
 * a current Samsung. Device facts only -- nothing identifying.
 */
export function deviceLine(view = globalThis) {
    const parts = [
        `ua=${view.navigator?.userAgent ?? 'unknown'}`,
        `cores=${view.navigator?.hardwareConcurrency ?? '?'}`,
        `dpr=${view.devicePixelRatio ?? '?'}`,
        `screen=${view.screen?.width ?? '?'}x${view.screen?.height ?? '?'}`,
    ];
    const memory = view.performance?.memory?.jsHeapSizeLimit;
    if (memory) parts.push(`heapLimit=${Math.round(memory / 1048576)}MB`);
    return `perf: ${parts.join(' ')}`;
}

/**
 * One line for one shot: mean and worst per segment, ordered by mean.
 *
 * Deliberately not the table -- this lands in every user's log, and a report
 * nobody minds carrying is one that stays short. `n` is the frame count, taken
 * as the busiest segment's, since the segments behind `mainPageShown` do not run
 * when a subpage is open and would understate it.
 *
 * @param {Map<string, {count: number, total: number, max: number}>} entries
 * @param {number} seconds shot length
 * @returns {string}
 */
export function shotSummary(entries, seconds) {
    const rows = [...entries.entries()]
        .filter(([, entry]) => entry.count > 0)
        .map(([label, { count, total, max }]) => ({ label, count, mean: total / count, max }))
        .sort((a, b) => b.mean - a.mean);

    const frames = rows.reduce((most, row) => Math.max(most, row.count), 0);
    const parts = rows.map(row => `${row.label}=${row.mean.toFixed(2)}/${row.max.toFixed(1)}`);
    return `perf: shot ${seconds.toFixed(1)}s n=${frames} ${parts.join(' ')} (mean/max ms)`;
}

/** A shot began: the window is the shot, not the minutes of idling before it. */
export function startPerfShot() {
    stats.clear();
    windowStartedAt = performance.now();
}

/**
 * A shot ended: leave the line in the log. Short runs are skipped -- a two-second
 * flush measures the machine stopping, not the skin, and the field logs are more
 * useful without them.
 */
export function endPerfShot(seconds) {
    if (!(seconds >= MIN_REPORTED_SHOT_S)) {
        stats.clear();
        return false;
    }
    if (!deviceLineSent) {
        logger.audit(deviceLine());
        deviceLineSent = true;
    }
    logger.audit(shotSummary(stats, seconds));
    stats.clear();
    windowStartedAt = performance.now();
    return true;
}

/** Emit the current window and start a fresh one. */
export function flushReport(now = performance.now()) {
    for (const line of summarize(stats, now - windowStartedAt)) logger.audit(line);
    stats.clear();
    windowStartedAt = now;
}

/**
 * Turn the probe on when asked. `?perf=1` also persists, so the flag survives
 * Decaid reloading the skin on its own ephemeral port mid-session; `?perf=0`
 * clears it.
 */
export function initPerfProbe(view = globalThis) {
    let flag = null;
    try {
        flag = new URL(view.location?.href ?? '').searchParams.get('perf');
    } catch (e) { /* no location, or not a URL we can parse */ }
    try {
        if (flag !== null) view.localStorage?.setItem(PERF_PROBE_KEY, flag === '1' ? '1' : '0');
        enabled = (flag ?? view.localStorage?.getItem(PERF_PROBE_KEY)) === '1';
    } catch (e) {
        enabled = flag === '1';
    }
    // Before the early return: switching the probe off has to stop the timer a
    // previous call started, not leave it reporting empty windows forever.
    clearInterval(reportTimer);
    reportTimer = 0;
    if (!enabled) return false;

    logger.audit(deviceLine(view));
    deviceLineSent = true;
    windowStartedAt = performance.now();
    reportTimer = setInterval(() => flushReport(), REPORT_EVERY_MS);
    // Node keeps the process alive for a pending interval; a browser does not
    // care, and the tests would otherwise hang on this one timer.
    reportTimer?.unref?.();
    return true;
}

/** Test seam: force the switch without a location or a storage. */
export function setPerfProbeEnabled(value) {
    enabled = Boolean(value);
    deviceLineSent = false;
    stats.clear();
    windowStartedAt = performance.now();
    if (!enabled) clearInterval(reportTimer);
}

/** Test seam. */
export function readStats() {
    return stats;
}
