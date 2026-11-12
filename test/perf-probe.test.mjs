import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MIN_REPORTED_SHOT_S,
    PERF_PROBE_KEY,
    deviceLine,
    endPerfShot,
    initPerfProbe,
    isPerfProbeEnabled,
    measure,
    navSummary,
    readStats,
    setPerfProbeEnabled,
    shotSummary,
    startPerfShot,
    summarize,
} from '../src/modules/perf-probe.js';

/** A localStorage stand-in; the probe must never assume a real one. */
function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem: key => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        read: key => (map.has(key) ? map.get(key) : null),
    };
}

const view = (href, storage) => ({
    location: { href },
    localStorage: storage,
    navigator: { userAgent: 'test', hardwareConcurrency: 4 },
    screen: { width: 1920, height: 1200 },
    devicePixelRatio: 2,
});

// Timing does not wait to be switched on: the skin runs in a WebView with no
// address bar, so a flag only a developer can set would only ever measure a
// developer's machine. Verbose reporting is what the flag controls.
test('timing runs whether or not verbose reporting is on', () => {
    setPerfProbeEnabled(false);
    assert.equal(isPerfProbeEnabled(), false);

    startPerfShot();
    assert.equal(measure('noop', () => 42), 42);
    assert.equal(readStats().get('noop').count, 1, 'a shot on any tablet is measured');
});

test('a measured call keeps its return value, and a throw still propagates', () => {
    setPerfProbeEnabled(true);

    assert.equal(measure('value', () => 'kept'), 'kept');
    assert.throws(() => measure('throws', () => { throw new Error('boom'); }), /boom/);

    // The throwing call is still counted: a frame that failed is exactly the one
    // worth seeing in the report.
    assert.equal(readStats().get('throws').count, 1);
    setPerfProbeEnabled(false);
});

test('the report ranks by total time and keeps the worst single call', () => {
    const stats = new Map();
    stats.set('small', { count: 4, total: 4, max: 1 });
    stats.set('big', { count: 2, total: 6, max: 5 });

    const [header, first, second] = summarize(stats, 2000);

    assert.match(header, /2000 ms window, 10\.0 ms measured/);
    assert.match(first, /^big n=2 total=6\.0ms mean=3\.000ms max=5\.000ms share=60%$/);
    assert.match(second, /^small n=4 .* share=40%$/);
});

test('an empty window still reports, rather than going silent', () => {
    assert.deepEqual(summarize(new Map(), 10000), ['perf: nothing measured in 10000 ms']);
});

test('the switch comes from the URL, persists, and clears', () => {
    const storage = fakeStorage();

    assert.equal(initPerfProbe(view('http://tablet:3000/?perf=1', storage)), true);
    assert.equal(storage.read(PERF_PROBE_KEY), '1', 'survives Decaid reloading the skin');

    // No query: the stored flag decides, which is what a reload lands on.
    assert.equal(initPerfProbe(view('http://tablet:3000/', storage)), true);

    assert.equal(initPerfProbe(view('http://tablet:3000/?perf=0', storage)), false);
    assert.equal(storage.read(PERF_PROBE_KEY), '0');
    assert.equal(initPerfProbe(view('http://tablet:3000/', storage)), false);
});

test('no location and no storage is off, not a crash', () => {
    assert.equal(initPerfProbe({}), false);
    assert.equal(isPerfProbeEnabled(), false);
});

test('the device line carries the facts a frame budget is read against', () => {
    const line = deviceLine(view('http://tablet:3000/', fakeStorage()));
    assert.match(line, /ua=test/);
    assert.match(line, /cores=4/);
    assert.match(line, /dpr=2/);
    assert.match(line, /screen=1920x1200/);
});

test('a shot leaves one line, ordered by mean, with the worst frame kept', () => {
    const entries = new Map([
        ['status', { count: 240, total: 24, max: 0.4 }],
        ['chart', { count: 238, total: 166.6, max: 9.9 }],
        ['idle', { count: 0, total: 0, max: 0 }],
    ]);

    const line = shotSummary(entries, 24.06);

    assert.equal(line, 'perf: shot 24.1s n=240 chart=0.70/9.9x238 status=0.10/0.4x240 (mean/max ms x count)');
    assert.ok(!line.includes('idle'), 'a segment that never ran is not worth a column');
});

test('a flush-length run is dropped rather than logged, and clears the window', () => {
    setPerfProbeEnabled(false);
    startPerfShot();
    measure('chart', () => 1);

    assert.equal(endPerfShot(MIN_REPORTED_SHOT_S - 0.1), false);
    assert.equal(readStats().size, 0, 'a dropped run must not leak into the next shot');

    startPerfShot();
    measure('chart', () => 1);
    assert.equal(endPerfShot(MIN_REPORTED_SHOT_S), true);
    assert.equal(readStats().size, 0);
});

test('a navigation leaves one line, marks cumulative from the tap', () => {
    const line = navSummary('settings/maintenance', [['module', 412.4], ['mount', 530.6]], 531.2);

    assert.equal(line, 'perf: nav settings/maintenance module=412 mount=531 total=531ms');
});

test('a navigation with no marks still reports its total', () => {
    assert.equal(navSummary('main', [], 18.7), 'perf: nav main total=19ms');
});
