// Machine link state, derived from reaprime's /ws/v1/devices aggregator feed.
//
// After a machine power-cycle the skin showed "disconnected" forever,
// even though reaprime had reconnected. reaprime binds /ws/v1/machine/snapshot
// ONCE, to a De1 *instance* (de1handler.dart `_withDe1Ws`). On a power-cycle it
// throws that instance away and builds a new one — but it never re-binds the
// socket and, crucially, never CLOSES it. The socket goes open-but-silent.
// ReconnectingWebSocket only reconnects on *close*, so it never retries; the
// skin's 5 s data timeout latches isDe1Connected = false, and nothing could ever
// set it true again short of a reload.
//
// The /ws/v1/devices socket is bound to reaprime's DevicesStateAggregator, NOT to
// a De1 instance, so it SURVIVES the power-cycle and keeps reporting the truth
// (`state: "connected"`). The skin already holds that socket open and was reading
// only `data.scanning` from it. This module turns that surviving feed into the
// authority on machine link state.
//
// EDGE-TRIGGERED, NOT ID-DIFFED. The USB device id is byte-identical before and
// after a power-cycle — it is derived from the SAMD21 factory unique id
// (usb-2e8a-a-8549628789ABCDEF, proven identical across a cycle on the bench), so
// a fix that watched for the id to *change* would silently never fire. We watch
// the not-connected -> connected transition instead.
//
// DOM-free on purpose so `node --test test/` can import it (see test/README.md).

/**
 * Pull the devices array out of either shape we get it in:
 *   - the /ws/v1/devices WebSocket payload: { devices: [...], scanning, ... }
 *   - the GET /api/v1/devices REST response: a bare [...]
 *
 * Returns null when the payload carries no usable device list at all. That is
 * deliberately distinct from "an empty list": a malformed or partial frame tells
 * us NOTHING, and must not be read as "the machine went away" — that would fire a
 * spurious link-down/link-up pair and resync the sockets for no reason.
 */
function extractDeviceList(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.devices)) return payload.devices;
    return null;
}

/**
 * The machine's link state according to a devices payload.
 *
 * @returns {{ known: boolean, connected: boolean, deviceId: string|null }}
 *   known=false  -> the payload told us nothing; infer nothing from it.
 */
export function machineFromDevicesPayload(payload) {
    const list = extractDeviceList(payload);
    if (!list) return { known: false, connected: false, deviceId: null };

    const machine = list.find(
        (d) => d && d.type === 'machine' && d.state === 'connected'
    );
    if (!machine) return { known: true, connected: false, deviceId: null };

    return { known: true, connected: true, deviceId: machine.id ?? null };
}

/**
 * Edge-triggered watcher over the devices feed.
 *
 * - onLinkUp(deviceId): fired on not-connected -> connected, and on a change of
 *   the connected machine's id (a genuinely different machine).
 * - onLinkDown(): fired on connected -> not-connected.
 * - Repeats do not re-fire: the aggregator re-emits on every device event
 *   (scale battery, scanning flag, ...), so most payloads carry no edge.
 *
 * The FIRST payload only establishes the baseline and fires nothing. At boot the
 * app has just opened its machine sockets against the live machine; re-firing
 * link-up for a machine that was connected all along would close and re-open
 * them for nothing. The bug we are fixing needs a down edge before the up edge,
 * and that is exactly what a power-cycle produces.
 */
export function createMachineLinkWatcher({ onLinkUp, onLinkDown } = {}) {
    let connected = null; // null = no baseline yet
    let deviceId = null;

    return {
        /**
         * Feed a devices payload (WebSocket or REST shape).
         * @returns {boolean} true if the payload was usable (a baseline or an edge).
         */
        update(payload) {
            const link = machineFromDevicesPayload(payload);
            if (!link.known) return false; // partial/malformed frame: infer nothing

            const isBaseline = connected === null;
            const wasConnected = connected === true;
            const previousId = deviceId;

            connected = link.connected;
            deviceId = link.deviceId;

            if (isBaseline) return true;

            if (link.connected) {
                if (!wasConnected || link.deviceId !== previousId) {
                    onLinkUp?.(link.deviceId);
                }
            } else if (wasConnected) {
                onLinkDown?.();
            }
            return true;
        },

        /** True only once a payload has said so. Unknown reads as false. */
        isConnected() {
            return connected === true;
        },

        /** The connected machine's id, or null. */
        getDeviceId() {
            return deviceId;
        },

        /** False until the first usable payload has been seen. */
        hasBaseline() {
            return connected !== null;
        },

        /** Drop the baseline (next payload re-seeds without firing). */
        reset() {
            connected = null;
            deviceId = null;
        },
    };
}
