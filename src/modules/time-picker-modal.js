// Clock-face time picker -- a touch-first replacement for the native
// <input type="time"> spinner on tablet.
//
// Why this exists: the native time control renders the OS spinner/keyboard,
// which looks and behaves nothing like the rest of the skin on the machine's
// touchscreen. This module intercepts taps on any `input[type="time"]` (tablet
// only) and opens a Material-style dial instead: pick the hour, then the
// minute, with an AM/PM toggle. It writes the value straight back to the same
// input as "HH:MM" and dispatches input/change, so every existing save handler
// (handleNightModeTimeChange, handleSaveSchedule, ...) is untouched.
//
// Desktop keeps the native control: shouldUseNumpad() is false there, so
// initTimePicker() installs nothing.
//
// Opt out of the custom picker on a specific input with `data-no-time-picker`.

import { shouldUseNumpad } from './numpad-policy.js';
import {
    parseTime24,
    formatTime24,
    to12h,
    to24h,
    hourHandAngle,
    minuteHandAngle,
} from './time-picker-core.js';

let dialogEl = null;
const state = {
    inputEl: null,
    h12: 12,
    m: 0,
    ampm: 'AM',
    mode: 'hour', // 'hour' | 'minute'
};

// ---- geometry (matches the 264x264 viewBox in time-picker-modal.css) --------
const CENTER = 132;
const RADIUS = 98;
const FACE_R = 118;
const KNOB_R = 20;

const HOUR_LABELS = ['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
const MIN_LABELS = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

function pointOnFace(indexAngleDeg) {
    const a = (indexAngleDeg * Math.PI) / 180;
    return { x: CENTER + RADIUS * Math.cos(a), y: CENTER + RADIUS * Math.sin(a) };
}

function renderClock() {
    const isHour = state.mode === 'hour';
    const labels = isHour ? HOUR_LABELS : MIN_LABELS;

    let handAngle;
    let selIndex;
    if (isHour) {
        selIndex = state.h12 % 12; // 12 o'clock lives at index 0
        handAngle = hourHandAngle(state.h12);
    } else {
        handAngle = minuteHandAngle(state.m);
        selIndex = state.m % 5 === 0 ? (state.m / 5) % 12 : -1; // no exact number between ticks
    }

    const knob = pointOnFace(handAngle);
    const parts = [
        `<circle cx="${CENTER}" cy="${CENTER}" r="${FACE_R}" class="tpm-face"/>`,
        `<line x1="${CENTER}" y1="${CENTER}" x2="${knob.x.toFixed(2)}" y2="${knob.y.toFixed(2)}" class="tpm-hand"/>`,
        `<circle cx="${knob.x.toFixed(2)}" cy="${knob.y.toFixed(2)}" r="${KNOB_R}" class="tpm-knob"/>`,
        `<circle cx="${CENTER}" cy="${CENTER}" r="4" class="tpm-hub"/>`,
    ];

    labels.forEach((label, i) => {
        const p = pointOnFace(i * 30 - 90);
        const val = isHour ? (i === 0 ? 12 : i) : i * 5;
        const sel = i === selIndex ? ' tpm-num-sel' : '';
        // Transparent hit target first (bigger than the glyph), label on top.
        parts.push(`<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="22" class="tpm-hit" data-val="${val}"/>`);
        parts.push(`<text x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" class="tpm-num${sel}" data-val="${val}">${label}</text>`);
    });

    return `<svg viewBox="0 0 264 264" class="tpm-svg">${parts.join('')}</svg>`;
}

function render() {
    if (!dialogEl) return;
    const hourEl = dialogEl.querySelector('#tpm-hour');
    const minEl = dialogEl.querySelector('#tpm-min');
    hourEl.textContent = String(state.h12).padStart(2, '0');
    minEl.textContent = String(state.m).padStart(2, '0');
    hourEl.classList.toggle('tpm-seg-active', state.mode === 'hour');
    minEl.classList.toggle('tpm-seg-active', state.mode === 'minute');
    dialogEl.querySelectorAll('.tpm-ampm-btn').forEach((b) => {
        b.classList.toggle('tpm-ampm-on', b.dataset.ampm === state.ampm);
    });
    dialogEl.querySelector('#tpm-clock').innerHTML = renderClock();
}

function handleClockClick(e) {
    const hit = e.target.closest ? e.target.closest('[data-val]') : null;
    if (!hit) return;
    const val = parseInt(hit.getAttribute('data-val'), 10);
    if (Number.isNaN(val)) return;
    if (state.mode === 'hour') {
        state.h12 = val === 0 ? 12 : val;
        state.mode = 'minute'; // auto-advance to the minute dial, like the OS picker
    } else {
        state.m = val % 60;
    }
    render();
}

function close() {
    if (dialogEl && dialogEl.open) dialogEl.close();
}

function commit() {
    const h24 = to24h(state.h12, state.ampm);
    const value = formatTime24(h24, state.m);
    const el = state.inputEl;
    close();
    if (el) {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

function ensureDialog() {
    if (dialogEl) return dialogEl;

    dialogEl = document.createElement('dialog');
    dialogEl.id = 'time-picker-modal';
    dialogEl.className = 'tpm-dialog';
    dialogEl.innerHTML = `
        <div class="tpm-card">
            <div class="tpm-header">
                <span class="tpm-title" data-i18n-key="Set time">Set time</span>
                <div class="tpm-actions">
                    <button type="button" class="tpm-btn tpm-cancel" data-act="cancel" data-i18n-key="Cancel">CANCEL</button>
                    <button type="button" class="tpm-btn tpm-ok" data-act="ok" data-i18n-key="OK">OK</button>
                </div>
            </div>
            <div class="tpm-display">
                <button type="button" class="tpm-seg" id="tpm-hour" data-seg="hour">12</button>
                <span class="tpm-colon">:</span>
                <button type="button" class="tpm-seg" id="tpm-min" data-seg="minute">00</button>
                <div class="tpm-ampm">
                    <button type="button" class="tpm-ampm-btn" data-ampm="AM">AM</button>
                    <button type="button" class="tpm-ampm-btn" data-ampm="PM">PM</button>
                </div>
            </div>
            <div class="tpm-clock" id="tpm-clock"></div>
        </div>`;
    document.body.appendChild(dialogEl);

    dialogEl.querySelector('#tpm-hour').addEventListener('click', () => {
        state.mode = 'hour';
        render();
    });
    dialogEl.querySelector('#tpm-min').addEventListener('click', () => {
        state.mode = 'minute';
        render();
    });
    dialogEl.querySelectorAll('.tpm-ampm-btn').forEach((b) => {
        b.addEventListener('click', () => {
            state.ampm = b.dataset.ampm;
            render();
        });
    });
    dialogEl.querySelector('#tpm-clock').addEventListener('click', handleClockClick);
    dialogEl.querySelector('[data-act="ok"]').addEventListener('click', commit);
    dialogEl.querySelector('[data-act="cancel"]').addEventListener('click', close);
    // Backdrop tap (outside the card) cancels; ESC fires the dialog 'cancel' event.
    dialogEl.addEventListener('click', (e) => {
        if (e.target === dialogEl) close();
    });

    return dialogEl;
}

// Open the picker for a given <input type="time">. Reads its current "HH:MM"
// value, and on OK writes the new "HH:MM" back and dispatches input/change.
export function openTimePicker(inputEl) {
    ensureDialog();
    state.inputEl = inputEl;
    const { h24, m } = parseTime24(inputEl && inputEl.value);
    const twelve = to12h(h24);
    state.h12 = twelve.h12;
    state.ampm = twelve.ampm;
    state.m = m;
    state.mode = 'hour';
    render();
    if (!dialogEl.open) dialogEl.showModal();
}

// Install the delegated interception once, on tablet only. Uses capture-phase
// listeners on document so it survives every settings re-render and works even
// when the target input lives inside a native <dialog> (top layer): our own
// <dialog>.showModal() then stacks above it.
export function initTimePicker() {
    if (!shouldUseNumpad()) return; // desktop keeps the native <input type="time">
    if (window.__tpmInstalled) return;
    window.__tpmInstalled = true;

    const match = (t) =>
        t && t.matches && t.matches('input[type="time"]') && !t.hasAttribute('data-no-time-picker')
            ? t
            : null;

    // Kill the tap before it can focus the field or run an inline onclick that
    // would summon the OS picker.
    document.addEventListener(
        'pointerdown',
        (e) => {
            if (!match(e.target)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        },
        true,
    );
    document.addEventListener(
        'click',
        (e) => {
            const t = match(e.target);
            if (!t) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            openTimePicker(t);
        },
        true,
    );
    // Safety net: if the field gets focus by any other path, drop it so the OS
    // keyboard/picker never appears.
    document.addEventListener(
        'focusin',
        (e) => {
            const t = match(e.target);
            if (t) t.blur();
        },
        true,
    );
}

// Exposed for manual testing in the browser console.
window.openTimePicker = openTimePicker;
window.initTimePicker = initTimePicker;

export { initTimePicker as default };
