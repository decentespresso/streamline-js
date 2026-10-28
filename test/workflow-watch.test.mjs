import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { profileFingerprint } from '../src/modules/dye-selection.js';

import { workflowTileValues, changedTileValues, tilesToPaint, profileChanged, FORCED_KEYS, API_DEBOUNCE_MS, WORKFLOW_EDIT_GUARD_MS } from '../src/modules/workflow-watch.js';

// The dashboard learns about a workflow changed elsewhere (Decaid's UI, another
// skin, a DYE2 page) only by re-reading GET /workflow -- there is no workflow
// websocket and no revision to poll. These two functions decide what that re-read
// is allowed to repaint, so the rules that matter are: a field the user is
// mid-edit reads as unchanged (their value has not reached the server yet), and
// the first read after boot repaints nothing.

const workflow = ({ steam = {}, ...over } = {}) => ({
    profile: { title: 'Londonium', steps: [{ temperature: 89 }] },
    context: { grinderSetting: '21', targetDoseWeight: 18, targetYield: 36 },
    steamSettings: { duration: 45, flow: 0.8, stopAtTemperature: 0, ...steam },
    hotWaterData: { volume: 50, targetTemperature: 80 },
    rinseData: { duration: 5 },
    ...over,
});

test('every main-page tile value is read off the workflow', () => {
    assert.deepEqual(workflowTileValues(workflow()), {
        profileTitle: 'Londonium',
        profileSig: profileFingerprint({ title: 'Londonium', steps: [{ temperature: 89 }] }),
        grind: '21',
        dose: 18,
        yield: 36,
        brewTemp: 89,
        steamDuration: 45,
        steamFlow: 0.8,
        milkStop: 0,
        hotWaterVolume: 50,
        hotWaterTemp: 80,
        flush: 5,
    });
});

test('legacy doseData/grinderData fill in when context is absent', () => {
    const values = workflowTileValues({
        doseData: { doseIn: 20, drinkOut: 40 },
        grinderData: { setting: '15' },
    });
    assert.equal(values.dose, 20);
    assert.equal(values.yield, 40);
    assert.equal(values.grind, '15');
});

test('a missing workflow yields nothing rather than throwing', () => {
    assert.deepEqual(workflowTileValues(null), {});
});

test('the first read after boot repaints nothing', () => {
    // Boot already painted from this document; treating it as a change would
    // repaint every tile on the first poll.
    assert.deepEqual(changedTileValues(null, workflowTileValues(workflow())), {});
});

test('only the fields that actually moved are reported', () => {
    const before = workflowTileValues(workflow());
    const after = workflowTileValues(workflow({ steam: { duration: 30 } }));
    assert.deepEqual(changedTileValues(before, after), { steamDuration: 30 });
});

test('an unchanged document reports no changes', () => {
    const before = workflowTileValues(workflow());
    assert.deepEqual(changedTileValues(before, workflowTileValues(workflow())), {});
});

test('a reformatted grind setting is not a change', () => {
    // The workflow stores grind as a string and writers format it differently
    // ("21" from one client, "21.00" from setTargetGrind).
    const before = workflowTileValues(workflow());
    const after = workflowTileValues(workflow({ context: { grinderSetting: '21.00' } }));
    assert.deepEqual(changedTileValues(before, after), {});
});

test('a field that vanished is not reported -- there is nothing to paint', () => {
    const before = workflowTileValues(workflow());
    const after = workflowTileValues(workflow({ rinseData: undefined }));
    assert.equal('flush' in changedTileValues(before, after), false);
});

test('a milk stop turned off elsewhere is reported, 0 being a real value', () => {
    const before = workflowTileValues(workflow({ steam: { stopAtTemperature: 60 } }));
    const after = workflowTileValues(workflow({ steam: { stopAtTemperature: 0 } }));
    assert.deepEqual(changedTileValues(before, after), { milkStop: 0 });
});

test('a profile switch shows up as a title change', () => {
    const before = workflowTileValues(workflow());
    const after = workflowTileValues(workflow({
        profile: { title: 'Blooming espresso', steps: [{ temperature: 92 }] },
    }));
    const changed = changedTileValues(before, after);
    assert.equal(changed.profileTitle, 'Blooming espresso');
    assert.equal(changed.brewTemp, 92);
});


// ── The refresh itself (app.js) ──────────────────────────────────────────────
// app.js can't be imported under node (browser globals), so refreshWorkflowTiles
// is lifted out of the source and run with its dependencies injected.
{
    const source = readFileSync(new URL('../src/modules/app.js', import.meta.url), 'utf8');
    const match = source.match(/async function refreshWorkflowTiles\(\) \{[\s\S]*?\r?\n\}/);
    if (!match) throw new Error('refreshWorkflowTiles not found in app.js');

    const build = ({ baseline, workflow, msSinceEdit = 60_000, subPage = false, force = false, editAfterRead = false, getWorkflowImpl } = {}) => {
        const calls = { painted: [], reloads: 0, fetches: 0, retries: 0 };
        const state = { force };
        let sinceEdit = msSinceEdit;
        const refresh = new Function(
            'isSubPage', 'ui', 'getWorkflow', 'logger', 'loadInitialData',
            'workflowTileValues', 'tilesToPaint', 'profileChanged',
            'WORKFLOW_REFRESH_MIN_GAP_MS', 'tileEditPending', 'WORKFLOW_TILE_PAINTERS',
            'refreshWorkflowTilesSoon', 'seed', 'calls', 'state',
            `let lastWorkflowTiles = seed;
             let lastWorkflowRefreshAt = 0;
             let pendingForcedRefresh = state.force;
             state.read = () => pendingForcedRefresh;
             ${match[0]}
             return refreshWorkflowTiles;`
        )(
            () => subPage,
            { msSinceTileInteraction: () => sinceEdit },
            getWorkflowImpl ? async () => { calls.fetches++; return getWorkflowImpl(); }
                : async () => { calls.fetches++; if (editAfterRead) sinceEdit = 100; return workflow; },
            { info() {}, warn() {} },
            async () => { calls.reloads++; },
            workflowTileValues,
            tilesToPaint,
            profileChanged,
            250,
            () => sinceEdit < 1100,
            new Proxy({}, { get: (_t, key) => (value) => calls.painted.push([key, value]) }),
            () => { calls.retries++; },
            baseline,
            calls,
            state,
        );
        return { refresh, calls, state };
    };

    const base = () => ({
        profile: { title: 'Londonium', steps: [{ temperature: 89 }] },
        context: { grinderSetting: '21', targetDoseWeight: 18, targetYield: 36 },
        steamSettings: { duration: 45, flow: 0.8, stopAtTemperature: 0 },
        hotWaterData: { volume: 50, targetTemperature: 80 },
        rinseData: { duration: 5 },
    });

    test('a tile touched moments ago blocks the refresh entirely', async () => {
        // The push is debounced a second, so an earlier press can already be on the
        // server while a later one is pending: repainting would reassign the value
        // that pending push is about to send, and the newest keypress is lost.
        const moved = base();
        moved.steamSettings.flow = 0.4;
        const { refresh, calls } = build({
            baseline: workflowTileValues(base()),
            workflow: moved,
            msSinceEdit: 800,
        });

        await refresh();
        assert.equal(calls.fetches, 0);
        assert.deepEqual(calls.painted, []);
    });

    test('the blocked change is still picked up once editing stops', async () => {
        const moved = base();
        moved.steamSettings.flow = 0.4;
        const { refresh, calls } = build({
            baseline: workflowTileValues(base()),
            workflow: moved,
            msSinceEdit: 30_000,
        });

        await refresh();
        assert.ok(calls.painted.some(([k, v]) => k === 'steamFlow' && v === 0.4));
    });

    test('a moved secondary tile is painted with the rest', async () => {
        const moved = base();
        moved.hotWaterData.volume = 100;
        const { refresh, calls } = build({ baseline: workflowTileValues(base()), workflow: moved });

        await refresh();
        assert.ok(calls.painted.some(([k, v]) => k === 'hotWaterVolume' && v === 100));
        assert.ok(calls.painted.some(([k, v]) => k === 'steamFlow' && v === 0.8), 'unmoved steam is repainted too');
    });

    test('a profile switch reloads instead of painting tiles piecemeal', async () => {
        // The chart's step tracking, the active-profile record and the favourite
        // highlight all follow the profile; only loadInitialData moves all of them.
        const moved = base();
        moved.profile = { title: 'Blooming espresso', steps: [{ temperature: 92 }] };
        const { refresh, calls } = build({ baseline: workflowTileValues(base()), workflow: moved });

        await refresh();
        assert.equal(calls.reloads, 1);
        assert.deepEqual(calls.painted, []);
    });

    test('nothing happens on a sub-page, where the tiles are not mounted', async () => {
        const { refresh, calls } = build({ baseline: workflowTileValues(base()), workflow: base(), subPage: true });
        await refresh();
        assert.equal(calls.fetches, 0);
    });

    test('a forced refresh survives every skipped read and clears after an applied one', async () => {
        const wf = base();
        const baseline = workflowTileValues(wf);
        for (const opts of [{ subPage: true }, { msSinceEdit: 100 }]) {
            const { refresh, state } = build({ baseline, workflow: wf, force: true, ...opts });
            await refresh();
            assert.equal(state.read(), true, JSON.stringify(opts));
        }
        // time gap: a second refresh right after the first is skipped
        const gap = build({ baseline, workflow: wf, force: true });
        await gap.refresh();
        assert.equal(gap.state.read(), false);
        gap.state.force = true;
        const { calls } = gap;
        const painted = calls.painted.length;
        await gap.refresh();
        assert.equal(calls.painted.length, painted);
        assert.equal(calls.fetches, 1);

        // failed read keeps the force
        const failed = build({ baseline, workflow: wf, force: true, getWorkflowImpl: async () => { throw new Error('x'); } });
        await failed.refresh();
        assert.equal(failed.state.read(), true);
    });

    test('an edit during the read drops it, keeps the force and the baseline, and retries', async () => {
        const moved = base();
        moved.hotWaterData.volume = 100;
        const { refresh, calls, state } = build({
            baseline: workflowTileValues(base()), workflow: moved, force: true, editAfterRead: true,
        });
        await refresh();
        assert.equal(calls.fetches, 1);
        assert.deepEqual(calls.painted, []);
        assert.equal(state.read(), true);
        assert.equal(calls.retries, 1);
    });

    test('a forced read repaints every forced tile then clears the flag', async () => {
        const wf = base();
        const { refresh, calls, state } = build({ baseline: workflowTileValues(wf), workflow: wf, force: true });
        await refresh();
        assert.deepEqual(calls.painted.map(p => p[0]).sort(), ['brewTemp', 'dose', 'flush', 'grind', 'hotWaterTemp', 'hotWaterVolume', 'milkStop', 'steamDuration', 'steamFlow', 'yield']);
        assert.equal(state.read(), false);
    });

    test('an unchanged workflow still repaints every forced tile', async () => {
        const { refresh, calls } = build({ baseline: workflowTileValues(base()), workflow: base() });
        await refresh();
        assert.equal(calls.fetches, 1);
        assert.deepEqual(calls.painted.map(([k]) => k).sort(), ['brewTemp', 'dose', 'flush', 'grind', 'hotWaterTemp', 'hotWaterVolume', 'milkStop', 'steamDuration', 'steamFlow', 'yield']);
    });
}

test('tilesToPaint: force repaints every forced tile even when the baseline matches', () => {
    const tiles = { profileTitle: 'A', dose: 18, yield: 36, grind: '5', brewTemp: 93, steamDuration: 30 };
    assert.deepEqual(tilesToPaint(tiles, { ...tiles }, { force: true }),
        { dose: 18, yield: 36, grind: '5', brewTemp: 93, steamDuration: 30 });
    assert.deepEqual(FORCED_KEYS.slice(0, 4), ['dose', 'yield', 'grind', 'brewTemp']);
    assert.ok(!FORCED_KEYS.includes('profileTitle'));
});

test('tilesToPaint: without force it is changedTileValues', () => {
    const a = { profileTitle: 'A', dose: 18, yield: 36 };
    const b = { profileTitle: 'B', dose: 18, yield: 40 };
    assert.deepEqual(tilesToPaint(a, b), changedTileValues(a, b));
    assert.deepEqual(tilesToPaint(a, a, { force: false }), {});
});

test('tilesToPaint: null values are never returned and profileTitle is not forced', () => {
    const tiles = { profileTitle: 'A', dose: null, yield: undefined, grind: '5', brewTemp: 93 };
    assert.deepEqual(tilesToPaint(tiles, { ...tiles }, { force: true }), { grind: '5', brewTemp: 93 });
});

test('tilesToPaint: unknown previous state with force still returns the four keys', () => {
    const next = { profileTitle: 'A', dose: 18, yield: 36, grind: '5', brewTemp: 93, flush: 5 };
    assert.deepEqual(tilesToPaint(null, next, { force: true }), { dose: 18, yield: 36, grind: '5', brewTemp: 93, flush: 5 });
    assert.deepEqual(tilesToPaint(null, next), {});
});

test('profile change detection: same title, different steps is a profile change', () => {
    const wf = steps => ({ profile: { title: 'A', steps } });
    const before = workflowTileValues(wf([{ name: 'fill', pump: 'flow' }]));
    const after = workflowTileValues(wf([{ name: 'fill', pump: 'flow' }, { name: 'pour', pump: 'pressure' }]));
    const changed = changedTileValues(before, after);
    assert.ok('profileSig' in changed);
    assert.ok(!('profileTitle' in changed));
    assert.equal(profileChanged(changed), true);
});

test('profile change detection: same fingerprint is unchanged, brew temp alone is not a profile change', () => {
    const wf = temperature => ({ profile: { title: 'A', steps: [{ name: 'fill', temperature }] } });
    const changed = changedTileValues(workflowTileValues(wf(90)), workflowTileValues(wf(93)));
    assert.deepEqual(Object.keys(changed), ['brewTemp']);
    assert.equal(profileChanged(changed), false);
    assert.equal(profileChanged({}), false);
});

test('profile change detection: null and garbage are safe', () => {
    assert.equal(profileChanged(null), false);
    assert.equal(profileChanged(undefined), false);
    for (const bad of [null, {}, { profile: null }, { profile: 'x' }, { profile: 5 }, { profile: { steps: 'nope' } }]) {
        assert.doesNotThrow(() => workflowTileValues(bad));
    }
    assert.deepEqual(changedTileValues(workflowTileValues({ profile: { title: 'A' } }), workflowTileValues(null)), {});
});

test('the edit guard outlasts the tile write debounce and is not duplicated as a literal', () => {
    assert.ok(WORKFLOW_EDIT_GUARD_MS > API_DEBOUNCE_MS);
    // A settled tile value waits this long before Decaid hears it, and a cafe
    // sharing a dial-in pays it on the sending machine (issue #174). A burst is
    // one PUT at any value, so there is nothing to buy by waiting longer.
    assert.ok(API_DEBOUNCE_MS <= 300, `tile writes must not wait longer than 300 ms (got ${API_DEBOUNCE_MS})`);
    assert.doesNotMatch(readFileSync(new URL('../src/modules/app.js', import.meta.url), 'utf8'), /WORKFLOW_EDIT_GUARD_MS\s*=\s*\d/);
    assert.doesNotMatch(readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8'), /API_DEBOUNCE_MS\s*=\s*\d/);
});
