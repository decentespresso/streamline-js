// When a profile may be written to the machine, and what to do with one that
// may not. DOM-free so node:test can import it.
//
// Decaid does not guard this itself. PUT /workflow hands the profile to its
// WorkflowController, whose listener WorkflowDeviceSync calls De1.setProfile the
// moment the profile changes (workflow_device_sync.dart _onChange -> _drain),
// and setProfile rewrites the header, every step frame and the tail
// (unified_de1.profile.dart _sendProfile). The DE1 runs frames by index out of
// that table, so writing it during a shot replaces the frames the machine is
// still executing. The skin is the only thing that can stop it.

// Only espresso runs profile frames. Steam, flush and hot water do not, and a
// machine that is asleep or heating is not mid-shot either.
export const PROFILE_SEND_BLOCKING_STATES = ['espresso'];

/**
 * An unknown state does not block: it means the snapshot socket is down, which
 * is not a machine we can be running a shot on, and blocking there would
 * disable profile switching outright whenever the socket hiccups.
 */
export function profileSendBlocked(state) {
    return PROFILE_SEND_BLOCKING_STATES.includes(state);
}

/** The shot that was running has ended, so a held profile may go out now. */
export function shouldFlushPendingSend(previousState, nextState) {
    return profileSendBlocked(previousState) && !profileSendBlocked(nextState);
}

// One slot, last write wins. Picking profile A and then B during the same shot
// must leave B on the machine, not A then B -- and never a queue of switches
// the user has long since changed their mind about.
let pending = null;

/** Hold a record to send when the shot ends. Returns what is now held. */
export function setPendingProfileSend(record) {
    pending = record?.profile ? record : null;
    return pending;
}

export function peekPendingProfileSend() {
    return pending;
}

/** Take the held record, clearing the slot. */
export function takePendingProfileSend() {
    const held = pending;
    pending = null;
    return held;
}

/** A send that actually went out retires anything held for the same machine. */
export function clearPendingProfileSend() {
    pending = null;
}
