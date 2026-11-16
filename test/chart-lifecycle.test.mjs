import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

test('main chart observation is restored after subpage cleanup', async () => {
    const observed = [];
    const unobserved = [];
    class ResizeObserver {
        observe(element) { observed.push(element.id); }
        unobserve(element) { unobserved.push(element.id); }
    }
    const mainChart = { id: 'main-chart', clientWidth: 960, clientHeight: 390 };
    const profileChart = { id: 'profile-chart', clientWidth: 960, clientHeight: 390 };
    const mainPage = {
        style: { display: 'block' },
        querySelector: selector => selector === '#plotly-chart' ? mainChart : null
    };
    const subpageHost = {
        querySelector: selector => selector === '#plotly-chart' ? profileChart : null,
        querySelectorAll: selector => selector === '#plotly-chart' ? [profileChart] : [],
        contains: element => element === profileChart
    };
    const documentTarget = new EventTarget();
    Object.assign(documentTarget, {
        visibilityState: 'visible',
        getElementById: id => ({ 'main-page': mainPage, 'subpage-host': subpageHost })[id] || null,
        createElement: () => ({ style: {}, getContext: () => ({ measureText: text => ({ width: text.length * 8 }) }) })
    });
    const windowTarget = new EventTarget();
    windowTarget.ResizeObserver = ResizeObserver;

    globalThis.document = documentTarget;
    globalThis.window = windowTarget;
    globalThis.localStorage = { getItem: () => 'light' };

    const chart = await import(`../src/modules/chart.js?lifecycle=${Date.now()}`);
    chart.initChart();
    mainPage.style.display = 'none';
    chart.initChart();
    await chart.cleanupSubpageChart(subpageHost);
    mainPage.style.display = 'block';
    documentTarget.dispatchEvent(new Event('streamline:mainpagevisible'));

    assert.deepEqual(observed, ['main-chart', 'profile-chart', 'main-chart']);
    assert.deepEqual(unobserved, ['main-chart', 'profile-chart']);
});

// Issue #73: finalizeLiveChart() threw on an old Android WebView and unwound
// past the `shotStartTime = null` that used to sit after it. With shot state
// stranded, the next shot's reset -- gated on `if (!shotStartTime)` -- never
// ran, so a 3-second flush kept measuring from a shot 20 hours earlier.
//
// This asserts on source text, which is weaker than driving the path: it would
// not catch some *other* piece of shot state being stranded, and it needs
// updating if the branch is refactored. handleData is module-private and only
// reachable through initMainPageOnce, which wants IndexedDB, network and live
// timers -- driving it under stubs hangs the runner, so the behavioural test
// costs more than it returns here.
test('the shot-end finalize cannot strand shot state', () => {
    const app = readFileSync(new URL('../src/modules/app.js', import.meta.url), 'utf8');
    const branch = app.slice(app.indexOf('shotEndedAt = Date.now();'));
    const cleared = branch.indexOf('shotStartTime = null;');
    // Matches the call whatever it is passed: finalizeLiveChart takes a redraw
    // flag now (false while the user reviews a past shot).
    const finalized = branch.indexOf('chart.finalizeLiveChart(');
    assert.ok(cleared !== -1 && finalized !== -1, 'shot-end branch not found; update this test');

    // The guarantee: a throw out of the render is caught, so the shot-end
    // branch always completes. The ordering below is the second line of
    // defence if that catch is ever removed.
    const guarded = /try\s*\{[^}]*chart\.finalizeLiveChart\([^;]*\);[^}]*\}\s*catch/s.test(branch);
    assert.ok(guarded, 'finalizeLiveChart() must be wrapped in try/catch');
    assert.ok(cleared < finalized,
        'shotStartTime must be cleared before finalizeLiveChart(), so a render throw cannot strand it');
});
