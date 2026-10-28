// plugin-surfaces.js -- parse and validate a plugin's `skin` answer
// (GET /api/v1/plugins/{id}/skin). DOM-free so node:test can import it.
//
// The answer is untrusted: a plugin installs from an arbitrary repo. Nothing here
// is trusted or executed; the output is plain, length-capped data that a renderer
// writes with textContent. Anything that does not validate is dropped, never
// repaired into something else, so a bad surface cannot break a good one.

export const SKIN_VERSION = 1;
export const MAX_SURFACES = 16;     // per plugin, all kinds together (slots allow one per kind per tile)
export const MAX_MODES_PER_PLUGIN_TILE = 3; // tile-modes one plugin may add to one tile

// `menu-item` adds an entry to one of the skin's long-press menus. The list is fixed
// and each menu has its own small context (see docs/plugin-surfaces.md).
export const MENUS = ['shot-history', 'favourite', 'profile'];
export const MAX_MENU_ITEMS_PER_PLUGIN = 3; // per menu

export const TILES = ['dose', 'drink', 'grind', 'temperature'];
// The fields `set` may write. Each maximum is the one the tile itself enforces when
// the user types a value (ui.js makeEditable handlers; brew temperature also caps
// the +/- buttons at 105). The tile's minimum is 0; dose, yield and brew
// temperature use a higher minimum here (grind is the same 0).
// brewTemperature is in degrees Celsius and is where the profile's first step goes;
// the other steps move by the same amount (the tile's own behaviour, see
// brew-temp.js and docs/plugin-surfaces.md).
export const SET_LIMITS = {
    targetDoseWeight: { min: 1, max: 30 },
    targetYield: { min: 1, max: 2000 },
    grinderSetting: { min: 0, max: 9999 },
    brewTemperature: { min: 70, max: 105 },
};
export const SET_FIELDS = Object.keys(SET_LIMITS);
// `tile-sync`: the tiles a plugin may keep in step with a device, and the workflow field each one is.
export const SYNC_TILES = { grind: 'grinderSetting' };
// `telemetry-label` renames a label in the main page's telemetry row.
export const TELEMETRY_LABELS = ['puck'];
export const PRESENTATIONS = ['page', 'overlay'];
// `size` on a tile hint, line or mode: how big its text is. Three fixed steps, never
// pixels, so a plugin cannot break a tile's layout; `small` is the default and is
// not kept. The renderer drops to a smaller step when the text does not fit.
export const SURFACE_SIZES = ['small', 'medium', 'large'];
function parseSize(value) {
    return value === 'medium' || value === 'large' ? value : null;
}
// `step` moves the tile's own value by `by`; brew temperature is left out because
// the tile shows it in the user's unit and a step would have to know which.
export const STEP_FIELDS = ['targetDoseWeight', 'targetYield', 'grinderSetting'];
const STEP_MAX = 100;
// `stepsize` sets what the dose / yield tile's own -/+ move by, on this device.
// Brew temperature depends on the unit, so it is not steppable.
export const STEPSIZE_FIELDS = ['targetDoseWeight', 'targetYield', 'grinderSetting'];
const STEPSIZE_MAX_SIZES = 4;

// `keepRatio` on a Drink hint or line: while the surface is shown, a new dose also
// moves the yield to dose x ratio, in the same write. The plugin owns the switch (it
// sends the field while its lock is on) and the number.
export const KEEP_RATIO_LIMITS = { min: 0.1, max: 50 };
function parseKeepRatio(value) {
    const n = toNumber(value);
    return n !== null && n >= KEEP_RATIO_LIMITS.min && n <= KEEP_RATIO_LIMITS.max ? Math.round(n * 100) / 100 : null;
}
// Which tile a change moves: each moves the other ("both", the default, so the ratio holds
// whichever the user changes), only a dose moves the yield ("yield"), or only a yield moves
// the dose ("dose").
export const KEEP_RATIO_MOVES = ['both', 'yield', 'dose'];
// The dose for `yieldWeight` at `ratio`, to a tenth of a gram; null when it would leave
// the range a dose may have (the yield then goes alone).
export function doseForRatio(yieldWeight, ratio) {
    const d = Math.round(yieldWeight / ratio * 10) / 10;
    return Number.isFinite(d) && d >= SET_LIMITS.targetDoseWeight.min && d <= SET_LIMITS.targetDoseWeight.max ? d : null;
}
// The yield for `dose` at `ratio`, to a tenth of a gram; null when it would leave
// the range a yield may have (the dose then goes alone, as without a lock).
export function yieldForRatio(dose, ratio) {
    const y = Math.round(dose * ratio * 10) / 10;
    return Number.isFinite(y) && y >= 1 && y <= 2000 ? y : null;
}
export const STEPSIZE_MAX = 10;

// `tile-mode` adds an option to the toggle under a left-column tile's label.
// Steam, hot water and flush can take a mode but not a hint or a line, so they are not in TILES.
export const MODE_TILES = [...TILES, 'steam', 'hotwater', 'flush'];
export const MODE_LIMITS = {
    label: 6,        // characters in the toggle option
    unit: 3,         // characters appended to the value
    secondUnit: 6,   // characters appended to the second value (steam and drink only)
    presets: 4,      // the preset row has four slots
    menu: 4,         // extra items in a preset's long-press menu
    menuLabel: 24,
    bound: 9999,     // |min|, |max|
    decimals: 2,
};
// Endpoint ids Decaid serves itself: it registers `POST /api/v1/plugins/<id>/settings`,
// `/enable`, `/disable` and the plugin-management routes before the generic
// `<endpoint>` route, so a plugin endpoint with one of these ids is never reached.
export const RESERVED_ENDPOINTS = ['skin', 'settings', 'enable', 'disable', 'source', 'update', 'install'];
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CAPS = { label: 24, text: 40, hint: 24, title: 80, image: 2048 };

function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '').trim().slice(0, max);
}

function httpsUrl(value) {
    if (typeof value !== 'string' || value.length > CAPS.image) return null;
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.username || u.password) return null;
        return u.href;
    } catch {
        return null;
    }
}

// Anything unknown falls back to `page` and never invalidates the surface.
function parseOpen(action) {
    const view = typeof action.view === 'string' ? action.view : '';
    const presentation = PRESENTATIONS.includes(action.presentation) ? action.presentation : 'page';
    // `fit`: the overlay's page will report its size (streamline:size), so the dialog stays
    // invisible until it does. Only an overlay has a dialog to hold back.
    return {
        type: 'open',
        view: ID_RE.test(view) ? view : '',
        presentation,
        // `size: "full"`: the whole screen less the close button. The page needs no size
        // report there, so `fit` does not apply.
        ...(presentation === 'overlay' && action.size === 'full' && { size: 'full' }),
        ...(presentation === 'overlay' && action.size !== 'full' && action.fit === true && { fit: true }),
        // `closeOnShot`: the page opts in to being closed when an espresso starts, so it never
        // covers the shot. Only an overlay is covering anything.
        ...(presentation === 'overlay' && action.closeOnShot === true && { closeOnShot: true }),
    };
}

// A finite number from a number or a numeric string; null otherwise.
function toNumber(value) {
    const n = typeof value === 'number' ? value
        : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    return Number.isFinite(n) ? n : null;
}

const round2 = n => Math.round(n * 100) / 100;
const roundTo = (n, decimals) => Math.round(n * 10 ** decimals) / 10 ** decimals;

// A finite number (or numeric string) clamped to the field's range, to
// hundredths; null when it is not a number or the field is not settable.
export function clampSetValue(field, value) {
    if (!Object.prototype.hasOwnProperty.call(SET_LIMITS, field)) return null;
    const limits = SET_LIMITS[field];
    const n = toNumber(value);
    if (n === null) return null;
    return round2(Math.min(limits.max, Math.max(limits.min, n)));
}

// `from: "scale"` replaces `value`: the skin reads the scale when the pill is tapped.
// Only the dose can come from the scale, so the plugin needs no scale stream of its own.
export const SET_FROM = ['scale'];
function parseSet(action) {
    if (action.from !== undefined) {
        return SET_FROM.includes(action.from) && action.field === 'targetDoseWeight'
            ? { type: 'set', field: action.field, from: action.from } : null;
    }
    const value = clampSetValue(action.field, action.value);
    return value === null ? null : { type: 'set', field: action.field, value };
}

// The dose a scale reading may become: to a tenth of a gram, and only when it is a
// real dose. A reading outside the dose's range (a full cup, 200 g) is refused, never
// clamped into one.
export function scaleDoseWeight(weight) {
    if (typeof weight !== 'number' || !Number.isFinite(weight)) return null;
    const w = Math.round(weight * 10) / 10;
    return w >= SET_LIMITS.targetDoseWeight.min && w <= SET_LIMITS.targetDoseWeight.max ? w : null;
}

// What a "use the scale" tap may do, as one decision: refused while the machine is making
// something, when the reading is older than 3 s (a scale that stopped sending), within 10 s
// of an espresso ending (the full cup is still on the scale), and for a weight that is not
// a real dose. Pure so the rules can be tested; the caller passes the clock and the state.
export const SCALE_DOSE = { maxAgeMs: 3000, afterShotMs: 10000 };
export const NOT_FOR_DOSE_STATES = ['espresso', 'skipStep', 'steam', 'steamRinse', 'hotWater', 'flush',
    'cleaning', 'descaling', 'airPurge'];
export function scaleDoseFor({ weight, readAt, now, state, espressoEndedAt }) {
    if (NOT_FOR_DOSE_STATES.includes(state)) return null;
    if (!Number.isFinite(readAt) || !Number.isFinite(now) || now - readAt > SCALE_DOSE.maxAgeMs) return null;
    if (Number.isFinite(espressoEndedAt) && now - espressoEndedAt < SCALE_DOSE.afterShotMs) return null;
    return scaleDoseWeight(weight);
}

// The size an overlay asked for with `streamline:size`, held to what the overlay may
// use: never bigger than the default dialog or the screen, never a sliver. null for junk.
export const OVERLAY_LIMITS = { maxWidth: 1100, maxHeight: 760, minWidth: 280, minHeight: 160 };
export function fitOverlaySize(width, height, viewportWidth, viewportHeight) {
    if (![width, height, viewportWidth, viewportHeight].every(n => typeof n === 'number' && Number.isFinite(n))) return null;
    const clamp = (n, min, max) => Math.round(Math.min(max, Math.max(min, n)));
    return {
        width: clamp(width, OVERLAY_LIMITS.minWidth, Math.max(OVERLAY_LIMITS.minWidth, Math.min(OVERLAY_LIMITS.maxWidth, viewportWidth * 0.94))),
        height: clamp(height, OVERLAY_LIMITS.minHeight, Math.max(OVERLAY_LIMITS.minHeight, Math.min(OVERLAY_LIMITS.maxHeight, viewportHeight * 0.9))),
    };
}

function parseStep(action) {
    const by = toNumber(action.by);
    if (!STEP_FIELDS.includes(action.field) || by === null || by === 0 || Math.abs(by) > STEP_MAX) return null;
    return { type: 'step', field: action.field, by: round2(by) };
}

function parseStepSize(action) {
    const { sizes } = action;
    // `custom`: the user may also type a step of their own (long-press the pill), for a
    // stepless grinder. Then `sizes` may be empty and a tap opens the numpad directly.
    const custom = action.custom === true;
    if (!STEPSIZE_FIELDS.includes(action.field) || !Array.isArray(sizes)
        || sizes.length < (custom ? 0 : 1) || sizes.length > STEPSIZE_MAX_SIZES) return null;
    const out = [];
    for (const item of sizes) {
        const n = toNumber(item);
        if (n === null || n <= 0 || n > STEPSIZE_MAX) return null;
        const r = round2(n);
        if (r <= 0) return null;
        out.push(r);
    }
    return { type: 'stepsize', field: action.field, sizes: out, ...(custom && { custom: true }) };
}

// The size after `current` in `sizes`, wrapping; the first when `current` is not in it.
export function nextStepSize(sizes, current) {
    if (!Array.isArray(sizes) || sizes.length === 0) return null;
    const i = sizes.indexOf(current);
    return i === -1 ? sizes[0] : sizes[(i + 1) % sizes.length];
}

// The size to use for a stored value: the stored one when the plugin still offers
// it, otherwise the first offered size.
export function resolveStepSize(sizes, stored, custom = false) {
    // A typed step is kept as is (to hundredths, up to the same cap as an offered size).
    if (custom && Number.isFinite(stored) && stored > 0 && stored <= STEPSIZE_MAX && round2(stored) === stored) return stored;
    if (!Array.isArray(sizes) || sizes.length === 0) return 1;
    return sizes.includes(stored) ? stored : sizes[0];
}

// Pill text for a size, e.g. `±0.5 g`; grind has no unit.
export function formatStepSize(size, field) {
    return `±${round2(size)}${field === 'grinderSetting' ? '' : ' g'}`;
}

// `call` POSTs `{ [field]: <number> }` to one of the plugin's own http endpoints.
// Whether `endpoint` is one the plugin declares is checked against its manifest by
// callableEndpoint(); `skin` is the read side and the other RESERVED_ENDPOINTS are
// Decaid's own routes, so none of those is callable.
// A hint or line sends a fixed number with its tap (`value`, required there); a
// tile-mode sends whatever the user chose, so it declares none.
const CALL_VALUE_MAX = 99999;

// `input` asks the user for the number with the skin's own full-screen numpad:
// { title (24), unit (6), min, max, decimals (0-2), value (the starting number) }.
// Used by a call's `input` and by an overlay's `streamline:numpad` request, so both
// are limited alike. Anything off drops it (null): a numpad with no usable range
// would let a plugin put arbitrary numbers in front of the user.
export const NUMPAD_LIMITS = { title: 24, unit: 6, bound: CALL_VALUE_MAX, decimals: 2 };

// The number the numpad may return: rounded to `decimals`, then held inside
// [min, max] on that same grid (a max of 1.25 with one decimal allows 1.2, not 1.3).
export function fitNumpadValue({ min, max, decimals }, n) {
    const f = 10 ** decimals;
    const lo = Math.ceil(min * f - 1e-9) / f;
    const hi = Math.floor(max * f + 1e-9) / f;
    return Math.min(hi, Math.max(lo, roundTo(n, decimals)));
}

export function parseNumpadInput(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const min = toNumber(raw.min), max = toNumber(raw.max);
    if (min === null || max === null || min >= max
        || Math.abs(min) > NUMPAD_LIMITS.bound || Math.abs(max) > NUMPAD_LIMITS.bound) return null;
    const decimals = raw.decimals == null ? 0 : raw.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > NUMPAD_LIMITS.decimals) return null;
    // The numpad's sign key exists only for whole numbers, so a negative range
    // with decimals could not be typed.
    if (min < 0 && decimals > 0) return null;
    // At least one number on the grid must fit the range.
    const f = 10 ** decimals;
    if (Math.ceil(min * f - 1e-9) > Math.floor(max * f + 1e-9)) return null;
    const start = toNumber(raw.value);
    const title = cleanText(raw.title, NUMPAD_LIMITS.title);
    const unit = cleanText(raw.unit, NUMPAD_LIMITS.unit);
    return { ...(title && { title }), ...(unit && { unit }), min, max, decimals,
        value: fitNumpadValue({ min, max, decimals }, start === null ? min : start) };
}

// A menu item's call carries the menu's context as its body, so it has no field or value.
function parseMenuCall(action) {
    const { endpoint } = action;
    if (typeof endpoint !== 'string' || !ID_RE.test(endpoint) || RESERVED_ENDPOINTS.includes(endpoint)) return null;
    return { type: 'call', endpoint };
}

function parseCall(action, { withValue = false } = {}) {
    const { endpoint, field } = action;
    if (typeof endpoint !== 'string' || !ID_RE.test(endpoint) || RESERVED_ENDPOINTS.includes(endpoint)) return null;
    if (typeof field !== 'string' || !FIELD_RE.test(field)) return null;
    if (!withValue) return { type: 'call', endpoint, field };
    // A numpad input replaces the fixed number: the user types it.
    if (action.input !== undefined) {
        const input = parseNumpadInput(action.input);
        return input ? { type: 'call', endpoint, field, input } : null;
    }
    const value = toNumber(action.value);
    if (value === null || Math.abs(value) > CALL_VALUE_MAX) return null;
    return { type: 'call', endpoint, field, value: round2(value) };
}

// True when `plugin` declares an http endpoint with this id that a `call` may use.
export function callableEndpoint(plugin, endpoint) {
    if (typeof endpoint !== 'string' || RESERVED_ENDPOINTS.includes(endpoint)) return false;
    return Array.isArray(plugin?.api) && plugin.api.some(e => e?.type === 'http' && e?.id === endpoint);
}

// An invalid action drops the action only; the surface still shows, inert.
// (`tile-mode` is the exception: without a valid `call` it is dropped.)
function parseAction(raw, kind) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type === 'open') return parseOpen(raw);
    if (raw.type === 'call' && kind === 'menu-item') return parseMenuCall(raw);
    if (raw.type === 'call' && kind === 'ratio-action') return parseCall(raw, { withValue: true });
    if (raw.type === 'set' && (kind === 'tile-hint' || kind === 'tile-line')) return parseSet(raw);
    if (raw.type === 'step' && (kind === 'tile-hint' || kind === 'tile-line')) return parseStep(raw);
    if (raw.type === 'stepsize' && (kind === 'tile-hint' || kind === 'tile-line')) return parseStepSize(raw);
    if (raw.type === 'call' && kind === 'tile-mode') return parseCall(raw);
    if (raw.type === 'call' && (kind === 'tile-hint' || kind === 'tile-line')) return parseCall(raw, { withValue: true });
    return null;
}

// A second number a mode keeps beside its main one (a steam flow beside a time).
// The steam and drink tiles have a second line for it. Tapping it opens the numpad
// and sends the new number to the same `call` under `field`. Invalid -> no second
// value; the mode itself is still drawn.
const SECOND_TILES = ['steam', 'hotwater', 'flush', 'drink'];
function parseSecond(raw, mainField) {
    if (!raw || typeof raw !== 'object') return null;
    const { field } = raw;
    if (typeof field !== 'string' || !FIELD_RE.test(field) || field === mainField) return null;
    const decimals = raw.decimals == null ? 0 : raw.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MODE_LIMITS.decimals) return null;
    const min = toNumber(raw.min);
    const max = toNumber(raw.max);
    const bound = MODE_LIMITS.bound;
    if (min === null || max === null || min >= max || min < -bound || max > bound) return null;
    if (roundTo(min, decimals) !== min || roundTo(max, decimals) !== max) return null;
    const value = toNumber(raw.value);
    if (value === null) return null;
    const unit = cleanText(raw.unit, MODE_LIMITS.secondUnit);
    return { field, ...(unit && { unit }), decimals, min, max,
        value: roundTo(Math.min(max, Math.max(min, value)), decimals) };
}

// A mode the user steps through with the tile's -/+ and numpad. `value` and the
// presets are clamped into [min, max] and rounded to `decimals`; a mode that cannot
// be stepped (min/max/step finer than `decimals`) or called is dropped.
function parseMode(raw, id, action) {
    if (!MODE_TILES.includes(raw.tile) || action?.type !== 'call') return null;
    const label = cleanText(raw.label, MODE_LIMITS.label);
    if (!label) return null;
    const unit = cleanText(raw.unit, MODE_LIMITS.unit);

    const decimals = raw.decimals == null ? 0 : raw.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MODE_LIMITS.decimals) return null;

    const bound = MODE_LIMITS.bound;
    const min = toNumber(raw.min);
    const max = toNumber(raw.max);
    if (min === null || max === null || min >= max || min < -bound || max > bound) return null;
    // A bound that does not fit `decimals` would let out-of-range values through.
    if (roundTo(min, decimals) !== min || roundTo(max, decimals) !== max) return null;
    const clamp = n => roundTo(Math.min(max, Math.max(min, n)), decimals);

    const value = toNumber(raw.value);
    if (value === null) return null;
    const rawStep = raw.step == null ? 1 : toNumber(raw.step);
    if (rawStep === null) return null;
    // A step finer than `decimals` rounds to 0 (or never moves the shown value).
    const step = roundTo(rawStep, decimals);
    if (step <= 0 || step < 10 ** -decimals || step > max - min) return null;

    const presets = [];
    if (Array.isArray(raw.presets)) {
        for (const item of raw.presets) {
            const n = toNumber(item);
            if (n !== null && presets.length < MODE_LIMITS.presets) presets.push(clamp(n));
        }
    }
    // Extra long-press menu items: a label and the number to send. Same `call`.
    const menu = [];
    if (Array.isArray(raw.menu)) {
        for (const item of raw.menu) {
            if (menu.length >= MODE_LIMITS.menu || !item || typeof item !== 'object') continue;
            const itemLabel = cleanText(item.label, MODE_LIMITS.menuLabel);
            const n = toNumber(item.value);
            if (itemLabel && n !== null) menu.push({ label: itemLabel, value: clamp(n) });
        }
    }
    const second = SECOND_TILES.includes(raw.tile) ? parseSecond(raw.second, action.field) : null;
    return { id, kind: 'tile-mode', tile: raw.tile, label, ...(unit && { unit }),
        value: clamp(value), min, max, step, decimals, presets, ...(menu.length && { menu }),
        ...(second && { second }), ...(raw.applyOnSelect === true && { applyOnSelect: true }),
        ...(parseSize(raw.size) && { size: parseSize(raw.size) }),
        ...(raw.presetsEditable === false && { presetsEditable: false }), action };
}

// A live shot strip: a few readings drawn in the info row during an espresso (or
// always). The skin reads the numbers; the plugin picks which cells, their colour
// tokens and how a dot or bar judges a reading against its goal. No plugin code runs.
export const STRIP_BUILTIN = ['weight', 'pressure', 'flow', 'weightFlow', 'puckTemp', 'waterTemp', 'step'];
const STRIP_WITH_GOAL = ['weight', 'pressure', 'flow', 'puckTemp', 'waterTemp'];
export const STRIP_COLORS = ['pressure', 'flow', 'temp', 'weight', 'ongoing', 'accent', 'text', 'muted', 'red', 'amber'];
export const STRIP_SHOW = ['shot', 'always'];
// The info row is a 9-column grid: in the Figma dashboard (a 12-column page) the left
// control column takes 3 columns and the info row the other 9.
export const STRIP_COLUMNS = 9;
export const STRIP_MAX_CELLS = STRIP_COLUMNS;
const STRIP_DOT_COLORS = { good: 'ongoing', warn: 'amber', bad: 'red' };
const stripColor = v => (STRIP_COLORS.includes(v) ? v : null);

function parseStripDot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const green = toNumber(raw.greenWithin);
    const amber = toNumber(raw.amberWithin);
    if (green === null || amber === null || green <= 0 || amber <= green || amber > 2) return null;
    const colors = { ...STRIP_DOT_COLORS };
    for (const k of Object.keys(colors)) if (stripColor(raw.colors?.[k])) colors[k] = raw.colors[k];
    return { greenWithin: green, amberWithin: amber, colors };
}

const gridInt = v => (Number.isInteger(v) && v >= 1 && v <= STRIP_COLUMNS ? v : null);

// Gives every cell a `col` and `span` on the grid. A cell that asks for a column
// keeps it, one column wide unless it sets `span` (cut to the grid's edge); one that
// overlaps an earlier cell is dropped. Cells without a column fill the free columns
// left to right, each taking `span`, or two columns while the free columns allow every
// cell still to place one, else one.
export function stripLayout(cells) {
    const taken = Array(STRIP_COLUMNS + 1).fill(false);
    const free = (col, span) => col + span - 1 <= STRIP_COLUMNS && taken.slice(col, col + span).every(t => !t);
    const take = (col, span) => taken.fill(true, col, col + span);
    const placed = new Map();
    cells.forEach((cell, i) => {
        if (!cell.col) return;
        const span = Math.min(cell.span || 1, STRIP_COLUMNS - cell.col + 1);
        if (!free(cell.col, span)) return;
        take(cell.col, span);
        placed.set(i, { col: cell.col, span });
    });
    let autosLeft = cells.filter(c => !c.col).length;
    cells.forEach((cell, i) => {
        if (cell.col) return;
        const freeCols = taken.slice(1).filter(t => !t).length;
        const want = cell.span || (freeCols >= autosLeft + 1 ? 2 : 1);
        autosLeft -= 1;
        for (const span of [...new Set([want, 1])]) {
            const col = Array.from({ length: STRIP_COLUMNS }, (_, c) => c + 1).find(c => free(c, span));
            if (col) { take(col, span); placed.set(i, { col, span }); return; }
        }
    });
    return cells.flatMap((cell, i) => {
        const at = placed.get(i);
        if (!at) return [];
        const { col: _c, span: _s, ...rest } = cell;
        return [{ ...rest, ...at }];
    }).sort((a, b) => a.col - b.col);
}

function parseStripCell(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cell = parseStripCellBody(raw);
    if (!cell) return null;
    const col = gridInt(raw.col);
    const span = gridInt(raw.span);
    return { ...cell, ...(col && { col }), ...(span && { span }) };
}

function parseStripCellBody(raw) {
    const color = stripColor(raw.color);
    const label = cleanText(raw.label, 12);
    if (raw.cell == null) { // a cell of the plugin's own: a label and a text
        const text = cleanText(raw.text, 16);
        return label && text ? { label, text, ...(color && { color }) } : null;
    }
    if (!STRIP_BUILTIN.includes(raw.cell)) return null;
    const goal = STRIP_WITH_GOAL.includes(raw.cell);
    const dot = goal && parseStripDot(raw.dot);
    return { cell: raw.cell, ...(label && { label }), ...(color && { color }),
        ...(dot && { dot }), ...(goal && raw.bar === true && { bar: true,
            ...(toNumber(raw.barMax) > 0 && toNumber(raw.barMax) <= BAR_MAX_LIMIT && { barMax: toNumber(raw.barMax) }) }),
        ...(goal && SURFACE_SIZES.includes(raw.goalSize) && { goalSize: raw.goalSize }) };
}

// -> a number and its goal for one built-in cell, or nulls when the frame has none.
// `ctx`: { sample (snapshot), weight, weightFlow (g/s), yieldGoal, step: { name, pump } }.
export function stripReading(cell, { sample = {}, weight = null, weightFlow = null, yieldGoal = null, step = null } = {}) {
    const num = v => (Number.isFinite(v) ? v : null);
    const pos = v => (Number.isFinite(v) && v > 0 ? v : null);
    switch (cell) {
        case 'weight': return { value: num(weight), goal: pos(yieldGoal) };
        // A pressure goal means something only on a pressure step, a flow goal on a flow step.
        case 'pressure': return { value: num(sample.pressure), goal: step?.pump === 'flow' ? null : pos(sample.targetPressure) };
        case 'flow': return { value: num(sample.flow), goal: step?.pump === 'pressure' ? null : pos(sample.targetFlow) };
        case 'weightFlow': return { value: num(weightFlow), goal: null }; // g/s, the series the chart draws
        case 'puckTemp': return { value: num(sample.groupTemperature), goal: pos(sample.targetGroupTemperature) };
        case 'waterTemp': return { value: num(sample.mixTemperature), goal: pos(sample.targetMixTemperature) };
        default: return { value: null, goal: null };
    }
}

// -> 'good' | 'warn' | 'bad' by how far `value` is from `goal` (a fraction of it).
export function stripDotLevel(dot, value, goal) {
    if (!dot || !Number.isFinite(value) || !Number.isFinite(goal) || goal <= 0) return null;
    const off = Math.abs(value - goal) / goal;
    return off <= dot.greenWithin ? 'good' : off <= dot.amberWithin ? 'warn' : 'bad';
}

// A bar fills against the goal; where the step has none (flow on a pressure step) it
// fills against a scale: the plugin's `barMax`, else these.
export const STRIP_BAR_MAX = { pressure: 12, flow: 8, puckTemp: 100, waterTemp: 100 };
const BAR_MAX_LIMIT = 1000;

// -> how full a bar is, 0..1 (value / goal, or / max without a goal), or null.
export function stripBarFraction(value, goal, max = null) {
    const whole = Number.isFinite(goal) && goal > 0 ? goal : max;
    if (!Number.isFinite(value) || !Number.isFinite(whole) || whole <= 0) return null;
    return Math.min(1, Math.max(0, value / whole));
}

function parseStrip(raw, id) {
    if (!Array.isArray(raw.cells)) return null;
    const cells = [];
    for (const item of raw.cells) {
        const cell = cells.length < STRIP_MAX_CELLS ? parseStripCell(item) : null;
        if (cell) cells.push(cell);
    }
    const laid = stripLayout(cells);
    if (!laid.length) return null;
    return { id, kind: 'shot-strip', show: STRIP_SHOW.includes(raw.show) ? raw.show : 'shot', cells: laid };
}

function parseSurface(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
    const { id, kind } = raw;
    const action = parseAction(raw.action, kind);

    if (kind === 'header-button') {
        const label = cleanText(raw.label, CAPS.label);
        if (!label) return null;
        const text = cleanText(raw.text, CAPS.text);
        const image = raw.image == null ? null : httpsUrl(raw.image);
        return { id, kind, label, ...(text && { text }), ...(image && { image }), ...(action && { action }) };
    }

    // Drawn over the screensaver. It opens a plugin page and nothing else, so it
    // takes an `open` action only; without one it would be a dead button.
    if (kind === 'screensaver-button') {
        const label = cleanText(raw.label, CAPS.label);
        if (!label || action?.type !== 'open') return null;
        const image = raw.image == null ? null : httpsUrl(raw.image);
        return { id, kind, label, ...(image && { image }), action };
    }

    // The ratio label under Drink ("(1:2.7)") becomes tappable. It runs this action
    // and nothing else, so without an `open` or `call` it would be dead: dropped.
    // The label's text stays the skin's; one per plugin (the slot rule below).
    if (kind === 'ratio-action') {
        if (action?.type !== 'open' && action?.type !== 'call') return null;
        const title = cleanText(raw.title, CAPS.title);
        return { id, kind, ...(title && { title }), action };
    }

    // Without an `open` or `call` it would be a dead menu entry: dropped.
    if (kind === 'menu-item') {
        const label = cleanText(raw.label, CAPS.text);
        if (!label || !MENUS.includes(raw.menu) || (action?.type !== 'open' && action?.type !== 'call')) return null;
        return { id, kind, menu: raw.menu, label, action };
    }

    // The tile follows a device's reading: the skin writes `value` as a tile edit when it
    // changes (see plugin-surfaces-ui.js). Nothing to draw, so no action either.
    if (kind === 'tile-sync') {
        const field = SYNC_TILES[raw.tile];
        const value = field ? clampSetValue(field, raw.value) : null;
        if (value === null) return null;
        const label = cleanText(raw.label, CAPS.label);
        return { id, kind, tile: raw.tile, value, ...(label && { label }) };
    }

    // Renames a telemetry label ("Puck" -> "Coffee"). Nothing to tap, so no action.
    if (kind === 'telemetry-label') {
        const text = cleanText(raw.text, CAPS.label);
        return TELEMETRY_LABELS.includes(raw.target) && text ? { id, kind, target: raw.target, text } : null;
    }

    if (kind === 'tile-mode') return parseMode(raw, id, action);
    if (kind === 'shot-strip') return parseStrip(raw, id);

    if (kind === 'tile-hint' || kind === 'tile-line') {
        if (!TILES.includes(raw.tile)) return null;
        // A `stepsize` pill is drawn by the skin from the device's stored size, so
        // its `text` is optional and ignored.
        const text = cleanText(raw.text, kind === 'tile-hint' ? CAPS.hint : CAPS.text)
            || (raw.action?.type === 'stepsize' ? formatStepSize(action?.sizes?.[0] ?? 1, action?.field) : '');
        if (!text) return null;
        const title = kind === 'tile-hint' ? cleanText(raw.title, CAPS.title) : '';
        // `active` marks a pill or line as switched on (a lock, a chosen option).
        return { id, kind, tile: raw.tile, text, ...(title && { title }),
            ...(parseSize(raw.size) && { size: parseSize(raw.size) }),
            ...(raw.tile === 'drink' && parseKeepRatio(raw.keepRatio) && { keepRatio: parseKeepRatio(raw.keepRatio),
                ...(KEEP_RATIO_MOVES.includes(raw.keepRatioMoves) && raw.keepRatioMoves !== 'both' && { keepRatioMoves: raw.keepRatioMoves }) }),
            ...(raw.active === true && { active: true }), ...(action && { action }) };
    }

    return null; // unknown kind: a newer plugin on an older skin just shows less
}

// -> { surfaces: [...] }. Never throws; a wrong version or shape gives no surfaces.
// `live` names a websocket endpoint of the plugin that says "my answer changed":
// any message on it makes the skin read `skin` again. Whether the plugin really
// declares that websocket is checked against its manifest by liveEndpoint().
function parseLive(raw) {
    const endpoint = raw && typeof raw === 'object' ? raw.endpoint : null;
    if (typeof endpoint !== 'string' || !ID_RE.test(endpoint) || RESERVED_ENDPOINTS.includes(endpoint)) return null;
    return { endpoint };
}

// How the plugin wants its Open button in Settings > Extensions to behave. That
// button is not a surface -- the settings page draws it from the plugin's `ui`
// endpoint, for every plugin that has one -- so the answer declares it here
// instead, as a whole `open` action run through the same parser.
//
// Only `presentation: "overlay"` is kept: anything else is what the button
// already does (same-frame navigation with returnTo), so there is nothing to
// record. Guessing instead of reading a declaration was the alternative, and it
// would have cost every page that does not speak the overlay protocol a 3 s
// empty dialog before falling back -- which today is nearly all of them
// (issue #173).
function parseSettingsOpen(raw) {
    if (!raw || typeof raw !== 'object' || raw.type !== 'open') return null;
    const action = parseOpen(raw);
    return action.presentation === 'overlay' ? action : null;
}

// What a live push asks for. A body of {"what":"skin"} means only the skin answer
// changed; anything else (including "workflow", no body, or junk) means both the
// skin and the workflow tiles should be re-read.
export function pushWants(data) {
    let body = data;
    if (typeof data === 'string') {
        try { body = JSON.parse(data); } catch { body = null; }
    }
    const skinOnly = !!body && typeof body === 'object' && body.what === 'skin';
    return { skin: true, workflow: !skinOnly };
}

// Runs `run` on the first push of a burst and at most once more per window,
// so a change a plugin made shows at once instead of after the window, while a
// fast stream still costs one run per window. `wantsWorkflow` is OR-ed across
// the messages a window swallowed, so a skin-only push cannot drop the workflow
// re-read a push behind it asked for.
export function createPushCoalescer({ run, windowMs, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let timer = null;
    let queued = false;
    let queuedWorkflow = false;

    function fire(wantsWorkflow) {
        run(wantsWorkflow);
        timer = setTimer(() => {
            timer = null;
            if (!queued) return;
            const workflow = queuedWorkflow;
            queued = false;
            queuedWorkflow = false;
            fire(workflow);
        }, windowMs);
    }

    return {
        push(wantsWorkflow) {
            if (timer === null) { fire(Boolean(wantsWorkflow)); return; }
            queued = true;
            if (wantsWorkflow) queuedWorkflow = true;
        },
        // The page going hidden closes the sockets; a window left open would
        // fire a run after the next open with nothing behind it.
        reset() {
            clearTimer(timer);
            timer = null;
            queued = false;
            queuedWorkflow = false;
        },
    };
}

// -> the endpoint id when `plugin` declares it as a websocket, else null.
export function liveEndpoint(plugin, live) {
    const id = live?.endpoint;
    if (typeof id !== 'string' || RESERVED_ENDPOINTS.includes(id)) return null;
    return Array.isArray(plugin?.api) && plugin.api.some(e => e?.type === 'websocket' && e?.id === id) ? id : null;
}

export function parseSkinAnswer(raw) {
    const out = { surfaces: [], live: null, settingsOpen: null };
    if (!raw || typeof raw !== 'object' || raw.version !== SKIN_VERSION || !Array.isArray(raw.surfaces)) return out;
    out.live = parseLive(raw.live);
    out.settingsOpen = parseSettingsOpen(raw.settingsOpen);

    const seen = new Set();
    const slots = new Set(); // one header button, and one hint and line per tile
    const modeCount = {};    // tile -> tile-modes taken so far (up to MAX_MODES_PER_PLUGIN_TILE)
    const menuCount = {};    // menu -> menu-items taken so far (up to MAX_MENU_ITEMS_PER_PLUGIN)
    for (const item of raw.surfaces) {
        if (out.surfaces.length >= MAX_SURFACES) break;
        const surface = parseSurface(item);
        if (!surface || seen.has(surface.id)) continue;
        if (surface.kind === 'tile-mode') {
            if ((modeCount[surface.tile] || 0) >= MAX_MODES_PER_PLUGIN_TILE) continue;
            modeCount[surface.tile] = (modeCount[surface.tile] || 0) + 1;
        } else if (surface.kind === 'menu-item') {
            if ((menuCount[surface.menu] || 0) >= MAX_MENU_ITEMS_PER_PLUGIN) continue;
            menuCount[surface.menu] = (menuCount[surface.menu] || 0) + 1;
        } else {
            const slot = surface.tile ? `${surface.kind}:${surface.tile}` : surface.kind;
            if (slots.has(slot)) continue;
            slots.add(slot);
        }
        seen.add(surface.id);
        out.surfaces.push(surface);
    }
    return out;
}

// Loaded plugins that declare an http endpoint named `skin`; the only ones asked.
export function skinPlugins(plugins) {
    if (!Array.isArray(plugins)) return [];
    return plugins.filter(p => p?.loaded && typeof p.id === 'string'
        && Array.isArray(p.api) && p.api.some(e => e?.type === 'http' && e?.id === 'skin'));
}
