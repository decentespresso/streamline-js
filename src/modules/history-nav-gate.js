// When the shot-history arrows on the main page may step through past shots.
// DOM-free so node:test can import it.
//
// Stepping back during a shot fights the live chart: plotHistoricalShot()
// empties the same arrays the live chart renders from, so app.js holds the live
// feed back for as long as a review lasts (see isReviewingHistory). While the
// machine is pulling espresso the panel belongs to the running shot, so the
// arrows are inert.

// Only espresso produces the live shot the panel is showing. Steam, flush and
// hot water draw nothing there, and a sleeping or heating machine is not mid-shot.
export const HISTORY_NAV_BLOCKING_STATES = ['espresso'];

/**
 * An unknown state does not block: it means the snapshot socket is down, which
 * is not a machine we can be running a shot on, and blocking there would kill
 * history navigation outright whenever the socket hiccups.
 */
export function historyNavBlocked(state) {
    return HISTORY_NAV_BLOCKING_STATES.includes(state);
}
