// The wake profile loads when the machine wakes -- unless the user (or a plugin)
// chose a different profile while it slept, which must not be overwritten.
// DOM-free so node:test can import it.
import { profileFingerprint } from './dye-selection.js';

export const SLEEP_PROFILE_KEY = 'streamline.sleepProfile';

/** What identifies the profile in the workflow at the moment the machine goes to sleep. */
export function sleepProfileMark(workflow) {
    return identity(workflow?.profile);
}

// The yield is a dial-in value (the dashboard folds it into target_weight), not which
// profile was chosen, so changing it while asleep must not count as a different profile.
function identity(profile) {
    if (!profile) return null;
    return profileFingerprint({ ...profile, target_weight: undefined, target_volume: undefined });
}

/**
 * Load the wake profile only when the workflow still holds the profile it had at
 * sleep. No mark (the page reloaded during sleep, or sleep was never seen) means
 * nothing to compare, so behaviour is as before: load it. An unreadable live
 * workflow also loads it, rather than silently never waking onto it.
 */
export function shouldApplyWakeProfile(mark, liveWorkflow) {
    if (!mark) return true;
    const live = identity(liveWorkflow?.profile);
    if (!live) return true;
    return live === mark;
}

/**
 * Bookkeeping for the sleep mark, kept here so node:test can drive it with a
 * fake store. Storage is injected because this module must stay DOM-free.
 *
 * Two things the plain getItem/setItem pair got wrong:
 *
 *  - A sleep that could not read the workflow used to leave the PREVIOUS
 *    sleep's mark in place, and the next wake compared the live profile
 *    against an unrelated profile and skipped the wake profile for good. Every
 *    sleep now publishes its own answer, "no mark" included.
 *  - The mark is written from an async workflow read, so a machine that woke
 *    before that read resolved used to get the pre-sleep mark written back
 *    AFTER the wake had consumed it. A generation token drops that late write.
 */
export function createSleepMarkStore(getStorage = () => globalThis.sessionStorage) {
    let generation = 0;
    const read = () => {
        try { return getStorage()?.getItem(SLEEP_PROFILE_KEY) ?? null; } catch (e) { return null; } // private mode
    };
    const write = value => {
        try {
            const store = getStorage();
            if (!store) return;
            if (value) store.setItem(SLEEP_PROFILE_KEY, value);
            else store.removeItem(SLEEP_PROFILE_KEY);
        } catch (e) { /* private mode */ }
    };
    return {
        /** Open a sleep. Returns commit(mark); a falsy mark clears, so a stale one cannot answer for this sleep. */
        beginSleep() {
            const token = ++generation;
            return mark => {
                if (token !== generation) return false; // a wake already consumed this sleep
                write(mark);
                return true;
            };
        },
        /** Read and clear at the wake edge. Always clear: a mark left behind would answer for a later sleep. */
        takeOnWake() {
            generation += 1;
            const mark = read();
            write(null);
            return mark;
        },
        peek: read,
    };
}

/**
 * Profile records to offer as the wake profile, sorted by the title shown.
 *
 * `availableProfiles` keeps the records an edit retires (visibility 'hidden')
 * for the editor's revert history, so an unfiltered list grew another entry
 * under the same title on every save and let the user bind the wake profile to
 * a record `loadProfileForWake` then has to resolve forward by title. The
 * chosen record stays listed even when hidden, so the picker never shows
 * "Select a profile" over a setting that is in fact set.
 */
export function wakeProfileChoices(records, selectedId, titleOf = record => record?.profile?.title) {
    const label = record => String(titleOf(record) || record?.id || '');
    return Object.values(records || {})
        .filter(record => record && (record.visibility !== 'hidden' || record.id === selectedId))
        .sort((a, b) => label(a).localeCompare(label(b)));
}
