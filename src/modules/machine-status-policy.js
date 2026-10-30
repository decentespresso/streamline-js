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
