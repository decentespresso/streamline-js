// Pure time-of-day helpers for the clock-face time picker.
//
// No DOM, no imports, no browser globals -- everything here is a plain function
// of its arguments so it can be unit-tested under `node --test`
// (test/time-picker-core.test.mjs). The DOM component lives in
// time-picker-modal.js and imports from here.

function clampInt(v, lo, hi) {
    v = Math.round(Number(v));
    if (!Number.isFinite(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
}

// Parse an "HH:MM" 24-hour string into { h24, m }. Anything that is not a valid
// time of day (empty field, garbage, out-of-range) falls back to `fallback` so
// the picker always opens on a real time rather than NaN.
export function parseTime24(str, fallback = { h24: 7, m: 0 }) {
    if (typeof str !== 'string') return { ...fallback };
    const match = str.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
    if (!match) return { ...fallback };
    const h24 = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (h24 < 0 || h24 > 23 || m < 0 || m > 59) return { ...fallback };
    return { h24, m };
}

// Format an hour/minute pair back to a zero-padded "HH:MM" 24-hour string --
// the exact shape the native <input type="time"> and the existing save handlers
// read, so callers stay unchanged.
export function formatTime24(h24, m) {
    const hh = String(clampInt(h24, 0, 23)).padStart(2, '0');
    const mm = String(clampInt(m, 0, 59)).padStart(2, '0');
    return `${hh}:${mm}`;
}

// 24-hour hour -> 12-hour clock form. 0 -> 12 AM, 12 -> 12 PM, 13 -> 1 PM.
export function to12h(h24) {
    h24 = clampInt(h24, 0, 23);
    const ampm = h24 < 12 ? 'AM' : 'PM';
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return { h12, ampm };
}

// 12-hour clock form -> 24-hour hour. Inverse of to12h.
export function to24h(h12, ampm) {
    h12 = clampInt(h12, 1, 12);
    const pm = String(ampm).toUpperCase() === 'PM';
    if (h12 === 12) return pm ? 12 : 0;
    return pm ? h12 + 12 : h12;
}

// Round a raw minute to the nearest `step`, wrapping 60 back to 0. The minute
// dial only exposes multiples of `step`, so a tap resolves to the nearest one.
export function snapMinute(m, step = 5) {
    m = clampInt(m, 0, 59);
    return (Math.round(m / step) * step) % 60;
}

// Angle in degrees for the clock hand, measured from 12 o'clock going clockwise
// (so -90 points straight up, 0 points right, 90 points down). Shared by the
// hour and minute dials.
export function hourHandAngle(h12) {
    return (clampInt(h12, 1, 12) % 12) * 30 - 90;
}
export function minuteHandAngle(m) {
    return clampInt(m, 0, 59) * 6 - 90;
}
