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
