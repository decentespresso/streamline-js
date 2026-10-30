// Match the historical 10 Hz gate until a positive frame interval is observed.
export const DEFAULT_CHART_INTERVAL_MS = 100;
// Measured on a Bengle tablet (2026-10-21): the machine snapshot transport runs at
// 15.2 Hz, gap p50 66.8 ms / p95 89 ms, so a 100 ms floor coalesced about every
// third delivered frame -- 8.6 flushes/s at 100 ms against 13.2/s at 25 ms, for
// paint p50 3.9 ms / p95 9.7 ms and no sustained long tasks. MAX stays at the
// historical gate, so a stall still cannot paint slower than it used to.
export const MIN_CHART_INTERVAL_MS = 25;
export const MAX_CHART_INTERVAL_MS = 100;

// Observe accepted updateChart arrivals, not machine timestamps: catch-up frames
// must not unthrottle painting, and a stall must not slow it below the old gate.
// The floor only binds when the transport is faster than the historical gate.
export function createChartCadence() {
    let lastFrameAt = null;
    let estimate = null;
    return now => {
        const delta = lastFrameAt === null ? NaN : now - lastFrameAt;
        lastFrameAt = Number.isFinite(now) ? now : null;
        if (!Number.isFinite(delta) || delta <= 0) {
            estimate = null;
            return DEFAULT_CHART_INTERVAL_MS;
        }
        const smoothed = estimate === null ? delta : estimate * 0.75 + delta * 0.25;
        estimate = Math.max(MIN_CHART_INTERVAL_MS, Math.min(MAX_CHART_INTERVAL_MS, smoothed));
        return estimate;
    };
}

// Live source arrays are append-only. Replacing either array or truncating it
// starts a new projection; never modify the source used by full/history renders.
export function projectTraceDelta(trace, previous) {
    const length = trace.x.length;
    const reset = !previous || previous.x !== trace.x || previous.y !== trace.y || previous.length > length;
    const points = [];
    for (let index = reset ? 0 : previous.length; index < length; index++) {
        points.push([trace.x[index], trace.y[index]]);
    }
    return { x: trace.x, y: trace.y, length, reset, points };
}
