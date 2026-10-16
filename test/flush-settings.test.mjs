import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Flush temperature and flow used to be written with updateDe1Setting, which reaches the DE1
// but never the workflow — so nothing else could read them back. A plugin saw the previous
// values, and a DYE2 recipe could apply a flush temperature it had no way to record. They are
// staged onto the workflow's rinseData now, the way steam and hot water already were.
//
// settings.js can't be imported under node (browser globals), so the staging function is
// lifted out of the source and run with its module state injected — same trick as
// dye2-plugin-source.test.mjs.

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');

function lifted() {
    const match = source.match(/export function updateFlushSetting\(key, value\) \{[\s\S]*?\r?\n\}/);
    assert.ok(match, 'no updateFlushSetting in settings.js');
    const settingsCache = { workflow: null, de1: { flushTemp: 95, flushFlow: 6 } };
    const pendingChanges = { rea: {}, de1: {}, de1Advanced: {}, workflow: {} };
    const update = new Function('settingsCache', 'pendingChanges',
        `${match[0].replace('export ', '')}\nreturn updateFlushSetting;`)(settingsCache, pendingChanges);
    return { update, settingsCache, pendingChanges };
}

test('a flush edit is staged onto the workflow, not the DE1 settings', () => {
    const { update, settingsCache, pendingChanges } = lifted();
    update('targetTemperature', 88);
    assert.deepEqual(pendingChanges.workflow.rinseData, { targetTemperature: 88 });
    assert.deepEqual(pendingChanges.de1, {}, 'nothing goes to the DE1 settings endpoint');
    assert.equal(settingsCache.workflow.rinseData.targetTemperature, 88, 'the page shows it straight away');
});

test('a second edit adds to the staged block', () => {
    // The whole block is sent, so the first field must survive the second edit.
    const { update, pendingChanges } = lifted();
    update('targetTemperature', 88);
    update('flow', 4);
    assert.deepEqual(pendingChanges.workflow.rinseData, { targetTemperature: 88, flow: 4 });
});

test('the staged block keeps a duration the workflow already had', () => {
    const { update, settingsCache, pendingChanges } = lifted();
    settingsCache.workflow = { rinseData: { duration: 5 } };
    update('flow', 4);
    assert.deepEqual(pendingChanges.workflow.rinseData, { duration: 5, flow: 4 },
        'a partial PUT that dropped the duration would reset the flush time');
});

test('the flush inputs write through updateFlushSetting', () => {
    // The regression this file exists for: a handler put back to updateDe1Setting would make
    // the two unreadable again, silently.
    for (const id of ['flushTempInput', 'flushFlowInput']) {
        const input = source.match(new RegExp(`id="${id}"[\\s\\S]*?>`));
        assert.ok(input, `no ${id} in settings.js`);
        assert.match(input[0], /window\.updateFlushSetting\('(targetTemperature|flow)'/);
    }
});

test('the flush page reads its values from the workflow', () => {
    const render = source.match(/export function renderFlushSettingsForm\(settings\) \{[\s\S]*?\r?\n\}/);
    assert.ok(render, 'no renderFlushSettingsForm in settings.js');
    assert.match(render[0], /settingsCache\.workflow\?\.rinseData/);
    assert.match(render[0], /rinse\.targetTemperature \?\? settings\?\.flushTemp/, 'with the machine as the fallback');
});

test('the staged flush block is PUT to the workflow when settings are saved', () => {
    const flushFn = source.match(/async function flushPendingChanges\(\) \{[\s\S]*?\r?\n\}/);
    assert.ok(flushFn, 'no flushPendingChanges in settings.js');
    assert.match(flushFn[0], /pendingChanges\.workflow\.rinseData/);
    assert.match(flushFn[0], /updateWorkflow\(\{ rinseData: rinse \}\)/);
});
