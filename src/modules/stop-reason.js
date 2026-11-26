// Why did the shot stop? -- pure, DOM-free.
//
// Two callers, two very different qualities of evidence:
//
//   1. ws/v1/machine/shotState carries the sequencer's OWN decision.reason.
//      Authoritative -- except for one case, below.
//   2. In gateway mode no sequencer runs, the feed stays idle, and app.js has
//      to reconstruct the reason from what the finished shot looks like.
//
// Both used to conclude "stopped by weight" for shots that were really ended by
// the profile running out of frames.

/** A target counts as reached at 93% -- shared by both paths. */
export const HIT_TOLERANCE = 0.93;
/** The profile counts as having run to its end at 95% of its nominal seconds. */
export const TIME_TOLERANCE = 0.95;

// ── The canonical vocabulary ────────────────────────────────────────────────
// Both entry points below answer in THESE terms, so app.js renders the toast
// from one table instead of one per path. The first two are wire reasons from
// ws/v1/machine/shotState; the other two are internal — the wire enum has no
// word for "the profile ran to its last frame", and no word for "we could not
// tell", which is a real answer and better than guessing.
export const STOP_TARGET_WEIGHT = 'targetWeight';
export const STOP_TARGET_VOLUME = 'targetVolume';
export const STOP_PROFILE_ENDED = 'profileEnded';
export const STOP_UNKNOWN = 'unknown';

/**
 * Reconstruct the stop reason from the finished shot, in the canonical
 * vocabulary above. Used in gateway mode, where no sequencer runs and the
 * shotState feed stays idle, so there is no decision.reason to canonicalise.
 *
 * TIME IS TESTED FIRST, and that ordering is the whole point. A stop-at-weight
 * or stop-at-volume cuts a shot SHORT -- it ends before the profile's frames
 * run out. So if the shot lasted essentially the profile's full nominal
 * duration, the profile is what ended it, whatever the scale happens to read.
 *
 * Checking weight first (the old order) misfired on the most ordinary setup
 * there is: a target yield set to roughly what the profile already pours. The
 * shot runs its full time, the weight lands within 7% of target anyway, and a
 * plainly time-stopped shot gets reported as "Stopped by weight: 36.0g".
 *
 * Note this cannot misfire the other way. A profile whose steps exit early on
 * pressure/flow never reaches its nominal seconds, so the profile-ended branch
 * stays shut and a genuine weight stop still reports as weight.
 */
export function classifyStopReason({
    totalS = 0,
    finalWeight = null,
    finalVolume = 0,
    targetWeight = 0,
    targetVolume = 0,
    profileSeconds = 0,
    isScaleConnected = false,
} = {}) {
    if (profileSeconds > 0 && totalS >= profileSeconds * TIME_TOLERANCE) return STOP_PROFILE_ENDED;
    // Scale present -> weight is the authoritative stop signal and a volume
    // match is coincidental. Scale absent -> volume is the only mass proxy the
    // DE1 has, so it becomes the valid non-time reason.
    if (isScaleConnected && targetWeight > 0 && finalWeight !== null && finalWeight >= targetWeight * HIT_TOLERANCE) {
        return STOP_TARGET_WEIGHT;
    }
    // Volume is suppressed only when a WEIGHT target could explain the stop
    // instead: with a scale attached, weight is the authoritative signal and a
    // volume match alongside it is coincidental. Gating on the scale ALONE (the
    // old rule) also silenced the setup with a volume target and no weight
    // target — where volume is the only stop target there is — reporting a
    // genuine volume stop as the generic "Shot Stopped".
    const weightCouldExplain = isScaleConnected && targetWeight > 0;
    if (!weightCouldExplain && targetVolume > 0 && finalVolume >= targetVolume * HIT_TOLERANCE) {
        return STOP_TARGET_VOLUME;
    }
    return STOP_UNKNOWN;
}

/**
 * Did a `machineEnded` decision actually mean the firmware's stop-at-weight?
 *
 * On a machine with autonomous SAW (Bengle) the target-yield stop is firmware
 * side and comes back as reason 'machineEnded' -- but so does a profile that
 * simply ran to its last frame. The reason alone cannot tell them apart, so
 * treating every machineEnded-with-a-scale as a weight stop reported a
 * time-ended shot as "Stopped by weight" and printed whatever the scale read.
 *
 * Require evidence the yield was actually reached before making that claim.
 */
export function isAutonomousWeightStop(weight, targetWeight) {
    return targetWeight > 0
        && typeof weight === 'number'
        && isFinite(weight)
        && weight >= targetWeight * HIT_TOLERANCE;
}

/**
 * Collapse a wire `decision.reason` to a canonical, MACHINE-INDEPENDENT reason.
 *
 * Every reason in the enum means the same thing on every machine except one.
 * 'machineEnded' means "the firmware ended the pour", and which firmware you
 * have decides why it did:
 *
 *   - autonomous stop-at-weight (Bengle): the target-yield stop is firmware
 *     side, so a WEIGHT stop arrives as machineEnded;
 *   - everyone else: a weight stop is the app sequencer's, and arrives as
 *     'targetWeight', so machineEnded can only mean the profile ran out of
 *     frames — a TIME stop.
 *
 * Resolving that here means callers downstream see one vocabulary and cannot
 * grow machine-specific branches of their own. Two shots that ended the same
 * way produce the same message whatever poured them.
 *
 * Returns the canonical vocabulary above, or passes an unrecognised wire reason
 * through untouched — the enum is an open set and newer builds may add values.
 */
export function canonicalStopReason(reason, {
    machineHasAutonomousSAW = false,
    isScaleConnected = false,
    weight = null,
    targetWeight = 0,
    totalS = 0,
    profileSeconds = 0,
} = {}) {
    if (reason !== 'machineEnded') return reason;
    // TIME FIRST, for the same reason classifyStopReason tests it first: a
    // firmware stop-at-weight cuts the shot SHORT, so a shot that ran the
    // profile's full nominal length was ended by the profile — even on a Bengle,
    // and even though the yield was also reached (which it usually is, since a
    // sane target is roughly what the profile already pours). Checking the yield
    // evidence first reproduces the original bug on the firmware-SAW path.
    if (classifyStopReason({ totalS, profileSeconds }) === STOP_PROFILE_ENDED) return STOP_PROFILE_ENDED;
    // Cut short: now the yield evidence decides whether the firmware stopped it.
    if (machineHasAutonomousSAW && isScaleConnected && isAutonomousWeightStop(weight, targetWeight)) {
        return STOP_TARGET_WEIGHT;
    }
    return reason;
}
