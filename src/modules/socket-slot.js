// A named slot holding at most ONE live WebSocket, with close-before-open.
//
// Why: app.js re-opens the machine-bound sockets after a machine
// power-cycle (resyncMachineSockets), because reaprime binds them to a De1
// *instance* and never re-binds them when it swaps that instance out. Re-opening
// is only safe if the previous socket is closed FIRST. Without that,
// every power-cycle leaks a socket and double-delivers every frame — a doubled
// snapshot frame rate is the tell.
//
// The discarded socket is also SILENCED before it is closed. A socket we are
// throwing away must not narrate its own funeral: the machine snapshot socket's
// onclose paints "Disconnected", and this close is ours, not the machine's — the
// user would see a spurious disconnect flash on every resync.
//
// Handlers are replaced with no-ops rather than null on purpose:
// ReconnectingWebSocket dispatches via `self.onclose(event)` unconditionally
// (reconnecting-websocket.js:179-183), so a null handler would throw.
//
// DOM-free on purpose so `node --test test/` can import it (see test/README.md).

import { logger } from './logger.js';

/**
 * Detach a socket's handlers so a socket we are discarding can no longer touch
 * the UI or fire app callbacks. Returns the socket for chaining.
 */
export function silenceSocket(socket) {
    if (!socket) return socket;
    const noop = () => {};
    socket.onopen = noop;
    socket.onmessage = noop;
    socket.onclose = noop;
    socket.onerror = noop;
    socket.onconnecting = noop;
    return socket;
}

/**
 * Create a slot that owns one socket at a time.
 *
 * @param {string} label - used in logs, e.g. 'machine snapshot'.
 */
export function createSocketSlot(label) {
    let socket = null;

    return {
        /**
         * Close (and silence) whatever is in the slot, THEN open the replacement.
         *
         * @param {() => object} open - factory constructing the new socket.
         * @returns the new socket.
         */
        replace(open) {
            if (socket) {
                logger.info(`Closing existing ${label} WebSocket before opening a new one.`);
                silenceSocket(socket);
                try {
                    socket.close();
                } catch (err) {
                    // A socket that refuses to close must not block the re-open —
                    // being stuck without a live socket is the bug we are fixing.
                    logger.warn(`Failed to close ${label} WebSocket cleanly:`, err);
                }
                socket = null;
            }
            socket = open();
            return socket;
        },

        /** The socket currently in the slot, or null. */
        current() {
            return socket;
        },
    };
}
