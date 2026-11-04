// The DYE2 master switch on its own, split out of dyeStrip.js so a caller can
// read the flag without pulling that module in. dyeStrip.js is ~90K and
// history.js imported all of it for this one-line gate, which put it on the
// boot graph; dyeStrip.js re-exports isDye2Enabled, so this file stays the one
// definition of the key and no other call site changes.
//
// localStorage is touched inside the function, never at module load, so this
// stays importable from a node test.
export const DYE2_ENABLED_KEY = 'streamline.dye2Enabled';

export function isDye2Enabled() {
    try { return localStorage.getItem(DYE2_ENABLED_KEY) === 'true'; } catch (e) { return false; }
}
