import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largestFittingSize } from '../src/modules/text-fit.js';

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
