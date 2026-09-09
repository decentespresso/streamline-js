import { loadPage } from './router.js';
import { showToast, flashPlusMinusButton } from './ui.js';
import { openModal, shouldUseNumpad, resetNumpadModal } from './numpad-modal.js';
import { openNotesModal } from './notes-modal.js';
import { getTranslation } from './i18n.js';
import { callPluginEndpoint, getPluginSettings } from './api.js';
import { validateProfileStructure } from './profileManager.js';
import { loadECharts } from './echarts-loader.js';
import { renderChart } from './echarts-renderer.js';
import { parseTclProfile, isLikelyTclProfile } from './tcl-profile.js';
import { FIELD_LIMITS, EXIT_TYPES, EXIT_UNIT_MAP, EXIT_STEP_MAP, EXIT_MAX_MAP, DEFAULT_LIMITER_RANGE } from './profile-field-limits.js';

// ─── State ──────────────────────────────────────────────────────────────────

let editorState = {
    sourceProfileId: null,
    sourceProfileRecord: null,
    profile: null,
    activeTab: 0,
};

// IDs of profiles persisted to the server via share-code import during a
// new-profile session. Cleaned up on cancel so no orphans are left behind.
let _isNewProfileSession = false;
let _sessionImportedIds = [];
let _hasImportedInSession = false;

// Snapshot of the profile as last loaded or saved. Cancel compares against it
// to decide whether there is unsaved work worth warning about.
let _baselineProfileJson = null;







// ─── Numpad Helper ─────────────────────────────────────────────────────────

function openNumpadForField(currentVal, numpadConfig, onCommit) {
    // After router navigation the DOM is rebuilt; reset flag if overlay was lost
    if (!document.getElementById('numpad-modal-overlay')) resetNumpadModal();
    const mockInput = { value: String(currentVal), dispatchEvent: () => {} };
    openModal(mockInput, {
        fieldType: numpadConfig.fieldType || 'pe-generic',
        config: numpadConfig,
        onConfirm: (val) => {
            const num = parseFloat(val);
            if (!isNaN(num)) onCommit(clamp(num, numpadConfig.min ?? 0, numpadConfig.max ?? 9999));
        }
    });
}

// ─── Review Settings Editable Pill ─────────────────────────────────────────
// Reusable inline editable value span — dotted blue underline; click opens
// numpad on tablet or inline edit on desktop. Used in the review tab's
// settings list under the graph preview.

function createSettingPill({ value, step, unit, min, max, fieldType, title, format, onCommit }) {
    const PILL_CLASS = 'text-[var(--button-primary-bg)] font-semibold cursor-pointer select-none inline-flex underline decoration-dashed underline-offset-[3px] px-[4px] rounded-[4px]';
    const fmt = format || ((v) => unit ? `${roundTo(v, step || 1)} ${unit}` : `${roundTo(v, step || 1)}`);

    const pill = document.createElement('span');
    pill.className = PILL_CLASS;
    pill.textContent = fmt(value);
    pill.addEventListener('mouseenter', () => { pill.style.backgroundColor = 'var(--button-grey)'; });
    pill.addEventListener('mouseleave', () => { pill.style.backgroundColor = ''; });

    pill.addEventListener('click', () => {
        if (shouldUseNumpad()) {
            openNumpadForField(value, {
                fieldType: fieldType || 'pe-review-setting',
                title: title || (unit ? unit.toUpperCase() : 'VALUE'),
                unit: unit || '',
                min: min ?? 0,
                max: max ?? 9999,
                label: `${min ?? 0}–${max ?? 9999}`
            }, (val) => {
                value = val;
                pill.textContent = fmt(value);
                onCommit(value);
            });
            return;
        }
        inlineEditValue(pill, value, {
            min, max, step: step || 1, unit,
            onCommit(val) {
                value = val;
                pill.textContent = fmt(value);
                onCommit(value);
            }
        });
    });

    return pill;
}

// ─── Desktop Inline Edit Helper ────────────────────────────────────────────
// On desktop (non-numpad), clicking a numeric display opens a small input field
// so the user can type a value directly instead of using +/- buttons.

function inlineEditValue(displayEl, currentValue, { min, max, step, unit, onCommit }) {
    if (shouldUseNumpad()) return false; // tablet — let numpad handle it
    if (!displayEl || !displayEl.querySelector) return false; // not a valid element
    if (displayEl.querySelector('input')) return false; // already editing

    // Find the first text node to replace (preserve child elements like ± buttons)
    let textNode = null;
    for (const child of displayEl.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { textNode = child; break; }
    }
    const savedText = textNode ? textNode.textContent : displayEl.textContent;

    const input = document.createElement('input');
    input.type = 'number';
    input.value = currentValue;
    input.step = step || 'any';
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.className = 'bg-transparent border-b-2 border-[var(--text-primary)] outline-none text-center font-bold text-[var(--text-primary)]';
    input.style.cssText = `width:${Math.max(displayEl.offsetWidth, 60)}px;font-size:inherit;line-height:inherit;`;

    if (textNode) {
        displayEl.replaceChild(input, textNode);
    } else {
        displayEl.textContent = '';
        displayEl.appendChild(input);
    }
    input.focus();
    input.select();

    function commit() {
        const num = parseFloat(input.value);
        restore(); // always put text node back before calling onCommit
        if (!isNaN(num)) {
            const clamped = clamp(roundTo(num, step || 0.1), min ?? 0, max ?? 9999);
            onCommit(clamped);
        }
        cleanup();
    }

    function restore() {
        const newText = document.createTextNode(savedText);
        if (input.parentNode === displayEl) displayEl.replaceChild(newText, input);
    }

    function cancel() {
        restore();
        cleanup();
    }

    function cleanup() {
        input.removeEventListener('blur', commit);
        input.removeEventListener('keydown', onKey);
    }

    function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', commit); cancel(); }
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', onKey);
    return true; // handled
}

// ─── Constants ──────────────────────────────────────────────────────────────

// EXIT_TYPES/EXIT_UNIT_MAP/EXIT_STEP_MAP/EXIT_MAX_MAP and FIELD_LIMITS live in
// profile-field-limits.js (imported above) so the legacy-TCL importer clamps
// against the exact same bounds this editor enforces, rather than a second
// copy that can drift the way the grid/text tabs once did (see that module's
// header comment).

// A step with no `exit` has no exit condition, so it reads as 'off'. Both tabs
// go through this so they agree: the grid used to default a missing exit to
// { pressure, over, 0 } and render "Pressure is over 0.0 bar", announcing an
// exit the step does not have and the save path would not write.
function readExitDef(step) {
    const e = step.exit;
    if (!e || (e.type !== 'pressure' && e.type !== 'flow')) {
        return { type: 'off', condition: 'over', value: 0 };
    }
    return { type: e.type, condition: e.condition || 'over', value: e.value ?? 0 };
}

// Builds a numpad config from a FIELD_LIMITS entry so the displayed range label
// can never disagree with the range actually enforced.
function numpadConfig(fieldType, title, unit, lim) {
    return { fieldType, title, unit, min: lim.min, max: lim.max, label: `${lim.min}–${lim.max}` };
}

// Numpad identity for the three "Max" fields — shared by the grid and text tabs.
const MAX_NUMPAD = {
    weight:  { fieldType: 'pe-max-weight',  title: 'MAX WEIGHT' },
    seconds: { fieldType: 'pe-max-seconds', title: 'MAX TIME' },
    volume:  { fieldType: 'pe-max-volume',  title: 'MAX VOLUME' },
};

// Seed values used when the pump-toggle switches between flow and pressure
// modes. Not part of the persisted step shape — see makeNewStep().
const PUMP_SEED_FLOW = 6.0;
const PUMP_SEED_PRESSURE = 6.0;

const DEFAULT_STEP = {
    name: 'New Step',
    pump: 'flow',
    transition: 'fast',
    flow: PUMP_SEED_FLOW,
    temperature: 93,
    sensor: 'coffee',
    seconds: 30,
    weight: 0,
    volume: 0,
    exit: { type: 'pressure', condition: 'over', value: 9.0 },
    limiter: null,
};

// Factory for new steps inserted from the "+" button. Returns a deep copy of
// DEFAULT_STEP. Kept as a function so future variants (e.g. seeded from the
// previous step) can branch here.
function makeNewStep() {
    return JSON.parse(JSON.stringify(DEFAULT_STEP));
}

// profile.target_volume_count_start is a 1-based step index (0 = None), so it
// has to move with the steps around it. Splicing the array directly — as both
// the grid and text tabs used to do — silently repointed it at a different
// step, or left it dangling past the end of the array.
function removeStepAt(index) {
    const p = editorState.profile;
    p.steps.splice(index, 1);
    const start = p.target_volume_count_start || 0;
    if (start === index + 1) p.target_volume_count_start = index; // the marked step is gone → fall back to the one before it (0 = None)
    else if (start > index + 1) p.target_volume_count_start = start - 1;
}

// Deleting a step throws away everything configured on it and there is no undo,
// so it asks first. Composed from keys the translation sheet already carries
// ('Delete', 'Step', 'Cancel') rather than adding a new sentence to translate —
// the question plus the Delete/Cancel buttons say enough without a body. The
// step's own name is deliberately left out: promptConfirm renders its message
// as innerHTML and the name is user input.
function confirmDeleteStep(index) {
    return promptConfirm({
        message: `${getTranslation('Delete')} ${getTranslation('Step')} ${index + 1}?`,
        confirmLabel: getTranslation('Delete'),
        cancelLabel: getTranslation('Cancel'),
    });
}

function insertStepAfter(index) {
    const p = editorState.profile;
    p.steps.splice(index + 1, 0, makeNewStep());
    const start = p.target_volume_count_start || 0;
    if (start > index + 1) p.target_volume_count_start = start + 1;
}

// Reorder button for a step. `dir` is -1 (earlier) or +1 (later). At the ends
// of the run the button stays in place but goes inert, so the footer's button
// row keeps the same width on every step — a disappearing control would shift
// delete and insert sideways under the finger.
function makeMoveBtn(index, dir, total, rerender, big) {
    // Class strings are literals, not interpolated: Tailwind builds app.css by
    // scanning source text, so a `w-[${size}px]` would compile to nothing and
    // silently lose its width.
    const BOX = big
        ? 'pe-step-action-btn w-[60px] h-[60px] flex items-center justify-center rounded-[10px]'
        : 'pe-step-action-btn w-[36px] h-[36px] flex items-center justify-center rounded-[10px]';

    const target = index + dir;
    const disabled = target < 0 || target >= total;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${BOX} ${disabled ? 'cursor-default' : 'text-[var(--mimoja-blue)] hover:bg-[var(--button-grey)] cursor-pointer'}`;
    if (disabled) {
        btn.style.color = 'var(--low-contrast-white)';
        btn.style.opacity = '0.35';
        btn.disabled = true;
    }
    const d = dir < 0 ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7';
    const px = big ? 'h-8 w-8' : 'h-5 w-5';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="${px}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${d}" /></svg>`;
    btn.setAttribute('aria-label', dir < 0 ? 'Move step earlier' : 'Move step later');
    if (!disabled) btn.addEventListener('click', () => { if (moveStep(index, target)) rerender(); });
    return btn;
}

// Move a step to a new position. Like removeStepAt/insertStepAfter this has to
// carry profile.target_volume_count_start with it — a 1-based step index where
// 0 means None. Reordering steps under it would otherwise silently re-point
// preinfusion at whichever step happened to land in that slot.
function moveStep(from, to) {
    const p = editorState.profile;
    if (to < 0 || to >= p.steps.length || from === to) return false;

    const [moved] = p.steps.splice(from, 1);
    p.steps.splice(to, 0, moved);

    const start = p.target_volume_count_start || 0;
    if (start === 0) return true;            // None — nothing to track
    let marked = start - 1;                  // to 0-based
    if (marked === from) {
        marked = to;                         // the marked step is the one that moved
    } else if (from < to && marked > from && marked <= to) {
        marked -= 1;                         // steps it passed shift left
    } else if (from > to && marked >= to && marked < from) {
        marked += 1;                         // steps it passed shift right
    }
    p.target_volume_count_start = marked + 1;
    return true;
}

const TAB_COUNT = 3;

// Stepper ± button. 44px is the WCAG 2.5.5 / iOS HIG touch-target floor; the old
// expand-on-tap buttons were 60px, which only fitted because they were hidden at
// rest and drawn outside the cell. Always-visible buttons have to live in the
// cell's width budget, and 44 is what pays for that.
const STEPPER_BTN_CLASS = 'bg-[var(--button-grey)] rounded-[14px] w-[44px] h-[44px] flex items-center justify-center shrink-0 cursor-pointer select-none text-xl font-bold text-[var(--text-primary)]';

// ─── Helpers ────────────────────────────────────────────────────────────────

function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function clamp(value, min, max) {
    if (min !== undefined && value < min) return min;
    if (max !== undefined && value > max) return max;
    return value;
}

function roundTo(value, step) {
    value = typeof value === 'number' ? value : parseFloat(value) || 0;
    const decimals = step < 1 ? String(step).split('.')[1].length : 0;
    return parseFloat(value.toFixed(decimals));
}

// ─── Spinner Factory ────────────────────────────────────────────────────────

function createSpinner(initialValue, step, unit, onChange, opts = {}) {
    const { min, max, disabled } = opts;
    let value = typeof initialValue === 'number' ? initialValue : parseFloat(initialValue) || 0;
    let debounceTimer = null;

    const wrapper = document.createElement('div');
    wrapper.className = 'flex items-center gap-[10px]';

    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
    minusBtn.textContent = '\u2212';
    minusBtn.setAttribute('aria-label', 'Decrease');

    const display = document.createElement('span');
    display.className = 'font-bold text-[20px] text-center w-[90px] text-[var(--text-primary)]';

    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'bg-[var(--button-grey)] rounded-[18px] w-[60px] h-[60px] flex items-center justify-center cursor-pointer select-none text-xl font-bold text-[var(--text-primary)] z-[10]';
    plusBtn.textContent = '+';
    plusBtn.setAttribute('aria-label', 'Increase');

    function updateDisplay() {
        const formatted = roundTo(value, step);
        display.textContent = unit ? `${formatted} ${unit}` : `${formatted}`;
    }

    function debouncedOnChange() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            onChange(value);
        }, 300);
    }

    minusBtn.addEventListener('click', () => {
        flashPlusMinusButton(minusBtn);
        value = roundTo(clamp(value - step, min, max), step);
        updateDisplay();
        debouncedOnChange();
    });

    plusBtn.addEventListener('click', () => {
        flashPlusMinusButton(plusBtn);
        value = roundTo(clamp(value + step, min, max), step);
        updateDisplay();
        debouncedOnChange();
    });

    // Click the value to type one: numpad on tablet, inline input on desktop.
    // This used to need two taps (first selected, second opened) with a 2s
    // window in between — the ± are always visible here, so there was never
    // anything for the first tap to disambiguate.
    display.style.cursor = 'pointer';
    display.addEventListener('click', () => {
        const commit = (val) => { value = roundTo(val, step); updateDisplay(); onChange(value); };
        if (shouldUseNumpad()) {
            openNumpadForField(value, {
                fieldType: 'pe-settings',
                title: (unit || 'VALUE').toUpperCase(),
                unit: unit || '',
                min: min ?? 0,
                max: max ?? 9999,
                label: `${min ?? 0}–${max ?? 9999}`
            }, commit);
            return;
        }
        inlineEditValue(display, value, { min, max, step, unit, onCommit: commit });
    });

    updateDisplay();

    wrapper.appendChild(minusBtn);
    wrapper.appendChild(display);
    wrapper.appendChild(plusBtn);

    // A disabled spinner still shows its value -- it reads as "nothing set"
    // rather than vanishing -- but nothing about it is live. pointer-events
    // covers the +, the - and the tap-to-type on the display in one go.
    if (disabled) {
        wrapper.className += ' opacity-40 pointer-events-none';
        wrapper.setAttribute('aria-disabled', 'true');
    }

    // Expose a way to get or set the current value externally
    wrapper._getValue = () => value;
    wrapper._setValue = (v) => { value = v; updateDisplay(); };

    return wrapper;
}

// ─── Limiter tolerance ──────────────────────────────────────────────────────
// `range` is the softness of a limiter: 0 clamps hard at the limit, larger
// values taper into it (decaid's _applyLimiter). It is a per-step field the
// editor presents profile-wide, one control per pump type, so the read has to
// pick a step that actually carries a limiter -- profiles routinely limit only
// their last step, and the earlier steps' dead `value: 0` limiters keep a stale
// range. Live limiters agree within a profile, so the first live one wins.
// DEFAULT_LIMITER_RANGE itself lives in profile-field-limits.js (imported above).

function limitedSteps(pump) {
    return (editorState.profile?.steps || []).filter(s => s.pump === pump && s.limiter);
}

function limiterRangeOf(pump, fallback) {
    const limited = limitedSteps(pump);
    const step = limited.find(s => parseFloat(s.limiter.value) > 0) || limited[0];
    const range = parseFloat(step?.limiter?.range);
    return Number.isFinite(range) ? range : fallback;
}

// What a limiter created from a step card gets. It inherits the profile's
// existing tolerance so adding one doesn't quietly introduce a second range;
// with no limiter anywhere it takes the DE1's conventional band, NOT the 0 the
// tolerance spinner shows for "none" -- that would hard-clamp the new limiter.
function newLimiterRange(pump) {
    return limiterRangeOf(pump, DEFAULT_LIMITER_RANGE);
}

// ─── Grid Stepper ───────────────────────────────────────────────────────────
// One control for every numeric field in the step grid: [−] [value] [+].
//
// `revealOnTap` hides the ± until the value is tapped, so a cell at rest shows
// only its numbers. Two rules keep that from repeating the old tap-to-expand
// model's mistakes:
//
//  1. Hidden means `visibility:hidden`, not `display:none`. The ± keep their
//     space, so revealing them cannot reflow the row out from under a finger —
//     which is the reason the old code positioned them `absolute` outside the
//     pill, where they overlapped the sticky label column and the next step.
//  2. Nothing auto-collapses. The old 2s timer expired mid-edit and was a
//     WCAG 2.2.1 failure. A revealed stepper closes only when another one
//     opens, tracked by the single `_activeStepper` below (the previous code
//     spread this across five Sets and a Map that could disagree).
//
// Tapping the value opens the numpad on tablet or an inline input on desktop —
// once revealed, or immediately when `revealOnTap` is false.
let _activeStepper = null; // { hide: fn } | null

// `startRevealed` steppers are the grid's affordance hint: the Temp row draws
// its ± on first paint so the control demonstrates itself, and the first tap on
// any pill anywhere retires them — by then the user has seen what a pill does.
// Dismissal is sticky for the editing session, otherwise every renderStepCards()
// (tab switch, insert, delete) would re-arm the hint and it would read as a
// flicker rather than a one-time lesson. Reset in initializeProfileEditor.
let _hintSteppers = [];      // hide fns still acting as hints
let _hintsDismissed = false;

function _dismissHints(exceptHide) {
    if (!_hintSteppers.length) return;
    for (const hideFn of _hintSteppers) if (hideFn !== exceptHide) hideFn();
    _hintSteppers = [];
    _hintsDismissed = true;
}

function createGridStepper({ value, lim, numpad, revealOnTap = false, startRevealed = false, offWhenZero = false, format, onChange }) {
    let current = value;
    const fmt = format || ((v) => `${roundTo(v, lim.step)}`);

    const wrapper = document.createElement('div');
    wrapper.className = 'flex items-center gap-[8px]';

    const display = document.createElement('span');
    display.style.minWidth = '140px';

    function restyle() {
        // offWhenZero fields (the limiter, the three Max limits) read as an
        // outline pill at 0 — white on --secondary-button-bg was 1.75:1 in the
        // light theme. Off is greyed, not just unfilled: --secondary-button-outline
        // is the blue the live Flow/Quickly toggles wear, so a 0 g pill used to
        // look exactly as enabled as they are.
        const on = !offWhenZero || current > 0;
        const textCls = on ? 'text-white' : 'text-[var(--low-contrast-white)]';
        const bg = on ? 'bg-[var(--button-primary-bg)]' : '';
        display.className = `${bg} rounded-[8px] px-[10px] py-[4px] text-[24px] font-semibold cursor-pointer select-none text-center ${textCls}`;
        display.style.border = on ? '1px solid transparent' : '1px solid var(--border-color)';
        // The ± dim with their pill, so a revealed-but-off field still reads off.
        minusBtn.style.opacity = on ? '' : '0.45';
        plusBtn.style.opacity  = on ? '' : '0.45';
    }

    function render() {
        display.textContent = fmt(current);
        restyle();
    }

    function commit(val) {
        current = val;
        render();
        onChange(current);
    }

    function mkBtn(label, delta, ariaLabel) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = STEPPER_BTN_CLASS;
        btn.textContent = label;
        btn.setAttribute('aria-label', ariaLabel);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            flashPlusMinusButton(btn);
            commit(roundTo(clamp(current + delta, lim.min, lim.max), lim.step));
        });
        return btn;
    }

    const minusBtn = mkBtn('−', -lim.step, numpad.title + ' decrease');
    const plusBtn  = mkBtn('+',       lim.step, numpad.title + ' increase');

    const isHint = revealOnTap && startRevealed && !_hintsDismissed;
    let revealed = !revealOnTap || isHint;
    function setRevealed(on) {
        revealed = on;
        const v = on ? 'visible' : 'hidden';
        minusBtn.style.visibility = v;
        plusBtn.style.visibility = v;
    }
    setRevealed(revealed);

    function hide() {
        if (!revealOnTap) return;
        setRevealed(false);
        if (_activeStepper && _activeStepper.hide === hide) _activeStepper = null;
    }

    if (isHint) _hintSteppers.push(hide);

    display.addEventListener('click', () => {
        // Any pill tap ends the hint — including a tap on a hinting pill itself,
        // which keeps its own ± (it is the field being edited) while its peers
        // drop theirs.
        _dismissHints(hide);
        if (revealOnTap && !revealed) {
            if (_activeStepper) _activeStepper.hide();
            setRevealed(true);
            _activeStepper = { hide };
            return;
        }
        // A hinting pill was already revealed, so this tap is the edit itself —
        // register it as active so the next tap elsewhere collapses it.
        if (revealOnTap && revealed && !_activeStepper) _activeStepper = { hide };
        if (shouldUseNumpad()) {
            openNumpadForField(current, numpad, commit);
            return;
        }
        inlineEditValue(display, current, {
            min: lim.min, max: lim.max, step: lim.step,
            onCommit: commit,
        });
    });

    render();
    wrapper.appendChild(minusBtn);
    wrapper.appendChild(display);
    wrapper.appendChild(plusBtn);
    wrapper._setWidth = (px) => { display.style.minWidth = px; };
    return wrapper;
}

// ─── Render Functions ───────────────────────────────────────────────────────

function renderStepCards() {
    const container = document.getElementById('editor-steps-container');
    if (!container) return;
    container.innerHTML = '';

    const steps = editorState.profile.steps || [];
    const numSteps = steps.length;

    // CSS grid: label col + step cols (4 visible at once, extras scroll) + add-step col
    // 380px per step = (1920 - 220 label - 180 add) / 4; minmax keeps 4 visible, min enforces scroll beyond 4
    const R = { HEADER: 1, TEMP: 2, PUMP: 3, MAX: 4, EXIT: 5, FOOTER: 6 };
    const TOTAL_ROWS = 6;

    container.style.display = 'grid';
    // Label column grows to fit the longest (translated) row label — min 110px so
    // English stays compact, max-content so longer languages don't clip/overflow.
    // repeat() rejects a count of 0 and CSS drops the whole declaration, so a
    // zero-step profile has to omit the step track entirely.
    const stepCols = numSteps > 0 ? ` repeat(${numSteps}, minmax(380px, 1fr))` : '';
    container.style.gridTemplateColumns = `minmax(110px, max-content)${stepCols} 180px`;
    container.style.gridTemplateRows = `60px 1fr 1fr 1fr 1fr 60px`;
    container.style.height = '100%';
    container.style.width = '100%';
    // Match the data rows to the header/label background (transparent cells pick this up).
    container.style.backgroundColor = 'var(--box-color)';

    // Helper: create a grid cell, append to container
    function mkCell(row, col, className) {
        const el = document.createElement('div');
        el.style.gridRow = row;
        el.style.gridColumn = col;
        el.className = className;
        container.appendChild(el);
        return el;
    }

    // ── Label column (sticky left) ────────────────────────────────────────────
    const labelBase = 'flex items-center px-[20px] py-[8px] border-r-2 border-b border-[var(--border-color)] bg-[var(--box-color)]';

    function mkLabel(row, text, tip = '') {
        const el = mkCell(row, 1, labelBase);
        el.style.position = 'sticky';
        el.style.left = '0';
        el.style.zIndex = '2';
        if (text) {
            const span = document.createElement('span');
            span.className = 'text-[17px] font-semibold text-[var(--low-contrast-white)] leading-tight break-words';
            span.textContent = text;
            el.appendChild(span);
        }
        if (tip) {
            const tipWrapper = document.createElement('div');
            tipWrapper.className = 'tooltip tooltip-right ml-[6px] before:text-[18px]';
            tipWrapper.setAttribute('data-tip', tip);
            tipWrapper.innerHTML = `<button type="button" class="w-[18px] h-[18px] rounded-full bg-[var(--button-grey)] text-[var(--low-contrast-white)] text-[12px] font-bold flex items-center justify-center shrink-0 focus:outline-none" tabindex="-1" aria-label="Help">i</button>`;
            el.appendChild(tipWrapper);
        }
        return el;
    }

    mkLabel(R.HEADER,  '');
    mkLabel(R.TEMP,    getTranslation('Temp')).id = 'editor-row-temp';
    mkLabel(R.PUMP,    getTranslation('Pump')).id = 'editor-row-pump';
    mkLabel(R.MAX,     getTranslation('Max')).id = 'editor-row-max';
    mkLabel(R.EXIT,    getTranslation('Exit if')).id = 'editor-row-exit';
    mkLabel(R.FOOTER,  '');

    // ── Step columns ──────────────────────────────────────────────────────────
    const stepCell = 'flex items-center justify-start px-[16px] py-[8px] border-r border-b border-[var(--border-color)]';

    steps.forEach((step, index) => {
        const col = index + 2;
        const isFlow = step.pump !== 'pressure';

        // Header: step number + name input
        // overflow-hidden + the min-w-0/max-w-full pair below keep a long step name
        // inside its column: the track is minmax(380px, 1fr), so it does not grow to
        // fit content — without the cap the name input spilled over the next step.
        const hCell = mkCell(R.HEADER, col, 'flex items-center justify-center px-[16px] py-[10px] border-r border-b-2 border-[var(--border-color)] bg-[var(--box-color)] overflow-hidden');
        const nameWrapper = document.createElement('div');
        nameWrapper.className = 'flex items-center gap-[6px] min-w-0 max-w-full';
        const numSpan = document.createElement('span');
        numSpan.className = 'text-[24px] font-bold text-[var(--low-contrast-white)] shrink-0 select-none';
        numSpan.textContent = `${index + 1}.`;
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = step.name || '';
        // Dashed underline, the same affordance the Text tab's editable values
        // use. Without it a transparent borderless input reads as static text.
        // It also restores a focus indicator: `outline-none` left this field with
        // no visible focus state at all.
        // min-w-0 lets the input shrink below its `size` width (a form control's
        // default min-width is auto, which is what let it push past the column);
        // max-w-full stops at the cell edge. Short names still size to their text.
        nameInput.className = 'text-[24px] font-bold text-[var(--text-primary)] bg-transparent outline-none underline decoration-dashed min-w-0 max-w-full';
        nameInput.style.textDecorationColor = 'var(--low-contrast-white)';
        nameInput.style.textUnderlineOffset = '4px';
        nameInput.addEventListener('focus', () => { nameInput.style.textDecorationColor = 'var(--mimoja-blue)'; });
        nameInput.addEventListener('blur',  () => { nameInput.style.textDecorationColor = 'var(--low-contrast-white)'; });
        const syncSize = () => { nameInput.size = Math.max(4, nameInput.value.length + 1); };
        syncSize();
        nameInput.addEventListener('input', syncSize);
        nameInput.addEventListener('change', () => { editorState.profile.steps[index].name = nameInput.value; });
        nameWrapper.appendChild(numSpan);
        nameWrapper.appendChild(nameInput);
        hCell.appendChild(nameWrapper);

        // Temp + Sensor.
        //   [−]  93 °C  [+]
        //   Group
        // Temp starts with its ± shown as the grid's affordance hint; the first tap
        // on any pill retires it and Temp behaves like every other row.
        {
            const tCell = mkCell(R.TEMP, col, 'flex flex-col justify-center items-center px-[16px] py-[8px] border-r border-b border-[var(--border-color)] gap-[10px]');
            const TEMP_LIM = FIELD_LIMITS.temperature;

            const tempStepper = createGridStepper({
                value: step.temperature || 93,
                lim: TEMP_LIM,
                revealOnTap: true,
                startRevealed: true,
                numpad: numpadConfig('pe-temp', 'TEMPERATURE', '°C', TEMP_LIM),
                format: (v) => `${v}°C`,
                onChange: (val) => {
                    editorState.profile.steps[index].temperature = val;
                    renderReviewGraph();
                },
            });
            tempStepper._setWidth('110px');

            let sensorValue = step.sensor || 'coffee';
            const sensorBtn = document.createElement('button');
            sensorBtn.type = 'button';
            sensorBtn.className = 'text-[var(--text-primary)] border border-[var(--secondary-button-outline)] rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';
            sensorBtn.textContent = sensorValue === 'coffee' ? getTranslation('Group') : getTranslation('Mix');
            sensorBtn.addEventListener('click', () => {
                sensorValue = sensorValue === 'coffee' ? 'water' : 'coffee';
                sensorBtn.textContent = sensorValue === 'coffee' ? getTranslation('Group') : getTranslation('Mix');
                editorState.profile.steps[index].sensor = sensorValue;
            });

            tCell.appendChild(tempStepper);
            tCell.appendChild(sensorBtn);
        }

        // Pump + Limit — three lines:
        //   [−]  6.0 mL/s  [+]      (± revealed on tap)
        //   [Flow]  [Quickly]
        //   + Limit   /   Limit to [−] 4.0 bar [+]
        // The pump cell carries the most controls, so its steppers stay quiet
        // until tapped — the ± keep their space (visibility, not display), so
        // revealing them never shifts the row.
        {
            const pCell = mkCell(R.PUMP, col, 'flex flex-col justify-center items-center px-[16px] py-[4px] gap-[10px] border-r border-b border-[var(--border-color)]');

            const targetUnit = isFlow ? 'mL/s' : 'bar';
            const PUMP_LIM   = isFlow ? FIELD_LIMITS.flow : FIELD_LIMITS.pressure;
            let transValue   = step.transition || 'fast';

            // ── Line 1: pump target ──────────────────────────────────────────
            const targetStepper = createGridStepper({
                value: isFlow ? (step.flow || 0) : (step.pressure || 0),
                lim: PUMP_LIM,
                revealOnTap: true,
                numpad: isFlow
                    ? numpadConfig('pe-pump', 'FLOW', 'mL/s', PUMP_LIM)
                    : numpadConfig('pe-pump', 'PRESSURE', 'bar', PUMP_LIM),
                format: (v) => `${roundTo(v, PUMP_LIM.step)} ${targetUnit}`,
                onChange: (val) => {
                    if (isFlow) editorState.profile.steps[index].flow = val;
                    else editorState.profile.steps[index].pressure = val;
                    renderReviewGraph();
                },
            });

            // ── Line 2: pump mode + ramp ─────────────────────────────────────
            // The 'Ramp' label is gone: it was the widest element in the cell,
            // and its German (row 1721, 'Sanfter Ubergang' = smooth transition)
            // hardcodes 'smooth', so beside the toggle it read 'Sanfter
            // Ubergang Schnell' — smooth transition, fast. The toggle says the
            // whole thing on its own.
            // Single cycling button, not a segmented pair: every other toggle in
            // this editor shows the current value and cycles on tap, and the
            // unit in the value above already says which mode is active.
            const modeLine = document.createElement('div');
            modeLine.className = 'flex items-center gap-[8px] flex-wrap justify-center';

            const modeBtn = document.createElement('button');
            modeBtn.type = 'button';
            modeBtn.className = 'border border-[var(--secondary-button-outline)] text-[var(--text-primary)] rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';
            modeBtn.textContent = isFlow ? getTranslation('Flow') : getTranslation('Pressure');
            modeBtn.addEventListener('click', () => {
                const s = editorState.profile.steps[index];
                if (isFlow) {
                    s.pump = 'pressure';
                    if (!s.pressure) s.pressure = PUMP_SEED_PRESSURE;
                    delete s.flow;
                } else {
                    s.pump = 'flow';
                    if (!s.flow) s.flow = PUMP_SEED_FLOW;
                    delete s.pressure;
                }
                renderStepCards(); // units, limits and the limiter axis all change with the mode
            });

            const transBtn = document.createElement('button');
            transBtn.type = 'button';
            transBtn.className = 'border border-[var(--secondary-button-outline)] text-[var(--text-primary)] rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';
            transBtn.textContent = transValue === 'fast' ? getTranslation('Quickly') : getTranslation('Slowly');
            transBtn.addEventListener('click', () => {
                transValue = transValue === 'fast' ? 'smooth' : 'fast';
                transBtn.textContent = transValue === 'fast' ? getTranslation('Quickly') : getTranslation('Slowly');
                editorState.profile.steps[index].transition = transValue;
                renderReviewGraph();
            });

            modeLine.appendChild(modeBtn);
            modeLine.appendChild(transBtn);

            // ── Line 3: limiter ──────────────────────────────────────────────
            // Off collapses to a single '+ Limit' chip: 'Limit to [−] 0 bar [+]'
            // spent four elements saying nothing is limited, on the majority of
            // steps. The chip opens the numpad directly, so there is no
            // revealed-but-still-zero state and no silently seeded value.
            const limUnit = isFlow ? 'bar' : 'mL/s';
            const LIM_LIM = isFlow ? FIELD_LIMITS.pressureLimit : FIELD_LIMITS.flowLimit;
            const limValue = step.limiter?.value ?? 0;
            const limNumpad = isFlow
                ? numpadConfig('pe-lim', 'PRESSURE LIMIT', 'bar', LIM_LIM)
                : numpadConfig('pe-lim', 'FLOW LIMIT', 'mL/s', LIM_LIM);

            function writeLim(val) {
                const s = editorState.profile.steps[index];
                if (!s.limiter) s.limiter = { value: val, range: newLimiterRange(s.pump) };
                else s.limiter.value = val;
                renderReviewGraph();
            }

            const limLine = document.createElement('div');
            // Column, not a row: "Limit to" sits above its stepper as a caption.
            // Inline it competed with the value for the cell's width and forced
            // German ("Begrenzen auf") to wrap mid-phrase.
            limLine.className = 'flex flex-col items-center gap-[4px]';

            if (limValue > 0) {
                const withText = document.createElement('span');
                // Caption weight, not body weight — at 24px it read as a peer of
                // the value it labels.
                withText.className = 'text-[20px] text-[var(--low-contrast-white)] select-none';
                withText.textContent = getTranslation('Limit to');

                const limStepper = createGridStepper({
                    value: limValue,
                    lim: LIM_LIM,
                    revealOnTap: true,
                    offWhenZero: true,
                    numpad: limNumpad,
                    format: (v) => `${roundTo(v, LIM_LIM.step)} ${limUnit}`,
                    onChange: writeLim,
                });
                limStepper._setWidth('130px');

                limLine.appendChild(withText);
                limLine.appendChild(limStepper);
            } else {
                const addLimit = document.createElement('button');
                addLimit.type = 'button';
                addLimit.className = 'border border-[var(--secondary-button-outline)] text-[var(--text-primary)] rounded-[8px] px-[10px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';
                addLimit.textContent = `+ ${getTranslation('Limit')}`;
                addLimit.addEventListener('click', () => {
                    const apply = (val) => { writeLim(val); if (val > 0) renderStepCards(); };
                    if (shouldUseNumpad()) openNumpadForField(0, limNumpad, apply);
                    else inlineEditValue(addLimit, 0, { min: LIM_LIM.min, max: LIM_LIM.max, step: LIM_LIM.step, onCommit: apply });
                });
                limLine.appendChild(addLimit);
            }

            pCell.appendChild(targetStepper);
            pCell.appendChild(modeLine);
            pCell.appendChild(limLine);
        }

        // Exit — two lines:
        //   [Pressure] [is over]
        //   [−]  9.0 bar  [+]
        // Type 'off' is a UI-only state (step.exit = null on save); it hides the
        // condition and value rather than showing a disabled control.
        {
            const exitCell = mkCell(R.EXIT, col, 'flex flex-col justify-center items-center px-[16px] py-[4px] gap-[8px] border-r border-b border-[var(--border-color)]');

            const exitDef = readExitDef(step);
            let exitType  = exitDef.type;
            let exitCond  = exitDef.condition;
            const exitValue = exitDef.value;

            const TOGGLE_CLASS = 'border border-[var(--secondary-button-outline)] text-[var(--text-primary)] rounded-[8px] px-[8px] py-[2px] text-[24px] font-semibold cursor-pointer select-none';

            function writeExit(patch) {
                const s = editorState.profile.steps[index];
                if (!s.exit) s.exit = { type: exitType, condition: exitCond, value: exitValue };
                Object.assign(s.exit, patch);
                renderReviewGraph();
            }

            const typeBtn = document.createElement('button');
            typeBtn.type = 'button';
            typeBtn.className = TOGGLE_CLASS;
            typeBtn.textContent = getTranslation(exitType.charAt(0).toUpperCase() + exitType.slice(1));
            typeBtn.addEventListener('click', () => {
                exitType = EXIT_TYPES[(EXIT_TYPES.indexOf(exitType) + 1) % EXIT_TYPES.length];
                // Bounds are per-type — pressure tops out at 12 bar, flow at
                // 8 mL/s — so the value has to come along into the new range.
                // Switching 11 bar to flow used to leave an 11 mL/s exit, well
                // over the ceiling the numpad and ± both enforce.
                const patch = { type: exitType };
                if (exitType !== 'off') patch.value = clamp(exitValue, 0, EXIT_MAX_MAP[exitType]);
                writeExit(patch);
                renderStepCards(); // unit, bounds and the whole line's visibility change with the type
            });

            const condBtn = document.createElement('button');
            condBtn.type = 'button';
            condBtn.className = TOGGLE_CLASS;
            condBtn.textContent = getTranslation(exitCond === 'over' ? 'is over' : 'is under');
            condBtn.addEventListener('click', () => {
                exitCond = exitCond === 'over' ? 'under' : 'over';
                condBtn.textContent = getTranslation(exitCond === 'over' ? 'is over' : 'is under');
                writeExit({ condition: exitCond });
            });

            const exitTopLine = document.createElement('div');
            exitTopLine.className = 'flex items-center gap-[8px] flex-wrap justify-center';
            exitTopLine.appendChild(typeBtn);
            exitCell.appendChild(exitTopLine);

            if (exitType !== 'off') {
                condBtn.style.display = '';
                exitTopLine.appendChild(condBtn);

                const EXIT_LIM = { min: 0, max: EXIT_MAX_MAP[exitType], step: EXIT_STEP_MAP[exitType] };
                const exitStepper = createGridStepper({
                    value: exitValue,
                    lim: EXIT_LIM,
                    revealOnTap: true,
                    numpad: {
                        fieldType: 'pe-exit',
                        title: 'EXIT ' + exitType.toUpperCase(),
                        unit: EXIT_UNIT_MAP[exitType] || '',
                        min: EXIT_LIM.min, max: EXIT_LIM.max,
                        label: `${EXIT_LIM.min}–${EXIT_LIM.max}`,
                    },
                    format: (v) => `${roundTo(v, EXIT_LIM.step)} ${EXIT_UNIT_MAP[exitType]}`,
                    onChange: (val) => writeExit({ value: val }),
                });
                exitStepper._setWidth('130px');
                exitCell.appendChild(exitStepper);
            }
        }

        // Max — one stepper per limit, stacked.
        //   [−]  0 g    [+]      outline = this limit is off
        //   [−]  30 sec [+]      filled  = active
        //   [−]  0 ml   [+]
        // All three are shown because all three are live on the machine: whichever
        // trips first ends the step. The old row colored exactly one of them blue
        // by a weight > seconds > volume priority, which described nothing the
        // machine does, and it floated the inactive pills absolutely above and
        // below the active one — over the Pump and Exit rows either side of it.
        {
            const maxCell = mkCell(R.MAX, col, 'flex flex-col justify-center items-center px-[16px] py-[4px] border-r border-b border-[var(--border-color)] gap-[4px]');

            const MAX_FIELDS = [
                { key: 'weight',  unit: 'g',   lim: FIELD_LIMITS.weight },
                { key: 'seconds', unit: 'sec', lim: FIELD_LIMITS.seconds },
                { key: 'volume',  unit: 'ml',  lim: FIELD_LIMITS.volume },
            ];

            MAX_FIELDS.forEach(({ key, unit, lim }) => {
                const stepper = createGridStepper({
                    value: step[key] || 0,
                    lim,
                    revealOnTap: true,
                    offWhenZero: true,
                    numpad: numpadConfig(MAX_NUMPAD[key].fieldType, MAX_NUMPAD[key].title, unit, lim),
                    format: (v) => `${roundTo(v, lim.step)} ${unit}`,
                    onChange: (val) => {
                        editorState.profile.steps[index][key] = val;
                        renderReviewGraph();
                    },
                });
                stepper._setWidth('120px');
                maxCell.appendChild(stepper);
            });
        }

        // Footer: move left / delete / insert / move right.
        // gap drops from 40px to 16px — four 60px buttons plus 40px gaps would be
        // 360px in a 380px column.
        const fCell = mkCell(R.FOOTER, col, 'flex justify-center items-center gap-[16px] px-[16px] py-[8px] border-r border-[var(--border-color)]');

        fCell.appendChild(makeMoveBtn(index, -1, numSteps, renderStepCards, true));

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'pe-step-action-btn w-[60px] h-[60px] flex items-center justify-center text-[var(--mimoja-blue-v2)] hover:bg-[var(--button-grey)] rounded-[10px] cursor-pointer';
        deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>';
        deleteBtn.setAttribute('aria-label', 'Delete step');
        deleteBtn.addEventListener('click', async () => {
            if (!await confirmDeleteStep(index)) return;
            removeStepAt(index);
            renderStepCards();
        });

        const insertBtn = document.createElement('button');
        insertBtn.type = 'button';
        insertBtn.className = 'pe-step-action-btn w-[60px] h-[60px] flex items-center justify-center text-[var(--mimoja-blue)] hover:bg-[var(--button-grey)] rounded-[10px] cursor-pointer';
        insertBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>';
        insertBtn.setAttribute('aria-label', 'Insert step after');
        insertBtn.addEventListener('click', () => { insertStepAfter(index); renderStepCards(); });

        fCell.appendChild(deleteBtn);
        fCell.appendChild(insertBtn);
        fCell.appendChild(makeMoveBtn(index, +1, numSteps, renderStepCards, true));
    });

    // ── Add-step column ───────────────────────────────────────────────────────
    // Full-height so it reads as a column, and so deleting the last step leaves
    // something to click. Every other way to add a step lives in a step's own
    // footer, which means an empty profile used to be a dead end: no columns, no
    // "+", and Save rejects a profile with no steps.
    const addCell = mkCell(`1 / ${TOTAL_ROWS + 1}`, numSteps + 2, 'flex items-center justify-center');
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pe-step-action-btn w-[60px] h-[60px] flex items-center justify-center text-[var(--mimoja-blue)] hover:bg-[var(--button-grey)] rounded-[10px] cursor-pointer';
    addBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>';
    addBtn.setAttribute('aria-label', 'Insert a step');
    addBtn.title = getTranslation('Insert a step');
    // -1 when there are no steps → splice(0, 0, …), which is what we want.
    addBtn.addEventListener('click', () => { insertStepAfter(numSteps - 1); renderStepCards(); });
    addCell.appendChild(addBtn);
}

function renderSettingsTab() {
    const container = document.getElementById('editor-settings-container');
    if (!container) return;
    container.innerHTML = '';

    const profile = editorState.profile;

    // Create 3 column containers. Use flex ratios (1:1:2) so columns divide the
    // ACTUAL available row space (after padding + gaps), not the parent's full
    // width — otherwise widths sum to 100% + 160px and rightCol overflows back
    // onto middleCol, clipping the Import button on tablet. min-w-0 lets
    // children shrink below their intrinsic min-content width.
    const leftCol = document.createElement('div');
    leftCol.className = 'flex flex-col gap-[45px] min-w-0';
    leftCol.style.flex = '1 1 0';

    const middleCol = document.createElement('div');
    middleCol.className = 'flex flex-col gap-[45px] min-w-0';
    middleCol.style.flex = '1 1 0';

    const rightCol = document.createElement('div');
    rightCol.className = 'flex flex-col gap-[24px] min-w-0';
    rightCol.style.flex = '2 1 0';

    container.appendChild(leftCol);
    container.appendChild(middleCol);
    container.appendChild(rightCol);

    function addFieldTo(targetCol, labelText, element) {
        const wrapper = document.createElement('div');
        wrapper.className = 'flex flex-col gap-[12px]';
        const label = document.createElement('div');
        label.className = 'text-[24px] font-semibold text-[var(--text-primary)] break-words';
        label.textContent = labelText;
        wrapper.appendChild(label);
        wrapper.appendChild(element);
        targetCol.appendChild(wrapper);
        return wrapper;
    }

    // ── Left column: Target Weight, Tank Temperature, Beverage Type, Author ──

    // Target Weight
    addFieldTo(leftCol, getTranslation('Target Weight (g)'), createSpinner(
        profile.target_weight || 0, 0.1, 'g', (val) => { editorState.profile.target_weight = val; }, { min: 0, max: 1000 }
    ));

    // Tank Temperature
    addFieldTo(leftCol, getTranslation('Tank Temperature (\u00b0c)'), createSpinner(
        profile.tank_temperature || 0, 1, '\u00b0c', (val) => { editorState.profile.tank_temperature = val; }, { min: 0, max: 110 }
    ));

    // Limiter Tolerance — separate controls for bar (flow-pump steps) and mL/s
    // (pressure-pump steps). A flow-pump step's limiter caps pressure, so it is
    // the bar control; a pressure-pump step's caps flow, so it is the mL/s one.
    {
        // No limiter on this pump type means no tolerance: show 0, not the 0.6
        // default, which reads as a setting someone chose. The control is dead
        // too -- there is no step to write a range to, and decaid drops the
        // field entirely for a limiter-less step (unified_de1.profile.dart).
        const toleranceField = (pump, label, unit) => {
            const hasLimiter = limitedSteps(pump).length > 0;
            addFieldTo(leftCol, getTranslation(label), createSpinner(
                limiterRangeOf(pump, 0), 0.1, unit,
                // Writes reach only the steps that already have a limiter.
                // Creating one on every step of the pump type would flatten a
                // profile that deliberately limits a single step.
                (val) => limitedSteps(pump).forEach(step => { step.limiter.range = val; }),
                { min: 0, max: 5, disabled: !hasLimiter }
            ));
        };

        toleranceField('flow', 'Limiter Tolerance (bar)', 'bar');
        toleranceField('pressure', 'Limiter Tolerance (mL/s)', 'mL/s');
    }

    // Beverage Type (select)
    const select = document.createElement('select');
    select.className = 'text-[24px] text-[var(--text-primary)] bg-[var(--box-color)] border border-[var(--border-color)] rounded-[12px] px-[16px] py-[12px] outline-none focus:border-[var(--mimoja-blue)] w-full';
    ['espresso', 'manual', 'cleaning'].forEach((type) => {
        const opt = document.createElement('option');
        opt.value = type;
        opt.textContent = type.charAt(0).toUpperCase() + type.slice(1);
        if (profile.beverage_type === type) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => { editorState.profile.beverage_type = select.value; });
    addFieldTo(leftCol, getTranslation('Beverage type'), select);

    // Author (text input)
    const authorInput = document.createElement('input');
    authorInput.type = 'text';
    authorInput.value = profile.author || '';
    authorInput.className = 'text-[24px] text-[var(--text-primary)] bg-[var(--box-color)] border border-[var(--border-color)] rounded-[12px] px-[16px] py-[12px] outline-none focus:border-[var(--mimoja-blue)] w-full';
    authorInput.addEventListener('change', () => { editorState.profile.author = authorInput.value; });
    addFieldTo(leftCol, getTranslation('Author'), authorInput);

    // ── Middle column: Preinfusion ends after, After preinfusion stop the shot at ──

    // Preinfusion ends after — dropdown of step names
    {
        const steps = profile.steps || [];
        const countStart = profile.target_volume_count_start || 0;

        const preinfSelect = document.createElement('select');
        preinfSelect.className = 'text-[24px] text-[var(--text-primary)] bg-[var(--box-color)] border border-[var(--border-color)] rounded-[12px] px-[16px] py-[12px] outline-none focus:border-[var(--mimoja-blue)] w-full';

        const noneOpt = document.createElement('option');
        noneOpt.value = '0';
        noneOpt.textContent = getTranslation('None');
        if (countStart === 0) noneOpt.selected = true;
        preinfSelect.appendChild(noneOpt);

        steps.forEach((step, i) => {
            const opt = document.createElement('option');
            opt.value = String(i + 1);
            opt.textContent = step.name || `Step ${i + 1}`;
            if (countStart === i + 1) opt.selected = true;
            preinfSelect.appendChild(opt);
        });

        preinfSelect.addEventListener('change', () => {
            editorState.profile.target_volume_count_start = parseInt(preinfSelect.value, 10);
        });

        addFieldTo(middleCol, getTranslation('Preinfusion ends after'), preinfSelect);
    }

    // Target Volume (stop shot after preinfusion)
    addFieldTo(middleCol, getTranslation('After preinfusion stop the shot at'), createSpinner(
        profile.target_volume || 0, 1, 'ml', (val) => { editorState.profile.target_volume = val; }, { min: 0, max: 500 }
    ));

    // ── Middle column: Load Profile From (new profile only) ──

    const isNewProfile = editorState.sourceProfileId === null;

    function reloadEditorWithProfile(newProfile, sourceRecord) {
        // Track any server record created during a new-profile session so cancel can delete it
        if (_isNewProfileSession) {
            _hasImportedInSession = true;
            if (sourceRecord?.id && !_sessionImportedIds.includes(sourceRecord.id)) {
                _sessionImportedIds.push(sourceRecord.id);
            }
        }
        editorState.profile = deepCopy(newProfile);
        editorState.sourceProfileRecord = sourceRecord || null;
        editorState.sourceProfileId = sourceRecord?.id || null;
        _baselineProfileJson = JSON.stringify(editorState.profile);
        const titleDisplay = document.getElementById('editor-title-display');
        if (titleDisplay) titleDisplay.textContent = editorState.profile.title || 'Untitled Profile';
        renderStepCards();
        renderSettingsTab();
    }

    if (isNewProfile) {
        // Upload local file button
        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'w-full h-[56px] bg-[var(--mimoja-blue)] text-white text-[20px] font-semibold rounded-[12px] flex items-center justify-center gap-[10px] hover:opacity-90 transition-opacity';
        const uploadIcon = document.createElement('span');
        uploadIcon.innerHTML = `<svg class="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>`;
        const uploadText = document.createElement('span');
        uploadText.textContent = getTranslation('Upload Local File');
        uploadBtn.appendChild(uploadIcon);
        uploadBtn.appendChild(uploadText);
        uploadBtn.addEventListener('click', () => {
            let fileInput = document.getElementById('pe-upload-input');
            if (!fileInput) {
                fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.id = 'pe-upload-input';
                fileInput.accept = '.json,.tcl';
                fileInput.style.display = 'none';
                document.body.appendChild(fileInput);
            }
            fileInput.value = '';
            fileInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                    const text = await file.text();
                    // Legacy de1app/Visualizer profiles are Tcl, not JSON — branch on
                    // the extension first, and fall back to sniffing the content (a
                    // JSON profile always starts with '{') for a misnamed file, so
                    // this one button still handles both formats. The Tcl branch is
                    // converted to this app's JSON profile shape entirely in
                    // tcl-profile.js — nothing downstream of this point (including
                    // validateProfileStructure and reloadEditorWithProfile) ever sees Tcl.
                    const isTcl = /\.tcl$/i.test(file.name || '') || (!/\.json$/i.test(file.name || '') && isLikelyTclProfile(text));
                    const parsed = isTcl ? parseTclProfile(text) : JSON.parse(text);
                    const validation = validateProfileStructure(parsed);
                    if (!validation.isValid) throw new Error(validation.errorMessage);
                    reloadEditorWithProfile(parsed, null);
                    showToast(`${getTranslation('Import')}: ${parsed.title || 'Profile'}`, 2500, 'success');
                } catch (err) {
                    // '# Errors' is a section-header row in the translation sheet,
                    // so every cell carries a literal '# ' ("# Fehler", "# 错误").
                    // Strip it — the translated word is what we want, not the hash.
                    showToast(`${getTranslation('# Errors').replace(/^#\s*/, '')}: ${err.message}`, 4000, 'error');
                }
            };
            fileInput.click();
        });
        addFieldTo(middleCol, getTranslation('Upload Local File'), uploadBtn);

        // Import from share code
        const shareSection = document.createElement('div');
        shareSection.className = 'flex flex-col gap-[10px]';

        const shareRow = document.createElement('div');
        shareRow.className = 'flex gap-[10px]';

        const shareInput = document.createElement('input');
        shareInput.type = 'text';
        shareInput.maxLength = 4;
        shareInput.placeholder = 'ABCD';
        // min-w-0: an input's min-content width comes from its size attribute (20 chars
        // by default), and a flex item will not shrink below that. At text-[22px] with
        // tracking-[6px] those 20 characters are wider than the whole middle column, so
        // the shrink-0 Import button got pushed past the column edge and rendered on top
        // of the Notes column. size=4 matches maxLength so the intrinsic width is honest
        // even if the flex context changes later.
        shareInput.size = 4;
        shareInput.className = 'flex-1 min-w-0 h-[56px] text-[22px] font-bold text-center tracking-[6px] bg-[var(--box-color)] border-2 border-[var(--border-color)] rounded-[12px] outline-none focus:border-[var(--mimoja-blue)]';
        shareInput.addEventListener('input', () => { shareInput.value = shareInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

        const shareImportBtn = document.createElement('button');
        shareImportBtn.textContent = getTranslation('Import');
        shareImportBtn.className = 'h-[56px] px-[24px] bg-[var(--mimoja-blue)] text-white text-[20px] font-semibold rounded-[12px] hover:opacity-90 transition-opacity shrink-0';

        const shareStatus = document.createElement('p');
        shareStatus.className = 'text-[18px] text-[var(--low-contrast-white)] min-h-[24px]';

        shareImportBtn.addEventListener('click', async () => {
            const code = shareInput.value.trim();
            if (code.length !== 4) {
                shareStatus.textContent = getTranslation('Enter a 4-character code.');
                return;
            }
            shareImportBtn.disabled = true;
            // No ellipsis: the sheet carries 'Importing' (row 1813), not 'Importing…'.
            shareImportBtn.textContent = getTranslation('Importing');
            shareStatus.textContent = '';
            try {
                const vizSettings = await getPluginSettings('visualizer.reaplugin');
                // Secure settings come back as { isSet } state, never plaintext (decaid #588).
                const password = vizSettings?.Password;
                const passwordSet = password == null ? false
                    : typeof password === 'object' ? password.isSet === true
                    : !!password; // legacy cleartext from older decaid
                const isConfigured = vizSettings?.Enabled !== false && !!(vizSettings?.Username && passwordSet);
                if (!isConfigured) {
                    shareStatus.innerHTML = 'No Visualizer account found. Go to <strong>Settings → Extensions → Visualizer</strong> to log in first.';
                    return;
                }
                const result = await callPluginEndpoint('visualizer.reaplugin', 'import', { shareCode: code });
                if (!result.success) {
                    const msg = result.error || 'Import failed';
                    const isAuthError = /credential|login|auth|unauthorized|password|username/i.test(msg);
                    shareStatus.innerHTML = isAuthError
                        ? `${msg} — Go to <strong>Settings → Extensions → Visualizer</strong> to log in.`
                        : msg;
                    return;
                }
                const { init: initPM, availableProfiles } = await import('./profileManager.js');
                await initPM();
                const rec = availableProfiles[result.profileId];
                if (!rec) throw new Error('Profile not found after import');
                reloadEditorWithProfile(rec.profile, rec);
                showToast(`Imported: ${rec.profile.title}`, 2500, 'success');
            } catch (err) {
                shareStatus.textContent = err.message;
            } finally {
                shareImportBtn.disabled = false;
                shareImportBtn.textContent = getTranslation('Import');
            }
        });

        shareRow.appendChild(shareInput);
        shareRow.appendChild(shareImportBtn);
        shareSection.appendChild(shareRow);
        shareSection.appendChild(shareStatus);
        addFieldTo(middleCol, getTranslation('Import from Share Code'), shareSection);
    }

    // ── Right column: Notes (tall textarea filling column height) ──

    const notesPreview = document.createElement('div');
    notesPreview.className = 'text-[22px] text-[var(--text-primary)] bg-[var(--box-color)] border-2 border-[var(--border-color)] rounded-[12px] px-[20px] py-[16px] cursor-pointer select-none overflow-y-auto flex-1 whitespace-pre-wrap leading-[1.5] hover:border-[var(--mimoja-blue)] transition-colors';
    function updateNotesPreview() {
        const text = editorState.profile.notes || '';
        if (text) {
            notesPreview.textContent = text;
            notesPreview.style.color = '';
        } else {
            notesPreview.textContent = getTranslation('Tap to edit notes\u2026');
            notesPreview.style.color = '#959595';
        }
    }
    updateNotesPreview();
    notesPreview.addEventListener('click', () => {
        openNotesModal(editorState.profile.notes || '', (newText) => {
            editorState.profile.notes = newText;
            updateNotesPreview();
        });
    });
    const notesWrapper = addFieldTo(rightCol, getTranslation('Notes'), notesPreview);
    notesWrapper.className = 'flex flex-col gap-[12px] flex-1';
}

// ─── Review Tab ─────────────────────────────────────────────────────────────

function describeStep(step, index) {
    const PROSE_CLASS = 'text-[20px] text-[var(--text-primary)] select-none';
    const PILL_ACTIVE   = 'text-[var(--button-primary-bg)] text-[20px] font-semibold cursor-pointer select-none inline-flex underline decoration-dashed underline-offset-[3px] px-[4px] rounded-[4px]';
    const TOGGLE_CLASS  = 'text-[var(--button-primary-bg)] text-[20px] font-semibold cursor-pointer select-none underline decoration-dashed underline-offset-[3px] px-[4px]';
    // Zero-valued max fields: same pill, muted, so "not set" is legible without
    // spending a sentence on it.
    const PILL_MUTED    = 'text-[var(--low-contrast-white)] text-[20px] font-semibold cursor-pointer select-none inline-flex underline decoration-dashed underline-offset-[3px] px-[4px] rounded-[4px]';

    function makeProseSpan(text) {
        const span = document.createElement('span');
        span.className = PROSE_CLASS;
        span.textContent = text;
        return span;
    }

    function makeToggle(initialText, onClick) {
        const span = document.createElement('span');
        span.className = TOGGLE_CLASS;
        span.textContent = initialText;
        span.addEventListener('click', () => { onClick(span); });
        return span;
    }

    // An editable value inside a sentence. The dashed underline already says
    // "tappable", so a tap goes straight to the numpad (tablet) or an inline
    // input (desktop). No ± here: this is the read-it-as-prose view, and 40px
    // buttons floated around a word mid-sentence were what overlapped the
    // neighbouring lines. Fine adjustment lives in the grid, which has real
    // steppers now.
    function makeValuePill(initialValue, lim, unit, onCommit, opts = {}) {
        let value = initialValue;

        const pill = document.createElement('span');
        pill.addEventListener('mouseenter', () => { pill.style.backgroundColor = 'var(--button-grey)'; });
        pill.addEventListener('mouseleave', () => { pill.style.backgroundColor = ''; });

        function render() {
            pill.textContent = `${roundTo(value, lim.step)} ${unit}`;
            pill.className = (opts.mutedWhenZero && value === 0) ? PILL_MUTED : PILL_ACTIVE;
        }

        function commit(val) {
            value = val;
            render();
            onCommit(value);
        }

        pill.addEventListener('click', () => {
            if (shouldUseNumpad()) {
                openNumpadForField(value, {
                    fieldType: opts.fieldType || 'pe-review',
                    title: (opts.title || unit || 'VALUE').toUpperCase(),
                    unit,
                    min: lim.min, max: lim.max,
                    label: `${lim.min}–${lim.max}`,
                }, commit);
                return;
            }
            inlineEditValue(pill, value, {
                min: lim.min, max: lim.max, step: lim.step, unit,
                onCommit: commit,
            });
        });

        render();
        return pill;
    }

    function makeLine(children) {
        const span = document.createElement('span');
        // flex-wrap so longer-language sentence rows wrap to a second line instead
        // of overflowing the step cell.
        span.className = 'inline-flex flex-wrap items-center justify-center gap-[6px]';
        for (const child of children) {
            if (typeof child === 'string') {
                span.appendChild(makeProseSpan(child));
            } else {
                span.appendChild(child);
            }
        }
        return span;
    }

    const lines = [];
    const isFlow = step.pump !== 'pressure';

    // Line 1 — Temperature + sensor
    {
        let sensorValue = step.sensor || 'coffee';
        const sensorToggle = makeToggle(
            sensorValue === 'water' ? getTranslation('Mix') : getTranslation('Group'),
            (span) => {
                sensorValue = sensorValue === 'coffee' ? 'water' : 'coffee';
                span.textContent = sensorValue === 'coffee' ? getTranslation('Group') : getTranslation('Mix');
                editorState.profile.steps[index].sensor = sensorValue;
                renderReviewGraph();
            }
        );

        const tempSpinner = makeValuePill(
            step.temperature ?? 93, FIELD_LIMITS.temperature, '\u00b0C',
            (val) => { editorState.profile.steps[index].temperature = val; renderReviewGraph(); },
            { fieldType: 'pe-review-temp', title: 'TEMPERATURE' }
        );

        lines.push(makeLine([sensorToggle, getTranslation('to'), tempSpinner]));
    }

    // Line 2 — Pump mode + ramp + target
    {
        // Mode leads the line for the same reason it has a button in the grid:
        // it decides the unit, the target's bounds, and which axis the limiter
        // constrains. The summary used to show a step's most consequential
        // property as nothing but the unit on its value, with no way to change
        // it — the one control on the step page with no counterpart here.
        const modeToggle = makeToggle(
            isFlow ? getTranslation('Flow') : getTranslation('Pressure'),
            () => {
                const s = editorState.profile.steps[index];
                if (isFlow) {
                    s.pump = 'pressure';
                    if (!s.pressure) s.pressure = PUMP_SEED_PRESSURE;
                    delete s.flow;
                } else {
                    s.pump = 'flow';
                    if (!s.flow) s.flow = PUMP_SEED_FLOW;
                    delete s.pressure;
                }
                // Full tab rebuild, not just the chart: the target pill and the
                // limiter pill both closed over the old mode's unit and bounds.
                renderReviewTab();
            }
        );

        let transValue = step.transition || 'fast';
        const transToggle = makeToggle(
            transValue === 'fast' ? getTranslation('Quickly') : getTranslation('Slowly'),
            (span) => {
                transValue = transValue === 'fast' ? 'smooth' : 'fast';
                span.textContent = transValue === 'fast' ? getTranslation('Quickly') : getTranslation('Slowly');
                editorState.profile.steps[index].transition = transValue;
                renderReviewGraph();
            }
        );

        const pumpLim  = isFlow ? FIELD_LIMITS.flow : FIELD_LIMITS.pressure;
        const pumpUnit = isFlow ? 'mL/s' : 'bar';
        const pumpSpinner = makeValuePill(
            (isFlow ? step.flow : step.pressure) ?? 0, pumpLim, pumpUnit,
            (val) => {
                if (isFlow) editorState.profile.steps[index].flow = val;
                else editorState.profile.steps[index].pressure = val;
                renderReviewGraph();
            },
            isFlow
                ? { fieldType: 'pe-review-flow', title: 'FLOW' }
                : { fieldType: 'pe-review-pressure', title: 'PRESSURE' }
        );

        // 'Ramp' is dropped, as it was from the grid: its German (translation
        // CSV row 1721, 'Sanfter Übergang') means *smooth transition*, so next
        // to the transition toggle it read 'smooth transition quickly'.
        lines.push(makeLine([modeToggle, transToggle, getTranslation('to'), pumpSpinner]));
    }

    // Line 3 — Limiter. Always present, muted at 0, exactly like the Max line
    // below treats its unset limits. Rendering it only when it was already
    // non-zero meant a limiter could be edited from the summary but never
    // added — the grid at least falls back to a '+ Limit' chip.
    {
        const limValue = step.limiter?.value ?? 0;
        const limUnit  = isFlow ? 'bar' : 'mL/s';
        const limLim   = isFlow ? FIELD_LIMITS.pressureLimit : FIELD_LIMITS.flowLimit;
        const limSpinner = makeValuePill(
            limValue, limLim, limUnit,
            (val) => {
                const s = editorState.profile.steps[index];
                if (!s.limiter) s.limiter = { value: val, range: newLimiterRange(s.pump) };
                else s.limiter.value = val;
                renderReviewGraph();
            },
            { mutedWhenZero: true, fieldType: 'pe-review-limit', title: 'LIMIT' }
        );
        lines.push(makeLine([getTranslation('Limit to'), limSpinner]));
    }

    // Line 4 — Max (weight / seconds / volume)
    // All three are listed because all three are live: whichever trips first
    // ends the step. Unset ones are muted rather than hidden, so there is always
    // somewhere to tap to set them — the old version needed an expanded/
    // collapsed mode, a "+ max" placeholder, a 2s timer and a focus overlay to
    // solve that, and floated its pills over the neighbouring lines.
    {
        const MAX_FIELDS = [
            { key: 'weight',  unit: 'g',   lim: FIELD_LIMITS.weight },
            { key: 'seconds', unit: 'sec', lim: FIELD_LIMITS.seconds },
            { key: 'volume',  unit: 'ml',  lim: FIELD_LIMITS.volume },
        ];

        const parts = [getTranslation('Up to')];
        MAX_FIELDS.forEach(({ key, unit, lim }) => {
            parts.push(makeValuePill(
                step[key] ?? 0, lim, unit,
                (val) => { editorState.profile.steps[index][key] = val; renderReviewGraph(); },
                { mutedWhenZero: true, fieldType: MAX_NUMPAD[key].fieldType, title: MAX_NUMPAD[key].title }
            ));
        });

        lines.push(makeLine(parts));
    }

    // Line 4 — Exit condition. Always present, 'off' included, so an exit can
    // be added and cleared from here. It used to render only for a step that
    // already had one, and its type toggle filtered 'off' out of the cycle —
    // between them, the summary could reach an exit but never leave one.
    {
        const exitDef = readExitDef(step);
        let exitType = exitDef.type;
        let exitCond = exitDef.condition;
        let exitValue = exitDef.value;

        const exitTypeToggle = makeToggle(
            getTranslation(exitType.charAt(0).toUpperCase() + exitType.slice(1)),
            () => {
                exitType = EXIT_TYPES[(EXIT_TYPES.indexOf(exitType) + 1) % EXIT_TYPES.length];
                // Carry the value into the new type's range: pressure allows
                // 12 bar, flow only 8 mL/s. 'off' has no ceiling to clamp to.
                exitValue = clamp(exitValue, 0, EXIT_MAX_MAP[exitType] ?? exitValue);
                const s = editorState.profile.steps[index];
                if (!s.exit) s.exit = { type: exitType, condition: exitCond, value: exitValue };
                else { s.exit.type = exitType; s.exit.value = exitValue; }
                // Full tab rebuild, not just the chart. The value pill closed
                // over the old type's unit and bounds when it was built, so
                // renderReviewGraph() alone left it reading "2.0 bar" on a
                // flow exit — and still enforcing pressure's ceiling of 12.
                renderReviewTab();
            }
        );

        // 'off' has no condition and no value, so neither control is built —
        // the same way the grid's Exit cell drops both rather than disabling
        // them. EXIT_MAX_MAP/EXIT_UNIT_MAP have no 'off' entry to read either.
        if (exitType === 'off') {
            lines.push(makeLine([getTranslation('Move on if'), exitTypeToggle]));
            return lines;
        }

        const exitCondToggle = makeToggle(
            getTranslation(exitCond === 'over' ? 'is over' : 'is under'),
            (span) => {
                exitCond = exitCond === 'over' ? 'under' : 'over';
                span.textContent = getTranslation(exitCond === 'over' ? 'is over' : 'is under');
                if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: exitValue };
                else editorState.profile.steps[index].exit.condition = exitCond;
                renderReviewGraph();
            }
        );

        const exitSpinner = makeValuePill(
            exitValue,
            { min: 0, max: EXIT_MAX_MAP[exitType], step: EXIT_STEP_MAP[exitType] },
            EXIT_UNIT_MAP[exitType],
            (val) => {
                exitValue = val;
                if (!editorState.profile.steps[index].exit) editorState.profile.steps[index].exit = { type: exitType, condition: exitCond, value: val };
                else editorState.profile.steps[index].exit.value = val;
                renderReviewGraph();
            },
            { fieldType: 'pe-review-exit', title: 'EXIT' }
        );

        lines.push(makeLine([getTranslation('Move on if'), exitTypeToggle, exitCondToggle, exitSpinner]));
    }

    return lines;
}

// 'smooth' is the firmware's Interpolate frame flag (de1app binary.tcl:929):
// the setpoint ramps linearly from the previous frame's value to this frame's
// target across the *whole* frame. 'fast' jumps to the target at the frame
// boundary and holds. The old version invented a ramp of 30% of the step capped
// at 3s, and drew it by omitting the frame's opening point — which relied on the
// previous trace point to slope up from. Step 1 has no previous point, so on the
// opening step — where the ramp changes the extraction most — smooth and fast
// plotted identically.
export function pushChannel(xArr, yArr, startT, endT, prevVal, target, transition) {
    xArr.push(startT, endT);
    yArr.push(transition === 'smooth' ? prevVal : target, target);
}

function renderReviewGraph() {
    // The panel stays in the DOM when hidden, so every grid edit used to replot
    // into a zero-size container. setActiveTab(2) re-renders on entry, so
    // skipping the work while another tab is up loses nothing.
    if (editorState.activeTab !== 2) return;
    const profile = editorState.profile;
    const graphDiv = document.getElementById('review-graph');
    if (!graphDiv) return;

    const isDark = (localStorage.getItem('theme') || 'light') === 'dark';
    const stepMarkerColor = isDark ? '#7f8bbb' : '#7c7c7c';
    const tempLineColor = isDark ? '#AE6D73' : '#ff97a1';

    // Build step-target traces + step boundary markers
    const pressureX = [], pressureY = [], flowX = [], flowY = [], tempX = [], tempY = [];
    const stepShapes = [];
    let t = 0;
    let prevPressure = 0;
    let prevFlow = 0;


    for (const step of (profile.steps || [])) {
        const dur = (step.seconds && step.seconds > 0) ? step.seconds : 10;
        const startT = t;
        const endT = t + dur;
        const transition = step.transition || 'fast';

        // Step boundary vertical line (skip t=0)
        if (startT > 0) {
            stepShapes.push({
                type: 'line',
                x0: startT, x1: startT,
                y0: 0, y1: 1, yref: 'paper',
                line: { color: stepMarkerColor, width: 2, dash: 'longdash' },
            });
        }

        if (step.pump === 'pressure') {
            const target = step.pressure ?? 0;
            pushChannel(pressureX, pressureY, startT, endT, prevPressure, target, transition);
            prevPressure = target;
            flowX.push(startT, endT);
            flowY.push(0, 0);
            prevFlow = 0;
        } else {
            const target = step.flow ?? 0;
            pushChannel(flowX, flowY, startT, endT, prevFlow, target, transition);
            prevFlow = target;
            pressureX.push(startT, endT);
            pressureY.push(0, 0);
            prevPressure = 0;
        }
        const tempScaled = ((step.temperature ?? 0) / 100) * 10;
        tempX.push(startT, endT);
        tempY.push(tempScaled, tempScaled);
        t = endT;
    }

    const traces = [
        { x: pressureX, y: pressureY, name: 'Pressure', mode: 'lines', line: { color: '#17c29a' }, hoverinfo: 'name' },
        { x: flowX,     y: flowY,     name: 'Flow',     mode: 'lines', line: { color: '#0358cf' }, hoverinfo: 'name' },
        { x: tempX,     y: tempY,     name: '\u00b0C',  mode: 'lines', line: { color: tempLineColor }, hoverinfo: 'name' },
    ];

    const layout = isDark ? {
        plot_bgcolor: '#0d0e14',
        paper_bgcolor: '#0d0e14',
        font: { color: '#606579', size: 16 },
        autosize: true,
        margin: { l: 50, r: 50, t: 20, b: 40, pad: 0 },
        showlegend: false,
        shapes: stepShapes,
        xaxis: { gridcolor: '#3D4255', linecolor: '#606579', tickcolor: '#606579', fixedrange: true },
        yaxis: { gridcolor: '#3D4255', linecolor: '#606579', tickcolor: '#606579', range: [0, 10], dtick: 1, fixedrange: true },
    } : {
        plot_bgcolor: 'white',
        paper_bgcolor: 'white',
        font: { color: '#959595', size: 16 },
        autosize: true,
        margin: { l: 50, r: 50, t: 20, b: 40, pad: 0 },
        showlegend: false,
        shapes: stepShapes,
        xaxis: { gridcolor: '#E0E0E0', linecolor: '#959595', tickcolor: '#959595', fixedrange: true },
        yaxis: { gridcolor: '#E0E0E0', linecolor: '#959595', tickcolor: '#959595', range: [0, 10], dtick: 1, fixedrange: true },
    };

    void loadECharts().then(echarts => {
        if (graphDiv.isConnected && editorState.activeTab === 2) renderChart(echarts, graphDiv, traces, layout);
    });
}

function renderReviewTab() {
    // Collapse any open review spinner since DOM is being rebuilt

    const profile = editorState.profile;
    if (!profile) return;

    // ── Steps list ──────────────────────────────────────────────────────────
    const stepsList = document.getElementById('review-steps-list');
    if (stepsList) {
        stepsList.innerHTML = '';
        const steps = profile.steps || [];
        const half = Math.ceil(steps.length / 2);

        const leftCol = document.createElement('div');
        leftCol.className = 'flex flex-col gap-[20px] flex-1';
        const rightCol = document.createElement('div');
        rightCol.className = 'flex flex-col gap-[20px] flex-1';

        steps.forEach((step, i) => {
            const row = document.createElement('div');
            row.className = 'flex flex-col gap-[6px] text-[var(--text-primary)]';

            const nameRow = document.createElement('div');
            nameRow.className = 'flex items-center justify-between';

            const nameEl = document.createElement('p');
            nameEl.className = 'font-semibold text-[20px] leading-[1.3]';
            nameEl.textContent = `${i + 1}: ${step.name || 'Step'}`;

            const nameActions = document.createElement('div');
            nameActions.className = 'flex items-center gap-[4px]';

            const reviewDeleteBtn = document.createElement('button');
            reviewDeleteBtn.type = 'button';
            reviewDeleteBtn.className = 'pe-step-action-btn w-[36px] h-[36px] flex items-center justify-center text-[var(--mimoja-blue-v2)] hover:bg-[var(--button-grey)] rounded-[10px] cursor-pointer';
            reviewDeleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>';
            reviewDeleteBtn.setAttribute('aria-label', 'Delete step');
            reviewDeleteBtn.addEventListener('click', async () => {
                if (!await confirmDeleteStep(i)) return;
                removeStepAt(i);
                renderReviewTab();
            });

            const reviewInsertBtn = document.createElement('button');
            reviewInsertBtn.type = 'button';
            reviewInsertBtn.className = 'pe-step-action-btn w-[36px] h-[36px] flex items-center justify-center text-[var(--mimoja-blue)] hover:bg-[var(--button-grey)] rounded-[10px] cursor-pointer';
            reviewInsertBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>';
            reviewInsertBtn.setAttribute('aria-label', 'Insert step after');
            reviewInsertBtn.addEventListener('click', () => {
                insertStepAfter(i);
                renderReviewTab();
            });

            nameActions.appendChild(makeMoveBtn(i, -1, steps.length, renderReviewTab, false));
            nameActions.appendChild(reviewDeleteBtn);
            nameActions.appendChild(reviewInsertBtn);
            nameActions.appendChild(makeMoveBtn(i, +1, steps.length, renderReviewTab, false));
            nameRow.appendChild(nameEl);
            nameRow.appendChild(nameActions);
            row.appendChild(nameRow);

            const bulletCol = document.createElement('ul');
            bulletCol.className = 'flex flex-col gap-[6px] list-disc list-inside text-[20px]';
            for (const lineEl of describeStep(step, i)) {
                const li = document.createElement('li');
                li.appendChild(lineEl);
                bulletCol.appendChild(li);
            }
            row.appendChild(bulletCol);
            (i < half ? leftCol : rightCol).appendChild(row);
        });

        stepsList.appendChild(leftCol);
        stepsList.appendChild(rightCol);
    }

    // ── Settings list ───────────────────────────────────────────────────────
    const settingsList = document.getElementById('review-settings-list');
    if (settingsList) {
        settingsList.innerHTML = '';
        const s = (label, val) => {
            const li = document.createElement('li');
            li.innerHTML = `${label} <span class="font-semibold text-[var(--button-primary-bg)]">${val}</span>`;
            settingsList.appendChild(li);
        };
        const appendRow = (label, pillEl) => {
            const li = document.createElement('li');
            li.append(`${label} `);
            li.appendChild(pillEl);
            settingsList.appendChild(li);
        };

        if (profile.tank_temperature != null) {
            appendRow(getTranslation('Preheat water tank'), createSettingPill({
                value: profile.tank_temperature, step: 1, unit: '\u00b0C', min: 0, max: 110,
                fieldType: 'pe-tank-temp', title: 'TANK TEMPERATURE',
                onCommit: (v) => { editorState.profile.tank_temperature = v; }
            }));
        }
        if (profile.target_volume_count_start != null) {
            const steps = profile.steps || [];
            appendRow(getTranslation('Track water volume after step'), createSettingPill({
                value: profile.target_volume_count_start, step: 1, unit: '', min: 0, max: Math.max(steps.length, 1),
                fieldType: 'pe-vol-count-start', title: 'STEP NUMBER',
                format: (v) => `${Math.round(v)}`,
                onCommit: (v) => { editorState.profile.target_volume_count_start = Math.round(v); }
            }));
        }
        if (profile.target_weight != null && profile.target_weight > 0) {
            appendRow(getTranslation('Stop at weight'), createSettingPill({
                value: profile.target_weight, step: 0.1, unit: 'g', min: 0, max: 1000,
                fieldType: 'pe-target-weight', title: 'TARGET WEIGHT',
                onCommit: (v) => { editorState.profile.target_weight = v; }
            }));
        }
        if (profile.target_volume != null && profile.target_volume > 0) {
            appendRow(getTranslation('Stop at volume'), createSettingPill({
                value: profile.target_volume, step: 1, unit: 'ml', min: 0, max: 1000,
                fieldType: 'pe-target-volume', title: 'TARGET VOLUME',
                onCommit: (v) => { editorState.profile.target_volume = v; }
            }));
        }
        if (profile.beverage_type) s(getTranslation('Beverage type'), profile.beverage_type);
    }

    // ── Graph preview ───────────────────────────────────────────────────────
    renderReviewGraph();
}

// ─── Tab Management ─────────────────────────────────────────────────────────

function setActiveTab(tabIndex) {
    editorState.activeTab = tabIndex;

    // Update tab buttons
    document.querySelectorAll('.editor-tab-btn').forEach((btn) => {
        const idx = parseInt(btn.dataset.tab, 10);
        if (idx === tabIndex) {
            btn.className = 'editor-tab-btn font-bold px-[28px] h-[44px] rounded-[44px] transition-colors text-[20px] tracking-wide uppercase bg-[var(--button-primary-bg)] text-white';
        } else {
            btn.className = 'editor-tab-btn font-bold px-[28px] h-[44px] rounded-[44px] transition-colors text-[20px] tracking-wide uppercase text-[var(--button-primary-bg)] bg-transparent';
        }
    });

    // Show/hide panels
    for (let i = 0; i < TAB_COUNT; i++) {
        const panel = document.getElementById(`editor-tab-panel-${i}`);
        if (panel) {
            panel.classList.toggle('hidden', i !== tabIndex);
        }
    }

    // Re-render the tab being shown. Every control closes over its own copy of
    // the value it edits (captured at render time), so a panel left standing
    // from an earlier render shows stale numbers AND writes them back on the
    // next ± tap — silently reverting edits made in another tab.
    if (tabIndex === 0) renderStepCards();
    else if (tabIndex === 1) renderSettingsTab();
    else if (tabIndex === 2) renderReviewTab();
}

// ─── Title Editing ──────────────────────────────────────────────────────────

function initTitleEditing() {
    const display = document.getElementById('editor-title-display');
    const input = document.getElementById('editor-title-input');

    if (!display || !input) return;

    function startEditing() {
        display.classList.add('hidden');
        input.classList.remove('hidden');
        input.value = editorState.profile.title || '';
        input.focus();
        input.select();
    }

    function stopEditing() {
        const val = input.value.trim();
        if (val) {
            editorState.profile.title = val;
            display.textContent = val;
        }
        input.classList.add('hidden');
        display.classList.remove('hidden');
    }

    display.addEventListener('click', startEditing);

    input.addEventListener('blur', stopEditing);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = editorState.profile.title || ''; input.blur(); }
    });
}

// ─── Save / Cancel ──────────────────────────────────────────────────────────

// Presentation fields don't feed the execution hash — REA treats a change to
// only these as a metadata update (same id). Everything else is execution.
const PRESENTATION_FIELDS = ['title', 'author', 'notes'];
function executionChanged(orig, edited) {
    const strip = p => {
        const c = { ...p };
        PRESENTATION_FIELDS.forEach(k => delete c[k]);
        return JSON.stringify(c);
    };
    return strip(orig) !== strip(edited);
}

// Shared tail of a successful save (including the no-op "nothing changed"
// case, which reports success without writing anything): hint the selector to
// pre-select this profile, toast, and navigate back.
function finishSaveSuccess(id) {
    sessionStorage.setItem('lastEditedProfileKey', id);
    showToast(getTranslation('Saved profile'), 2000, 'success');
    setTimeout(() => { loadPage('src/profiles/profile_selector.html'); }, 1000);
}

async function saveProfile() {
    if (!editorState.profile.title?.trim()) {
        showToast(getTranslation('Invalid name'), 3000, 'error');
        return;
    }
    if (!editorState.profile.steps?.length) {
        showToast(getTranslation('Insert a step'), 3000, 'error');
        return;
    }

    try {
        const { updateProfile, uploadProfileWithParent, updateProfileVisibility } = await import('./api.js');
        const { availableProfiles, remapFavorite } = await import('./profileManager.js');

        // Overwrite-in-place is the default: editing an existing user profile and
        // keeping its title updates the same record (no "(2)" cruft on a
        // draft→test→tweak loop). Renaming via the inline title editor is the
        // explicit save-as — titleChanged below routes it to a new record.
        //
        // A brand-new profile arrives as a stub record carrying id null (see the
        // Add Profile handler in profile_selector.js), so key off the id, not the
        // record: with the stub as `src` the no-op guard below saw the untouched
        // defaults as "unchanged" and silently dropped the whole profile.
        const src = editorState.sourceProfileRecord?.id ? editorState.sourceProfileRecord : null;

        // Compare against the source put through the same normalisation the
        // editor ran on load (initializeProfileEditor). Without it every profile
        // still carrying legacy fields reads as modified the instant it opens —
        // normalizeLegacySteps strips the off-pump pressure/flow keys from the
        // editor's copy but not from the source record.
        const sourceProfile = src?.profile ? normalizeLegacySteps(deepCopy(src.profile)) : null;
        const sourceProfileJson = sourceProfile ? JSON.stringify(sourceProfile) : null;

        // No-op save guard — nothing changed, so there is nothing worth writing.
        // Two shapes of "nothing changed":
        //  - an existing profile reopened and saved untouched: there is nothing
        //    to write, but the user's intent was "keep this", so report success
        //    and leave the editor exactly as a real save would.
        //  - a brand-new profile saved straight off the Add Profile template,
        //    which has no source record, so compare to the load-time baseline.
        //    Blocking it keeps a generic "New Profile" of stock defaults out of
        //    the list; the user still has to name it or edit something, so stay
        //    on the editor — the toast names the way forward (renaming is the
        //    save-as route, titleChanged below, which does mint a record).
        // An uploaded file also has no source record and also resets the
        // baseline, but saving it verbatim is the whole point of uploading —
        // _hasImportedInSession excludes it from the template check.
        const editedJson = JSON.stringify(editorState.profile);
        if (sourceProfileJson) {
            if (sourceProfileJson === editedJson) {
                finishSaveSuccess(src.id);
                return;
            }
        } else if (!_hasImportedInSession && editedJson === _baselineProfileJson) {
            showToast(getTranslation('Pick a new name to save'), 3000, 'info');
            return;
        }

        // Title change at save = user intent to save as a brand-new profile.
        const sourceTitle = (src?.profile?.title || '').trim();
        const currentTitle = editorState.profile.title.trim();
        const titleChanged = sourceTitle && currentTitle !== sourceTitle;

        // Both sides normalised (see above), so a legacy field the editor drops
        // on load can't masquerade as an execution change and fork the profile.
        const execChanged = !src || executionChanged(sourceProfile, editorState.profile);

        // Auto-suffix title only when minting a NEW record (a save-as, a fresh
        // profile, or a default forked on execution change). An in-place PUT can
        // keep its own title, so exclude self from the collision set.
        const willCreateNew = !src || titleChanged || (src.isDefault && execChanged);
        const existingTitles = new Set(
            Object.values(availableProfiles)
                .filter(r => r.id !== src?.id)
                .map(r => r.profile?.title)
                .filter(Boolean)
        );
        let finalTitle = editorState.profile.title.trim();
        if (willCreateNew && existingTitles.has(finalTitle)) {
            let n = 2;
            while (existingTitles.has(`${finalTitle} (${n})`)) n++;
            finalTitle = `${finalTitle} (${n})`;
            editorState.profile.title = finalTitle;
            const titleDisplay = document.getElementById('editor-title-display');
            if (titleDisplay) titleDisplay.textContent = finalTitle;
        }

        // Legacy-field stripping + REA Profile-model adaptation happens at the
        // api.js write boundary (sanitizeProfileForRea), covering every path.

        // A record's id IS the hash of its execution fields — title/author/notes
        // are hashed separately and are not part of identity. So a rename with no
        // execution change cannot mint a new record: POST hits the server's
        // dedup (ProfileController.create returns the existing record untouched)
        // and the new name is silently dropped. It has to go through PUT, which
        // keeps the id and rewrites the metadata. A default can't be PUT at all
        // (the server rejects content edits on defaults), so say so instead of
        // pretending the rename stuck.
        if (titleChanged && !execChanged && src.isDefault) {
            showToast(getTranslation('Change a setting to save a copy'), 3500, 'info');
            return;
        }

        // POST /profiles is content-addressed (ProfileController.create): if the
        // execution hash we submit already matches a stored record — most often
        // the very default/profile we're forking away from, because our
        // executionChanged() diff is a raw JSON compare over a wider field set
        // than the server's hash — it silently hands back that EXISTING record
        // (its own id, its own title) instead of minting ours. The HTTP response
        // still reads as success (201 via jsonCreated) either way, so the only
        // reliable tell from here is comparing what we sent against what we got
        // back: the returned id landing on the record we're forking away from,
        // or the returned title silently not being the one we typed.
        const sentTitle = finalTitle;
        const forkDeduped = (record, avoidId) => {
            if (!record) return true;
            if (avoidId && record.id === avoidId) return true;
            return (record.profile?.title || '') !== sentTitle;
        };

        // Save routing (REA versioning model):
        //  - default + execution change → POST fork (PUT would be rejected); the
        //    default stays as the parent/reset point.
        //  - new profile, or save-as that actually changes execution → POST
        //    (parentId links the source).
        //  - otherwise → PUT in place; the server keeps the id on a
        //    presentation-only change (rename included) or rehashes it (deleting
        //    the old) on a user execution change.
        let saved;
        if (src?.isDefault && execChanged) {
            saved = await uploadProfileWithParent(editorState.profile, src.id);
            if (forkDeduped(saved, src.id)) {
                showToast(getTranslation('This change matches an existing profile — nothing new was saved'), 4000, 'info');
                return;
            }
        } else if (!src || (titleChanged && execChanged)) {
            saved = await uploadProfileWithParent(editorState.profile, src?.id ?? null);
            if (forkDeduped(saved, src?.id ?? null)) {
                showToast(getTranslation('This change matches an existing profile — nothing new was saved'), 4000, 'info');
                return;
            }
        } else if (execChanged) {
            // Overwrite of an existing user profile: keep the prior version as a
            // hidden, restorable snapshot instead of letting the server drop it on
            // rehash. The new record links back via parentId, so /lineage returns
            // the full history the Revert picker reads.
            saved = await uploadProfileWithParent(editorState.profile, src.id);
            // A dedup here would return src itself — flipping it visible then
            // straight back to hidden a few lines down and erasing the user's
            // only copy of the profile they thought they were editing. Bail
            // before either visibility call runs.
            if (forkDeduped(saved, src.id)) {
                showToast(getTranslation('This change matches an existing profile — nothing new was saved'), 4000, 'info');
                return;
            }
            if (saved.visibility !== 'visible') {
                saved = await updateProfileVisibility(saved.id, 'visible');
            }
            try { await updateProfileVisibility(src.id, 'hidden'); } catch (_) {}
        } else {
            // Presentation-only change (title/author/notes, no execution change)
            // → same id, PUT in place. Renaming a user profile lands here.
            saved = await updateProfile(src.id, editorState.profile);
        }

        const oldId = editorState.sourceProfileId;
        availableProfiles[saved.id] = saved;

        // Only an in-place user PUT replaces the old hash — follow the favorite then.
        if (oldId && oldId !== saved.id && !src?.isDefault && !titleChanged) {
            delete availableProfiles[oldId];
            await remapFavorite(oldId, saved.id);
        }

        // Rebind editor to the saved record so repeat saves update in place.
        editorState.sourceProfileRecord = saved;
        editorState.sourceProfileId = saved.id;
        _baselineProfileJson = JSON.stringify(editorState.profile);

        finishSaveSuccess(saved.id);
    } catch (err) {
        console.error('Profile save failed:', err);
        // Every failure path here is a write to Rea Prime (POST/PUT), so the
        // sheet's upload wording is the accurate one. err.message stays English.
        showToast(`${getTranslation('Upload failed!')} ${err.message}`, 4000, 'error');
    }
}

// Yes/no dialog matching promptVersionRestore's styling. Replaces window.confirm,
// which renders as a browser chrome dialog inside the host webview.
function promptConfirm({ title, message, confirmLabel, cancelLabel }) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.className = 'pe-confirm-dialog rounded-[16px] bg-[var(--box-color)] p-0 border border-[var(--border-color)] max-w-[520px] w-[90vw] shadow-2xl';
        dlg.style.marginTop = '12vh';
        dlg.style.marginBottom = 'auto';
        dlg.innerHTML = `
            <div class="flex flex-col gap-[16px] p-[24px]">
                ${title ? `<h3 class="text-[24px] font-bold text-[var(--text-primary)]">${title}</h3>` : ''}
                <p class="text-[20px] text-[var(--text-primary)]">${message}</p>
                <div class="flex flex-wrap justify-end gap-[12px] mt-[8px]">
                    <button type="button" data-act="cancel" class="px-[18px] py-[10px] rounded-[10px] bg-[var(--button-grey)] text-[var(--text-primary)] text-[20px] font-semibold cursor-pointer">${cancelLabel}</button>
                    <button type="button" data-act="ok" class="px-[18px] py-[10px] rounded-[10px] bg-[var(--mimoja-blue)] text-white text-[20px] font-semibold cursor-pointer">${confirmLabel}</button>
                </div>
            </div>`;

        function done(result) {
            try { dlg.close(); } catch (_) {}
            dlg.remove();
            resolve(result);
        }
        dlg.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
        dlg.querySelector('[data-act="ok"]').addEventListener('click', () => done(true));
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });

        document.body.appendChild(dlg);
        dlg.showModal();
    });
}

async function cancelEditor() {
    // Cancel used to warn only when a share-code import was pending, so any
    // other edit — however long the user had been working — was discarded on
    // a single tap with no confirmation.
    if (_isNewProfileSession && _hasImportedInSession) {
        // Keep this exact message — it is the one already carried in the
        // translation sheet for this prompt. The buttons are 'Delete'/'Cancel':
        // confirming really does DELETE the imported record from the server
        // (deleteProfile below), and labelling the destructive button 'Cancel'
        // would collide with the dismiss button's meaning on a dialog whose
        // question is itself about cancelling.
        const ok = await promptConfirm({
            message: getTranslation('Discard the imported profile? This cannot be undone.'),
            confirmLabel: getTranslation('Delete'),
            cancelLabel: getTranslation('Cancel'),
        });
        if (!ok) return;
    } else if (JSON.stringify(editorState.profile) !== _baselineProfileJson) {
        // 'Undo changes' and 'Cancel' are both carried by the translation sheet;
        // the four strings this replaced (Discard changes? / Your edits to this
        // profile have not been saved. / Discard / Keep editing) were none of
        // them, so the whole dialog rendered in English everywhere. The confirm
        // button restates the question verbatim so the two can't drift apart.
        const ok = await promptConfirm({
            message: `${getTranslation('Undo changes')}?`,
            confirmLabel: getTranslation('Undo changes'),
            cancelLabel: getTranslation('Cancel'),
        });
        if (!ok) return;
    }
    if (_isNewProfileSession && _sessionImportedIds.length > 0) {
        try {
            const { deleteProfile } = await import('./api.js');
            const { availableProfiles } = await import('./profileManager.js');
            for (const id of _sessionImportedIds) {
                try { await deleteProfile(id); } catch (_) {}
                delete availableProfiles[id];
            }
        } catch (_) {}
    }
    loadPage('index.html');
}


// ─── Version history / revert ────────────────────────────────────────────────

// Coerce legacy step shape onto the current Rea spec: prior versions persisted
// exit.type of 'weight'/'time'/'off' (not in spec) and stored both flow and
// pressure on every step. Applied when loading any saved profile (fresh edit or
// a restored older version) so the UI never reads undefined EXIT_UNIT_MAP entries.
function normalizeLegacySteps(profile) {
    if (Array.isArray(profile?.steps)) {
        for (const step of profile.steps) {
            if (step.pump === 'flow') delete step.pressure;
            else if (step.pump === 'pressure') delete step.flow;
            if (step.limiter && step.limiter.value === 0) step.limiter = null;
            if (step.exit && step.exit.type !== 'pressure' && step.exit.type !== 'flow') {
                step.exit = null;
            }
        }
    }
    return profile;
}

// Version picker. Returns the chosen ProfileRecord, or null on cancel.
// Picking a row selects it; Confirm applies it. A row used to restore on the
// single tap that selected it, which put an unconfirmed, unod-oable profile
// swap one stray tap away — and restoring discards unsaved edits.
function promptVersionRestore(versions) {
    return new Promise((resolve) => {
        const ROW_BASE     = 'text-left px-[16px] py-[14px] rounded-[10px] border-2 bg-[var(--box-color)] cursor-pointer';
        const ROW_IDLE     = `${ROW_BASE} border-[var(--border-color)] hover:border-[var(--mimoja-blue)]`;
        const ROW_SELECTED = `${ROW_BASE} border-[var(--mimoja-blue)]`;

        const dlg = document.createElement('dialog');
        dlg.className = 'pe-history-dialog rounded-[16px] bg-[var(--box-color)] p-0 border border-[var(--border-color)] max-w-[560px] w-[90vw] shadow-2xl';
        dlg.style.marginTop = '8vh';
        dlg.style.marginBottom = 'auto';

        dlg.innerHTML = `
            <div class="flex flex-col gap-[16px] p-[24px]">
                <h3 class="text-[24px] font-bold text-[var(--text-primary)]">${getTranslation('Version')}</h3>
                <div data-rows class="flex flex-col gap-[10px] max-h-[46vh] overflow-y-auto"></div>
                <div class="flex flex-wrap justify-end gap-[12px] mt-[8px]">
                    <button type="button" data-act="cancel" class="px-[18px] py-[10px] rounded-[10px] bg-[var(--button-grey)] text-[var(--text-primary)] text-[20px] font-semibold cursor-pointer">${getTranslation('Cancel')}</button>
                    <button type="button" data-act="ok" class="hidden px-[18px] py-[10px] rounded-[10px] bg-[var(--mimoja-blue)] text-white text-[20px] font-semibold cursor-pointer">${getTranslation('Confirm')}</button>
                </div>
            </div>`;

        const rowsHost  = dlg.querySelector('[data-rows]');
        const confirmBtn = dlg.querySelector('[data-act="ok"]');
        let selected = null;

        // Rows are built as DOM, not interpolated markup: the title is
        // user-supplied text and this dialog is rendered with innerHTML.
        const rowBtns = versions.map((v, i) => {
            const when  = new Date(v.createdAt);
            const label = isNaN(when.getTime()) ? '' : when.toLocaleString();

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = ROW_IDLE;
            btn.dataset.idx = String(i);
            btn.setAttribute('aria-pressed', 'false');

            const title = document.createElement('div');
            title.className = 'text-[20px] font-semibold text-[var(--text-primary)]';
            title.textContent = v.profile?.title || 'Untitled';

            const stamp = document.createElement('div');
            stamp.className = 'text-[16px] text-[var(--text-primary)]';
            stamp.style.opacity = '0.6';
            stamp.textContent = label;

            btn.appendChild(title);
            btn.appendChild(stamp);
            btn.addEventListener('click', () => {
                selected = v;
                rowBtns.forEach((b) => {
                    const on = b === btn;
                    b.className = on ? ROW_SELECTED : ROW_IDLE;
                    b.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
                confirmBtn.classList.remove('hidden');
            });

            rowsHost.appendChild(btn);
            return btn;
        });

        function done(result) {
            try { dlg.close(); } catch (_) {}
            dlg.remove();
            resolve(result);
        }

        dlg.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
        confirmBtn.addEventListener('click', () => done(selected));
        dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });

        document.body.appendChild(dlg);
        dlg.showModal();
    });
}

async function openVersionHistory() {
    const id = editorState.sourceProfileId;
    if (!id) return;

    let lineage;
    try {
        const { getProfileLineage } = await import('./api.js');
        lineage = await getProfileLineage(id);
    } catch (err) {
        showToast('Could not load version history', 3000, 'error');
        return;
    }

    // Prior versions = the chain minus the record we're editing, newest first.
    const versions = (lineage || [])
        .filter(r => r.id !== id && r.profile)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!versions.length) {
        showToast('No previous versions yet', 2500, 'info');
        return;
    }

    const chosen = await promptVersionRestore(versions);
    if (!chosen) return;

    // Restoring replaces the whole in-memory profile, so any unsaved edits are
    // gone the instant a version is picked — the one genuinely destructive part
    // of this flow, and it used to happen with no warning at all. (The server
    // side is safe either way: saving hides the prior version rather than
    // deleting it, and it stays restorable from this same picker.)
    if (JSON.stringify(editorState.profile) !== _baselineProfileJson) {
        const ok = await promptConfirm({
            message: `${getTranslation('Undo changes')}?`,
            confirmLabel: getTranslation('Undo changes'),
            cancelLabel: getTranslation('Cancel'),
        });
        if (!ok) return;
    }

    // Load the snapshot into the editor. Saving mints a new current version and
    // hides this restored state's predecessor — a non-destructive revert.
    editorState.profile = normalizeLegacySteps(deepCopy(chosen.profile));
    const titleDisplay = document.getElementById('editor-title-display');
    if (titleDisplay) titleDisplay.textContent = editorState.profile.title || 'Untitled Profile';
    // Baseline deliberately not reset: a restored version is unsaved work, so
    // Cancel must still warn before throwing it away.
    setActiveTab(editorState.activeTab || 0);
    showToast('Restored — Save to keep this version', 3000, 'success');
}

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initializeProfileEditor() {
    console.log('[ProfileEditor] initializeProfileEditor called');
    console.log('[ProfileEditor] window.__pendingEditProfile=', window.__pendingEditProfile);
    console.log('[ProfileEditor] typeof window.__pendingEditProfile=', typeof window.__pendingEditProfile);

    // 1. Read pending profile from window global (set by profile_selector.js)
    const profileRecord = window.__pendingEditProfile;
    if (!profileRecord) {
        console.warn('[ProfileEditor] No profile data on window.__pendingEditProfile — aborting.');
        showToast('No profile data found. Returning to selector.', 3000, 'error');
        setTimeout(() => { loadPage('src/profiles/profile_selector.html'); }, 1000);
        return;
    }
    console.log('[ProfileEditor] Got profile:', profileRecord?.profile?.title);
    window.__pendingEditProfile = null;

    // 2. Deep copy
    editorState.sourceProfileRecord = profileRecord;
    editorState.sourceProfileId = profileRecord.id;
    editorState.profile = normalizeLegacySteps(deepCopy(profileRecord.profile));
    editorState.activeTab = 0;
    _baselineProfileJson = JSON.stringify(editorState.profile);
    _isNewProfileSession = !profileRecord.id;
    _sessionImportedIds = [];
    _hasImportedInSession = false;
    // Re-arm the ± hint for each editing session, but not for the re-renders
    // within one (tab switch, step insert/delete).
    _hintSteppers = [];
    _hintsDismissed = false;
    _activeStepper = null;

    // 3. Populate title
    const titleDisplay = document.getElementById('editor-title-display');
    if (titleDisplay) titleDisplay.textContent = editorState.profile.title || 'Untitled Profile';

    // 4. Render tabs — setActiveTab renders whichever panel it shows.
    setActiveTab(0);

    // 5. Wire event listeners
    initTitleEditing();

    // Tab buttons
    document.querySelectorAll('.editor-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            setActiveTab(parseInt(btn.dataset.tab, 10));
        });
    });

    // Save / Cancel
    const saveBtn = document.getElementById('editor-save-btn');
    const cancelBtn = document.getElementById('editor-cancel-btn');
    if (saveBtn) saveBtn.addEventListener('click', saveProfile);
    if (cancelBtn) cancelBtn.addEventListener('click', cancelEditor);

    // Version history — only for an already-saved, non-default profile.
    const historyBtn = document.getElementById('editor-history-btn');
    if (historyBtn) {
        historyBtn.addEventListener('click', openVersionHistory);
        if (editorState.sourceProfileId && !editorState.sourceProfileRecord?.isDefault) {
            historyBtn.classList.remove('hidden');
            historyBtn.classList.add('flex');
        }
    }

    console.log('Profile Editor: Initialization complete.');
}
