// Heating countdown resolver.
//
// The "Heating: 42s remaining" status had two owners: the time-to-ready plugin
// socket (~1 Hz) supplied the number, the DE1 snapshot socket (~10 Hz) did the
// painting. app.js kept a pre-rendered string plus a boolean flag that the ttr
// handler cleared on every non-heating frame, so the ~10 Hz painter kept catching
// the cleared state and the status flipped between the countdown and a bare
// "Heating".
//
// Split by ownership instead: the snapshot decides *whether* we are heating, this
// module decides *what number* (if any) to show. The estimate is stored as an
// absolute deadline, so the countdown keeps ticking between the sparse ttr frames
// rather than freezing, and it carries the time it arrived so a socket that goes
// quiet expires instead of counting down forever off a stale estimate.
//
// DOM-free on purpose so `node --test test/` can import it (see test/README.md).

/** An estimate older than this is not shown at all — the socket has gone quiet. */
export const TTR_STALE_MS = 6000; // ponytail: fixed window, several ttr periods

/**
 * Grace after the deadline before we give up on the number. The machine can heat
 * longer than predicted; holding the countdown at 1s for a few seconds beats
 * flipping to plain "Heating" and back on the next estimate.
 */
export const TTR_OVERRUN_MS = 10000; // ponytail: fixed window, widen if estimates run long

/** Never advertise more than 5 minutes: above that the estimate is noise. */
export const TTR_CAP_S = 300;

/**
 * Fold a time-to-ready frame into the stored estimate.
 *
 * A frame that carries no usable number is IGNORED, not treated as "no estimate":
 * the ttr socket mixes in non-heating / zero-remaining frames while the DE1
 * snapshot still says heating, and wiping the estimate on those is what made the
 * status swap between the countdown and a bare "Heating" about once a second.
 * Every frame refreshes the arrival time, so a live socket keeps the estimate
 * fresh and only a silent one expires (see TTR_STALE_MS).
 *
 * @param {{status?: string, remainingTimeMs?: number}} frame
 * @param {number} now epoch ms
 * @param {{deadline: number, at: number}|null} previous estimate held so far
 */
export function readTimeToReadyFrame(frame, now, previous = null) {
    if (frame?.status === 'heating' && frame.remainingTimeMs > 0) {
        return { deadline: now + frame.remainingTimeMs, at: now };
    }
    return previous ? { ...previous, at: now } : null;
}

/**
 * Seconds to display, or 0 for "no usable estimate — say plain Heating".
 * Clamped to [1, TTR_CAP_S] while the estimate is live: a cold-boot estimate of 20
 * minutes shows as 300s and only starts moving once the real estimate drops under
 * the cap, and a deadline that has just passed holds at 1s instead of dropping the
 * number (dropping it, then picking the next estimate back up, was the flip-flop).
 * @param {{deadline: number, at: number}|null} estimate
 * @param {number} now epoch ms
 */
export function heatingSecondsLeft(estimate, now) {
    if (!estimate || now - estimate.at > TTR_STALE_MS) return 0;
    if (now - estimate.deadline > TTR_OVERRUN_MS) return 0; // estimate was wrong
    const seconds = Math.round((estimate.deadline - now) / 1000);
    return Math.min(Math.max(seconds, 1), TTR_CAP_S);
}
