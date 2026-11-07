// plugin-tile-modes.js -- what a left-column tile does while a plugin tile-mode is
// selected in its label toggle (see docs/plugin-surfaces.md, "Tile modes").
//
// The tile's own value and preset row are left alone and hidden; the mode draws
// its own in the same place. So the tile's polling and repaint keep working on
// the hidden elements, and switching back to the built-in option just shows them.
// -/+ are caught before the tile's own handlers. Every change goes to the plugin
// through callMode(); nothing is written to the profile or workflow from here.
//
// Presets keep the long-press menu the built-in ones have (Apply, Enter value,
// Save current here, Revert), with the user's edits kept per plugin and mode on
// this device, plus any items the plugin declares in `menu`.

import { callMode, isModeCallBusy } from './plugin-surfaces-ui.js';
import {
    clampModeValue, stepModeValue, formatModeValue,
    sanitizeEdits, effectivePresets, withPresetEdit, presetMenuModel,
} from './plugin-modes.js';
import { setupPressAndHold, showToast } from './ui.js';
import { openContextMenu } from './context-menu.js';
import { getTranslation } from './i18n.js';
import { logger } from './logger.js';

const TILE_DOM = {
    temperature: { minus: 'temp-minus', plus: 'temp-plus', value: 'temp-value', presets: ['temp-presets'], title: 'BREW' },
    dose: { minus: 'dose-in-minus', plus: 'dose-in-plus', value: 'dose-in-value', presets: [], title: 'DOSE' },
    drink: { minus: 'drink-out-minus', plus: 'drink-out-plus', value: 'drink-out-value', presets: ['drink-out-presets'], title: 'DRINK', ownBox: true },
    grind: { minus: 'grind-minus', plus: 'grind-plus', value: 'grind-value', presets: [], title: 'GRIND' },
    flush: { minus: 'flush-minus', plus: 'flush-plus', value: 'flush-value', presets: ['flush-presets'], title: 'FLUSH' },
    // Steam keeps one preset row per built-in mode and shows one at a time, and
    // its value box holds the duration and the flow.
    steam: { minus: 'steam-minus', plus: 'steam-plus', value: 'steam-duration-value',
        presets: ['steam-presets', 'steam-flow-presets', 'steam-milk-presets', 'steam-auto-presets'], title: 'STEAM', ownBox: true },
    // Like steam: a toggle (Temp | Vol) and a box with the volume and the temperature.
    hotwater: { minus: 'hot-water-vol-minus', plus: 'hot-water-vol-plus', value: 'hot-water-vol-value',
        presets: ['hotwater-presets'], title: 'HOT WATER', ownBox: true },
};

const active = {}; // tile -> { plugin, surface, value, valueEl, presetButtons, overlay: [elements], restore: [fns] }
const wired = new Set();
let started = false;

// The user's preset edits for one mode, on this device only.
function editsKey(plugin, surface) {
    return `plugin-mode-presets:${plugin.id}:${surface.id}`;
}

function readEdits(plugin, surface) {
    try {
        const raw = localStorage.getItem(editsKey(plugin, surface));
        return sanitizeEdits(surface, raw === null ? null : JSON.parse(raw));
    } catch {
        return sanitizeEdits(surface, null);
    }
}

// -> whether the edit was stored (a WebView in private mode, or a full store, refuses).
function writeEdits(plugin, surface, edits) {
    try {
        if (edits.every(e => e === null)) localStorage.removeItem(editsKey(plugin, surface));
        else localStorage.setItem(editsKey(plugin, surface), JSON.stringify(edits));
        return true;
    } catch (error) {
        logger.warn('Plugin mode preset edit not saved:', error);
        return false;
    }
}

function clearTile(tile) {
    const state = active[tile];
    if (!state) return;
    state.overlay.forEach(el => el.remove());
    state.restore.forEach(fn => fn());
    delete active[tile];
}

function apply(tile, number, { immediate }) {
    const state = active[tile];
    if (!state || !Number.isFinite(number)) return;
    state.value = clampModeValue(state.surface, number);
    paint(tile);
    callMode(state.plugin, state.surface, state.value, { immediate, extra: secondBody(state) });
}

const secondBody = state => (state.second == null ? undefined : { [state.surface.second.field]: state.second });

const roundSecond = (second, n) => Math.round(Math.min(second.max, Math.max(second.min, n)) * 10 ** second.decimals) / 10 ** second.decimals;
const formatSecond = (second, n) => `${n.toFixed(second.decimals)}${second.unit || ''}`;

// The second value was edited: the call carries both numbers, so a newer call that
// supersedes this one in the queue never loses the other value.
function applySecond(tile, number) {
    const state = active[tile];
    const second = state?.surface.second;
    if (!second || !Number.isFinite(number)) return;
    state.second = roundSecond(second, number);
    paint(tile);
    callMode(state.plugin, state.surface, state.value, { immediate: true, extra: secondBody(state) });
}

// `initial` and `onConfirm` default to editing the mode's own value.
async function openNumpad(tile, { initial, onConfirm, suffix = '', spec } = {}) {
    const state = active[tile];
    if (!state) return;
    const { plugin, surface } = state;
    // The mode's own number unless `spec` names another (the second value).
    const field = spec || { label: surface.label, unit: surface.unit || '', min: surface.min, max: surface.max,
        signed: surface.min < 0 && surface.decimals === 0 };
    const start = initial === undefined ? state.value : initial;
    const module = await import('./numpad-modal.js');
    module.initNumpadModal();
    const input = { value: String(start), setAttribute() {}, getAttribute() { return null; }, dispatchEvent() {} };
    module.openModal(input, {
        // Per plugin and mode, so two plugins on one tile keep their own previous-value pills.
        fieldType: `plugin-mode-${String(plugin.id)}:${surface.id}${suffix}`.replace(/[^A-Za-z0-9_.:-]/g, '_'),
        config: {
            title: `${TILE_DOM[tile].title} ${field.label}`,
            unit: field.unit,
            defaultValue: String(start),
            min: field.min,
            max: field.max,
            // The "." key becomes +/- when only whole numbers are asked for and negatives are possible.
            signed: field.signed,
        },
        onConfirm: onConfirm || (raw => apply(tile, parseFloat(raw), { immediate: true })),
    });
}

// -> whether it was stored. Does nothing if the tile no longer shows the mode the
// menu was opened for (the plugin answered differently, or the user switched).
function savePresetEdit(tile, plugin, surface, index, value) {
    const state = active[tile];
    if (!state || state.plugin.id !== plugin.id || state.surface.id !== surface.id) return false;
    const stored = writeEdits(plugin, state.surface, withPresetEdit(state.surface, readEdits(plugin, state.surface), index, value));
    draw(tile, plugin, state.surface, { keepValue: true });
    return stored;
}

function reportSaved(stored, message) {
    if (stored) showToast(getTranslation(message), 2000, 'success');
    else showToast(getTranslation('Could not save the preset on this device'), 3000, 'error');
}

// The long press of a plugin preset: the built-in preset menu, then the plugin's items.
function openPresetMenu(tile, button, index) {
    const state = active[tile];
    if (!state || !button.isConnected) return; // a redraw replaced the button under the finger
    const { plugin, surface } = state;
    const fmt = n => formatModeValue(surface, n);
    const stillShown = () => active[tile]?.plugin.id === plugin.id && active[tile]?.surface.id === surface.id;
    // Replacements as functions: a plugin unit such as "$&" is not a replace pattern.
    const fill = (key, text) => getTranslation(key).replace('{value}', () => text);
    const model = presetMenuModel(surface, index, readEdits(plugin, surface), state.value);
    const items = [];
    let divided = false; // one divider between the built-in items and the plugin's
    for (const entry of model) {
        if (entry.id === 'menu' && !divided && items.length) {
            items.push({ divider: true });
            divided = true;
        }
        if (entry.id === 'apply') {
            items.push({ label: fill('Apply {value}', fmt(entry.value)),
                onSelect: () => { if (stillShown()) apply(tile, entry.value, { immediate: true }); } });
        } else if (entry.id === 'enter') {
            items.push({ label: getTranslation('Enter value'), onSelect: () => openNumpad(tile, {
                initial: entry.value,
                suffix: ':preset', // its previous-value pills are presets, not mode values
                onConfirm: raw => {
                    const n = parseFloat(raw);
                    if (!Number.isFinite(n)) return;
                    reportSaved(savePresetEdit(tile, plugin, surface, index, n), `Preset saved as ${fmt(clampModeValue(surface, n))}`);
                },
            }) });
        } else if (entry.id === 'save') {
            items.push({ label: fill('Save current ({value}) here', fmt(entry.value)),
                disabled: entry.disabled,
                onSelect: () => reportSaved(savePresetEdit(tile, plugin, surface, index, entry.value),
                    `Preset saved as ${fmt(entry.value)}`) });
        } else if (entry.id === 'revert') {
            items.push({ label: fill('Revert to {value}', fmt(entry.value)),
                danger: true, disabled: entry.disabled, onSelect: () => {
                    if (savePresetEdit(tile, plugin, surface, index, null)) {
                        showToast(getTranslation(`Preset reverted to ${fmt(entry.value)}`), 2000, 'info');
                    }
                } });
        } else {
            items.push({ label: entry.label,
                onSelect: () => { if (stillShown()) apply(tile, entry.value, { immediate: true }); } });
        }
    }
    openContextMenu(button, items);
}

function paint(tile) {
    const state = active[tile];
    if (!state) return;
    const { surface } = state;
    const text = formatModeValue(surface, state.value);
    (state.textEl || state.valueEl).textContent = text;
    state.valueEl.setAttribute('aria-label', `${surface.label} ${text}`);
    if (state.secondEl) {
        const second = formatSecond(surface.second, state.second);
        state.secondEl.textContent = second;
        state.secondEl.setAttribute('aria-label', `${surface.label} ${surface.second.field} ${second}`);
    }
    for (const button of state.presetButtons) {
        button.classList.toggle('preset-active', Number(button.dataset.modeValue) === state.value);
    }
}

function draw(tile, plugin, surface, { keepValue = false } = {}) {
    const dom = TILE_DOM[tile];
    const valueEl = dom && document.getElementById(dom.value);
    if (!valueEl || !document.getElementById(dom.minus)) return;

    // Redrawn for the same mode while a call is still going out: the user's value is
    // newer than the plugin's answer, so keep it instead of snapping back.
    const before = active[tile];
    const keep = before && before.plugin.id === plugin.id && before.surface.id === surface.id
        && (keepValue || isModeCallBusy(plugin, surface));
    clearTile(tile);
    const state = { plugin, surface, value: clampModeValue(surface, keep ? before.value : surface.value),
        second: surface.second ? roundSecond(surface.second, keep && before.second != null ? before.second : surface.second.value) : null,
        overlay: [], restore: [], presetButtons: [], valueEl: null };
    active[tile] = state;
    const hideEl = el => {
        const before = el.style.visibility;
        el.style.visibility = 'hidden';
        state.restore.push(() => { el.style.visibility = before; });
    };

    // Value: in the tile's own box, with its own classes. The drink tile's box
    // holds the value and the ratio, so that whole box is hidden.
    const hidden = dom.ownBox ? valueEl.parentElement : valueEl;
    const mine = document.createElement('span');
    mine.className = dom.ownBox
        ? 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[72px] text-center text-[var(--text-primary)] text-[25.5px] font-bold'
        : valueEl.className.replace(/\bblock\b/, '').trim();
    mine.style.cursor = 'pointer';
    mine.dataset.pluginSurface = `mode-value:${tile}`;
    mine.dataset.agentId = `plugin-tile:${tile}:tile-mode-value`;
    mine.setAttribute('role', 'button');
    mine.tabIndex = 0; // aria-label is set by paint() with the current value
    mine.addEventListener('click', () => openNumpad(tile));
    mine.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openNumpad(tile);
    });
    // A second line under the value (a flow beside a time) on the tiles whose box
    // holds two lines. Both lines open the numpad; the call carries both numbers.
    if (surface.second) {
        mine.className = 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[110px] flex flex-col items-center text-center text-[var(--text-primary)] leading-tight';
        mine.removeAttribute('role');
        mine.removeAttribute('tabindex');
        mine.style.cursor = '';
        const main = document.createElement('span');
        main.className = 'text-[25.5px] font-bold';
        main.style.cursor = 'pointer';
        main.setAttribute('role', 'button');
        main.tabIndex = 0;
        // Each line handles its own tap; the container's handler (for the single-line
        // value) must not also open the main numpad.
        main.addEventListener('click', event => { event.stopPropagation(); openNumpad(tile); });
        main.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            openNumpad(tile);
        });
        const second = document.createElement('span');
        second.className = 'text-[19.5px] font-semibold';
        second.style.cursor = 'pointer';
        second.setAttribute('role', 'button');
        second.tabIndex = 0;
        const openSecond = () => openNumpad(tile, {
            initial: state.second, suffix: ':second',
            spec: { label: `${surface.label} ${surface.second.field}`, unit: surface.second.unit || '',
                min: surface.second.min, max: surface.second.max, signed: false },
            onConfirm: raw => applySecond(tile, parseFloat(raw)),
        });
        second.addEventListener('click', event => { event.stopPropagation(); openSecond(); });
        second.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            openSecond();
        });
        mine.append(main, second);
        state.textEl = main;
        state.secondEl = second;
        state.valueEl = main;
    }
    hideEl(hidden);
    hidden.parentElement.appendChild(mine);
    state.overlay.push(mine);
    if (!state.valueEl) state.valueEl = mine;

    // Presets: the plugin's own, or none. The tile's rows are taken out of the
    // layout and ours, the same size, takes the place of the first, so nothing
    // moves. Tiles without a preset row ignore the mode's presets.
    const rows = dom.presets.map(id => document.getElementById(id)).filter(Boolean);
    if (rows.length) {
        const [first] = rows;
        const template = first.firstElementChild;
        const mineRow = document.createElement('div');
        mineRow.dataset.pluginSurface = `mode-presets:${tile}`;
        mineRow.className = first.className.replace(/\bhidden\b/, '').trim();
        const shown = effectivePresets(surface, readEdits(plugin, surface));
        // With nothing but "Apply" to offer, a long press would only repeat the tap.
        const hasMenu = presetMenuModel(surface, 0, null, state.value).length > 1;
        shown.forEach((preset, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            if (template) button.className = template.className.replace(/\bpreset-active\b/, '').trim();
            button.textContent = formatModeValue(surface, preset);
            button.dataset.modeValue = String(preset);
            const onTap = () => apply(tile, preset, { immediate: true });
            if (hasMenu) {
                button.classList.add('no-select', 'has-context-menu');
                setupPressAndHold(button, onTap, () => openPresetMenu(tile, button, index));
            } else {
                button.addEventListener('click', onTap);
            }
            mineRow.appendChild(button);
            state.presetButtons.push(button);
        });
        for (const row of rows) {
            const before = row.style.display;
            row.style.display = 'none';
            state.restore.push(() => { row.style.display = before; });
        }
        first.parentElement.insertBefore(mineRow, first);
        state.overlay.push(mineRow);
    }
    paint(tile);
    wire(tile);
}

// Caught on the wrapper in the capture phase, before the tile's own -/+ handlers.
function wire(tile) {
    if (wired.has(tile)) return;
    const dom = TILE_DOM[tile];
    const parent = document.getElementById(dom.minus)?.parentElement;
    if (!parent) return;
    wired.add(tile);
    parent.addEventListener('click', event => {
        const state = active[tile];
        const button = event.target.closest?.('button');
        if (!state || !button || (button.id !== dom.minus && button.id !== dom.plus)) return;
        event.stopPropagation();
        event.preventDefault();
        apply(tile, stepModeValue(state.surface, state.value, button.id === dom.plus ? 1 : -1), { immediate: false });
    }, true);
}

export function initTileModes() {
    if (started) return;
    started = true;
    document.addEventListener('streamline:tilemodechange', event => {
        const { tile, plugin, surface } = event.detail || {};
        if (!TILE_DOM[tile]) return;
        if (plugin && surface) draw(tile, plugin, surface);
        else clearTile(tile);
    });
}
