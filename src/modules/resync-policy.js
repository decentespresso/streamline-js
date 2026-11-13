/**
 * DOM-free decision for api.resyncIfDrifted: what to do when the workflow's
 * value for a remembered control disagrees with the remembered (`last-*`) one.
 *
 * The remembered value is only authoritative for pushes Streamline itself made
 * and has not seen land. Anything else that differs was written by someone else
 * (another skin, a plugin, a script) on purpose, so it is adopted, not undone.
 */

// A DE1 under a fast write stream can echo the previous value for a few
// seconds after our own push (decaid gh-678). Frames that show it inside this
// window are not outside changes.
export const ECHO_WINDOW_MS = 10000;

/**
 * @param {object} p
 * @param {*} p.remembered  KV `last-*` value, null when the user never set one
 * @param {*} p.observed    value the workflow holds now, null/undefined if absent
 * @param {*} p.pending     value of our own push that has not been confirmed, or null
 * @param {{value:*, at:number}|null} p.lastPush  our most recent push of this field
 * @param {number} p.now
 * @returns {{action:'none'}|{action:'push', value:*}|{action:'adopt', value:*}}
 */
export function decideResync({ remembered, observed, pending = null, lastPush = null, now }) {
    // Our own failed push: keep retrying it until the workflow shows it.
    if (pending != null && pending !== observed) return { action: 'push', value: pending };
    if (remembered == null) return { action: 'none' };
    // A missing field is not an outside choice; fill it from what the user set.
    if (observed == null) return { action: 'push', value: remembered };
    if (remembered === observed) return { action: 'none' };
    if (lastPush && now - lastPush.at < ECHO_WINDOW_MS && observed !== lastPush.value) {
        return { action: 'none' };
    }
    return { action: 'adopt', value: observed };
}
