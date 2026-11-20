// DOM-free decision for loadAssignments(): where the favourites come from and
// whether the Decaid store may be written back.
//
// The Decaid store is shared by every tablet. A write-back after a read that
// FAILED would replace whatever another device saved with this device's older
// IndexedDB backup, so a write-back is only allowed when the read succeeded and
// found nothing usable (a first run, or a store that was wiped).

const isValid = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{readOk: boolean, remote: any, backup: any}} input
 *   readOk  - the Decaid read completed (a 404 "no such key" counts as completed)
 *   remote  - what it returned (ignored when readOk is false)
 *   backup  - the IndexedDB copy (may be null)
 * @returns {{source: 'remote'|'backup'|'none', assignments: object|null, writeBack: boolean}}
 */
export function planAssignmentsLoad({ readOk, remote, backup }) {
    if (readOk && isValid(remote)) return { source: 'remote', assignments: remote, writeBack: false };
    if (isValid(backup)) return { source: 'backup', assignments: backup, writeBack: readOk === true };
    return { source: 'none', assignments: null, writeBack: false };
}

/**
 * Auto-populating defaults must not be persisted when the Decaid read failed:
 * the store may hold another device's favourites that we just could not see.
 */
export function mayPersistAutoPopulate(readOk) {
    return readOk === true;
}
