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
/**
 * The widest string that renders in the same space as `value`, used as a cache
 * key: a fitted font size holds for every value of the same shape, so a cell
 * whose digits change but whose layout does not need not be measured again.
 *
 * Measured on the shot-data table, where this matters: writing a range cell
 * costs 0.001 ms and fitting it 0.307 ms, and during a live shot the flow,
 * pressure and temperature ranges change almost every frame while their shape
 * changes only when a value crosses ten.
 *
 * Digits become 8 rather than being counted, so '9.9' and '10.1' key apart while
 * '9.9' and '1.2' share a key. The shot-data cells are NotoSansMono, where every
 * digit has the same advance width, so same-key strings render at exactly the
 * same width; in a proportional face 8 is the safe upper bound and the fitter's
 * 8px inset absorbs the difference.
 */
export function fitShapeKey(value) {
    return String(value).replace(/[0-9]/g, '8');
}

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

/**
 * The largest size in [min, start] whose text fits `avail`, found by prediction
 * rather than search: text width scales with font size, so the width at `start`
 * says where the answer is in one step. The prediction is probed once, because a
 * face whose advance does not scale cleanly can land a pixel over.
 *
 * Two measurements instead of the ~4 a halving search needs and the up-to-18 of
 * a 1px walk. That matters where a measurement is expensive -- through the DOM
 * each one forces a layout of the whole document (see i18n.js's fitTextToWidth,
 * ~3.4 ms a probe on a tablet mid-shot).
 *
 * @param {number} start the CSS font size, in px
 * @param {number} avail the width to fit into, in px
 * @param {number} min the floor
 * @param {(size: number) => number} widthAt renders `size` and returns its width
 * @returns {number} the size to use; `start` when it already fits
 */
export function predictFittingSize(start, avail, min, widthAt) {
    // A width of 0 -- empty text, or a face that measured as nothing -- is not a
    // division waiting to happen: it fits, so it keeps the size its CSS gives it.
    const width = widthAt(start);
    if (width <= avail) return start;
    let size = Math.max(min, Math.floor(start * avail / width));
    if (size > min && widthAt(size) > avail) size -= 1;
    return size;
}
