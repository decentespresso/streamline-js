// Pure decisions behind the machine status line. DOM-free so node:test can import it.

// `from: 'status'` keys are state-level only. MachineSubstate carries a filler `idle`
// while MachineState is an action state (espresso/steam/flush/hotWater), so the
// substate must never resolve these. Only the action keys may match a substate.
const STATE_KEYS = [
    { key: 'disconnected', from: 'status' },
    { key: 'sleeping', from: 'status' },
    { key: 'error', from: 'status' },
    { key: 'heating', from: 'status' },
    { key: 'idle', from: 'status' },
    { key: 'flushing', from: 'both' },
    { key: 'steaming', from: 'both' },
    { key: 'hotwater', from: 'both' },
    { key: 'preinfusion', from: 'both' },
    { key: 'pouring', from: 'both' },
];

/** The status-line state key for a status/substate pair, or '' when none applies. */
export function resolveStatusStateKey(status, substate) {
    const lowerStatus = status?.toLowerCase() || '';
    const lowerSubstate = substate?.toLowerCase() || '';
    for (const { key, from } of STATE_KEYS) {
        if (lowerStatus.includes(key)) return key;
        if (from === 'both' && lowerSubstate.includes(key)) return key;
    }
    return '';
}

// The post-action tail: the DE1 keeps state=steam/flush/hotWater through these
// substates but the user-visible action is over, so counters stop and freeze.
const TAIL_SUBSTATES = ['pouringDone', 'puffing'];

/** Is this substate the tail of an action rather than the action itself? */
export function isActionTailSubstate(substate) {
    return TAIL_SUBSTATES.includes(substate);
}

// Retry for a refill kit that has stopped, in the status line.
//
// de1app's "Please add water" page makes the whole page one retry button --
// start_refill_kit on any tap, never gated (skins/default/standard_includes.tcl)
// -- and gates only the hint that advertises it: refill_kit_retry_button
// (de1plus/vars.tcl) shows "Touch screen to retry" while the DE1 substate is
// not 0, which during Refill is substate 0x11, "Have we given up on a refill?".
//
// Decaid collapses that substate into MachineSubstate.idle (de1.utils.dart,
// decentespresso/decaid#1062), so a kit that is filling and a kit that has
// given up arrive here as the same frame. The retry is therefore offered for as
// long as the state lasts, which is what de1app's own tap target does anyway.
//
// It is gated on the kit instead of on the substate: without a kit nothing is
// waiting to be told to try again, and the only fix is to pour water in. null
// (machine info not read yet) is not a kit.
export function offerRefillRetry(state, refillKitPresent) {
    return state === 'needsWater' && refillKitPresent === true;
}
