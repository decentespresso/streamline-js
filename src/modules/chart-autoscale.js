// Autoscale maths for the expanded (full-screen) live charts.
//
// DOM-free on purpose so the node:test suite can import it directly
// (test/chart-autoscale.test.mjs; see test/README.md for the pattern).
// chart.js owns the stateful per-shot series and feeds them in here.

/** Top-chart Y never shrinks below this (bar / ml/s / g/s share one axis). */
export const EXP_TOP_FLOOR = 12;
/** °C shown below the coolest target (temperature usually sags below target). */
export const EXP_TEMP_PAD_BELOW = 10;
/** °C shown above the hottest target. */
export const EXP_TEMP_PAD_ABOVE = 5;
/** Hard ceiling for the temp axis, no matter what the data says. */
export const EXP_TEMP_MAX = 105;

// Round up to a clean axis tick: steps of 2 to 30, then 5 to 80, then 10.
export function niceCeil(v) {
    if (v <= 0) return 0;
    if (v <= 30) return Math.ceil(v / 2) * 2;
    if (v <= 80) return Math.ceil(v / 5) * 5;
    return Math.ceil(v / 10) * 10;
}

// Drop the y-arrays whose trace is hidden, so an axis computed from these
// follows what is actually on screen. `visibleFlags` is Plotly's per-trace
// `visible` in the same order as `seriesYs` — true, false or 'legendonly';
// anything that is not exactly true counts as hidden. A missing/short flag list
// (nothing drawn yet) leaves the series untouched.
export function pickVisible(seriesYs, visibleFlags) {
    if (!visibleFlags) return seriesYs;
    return seriesYs.filter((_, i) => (visibleFlags[i] ?? true) === true);
}

export function separateLabelPositions(positions, minSeparation, maxPosition, minPosition = 0) {
    if (positions.length < 2) return positions.slice();
    const result = positions.slice();
    for (let i = 1; i < result.length; i++) {
        result[i] = Math.max(result[i], result[i - 1] + minSeparation);
    }
    if (result[result.length - 1] > maxPosition) {
        result[result.length - 1] = maxPosition;
        for (let i = result.length - 2; i >= 0; i--) {
            result[i] = Math.min(result[i], result[i + 1] - minSeparation);
        }
    }
    if (result[0] < minPosition) {
        result[0] = minPosition;
        for (let i = 1; i < result.length; i++) {
            result[i] = Math.max(result[i], result[i - 1] + minSeparation);
        }
    }
    return result;
}

// Damped top-axis max. `seriesYs` is a list of y-arrays (real units); `prevYMax`
// is the previous damped value the caller stored. Grows instantly so peaks stay
// visible; eases back down at most 2 units per call, and only once the need has
// dropped by more than 2 (hysteresis against flicker). Data only grows within a
// shot, so this is effectively monotonic during a pour (no snapping); it only
// eases back down across shots.
export function computeExpandedTopYMax(seriesYs, prevYMax) {
    let m = 0;
    for (const ys of seriesYs) {
        for (let i = 0; i < ys.length; i++) { if (ys[i] > m) m = ys[i]; }
    }
    const need = Math.max(EXP_TOP_FLOOR, niceCeil(m * 1.05)); // 5% headroom
    let next = prevYMax;
    if (need > next) {
        next = need;                      // grow instantly to keep peaks visible
    } else if (need < next - 2) {
        next = Math.max(need, next - 2);  // ease down one step
    }
    return next;
}

// Temperature band = [min(target)−10, max(target)+5] over every GROUP target
// seen this shot (target 80 → 70..85; if it then drops to 70 the band widens to
// 60..85). With no group target yet, the band anchors on the LAST group-temp
// sample (default 90). The band then widens so the other temperature lines
// (group actual, mix actual, mix TARGET) never clip out of view — EXCEPT the
// hard 105 °C ceiling, which wins over "never clip"; a ≥5 °C span is kept when
// the cap squeezes the band.
//
// Only the GROUP target anchors. The mix target (4th input) is drawn on the
// chart and is never clipped, but it does NOT drive the band: despite its name
// it is not a flat goal, it is the DE1's servo SETPOINT — the machine slams it
// around to steer the group, and on a shot that starts with a hot group it
// dives to ~37 °C to demand cold water. Anchoring on it would pad a further
// 10 °C below that dive ([27, 95] on a real bench shot) and squash the group
// trace to a flat ribbon. Widening-only keeps the line fully visible while the
// band stays owned by the goal that actually matters (bench replay: hot-group
// shot [27, 95] → [37, 95]; normal shots [70, 95] → [73, 90]).
export function computeExpandedTempRange(targetTempYs, groupTempYs, mixTempYs = [], targetMixTempYs = []) {
    const tt = targetTempYs;
    let lo, hi;
    if (tt.length) {                            // ...only the group target anchors
        let tmin = Infinity, tmax = -Infinity;
        for (let i = 0; i < tt.length; i++) { if (tt[i] < tmin) tmin = tt[i]; if (tt[i] > tmax) tmax = tt[i]; }
        lo = tmin - EXP_TEMP_PAD_BELOW; hi = tmax + EXP_TEMP_PAD_ABOVE;
    } else {
        const gy = groupTempYs;
        const last = gy.length ? gy[gy.length - 1] : 90;
        lo = last - EXP_TEMP_PAD_BELOW; hi = last + EXP_TEMP_PAD_ABOVE;
    }
    // ...every other line only widens, so none of them ever clips
    for (const ys of [groupTempYs, mixTempYs, targetMixTempYs]) {
        for (let i = 0; i < ys.length; i++) { if (ys[i] < lo) lo = ys[i]; if (ys[i] > hi) hi = ys[i]; }
    }
    hi = Math.min(EXP_TEMP_MAX, hi);            // ...except the hard 105 °C ceiling
    if (lo > hi - 5) lo = hi - 5;               // keep a sane minimum span if capped
    return [Math.floor(lo), Math.ceil(hi)];
}
