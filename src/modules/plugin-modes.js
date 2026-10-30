// plugin-modes.js -- pure helpers for plugin `tile-mode` surfaces (see
// docs/plugin-surfaces.md). DOM-free so node:test can import it.

// Three options fit the 112px label column. Most tiles have a built-in option in
// the row, so they take two plugin options. Steam, hot water and flush have none: on
// steam and hot water the skin's own toggle (Time | Flow, Temp | Vol) ends a plugin
// mode, on flush a tap on the label does, so their row holds plugin options only.
export const MAX_OPTIONS_PER_TILE = 3;
export const tileHasBuiltinOption = tile => !['steam', 'hotwater', 'flush'].includes(tile);
export const pluginOptionCapacity = tile => MAX_OPTIONS_PER_TILE - (tileHasBuiltinOption(tile) ? 1 : 0);

// Entries are { plugin, surface } in Decaid's plugin order. Returns the modes each
// tile gets: the first plugins win, the rest are dropped.
export function planTileModes(entries) {
    const byTile = {};
    for (const entry of entries) {
        if (entry.surface.kind !== 'tile-mode') continue;
        const list = byTile[entry.surface.tile] || (byTile[entry.surface.tile] = []);
        if (list.length < pluginOptionCapacity(entry.surface.tile)) list.push(entry);
    }
    return byTile;
}

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

// Mode values are clamped into [min, max] and held at the mode's decimals.
export function clampModeValue(mode, n) {
    return round(Math.min(mode.max, Math.max(mode.min, n)), mode.decimals);
}

export function stepModeValue(mode, value, direction) {
    return clampModeValue(mode, round(value + direction * mode.step, 2));
}

// `+5%`, `0%`, `-7%`; the plus sign only when the mode can go negative.
export function formatModeValue(mode, value) {
    const n = clampModeValue(mode, value);
    const text = n.toFixed(mode.decimals);
    return `${mode.min < 0 && n > 0 ? '+' : ''}${text}${mode.unit || ''}`;
}

// The user's edits to a mode's presets: one entry per preset slot, `{ base, value }`
// or null. `base` is the plugin's preset when the edit was made; an edit whose base
// no longer matches (the plugin changed or reordered its presets) is dropped, so it
// never lands on a different preset. Anything malformed is ignored.
export function sanitizeEdits(mode, edits) {
    const out = mode.presets.map(() => null);
    if (Array.isArray(edits)) {
        mode.presets.forEach((preset, i) => {
            const e = edits[i];
            if (e && typeof e === 'object' && Number.isFinite(e.value) && e.base === preset) {
                out[i] = { base: preset, value: clampModeValue(mode, e.value) };
            }
        });
    }
    return out;
}

// What the preset row shows: the user's edit where there is one, else the plugin's.
// Presets the plugin marked not editable are always the plugin's own; stored edits
// are kept and apply again if it unlocks them.
export function effectivePresets(mode, edits) {
    if (mode.presetsEditable === false) return [...mode.presets];
    const clean = sanitizeEdits(mode, edits);
    return mode.presets.map((preset, i) => (clean[i] === null ? preset : clean[i].value));
}

// `edits` with slot `index` set to `value` (clamped), or cleared with null.
export function withPresetEdit(mode, edits, index, value) {
    const next = sanitizeEdits(mode, edits);
    if (index >= 0 && index < next.length) {
        next[index] = value === null ? null : { base: mode.presets[index], value: clampModeValue(mode, value) };
    }
    return next;
}

// The long-press menu of preset `index` as plain descriptors; the tile module
// turns them into menu items. Editing items are left out when the plugin says
// its presets are not editable, and Revert is disabled until the slot was edited.
export function presetMenuModel(mode, index, edits, current) {
    const clean = sanitizeEdits(mode, edits);
    const shown = effectivePresets(mode, clean)[index];
    const items = [{ id: 'apply', value: shown }];
    if (mode.presetsEditable !== false) {
        items.push({ id: 'enter', value: shown });
        items.push({ id: 'save', value: current, disabled: !Number.isFinite(current) });
        items.push({ id: 'revert', value: mode.presets[index], disabled: clean[index] === null, danger: true });
    }
    for (const item of mode.menu || []) items.push({ id: 'menu', label: item.label, value: item.value });
    return items;
}

// Sends one payload per key at a time, newest wins. `request` resolves:
//   false  `send` rejected (or timed out);
//   null   superseded: a newer payload replaced it before it was sent, or it was
//          sent but a newer one is already waiting, so its answer is stale;
//   true   it was sent and nothing newer is waiting.
// `request(key, payload, { immediate })` debounces unless `immediate`; `busy(key)`
// is true while a send is in flight or a payload is pending or debouncing.
export function createCallQueue({ send, delayMs = 300, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const lanes = new Map(); // key -> { timer, pending, inFlight }

    function laneFor(key) {
        let lane = lanes.get(key);
        if (!lane) {
            lane = { timer: null, pending: null, inFlight: false };
            lanes.set(key, lane);
        }
        return lane;
    }

    function run(key) {
        const lane = lanes.get(key);
        if (!lane || lane.inFlight || !lane.pending) return;
        const job = lane.pending;
        lane.pending = null;
        lane.inFlight = true;
        Promise.resolve()
            .then(() => send(key, job.payload))
            .then(() => true, () => false)
            .then(ok => {
                lane.inFlight = false;
                // A pending payload (debouncing or not) means the user is still stepping.
                job.resolve(ok && lane.pending ? null : ok);
                if (lane.pending && !lane.timer) run(key);
                else if (!lane.pending && !lane.timer) lanes.delete(key);
            });
    }

    function request(key, payload, { immediate = false } = {}) {
        const lane = laneFor(key);
        if (lane.timer) { clearTimer(lane.timer); lane.timer = null; }
        if (lane.pending) lane.pending.resolve(null);
        return new Promise(resolve => {
            lane.pending = { payload, resolve };
            if (immediate) run(key);
            else lane.timer = setTimer(() => { lane.timer = null; run(key); }, delayMs);
        });
    }

    function busy(key) {
        const lane = lanes.get(key);
        return !!lane && (lane.inFlight || !!lane.pending || !!lane.timer);
    }

    return { request, busy };
}
