import assert from 'node:assert/strict';
import { test } from 'node:test';

import { destroyChart, renderChart } from '../src/modules/echarts-renderer.js';

test('renderer preserves Plotly geometry, line styling, markers, labels, and capped DPR', () => {
    const calls = [];
    const handlers = {};
    let initOptions;
    let disposed = false;
    let labelRemoved = false;
    const label = { style: {}, remove: () => { labelRemoved = true; } };
    const chart = {
        setOption: (option, settings) => calls.push({ option, settings }),
        getOption: () => undefined,
        resize() {},
        on: (event, query, callback) => { handlers[event] = callback || query; },
        dispose: () => { disposed = true; }
    };
    const echarts = {
        init: (_element, _theme, options) => {
            initOptions = options;
            return chart;
        }
    };
    const element = {
        clientWidth: 800,
        clientHeight: 400,
        style: {},
        ownerDocument: { createElement: () => label },
        append: child => { assert.equal(child, label); },
        replaceChildren() {}
    };
    const traces = [
        { name: 'Pressure', x: [0, 1], y: [0, 8], line: { color: '#17c29a', width: 3 }, hoverinfo: 'name' },
        { name: 'Target Pressure', x: [0, 1], y: [0, 9], line: { color: '#8fd3bf', width: 2, dash: 'dot' }, hoverinfo: 'skip' }
    ];
    const layout = {
        paper_bgcolor: '#0d0e14',
        font: { color: '#606579', size: 20 },
        margin: { l: 50, r: 60, t: 20, b: 40 },
        xaxis: { range: [0, 1.2], gridcolor: '#3D4255', linecolor: '#606579', tickcolor: '#606579' },
        yaxis: { range: [0, 10], gridcolor: '#3D4255', linecolor: '#606579', tickcolor: '#606579' },
        shapes: [{ xref: 'x', x0: 0.5, line: { color: '#7f8bbb', width: 2, dash: 'longdash' } }],
        annotations: [{ x: 1, y: 8, text: 'Pressure', xshift: 6, yshift: -4, font: { color: '#17c29a', size: 16 } }],
        showlegend: false
    };

    globalThis.window = { devicePixelRatio: 2 };
    renderChart(echarts, element, traces, layout);

    const option = calls[0].option;
    assert.equal(initOptions.renderer, 'canvas');
    assert.equal(initOptions.devicePixelRatio, 1.25);
    assert.deepEqual(option.grid[0], { left: 50, right: 60, top: 20, height: 340, containLabel: false });
    assert.equal(option.animation, false);
    assert.equal(option.xAxis[0].axisLabel.fontSize, 20);
    assert.equal(option.series[0].lineStyle.width, 3);
    assert.equal(option.series[0].itemStyle.color, '#17c29a');
    assert.equal(option.series[0].silent, false);
    assert.equal(option.series[0].triggerEvent, 'line');
    assert.equal(option.series[1].silent, true);
    assert.equal(option.series[1].triggerEvent, false);
    assert.equal(option.series[1].lineStyle.type, 'dotted');
    assert.equal(option.series[2].markLine.data[0].lineStyle.type, 'dashed');
    assert.equal(option.series[0].markLine, undefined);
    assert.deepEqual(option.series[0].markPoint.label.offset, [0, 4]);
    assert.equal(option.series[1].markPoint, undefined);
    assert.equal(calls[0].settings.lazyUpdate, false);

    renderChart(echarts, element, traces.map(trace => ({ ...trace, x: [...trace.x, 2], y: [...trace.y, 7] })), layout, 'live');
    assert.equal(calls[1].settings.lazyUpdate, true);
    assert.equal(calls[1].option.grid, undefined);
    assert.equal(calls[1].option.legend, undefined);
    assert.equal(calls[1].option.yAxis, undefined);
    assert.deepEqual([calls[1].option.xAxis[0].min, calls[1].option.xAxis[0].max], [0, 1.2]);
    assert.deepEqual(Object.keys(calls[1].option.series[0]), ['id', 'data']);
    assert.equal(calls[1].option.series.length, 2);

    renderChart(echarts, element, traces, { ...layout, xaxis: { ...layout.xaxis, range: [0, 2.4] } }, 'live');
    assert.equal(calls[2].option.yAxis, undefined);
    assert.deepEqual([calls[2].option.xAxis[0].min, calls[2].option.xAxis[0].max], [0, 2.4]);

    renderChart(echarts, element, traces, { ...layout, shapes: [], yaxis: { ...layout.yaxis, range: [0, 12] } }, 'live');
    assert.equal(calls[3].option.series.length, 3);
    assert.equal(calls[3].option.series[2].id, 'markers-0');
    assert.deepEqual(calls[3].option.series[2].markLine.data, []);

    handlers.mousemove({ seriesName: 'Pressure', color: '#17c29a', event: { offsetX: 120, offsetY: 80 } });
    assert.equal(label.textContent, 'Pressure');
    assert.equal(label.style.backgroundColor, '#17c29a');
    assert.equal(label.style.left, '120px');
    assert.equal(label.style.top, '80px');
    assert.equal(label.style.display, 'block');
    handlers.mouseout();
    assert.equal(label.style.display, 'none');

    destroyChart(element);
    assert.equal(disposed, true);
    assert.equal(labelRemoved, true);
});

test('the Chart Line Width setting scales both series and step-marker line widths', () => {
    const calls = [];
    const chart = {
        setOption: (option, settings) => calls.push({ option, settings }),
        getOption: () => undefined,
        resize() {},
        on() {},
        dispose() {}
    };
    const element = {
        clientWidth: 800,
        clientHeight: 400,
        style: {},
        ownerDocument: { createElement: () => null },
        append() {},
        replaceChildren() {}
    };
    const traces = [
        { name: 'Pressure', x: [0, 1], y: [0, 8], line: { color: '#17c29a', width: 3 } }
    ];
    const layout = {
        margin: { l: 50, r: 50, t: 20, b: 40 },
        xaxis: { range: [0, 1] },
        yaxis: { range: [0, 10] },
        shapes: [{ xref: 'x', x0: 0.5, line: { color: '#7f8bbb', width: 2, dash: 'longdash' } }]
    };

    globalThis.window = { devicePixelRatio: 1 }; // no localStorage -- defaults to 1.0, unchanged
    renderChart({ init: () => chart }, element, traces, layout);
    assert.equal(calls[0].option.series[0].lineStyle.width, 3);
    assert.equal(calls[0].option.series[1].markLine.data[0].lineStyle.width, 2);

    const store = { chartLineWidth: '1.5' };
    globalThis.window = { devicePixelRatio: 1, localStorage: { getItem: k => store[k] } };
    renderChart({ init: () => chart }, element, traces, layout);
    assert.equal(calls[1].option.series[0].lineStyle.width, 4.5);
    assert.equal(calls[1].option.series[1].markLine.data[0].lineStyle.width, 3);
});

test('expanded renderer uses two grids with synchronized time axes and mirrored markers', () => {
    let option;
    const chart = {
        setOption: value => { option = value; },
        resize() {},
        dispose() {}
    };
    const element = { clientWidth: 1920, clientHeight: 1104, style: {}, replaceChildren() {} };
    const traces = [
        { name: 'Pressure', x: [1, 7], y: [1, 8], line: { color: '#17c29a' } },
        { name: 'Group C', x: [2, 6], y: [8, 9], xaxis: 'x2', yaxis: 'y2', line: { color: '#ff97a1' } }
    ];
    const axis = { autorange: true, gridcolor: '#eee', linecolor: '#999', tickcolor: '#999' };
    const layout = {
        font: { color: '#606579', size: 18 },
        margin: { l: 70, r: 28, t: 88, b: 52 },
        xaxis: { ...axis },
        yaxis: { ...axis, domain: [0.46, 1], range: [0, 12], autorange: false },
        xaxis2: { ...axis, matches: 'x' },
        yaxis2: { ...axis, domain: [0, 0.30], range: [8, 9.5], autorange: false },
        shapes: [
            { xref: 'x', x0: 4, line: { color: '#777', width: 2, dash: 'longdash' } },
            { xref: 'x2', x0: 4, line: { color: '#777', width: 2, dash: 'longdash' } }
        ],
        showlegend: true,
        legend: { orientation: 'h', y: 1.04, yanchor: 'bottom', font: { size: 26 } },
        legend2: { orientation: 'h', y: 0.37, yanchor: 'bottom', font: { size: 26 } }
    };

    globalThis.window = { devicePixelRatio: 1 };
    renderChart({ init: () => chart }, element, traces, layout);

    assert.equal(option.grid.length, 2);
    assert.equal(option.legend.length, 2);
    assert.deepEqual([option.xAxis[0].min, option.xAxis[0].max], [1, 7]);
    assert.deepEqual([option.xAxis[1].min, option.xAxis[1].max], [1, 7]);
    assert.equal(option.series[2].markLine.data[0].xAxis, 4);
    assert.equal(option.series[3].markLine.data[0].xAxis, 4);
    destroyChart(element);
});

test('legend visibility survives renderer updates', () => {
    let current = { legend: [] };
    const chart = {
        setOption: option => { current = option; },
        getOption: () => current,
        resize() {},
        dispose() {}
    };
    const element = { clientWidth: 800, clientHeight: 400, style: {}, replaceChildren() {} };
    const traces = [
        { name: 'Pressure', x: [0, 1], y: [0, 8], line: { color: '#17c29a' } },
        { name: 'Flow', x: [0, 1], y: [0, 4], line: { color: '#0358cf' } }
    ];
    const layout = {
        font: { color: '#606579', size: 18 },
        xaxis: {},
        yaxis: { range: [0, 12] },
        showlegend: true,
        legend: { orientation: 'h', y: 1, font: { size: 20 } }
    };

    globalThis.window = { devicePixelRatio: 1 };
    renderChart({ init: () => chart }, element, traces, layout);
    current.legend[0].selected = { Pressure: false, Flow: true };
    renderChart({ init: () => chart }, element, traces, layout);

    assert.deepEqual(current.legend[0].selected, { Pressure: false, Flow: true });
    destroyChart(element);
});
