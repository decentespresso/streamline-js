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

/** Never advertise more than 5 minutes: above that the estimate is noise. */
export const TTR_CAP_S = 300;

/**
 * Build the stored estimate from a time-to-ready frame, or null when the frame
 * carries no usable one.
 * @param {{status?: string, remainingTimeMs?: number}} frame
 * @param {number} now epoch ms
 */
export function readTimeToReadyFrame(frame, now) {
    return (frame?.status === 'heating' && frame.remainingTimeMs > 0)
        ? { deadline: now + frame.remainingTimeMs, at: now }
        : null;
}

/**
 * Seconds to display, or 0 for "no usable estimate — say plain Heating".
 * Clamped to [0, TTR_CAP_S]: a cold-boot estimate of 20 minutes shows as 300s and
 * only starts moving once the real estimate drops under the cap.
 * @param {{deadline: number, at: number}|null} estimate
 * @param {number} now epoch ms
 */
export function heatingSecondsLeft(estimate, now) {
    if (!estimate || now - estimate.at > TTR_STALE_MS) return 0;
    const seconds = Math.round((estimate.deadline - now) / 1000);
    return Math.min(Math.max(seconds, 0), TTR_CAP_S);
}
