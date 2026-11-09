// How long steam has actually been delivered, for the status line. DOM-free so
// node:test can drive whole substate timelines through it.
//
// The timer counts only `state === 'steam' && substate === 'pouring'`, which is
// what the firmware's `steaming` substate arrives as (decaid#1107). Everything
// else the DE1 reports while it stays in `steam` -- `preparingForShot` warming
// the boiler, `pausedSteam`, `puffing` and `pouringDone` clearing the wand --
// holds the count where it is.
//
// It used to be the other way round: a wall clock started when the status string
// said steam and stopped when it stopped saying so, with a list of tail
// substates excluded. That counts the tail of the session as steam, which is how
// a 20 s steam read 38 s (#188), and an exclusion list is only ever as right as
// it is complete. Counting delivery directly needs no list, and nothing has to
// be capped at the configured duration afterwards: a steam that genuinely runs
// long should say so.
//
// A pause resumes rather than restarting -- `pausedSteam` is one session with a
// gap in it, and a barista who pauses to reposition the pitcher has not started
// a second steam.

/** Out of steam for longer than this and the next steam is a new session, not the same one through a gap. */
export const STEAM_SESSION_GAP_MS = 2000;

export function createSteamTimer() {
    return { accumulated: 0, activeSince: null, leftSteamAt: null };
}

/** Is the machine delivering steam right now, as opposed to merely being in steam? */
export function isSteamDelivering(state, substate) {
    return state === 'steam' && String(substate ?? '').toLowerCase() === 'pouring';
}

/** Milliseconds of delivered steam in this session, including the run in progress. */
export function steamElapsedMs(timer, now) {
    const t = timer ?? createSteamTimer();
    return t.accumulated + (t.activeSince === null ? 0 : Math.max(0, now - t.activeSince));
}

/** What the status line shows. */
export function steamElapsedSeconds(timer, now) {
    return Math.floor(steamElapsedMs(timer, now) / 1000);
}

/**
 * The steam debug trail (issue #192), as a decision rather than a log call.
 *
 * A report of a steam counter that read wrong arrives as a submitted log, and
 * the substates it turns on are not in one: decaid logs on machine-STATE change
 * only, and a tablet with verbose logging off records no per-frame trace at all.
 * One line per substate change while the machine is in steam, plus the single
 * frame that leaves it, is enough to tell a steam that never delivered from a
 * counter that failed to count -- and it is short enough for logger.audit, which
 * is always on.
 *
 * Returns null for a frame worth no line: outside steam with nothing open, or a
 * repeat of the substate already reported.
 *
 * @param {string|null} lastKey  `nextKey` from the previous call, null at rest
 * @param {{state:*, substate:*, seconds:number}} frame  seconds: what the status line shows
 * @returns {{line:string, nextKey:string|null}|null}
 */
export function steamAuditFrame(lastKey, { state, substate, seconds }) {
    const inSteam = state === 'steam';
    if (!inSteam && !lastKey) return null;
    const key = `${state ?? '?'}/${substate ?? '?'}`;
    if (key === lastKey) return null;
    return { line: `${key} ${seconds}s`, nextKey: inSteam ? key : null };
}

/**
 * Fold one machine frame in. Returns the next timer; never mutates.
 *
 * Leaving `steam` freezes rather than resets, so the frozen value stays readable
 * through the purge and through a single dropped or odd frame (#60). The reset
 * happens on the way back IN, when the time spent out of steam shows this is a
 * new session rather than the same one.
 */
export function foldSteamFrame(timer, { state, substate, now }) {
    const t = timer ?? createSteamTimer();
    if (state !== 'steam') {
        // Stamp when it LEFT, not every frame since: the gap that separates two
        // sessions is time spent out of steam, not the spacing of the frames.
        return {
            accumulated: steamElapsedMs(t, now),
            activeSince: null,
            leftSteamAt: t.leftSteamAt ?? now,
        };
    }
    const newSession = t.leftSteamAt !== null && now - t.leftSteamAt > STEAM_SESSION_GAP_MS;
    const carried = newSession ? createSteamTimer() : t;
    if (isSteamDelivering(state, substate)) {
        return {
            accumulated: carried.accumulated,
            activeSince: carried.activeSince ?? now,
            leftSteamAt: null,
        };
    }
    return { accumulated: steamElapsedMs(carried, now), activeSince: null, leftSteamAt: null };
}
