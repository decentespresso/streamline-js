// Pure policy for keeping the Grind tile and a connected grinder in step. DOM-free so
// node:test can import it; the wiring is in grinder-runtime.js.
//
// Two directions, each opt-in and each acting only on a CHANGE of its own side, so the
// two never fight: a value the skin just sent comes back as an unchanged tile, and a
// value the grinder just reported comes back as an unchanged reading.
//   follow: the grinder's reading becomes the tile ("device wins").
//   send:   a tile edit is written to the grinder ("recipe wins").

const SAME = 0.005; // the tile keeps hundredths

export const sameGrind = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < SAME;

/** The reading a snapshot carries: a writable grinder's `setting`, else the read-only `observedSetting`. */
export function deviceSetting(snapshot) {
    const raw = snapshot?.setting ?? snapshot?.observedSetting;
    return typeof raw === 'string' ? raw : null;
}

/** A plain number from a grinder's setting string; null for text such as "espresso/A". */
export function parseDeviceNumber(text) {
    if (typeof text !== 'string' || !/^\s*-?\d+(\.\d+)?\s*$/.test(text)) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
}

/** -> the number to put on the tile, or null. Only when the grinder's reading moved. */
export function followDecision({ deviceValue, lastDevice, tileValue }) {
    if (!Number.isFinite(deviceValue) || sameGrind(deviceValue, lastDevice)) return null;
    return sameGrind(deviceValue, tileValue) ? null : deviceValue;
}

/** Can the skin write a number to this grinder? A command it supports and a numeric range. */
export function canSendGrind(info) {
    const d = info?.controls?.grindSetting;
    return Array.isArray(info?.capabilities) && info.capabilities.includes('grindSetting')
        && d?.kind === 'numeric' && Number.isFinite(d.min) && Number.isFinite(d.max) && d.min <= d.max;
}

const decimals = n => (String(n).split('.')[1] || '').length;

/** The setting string for the grinder: held to its range, to the precision of its step. */
export function grinderSettingString(value, descriptor) {
    if (!Number.isFinite(value) || descriptor?.kind !== 'numeric') return null;
    const clamped = Math.min(descriptor.max, Math.max(descriptor.min, value));
    const places = descriptor.step > 0 ? Math.min(2, decimals(descriptor.step)) : 2;
    return String(Number(clamped.toFixed(places)));
}

/** -> the string to send, or null. Only when the tile moved, and not to what the grinder already shows. */
export function sendDecision({ tileValue, lastTile, deviceValue, info }) {
    if (!canSendGrind(info) || !Number.isFinite(tileValue) || sameGrind(tileValue, lastTile)) return null;
    if (sameGrind(tileValue, deviceValue)) return null;
    return grinderSettingString(tileValue, info.controls.grindSetting);
}

/** The Grind tile's -/+ step a connected grinder declares (its numeric control's step), or null. */
export function grindStepFromInfo(info) {
    const d = info?.controls?.grindSetting;
    const step = d?.step;
    return Array.isArray(info?.capabilities) && info.capabilities.includes('grindSetting')
        && d?.kind === 'numeric' && Number.isFinite(step) && step > 0 && step <= 100 ? step : null;
}
