// plugin-shot-strip.js -- draws the `shot-strip` surface a plugin declares: a few
// live readings in the info row, in place of it. The plugin chose the cells, colour
// tokens and thresholds (validated in plugin-surfaces.js); this module reads the
// shot's own numbers and paints them with textContent. No plugin code runs.

import { MachineState } from './api.js';
import { getTranslation } from './i18n.js';
import { formatTemp } from './units.js';
import { STRIP_COLUMNS, STRIP_BAR_MAX, stripReading, stripDotLevel, stripBarFraction } from './plugin-surfaces.js';

// Colour tokens -> the style guide's [light, dark] values (Graph.*.Ongoing, Status.Ongoing,
// Action.Primary.Active, Text.*). Flow has no dark Ongoing token (the chart reuses the
// light one); `amber` is not in the guide.
const COLORS = {
    pressure: ['#17C29A', '#00B087'], flow: ['#0358CF', '#0358CF'], temp: ['#FF97A1', '#653F43'],
    weight: ['#E9D3C3', '#695F57'], ongoing: ['#0CA581', '#17C29A'], accent: ['#385A92', '#415996'],
    text: ['#121212', '#E8E8E8'], muted: ['#777777', '#707485'], red: ['#DA515E', '#DA515E'],
    amber: ['#D98E04', '#E0A030'],
};
const LABELS = { weight: 'Weight', pressure: 'Pressure', flow: 'Flow', weightFlow: 'Weight flow', puckTemp: 'Puck', waterTemp: 'Water', step: 'Step' };
const TRACE_COLOR = { weight: 'weight', pressure: 'pressure', flow: 'flow', weightFlow: 'weight', puckTemp: 'temp', waterTemp: 'temp', step: 'muted' };
// The goal's text size: a plugin's `goalSize`, else the skin's own row size.
const GOAL_PX = { small: 14, medium: 17, large: 22.5 };
const LEVEL_KEY = { good: 'good', warn: 'warn', bad: 'bad' };

let strip = null;    // the surface in use, or null
let host = null;     // our row, next to #telemetry-row
let resizeObs = null;
let cellEls = [];    // [{ value, goal, dot, fill }] per cell
let lastShown = null;
let builtDark = false; // the theme the colours were drawn for

const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
const color = token => (COLORS[token] || COLORS.muted)[isDark() ? 1 : 0];

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

function buildCell(cell) {
    const wrap = el('span', `position:relative;display:block;min-width:0;padding:5px 0 7px;grid-column:${cell.col} / span ${cell.span};`);
    const inner = el('span', 'display:inline-block;white-space:nowrap;transform-origin:left center;');
    wrap.append(inner);
    const token = cell.color || TRACE_COLOR[cell.cell] || 'muted';
    const label = el('span', `font-family:Inter;font-size:22.5px;font-weight:600;line-height:24px;color:${color(token)};`,
        cell.label || (LABELS[cell.cell] ? getTranslation(LABELS[cell.cell]) : ''));
    inner.append(label, document.createTextNode('  '));
    const value = el('span', 'font-family:NotoSansMono;font-size:22.5px;font-weight:600;line-height:24px;color:var(--text-primary);',
        cell.text || '');
    inner.append(value);
    const refs = { cell, token, label, value, wrap, inner };
    if (cell.cell) {
        refs.goal = el('span', `font-family:NotoSansMono;font-size:${GOAL_PX[cell.goalSize] || 22.5}px;font-weight:600;color:var(--data-card-title-text-color);`);
        inner.append(refs.goal);
    }
    if (cell.dot) {
        refs.dot = el('span', 'display:inline-block;width:12px;height:12px;border-radius:50%;margin-left:8px;vertical-align:-1px;visibility:hidden;');
        inner.append(refs.dot);
    }
    if (cell.bar) {
        const track = el('span', 'position:absolute;left:0;right:0;bottom:0;height:4px;border-radius:2px;background:var(--border-graph-grid, #E8E8E8);');
        refs.fill = el('span', `position:absolute;left:0;top:0;bottom:0;width:0;border-radius:2px;background:${color(token)};`);
        track.append(refs.fill);
        wrap.append(track);
    }
    refs.wrap = wrap;
    return refs;
}

function ensureHost() {
    const row = document.getElementById('telemetry-row');
    if (!row) return null;
    if (host?.isConnected) return host;
    host = el('div');
    host.id = 'shot-strip';
    host.className = row.className;
    host.style.width = '100%';
    host.style.gap = '0 12px';
    host.style.alignContent = 'center'; // the row's box has no height: centre on its line like the plain row's cells
    host.setAttribute('aria-label', 'Shot readings');
    host.style.display = 'none';
    row.after(host);
    // The row's width changes with the window and the GHC column, with no text change.
    if (typeof ResizeObserver !== 'undefined') { resizeObs = new ResizeObserver(() => fit()); resizeObs.observe(host); }
    return host;
}

let changed = false; // a cell's text moved: the strip may need refitting
function setText(node, text) {
    if (node.textContent === text) return;
    node.textContent = text;
    changed = true;
}

// Each cell shrinks to its own columns when its text is wider than them. Reads
// first, then writes, so the layout is measured once.
function fit() {
    if (!host || !host.clientWidth) return; // hidden: keep the last fit
    const sizes = cellEls.map(c => [c.wrap.clientWidth, c.inner.scrollWidth]); // scrollWidth ignores the transform
    cellEls.forEach((c, i) => {
        const [room, need] = sizes[i];
        c.inner.style.transform = room > 0 && need > room ? `scale(${(room / need).toFixed(3)})` : '';
    });
}

function show(on) {
    const row = document.getElementById('telemetry-row');
    if (!host || !row || lastShown === on) return;
    lastShown = on;
    host.style.display = on ? 'grid' : 'none';
    row.style.display = on ? 'none' : '';
    if (on) fit();
}

// The surface to draw (a parsed `shot-strip`), or null to go back to the plain row.
export function setShotStrip(surface) {
    if (!surface) {
        if (strip) {
            strip = null; show(false); cellEls = [];
            resizeObs?.disconnect(); resizeObs = null;
            host?.remove(); host = null;
        }
        return;
    }
    if (!ensureHost()) return;
    strip = surface;
    builtDark = isDark();
    cellEls = surface.cells.map(buildCell);
    host.style.gridTemplateColumns = `repeat(${STRIP_COLUMNS}, minmax(0, 1fr))`;
    host.replaceChildren(...cellEls.map(c => c.wrap));
    changed = true;
    lastShown = null;
    if (lastFrame) paintShotStrip(lastFrame); // decides show() from the state: no flash of the plain row
    else show(strip.show === 'always');
}

let lastFrame = null;

// One snapshot frame: { sample, weight, weightFlow, state }. Cheap; called at the stream's rate.
export function paintShotStrip(frame) {
    lastFrame = frame;
    if (!strip || !host || !frame) return;
    if (builtDark !== isDark()) { setShotStrip(strip); return; } // theme switched: redraw in its colours
    const inShot = frame.state === MachineState.ESPRESSO;
    show(strip.show === 'always' || inShot);
    if (host.style.display === 'none') return;
    const stepIdx = frame.sample?.profileFrame;
    const step = frame.step || null; // the running profile's step, found by the caller
    const yieldGoal = parseFloat(document.getElementById('drink-out-value')?.textContent);
    const ctx = { sample: frame.sample, weight: frame.weight, weightFlow: frame.weightFlow, yieldGoal, step };
    for (const c of cellEls) {
        if (!c.cell.cell) continue;
        if (c.cell.cell === 'step') {
            setText(c.value, inShot && Number.isInteger(stepIdx) ? `${stepIdx + 1}${step?.name ? ` ${step.name}` : ''}`.slice(0, 18) : '-');
            continue;
        }
        const { value, goal } = stripReading(c.cell.cell, ctx);
        const temp = c.cell.cell.endsWith('Temp');
        const weight = c.cell.cell === 'weight';
        const fmt = n => (temp ? formatTemp(n, 1) : weight ? `${n.toFixed(1)}g` : n.toFixed(1));
        setText(c.value, value === null ? '-' : fmt(value));
        setText(c.goal, goal === null ? '' : ` / ${temp ? formatTemp(goal, 0).replace(/°.$/, '') : weight ? `${goal.toFixed(0)}g` : goal.toFixed(1)}`);
        if (c.dot) {
            const level = stripDotLevel(c.cell.dot, value, goal);
            c.dot.style.visibility = level ? 'visible' : 'hidden';
            if (level) c.dot.style.background = color(c.cell.dot.colors[LEVEL_KEY[level]]);
        }
        if (c.fill) c.fill.style.width = `${Math.round((stripBarFraction(value, goal, c.cell.barMax ?? STRIP_BAR_MAX[c.cell.cell]) ?? 0) * 100)}%`;
    }
    if (changed) { changed = false; fit(); }
}
