import { logger } from './logger.js';
import { getTranslation } from './i18n.js';
import { hasMachineGFlow, createScaleFlowResolver, createPourPhaseTracker } from './historical-gflow.js';
import { EXP_TOP_FLOOR, computeExpandedTopYMax, computeExpandedTempRange, separateLabelPositions, pickVisible } from './chart-autoscale.js';
import { createLatestTaskRunner } from './latest-task-runner.js';
import { loadECharts } from './echarts-loader.js';
import { destroyChart, getSeriesVisibility, hasChart, onLegendChange, renderChart, resizeChart, selectSeries, setYAxisRange } from './echarts-renderer.js';

// Maps internal trace key → i18n key used for the chart label.
const LABEL_KEYS = {
    pressure: 'Pressure',
    flow: 'Flow',
    // groupTemperature intentionally omitted → falls back to trace.name '°C'
    weight: 'Weight'
};

function getLabelText(traceName, fallback) {
    const key = LABEL_KEYS[traceName];
    return key ? getTranslation(key) : fallback;
}

// Define colors for step markers
const STEP_MARKER_COLORS = {
    dark: '#7f8bbb',
    light: '#7c7c7c'
};

const CHART_REDRAW_INTERVAL_MS = 100;
const LIVE_X_DATA_FRACTION = 0.93;
const renderQueues = new WeakMap();
const renderGenerations = new WeakMap();
let latestMainRender = null;
let mainRenderDirty = false;
let currentTheme = localStorage.getItem('theme') || 'light';

async function drawECharts({ element, traces, layout, mode, generation }) {
    if (!element.isConnected || renderGenerations.get(element) !== generation) return;
    const echarts = await loadECharts();
    if (!element.isConnected || renderGenerations.get(element) !== generation) return;
    renderChart(echarts, element, traces, layout, mode);
    ensureExpandedInteractions(element);
}

function renderECharts(element, traces, layout, mode = 'full') {
    let enqueue = renderQueues.get(element);
    if (!enqueue) {
        renderGenerations.set(element, (renderGenerations.get(element) || 0) + 1);
        enqueue = createLatestTaskRunner(drawECharts, (error) => {
            logger.error('Chart render failed:', error);
        });
        renderQueues.set(element, enqueue);
    }
    enqueue({ element, traces, layout, mode, generation: renderGenerations.get(element) });
}

async function disposeECharts(element) {
    const generation = (renderGenerations.get(element) || 0) + 1;
    renderGenerations.set(element, generation);
    const enqueue = renderQueues.get(element);
    renderQueues.delete(element);
    await enqueue?.dispose();
    if (renderGenerations.get(element) !== generation) return;
    try {
        destroyChart(element);
    } finally {
        renderGenerations.delete(element);
    }
}

function renderMain(traces, layout, mode = 'full') {
    latestMainRender = { traces, layout, mode };
    const element = getChartElement();
    if (!element || element.offsetParent === null || expandedOpen) {
        mainRenderDirty = true;
        return;
    }
    renderECharts(element, traces, layout, mode);
    mainRenderDirty = false;
}

function flushMainRender() {
    if (mainRenderDirty && latestMainRender && !expandedOpen) {
        renderMain(latestMainRender.traces, latestMainRender.layout, latestMainRender.mode);
    }
}

function getChartElement() {
    const mainPage = document.getElementById('main-page');
    if (mainPage?.style.display === 'none') {
        return document.getElementById('subpage-host')?.querySelector('#plotly-chart') ?? null;
    }
    return mainPage?.querySelector('#plotly-chart') ?? null;
}

// profile_selector.html (and other subpages) carry their own #plotly-chart
// with the same id, so it stays visible (has an offsetParent) even while the
// main page's own chart is hidden behind it. Anything that repaints from the
// shared chartTraces/layout globals -- which only ever hold the main page's
// shot data -- must check THIS, not element.offsetParent, before repainting,
// or it clobbers whatever the subpage (e.g. a profile preview) just drew.
function isMainChartActive() {
    return document.getElementById('main-page')?.style.display !== 'none';
}
let currentSubstate = 'idle';
let previousSubstateForShape = 'idle'; // To track step changes for vertical lines
let lastWeight = 0;
let lastTime = 0;
const SMOOTHING_FACTOR = 0.1;
let smoothedWeightChange = 0;
// Previous target values, so at a step boundary we can anchor the old value at
// the new time and render a vertical jump (e.g. pressure→flow swap) instead of a
// diagonal — without stair-stepping smooth in-step ramps. null = no prior frame.
let lastTargetPressureY = null;
let lastTargetFlowY = null;

// Base chart data with light mode defaults
const baseChartData = {
    pressure: {
        x: [],
        y: [],
        name: 'Pressure',
        type: 'scatter',
        mode: 'lines',
        line: { color: '#17c29a' },
        hoverinfo: 'name'
    },
    flow: {
        x: [],
        y: [],
        name: 'Flow',
        type: 'scatter',
        mode: 'lines',
        line: { color: '#0358cf' },
        hoverinfo: 'name'
    },
    targetPressure: {
        x: [],
        y: [],
        name: 'Target Pressure',
        type: 'scatter',
        mode: 'lines',
        line: { color: '#bde2d5', dash: 'dot' },
        hoverinfo: 'name'
    },
    targetFlow: {
        x: [],
        y: [],
        name: 'Target Flow',
        type: 'scatter',
        mode: 'lines',
        line: { color: '#cdd9f5', dash: 'dot' },
        hoverinfo: 'name'
    },
    groupTemperature: {
        x: [],
        y: [],
        name: '°C',
        type: 'scatter',
        mode: 'lines',
        line: {color: '#ff97a1'},
        hoverinfo: 'name'
    },
    targetTemperature: {
        x: [],
        y: [],
        name: 'Target °C',
        type: 'scatter',
        mode: 'lines',
        line: { color: '#F9ebec', dash: 'dot' },
        hoverinfo: 'name'
    },
    weight: {
        x: [],
        y: [],
        name: 'Weight',
        type: 'scatter',
        mode: 'lines',
        line: { color: '#D8BDA8' }, // light mode
        hoverinfo: 'name'
    }
};

// Create chartData with initial values
const chartData = JSON.parse(JSON.stringify(baseChartData));
const chartTraces = Object.values(chartData);

// ============================================================================
// Expanded (full-screen) live charts.
// Tapping the main chart opens a full-screen overlay with two stacked plots:
//   TOP    (2/3 height) = Pressure / Flow / their targets / GFlow, on one axis
//                         with a damped auto Y-max (grows to fit up to ~20+ ml/s,
//                         never snaps around) so fast flows are visible.
//   BOTTOM (1/3 height) = Group + Mix temperature vs their targets, on a
//                         +5/−10 °C band around every GROUP target seen this
//                         shot (target 80 -> 70..85; if it then drops to 70 the
//                         band widens to 60..85), hard-capped at 105 °C. Every
//                         other line (group actual, mix actual, mix target)
//                         only widens the band so it never clips; only the
//                         group target anchors it — the mix "target" is really
//                         the DE1's servo setpoint and would wreck the band.
// Fed from the SAME live frames as the main chart, plus a rebuild from chartData
// when a historical shot is loaded — so it always mirrors what's on screen.
// The band/axis maths live in chart-autoscale.js (DOM-free, node-tested).
// ============================================================================
let expandedOpen = false;      // overlay currently visible
let expandedTopYMax = EXP_TOP_FLOOR;  // damped, monotonic-within-shot top-axis max
let helpBtnPrevDisplay = '';   // help FAB display value to restore when overlay closes
let expandedMixTemp = { x: [], y: [] };
let expandedTargetMixTemp = { x: [], y: [] };
let expandedTargetTempMin = Infinity;
let expandedTargetTempMax = -Infinity;
let expandedTempMin = Infinity;
let expandedTempMax = -Infinity;
let expandedLastGroupTemp = 90;

const baseLayout = {
    plot_bgcolor: '#0d0e14',
    paper_bgcolor: '#0d0e14',
    font: { color: '#606579', size: 20 },
    shapes: [], // Initialize shapes array for vertical lines
    xaxis: {
        gridcolor: '#3D4255',
        linecolor: '#606579',
        tickcolor: '#606579',
        dtick: 1,
        fixedrange: true
    },
    yaxis: {
        gridcolor: '#3D4255',
        linecolor: '#606579',
        tickcolor: '#606579',
        range: [0, 10],
        dtick: 1,
        fixedrange: true
    },
    autosize: true,
    margin: {
        autoexpand: true,
        l: 50,
        r: 50,
        t: 20,
        b: 40,
        pad: 0
    },
    showlegend: false,
};

const lightLayout = {
    ...baseLayout,
    plot_bgcolor: 'white',
    paper_bgcolor: 'white',
    font: { color: '#959595', size: 20 },
    xaxis: {
        ...baseLayout.xaxis,
        gridcolor: '#E0E0E0',
        linecolor: '#959595',
        tickcolor: '#959595'
    },
    yaxis: {
        ...baseLayout.yaxis,
        gridcolor: '#E0E0E0',
        linecolor: '#959595',
        tickcolor: '#959595'
    }
};

const darkLayout = { ...baseLayout };

const labelColors = {
    light: {
        pressure: '#17c29a',
        flow: '#0358cf',
        groupTemperature: '#ff97a1',
        weight: '#C7A58D'
    },
    dark: {
        pressure: '#17c29a',
        flow: '#0358cf',
        groupTemperature: '#AE6D73',
        weight: '#695f57'
    }
};

const LABEL_FONT_SIZE = 16;
const LABEL_FONT_CSS = `${LABEL_FONT_SIZE}px Inter, sans-serif`;
const LABEL_X_GAP = 6;     // px between line end and label text
const LABEL_X_PAD = 10;    // px breathing room past the widest label

let _measureCanvasCtx = null;
const measuredLabelWidths = new Map();
function measureTextWidth(text) {
    if (measuredLabelWidths.has(text)) return measuredLabelWidths.get(text);
    if (!_measureCanvasCtx) {
        const canvas = document.createElement('canvas');
        _measureCanvasCtx = canvas.getContext('2d');
    }
    _measureCanvasCtx.font = LABEL_FONT_CSS;
    const width = _measureCanvasCtx.measureText(text).width;
    measuredLabelWidths.set(text, width);
    return width;
}

// Plot pixel width (between left and right margin). Falls back to a sensible
// default when the chart element is hidden or hasn't been measured yet —
// returning a tiny value here would blow up `rangeMaxForLabels`.
const DEFAULT_PLOT_PX_WIDTH = 1360; // baseline 1460 chart - margin.l(50) - margin.r(50)
let observedChartSize = { width: 0, height: 0 };
function getPlotPixelWidth() {
    const usable = observedChartSize.width - 100; // baseLayout margin.l + margin.r
    return usable > 200 ? usable : DEFAULT_PLOT_PX_WIDTH;
}

const DEFAULT_PLOT_PX_HEIGHT = 590; // baseline 650 chart - margin.t(20) - margin.b(40)
function getPlotPixelHeight() {
    const usable = observedChartSize.height - 60;
    return usable > 100 ? usable : DEFAULT_PLOT_PX_HEIGHT;
}

const MIN_LABEL_SEP_PX = LABEL_FONT_SIZE + 2; // minimum vertical gap between label centers
const BOTTOM_EDGE_PAD_PX = 8;

// Y-axis is fixed [0, 10]. Returns label's natural pixel offset from plot top.
function dataYToPixelY(y, plotPxHeight) {
    return (10 - y) / 10 * plotPxHeight;
}

// Push labels apart vertically when they collide. Mutates `annotations` by
// setting `yshift` (negative px = moved DOWN from the trace endpoint).
function applyLabelCollisionAvoidance(annotations) {
    if (annotations.length < 2) return;
    const plotPxH = getPlotPixelHeight();
    const maxPxY = plotPxH - BOTTOM_EDGE_PAD_PX;

    const items = annotations.map(a => ({
        annotation: a,
        naturalPxY: dataYToPixelY(a.y, plotPxH)
    }));
    items.sort((a, b) => a.naturalPxY - b.naturalPxY); // top → bottom

    const positions = separateLabelPositions(
        items.map(item => item.naturalPxY),
        MIN_LABEL_SEP_PX,
        maxPxY
    );
    for (let i = 0; i < items.length; i++) {
        const shiftPx = positions[i] - items[i].naturalPxY;
        if (shiftPx !== 0) items[i].annotation.yshift = -shiftPx;
    }
}

// Given the data's x-max, return the range max that leaves room for the widest
// (translated) label INSIDE the plot area. Solved from
//   range = dataMax + labelPx * (range - rangeMin) / plotPxWidth
function rangeMaxForLabels(dataMax, rangeMin = 0) {
    let maxLabelPx = 0;
    for (const traceName in chartData) {
        if (traceName === 'targetPressure' || traceName === 'targetFlow' || traceName === 'targetTemperature') continue;
        const trace = chartData[traceName];
        if (trace.x.length === 0) continue;
        const w = measureTextWidth(getLabelText(traceName, trace.name));
        if (w > maxLabelPx) maxLabelPx = w;
    }
    if (maxLabelPx === 0) return dataMax;
    const padPx = maxLabelPx + LABEL_X_GAP + LABEL_X_PAD;
    const plotPxWidth = getPlotPixelWidth();
    const factor = Math.max(0.05, 1 - padPx / plotPxWidth);
    return rangeMin + (dataMax - rangeMin) / factor;
}

function getAnnotations() {
    const theme = currentTheme;
    const annotations = [];

    for (const traceName in chartData) {
        if (traceName === 'targetPressure' || traceName === 'targetFlow' || traceName === 'targetTemperature') continue;
        const trace = chartData[traceName];
        if (trace.x.length === 0) continue;

        annotations.push({
            x: trace.x[trace.x.length - 1],
            y: trace.y[trace.y.length - 1],
            xref: 'x',
            yref: 'y',
            text: getLabelText(traceName, trace.name),
            showarrow: false,
            xanchor: 'left',
            yanchor: 'middle',
            xshift: LABEL_X_GAP,
            font: {
                color: (labelColors[theme] && labelColors[theme][traceName]) ? labelColors[theme][traceName] : trace.line.color,
                size: LABEL_FONT_SIZE
            }
        });
    }

    applyLabelCollisionAvoidance(annotations);
    return annotations;
}

// Apply current labels + restore default right margin. Use before
// No labels while a shot is live — only once
// it's done (see isLiveShot below).
function applyLabelLayout(layout) {
    layout.annotations = isLiveShot ? [] : getAnnotations();
    layout.margin = { ...(layout.margin || {}), r: 50 };
}

function applyFinalXRange(layout) {
    let dataMax = 0;
    for (const traceName in chartData) {
        if (traceName === 'targetPressure' || traceName === 'targetFlow' || traceName === 'targetTemperature') continue;
        const trace = chartData[traceName];
        const lastX = trace.x[trace.x.length - 1];
        if (lastX > dataMax) dataMax = lastX;
    }
    if (dataMax === 0) {
        const { range: _range, ...xaxis } = layout.xaxis;
        layout.xaxis = { ...xaxis, autorange: true };
        return;
    }
    layout.xaxis = { ...layout.xaxis, range: [0, rangeMaxForLabels(dataMax)], autorange: false };
}

// True from shot start until finalizeLiveChart() runs at shot end — labels
// are suppressed entirely while true so a live shot shows no trace-end text.
let isLiveShot = false;

// Call when a shot finishes to reveal the trace-end labels on the chart that
// was just live.
export function finalizeLiveChart() {
    cancelChartFlush();
    liveRenderDirty = false;
    isLiveShot = false;
    const theme = currentTheme;
    const layout = theme === 'dark' ? darkLayout : lightLayout;
    applyLabelLayout(layout);
    applyFinalXRange(layout);
    renderMain(chartTraces, layout);
}

// Re-measure labels and refresh annotations + x-range so labels stay inside
// the plot area after the chart width changes (e.g. GHC column toggling).
export function refreshLabelMargin() {
    const element = getChartElement();
    if (!element || !hasChart(element)) return;
    // Hidden behind another page (e.g. settings, profile selector) -- skip.
    // offsetParent alone doesn't catch this: a subpage's own #plotly-chart is
    // visible too, so it'd pass that check and get clobbered with the main
    // page's stale chartTraces/layout. A hidden/foreign-page layout refresh
    // is non-cheap and has zero visible effect there, and every
    // streamline:languagechange fires this unconditionally regardless of
    // which page is actually showing.
    if ((element.offsetParent === null || !isMainChartActive()) && !expandedOpen) return;

    const theme = currentTheme;
    const layout = theme === 'dark' ? darkLayout : lightLayout;
    applyLabelLayout(layout);
    applyFinalXRange(layout);
    renderMain(chartTraces, layout);
}

// Helper function to add vertical lines for substate changes and annotations
function addStepMarker(layout, time, theme, stepName = '') {
    if (!layout.shapes) {
        layout.shapes = [];
    }
    layout.shapes.push({
        type: 'line',
        x0: time,
        x1: time,
        y0: 0,
        y1: 1,
        yref: 'paper',
        line: {
            color: theme === 'dark' ? STEP_MARKER_COLORS.dark : STEP_MARKER_COLORS.light, // ::state_change_color from skin.tcl
            width: 2,
            dash: 'longdash' // ::state_change_dashes from skin.tcl is dot equivalent
        }
    });

   
}

// Global variable to store the current profile for real-time step change detection
let currentProfile = null;
let liveProfileFrame = -1; // Track current profileFrame for live data
// let currentStepIndex = 0; // No longer needed for this logic
// let stepExitDetected = false; // No longer needed for this logic

let pendingTime = 0;
let redrawTimer = 0;
let redrawFrame = 0;
let lastRedrawAt = 0;
let liveRenderDirty = false;

function dtickForTime(time) {
    if (time < 15) return 1;
    if (time < 60) return 5;
    if (time < 100) return 20;
    return 30;
}

function liveXRange(time) {
    return time > 0 ? [0, time / LIVE_X_DATA_FRACTION] : [-1, 1];
}

function flushChart() {
    if (!hasVisibleChart()) {
        liveRenderDirty = true;
        return;
    }
    lastRedrawAt = performance.now();

    const theme = currentTheme;
    const dtickValue = dtickForTime(pendingTime);
    const layout = theme === 'dark' ? darkLayout : lightLayout;
    isLiveShot = true;
    applyLabelLayout(layout);
    const { range: _range, ...liveXAxis } = layout.xaxis;
    layout.xaxis = {
        ...liveXAxis,
        range: liveXRange(pendingTime),
        autorange: false,
        dtick: dtickValue
    };
    renderMain(chartTraces, layout, 'live');
    if (expandedOpen) renderExpandedCharts('live');
    liveRenderDirty = false;
}

function hasVisibleChart() {
    if (document.visibilityState === 'hidden') return false;
    if (expandedOpen) return true;
    // Same trap as refreshLabelMargin: a subpage (profile selector, etc.) has
    // its own visible #plotly-chart, so offsetParent alone can't tell it's
    // not the main page's live chart -- without this, a live shot update
    // would paint over whatever that subpage is currently showing.
    if (!isMainChartActive()) return false;
    const element = getChartElement();
    return Boolean(element && element.offsetParent !== null);
}

function cancelChartFlush() {
    if (redrawTimer) clearTimeout(redrawTimer);
    if (redrawFrame) cancelAnimationFrame(redrawFrame);
    redrawTimer = 0;
    redrawFrame = 0;
}

function scheduleChartFlush() {
    if (!hasVisibleChart()) {
        liveRenderDirty = true;
        return;
    }
    if (redrawTimer || redrawFrame) return;
    redrawTimer = setTimeout(() => {
        redrawTimer = 0;
        redrawFrame = requestAnimationFrame(() => {
            redrawFrame = 0;
            flushChart();
        });
    }, Math.max(0, CHART_REDRAW_INTERVAL_MS - (performance.now() - lastRedrawAt)));
}

function flushDeferredChart() {
    if (liveRenderDirty) scheduleChartFlush();
    else flushMainRender();
}

// ---- Expanded (full-screen) charts -----------------------------------------

function resetExpandedData() {
    expandedMixTemp = { x: [], y: [] };
    expandedTargetMixTemp = { x: [], y: [] };
    expandedTopYMax = EXP_TOP_FLOOR;
    expandedTargetTempMin = Infinity;
    expandedTargetTempMax = -Infinity;
    expandedTempMin = Infinity;
    expandedTempMax = -Infinity;
    expandedLastGroupTemp = 90;
}

function includeExpandedTemp(value) {
    if (!Number.isFinite(value)) return;
    expandedTempMin = Math.min(expandedTempMin, value);
    expandedTempMax = Math.max(expandedTempMax, value);
}

function includeExpandedTargetTemp(value) {
    if (!Number.isFinite(value) || value <= 0) return;
    expandedTargetTempMin = Math.min(expandedTargetTempMin, value);
    expandedTargetTempMax = Math.max(expandedTargetTempMax, value);
}

function pushExpandedFrame(time, data) {
    if (Number.isFinite(data.groupTemperature)) {
        expandedLastGroupTemp = data.groupTemperature;
        includeExpandedTemp(data.groupTemperature);
    }
    includeExpandedTargetTemp(data.targetGroupTemperature);
    if (Number.isFinite(data.mixTemperature)) {
        expandedMixTemp.x.push(time);
        expandedMixTemp.y.push(data.mixTemperature / 10);
        includeExpandedTemp(data.mixTemperature);
    }
    if (Number.isFinite(data.targetMixTemperature) && data.targetMixTemperature > 0) {
        expandedTargetMixTemp.x.push(time);
        expandedTargetMixTemp.y.push(data.targetMixTemperature / 10);
        includeExpandedTemp(data.targetMixTemperature);
    }
}

function rebuildExpandedFromChartData(mixSeries = null, mixTargetSeries = null) {
    resetExpandedData();
    for (const value of chartData.groupTemperature.y) includeExpandedTemp(value * 10);
    if (chartData.groupTemperature.y.length) {
        expandedLastGroupTemp = chartData.groupTemperature.y[chartData.groupTemperature.y.length - 1] * 10;
    }
    for (const value of chartData.targetTemperature.y) includeExpandedTargetTemp(value * 10);
    if (mixSeries) {
        expandedMixTemp = { x: mixSeries.x.slice(), y: mixSeries.y.map(value => value / 10) };
        for (const value of mixSeries.y) includeExpandedTemp(value);
    }
    if (mixTargetSeries) {
        expandedTargetMixTemp = { x: mixTargetSeries.x.slice(), y: mixTargetSeries.y.map(value => value / 10) };
        for (const value of mixTargetSeries.y) includeExpandedTemp(value);
    }
    if (expandedOpen) renderExpandedCharts();
}

function expandedAxisColors(theme) {
    const dark = theme === 'dark';
    return {
        paper: dark ? '#0d0e14' : '#ffffff',
        grid: dark ? '#3D4255' : '#E0E0E0',
        line: dark ? '#606579' : '#959595',
        font: dark ? '#9aa0b3' : '#606579',
    };
}

function expandedTemperatureRange() {
    const targets = Number.isFinite(expandedTargetTempMin)
        ? [expandedTargetTempMin, expandedTargetTempMax]
        : [];
    const temperatures = Number.isFinite(expandedTempMin)
        ? [expandedTempMin, expandedTempMax, expandedLastGroupTemp]
        : [];
    return computeExpandedTempRange(targets, temperatures);
}

function expandedTemperatureTicks(range) {
    const values = [];
    const text = [];
    for (let value = Math.ceil(range[0] / 2) * 2; value <= range[1]; value += 2) {
        values.push(value / 10);
        text.push(`${value}°`);
    }
    return { values, text };
}

function expandedShapes(theme) {
    return ((theme === 'dark' ? darkLayout : lightLayout).shapes || []).flatMap(shape => [
        { ...shape, xref: 'x', yref: 'y domain', line: { ...shape.line } },
        { ...shape, xref: 'x2', yref: 'y2 domain', line: { ...shape.line } }
    ]);
}

function expandedLayout(theme, topRange, tempRange, xRange) {
    const c = expandedAxisColors(theme);
    const ticks = expandedTemperatureTicks(tempRange);
    return {
        paper_bgcolor: c.paper,
        plot_bgcolor: c.paper,
        font: { color: c.font, size: 18 },
        margin: { l: 70, r: 28, t: 88, b: 52, pad: 0 },
        xaxis: {
            gridcolor: c.grid, linecolor: c.line, tickcolor: c.line,
            fixedrange: true, range: xRange, autorange: !xRange, zeroline: false, domain: [0, 1], anchor: 'y'
        },
        yaxis: {
            gridcolor: c.grid, linecolor: c.line, tickcolor: c.line,
            fixedrange: true, range: topRange, zeroline: false, domain: [0.46, 1], anchor: 'x'
        },
        xaxis2: {
            gridcolor: c.grid, linecolor: c.line, tickcolor: c.line,
            fixedrange: true, range: xRange, autorange: !xRange, zeroline: false, domain: [0, 1], anchor: 'y2', matches: 'x',
            title: { text: 'seconds', font: { size: 15 } }
        },
        yaxis2: {
            gridcolor: c.grid, linecolor: c.line, tickcolor: c.line,
            fixedrange: true, range: tempRange.map(value => value / 10), zeroline: false,
            domain: [0, 0.30], anchor: 'x2', tickvals: ticks.values, ticktext: ticks.text
        },
        shapes: expandedShapes(theme),
        showlegend: true,
        legend: { orientation: 'h', y: 1.04, yanchor: 'bottom', x: 0, xanchor: 'left', font: { size: 26 } },
        legend2: { orientation: 'h', y: 0.37, yanchor: 'bottom', x: 0, xanchor: 'left', font: { size: 26 } },
        autosize: true
    };
}

function expandedTopTraces() {
    return [
        { ...chartData.pressure, name: getTranslation('Pressure (bar)'), line: { color: '#17c29a', width: 3 }, hoverinfo: 'skip' },
        { ...chartData.flow, name: getTranslation('Flow (ml/s)'), line: { color: '#0358cf', width: 3 }, hoverinfo: 'skip' },
        { ...chartData.weight, name: getTranslation('GFlow (g/s)'), line: { color: '#C7A58D', width: 3 }, hoverinfo: 'skip' },
        { ...chartData.targetPressure, name: getTranslation('Target Pressure'), line: { color: '#8fd3bf', dash: 'dot', width: 2 }, hoverinfo: 'skip' },
        { ...chartData.targetFlow, name: getTranslation('Target Flow'), line: { color: '#7fa8ec', dash: 'dot', width: 2 }, hoverinfo: 'skip' }
    ];
}

function expandedTempTraces() {
    const traces = [
        { ...chartData.groupTemperature, name: `${getTranslation('Group')} °C`, line: { color: '#ff97a1', width: 3 }, hoverinfo: 'skip', xaxis: 'x2', yaxis: 'y2', legend: 'legend2' },
        { ...expandedMixTemp, name: `${getTranslation('Mix')} °C`, type: 'scatter', mode: 'lines', line: { color: '#d9822b', width: 3 }, hoverinfo: 'skip', xaxis: 'x2', yaxis: 'y2', legend: 'legend2' },
        { ...chartData.targetTemperature, name: getTranslation('Group Target °C'), line: { color: '#f0b8bd', dash: 'dot', width: 2 }, hoverinfo: 'skip', xaxis: 'x2', yaxis: 'y2', legend: 'legend2' }
    ];
    if (expandedTargetMixTemp.y.length) {
        traces.push({
            ...expandedTargetMixTemp, name: getTranslation('Mix Target °C'), type: 'scatter', mode: 'lines',
            line: { color: '#e8b480', dash: 'dash', width: 2 }, hoverinfo: 'skip',
            xaxis: 'x2', yaxis: 'y2', legend: 'legend2'
        });
    }
    return traces;
}

const expandedInteractionCallbacks = new WeakMap();

function expandedTopSeriesYs() {
    return [
        chartData.pressure.y,
        chartData.flow.y,
        chartData.weight.y,
        chartData.targetPressure.y,
        chartData.targetFlow.y
    ];
}

function rescaleExpandedTop(element) {
    const visibility = getSeriesVisibility(element, 5);
    if (!visibility) return;
    expandedTopYMax = computeExpandedTopYMax(pickVisible(expandedTopSeriesYs(), visibility), 0);
    setYAxisRange(element, [0, expandedTopYMax]);
}

function ensureExpandedInteractions(element) {
    if (element.id !== 'expanded-chart' || !hasChart(element)) return;
    let callback = expandedInteractionCallbacks.get(element);
    if (!callback) {
        callback = event => {
            const topNames = expandedTopTraces().map(trace => trace.name);
            if (!topNames.some(name => event.selected[name] !== false)) selectSeries(element, topNames);
            rescaleExpandedTop(element);
        };
        expandedInteractionCallbacks.set(element, callback);
    }
    onLegendChange(element, callback);
}

function renderExpandedCharts(mode = 'full') {
    if (!expandedOpen) return;
    const element = document.getElementById('expanded-chart');
    if (!element) return;
    const theme = currentTheme;
    const visibility = getSeriesVisibility(element, 5);
    expandedTopYMax = computeExpandedTopYMax(pickVisible(expandedTopSeriesYs(), visibility), expandedTopYMax);
    const layout = expandedLayout(theme, [0, expandedTopYMax], expandedTemperatureRange(), mode === 'live' ? liveXRange(pendingTime) : undefined);
    renderECharts(element, [...expandedTopTraces(), ...expandedTempTraces()], layout, mode);
}

export function isExpandedChartOpen() { return expandedOpen; }

export function openExpandedChart() {
    const overlay = document.getElementById('expanded-chart-overlay');
    if (!overlay) return;
    expandedOpen = true;
    overlay.style.display = 'flex';
    // The help FAB floats above everything (z-8000, outside the scaled container);
    // tuck it away for a clean full-screen view, remembering its prior state.
    const help = document.getElementById('help-overlay-btn');
    if (help) { helpBtnPrevDisplay = help.style.display; help.style.display = 'none'; }
    // Plot after the browser has laid the containers out at real size.
    requestAnimationFrame(() => {
        const element = document.getElementById('expanded-chart');
        if (element) observeChartElement(element);
        renderExpandedCharts();
        requestAnimationFrame(() => resizeChart(element));
    });
}

export function closeExpandedChart() {
    expandedOpen = false;
    const overlay = document.getElementById('expanded-chart-overlay');
    if (overlay) overlay.style.display = 'none';
    const help = document.getElementById('help-overlay-btn');
    if (help) help.style.display = helpBtnPrevDisplay;
    const element = document.getElementById('expanded-chart');
    if (element) void disposeECharts(element).catch(error => logger.error('Chart cleanup failed:', error));
    const mainElement = getChartElement();
    if (mainElement) observeChartElement(mainElement);
    flushMainRender();
}

export function setCurrentProfile(profile) {
    currentProfile = profile;
    resetProfileTracking(); // Encapsulate the reset logic
}

function resetProfileTracking() {
    liveProfileFrame = -1;
    // Reset any other tracking variables if needed
}

// Helper function to handle profile frame changes
function handleProfileFrameChange(currentFrame, time, profile, theme) {
    if (!profile || !profile.steps || currentFrame === undefined || currentFrame === null) {
        return false;
    }
    
    let stepMarkerAdded = false;
    
    // Handle first step detection (when starting a new shot)
    if (liveProfileFrame === -1) {
        // If first data has profileFrame > 0, draw markers for all skipped steps at time 0
        if (currentFrame > 0) {
            for (let i = 0; i < currentFrame && i < profile.steps.length; i++) {
                const stepName = profile.steps[i].name;
                const layout = theme === 'dark' ? darkLayout : lightLayout;
                addStepMarker(layout, 0, theme, stepName);
            }
        }
        // Draw marker for the current step at time 0 (shot start)
        // This ensures the first step marker is always at x=0, even if profileFrame
        // data arrives late (e.g., first data point doesn't have profileFrame set)
        const stepName = profile.steps[currentFrame].name;
        const layout = theme === 'dark' ? darkLayout : lightLayout;
        addStepMarker(layout, 0, theme, stepName);

        liveProfileFrame = currentFrame;
        stepMarkerAdded = true;
    } else if (currentFrame !== liveProfileFrame && currentFrame >= 0 && currentFrame < profile.steps.length) {
        // Normal step change during the shot
        const stepName = profile.steps[currentFrame].name;
        const layout = theme === 'dark' ? darkLayout : lightLayout;
        addStepMarker(layout, time, theme, stepName);
        liveProfileFrame = currentFrame;
        stepMarkerAdded = true;
    }
    
    return stepMarkerAdded;
}

export function updateChart(shotStartTime, data, weight, weightFlow = null, filterToPouring = true) {
    if (data && data.state && data.state.substate) {
        currentSubstate = data.state.substate;
    }

    const time = (new Date(data.timestamp) - shotStartTime) / 1000;
    const theme = currentTheme;
    let stepMarkerAdded = false;

    // New logic: Add vertical line and annotation at the start of each step based on profileFrame
    if (currentProfile && currentProfile.steps && data.profileFrame !== undefined && data.profileFrame !== null) {
        // logger.debug(`updateChart: profileFrame=${data.profileFrame}, time=${time.toFixed(2)}s, liveProfileFrame=${liveProfileFrame}, substate=${data.state.substate}`);
        if (handleProfileFrameChange(data.profileFrame, time, currentProfile, theme)) {
            stepMarkerAdded = true;
            // logger.debug(`updateChart: step marker added at time=${time.toFixed(2)}s`);
        }
    }


    if (filterToPouring) {
        const espressoStates = ['preinfusion', 'pouring'];
        if (!espressoStates.includes(data.state.substate)) {
            return;
        }
    }
    const pressureY = data.pressure;
    const flowY = data.flow;
    const targetPressureY = data.targetPressure;
    const targetFlowY = data.targetFlow;
    const groupTemperatureY = (data.groupTemperature / 100) * 10;

    // Prefer the server's smoothed weightFlow (g/s) from ScaleSnapshot. Fall back
    // to a local delta+EMA only when it's absent (older middleware / no scale frame).
    let weightY = 0;
    if (weightFlow !== null && weightFlow !== undefined) {
        weightY = weightFlow;
        smoothedWeightChange = weightFlow; // keep EMA seeded if we later fall back
    } else if (lastTime > 0 && time > lastTime) {
        const timeDiff = time - lastTime;
        const rawWeightChange = (weight - lastWeight) / timeDiff;
        smoothedWeightChange = (SMOOTHING_FACTOR * rawWeightChange) + (1 - SMOOTHING_FACTOR) * smoothedWeightChange;
        weightY = smoothedWeightChange;
    }
    lastWeight = weight;
    lastTime = time;

    // At a step boundary, anchor each target's PREVIOUS value at this x before the
    // new value is pushed below. That makes a pump-mode swap (pressure 8→0 / flow
    // 0→8) draw as a vertical step. Only fires on step changes, so smooth in-step
    // target ramps keep their diagonal. Step frames take the full-react flush path,
    // so writing to chartData here is enough — every flush draws from chartData.
    if (stepMarkerAdded && lastTargetPressureY !== null) {
        chartData.targetPressure.x.push(time);
        chartData.targetPressure.y.push(lastTargetPressureY);
        chartData.targetFlow.x.push(time);
        chartData.targetFlow.y.push(lastTargetFlowY);
    }

    chartData.pressure.x.push(time);
    chartData.pressure.y.push(pressureY);
    chartData.flow.x.push(time);
    chartData.flow.y.push(flowY);
    chartData.targetPressure.x.push(time);
    chartData.targetPressure.y.push(targetPressureY);
    chartData.targetFlow.x.push(time);
    chartData.targetFlow.y.push(targetFlowY);
    chartData.groupTemperature.x.push(time);
    chartData.groupTemperature.y.push(groupTemperatureY);
    if (Number.isFinite(data.targetGroupTemperature) && data.targetGroupTemperature > 0) {
        chartData.targetTemperature.x.push(time);
        chartData.targetTemperature.y.push(data.targetGroupTemperature / 10);
    }
    chartData.weight.x.push(time);
    chartData.weight.y.push(weightY);

    lastTargetPressureY = targetPressureY;
    lastTargetFlowY = targetFlowY;

    pendingTime = time;
    isLiveShot = true;
    // Mirror this frame into the expanded (full-screen) charts, in real units.
    pushExpandedFrame(time, data);
    scheduleChartFlush();
}

// Reset all chart data/tracking/layout state without touching the renderer. Callers
// that redraw themselves right after (plotHistoricalShot) use this to avoid
// painting an empty chart just to overwrite it.
function resetChartState() {
    // Clear all chart data arrays
    for (const trace in chartData) {
        chartData[trace].x = [];
        chartData[trace].y = [];
    }

    // Reset all tracking variables
    lastWeight = 0;
    lastTime = 0;
    smoothedWeightChange = 0;
    lastTargetPressureY = null;
    lastTargetFlowY = null;
    previousSubstateForShape = 'idle';
    liveProfileFrame = -1;  // FIX: Reset profile frame tracking
    currentSubstate = 'idle';  // FIX: Reset substate

    // Cancel a queued flush so a stale draw from the previous shot can't land
    // on the freshly cleared chart.
    cancelChartFlush();
    lastRedrawAt = 0;
    liveRenderDirty = false;
    isLiveShot = false;
    resetExpandedData();

    // Clear shapes and annotations from BOTH layouts
    // This prevents issues when theme is switched between shots
    darkLayout.shapes = [];
    lightLayout.shapes = [];
    darkLayout.annotations = [];
    lightLayout.annotations = [];
}

export function clearChart() {
    resetChartState();

    const theme = currentTheme;
    const layout = theme === 'dark' ? darkLayout : lightLayout;

    const element = getChartElement();
    if (!element) {
        console.error('clearChart: chartElement not found in DOM');
        return;
    }
    applyLabelLayout(layout);
    layout.xaxis = { ...layout.xaxis, autorange: true };
    renderMain(chartTraces, layout);
    if (expandedOpen) renderExpandedCharts();
}

export function plotHistoricalShot(measurements, workflow = null) {
    if (!measurements || measurements.length === 0) {
        clearChart();
        return;
    }

    // Reset state only — we render once at the end, so skip clearChart's two
    // throwaway redraws of an empty chart.
    resetChartState();

    let shotStartTime = null;

    for (const dataPoint of measurements) {
        const machineData = dataPoint.machine;
        if (machineData && machineData.state && (machineData.state.substate === 'preinfusion' || machineData.state.substate === 'pouring' )) {
            shotStartTime = new Date(machineData.timestamp);
            break;
        }
    }

    if (!shotStartTime) {
        console.warn("plotHistoricalShot: Could not find a starting data point (preinfusion/pouring) to begin the chart at t=0.");
        const firstPoint = measurements.find(p => (p.machine && p.machine.timestamp) || (p.scale && p.scale.timestamp));
        if (firstPoint) {
            const machineTs = firstPoint.machine && new Date(firstPoint.machine.timestamp);
            const scaleTs = firstPoint.scale && new Date(firstPoint.scale.timestamp);
            shotStartTime = (machineTs && scaleTs) ? (machineTs < scaleTs ? machineTs : scaleTs) : (machineTs || scaleTs);
        } else {
            console.error("plotHistoricalShot: No timestamps found in any measurements.");
            return;
        }
    }

    let shotEndTime = null;
    for (let i = measurements.length - 1; i >= 0; i--) {
        const machineData = measurements[i].machine;
        if (machineData && machineData.state && (machineData.state.substate === 'preinfusion' || machineData.state.substate === 'pouring')) {
            shotEndTime = new Date(machineData.timestamp);
            break;
        }
    }

    const tempChartData = {
        pressure: { x: [], y: [] },
        flow: { x: [], y: [] },
        targetPressure: { x: [], y: [] },
        targetFlow: { x: [], y: [] },
        groupTemperature: { x: [], y: [] },
        targetTemperature: { x: [], y: [] },
        weight: { x: [], y: [] }
    };

    // A record from a machine that reports its own gravimetric flow persists it
    // on every machine frame (machine.weightFlow) -- the exact series the live
    // chart plotted. Source the GFlow trace from it so the post-shot repaint
    // matches the live trace; every other record keeps the scale-sourced chain.
    const useMachineGFlow = hasMachineGFlow(measurements);
    const resolveScaleFlow = createScaleFlowResolver(SMOOTHING_FACTOR);

    // Mix Temp + Mix Target for the EXPANDED overlay only (real °C, NOT
    // /10-scaled): the main chart deliberately has no mix traces, so these must
    // stay out of chartData/tempChartData (extendTraces index map [0..5] would
    // corrupt). Shots recorded before the field existed simply leave histMixTarget
    // empty, and the trace is then omitted.
    const histMix = { x: [], y: [] };
    const histMixTarget = { x: [], y: [] };

    let historicalCurrentProfileFrame = -1; // Track current profileFrame for historical data
    // Phase of the most recent machine frame, carried forward so SCALE frames get
    // gated the same way every other trace is. See historical-gflow.js.
    const phase = createPourPhaseTracker();
    let histLastTargetPressure = null;      // for the vertical-jump anchor at step boundaries
    let histLastTargetFlow = null;

    // If workflow is provided, use step exit conditions for vertical lines
    if (workflow && workflow.profile && workflow.profile.steps) {
        const steps = workflow.profile.steps;
        const theme = currentTheme;
        const layout = theme === 'dark' ? darkLayout : lightLayout;

        for (const dataPoint of measurements) {
            const machineData = dataPoint.machine;
            const scaleData = dataPoint.scale;

            if (machineData && machineData.state && machineData.state.substate) {
                const currentState = machineData.state.substate;
                const time = (new Date(machineData.timestamp) - shotStartTime) / 1000;

                // Only add data points during espresso phases
                if (phase.observe(currentState)) {
                    if (time >= 0) {
                        tempChartData.pressure.x.push(time);
                        tempChartData.pressure.y.push(machineData.pressure);
                        tempChartData.flow.x.push(time);
                        tempChartData.flow.y.push(machineData.flow);
                        // Step boundary: anchor previous target values at this x so a
                        // pump-mode swap renders as a vertical step (mirrors live chart).
                        if (machineData.profileFrame !== undefined && machineData.profileFrame !== null &&
                            machineData.profileFrame !== historicalCurrentProfileFrame && histLastTargetPressure !== null) {
                            tempChartData.targetPressure.x.push(time);
                            tempChartData.targetPressure.y.push(histLastTargetPressure);
                            tempChartData.targetFlow.x.push(time);
                            tempChartData.targetFlow.y.push(histLastTargetFlow);
                        }
                        tempChartData.targetPressure.x.push(time);
                        tempChartData.targetPressure.y.push(machineData.targetPressure);
                        tempChartData.targetFlow.x.push(time);
                        tempChartData.targetFlow.y.push(machineData.targetFlow);
                        histLastTargetPressure = machineData.targetPressure;
                        histLastTargetFlow = machineData.targetFlow;
                        tempChartData.groupTemperature.x.push(time);
                        tempChartData.groupTemperature.y.push((machineData.groupTemperature / 100) * 10);
                        tempChartData.targetTemperature.x.push(time);
                        tempChartData.targetTemperature.y.push((machineData.targetGroupTemperature / 100) * 10);
                        // GFlow from the machine frames: same source, same
                        // timestamps/cadence, same pouring-only gating as live.
                        if (useMachineGFlow && typeof machineData.weightFlow === 'number' && isFinite(machineData.weightFlow)) {
                            tempChartData.weight.x.push(time);
                            tempChartData.weight.y.push(machineData.weightFlow);
                        }
                        if (typeof machineData.mixTemperature === 'number' && isFinite(machineData.mixTemperature)) {
                            histMix.x.push(time); histMix.y.push(machineData.mixTemperature); // real °C
                        }
                        // >0 gate mirrors the live path: a reported 0 °C target is
                        // "no target", not a real setpoint, and would drag the band down.
                        if (typeof machineData.targetMixTemperature === 'number' && machineData.targetMixTemperature > 0) {
                            histMixTarget.x.push(time); histMixTarget.y.push(machineData.targetMixTemperature); // real °C
                        }
                    }

                    // New logic: Add vertical line and annotation at the start of each step based on profileFrame
                    if (machineData.profileFrame !== undefined && machineData.profileFrame !== null &&
                        machineData.profileFrame !== historicalCurrentProfileFrame &&
                        machineData.profileFrame >= 0 && machineData.profileFrame < steps.length) {
                        historicalCurrentProfileFrame = machineData.profileFrame;
                        const stepName = steps[machineData.profileFrame].name;
                        addStepMarker(layout, time, theme, stepName);
                    }
                }
            }


            // phase.inPour: this branch sits outside the substate check every
            // other trace obeys, so without it the scale-sourced GFlow line was
            // drawn past where pressure and flow stop — and, on a record whose
            // machine frames carry no substate at all, drawn alone across the
            // whole record (shotEndTime is null there, so the bound below never
            // applies either). The live path and the machine-sourced GFlow above
            // are both pouring-only; this was the one source that disagreed.
            if (phase.inPour && !useMachineGFlow && scaleData && scaleData.weight) {
                const scaleTimestamp = new Date(scaleData.timestamp);
                if (shotEndTime && scaleTimestamp > shotEndTime) {
                    continue;
                }
                const time = (scaleTimestamp - shotStartTime) / 1000;
                if (time >= 0) {
                    // Prefer the stored server weightFlow (g/s); fall back to a local
                    // delta+EMA for older records that don't carry it.
                    tempChartData.weight.x.push(time);
                    tempChartData.weight.y.push(resolveScaleFlow(scaleData, time));
                }
            }
        }
    } else {
        // Fallback to original behavior if no workflow is provided
        // But only add data points, no vertical lines for substate changes
        for (const dataPoint of measurements) {
            const machineData = dataPoint.machine;
            const scaleData = dataPoint.scale;

            // Process machine data
            if (machineData && machineData.state && machineData.state.substate) {
                const currentState = machineData.state.substate;

                // Only add data points during espresso phases
                if (phase.observe(currentState)) {
                    const time = (new Date(machineData.timestamp) - shotStartTime) / 1000;
                    if (time >= 0) {
                        tempChartData.pressure.x.push(time);
                        tempChartData.pressure.y.push(machineData.pressure);
                        tempChartData.flow.x.push(time);
                        tempChartData.flow.y.push(machineData.flow);
                        tempChartData.targetPressure.x.push(time);
                        tempChartData.targetPressure.y.push(machineData.targetPressure);
                        tempChartData.targetFlow.x.push(time);
                        tempChartData.targetFlow.y.push(machineData.targetFlow);
                        tempChartData.groupTemperature.x.push(time);
                        tempChartData.groupTemperature.y.push((machineData.groupTemperature / 100) * 10);
                        tempChartData.targetTemperature.x.push(time);
                        tempChartData.targetTemperature.y.push((machineData.targetGroupTemperature / 100) * 10);
                        // GFlow from the machine frames: same source, same
                        // timestamps/cadence, same pouring-only gating as live.
                        if (useMachineGFlow && typeof machineData.weightFlow === 'number' && isFinite(machineData.weightFlow)) {
                            tempChartData.weight.x.push(time);
                            tempChartData.weight.y.push(machineData.weightFlow);
                        }
                        if (typeof machineData.mixTemperature === 'number' && isFinite(machineData.mixTemperature)) {
                            histMix.x.push(time); histMix.y.push(machineData.mixTemperature); // real °C
                        }
                        // >0 gate mirrors the live path: a reported 0 °C target is
                        // "no target", not a real setpoint, and would drag the band down.
                        if (typeof machineData.targetMixTemperature === 'number' && machineData.targetMixTemperature > 0) {
                            histMixTarget.x.push(time); histMixTarget.y.push(machineData.targetMixTemperature); // real °C
                        }
                    }
                }
            }

            // Pouring-gated for the same reason as the loop above.
            if (phase.inPour && !useMachineGFlow && scaleData && scaleData.weight) {
                const scaleTimestamp = new Date(scaleData.timestamp);
                if (shotEndTime && scaleTimestamp > shotEndTime) {
                    continue;
                }
                const time = (scaleTimestamp - shotStartTime) / 1000;
                if (time >= 0) {
                    // Prefer the stored server weightFlow (g/s); fall back to a local
                    // delta+EMA for older records that don't carry it.
                    tempChartData.weight.x.push(time);
                    tempChartData.weight.y.push(resolveScaleFlow(scaleData, time));
                }
            }
        }
    }

    Object.keys(tempChartData).forEach(key => {
        if(chartData[key]) {
            chartData[key].x = tempChartData[key].x;
            chartData[key].y = tempChartData[key].y;
        }
    });
    // x arrays are built in time order, so the last element is the max — no
    // need to spread the whole array through Math.max.
    // Mirror the loaded shot into the expanded (full-screen) charts too.
    rebuildExpandedFromChartData(histMix, histMixTarget);
    let maxTime = 0;
    for (const traceName in tempChartData) {
        const x = tempChartData[traceName].x;
        if (x.length > 0 && x[x.length - 1] > maxTime) {
            maxTime = x[x.length - 1];
        }
    }
    let dtickValue;
    if (maxTime < 10) {
        dtickValue = 1;
    } else if (maxTime < 60) {
        dtickValue = 5;
    } else if (maxTime < 100) {
        dtickValue = 20;
    } else {
        dtickValue = 30;
    }

    const theme = currentTheme;
    const layout = theme === 'dark' ? darkLayout : lightLayout;
    applyLabelLayout(layout);

    const element = getChartElement();
    if (!element) {
        console.error('plotHistoricalShot: chartElement not found in DOM');
        return;
    }
    if (maxTime > 0) {
        const rangeMax = rangeMaxForLabels(maxTime);
        layout.xaxis = {
            ...layout.xaxis,
            range: [0, rangeMax],
            autorange: false,
            dtick: dtickValue
        };
    } else {
        layout.xaxis = { ...layout.xaxis, autorange: true, dtick: dtickValue };
    }
    renderMain(chartTraces, layout);
}

// Helper function to check if exit condition is met
function checkExitCondition(machineData, exitCondition) {
    if (!exitCondition || !machineData) return false;

    const { type, condition, value } = exitCondition;

    switch (type) {
        case 'pressure':
            if (condition === 'over') return machineData.pressure > value;
            if (condition === 'under') return machineData.pressure < value;
            break;
        case 'flow':
            if (condition === 'over') return machineData.flow > value;
            if (condition === 'under') return machineData.flow < value;
            break;
        case 'temperature':
            if (condition === 'over') return machineData.mixTemperature > value;
            if (condition === 'under') return machineData.mixTemperature < value;
            break;
        case 'weight':
            // Weight is in scale data, not machine data
            // This would need to be handled differently
            break;
        case 'time':
            // Time-based exits would be handled differently
            break;
        default:
            return false;
    }

    return false;
}

export function plotProfile(profile) {
    if (!profile || !profile.steps || profile.steps.length === 0) {
        clearChart();
        return;
    }

    for (const trace in chartData) {
        chartData[trace].x = [];
        chartData[trace].y = [];
    }

    const tpX = chartData.targetPressure.x;
    const tpY = chartData.targetPressure.y;
    const tfX = chartData.targetFlow.x;
    const tfY = chartData.targetFlow.y;
    const tempX = chartData.groupTemperature.x;
    const tempY = chartData.groupTemperature.y;

    let currentTime = 0;
    // 'smooth' ramps from the channel's last value into the new target instead
    // of jumping there instantly; null means the channel was off (gap in the
    // line), so a ramp has nothing to ramp from and falls back to a jump.
    let prevPressure = 0;
    let prevFlow = 0;

    function rampDuration(duration) {
        return Math.min(duration, Math.min(3, Math.max(0.5, duration * 0.3)));
    }

    function pushChannelStep(xArr, yArr, isActive, target, prevVal, transition, nextTime, duration) {
        if (!isActive) {
            xArr.push(currentTime, nextTime);
            yArr.push(null, null);
            return null;
        }
        if (transition === 'smooth' && prevVal !== null && prevVal !== target) {
            const rampEnd = currentTime + rampDuration(duration);
            if (rampEnd < nextTime) {
                xArr.push(rampEnd, nextTime);
                yArr.push(target, target);
            } else {
                xArr.push(nextTime);
                yArr.push(target);
            }
        } else {
            xArr.push(currentTime, nextTime);
            yArr.push(target, target);
        }
        return target;
    }

    const initialTemp = (parseFloat(profile.steps[0].temperature || 0) / 100) * 10;
    tpX.push(0);
    tpY.push(0);
    tfX.push(0);
    tfY.push(0);
    tempX.push(0);
    tempY.push(initialTemp);

    // Where one step hands over to the next, for the vertical markers below.
    // The 0 and end-of-profile edges are the axis borders already, so only the
    // interior boundaries get a line.
    const stepBoundaries = [];

    for (const step of profile.steps) {
        const duration = parseFloat(step.seconds || 0);
        if (duration <= 0) continue;

        if (currentTime > 0) stepBoundaries.push(currentTime);
        const nextTime = currentTime + duration;
        const temp = (parseFloat(step.temperature || 0) / 100) * 10;
        const transition = step.transition || 'fast';

        const isPressure = step.pump === 'pressure';
        const isFlowStep = step.pump === 'flow';
        const pressureTarget = isPressure ? parseFloat(step.pressure || 0) : null;
        const flowTarget = isFlowStep ? parseFloat(step.flow || 0) : null;

        prevPressure = pushChannelStep(tpX, tpY, isPressure, pressureTarget, prevPressure, transition, nextTime, duration);
        prevFlow = pushChannelStep(tfX, tfY, isFlowStep, flowTarget, prevFlow, transition, nextTime, duration);

        tempX.push(currentTime, nextTime);
        tempY.push(temp, temp);

        currentTime = nextTime;
    }

    const theme = currentTheme;
    const layout = JSON.parse(JSON.stringify(theme === 'dark' ? darkLayout : lightLayout));
    layout.annotations = [];
    layout.shapes = []; // Clear shapes for profile plot
    // Same dashed step markers the live chart draws (addStepMarker), so a
    // profile previewed in the selector is read the same way as one being
    // pulled.
    for (const boundary of stepBoundaries) {
        addStepMarker(layout, boundary, theme);
    }
    layout.xaxis.range = [0, currentTime];

    // Adaptive X-axis tick density based on profile duration
    let xDtick;
    if (currentTime < 60) {
        xDtick = 10;
    } else if (currentTime < 120) {
        xDtick = 15;
    } else if (currentTime < 180) {
        xDtick = 20;
    } else {
        xDtick = 30;
    }
    layout.xaxis.dtick = xDtick;

    // Sparser Y-axis ticks (0, 2, 4, 6, 8, 10) instead of every 1 unit
    layout.yaxis.dtick = 2;
    const plotData = JSON.parse(JSON.stringify(chartTraces));

    const targetPressureTrace = plotData.find(trace => trace.name === 'Target Pressure');
    if (targetPressureTrace) {
        targetPressureTrace.line.dash = 'solid';
        targetPressureTrace.line.width = 5;
    }

    const targetFlowTrace = plotData.find(trace => trace.name === 'Target Flow');
    if (targetFlowTrace) {
        targetFlowTrace.line.dash = 'solid';
        targetFlowTrace.line.width = 5;
    }

    const groupTempTrace = plotData.find(trace => trace.name === '°C');
    if (groupTempTrace) {
        groupTempTrace.line.width = 5;
    }

    const element = getChartElement();
    if (!element) {
        console.error('plotProfile: chartElement not found in DOM');
        return;
    }
    rebuildExpandedFromChartData();
    renderMain(plotData, layout);
}

// Function to update chart colors based on theme
function updateChartColors(theme) {
    const isDark = theme === 'dark';

    // Update target flow line color
    chartData.targetFlow.line.color = isDark ? '#23416c' : baseChartData.targetFlow.line.color;

    // Update target temperature line color
    chartData.targetTemperature.line.color = isDark ? '#3e3233' : baseChartData.targetTemperature.line.color;

    // Update temperature line color
    chartData.groupTemperature.line.color = isDark ? '#AE6D73' : baseChartData.groupTemperature.line.color;

    // Update weight line color
    chartData.weight.line.color = isDark ? '#695f57' : baseChartData.weight.line.color;
}

let chartWindowResizeTimeout = 0;
let chartElementResizeTimeout = 0;
let observedChartElement = null;
let chartResizeObserver = null;
let chartLifecycleBound = false;

function resizeChartElement(element) {
    if (!element || element.offsetParent === null || !element.clientHeight || !element.clientWidth) return;
    if (!resizeChart(element)) return;
    if (!expandedOpen) refreshLabelMargin();
}

function handleChartWindowResize() {
    clearTimeout(chartWindowResizeTimeout);
    chartWindowResizeTimeout = setTimeout(() => resizeChartElement(getChartElement()), 100);
}

function handleChartElementResize(entries) {
    const size = entries[0]?.contentRect;
    if (size) observedChartSize = { width: size.width, height: size.height };
    clearTimeout(chartElementResizeTimeout);
    chartElementResizeTimeout = setTimeout(() => resizeChartElement(observedChartElement), 100);
}

function handleChartStorage(event) {
    if (event.key === 'theme') setTheme(event.newValue || 'light');
}

function handleChartLanguageChange() {
    measuredLabelWidths.clear();
    refreshLabelMargin();
    if (expandedOpen) renderExpandedCharts();
}

function handleChartVisibilityChange() {
    if (document.visibilityState === 'visible') flushDeferredChart();
}

function handleMainPageVisible() {
    const element = getChartElement();
    if (element) observeChartElement(element);
    flushDeferredChart();
}

function ensureChartLifecycle() {
    if (!chartLifecycleBound) {
        if (!window.ResizeObserver) window.addEventListener('resize', handleChartWindowResize);
        window.addEventListener('storage', handleChartStorage);
        document.addEventListener('streamline:languagechange', handleChartLanguageChange);
        document.addEventListener('streamline:mainpagevisible', handleMainPageVisible);
        document.addEventListener('visibilitychange', handleChartVisibilityChange);
        chartLifecycleBound = true;
    }
    if (!chartResizeObserver && window.ResizeObserver) {
        chartResizeObserver = new window.ResizeObserver(handleChartElementResize);
    }
}

function observeChartElement(element) {
    if (!chartResizeObserver || observedChartElement === element) return;
    if (observedChartElement) chartResizeObserver.unobserve(observedChartElement);
    observedChartElement = element;
    observedChartSize = { width: element.clientWidth, height: element.clientHeight };
    chartResizeObserver.observe(element);
}

export function initChart() {
    const element = getChartElement();
    if (!element) {
        console.error('initChart: chartElement is not found in the DOM');
        return;
    }

    currentTheme = localStorage.getItem('theme') || 'light';
    const theme = currentTheme;
    updateChartColors(theme); // Apply theme-specific colors

    const layout = theme === 'dark' ? darkLayout : lightLayout;
    applyLabelLayout(layout);
    ensureChartLifecycle();
    observeChartElement(element);

    // No initial render here: the CSS scaling pass (initScaling) hasn't run
    // yet at this point during boot, so drawing now would measure the
    // pre-scale container size and need a later resize to fix -- wasted
    // render at boot, and nothing currently corrects it automatically. The
    // first real draw (plotHistoricalShot / clearChart / plotProfile, all of
    // which work fine as an initial draw) happens once
    // there's actual data to show, by which point scaling has settled.

}

export async function cleanupSubpageChart(root) {
    if (!root) return;
    cancelChartFlush();
    clearTimeout(chartElementResizeTimeout);
    chartElementResizeTimeout = 0;
    if (observedChartElement && root.contains(observedChartElement)) {
        chartResizeObserver?.unobserve(observedChartElement);
        observedChartElement = null;
        observedChartSize = { width: 0, height: 0 };
    }
    await Promise.all([...root.querySelectorAll('#plotly-chart')].map(disposeECharts));
}

export function setTheme(theme) {
    currentTheme = theme;
    updateChartColors(theme); // Apply theme-specific colors

    const layoutUpdate = theme === 'dark' ? darkLayout : lightLayout;
    applyLabelLayout(layoutUpdate);
    const data = chartTraces;
    const element = getChartElement();
    if (!element) {
        console.error('setTheme: chartElement not found in DOM');
        return;
    }
    renderMain(data, layoutUpdate);
    if (expandedOpen) renderExpandedCharts();
}
