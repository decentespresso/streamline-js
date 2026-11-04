// The size search behind i18n.js's fitTextToBox, kept DOM-free so it can be
// tested directly: the caller passes a `fits` predicate that does the measuring.
//
// fitTextToBox used to walk down 1px at a time, and every step wrote font-size
// and then read scrollHeight -- a forced synchronous reflow per step. From a
// 28px start down to the 14px floor that is 14 reflows per element, and
// profileManager fits five favourite cells in one go. "Fits" is monotonic in
// font size (smaller text never overflows a box that larger text fitted), so a
// binary search finds the same answer in ~4 probes.
//
// Returns the largest integer size in [min, start] that fits, or min when none
// does. Returns null when `start` itself fits, so the caller can leave the
// element on its CSS size rather than pinning an inline one.
export function largestFittingSize(min, start, fits) {
    if (!(start > min) || fits(start)) return null;
    // lo fits or is the floor; hi is known not to fit.
    let lo = min;
    let hi = start;
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (fits(mid)) lo = mid;
        else hi = mid;
    }
    return lo;
}
