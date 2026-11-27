// Pure number helpers for the dose/drink tiles. DOM-free so node:test can import it.

// One -/+ step, rounded to hundredths so 16.4 - 1 is 15.4, not 15.399999999999999.
// An optional `min` keeps a large step from going below the tile's floor.
export function stepValue(value, step, direction, min = -Infinity) {
    return Math.max(min, Math.round((value + direction * step) * 100) / 100);
}

/** The value one -/+ step moves to, held to [min, max]; null when there is no number to step from or nowhere to go. */
export function stepWithin(value, step, direction, min, max) {
    if (!Number.isFinite(value)) return null;
    if (direction < 0) return value > min ? stepValue(value, step, -1, min) : null;
    const next = stepValue(value, step, 1);
    return max != null && next > max ? max : next;
}

// Two decimals when they carry information (1:2.52), one otherwise (1:2.0, 1:2.5).
export function formatRatio(ratio) {
    const two = ratio.toFixed(2);
    return two.endsWith('0') ? ratio.toFixed(1) : two;
}
