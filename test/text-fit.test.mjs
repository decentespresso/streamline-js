import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largestFittingSize, fitShapeKey, predictFittingSize } from '../src/modules/text-fit.js';

// fitTextToBox's size search. Each probe is a forced synchronous reflow in the
// browser (write font-size, read scrollHeight), so the probe count is the whole
// point of the binary search -- and it has to land on exactly the size the old
// 1px walk did.

// The old implementation, for an equivalence check.
function walkDown(min, start, fits) {
    let size = start;
    while (size > min && !fits(size)) size -= 1;
    return size;
}

// "Text fits at size s" is monotonic: anything at or below `threshold` fits.
const fitsBelow = (threshold) => (size) => size <= threshold;

test('a size that already fits is left on its CSS size', () => {
    assert.equal(largestFittingSize(14, 28, fitsBelow(28)), null);
    assert.equal(largestFittingSize(14, 28, fitsBelow(99)), null);
    // Nothing to search when the start is already at or under the floor.
    assert.equal(largestFittingSize(14, 14, fitsBelow(0)), null);
    assert.equal(largestFittingSize(14, 10, fitsBelow(0)), null);
});

test('it finds the largest size that fits', () => {
    assert.equal(largestFittingSize(14, 28, fitsBelow(20)), 20);
    assert.equal(largestFittingSize(14, 28, fitsBelow(15)), 15);
    assert.equal(largestFittingSize(14, 28, fitsBelow(27)), 27);
});

test('nothing that fits floors at min rather than shrinking past it', () => {
    assert.equal(largestFittingSize(14, 28, fitsBelow(5)), 14);
    // The old walk could step BELOW the floor from a fractional start
    // (15.5 -> 14.5 -> 13.5); this never returns less than min.
    assert.equal(largestFittingSize(14, 15.5, fitsBelow(5)), 14);
});

test('it agrees with the 1px walk it replaced, across the whole range', () => {
    for (let threshold = 0; threshold <= 30; threshold++) {
        const binary = largestFittingSize(14, 28, fitsBelow(threshold));
        const walked = walkDown(14, 28, fitsBelow(threshold));
        // null means "start fits", which the walk reports as the start size.
        assert.equal(binary ?? 28, walked, `threshold ${threshold}`);
    }
});

test('it probes far fewer times than the walk', () => {
    // Worst case for the walk: only the floor fits, so it steps all the way down.
    let binaryProbes = 0;
    let walkProbes = 0;
    largestFittingSize(14, 28, (s) => { binaryProbes++; return fitsBelow(14)(s); });
    walkDown(14, 28, (s) => { walkProbes++; return fitsBelow(14)(s); });
    assert.equal(walkProbes, 14);
    assert.ok(binaryProbes <= 5, `binary search probed ${binaryProbes} times`);
});

// The shot-data range cells re-fit on every change, and a fit costs ~0.3 ms
// against 0.001 ms for the write. The fitted size depends on how wide a string
// renders, not which digits it holds, so the cache key has to separate strings
// that render at different widths and merge the ones that do not.
test('fitShapeKey: values of the same width share a key', () => {
    assert.equal(fitShapeKey('9.9'), fitShapeKey('1.2'));
    assert.equal(fitShapeKey('10.5→12.0→10.1'), fitShapeKey('11.6→13.1→10.2'));
});

test('fitShapeKey: a value that got wider does not', () => {
    assert.notEqual(fitShapeKey('9.9'), fitShapeKey('10.1'), 'crossing ten is a re-fit');
    assert.notEqual(fitShapeKey('5.0→9.9'), fitShapeKey('5.0→9.9→8.1'), 'a third segment is a re-fit');
    assert.notEqual(fitShapeKey('92'), fitShapeKey('92→94'));
});

test('fitShapeKey: non-digits are the shape, and survive', () => {
    assert.equal(fitShapeKey('-'), '-', 'the cleared cell');
    assert.equal(fitShapeKey('8.8→8.8'), fitShapeKey('1.2→3.4'));
    assert.equal(fitShapeKey('36.2g'), '88.8g', 'units and separators are kept as-is');
});

// fitTextToWidth's size search. A measurement there forces a layout of the whole
// document, so what is pinned here is the probe COUNT as much as the answer: the
// prediction has to land on the same size a walk would, in two measurements.
test('the predicted size matches an exhaustive walk, in two measurements', () => {
    // A monospace-ish face: width scales exactly with size.
    const linear = (text, perPx) => size => text.length * perPx * size;

    for (const [chars, avail] of [[3, 200], [9, 200], [20, 200], [40, 200], [3, 20]]) {
        const widthAt = linear('x'.repeat(chars), 0.6);
        let probes = 0;
        const counted = size => { probes += 1; return widthAt(size); };

        const size = predictFittingSize(26, avail, 8, counted);

        let walked = 26;
        while (walked > 8 && widthAt(walked) > avail) walked -= 1;
        const expected = widthAt(26) <= avail ? 26 : walked;

        assert.equal(size, expected, `${chars} chars in ${avail}px`);
        assert.ok(widthAt(size) <= avail || size === 8, 'the chosen size must fit, unless it is the floor');
        assert.ok(probes <= 2, `${probes} probes for ${chars} chars`);
    }
});

test('a face whose advance does not scale cleanly still fits', () => {
    // Rounds every advance up to a whole pixel, so a prediction can land a pixel
    // over -- the case the correction step exists for.
    const widthAt = size => 12 * Math.ceil(0.62 * size);

    for (let avail = 60; avail <= 200; avail += 7) {
        const size = predictFittingSize(26, avail, 8, widthAt);
        assert.ok(widthAt(size) <= avail || size === 8, `overflowed at avail=${avail}`);
    }
});

test('text that measures as nothing keeps the size its CSS gives it', () => {
    assert.equal(predictFittingSize(26, 100, 8, () => 0), 26);
});
