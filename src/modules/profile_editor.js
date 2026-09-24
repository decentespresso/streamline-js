import { loadPage } from './router.js';
import { showToast, flashPlusMinusButton } from './ui.js';
import { openModal, resetNumpadModal } from './numpad-modal.js';
import { openNotesModal } from './notes-modal.js';
import { getTranslation, fitTextToWidth } from './i18n.js';
import { callPluginEndpoint, getPluginSettings } from './api.js';
import { validateProfileStructure, isActiveProfile } from './profileManager.js';
import { getProfileOverride, saveProfileOverride, removeProfileOverrideKeys,
    ensureProfileOverridesLoaded } from './profile-overrides.js';
import { applyFlowCalibrationForProfile, getFlowCalibrationBaseline, pickFlowCalibration,
    FLOW_CAL_KEYS, FLOW_CAL_DEFAULTS } from './flow-calibration.js';
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
    // Index of the one step card allowed to be expanded/editable at a time in
    // the CARDS tab; every other card renders read-only. null = all collapsed.
    editingStep: null,
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

// ─── Inline Editable Value Pill ────────────────────────────────────────────
// Reusable inline editable value span — dashed blue underline; a tap opens the
// full-screen numpad. This is the editor's one mid-sentence value control; the
// SCRIPT tab's Steps Overview builds every number in its prose from it.
// `fieldType` is the numpad's recent-values key, so passing the same one the
// CARDS tab uses (pe-temp, pe-pump, pe-lim, pe-exit, MAX_NUMPAD's) shares that
// history between the two tabs rather than splitting it per view.

function createSettingPill({ value, step, unit, min, max, fieldType, title, format, onCommit }) {
    // py + matching -my expands the tap/hover box for tablet fingers without
    // pushing wrapped script lines further apart (negative margin cancels the
    // padding's contribution to layout, only the hit area grows).
    const PILL_CLASS = 'text-[var(--button-primary-bg)] font-semibold cursor-pointer select-none inline-flex px-[4px] py-[10px] -my-[10px] rounded-[4px]';
    const fmt = format || ((v) => unit ? `${roundTo(v, step || 1)} ${unit}` : `${roundTo(v, step || 1)}`);

    const pill = document.createElement('span');
    pill.className = PILL_CLASS;
    pill.textContent = fmt(value);
    pill.addEventListener('mouseenter', () => { pill.style.backgroundColor = 'var(--button-grey)'; });
    pill.addEventListener('mouseleave', () => { pill.style.backgroundColor = ''; });

    pill.addEventListener('click', () => {
        openNumpadForField(value, {
            fieldType: fieldType || 'pe-script-value',
            title: title || (unit ? unit.toUpperCase() : 'VALUE'),
            unit: unit || '',
            min: min ?? 0,
            max: max ?? 9999,
            label: `${min ?? 0}–${max ?? 9999}`
        }, (val) => {
            value = val;
            pill.textContent = fmt(value);
            onCommit(value);
            // Every caller of createSettingPill edits an execution field —
            // keep SAVE AS NEW's enabled state current.
            updateSaveAsNewButtonState();
        });
    });

    return pill;
}

// ─── Icon Mask Helper ──────────────────────────────────────────────────────
// Renders an SVG as a CSS mask (see .pe-icon-mask in main.css) so the glyph
// follows a theme token/currentColor instead of the fixed stroke baked into
// the source file. `size` is a single px number (icons here are square).

const ICON_MINUS         = 'src/ui/Minus.svg';
const ICON_PLUS          = 'src/ui/Plus.svg';
const ICON_ARROW         = 'src/ui/Arrow.svg';
const ICON_TRASH         = 'src/ui/lucide_trash-2.svg';
const ICON_CHEVRON_LEFT  = 'src/ui/icons/chevron-left.svg';
const ICON_CHEVRON_RIGHT = 'src/ui/icons/chevron-right.svg';

function maskIcon(svgPath, size, color) {
    const el = document.createElement('span');
    el.className = 'pe-icon-mask';
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.maskImage = `url('${svgPath}')`;
    el.style.webkitMaskImage = `url('${svgPath}')`;
    el.style.backgroundColor = color;
    return el;
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

// Stepper ± button — shared by every ± control in the editor (the grid's
// createGridStepper and the settings tab's createSpinner), so there is
// exactly one ± button style in the file.
const STEPPER_BTN_CLASS = 'bg-[var(--button-grey)] rounded-[15px] w-[72px] h-[72px] flex items-center justify-center shrink-0 cursor-pointer select-none';

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
    wrapper.className = 'flex items-center gap-[15px]';

    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = STEPPER_BTN_CLASS;
    minusBtn.appendChild(maskIcon(ICON_MINUS, 37.5, 'var(--text-primary)'));
    minusBtn.setAttribute('aria-label', 'Decrease');

    const display = document.createElement('span');
    display.className = 'font-bold text-[24px] text-center w-[150px] text-[var(--text-primary)]';

    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = STEPPER_BTN_CLASS;
    plusBtn.appendChild(maskIcon(ICON_PLUS, 37.5, 'var(--text-primary)'));
    plusBtn.setAttribute('aria-label', 'Increase');

    function updateDisplay() {
        const formatted = roundTo(value, step);
        display.textContent = unit ? `${formatted} ${unit}` : `${formatted}`;
    }

    // Every createSpinner field in this editor (target weight/volume, tank
    // temperature, limiter tolerance) is a profile-wide execution field, so
    // every path that commits a value also has to keep SAVE AS NEW's enabled
    // state current — wrapped once here rather than at each of the two call
    // sites below (± via the debounce, tap-to-type via the numpad).
    function notifyChange(val) {
        onChange(val);
        updateSaveAsNewButtonState();
    }

    function debouncedOnChange() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            notifyChange(value);
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

    // Click the value to type one on the full-screen numpad. This used to need
    // two taps (first selected, second opened) with a 2s window in between —
    // the ± are always visible here, so there was never anything for the first
    // tap to disambiguate.
    display.style.cursor = 'pointer';
    display.addEventListener('click', () => {
        const commit = (val) => { value = roundTo(val, step); updateDisplay(); notifyChange(value); };
        openNumpadForField(value, {
            fieldType: 'pe-settings',
            title: (unit || 'VALUE').toUpperCase(),
            unit: unit || '',
            min: min ?? 0,
            max: max ?? 9999,
            label: `${min ?? 0}–${max ?? 9999}`
        }, commit);
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
// One control for every numeric field in an expanded step card: [−] [value] [+].
// The ± are always visible (no reveal-on-tap — cards themselves are the
// collapse/expand unit now, see editorState.editingStep). Tapping the value
// opens the full-screen numpad.
//
// `unit`, when given, renders as a second line stacked under the value (e.g.
// "7.5" over "mL/s"). Omit it and fold the unit into `format` instead for a
// field the design keeps on one line (e.g. "92°C", "15g").
function createGridStepper({ value, lim, numpad, unit = null, offWhenZero = false, format, onChange }) {
    let current = value;
    const fmt = format || ((v) => `${roundTo(v, lim.step)}`);

    const wrapper = document.createElement('div');
    wrapper.className = 'flex items-center gap-[15px]';

    const valueCol = document.createElement('div');
    valueCol.className = 'flex flex-col items-center justify-center w-[72px] cursor-pointer select-none';

    const valueLine = document.createElement('span');
    valueLine.className = 'font-bold text-[25.5px] text-center leading-tight';
    valueCol.appendChild(valueLine);

    let unitLine = null;
    if (unit) {
        unitLine = document.createElement('span');
        unitLine.className = 'font-semibold text-[19.5px] text-center leading-tight';
        unitLine.textContent = unit;
        valueCol.appendChild(unitLine);
    }

    function restyle() {
        // offWhenZero fields (the limiter, the three Max limits) read as
        // "off" via muted text rather than an outline pill — 0 is a real,
        // reachable state (a limiter/limit that isn't set), not a disabled one.
        const on = !offWhenZero || current > 0;
        const color = on ? 'var(--text-primary)' : 'var(--low-contrast-white)';
        valueLine.style.color = color;
        if (unitLine) unitLine.style.color = color;
    }

    function render() {
        valueLine.textContent = fmt(current);
        restyle();
    }

    function commit(val) {
        current = val;
        render();
        onChange(current);
        // Every createGridStepper field is an execution field (temp, pump
        // target, limiter, max, exit value) — SAVE AS NEW's enabled state has
        // to track every one of them, not just full-tab re-renders.
        updateSaveAsNewButtonState();
    }

    function mkBtn(svgPath, delta, ariaLabel) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = STEPPER_BTN_CLASS;
        btn.appendChild(maskIcon(svgPath, 37.5, 'var(--text-primary)'));
        btn.setAttribute('aria-label', ariaLabel);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            flashPlusMinusButton(btn);
            commit(roundTo(clamp(current + delta, lim.min, lim.max), lim.step));
        });
        return btn;
    }

    const minusBtn = mkBtn(ICON_MINUS, -lim.step, numpad.title + ' decrease');
    const plusBtn  = mkBtn(ICON_PLUS,   lim.step, numpad.title + ' increase');

    valueCol.addEventListener('click', (e) => {
        e.stopPropagation();
        openNumpadForField(current, numpad, commit);
    });

    render();
    wrapper.appendChild(minusBtn);
    wrapper.appendChild(valueCol);
    wrapper.appendChild(plusBtn);
    return wrapper;
}

// ─── Render Functions ───────────────────────────────────────────────────────

// ─── Cycle Chip Factory ─────────────────────────────────────────────────────
// One control for every "cycle through N states on tap" chip in an expanded
// card (temp sensor, pump mode, exit condition). `states` is an array of
// opaque backing values; `labelFor` renders the chip text for a given state.
function createCycleChip({ states, index, labelFor, onChange }) {
    let i = index;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'w-[114px] h-[72px] rounded-[15px] border-[1.5px] border-[var(--border-primary)] text-[var(--button-primary-bg)] font-bold text-[19.5px] leading-tight flex items-center justify-center text-center shrink-0 cursor-pointer select-none';
    chip.style.whiteSpace = 'normal';

    function render() { chip.textContent = labelFor(states[i], i); }
    render();

    chip.addEventListener('click', (e) => {
        e.stopPropagation();
        i = (i + 1) % states.length;
        render();
        onChange(states[i], i);
        // Every chip in this editor (sensor, pump mode, exit condition) cycles
        // an execution field — keep SAVE AS NEW's enabled state current.
        updateSaveAsNewButtonState();
    });

    return chip;
}

// ─── Pure state-cycle + paging math ────────────────────────────────────────
// Kept as small standalone functions (not closures) so they can be extracted
// and unit-tested the same way readExitDef/pushChannel are above.

// Pump-mode chip: Flow Quickly → Flow Slowly → Pressure Quickly → Pressure
// Slowly → (wrap). Composed from existing translation keys, not a new CSV row.
const PUMP_CYCLE_STATES = [
    { pump: 'flow',     transition: 'fast'   },
    { pump: 'flow',     transition: 'smooth' },
    { pump: 'pressure', transition: 'fast'   },
    { pump: 'pressure', transition: 'smooth' },
];
function pumpCycleIndex(pump, transition) {
    return (pump === 'pressure' ? 2 : 0) + (transition === 'smooth' ? 1 : 0);
}
function pumpChipLabel(state) {
    return `${getTranslation(state.pump === 'pressure' ? 'Pressure' : 'Flow')} `
         + getTranslation(state.transition === 'smooth' ? 'Slowly' : 'Quickly');
}

// "Move on if" chip: Pressure is over → Pressure is under → Flow is over →
// Flow is under → Off → (wrap). `type: null` marks the Off state, matching
// readExitDef's { type: 'off', condition: 'over', value: 0 } shape's 'off'.
const EXIT_CYCLE_STATES = [
    { type: 'pressure', condition: 'over'  },
    { type: 'pressure', condition: 'under' },
    { type: 'flow',      condition: 'over'  },
    { type: 'flow',      condition: 'under' },
    { type: 'off',       condition: null    },
];
function exitCycleIndex(type, condition) {
    if (type !== 'pressure' && type !== 'flow') return 4; // off
    return (type === 'flow' ? 2 : 0) + (condition === 'under' ? 1 : 0);
}
function exitChipLabel(state) {
    if (state.type === 'off') return getTranslation('Off');
    return `${getTranslation(state.type === 'flow' ? 'Flow' : 'Pressure')} `
         + getTranslation(state.condition === 'under' ? 'is under' : 'is over');
}

// Card paging: the row scrolls by one card "pitch" (450 card + 15 gap) per tap.
const CARD_WIDTH = 450;
const CARD_GAP = 15;
const CARD_PITCH = CARD_WIDTH + CARD_GAP;
// Skirt of page ground left visible below the card row (Figma 42 at 0.75).
const CARD_BOTTOM_GAP = 31.5;
// Width of the sticky label rail pinned over the row's left edge.
const LABEL_GUTTER = 192.75;
// The shell is a fixed-width design canvas (scaling.js scales the whole thing
// to the real viewport), so the row's own widths can be reasoned about against
// this rather than measured — which also means the tail below is decided
// correctly even when CARDS is re-rendered while hidden and clientWidth is 0.
const CANVAS_WIDTH = 1920;

// Trailing dead grid track for the card row, so the LAST card can still reach
// the "flush against the sticky gutter" snap position. Without it the row ends
// flush right: scrolling clamps at scrollWidth - clientWidth, which is not a
// snap position, so whichever card is leftmost there gets sliced by the gutter.
// The tail buys back exactly the slack that clamp was eating, and the row now
// ends in empty page ground rather than a cut card.
//
// Sized as a percentage rather than off CANVAS_WIDTH because a grid track's %
// resolves against the container's content box — the canvas less whatever
// scrollbar-gutter reserves for the vertical bar (1875, not 1920) — which is
// the same box the scroll clamp is computed from.
//
// The strict minimum is 100% - (gutter + card). It is overshot by the gutter's
// own width on purpose: at the exact minimum Chromium still stopped ~30px short
// of the last card's snap position, resting off-snap with a 15px sliver of the
// previous card showing past the gutter. The surplus is unreachable — mandatory
// snap pulls back to the last real snap position — so it costs nothing.
//
// Returns '' unless the row actually overflows (4+ cards at this canvas width):
// adding a tail to a row that already fits would invent a scrollbar, and with
// nothing to scroll past, the leftmost card was never at risk to begin with.
function cardRowTailTrack(numSteps) {
    const naturalRowWidth = LABEL_GUTTER + numSteps * CARD_WIDTH + Math.max(0, numSteps - 1) * CARD_GAP;
    return naturalRowWidth > CANVAS_WIDTH ? ` calc(100% - ${CARD_WIDTH}px)` : '';
}

// Which end-chevron is disabled for a header at `index` of `total` cards —
// shared by the header's own reorder chevrons.
function isChevronDisabled(index, dir, total) {
    const target = index + dir;
    return target < 0 || target >= total;
}

// ─── Card collapse/expand state ────────────────────────────────────────────
// Only one card is expanded at a time; collapsed cards render read-only.
// Outside-click collapses the open card — see installOutsideClickHandler.
function expandCard(index) {
    if (editorState.editingStep === index) return;
    editorState.editingStep = index;
    renderStepCards();
}

function collapseCard() {
    if (editorState.editingStep === null) return;
    editorState.editingStep = null;
    renderStepCards();
}

let _outsideClickHandler = null;
function installOutsideClickHandler() {
    removeOutsideClickHandler();
    _outsideClickHandler = (e) => {
        if (editorState.editingStep === null) return;
        const stepsContainer = document.getElementById('editor-steps-container');
        // Modals (numpad, notes, confirm dialogs) mount outside this container,
        // so a click landing there is never "outside the card" in the sense
        // that should collapse it.
        if (!stepsContainer || !stepsContainer.contains(e.target)) return;
        if (e.target.closest(`[data-card-index="${editorState.editingStep}"]`)) return;
        collapseCard();
    };
    document.addEventListener('click', _outsideClickHandler);
}

function removeOutsideClickHandler() {
    if (_outsideClickHandler) {
        document.removeEventListener('click', _outsideClickHandler);
        _outsideClickHandler = null;
    }
}

// ─── Card paging controls ───────────────────────────────────────────────────
let _pagingScrollHandler = null;

function updatePagingButtons() {
    const container = document.getElementById('editor-steps-container');
    const prevBtn = document.getElementById('editor-page-prev-btn');
    const nextBtn = document.getElementById('editor-page-next-btn');
    if (!container || !prevBtn || !nextBtn) return;
    // The last card has no scroll-snap-align (see renderStepCards), so with
    // mandatory snap the container can never actually come to rest at
    // scrollWidth - clientWidth — it snaps back to the second-to-last
    // card's start instead. That resting position is (numSteps - 2) card
    // pitches from scroll-padding-left 0, independent of LABEL_GUTTER since
    // scroll-padding-left shifts the snap target by the same amount.
    const numSteps = parseInt(container.dataset.numSteps, 10) || 0;
    const maxScrollLeft = numSteps >= 2 ? (numSteps - 2) * CARD_PITCH : 0;
    const atStart = container.scrollLeft <= 1;
    const atEnd = container.scrollLeft >= maxScrollLeft - 1;
    const prevIcon = prevBtn.querySelector('.pe-icon-mask');
    const nextIcon = nextBtn.querySelector('.pe-icon-mask');
    prevBtn.classList.toggle('pointer-events-none', atStart);
    prevBtn.setAttribute('aria-disabled', String(atStart));
    if (prevIcon) prevIcon.style.backgroundColor = atStart ? 'var(--profile-button-outline-color)' : 'var(--text-primary)';
    nextBtn.classList.toggle('pointer-events-none', atEnd);
    nextBtn.setAttribute('aria-disabled', String(atEnd));
    if (nextIcon) nextIcon.style.backgroundColor = atEnd ? 'var(--profile-button-outline-color)' : 'var(--text-primary)';
}

function removeCardPagingScrollHandler() {
    if (!_pagingScrollHandler) return;
    const container = document.getElementById('editor-steps-container');
    if (container) container.removeEventListener('scroll', _pagingScrollHandler);
    _pagingScrollHandler = null;
}

// Binds the paging buttons and the scroll listener exactly once per page
// mount. Called from initializeProfileEditor, NOT from renderStepCards: the
// prev/next buttons and the scroll container are static markup in
// profile_editor.html, so renderStepCards (which runs on every expand,
// collapse, reorder, chip cycle, insert and delete) only ever clears the
// container's *children* — calling this from there stacked a fresh click/
// scroll listener on the same three elements every single re-render.
// Idempotent: the router replaces the whole subpage HTML on every real
// navigation (fresh elements, nothing to double-bind), but this still has to
// survive being invoked twice against the same elements without stacking.
function initCardPaging() {
    const container = document.getElementById('editor-steps-container');
    const prevBtn = document.getElementById('editor-page-prev-btn');
    const nextBtn = document.getElementById('editor-page-next-btn');
    if (!container || !prevBtn || !nextBtn) return;

    if (prevBtn.dataset.pagingBound === 'true') {
        updatePagingButtons();
        return;
    }
    prevBtn.dataset.pagingBound = 'true';
    nextBtn.dataset.pagingBound = 'true';

    prevBtn.innerHTML = '';
    const prevIcon = maskIcon(ICON_ARROW, 37.5, 'var(--text-primary)');
    prevIcon.style.transform = 'rotate(180deg)';
    prevBtn.appendChild(prevIcon);

    nextBtn.innerHTML = '';
    nextBtn.appendChild(maskIcon(ICON_ARROW, 37.5, 'var(--text-primary)'));

    prevBtn.addEventListener('click', () => container.scrollBy({ left: -CARD_PITCH, behavior: 'smooth' }));
    nextBtn.addEventListener('click', () => container.scrollBy({ left: CARD_PITCH, behavior: 'smooth' }));

    removeCardPagingScrollHandler();
    _pagingScrollHandler = () => updatePagingButtons();
    container.addEventListener('scroll', _pagingScrollHandler);
    updatePagingButtons();
}

// ─── Exit-value memory ──────────────────────────────────────────────────────
// readExitDef reports a step with no exit as { type: 'off', value: 0 } — that
// 0 is a display fallback, not a real value (see the comment on readExitDef).
// Cycling the exit chip away from Off must not write it as one: a live
// { type: 'pressure', condition: 'over', value: 0 } exit fires on essentially
// any pressure at all, silently changing how the step runs. This remembers
// the last real value per pump type per step (keyed by the step object, so it
// survives a reorder — splice moves references, it never clones them — but
// naturally drops off if the step itself is deleted) so cycling Off and back
// through the same type restores what was there, and falls back to a sane
// default otherwise.
const _lastExitValue = new WeakMap(); // step -> { pressure?: number, flow?: number }

// DEFAULT_STEP.exit.value (9.0 bar) is the single source of truth for a fresh
// step's pressure exit; flow has no such default elsewhere, so 6.0 mL/s is
// chosen to match PUMP_SEED_FLOW's already-established "reasonable default
// flow" figure.
const EXIT_FALLBACK_VALUE = { pressure: DEFAULT_STEP.exit.value, flow: 6.0 };

function rememberExitValue(step, type, value) {
    if ((type !== 'pressure' && type !== 'flow') || !(value > 0)) return;
    const rec = _lastExitValue.get(step) || {};
    rec[type] = value;
    _lastExitValue.set(step, rec);
}

function recallExitValue(step, type) {
    const remembered = _lastExitValue.get(step)?.[type];
    const value = remembered > 0 ? remembered : EXIT_FALLBACK_VALUE[type];
    return clamp(value, 0, EXIT_MAX_MAP[type]);
}

// ─── Render Functions ───────────────────────────────────────────────────────

// Collapsed-card row: centered "Label  Value", read-only.
// A collapsed card mirrors the expanded one line for line — same labels, same
// order — so expanding a card changes only how a value is edited, never what
// the card says. `accent` follows the expanded row's own left slot: a label
// backed by a cycling chip reads in the action blue (Group, Flow Quickly,
// Pressure is over), a plain caption reads as body text (Limit to, Weight,
// Time, Volume). The gutter already names the row, so a line never repeats it.
function collapsedRow(labelText, valueText, { accent = true } = {}) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-center gap-[7.5px] flex-wrap px-[16px]';
    const label = document.createElement('span');
    label.className = accent
        ? 'font-bold text-[24px] text-[var(--button-primary-bg)]'
        : 'text-[24px] text-[var(--text-primary)]';
    label.textContent = labelText;
    const value = document.createElement('span');
    value.className = 'font-bold text-[25.5px] text-[var(--text-primary)]';
    value.textContent = valueText;
    row.appendChild(label);
    row.appendChild(value);
    return row;
}

// Expanded-card control line's fixed-width left slot when it has no cycling
// chip (a plain caption — "Limit to", "Weight", "Time" — rather than a
// tappable state). Same 114px width and centering as the chip so every
// stepper in the card lines up on the same column regardless of which kind
// of left slot its row uses.
function labelSlot(text) {
    const span = document.createElement('span');
    span.className = 'w-[114px] shrink-0 text-[24px] font-normal text-[var(--text-primary)] text-center leading-tight';
    span.textContent = text;
    return span;
}

// One horizontal control line: a 114px left slot (chip or label) + 30px gap
// + the stepper group. This is the one repeating structure every expanded
// row (Temp, each Pump/Maximum sub-line, Move on if) is built from — rows
// with two sub-fields (Pump, Maximum) stack two of these with a 15px gap
// between them; single-field rows (Temp, Move on if) use exactly one.
function controlLine(leftSlot, stepper) {
    const line = document.createElement('div');
    line.className = 'flex items-center justify-center gap-[30px]';
    line.appendChild(leftSlot);
    if (stepper) line.appendChild(stepper);
    return line;
}

function renderStepCards() {
    const container = document.getElementById('editor-steps-container');
    if (!container) return;
    container.innerHTML = '';

    const steps = editorState.profile.steps || [];
    const numSteps = steps.length;
    if (editorState.editingStep !== null && editorState.editingStep >= numSteps) {
        editorState.editingStep = numSteps > 0 ? numSteps - 1 : null;
    }

    const R = { HEADER: 1, TEMP: 2, PUMP: 3, MAX: 4, EXIT: 5, FOOTER: 6 };

    container.style.display = 'grid';
    // repeat() rejects a count of 0 and CSS drops the whole declaration, so a
    // zero-step profile reserves one bare track instead, for the empty-state
    // "insert a step" button below.
    const stepCols = numSteps > 0 ? ` repeat(${numSteps}, ${CARD_WIDTH}px)` : ` ${CARD_WIDTH}px`;
    const tailCol = cardRowTailTrack(numSteps);
    // Fixed 450px tracks, not 1fr: cards must not stretch to fill the row —
    // with few steps the row leaves empty space on the right ("cards snap to
    // the left"), which is the point of the horizontal scroll-snap below.
    container.style.gridTemplateColumns = `${LABEL_GUTTER}px${stepCols}${tailCol}`;
    // Header/footer stay content-sized; the four data rows are proportional
    // so they absorb the rest of the container's height — `auto` rows
    // stopped short of the bottom, leaving a bg-tertiary gap under the cards
    // instead of running the cards full height.
    // Figma's own label-gutter row heights (Temp 157, Pump 289, Move on if
    // 140) assumed a two-line Maximum row (289 too); Maximum carries a third
    // line (Volume) here, so its share is scaled up from 289 by the same
    // ratio a third 72px control line + 15px gap adds to a two-line row
    // (~1.46x) rather than reusing Pump's two-line figure verbatim.
    // Pump and Maximum share one share: Maximum carries a third line (Volume)
    // the design's two-line row didn't, and letting the two rows size apart
    // put a visible step in the hairline between neighbouring cards. Equal
    // shares keep that rule straight across the row, and 422 is the taller of
    // the two requirements (three 72px lines + two 15px gaps + padding).
    container.style.gridTemplateRows = `minmax(45px, auto) 157fr 422fr 422fr 140fr minmax(57px, auto)`;
    container.style.columnGap = `${CARD_GAP}px`;
    // Cards stop short of the content area's bottom edge: the design's card row
    // is 1138 tall in a 1600 frame starting at y=420, leaving a 42px skirt
    // (31.5 here) of --bg-tertiary below them. That skirt is padding, not a
    // shorter box: the element still runs to the bottom of the screen so its
    // horizontal scrollbar — which renders at the border box's bottom edge —
    // sits flush against it rather than floating 31.5px up.
    container.style.height = '100%';
    container.style.paddingBottom = `${CARD_BOTTOM_GAP}px`;
    // Width stays at the viewport (not max-content): the fixed-px column
    // tracks are what overflow it, and that overflow is exactly what makes
    // this scrollable — a content-sized container has scrollWidth ===
    // clientWidth, so scrollBy() and the paging buttons become no-ops.
    container.style.width = '100%';
    container.style.backgroundColor = 'var(--bg-tertiary)';
    container.style.scrollSnapType = 'x mandatory';
    // The label gutter is `position: sticky; left: 0` over the first
    // 192.75px of this container, but scroll-snap-align:start on the cards
    // snaps them to the container's own (unadjusted) left edge — landing a
    // snapped card underneath the gutter instead of flush against it.
    // scroll-padding insets the snapport by exactly the gutter's width so
    // snap positions account for the pinned overlay.
    container.style.scrollPaddingLeft = `${LABEL_GUTTER}px`;
    // Read back by updatePagingButtons to compute the true end-of-scroll
    // position — mandatory snap (below) means scrollWidth - clientWidth
    // overstates how far the container can actually rest.
    container.dataset.numSteps = String(numSteps);

    function mkCell(row, col, className) {
        const el = document.createElement('div');
        el.style.gridRow = row;
        el.style.gridColumn = col;
        el.className = className;
        container.appendChild(el);
        return el;
    }

    // ── Label gutter ────────────────────────────────────────────────────────
    const labelBase = 'flex items-center justify-end bg-[var(--bg-tertiary)] px-[22.5px]';

    function mkLabel(row, text) {
        const el = mkCell(row, 1, labelBase);
        // Fixed rail at x0 that the cards scroll underneath, per Figma — the
        // gutter's own bg-tertiary is a solid color (no alpha), so it stays
        // opaque and cards pass cleanly behind it rather than showing through.
        el.style.position = 'sticky';
        el.style.left = '0';
        el.style.zIndex = '2';
        if (text) {
            const span = document.createElement('span');
            span.className = 'w-[123px] text-right text-[24px] font-bold text-[var(--text-primary)] leading-tight';
            span.textContent = text;
            el.appendChild(span);
        }
        return el;
    }

    mkLabel(R.HEADER, '');
    mkLabel(R.TEMP,   getTranslation('Temp')).id = 'editor-row-temp';
    mkLabel(R.PUMP,   getTranslation('Pump')).id = 'editor-row-pump';
    mkLabel(R.MAX,    getTranslation('Maximum')).id = 'editor-row-max';
    mkLabel(R.EXIT,   getTranslation('Move on if')).id = 'editor-row-exit';
    mkLabel(R.FOOTER, '');

    // ── Card columns ────────────────────────────────────────────────────────
    // Each column is one white "card": rounded-[15px], 1.5px border, drawn as
    // per-row grid cells that share a background/side-border so the row reads
    // as one continuous card. The row's own border-top is the hairline between
    // fields — it bleeds the full 450px card width, past the 390px content col.
    const CARD_BG = 'bg-[var(--profile-button-background-color)]';
    const SIDE = 'border-l-[1.5px] border-r-[1.5px] border-[var(--border-graph-grid)]';
    const HAIRLINE = 'border-t-[1.5px] border-[var(--border-graph-grid)]';

    steps.forEach((step, index) => {
        const col = index + 2;
        const expanded = editorState.editingStep === index;
        const isFlow = step.pump !== 'pressure';
        // The last card has no snap target of its own: with mandatory
        // snap, a card here would rest flush against the gutter with
        // nothing after it but blank tail track — showing only that one
        // card at the end of the row. Leaving it un-snapped means the
        // furthest resting position is the second-to-last card instead,
        // which brings the last two cards into view together.
        const isLastCard = index === numSteps - 1;
        const cardAttr = (el) => { el.dataset.cardIndex = String(index); if (!isLastCard) el.style.scrollSnapAlign = 'start'; return el; };
        const onExpandClick = (el) => {
            if (!expanded) el.addEventListener('click', () => expandCard(index));
            return el;
        };

        // ── Header row ──────────────────────────────────────────────────────
        const hCell = cardAttr(mkCell(R.HEADER, col,
            `flex items-center justify-center gap-[8px] ${CARD_BG} border-t-[1.5px] border-[var(--border-graph-grid)] ${SIDE} rounded-t-[15px] px-[30px] pt-[30px] pb-[15px] overflow-hidden ${expanded ? '' : 'cursor-pointer'}`));
        onExpandClick(hCell);

        if (expanded) {
            const chevLeftDisabled = isChevronDisabled(index, -1, numSteps);
            const chevLeft = document.createElement('button');
            chevLeft.type = 'button';
            chevLeft.className = `w-[45px] h-[45px] flex items-center justify-center shrink-0 ${chevLeftDisabled ? 'pointer-events-none' : 'cursor-pointer'}`;
            chevLeft.setAttribute('aria-label', 'Move step earlier');
            chevLeft.setAttribute('aria-disabled', String(chevLeftDisabled));
            chevLeft.appendChild(maskIcon(ICON_CHEVRON_LEFT, 45, chevLeftDisabled ? 'var(--profile-button-outline-color)' : 'var(--button-primary-bg)'));
            chevLeft.addEventListener('click', (e) => {
                e.stopPropagation();
                if (moveStep(index, index - 1)) { editorState.editingStep = index - 1; renderStepCards(); }
            });

            const nameWrapper = document.createElement('div');
            nameWrapper.className = 'flex items-center gap-[6px] min-w-0 max-w-full';
            const numSpan = document.createElement('span');
            numSpan.className = 'text-[24px] font-semibold text-[var(--text-primary)] shrink-0 select-none';
            numSpan.textContent = `${index + 1}.`;
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = step.name || '';
            nameInput.className = 'text-[24px] font-bold text-[var(--button-primary-bg)] bg-transparent outline-none underline decoration-dashed min-w-0 max-w-full';
            nameInput.style.textDecorationColor = 'var(--low-contrast-white)';
            nameInput.style.textUnderlineOffset = '4px';
            nameInput.addEventListener('click', (e) => e.stopPropagation());
            nameInput.addEventListener('focus', () => { nameInput.style.textDecorationColor = 'var(--mimoja-blue)'; });
            nameInput.addEventListener('blur',  () => { nameInput.style.textDecorationColor = 'var(--low-contrast-white)'; });
            const syncSize = () => { nameInput.size = Math.max(4, nameInput.value.length + 1); };
            syncSize();
            nameInput.addEventListener('input', syncSize);
            nameInput.addEventListener('change', () => {
                editorState.profile.steps[index].name = nameInput.value;
                // A step name lives inside `steps`, which is hashed as
                // execution content (unlike the profile's own title) — no
                // other render path runs after this raw listener.
                updateSaveAsNewButtonState();
            });
            nameWrapper.appendChild(numSpan);
            nameWrapper.appendChild(nameInput);

            const chevRightDisabled = isChevronDisabled(index, 1, numSteps);
            const chevRight = document.createElement('button');
            chevRight.type = 'button';
            chevRight.className = `w-[45px] h-[45px] flex items-center justify-center shrink-0 ${chevRightDisabled ? 'pointer-events-none' : 'cursor-pointer'}`;
            chevRight.setAttribute('aria-label', 'Move step later');
            chevRight.setAttribute('aria-disabled', String(chevRightDisabled));
            chevRight.appendChild(maskIcon(ICON_CHEVRON_RIGHT, 45, chevRightDisabled ? 'var(--profile-button-outline-color)' : 'var(--button-primary-bg)'));
            chevRight.addEventListener('click', (e) => {
                e.stopPropagation();
                if (moveStep(index, index + 1)) { editorState.editingStep = index + 1; renderStepCards(); }
            });

            hCell.appendChild(chevLeft);
            hCell.appendChild(nameWrapper);
            hCell.appendChild(chevRight);
        } else {
            const label = document.createElement('span');
            label.className = 'text-[24px] font-bold text-center leading-tight';
            const numSpan = document.createElement('span');
            numSpan.className = 'text-[var(--text-primary)]';
            numSpan.textContent = `${index + 1}. `;
            const nameSpan = document.createElement('span');
            nameSpan.className = 'text-[var(--button-primary-bg)]';
            nameSpan.textContent = step.name || '';
            label.appendChild(numSpan);
            label.appendChild(nameSpan);
            hCell.appendChild(label);
        }

        // ── Temp row ────────────────────────────────────────────────────────
        // One horizontal line: the sensor chip on the left, then the ± target.
        const tCell = cardAttr(mkCell(R.TEMP, col,
            `flex items-center justify-center ${CARD_BG} ${SIDE} ${HAIRLINE} px-[30px] py-[15px] ${expanded ? '' : 'cursor-pointer'}`));
        onExpandClick(tCell);

        if (expanded) {
            const TEMP_LIM = FIELD_LIMITS.temperature;
            const tempStepper = createGridStepper({
                value: step.temperature || 93,
                lim: TEMP_LIM,
                numpad: numpadConfig('pe-temp', 'TEMPERATURE', '°C', TEMP_LIM),
                format: (v) => `${v}°C`,
                onChange: (val) => {
                    editorState.profile.steps[index].temperature = val;
                    renderScriptGraph();
                },
            });

            const sensorStates = ['coffee', 'water'];
            const sensorChip = createCycleChip({
                states: sensorStates,
                index: (step.sensor || 'coffee') === 'water' ? 1 : 0,
                labelFor: (s) => getTranslation(s === 'water' ? 'Mix' : 'Group'),
                onChange: (s) => { editorState.profile.steps[index].sensor = s; },
            });

            tCell.appendChild(controlLine(sensorChip, tempStepper));
        } else {
            tCell.appendChild(collapsedRow(
                getTranslation((step.sensor || 'coffee') === 'water' ? 'Mix' : 'Group'),
                `${step.temperature ?? 93}°C`,
            ));
        }

        // ── Pump row ────────────────────────────────────────────────────────
        const pCell = cardAttr(mkCell(R.PUMP, col,
            `flex flex-col items-center justify-center ${CARD_BG} ${SIDE} ${HAIRLINE} px-[30px] py-[15px] gap-[15px] ${expanded ? '' : 'cursor-pointer'}`));
        onExpandClick(pCell);

        if (expanded) {
            const targetUnit = isFlow ? 'mL/s' : 'bar';
            const PUMP_LIM = isFlow ? FIELD_LIMITS.flow : FIELD_LIMITS.pressure;

            const targetStepper = createGridStepper({
                value: isFlow ? (step.flow || 0) : (step.pressure || 0),
                lim: PUMP_LIM,
                unit: targetUnit,
                numpad: isFlow
                    ? numpadConfig('pe-pump', 'FLOW', 'mL/s', PUMP_LIM)
                    : numpadConfig('pe-pump', 'PRESSURE', 'bar', PUMP_LIM),
                onChange: (val) => {
                    if (isFlow) editorState.profile.steps[index].flow = val;
                    else editorState.profile.steps[index].pressure = val;
                    renderScriptGraph();
                },
            });

            // Single cycling chip replaces the old mode + transition button
            // pair: Flow Quickly → Flow Slowly → Pressure Quickly → Pressure
            // Slowly. Crossing the flow/pressure boundary keeps the existing
            // seed/delete behavior and re-renders the whole tab, because units,
            // FIELD_LIMITS bounds and the limiter axis all change with the mode.
            const modeChip = createCycleChip({
                states: PUMP_CYCLE_STATES,
                index: pumpCycleIndex(step.pump === 'pressure' ? 'pressure' : 'flow', step.transition || 'fast'),
                labelFor: pumpChipLabel,
                onChange: (state) => {
                    const s = editorState.profile.steps[index];
                    if (state.pump === 'pressure' && s.pump !== 'pressure') {
                        s.pump = 'pressure';
                        if (!s.pressure) s.pressure = PUMP_SEED_PRESSURE;
                        delete s.flow;
                    } else if (state.pump === 'flow' && s.pump === 'pressure') {
                        s.pump = 'flow';
                        if (!s.flow) s.flow = PUMP_SEED_FLOW;
                        delete s.pressure;
                    }
                    s.transition = state.transition;
                    renderStepCards(); // units, limits and the limiter axis all change with the mode
                },
            });

            const limUnit = isFlow ? 'bar' : 'mL/s';
            const LIM_LIM = isFlow ? FIELD_LIMITS.pressureLimit : FIELD_LIMITS.flowLimit;
            const limValue = step.limiter?.value ?? 0;
            const limNumpad = isFlow
                ? numpadConfig('pe-lim', 'PRESSURE LIMIT', 'bar', LIM_LIM)
                : numpadConfig('pe-lim', 'FLOW LIMIT', 'mL/s', LIM_LIM);

            const limStepper = createGridStepper({
                value: limValue,
                lim: LIM_LIM,
                unit: limUnit,
                offWhenZero: true,
                numpad: limNumpad,
                onChange: (val) => {
                    const s = editorState.profile.steps[index];
                    if (!s.limiter) s.limiter = { value: val, range: newLimiterRange(s.pump) };
                    else s.limiter.value = val;
                    renderScriptGraph();
                },
            });

            // Two horizontal lines, stacked: mode chip + target on top,
            // "Limit to" + limiter stepper below — never the other way
            // around (stacking the chip above the stepper) as before.
            pCell.appendChild(controlLine(modeChip, targetStepper));
            pCell.appendChild(controlLine(labelSlot(getTranslation('Limit to')), limStepper));
        } else {
            // Two lines, matching the expanded row: the pump mode (chip-backed,
            // so accented) with its target, then the limiter caption with its
            // value — "Off" rather than "0 bar" when nothing is limited, which
            // is what the zero actually means.
            const targetUnit = isFlow ? 'mL/s' : 'bar';
            const targetLim  = isFlow ? FIELD_LIMITS.flow : FIELD_LIMITS.pressure;
            const targetVal  = isFlow ? (step.flow || 0) : (step.pressure || 0);
            const limUnitC   = isFlow ? 'bar' : 'mL/s';
            const limLimC    = isFlow ? FIELD_LIMITS.pressureLimit : FIELD_LIMITS.flowLimit;
            const limValC    = step.limiter?.value ?? 0;

            pCell.appendChild(collapsedRow(
                pumpChipLabel({ pump: isFlow ? 'flow' : 'pressure', transition: step.transition || 'fast' }),
                `${roundTo(targetVal, targetLim.step)} ${targetUnit}`,
            ));
            pCell.appendChild(collapsedRow(
                getTranslation('Limit to'),
                limValC > 0 ? `${roundTo(limValC, limLimC.step)} ${limUnitC}` : getTranslation('Off'),
                { accent: false },
            ));
        }

        // ── Maximum row ─────────────────────────────────────────────────────
        // Three horizontal lines, stacked: Weight, Time (seconds), Volume.
        // All three are live on the machine — whichever trips first ends the
        // step — so all three stay editable from here, not just weight/time.
        const mCell = cardAttr(mkCell(R.MAX, col,
            `flex flex-col items-center justify-center ${CARD_BG} ${SIDE} ${HAIRLINE} px-[30px] py-[15px] gap-[15px] ${expanded ? '' : 'cursor-pointer'}`));
        onExpandClick(mCell);

        const MAX_FIELDS = [
            { key: 'weight',  unit: 'g',   lim: FIELD_LIMITS.weight,  label: 'Weight' },
            { key: 'seconds', unit: 'sec', lim: FIELD_LIMITS.seconds, label: 'Time' },
            { key: 'volume',  unit: 'ml',  lim: FIELD_LIMITS.volume,  label: 'Volume' },
        ];

        if (expanded) {
            MAX_FIELDS.forEach(({ key, unit, lim, label }) => {
                const stepper = createGridStepper({
                    value: step[key] || 0,
                    lim,
                    offWhenZero: true,
                    numpad: numpadConfig(MAX_NUMPAD[key].fieldType, MAX_NUMPAD[key].title, unit, lim),
                    format: (v) => `${roundTo(v, lim.step)} ${unit}`,
                    onChange: (val) => {
                        editorState.profile.steps[index][key] = val;
                        renderScriptGraph();
                    },
                });
                mCell.appendChild(controlLine(labelSlot(getTranslation(label)), stepper));
            });
        } else {
            // One line per field, same order as expanded — a comma-joined
            // digest hid which limit a number belonged to, and dropped the
            // unset ones entirely so the row's shape changed with its values.
            MAX_FIELDS.forEach(({ key, unit, lim, label }) => {
                const v = step[key] || 0;
                mCell.appendChild(collapsedRow(
                    getTranslation(label),
                    v > 0 ? `${roundTo(v, lim.step)} ${unit}` : getTranslation('Off'),
                    { accent: false },
                ));
            });
        }

        // ── Move on if row ──────────────────────────────────────────────────
        // One horizontal line: the exit-condition chip, then the ± value —
        // the value is simply absent while the chip reads Off.
        const eCell = cardAttr(mkCell(R.EXIT, col,
            `flex items-center justify-center ${CARD_BG} ${SIDE} ${HAIRLINE} px-[30px] py-[15px] ${expanded ? '' : 'cursor-pointer'}`));
        onExpandClick(eCell);

        const exitDef = readExitDef(step);

        if (expanded) {
            function writeExit(patch) {
                const s = editorState.profile.steps[index];
                if (patch.type === 'off') { s.exit = null; return; }
                if (!s.exit || s.exit.type === undefined) s.exit = { type: patch.type, condition: patch.condition, value: 0 };
                else Object.assign(s.exit, patch);
                // Remember a real edited value so a later Off-and-back on this
                // step restores it instead of reseeding a 0.
                if (patch.value !== undefined) rememberExitValue(step, patch.type, patch.value);
                renderScriptGraph();
            }

            const exitChip = createCycleChip({
                states: EXIT_CYCLE_STATES,
                index: exitCycleIndex(exitDef.type, exitDef.condition),
                labelFor: exitChipLabel,
                onChange: (state) => {
                    // Leaving a real type — remember its value before it's
                    // dropped (Off) or overwritten (switching pressure<->flow),
                    // so cycling back through it later is lossless.
                    if (exitDef.type === 'pressure' || exitDef.type === 'flow') {
                        rememberExitValue(step, exitDef.type, exitDef.value);
                    }
                    if (state.type === 'off') {
                        editorState.profile.steps[index].exit = null;
                    } else {
                        // Bounds are per-type — pressure tops out at 12 bar, flow
                        // at 8 mL/s. recallExitValue restores whatever this step
                        // last had for the new type (or a sane default) rather
                        // than carrying over 0 from readExitDef's Off fallback —
                        // a live "pressure is over 0 bar" fires on essentially
                        // any pressure at all.
                        const value = recallExitValue(step, state.type);
                        editorState.profile.steps[index].exit = { type: state.type, condition: state.condition, value };
                    }
                    renderStepCards(); // unit, bounds and the stepper's visibility change with the type
                },
            });
            let exitStepper = null;
            if (exitDef.type !== 'off') {
                const EXIT_LIM = { min: 0, max: EXIT_MAX_MAP[exitDef.type], step: EXIT_STEP_MAP[exitDef.type] };
                exitStepper = createGridStepper({
                    value: exitDef.value,
                    lim: EXIT_LIM,
                    unit: EXIT_UNIT_MAP[exitDef.type],
                    numpad: {
                        fieldType: 'pe-exit',
                        title: 'EXIT ' + exitDef.type.toUpperCase(),
                        unit: EXIT_UNIT_MAP[exitDef.type] || '',
                        min: EXIT_LIM.min, max: EXIT_LIM.max,
                        label: `${EXIT_LIM.min}–${EXIT_LIM.max}`,
                    },
                    onChange: (val) => writeExit({ type: exitDef.type, condition: exitDef.condition, value: val }),
                });
            }
            eCell.appendChild(controlLine(exitChip, exitStepper));
        } else {
            // The chip's own label, then its value — "Pressure is over 4.0 bar".
            // Off has no value to show, so the label carries the line alone.
            const exitLabel = exitChipLabel(
                exitDef.type === 'off' ? { type: 'off' } : { type: exitDef.type, condition: exitDef.condition }
            );
            eCell.appendChild(collapsedRow(
                exitLabel,
                exitDef.type === 'off'
                    ? ''
                    : `${roundTo(exitDef.value, EXIT_STEP_MAP[exitDef.type])} ${EXIT_UNIT_MAP[exitDef.type]}`,
            ));
        }

        // ── Footer row — trash / plus, on every card (collapsed or expanded) ──
        const fCell = cardAttr(mkCell(R.FOOTER, col,
            `flex items-center justify-between ${CARD_BG} ${SIDE} border-b-[1.5px] ${HAIRLINE} rounded-b-[15px] px-[30px] pt-[15px] pb-[22.5px] ${expanded ? '' : 'cursor-pointer'}`));
        onExpandClick(fCell);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'w-[67.5px] h-[67.5px] flex items-center justify-center cursor-pointer';
        deleteBtn.setAttribute('aria-label', 'Delete step');
        deleteBtn.appendChild(maskIcon(ICON_TRASH, 37.5, 'var(--button-primary-bg)'));
        deleteBtn.addEventListener('click', async (e) => {
            // stopPropagation so tapping trash on a collapsed card deletes the
            // step instead of expanding the card first.
            e.stopPropagation();
            if (!await confirmDeleteStep(index)) return;
            removeStepAt(index);
            if (editorState.editingStep === index) editorState.editingStep = null;
            renderStepCards();
        });

        const insertBtn = document.createElement('button');
        insertBtn.type = 'button';
        insertBtn.className = 'w-[67.5px] h-[67.5px] flex items-center justify-center cursor-pointer';
        insertBtn.setAttribute('aria-label', 'Insert step after');
        insertBtn.appendChild(maskIcon(ICON_PLUS, 37.5, 'var(--button-primary-bg)'));
        insertBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            insertStepAfter(index);
            editorState.editingStep = index + 1;
            renderStepCards();
        });

        fCell.appendChild(deleteBtn);
        fCell.appendChild(insertBtn);
    });

    // ── Empty state ─────────────────────────────────────────────────────────
    // A step's own footer is the only other way to add one, so a zero-step
    // profile needs its own affordance or it is a dead end (Save also rejects
    // a profile with no steps).
    if (numSteps === 0) {
        const emptyCell = mkCell('1 / 7', 2, 'flex items-center justify-center');
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'w-[72px] h-[72px] rounded-[15px] bg-[var(--button-grey)] flex items-center justify-center cursor-pointer';
        addBtn.setAttribute('aria-label', getTranslation('Insert a step'));
        addBtn.title = getTranslation('Insert a step');
        addBtn.appendChild(maskIcon(ICON_PLUS, 37.5, 'var(--text-primary)'));
        addBtn.addEventListener('click', () => {
            insertStepAfter(-1);
            editorState.editingStep = 0;
            renderStepCards();
        });
        emptyCell.appendChild(addBtn);
    }

    // Bindings live in initCardPaging (called once from initializeProfileEditor);
    // only the disabled states need recomputing here, since the step count and
    // the container's scrollWidth just changed.
    updatePagingButtons();

    // A full re-render here always follows an execution-field edit — insert,
    // delete, reorder, or a pump-mode/exit-type change that rebuilds the tab —
    // so this is also the catch-all for those, alongside the per-control
    // updates inside createGridStepper/createCycleChip.
    updateSaveAsNewButtonState();
}

// ─── Flow calibration (per profile) ─────────────────────────────────────────
// Decaid's flow multipliers are app-wide: ShotSequencer reads the global
// setting when a shot starts, so there is no per-profile field to write. These
// numbers therefore live in the profile's KV override (the same namespace as
// the dose/yield tiles) and flow-calibration.js pushes them to the machine
// whenever this profile is the active one, restoring the user's baseline for a
// profile that has none.
//
// They are deliberately NOT part of the profile JSON: /profiles is
// content-addressed, so baking a multiplier into the profile would mint a new
// profile on every tweak. That also means they cannot ride along on Save —
// a calibration-only edit changes no profile bytes and the save would dedup
// back onto the original. They are written the moment they change instead,
// exactly like the main page's tiles.
function renderFlowCalibrationFields(col) {
    const profileId = editorState.sourceProfileId;

    const wrapper = document.createElement('div');
    // pl-[15px] indent and gap-[15px] stack spacing match every other section
    // row's convention in this panel (see settingsSectionRow / Beverage Type).
    wrapper.className = 'flex flex-col gap-[15px] pl-[15px]';
    col.appendChild(wrapper);

    // Until the machine answers, `baseline` is only Decaid's default — seeding
    // the profile from it would save 1 / 0.3 as "the same as global" for a user
    // whose global is something else. Everything that reads it waits for `ready`.
    let baseline = { ...FLOW_CAL_DEFAULTS };
    let values = pickFlowCalibration(profileId ? getProfileOverride(profileId) : null);
    let enabled = FLOW_CAL_KEYS.some(key => key in values);

    async function persist() {
        if (!profileId) return;
        try {
            if (enabled) await saveProfileOverride(profileId, values);
            else await removeProfileOverrideKeys(profileId, FLOW_CAL_KEYS);
            // Only the machine's *current* profile owns the live setting.
            if (isActiveProfile(profileId)) await applyFlowCalibrationForProfile(profileId);
        } catch (error) {
            console.error('Failed to save flow calibration override:', error);
            showToast(getTranslation('Upload failed!'), 3000, 'error');
        }
    }

    function paint() {
        wrapper.innerHTML = '';

        // Header row: label beside its control, same as every other section
        // (settingsSectionRow's fixed-width side label + row.gap-[15px]) --
        // previously the label sat on its own line above the checkbox instead
        // of level with it. Spinners/hint below don't fit that single-row
        // shape, so only the toggle rides beside the label; they stay stacked
        // underneath.
        const headerRow = document.createElement('div');
        headerRow.className = 'flex items-center gap-[15px]';
        wrapper.appendChild(headerRow);

        const label = document.createElement('div');
        // Same label color/width every other section title uses (see
        // settingsSectionRow); this one was left on --text-primary instead of
        // --button-primary-bg and without the shared w-[127.5px].
        label.className = 'text-[24px] font-semibold text-[var(--button-primary-bg)] w-[127.5px] shrink-0 break-words';
        label.textContent = getTranslation('Flow calibration');
        headerRow.appendChild(label);

        const toggleRow = document.createElement('label');
        toggleRow.className = 'flex items-center gap-[15px] text-[20px] text-[var(--text-primary)]'
            + (profileId ? ' cursor-pointer' : ' opacity-40');
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'w-[26px] h-[26px] accent-[var(--mimoja-blue)]';
        toggle.checked = enabled;
        toggle.disabled = !profileId;
        toggle.addEventListener('change', async () => {
            enabled = toggle.checked;
            // Turning it on starts from the baseline, so the profile keeps
            // behaving exactly as it did until a number is actually moved.
            if (enabled) {
                await ready;
                values = { ...baseline, ...values };
            }
            paint();
            persist();
        });
        const toggleText = document.createElement('span');
        toggleText.textContent = getTranslation('Use this profile\u2019s own flow calibration');
        toggleRow.appendChild(toggle);
        toggleRow.appendChild(toggleText);
        headerRow.appendChild(toggleRow);

        if (enabled) {
            const spinnerFor = (key, text, step, unit, max) => {
                const row = document.createElement('div');
                row.className = 'flex flex-col gap-[8px]';
                const sub = document.createElement('div');
                sub.className = 'text-[20px] text-[var(--text-primary)] opacity-80';
                sub.textContent = getTranslation(text);
                row.appendChild(sub);
                row.appendChild(createSpinner(
                    values[key] ?? baseline[key], step, unit,
                    (val) => { values[key] = val; persist(); },
                    { min: 0, max }
                ));
                wrapper.appendChild(row);
            };
            spinnerFor('weightFlowMultiplier', 'Weight flow multiplier', 0.1, '', 5);
            spinnerFor('volumeFlowMultiplier', 'Volume flow multiplier (s)', 0.05, 's', 5);
        }

        const hint = document.createElement('p');
        hint.className = 'text-[18px] text-[var(--text-primary)] opacity-60 leading-[1.3]';
        hint.textContent = profileId
            ? (enabled
                ? getTranslation('Applied while this profile is loaded. Other profiles go back to the global value.')
                : `${getTranslation('Using the global value')}: ${roundTo(baseline.weightFlowMultiplier, 0.1)} / ${roundTo(baseline.volumeFlowMultiplier, 0.05)} s`)
            : getTranslation('Save this profile first to give it its own flow calibration');
        wrapper.appendChild(hint);
    }

    paint();

    // Both reads are off-machine, and the editor can be the first page of the
    // session — the saved override may not be in memory yet when this first
    // paints. Repaint with the real values once they land, unless the tab has
    // been rebuilt under us in the meantime.
    const ready = Promise.all([getFlowCalibrationBaseline(), ensureProfileOverridesLoaded()]).then(([resolved]) => {
        baseline = resolved;
        if (!wrapper.isConnected) return;
        if (!enabled) {
            values = pickFlowCalibration(profileId ? getProfileOverride(profileId) : null);
            enabled = FLOW_CAL_KEYS.some(key => key in values);
        }
        paint();
    });
}

// beverage_type enum per rest_v1.yml (Profile schema) and the Figma grid
// (node 2662-1507): espresso, filter, pourover, tea, tea_portafilter,
// calibrate, cleaning, manual.
const BEVERAGE_TYPE_TILES = [
    { value: 'espresso', label: 'Espresso' },
    { value: 'filter', label: 'Filter' },
    { value: 'pourover', label: 'Pour Over' },
    { value: 'tea', label: 'Tea' },
    { value: 'tea_portafilter', label: 'Tea Portafilter' },
    { value: 'calibrate', label: 'Calibration' },
    { value: 'cleaning', label: 'Cleaning' },
    { value: 'manual', label: 'Manual' },
];

// One bordered box inside a settings section row: a plain-text field label
// over its control. Two boxes share a hairline border edge (mr-[-1.5px]) the
// way the CARDS card footer already does, so adjoining boxes don't double
// their border weight.
function settingsFieldBox(labelText, controlEl, { last = false } = {}) {
    const box = document.createElement('div');
    // Fixed 420px (Figma 560), not flex-1: an auto-width row would size each
    // box to its own content, so the Water Settings row (which holds the wider
    // step cycler) would end further right than Limits and Stop At. Two boxes
    // at 420 less the shared hairline is 839.25 -- the same right edge as the
    // 4x210 beverage grid below them.
    box.className = `w-[420px] shrink-0 flex flex-col items-center gap-[22.5px] border border-[var(--border-primary)] px-[30px] py-[22.5px] ${last ? '' : 'mr-[-1px]'}`;
    const label = document.createElement('p');
    // leading-[1.2] is the design's own line-height on this style; without it
    // the browser default (1.5) adds ~8px to every field box, which the card
    // has no room for.
    label.className = 'text-[25.5px] leading-[1.2] text-[var(--text-primary)] whitespace-nowrap';
    label.textContent = labelText;
    box.appendChild(label);
    box.appendChild(controlEl);
    return box;
}

// One section row: a --mimoja-blue label in a fixed 127.5px gutter (matching
// the CARDS card's own label-gutter convention) beside its field boxes.
function settingsSectionRow(labelText, boxes) {
    const row = document.createElement('div');
    row.className = 'flex gap-[15px] items-center pl-[15px]';
    const label = document.createElement('p');
    label.className = 'text-[24px] font-semibold text-[var(--button-primary-bg)] w-[127.5px] shrink-0';
    label.textContent = labelText;
    row.appendChild(label);
    const boxRow = document.createElement('div');
    boxRow.className = 'flex items-stretch';
    boxes.forEach((box, i) => boxRow.appendChild(settingsFieldBox(box.label, box.control, { last: i === boxes.length - 1 })));
    row.appendChild(boxRow);
    return row;
}

// Pre-infusion ends after -- cycles through "None" + every step name with the
// same prev/next arrow chrome initCardPaging uses for CARDS' own paging
// buttons, instead of the old plain <select>. Writes target_volume_count_start,
// the same 0..steps.length integer the dropdown wrote.
function createStepCycler(steps, current, onChange) {
    let index = current;
    const wrapper = document.createElement('div');
    wrapper.className = 'flex items-center gap-[15px]';

    const label = (i) => i === 0 ? getTranslation('None') : (steps[i - 1]?.name || `${getTranslation('Step')} ${i}`);

    function makeArrowBtn(rotate) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = STEPPER_BTN_CLASS;
        const icon = maskIcon(ICON_ARROW, 37.5, 'var(--text-primary)');
        if (rotate) icon.style.transform = 'rotate(180deg)';
        btn.appendChild(icon);
        return btn;
    }

    const prevBtn = makeArrowBtn(true);
    const display = document.createElement('p');
    display.className = 'font-bold text-[24px] text-center text-[var(--text-primary)] w-[200px] whitespace-nowrap overflow-hidden text-ellipsis';
    const nextBtn = makeArrowBtn(false);

    function update() {
        display.textContent = label(index);
        const atStart = index === 0;
        const atEnd = index === steps.length;
        prevBtn.classList.toggle('opacity-40', atStart);
        prevBtn.classList.toggle('pointer-events-none', atStart);
        nextBtn.classList.toggle('opacity-40', atEnd);
        nextBtn.classList.toggle('pointer-events-none', atEnd);
    }

    prevBtn.addEventListener('click', () => { index = Math.max(0, index - 1); update(); onChange(index); });
    nextBtn.addEventListener('click', () => { index = Math.min(steps.length, index + 1); update(); onChange(index); });
    update();

    wrapper.appendChild(prevBtn);
    wrapper.appendChild(display);
    wrapper.appendChild(nextBtn);
    return wrapper;
}

// ── Custom scrollbars (see main.css's #editor-settings-form-card comment) —
// native ::-webkit-scrollbar-thumb height does not override Chromium's
// proportional thumb length in this browser, and none of these three panes
// (settings form card, description, script steps) reliably overflow enough
// for proportional sizing to ever look like the Figma's short pill. Each
// hides its native scrollbar and gets a hand-drawn pill instead: same fixed
// 119.25px height the design uses throughout, hidden entirely when its pane
// doesn't overflow. initScrollThumb wires the (idempotent) scroll listener
// once per container; updateScrollThumb does the actual size/position math
// and must be re-run after any render that could change scrollHeight. ──
const SCROLL_THUMB_HEIGHT = 119.25;
function updateScrollThumb(containerId, thumbId) {
    const container = document.getElementById(containerId);
    const thumb = document.getElementById(thumbId);
    if (!container || !thumb) return;
    const maxScroll = container.scrollHeight - container.clientHeight;
    if (maxScroll <= 0) {
        thumb.classList.add('hidden');
        return;
    }
    thumb.classList.remove('hidden');
    const pillHeight = Math.min(SCROLL_THUMB_HEIGHT, container.clientHeight);
    const travel = container.clientHeight - pillHeight;
    const top = travel > 0 ? (container.scrollTop / maxScroll) * travel : 0;
    thumb.style.height = `${pillHeight}px`;
    thumb.style.top = `${top}px`;
}
function initScrollThumb(containerId, thumbId) {
    const container = document.getElementById(containerId);
    // dataset flag, not a module-level Set: cloneNode-and-replace elsewhere in
    // this file would otherwise carry a stale flag on a since-detached node.
    if (!container || container.dataset.scrollThumbInit) return;
    container.dataset.scrollThumbInit = '1';
    container.addEventListener('scroll', () => updateScrollThumb(containerId, thumbId));
}

function renderSettingsTab() {
    const formCard = document.getElementById('editor-settings-form-card');
    const notesCol = document.getElementById('editor-settings-notes-col');
    if (!formCard || !notesCol) return;
    formCard.innerHTML = '';
    notesCol.innerHTML = '';
    // Attach once: these containers are never recreated (only their innerHTML
    // is cleared above), just re-rendered every time this function runs.
    initScrollThumb('editor-settings-form-card', 'editor-settings-form-card-thumb');
    initScrollThumb('editor-settings-notes-col', 'editor-settings-notes-col-thumb');

    const profile = editorState.profile;

    // Figma node 2662-1507 (2560px canvas at 0.75, the same convention CARDS
    // and SCRIPT were built on).
    // The Figma frame is over-stuffed: its own sections plus padding come to
    // ~897px inside an 853.5px card, so it cannot be reproduced as drawn and
    // still show everything. Two figures absorb that. pb is 45 rather than the
    // drawn 75, and the section gap is 34 rather than 45. Everything inside a
    // field box stays exactly on spec — the compression is all in the space
    // between sections, where it reads as tighter rhythm rather than as
    // shrunken controls.
    const form = document.createElement('div');
    form.className = 'flex flex-col gap-[34px] pl-[22.5px] pr-[30px] pt-[45px] pb-[45px]';
    formCard.appendChild(form);

    function appendBoltedField(labelText, element) {
        const wrapper = document.createElement('div');
        wrapper.className = 'flex flex-col gap-[12px] pl-[15px]';
        const label = document.createElement('div');
        label.className = 'text-[24px] font-semibold text-[var(--button-primary-bg)]';
        label.textContent = labelText;
        wrapper.appendChild(label);
        wrapper.appendChild(element);
        form.appendChild(wrapper);
        return wrapper;
    }

    // ── Water Settings: Preheat Water Tank, Pre-infusion ends at ──

    form.appendChild(settingsSectionRow(getTranslation('Water Settings'), [
        { label: getTranslation('Preheat Water Tank'), control: createSpinner(
            profile.tank_temperature || 0, 1, '°c', (val) => { editorState.profile.tank_temperature = val; }, { min: 0, max: 110 }
        ) },
        { label: getTranslation('Pre-infusion ends at'), control: createStepCycler(
            profile.steps || [], profile.target_volume_count_start || 0,
            (val) => { editorState.profile.target_volume_count_start = val; updateSaveAsNewButtonState(); }
        ) },
    ]));

    // ── Limits: Flow Range (pressure-pump steps' mL/s limiter), Pressure
    // Range (flow-pump steps' bar limiter) -- labeled by what they measure,
    // not by the pump type that owns them. Same underlying fields the old
    // "Limiter Tolerance" spinners wrote. ──
    {
        // No limiter on this pump type means no range to show: 0, not the 0.6
        // default, which would read as a setting someone chose. The control is
        // dead too -- there is no step to write a range to, and decaid drops
        // the field entirely for a limiter-less step (unified_de1.profile.dart).
        const rangeControl = (pump, unit) => {
            const hasLimiter = limitedSteps(pump).length > 0;
            return createSpinner(
                limiterRangeOf(pump, 0), 0.1, unit,
                // Writes reach only the steps that already have a limiter.
                // Creating one on every step of the pump type would flatten a
                // profile that deliberately limits a single step.
                (val) => limitedSteps(pump).forEach(step => { step.limiter.range = val; }),
                { min: 0, max: 5, disabled: !hasLimiter }
            );
        };

        form.appendChild(settingsSectionRow(getTranslation('Limits'), [
            { label: getTranslation('Flow Range'), control: rangeControl('pressure', 'mL/s') },
            { label: getTranslation('Pressure Range'), control: rangeControl('flow', 'bar') },
        ]));
    }

    // ── Stop At: Weight, Volume ──

    form.appendChild(settingsSectionRow(getTranslation('Stop At'), [
        { label: getTranslation('Weight'), control: createSpinner(
            profile.target_weight || 0, 0.1, 'g', (val) => { editorState.profile.target_weight = val; }, { min: 0, max: 1000 }
        ) },
        { label: getTranslation('Volume'), control: createSpinner(
            profile.target_volume || 0, 1, 'ml', (val) => { editorState.profile.target_volume = val; }, { min: 0, max: 500 }
        ) },
    ]));

    // ── Beverage Type: 2x4 tile grid ──
    {
        const section = document.createElement('div');
        section.className = 'flex gap-[15px] items-center pl-[15px]';

        const label = document.createElement('p');
        label.className = 'text-[24px] font-semibold text-[var(--button-primary-bg)] w-[127.5px] shrink-0';
        label.textContent = getTranslation('Beverage Type');
        section.appendChild(label);

        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-4';
        BEVERAGE_TYPE_TILES.forEach((tile, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            const active = profile.beverage_type === tile.value;
            // Pull only the edges that meet another tile, so the grid's own
            // outer edge keeps its full hairline instead of losing 1px off the
            // last column and row. The selected tile borders in its own fill
            // rather than dropping the border outright -- the design draws no
            // outline on it, and a width change here would reflow the row.
            const lastCol = i % 4 === 3;
            const lastRow = i >= 4;
            btn.className = `h-[72px] w-[210px] flex items-center justify-center text-center font-bold text-[24px] border ${lastCol ? '' : 'mr-[-1px]'} ${lastRow ? '' : 'mb-[-1px]'} ${
                active ? 'bg-[var(--button-primary-bg)] border-[var(--button-primary-bg)] text-white' : 'bg-[var(--box-color)] border-[var(--border-primary)] text-[var(--tab-text-inactive)]'
            }`;
            btn.textContent = getTranslation(tile.label);
            btn.setAttribute('aria-pressed', String(active));
            btn.addEventListener('click', () => {
                editorState.profile.beverage_type = tile.value;
                updateSaveAsNewButtonState(); // execution field — no other render path runs after this raw listener
                renderSettingsTab();
            });
            grid.appendChild(btn);
        });
        section.appendChild(grid);
        form.appendChild(section);
    }

    // ── Flow calibration ──
    // (target_volume itself now lives in the Stop At row above -- the
    // redesigned "Volume" field is the same target_volume this used to write
    // under "After preinfusion stop the shot at".)
    renderFlowCalibrationFields(form);

    // ── Load Profile From (new profile only), bolted on below the
    // redesigned fields -- the Figma frame only covers editing an existing
    // profile, so there's no spec yet for where this belongs. ──

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
        editorState.editingStep = null;
        _baselineProfileJson = JSON.stringify(editorState.profile);
        const titleDisplay = document.getElementById('editor-title-display');
        if (titleDisplay) titleDisplay.textContent = editorState.profile.title || 'Untitled Profile';
        updateSaveAsNewButtonState();
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
        appendBoltedField(getTranslation('Upload Local File'), uploadBtn);

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
                const { init: initPM, resolveImportedProfile } = await import('./profileManager.js');
                await initPM();
                const rec = await resolveImportedProfile(result.profileId);
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
        appendBoltedField(getTranslation('Import from Share Code'), shareSection);
    }

    // ── Description (right card, node 2662:1633's Description panel) ──
    // Same tap-to-edit-in-a-modal preview the old right column used, just
    // rendered into the redesign's own scrollable card instead of a labeled
    // column -- the HTML shell already draws the "Description" heading, help
    // icon and divider above #editor-settings-notes-col.

    const notesPreview = document.createElement('div');
    // No h-full: that forced this block to fill the whole card even for a
    // one-line description, pushing Author out of view below the fold on
    // anything short. Sized to its own text, Author now sits right after it.
    notesPreview.className = 'text-[24px] text-[var(--text-primary)] cursor-pointer select-none whitespace-pre-wrap leading-[1.5]';
    function updateNotesPreview() {
        const text = editorState.profile.notes || '';
        if (text) {
            notesPreview.textContent = text;
            notesPreview.style.color = '';
        } else {
            notesPreview.textContent = getTranslation('Tap to edit notes…');
            notesPreview.style.color = 'var(--low-contrast-white)';
        }
    }
    updateNotesPreview();
    notesPreview.addEventListener('click', () => {
        openNotesModal(editorState.profile.notes || '', (newText) => {
            editorState.profile.notes = newText;
            updateNotesPreview();
        });
    });
    notesCol.appendChild(notesPreview);

    // ── Author (bottom of Description card) — mt-auto pins it to the bottom
    // of notesCol (now a flex column) regardless of how short the description
    // is, instead of just trailing whatever whitespace was left after it.
    // "Author: xxx" sits on one row like the label + control convention used
    // elsewhere in this panel, not stacked. Metadata field like title/notes:
    // never part of the content hash (currentExecChanged's comment above), so
    // no updateSaveAsNewButtonState.
    const authorSection = document.createElement('div');
    authorSection.className = 'flex items-center gap-[15px] mt-auto pt-[36px] border-t-[1.5px] border-[var(--border-graph-grid)] shrink-0';

    const authorLabel = document.createElement('div');
    authorLabel.className = 'text-[24px] font-semibold text-[var(--button-primary-bg)] shrink-0';
    authorLabel.textContent = getTranslation('Author');
    authorSection.appendChild(authorLabel);

    const authorInput = document.createElement('input');
    authorInput.type = 'text';
    authorInput.value = editorState.profile.author || '';
    authorInput.className = 'text-[24px] text-[var(--text-primary)] bg-[var(--box-color)] border-2 border-[var(--border-color)] rounded-[12px] px-[16px] py-[12px] outline-none focus:border-[var(--mimoja-blue)] flex-1 min-w-0';
    authorInput.addEventListener('change', () => { editorState.profile.author = authorInput.value; });
    authorSection.appendChild(authorInput);

    notesCol.appendChild(authorSection);

    // Content height just changed (possibly for the first time this tab has
    // ever been shown), so each thumb's visibility/size/position needs a
    // fresh read of the now-final scrollHeight rather than whatever it was
    // left at from a previous render.
    updateScrollThumb('editor-settings-form-card', 'editor-settings-form-card-thumb');
    updateScrollThumb('editor-settings-notes-col', 'editor-settings-notes-col-thumb');
}

// ─── Script Tab ─────────────────────────────────────────────────────────────
// Figma node 2662-803 (2560px canvas, so every dimension below is the design
// value at 0.75 — the same convention the CARDS tab was built on). The profile
// read back as prose: the left half is a "Steps Overview" script, one bulleted
// sentence per thing a step does, and the right half is the graph preview the
// old Review tab already drew.
//
// Two things the review tab had are gone, because the design does not show
// them. Its third block — a second list of profile-wide settings under the
// graph — duplicated fields SETTINGS (tab 1) already owns, and the design's
// right half is the graph alone. Its per-step insert/delete/reorder buttons
// are gone too: the redesign gave every CARDS card a footer carrying exactly
// those three controls, and the design draws no step controls on this screen.
//
// Values and state words stay tappable, as they were in the review tab and as
// the design's accent-blue highlights imply.

// ─── Pure script-line composition ──────────────────────────────────────────
// Which sentences a step produces, in what order, and with which verb — kept
// off the DOM as standalone functions so test/profile-editor.test.mjs can
// extract and run them the same way it does readExitDef and pushChannel.

// Ordered as the CARDS "Maximum" row lists them, so the two tabs never
// disagree about a step's three ceilings.
const SCRIPT_MAX_FIELDS = [
    { key: 'weight',  unit: 'g'   },
    { key: 'seconds', unit: 'sec' },
    { key: 'volume',  unit: 'ml'  },
];

// "Set ... to 93.0 °C" on the opening step, then "Maintain ... at", "Increase
// ... to" or "Decrease ... to" relative to the step before it — per the Figma,
// where step 1 reads "Set", step 2 (same target) "Maintain", and step 3 (lower
// target) "Decrease". The stored value is an absolute setpoint either way; the
// verb only describes how it relates to what came before.
function temperatureVerb(prevTemp, temp) {
    if (typeof prevTemp !== 'number') return 'Set';
    if (temp > prevTemp) return 'Increase';
    if (temp < prevTemp) return 'Decrease';
    return 'Maintain';
}

function buildStepScript(step, index, profile, prevStep) {
    const lines = [];
    const isFlow = step.pump !== 'pressure';

    // profile.target_volume_count_start is "preinfusion ends after step N",
    // 1-based with 0 meaning none — so volume tracking starts on the step
    // AFTER it, at 0-based index N. The > 0 guard matters: `|| 0` turns "none"
    // into 0, which would otherwise put the marker on step 1.
    const countStart = profile.target_volume_count_start || 0;
    if (countStart > 0 && countStart === index) lines.push({ kind: 'volumeStart' });

    lines.push({
        kind: 'temperature',
        verb: temperatureVerb(
            typeof prevStep?.temperature === 'number' ? prevStep.temperature : null,
            step.temperature ?? 93,
        ),
    });

    lines.push({ kind: 'pump', isFlow });

    // Unlike the CARDS rows, an unset field is left out rather than shown
    // muted: this half is prose, and "Limit to 0.0 bar" or "For a maximum of
    // 0.0 g" asserts something the step does not do. Nothing becomes
    // unreachable — CARDS keeps a permanent row for each of them, which is
    // where one gets added.
    if ((step.limiter?.value ?? 0) > 0) lines.push({ kind: 'limit', isFlow });

    const maxKeys = SCRIPT_MAX_FIELDS.filter((f) => (step[f.key] ?? 0) > 0).map((f) => f.key);
    if (maxKeys.length > 0) lines.push({ kind: 'maximum', keys: maxKeys });

    if (readExitDef(step).type !== 'off') lines.push({ kind: 'exit' });

    return lines;
}

// Every number in the script reads to one decimal — "93.0 °C", "2.0 sec",
// "100.0 ml" — per the Figma. roundTo() collapses a whole number back to "93",
// so these pills format with toFixed(1) instead of createSettingPill's default.
function scriptValueFormat(unit) {
    return (v) => {
        const n = Number(v).toFixed(1);
        return unit ? `${n} ${unit}` : n;
    };
}

// ─── End pure script-line composition ──────────────────────────────────────

// An inline cycling word — the prose counterpart of the CARDS tab's boxed
// createCycleChip. Same `states`/`labelFor` contract and the same "every chip
// cycles an execution field, so refresh SAVE AS NEW" bookkeeping; only the
// presentation differs, since a 114×72 box cannot sit mid-sentence.
function createScriptChip({ states, index, labelFor, onChange }) {
    let i = index;
    // A real <button>, like createCycleChip — it costs nothing inline (Tailwind
    // preflight strips the native chrome and inherits the font) and carries
    // keyboard activation and the button role for free.
    const chip = document.createElement('button');
    chip.type = 'button';
    // Same py/-my hit-area expansion as createSettingPill's PILL_CLASS.
    chip.className = 'text-[var(--button-primary-bg)] font-semibold cursor-pointer select-none px-[4px] py-[10px] -my-[10px] rounded-[4px]';

    function render() { chip.textContent = labelFor(states[i], i); }
    render();

    chip.addEventListener('click', () => {
        i = (i + 1) % states.length;
        render();
        onChange(states[i], i);
        updateSaveAsNewButtonState();
    });
    chip.addEventListener('mouseenter', () => { chip.style.backgroundColor = 'var(--button-grey)'; });
    chip.addEventListener('mouseleave', () => { chip.style.backgroundColor = ''; });

    return chip;
}

// One bullet. Children are plain strings (prose) or elements (chips, pills);
// the inline-flex wrap keeps a long sentence inside the 756px text column
// instead of overflowing it, which matters most in the longer languages.
function scriptBullet(children) {
    const li = document.createElement('li');
    li.className = 'leading-[1.2] text-[24px] text-[var(--text-primary)]';
    const line = document.createElement('span');
    line.className = 'inline-flex flex-wrap items-baseline gap-[6px]';
    for (const child of children) {
        if (child == null || child === '') continue;
        if (typeof child === 'string') {
            const span = document.createElement('span');
            span.className = 'select-none';
            span.textContent = child;
            line.appendChild(span);
        } else {
            line.appendChild(child);
        }
    }
    li.appendChild(line);
    return li;
}

// Turns one buildStepScript descriptor into its bullet. Every editable value
// goes through createSettingPill (the editor's one numpad-backed inline value)
// and every state word through createScriptChip, so this function only decides
// wording and wiring — never how a control looks or clamps.
function renderScriptLine(line, step, index) {
    // A commit that only changes a number: write it, replot. Anything that
    // can change the SHAPE of the script calls renderScriptTab() instead.
    const write = (fn) => (val) => { fn(val); renderScriptGraph(); };

    switch (line.kind) {
        case 'volumeStart':
            return scriptBullet([getTranslation('Start tracking water volume')]);

        case 'temperature': {
            const sensorChip = createScriptChip({
                states: ['coffee', 'water'],
                index: (step.sensor || 'coffee') === 'water' ? 1 : 0,
                // Group/Mix, the same two words the CARDS sensor chip uses —
                // the design's raw "coffee" is the stored field value, not a
                // label this app shows anywhere else.
                labelFor: (s) => getTranslation(s === 'water' ? 'Mix' : 'Group'),
                onChange: (s) => { editorState.profile.steps[index].sensor = s; },
            });
            const lim = FIELD_LIMITS.temperature;
            return scriptBullet([
                getTranslation(line.verb),
                sensorChip,
                getTranslation('temperature'),
                getTranslation(line.verb === 'Maintain' ? 'at' : 'to'),
                createSettingPill({
                    value: step.temperature ?? 93, min: lim.min, max: lim.max, step: lim.step,
                    unit: '°C', fieldType: 'pe-temp', title: 'TEMPERATURE',
                    format: scriptValueFormat('°C'),
                    // The next step's verb is computed against this value, so
                    // the whole script is rebuilt rather than just the graph.
                    onCommit: (v) => { editorState.profile.steps[index].temperature = v; renderScriptTab(); },
                }),
            ]);
        }

        case 'pump': {
            const lim  = line.isFlow ? FIELD_LIMITS.flow : FIELD_LIMITS.pressure;
            const unit = line.isFlow ? 'mL/s' : 'bar';
            const modeChip = createScriptChip({
                states: PUMP_CYCLE_STATES,
                index: pumpCycleIndex(line.isFlow ? 'flow' : 'pressure', step.transition || 'fast'),
                labelFor: pumpChipLabel,
                onChange: (state) => {
                    const s = editorState.profile.steps[index];
                    if (state.pump === 'pressure' && s.pump !== 'pressure') {
                        s.pump = 'pressure';
                        if (!s.pressure) s.pressure = PUMP_SEED_PRESSURE;
                        delete s.flow;
                    } else if (state.pump === 'flow' && s.pump === 'pressure') {
                        s.pump = 'flow';
                        if (!s.flow) s.flow = PUMP_SEED_FLOW;
                        delete s.pressure;
                    }
                    s.transition = state.transition;
                    // Unit, bounds and the limiter's axis all change with the
                    // mode, and every pill on this step closed over the old
                    // ones — rebuild rather than repaint.
                    renderScriptTab();
                },
            });
            return scriptBullet([
                modeChip,
                getTranslation(line.isFlow ? 'at a rate of' : 'to'),
                createSettingPill({
                    value: (line.isFlow ? step.flow : step.pressure) ?? 0,
                    min: lim.min, max: lim.max, step: lim.step, unit,
                    fieldType: 'pe-pump', title: line.isFlow ? 'FLOW' : 'PRESSURE',
                    format: scriptValueFormat(unit),
                    onCommit: write((v) => {
                        if (line.isFlow) editorState.profile.steps[index].flow = v;
                        else editorState.profile.steps[index].pressure = v;
                    }),
                }),
            ]);
        }

        case 'limit': {
            const lim  = line.isFlow ? FIELD_LIMITS.pressureLimit : FIELD_LIMITS.flowLimit;
            const unit = line.isFlow ? 'bar' : 'mL/s';
            return scriptBullet([
                getTranslation('Limit to'),
                createSettingPill({
                    value: step.limiter?.value ?? 0,
                    min: lim.min, max: lim.max, step: lim.step, unit,
                    fieldType: 'pe-lim', title: line.isFlow ? 'PRESSURE LIMIT' : 'FLOW LIMIT',
                    format: scriptValueFormat(unit),
                    onCommit: (v) => {
                        const s = editorState.profile.steps[index];
                        if (!s.limiter) s.limiter = { value: v, range: newLimiterRange(s.pump) };
                        else s.limiter.value = v;
                        // Zeroing it retires the sentence entirely.
                        renderScriptTab();
                    },
                }),
            ]);
        }

        case 'maximum': {
            const parts = [getTranslation('For a maximum of')];
            line.keys.forEach((key, n) => {
                if (n > 0) parts.push(getTranslation('or'));
                const { unit } = SCRIPT_MAX_FIELDS.find((f) => f.key === key);
                const lim = FIELD_LIMITS[key];
                parts.push(createSettingPill({
                    value: step[key] ?? 0, min: lim.min, max: lim.max, step: lim.step, unit,
                    fieldType: MAX_NUMPAD[key].fieldType, title: MAX_NUMPAD[key].title,
                    format: scriptValueFormat(unit),
                    // Zeroing one drops it from the sentence, so the line's
                    // shape — not just its numbers — can change here.
                    onCommit: (v) => { editorState.profile.steps[index][key] = v; renderScriptTab(); },
                }));
            });
            return scriptBullet(parts);
        }

        case 'exit': {
            const exitDef = readExitDef(step);
            const unit = EXIT_UNIT_MAP[exitDef.type];
            const exitChip = createScriptChip({
                // Off is deliberately dropped from the cycle here. This line
                // only exists while the step HAS an exit, so landing on Off
                // would delete the very control being tapped, halfway through
                // its own cycle — CARDS keeps a permanent Move-on-if row, and
                // that is where an exit gets switched off. The four remaining
                // states keep their exitCycleIndex slots (Off is last).
                states: EXIT_CYCLE_STATES.filter((s) => s.type !== 'off'),
                index: exitCycleIndex(exitDef.type, exitDef.condition),
                labelFor: exitChipLabel,
                onChange: (state) => {
                    // Same lossless swap as the CARDS exit chip: remember the
                    // value being left behind, and restore it (never reseed a
                    // 0) on the way back. A live "pressure is over 0 bar" exit
                    // fires on essentially any pressure at all.
                    rememberExitValue(step, exitDef.type, exitDef.value);
                    editorState.profile.steps[index].exit = {
                        type: state.type, condition: state.condition,
                        value: recallExitValue(step, state.type),
                    };
                    // Bounds and unit are per-type, and the value pill closed
                    // over the old ones — rebuild rather than repaint.
                    renderScriptTab();
                },
            });
            return scriptBullet([
                getTranslation('Move on if'),
                exitChip,
                createSettingPill({
                    value: exitDef.value, min: 0, max: EXIT_MAX_MAP[exitDef.type],
                    step: EXIT_STEP_MAP[exitDef.type], unit,
                    fieldType: 'pe-exit', title: `EXIT ${exitDef.type.toUpperCase()}`,
                    format: scriptValueFormat(unit),
                    onCommit: write((v) => {
                        const s = editorState.profile.steps[index];
                        if (!s.exit) s.exit = { type: exitDef.type, condition: exitDef.condition, value: v };
                        else s.exit.value = v;
                        rememberExitValue(step, exitDef.type, v);
                    }),
                }),
            ]);
        }

        default:
            return null;
    }
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

function renderScriptGraph() {
    // Every execution-field edit in the SCRIPT tab (renderScriptLine's chips —
    // sensor, pump mode, transition, exit condition) reaches this function
    // whichever tab is active, so it doubles as the catch-all for those raw
    // toggles — unlike the plotting below, this must run even while another
    // tab is showing, not just on re-entry to SCRIPT.
    updateSaveAsNewButtonState();
    // The panel stays in the DOM when hidden, so every grid edit used to replot
    // into a zero-size container. setActiveTab(2) re-renders on entry, so
    // skipping the work while another tab is up loses nothing.
    if (editorState.activeTab !== 2) return;
    const profile = editorState.profile;
    const graphDiv = document.getElementById('script-graph');
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

    // smooth: true rounds the frame-to-frame corners into a shot-like curve \u2014
    // this is a preview plot of the target profile, not the live/history shot
    // trace, so it doesn't need to stay exact point-for-point.
    const traces = [
        { x: pressureX, y: pressureY, name: 'Pressure', mode: 'lines', line: { color: '#17c29a', smooth: true }, hoverinfo: 'name' },
        { x: flowX,     y: flowY,     name: 'Flow',     mode: 'lines', line: { color: '#0358cf', smooth: true }, hoverinfo: 'name' },
        { x: tempX,     y: tempY,     name: '\u00b0C',  mode: 'lines', line: { color: tempLineColor, smooth: true }, hoverinfo: 'name' },
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

function renderScriptTab() {
    const container = document.getElementById('script-steps-col');
    const profile = editorState.profile;
    if (!container || !profile) return;
    container.innerHTML = '';
    // Attach once: the container is never recreated (only its innerHTML is
    // cleared above), just re-rendered every time this function runs.
    initScrollThumb('script-steps-col', 'script-steps-col-thumb');

    const steps = profile.steps || [];

    steps.forEach((step, i) => {
        // Hairline between steps, drawn between rows rather than as a border on
        // them, so the first row does not open with a rule and the last does
        // not close with one (Figma 1008 wide at 0.75).
        if (i > 0) {
            const rule = document.createElement('div');
            rule.className = 'w-[756px] h-0 border-t-[1.5px] border-[var(--border-graph-grid)] shrink-0';
            container.appendChild(rule);
        }

        const row = document.createElement('div');
        row.className = 'flex gap-[15px] w-[756px] shrink-0';

        // Fixed 225px name column (Figma 300) so every step's bullets start on
        // the same left edge regardless of how long its name is.
        const nameEl = document.createElement('p');
        nameEl.className = 'w-[225px] shrink-0 text-[24px] font-semibold leading-[1.2] text-[var(--text-primary)] break-words';
        // Step names are user input; textContent keeps them text.
        nameEl.textContent = `${i + 1}: ${step.name || getTranslation('Step')}`;
        row.appendChild(nameEl);

        const bullets = document.createElement('ul');
        bullets.className = 'flex-1 min-w-0 flex flex-col gap-[18px] list-disc pl-[36px]';
        const prevStep = i > 0 ? steps[i - 1] : null;
        for (const line of buildStepScript(step, i, profile, prevStep)) {
            const li = renderScriptLine(line, step, i);
            if (li) bullets.appendChild(li);
        }
        row.appendChild(bullets);

        container.appendChild(row);
    });

    renderScriptGraph();
    // Content height just changed (possibly for the first time this tab has
    // ever been shown), so the thumb's visibility/size/position needs a
    // fresh read of the now-final scrollHeight rather than whatever it was
    // left at from a previous render.
    updateScrollThumb('script-steps-col', 'script-steps-col-thumb');
}

// ─── Tab Management ─────────────────────────────────────────────────────────

function setActiveTab(tabIndex) {
    editorState.activeTab = tabIndex;

    // Update tab buttons
    document.querySelectorAll('.editor-tab-btn').forEach((btn) => {
        const idx = parseInt(btn.dataset.tab, 10);
        if (idx === tabIndex) {
            btn.className = 'editor-tab-btn font-bold w-[251.25px] h-[75px] rounded-[45px] transition-colors text-[30px] tracking-[2.25px] whitespace-nowrap bg-[var(--button-primary-bg)] text-white';
        } else {
            btn.className = 'editor-tab-btn font-bold w-[251.25px] h-[75px] rounded-[45px] transition-colors text-[30px] tracking-[2.25px] whitespace-nowrap text-[var(--tab-text-inactive)] bg-transparent';
        }
        fitTextToWidth(btn);
    });

    // Paging controls only make sense on the CARDS tab.
    const pagingControls = document.getElementById('editor-paging-controls');
    if (pagingControls) pagingControls.classList.toggle('hidden', tabIndex !== 0);

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
    else if (tabIndex === 2) renderScriptTab();
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
        updateSaveAsNewButtonState();
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

// Save routing for a profile opened from a local-only draft (see
// profileManager.js duplicateProfileAsDraft / createOrUpdateDraft). Never
// throws — called from saveProfile without an await, so an escaped rejection
// here would be an unhandled promise rejection rather than the usual toast.
async function saveDraftEdit(draftRecord) {
    try {
        const { uniqueProfileTitle } = await import('./profileManager.js');
        // Same auto-suffix saveProfile applies before minting/renaming a real
        // record — a draft can otherwise be renamed (or promoted) onto a title
        // another profile or draft already holds, which then confuses any
        // title-keyed lookup (resolveProfileKeyByTitle and friends).
        const currentTitle = editorState.profile.title.trim();
        const dedupedTitle = uniqueProfileTitle(currentTitle, draftRecord.id);
        if (dedupedTitle !== currentTitle) {
            editorState.profile.title = dedupedTitle;
            const titleDisplay = document.getElementById('editor-title-display');
            if (titleDisplay) titleDisplay.textContent = dedupedTitle;
        }

        const sourceProfile = normalizeLegacySteps(deepCopy(draftRecord.profile));
        const execChanged = executionChanged(sourceProfile, editorState.profile);

        if (!execChanged) {
            // Rename-only (or literally untouched): stays a local draft, no
            // server round trip — same content still dedups against whatever
            // it was copied from.
            const { createOrUpdateDraft } = await import('./profileManager.js');
            const updated = await createOrUpdateDraft({
                draftId: draftRecord.id,
                profile: editorState.profile,
                parentId: draftRecord.parentId,
            });
            editorState.sourceProfileRecord = updated;
            _baselineProfileJson = JSON.stringify(editorState.profile);
            finishSaveSuccess(updated.id);
            return;
        }

        // Real content change — promote out of the draft bucket into a real,
        // server-backed profile. Same content-addressed dedup risk as any
        // other fork (see forkDeduped in saveProfile below): if the edit still
        // hashes the same as an existing record, POST hands that back instead
        // of minting a new one.
        const { uploadProfileWithParent } = await import('./api.js');
        const { availableProfiles, remapFavorite, deleteProfileDraft } = await import('./profileManager.js');
        const sentTitle = editorState.profile.title.trim();
        const saved = await uploadProfileWithParent(editorState.profile, draftRecord.parentId);
        // Same tell as forkDeduped in saveProfile: a POST that lands back on the
        // parent, or comes back under a title we didn't send, means the server
        // silently deduped it onto an existing record instead of minting ours.
        const deduped = !saved
            || (draftRecord.parentId && saved.id === draftRecord.parentId)
            || (saved.profile?.title || '') !== sentTitle;
        if (deduped) {
            showToast(getTranslation('This change matches an existing profile — nothing new was saved'), 4000, 'info');
            return;
        }

        await deleteProfileDraft(draftRecord.id);
        await remapFavorite(draftRecord.id, saved.id);

        // Tile edits (dose/yield/grind/brew-temp/steam) made while this draft
        // was the active profile were saved to KV keyed to its draft id —
        // carry them over to the new id or they're orphaned in KV forever.
        const { getProfileOverride, saveProfileOverride, clearProfileOverride } = await import('./profile-overrides.js');
        const carriedOverride = getProfileOverride(draftRecord.id);
        if (carriedOverride) {
            const merged = await saveProfileOverride(saved.id, carriedOverride);
            await clearProfileOverride(draftRecord.id);
            saved.metadata = { ...(saved.metadata || {}), ...merged };
        }

        availableProfiles[saved.id] = saved;

        editorState.sourceProfileRecord = saved;
        editorState.sourceProfileId = saved.id;
        _baselineProfileJson = JSON.stringify(editorState.profile);

        finishSaveSuccess(saved.id);
    } catch (err) {
        console.error('Draft save failed:', err);
        showToast(`${getTranslation('Upload failed!')} ${err.message}`, 4000, 'error');
    }
}

// A brand-new profile arrives as a stub record carrying id null (see the Add
// Profile handler in profile_selector.js), so "is there a source profile"
// keys off the id, not record truthiness — the stub itself is always set.
// Shared by saveProfile (PUT-vs-POST routing) and the SAVE AS NEW button's
// enabled state, so the two definitions of "no source" can't drift apart.
function currentSaveSource() {
    return editorState.sourceProfileRecord?.id ? editorState.sourceProfileRecord : null;
}

// Whether the editor's current profile differs from the source in any
// execution field (steps, beverage_type, tank_temperature, target_weight,
// target_volume, … — see rest_v1.yml's content-hash inputs; title/author/
// notes are a separate metadata hash and never count). Shared by saveProfile's
// routing and the SAVE AS NEW button's enabled state so the two can't drift —
// the same reason currentSaveSource() above is shared rather than each caller
// re-deriving "is there a source" its own way.
function currentExecChanged() {
    const src = currentSaveSource();
    if (!src?.profile) return true;
    const sourceProfile = normalizeLegacySteps(deepCopy(src.profile));
    return executionChanged(sourceProfile, editorState.profile);
}

// SAVE AS NEW only makes sense once an execution field has actually changed —
// resolveSaveTarget below returns 'blocked' for asNew && !execChanged, because
// a rename-only POST dedups back to the source by content hash (title isn't
// part of that hash). Gating on the title instead — as this used to — enabled
// the button in exactly the state where it could never succeed. This has to
// be re-evaluated on every execution-field edit, not just a title edit: see
// the updateSaveAsNewButtonState() calls threaded through createGridStepper,
// createCycleChip, createScriptChip, createSettingPill, createSpinner,
// renderStepCards and renderScriptGraph.
function updateSaveAsNewButtonState() {
    const btn = document.getElementById('editor-save-as-btn');
    if (!btn || !editorState.profile) return;
    const src = currentSaveSource();
    const enabled = !src || currentExecChanged();
    btn.classList.toggle('opacity-40', !enabled);
    btn.classList.toggle('pointer-events-none', !enabled);
    btn.setAttribute('aria-disabled', String(!enabled));
}

// ─── Save routing (pure) ────────────────────────────────────────────────────
// SAVE (asNew=false) and SAVE AS NEW (asNew=true) are the explicit choice —
// routing no longer infers "fork vs overwrite" from titleChanged, since that
// left the one case the buttons exist for (title changed) with no way to
// choose between them.
//
// 'put'     — updateProfile(src.id, …): same id, in place. Only reachable
//             with a source, no execution change, not a default, not asNew —
//             a presentation-only change (rename included) is always safe to
//             PUT because PUT never hashes/dedups by content.
// 'post'    — uploadProfileWithParent(…): mints a record via POST. Covers
//             three different call sites in saveProfile (forced default fork,
//             an explicit Save As New, and a plain overwrite's hide+replace
//             dance) — which one is decided there from the same inputs.
// 'blocked' — neither is possible: a default with no execution change (PUT is
//             rejected server-side, and POST would dedup by content hash back
//             to the same default, silently dropping the rename), or an
//             explicit Save As New with no execution change (POST would
//             dedup back to the *source* record for the same reason — title
//             isn't part of a record's content hash).
function resolveSaveTarget({ hasSource, isDefault, execChanged, titleChanged, asNew }) {
    if (!hasSource) return 'post';
    if (!execChanged) return (isDefault || asNew) ? 'blocked' : 'put';
    // execChanged is true from here: every branch mints a record via POST —
    // a forced default fork, an explicit Save As New, or a plain SAVE's
    // hide+replace overwrite. Which of the three is decided in saveProfile
    // from the same isDefault/asNew inputs; titleChanged plays no part here.
    return 'post';
}

// Which title actually gets saved, and whether it needs an auto-suffix to
// avoid colliding with another profile.
//
// `existingTitles` is every OTHER profile's title — the caller has already
// excluded the source by id, because for a PUT/overwrite that's exactly
// right (the source is the record being kept, not a collision candidate).
// A real fork is different: it mints a second record, so if the title was
// left unchanged that second record collides with its own still-visible
// parent — this adds sourceTitle back in for exactly that case.
//
//  - PUT (in place), or SAVE's hide+replace overwrite of a non-default: the
//    same profile kept under whatever title it now has — no collision check
//    at all, even if that title happens to match something else (matches
//    the pre-existing 'overwrite' path, which was only ever reached with an
//    unchanged title).
//  - Everything else that mints a record (Save As New, a brand-new/uploaded
//    profile, or a default forced to fork on an execution change) must not
//    silently share a title with its own source.
function resolveFinalTitle({ title, existingTitles, sourceId, sourceTitle, asNew, target, isDefault }) {
    const trimmed = title.trim();
    // The no-source case (a brand-new profile, or an uploaded file) is never
    // "in place" — sourceId gates it explicitly so it still collision-checks
    // against existingTitles, same as before this function existed.
    const isInPlace = !!sourceId && (target === 'put' || (target === 'post' && !asNew && !isDefault));
    if (isInPlace) return trimmed;

    const collisionTitles = (sourceId && sourceTitle) ? new Set([...existingTitles, sourceTitle]) : existingTitles;
    if (!collisionTitles.has(trimmed)) return trimmed;
    let n = 2;
    while (collisionTitles.has(`${trimmed} (${n})`)) n++;
    return `${trimmed} (${n})`;
}

async function saveProfile({ asNew = false } = {}) {
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

        // Overwrite-in-place is the default (SAVE): editing an existing user
        // profile updates the same record, whatever the title says (no "(2)"
        // cruft on a draft→test→tweak loop, and no surprise fork from a typo
        // fix). SAVE AS NEW (asNew=true) is the explicit save-as instead.
        const src = currentSaveSource();

        // Editing a local-only draft (see profileManager.js duplicateProfileAsDraft
        // / createOrUpdateDraft) follows a completely separate routing: it only
        // reaches the server once its content actually diverges from the draft.
        if (src?.isDraft) {
            return saveDraftEdit(src);
        }

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
        // Either way stay on the editor rather than bouncing to the selector: the
        // user pressed Save meaning to keep something, and navigating away reads
        // as success. The toast names the way forward — renaming and pressing
        // SAVE AS NEW is the save-as route, which does mint a record.
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

        const sourceTitle = (src?.profile?.title || '').trim();
        const currentTitle = editorState.profile.title.trim();
        const titleChanged = sourceTitle && currentTitle !== sourceTitle;

        // Shared with the SAVE AS NEW button's enabled state (currentExecChanged)
        // so the two can't drift. Both sides are normalised there the same way
        // sourceProfile is above, so a legacy field the editor drops on load
        // can't masquerade as an execution change and fork the profile.
        const execChanged = currentExecChanged();

        const target = resolveSaveTarget({
            hasSource: !!src,
            isDefault: !!src?.isDefault,
            execChanged,
            titleChanged,
            asNew,
        });

        // Neither PUT nor POST can honor this save — say so instead of
        // pretending it stuck (PUT is rejected for defaults; POST would dedup
        // by content hash and silently drop the rename either way).
        if (target === 'blocked') {
            showToast(getTranslation('Change a setting to save a copy'), 3500, 'info');
            return;
        }

        // existingTitles excludes the source itself — resolveFinalTitle below
        // decides whether to add it back in (a real fork must collide with
        // its own parent; an in-place PUT or overwrite is exempt because it's
        // the same profile, not a second one).
        const existingTitles = new Set(
            Object.values(availableProfiles)
                .filter(r => r.id !== src?.id)
                .map(r => r.profile?.title)
                .filter(Boolean)
        );
        const finalTitle = resolveFinalTitle({
            title: editorState.profile.title,
            existingTitles,
            sourceId: src?.id ?? null,
            sourceTitle: src?.profile?.title ?? null,
            asNew,
            target,
            isDefault: !!src?.isDefault,
        });
        if (finalTitle !== editorState.profile.title.trim()) {
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
        if (target === 'put') {
            // Presentation-only change (title/author/notes, no execution
            // change), not a default, not an explicit Save As New — same id,
            // PUT in place. Renaming a user profile with plain SAVE lands here.
            saved = await updateProfile(src.id, editorState.profile);
        } else if (src?.isDefault) {
            // Forced fork — PUT is rejected server-side for a default. The
            // default itself stays as the parent/reset point (never hidden).
            saved = await uploadProfileWithParent(editorState.profile, src.id);
            if (forkDeduped(saved, src.id)) {
                showToast(getTranslation('This change matches an existing profile — nothing new was saved'), 4000, 'info');
                return;
            }
        } else if (!src || asNew) {
            // New profile / uploaded file, or an explicit Save As New with a
            // real execution change: a plain POST. src?.id links provenance
            // (getProfileLineage) but the source's visibility is never
            // touched — Save As New leaves the original completely untouched.
            saved = await uploadProfileWithParent(editorState.profile, src?.id ?? null);
            if (forkDeduped(saved, src?.id ?? null)) {
                showToast(getTranslation('This change matches an existing profile — nothing new was saved'), 4000, 'info');
                return;
            }
        } else {
            // Plain SAVE overwriting an existing user profile with a real
            // execution change: the content rehashes to a new id, so keep the
            // prior version as a hidden, restorable snapshot instead of
            // letting the server drop it on rehash. The new record links back
            // via parentId, so /lineage returns the full history the Revert
            // picker reads.
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
        }

        const oldId = editorState.sourceProfileId;
        availableProfiles[saved.id] = saved;

        // Only the plain-overwrite POST (hide+replace, just above) actually
        // retires the old id — favorites need to follow it there. A default's
        // fork keeps the default around, and Save As New deliberately leaves
        // the source alone, so neither should touch a favorite pointed at it.
        if (oldId && oldId !== saved.id && !src?.isDefault && !asNew) {
            delete availableProfiles[oldId];
            await remapFavorite(oldId, saved.id);
        }

        // A fork/rehash mints a new id, and the overrides (dose/yield/grind/
        // brew-temp/steam/flow calibration) are keyed by the old one. Carry
        // them, or the edited profile silently loses numbers the user set —
        // including the flow calibration they may have just typed on this tab.
        if (oldId && oldId !== saved.id) {
            await ensureProfileOverridesLoaded();
            const carried = getProfileOverride(oldId);
            if (carried) {
                const merged = await saveProfileOverride(saved.id, carried);
                saved.metadata = { ...(saved.metadata || {}), ...merged };
            }
        }

        // Rebind editor to the saved record so repeat saves update in place.
        editorState.sourceProfileRecord = saved;
        editorState.sourceProfileId = saved.id;
        _baselineProfileJson = JSON.stringify(editorState.profile);
        updateSaveAsNewButtonState();

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
    updateSaveAsNewButtonState();
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
    editorState.editingStep = null; // every card starts collapsed
    _baselineProfileJson = JSON.stringify(editorState.profile);
    _isNewProfileSession = !profileRecord.id;
    _sessionImportedIds = [];
    _hasImportedInSession = false;

    // 3. Populate title
    const titleDisplay = document.getElementById('editor-title-display');
    if (titleDisplay) titleDisplay.textContent = editorState.profile.title || 'Untitled Profile';
    updateSaveAsNewButtonState();

    // 4. Render tabs — setActiveTab renders whichever panel it shows.
    // Paging must be bound before the first renderStepCards() call inside it
    // (renderStepCards only recomputes disabled states via
    // updatePagingButtons — the icons and click/scroll listeners live here).
    initCardPaging(); // idempotent — the router re-mounts this page
    setActiveTab(0);

    // 5. Wire event listeners
    initTitleEditing();
    installOutsideClickHandler(); // idempotent — the router re-mounts this page

    // Tab buttons
    document.querySelectorAll('.editor-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            setActiveTab(parseInt(btn.dataset.tab, 10));
        });
    });

    // Close / Save / Save As New
    const saveBtn = document.getElementById('editor-save-btn');
    const saveAsBtn = document.getElementById('editor-save-as-btn');
    const closeBtn = document.getElementById('editor-close-btn');
    // SAVE and SAVE AS NEW both call saveProfile(), but with an explicit
    // `asNew` flag rather than inferring the fork-vs-overwrite choice from
    // whether the title changed — see resolveSaveTarget. SAVE AS NEW is
    // disabled via updateSaveAsNewButtonState() until the title actually
    // differs from the source profile's.
    if (saveBtn) saveBtn.addEventListener('click', () => saveProfile({ asNew: false }));
    if (saveAsBtn) saveAsBtn.addEventListener('click', () => {
        if (saveAsBtn.getAttribute('aria-disabled') === 'true') return;
        saveProfile({ asNew: true });
    });
    if (closeBtn) closeBtn.addEventListener('click', cancelEditor);

    console.log('Profile Editor: Initialization complete.');
}

// The router replaces #subpage-host's innerHTML wholesale on every navigation,
// which tears down every listener bound to elements inside it — but the
// outside-click handler above is bound to `document`, so it survives that and
// has to be removed explicitly. Router.js calls this before loading the next
// page (see cleanupCurrentPage). The paging scroll handler is bound to
// #editor-steps-container, which normally goes with the rest of the injected
// HTML — but drop it defensively too, since nothing here guarantees this
// runs before that element is gone.
export function cleanupProfileEditor() {
    removeOutsideClickHandler();
    removeCardPagingScrollHandler();
}
