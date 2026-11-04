import { currentBeanContext } from '../src/modules/bean-selection.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Decaid owns plugin distribution (doc/Plugins.md): it records where each plugin
// came from and installs new releases itself, holding back only updates that ask
// for permissions the installed version does not hold. Streamline reads that
// state and never talks to GitHub. What is checked here:
//   - the install/approve wrappers hit the right endpoints and shape errors so a
//     409 ("the candidate moved since you reviewed it") is distinguishable from
//     an ordinary failure -- the settings card branches on that;
//   - getDye2VersionInfo maps the bridge fields the card renders, and reports an
//     unreachable bridge instead of passing it off as "not installed";
//   - the switch-on update offer prompts only when a decision is actually needed.
//
// api.js / dyeStrip.js can't be imported under node (browser globals), so the
// functions under test are lifted out of the source and run with their
// dependencies injected -- same trick as settings-sync.test.mjs.

function lift(module, patterns) {
    const source = readFileSync(new URL(`../src/modules/${module}`, import.meta.url), 'utf8');
    return patterns.map(pattern => {
        const match = source.match(pattern);
        assert.ok(match, `${module}: no match for ${pattern}`);
        return match[0].replace('export ', '');
    }).join('\n');
}

// ── Install / update-check / approve wrappers (api.js) ───────────────────────
{
    const body = lift('api.js', [
        /export async function installPluginFromRelease\([\s\S]*?\r?\n\}/,
        /export async function checkPluginUpdates\(\) \{[\s\S]*?\r?\n\}/,
        /export async function approvePluginUpdate\(pluginId\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = (responder) => {
        const calls = [];
        const api = new Function(
            'API_BASE_URL', 'fetch',
            `${body}\nreturn { installPluginFromRelease, checkPluginUpdates, approvePluginUpdate };`
        )('http://x:8080/api/v1', async (url, opts) => {
            calls.push({ url, opts });
            return responder(url, opts);
        });
        return { api, calls };
    };

    const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
    const fail = (status, payload) => ({ ok: false, status, statusText: 'Conflict', json: async () => payload });

    test('installPluginFromRelease posts the repo to the github-release endpoint', async () => {
        const { api, calls } = build(() => ok({ id: 'dye2.reaplugin', version: '0.1.6' }));
        const result = await api.installPluginFromRelease('decentespresso/dye2');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'http://x:8080/api/v1/plugins/install/github-release');
        assert.equal(calls[0].opts.method, 'POST');
        assert.deepEqual(JSON.parse(calls[0].opts.body), { repo: 'decentespresso/dye2' });
        assert.equal(result.version, '0.1.6');
    });

    test('checkPluginUpdates posts to the update endpoint', async () => {
        const { api, calls } = build(() => ok({ message: 'Plugin update check complete' }));
        await api.checkPluginUpdates();

        assert.equal(calls[0].url, 'http://x:8080/api/v1/plugins/update');
        assert.equal(calls[0].opts.method, 'POST');
    });

    test('approvePluginUpdate surfaces a 409 as a status the caller can branch on', async () => {
        const { api, calls } = build(() => fail(409, { error: 'Update of dye2.reaplugin changed since it was approved' }));

        await assert.rejects(
            () => api.approvePluginUpdate('dye2.reaplugin'),
            (e) => {
                // 409 means Decaid recorded a *new* pending update; retrying the same
                // call only 409s again, so the card must re-read and show the new delta.
                assert.equal(e.status, 409);
                assert.match(e.message, /changed since it was approved/);
                return true;
            }
        );
        assert.equal(calls[0].url, 'http://x:8080/api/v1/plugins/dye2.reaplugin/update/approve');
    });

    test('a failed install reports the server error, not just the status code', async () => {
        const { api } = build(() => fail(500, { error: 'Plugin package has 2 plugin roots; expected exactly one' }));
        await assert.rejects(
            () => api.installPluginFromRelease('decentespresso/dye2'),
            /2 plugin roots/
        );
    });
}

// ── Bridge state for the settings card (dyeStrip.js) ─────────────────────────
{
    const body = lift('dyeStrip.js', [
        /export async function getDye2VersionInfo\(\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = (getPlugins) => new Function(
        'PLUGIN_ID', 'getPlugins',
        `${body}\nreturn getDye2VersionInfo;`
    )('dye2.reaplugin', getPlugins);

    test('getDye2VersionInfo maps installed version, source and pending update', async () => {
        const getDye2VersionInfo = build(async () => [
            { id: 'settings.reaplugin', version: '1.0.0', loaded: true },
            {
                id: 'dye2.reaplugin',
                version: '0.1.6',
                loaded: true,
                source: { kind: 'github_release', repo: 'decentespresso/dye2', releaseTag: 'v0.1.6' },
                pendingUpdate: { version: '0.2.0', releaseTag: 'v0.2.0', addedPermissions: ['proxy.decent_api'] },
            },
        ]);

        const info = await getDye2VersionInfo();
        assert.equal(info.reachable, true);
        assert.equal(info.installed, '0.1.6');
        assert.equal(info.loaded, true);
        assert.equal(info.source.releaseTag, 'v0.1.6');
        assert.deepEqual(info.pending.addedPermissions, ['proxy.decent_api']);
    });

    test('an installed plugin with no pending update reports none', async () => {
        const getDye2VersionInfo = build(async () => [{ id: 'dye2.reaplugin', version: '0.1.6', loaded: false }]);
        const info = await getDye2VersionInfo();

        assert.equal(info.reachable, true);
        assert.equal(info.loaded, false);
        assert.equal(info.pending, null);
        assert.equal(info.source, null);
    });

    test('a plugin absent from the list reads as not installed, not as unreachable', async () => {
        const getDye2VersionInfo = build(async () => []);
        const info = await getDye2VersionInfo();

        assert.equal(info.reachable, true);
        assert.equal(info.installed, null);
    });

    test('an unreachable bridge is reported as such, never as "not installed"', async () => {
        // getPlugins returns null on a failed fetch, and can also reject outright.
        for (const getPlugins of [async () => null, async () => { throw new Error('offline'); }]) {
            const info = await build(getPlugins)();
            assert.equal(info.reachable, false);
            assert.equal(info.installed, null);
        }
    });
}

// ── Automatic update check + the switch-on offer (dyeStrip.js) ───────────────
{
    const body = lift('dyeStrip.js', [
        /export async function checkDye2UpdatesIfDue\(\) \{[\s\S]*?\r?\n\}/,
        /export async function offerDye2Update\(\) \{[\s\S]*?\r?\n\}/,
    ]);

    // The bridge is a single mutable state, as it is in the app: checkPluginUpdates
    // is what changes it, because Decaid installs permissionless updates inside
    // that call and records a pendingUpdate for the rest.
    const build = ({ state, onCheck, promptResult = false }) => {
        const calls = { checks: 0, prompts: [] };
        let current = state;
        const fns = new Function(
            'getDye2VersionInfo', 'checkPluginUpdates', 'promptPluginUpdate', 'logger', 'CHECK_COOLDOWN_MS',
            `${body}\nreturn { checkDye2UpdatesIfDue, offerDye2Update };`
        )(
            async () => current,
            async () => {
                calls.checks++;
                const next = onCheck?.();
                if (next instanceof Error) throw next;
                if (next) current = next;
            },
            async (info) => { calls.prompts.push(info); return promptResult; },
            { info() {}, error() {} },
            15 * 60 * 1000,
        );
        return { ...fns, calls };
    };

    const installed = (version, { checkedMinutesAgo = 120, ...extra } = {}) => ({
        reachable: true, installed: version, loaded: true,
        source: {
            kind: 'github_release', repo: 'decentespresso/dye2', releaseTag: `v${version}`,
            lastChecked: new Date(Date.now() - checkedMinutesAgo * 60 * 1000).toISOString(),
        },
        pending: null, ...extra,
    });

    test('an untracked copy is left alone -- Decaid cannot update a ZIP or folder install', async () => {
        const { checkDye2UpdatesIfDue, calls } = build({ state: { ...installed('0.1.6'), source: null } });
        await checkDye2UpdatesIfDue();
        assert.equal(calls.checks, 0);
    });

    test('a check Decaid ran minutes ago is not repeated -- GitHub allows 60 an hour', async () => {
        const { checkDye2UpdatesIfDue, calls } = build({ state: installed('0.1.6', { checkedMinutesAgo: 2 }) });
        await checkDye2UpdatesIfDue();
        assert.equal(calls.checks, 0);
    });

    test('a source that has never been checked is checked', async () => {
        const state = installed('0.1.6');
        delete state.source.lastChecked;
        const { checkDye2UpdatesIfDue, calls } = build({ state });
        await checkDye2UpdatesIfDue();
        assert.equal(calls.checks, 1);
    });

    test('the check returns the state after it, so the settings card renders the outcome', async () => {
        const { checkDye2UpdatesIfDue } = build({
            state: installed('0.1.6'),
            onCheck: () => installed('0.2.0'),
        });
        assert.equal((await checkDye2UpdatesIfDue()).installed, '0.2.0');
    });

    test('a failed check leaves the installed plugin reported as-is, never throws', async () => {
        const { checkDye2UpdatesIfDue, calls } = build({
            state: installed('0.1.6'),
            onCheck: () => new Error('403 rate limited'),
        });
        assert.equal((await checkDye2UpdatesIfDue()).installed, '0.1.6');
        assert.equal(calls.checks, 1);
    });

    test('the check never prompts -- only the switch-on path does', async () => {
        const pending = { version: '0.2.0', addedPermissions: ['proxy.decent_api'] };
        const { checkDye2UpdatesIfDue, calls } = build({
            state: installed('0.1.6'),
            onCheck: () => installed('0.1.6', { pending }),
        });
        const info = await checkDye2UpdatesIfDue();
        assert.deepEqual(info.pending, pending);
        assert.equal(calls.prompts.length, 0);
    });

    test('an update needing no new permission is already installed by the check, so no prompt', async () => {
        const { offerDye2Update, calls } = build({
            state: installed('0.1.6'),
            onCheck: () => installed('0.2.0'),
        });
        assert.equal(await offerDye2Update(), true);
        assert.equal(calls.prompts.length, 0);
    });

    test('a permission-escalating update prompts on switch-on, and the prompt decides the result', async () => {
        const pending = { version: '0.2.0', addedPermissions: ['proxy.decent_api'] };
        const { offerDye2Update, calls } = build({
            state: installed('0.1.6'),
            onCheck: () => installed('0.1.6', { pending }),
            promptResult: true,
        });
        assert.equal(await offerDye2Update(), true);
        assert.deepEqual(calls.prompts[0].pending, pending);
    });

    test('a pendingUpdate from an earlier check still prompts while the check is on cooldown', async () => {
        const pending = { version: '0.2.0', addedPermissions: ['emit'] };
        const { offerDye2Update, calls } = build({
            state: installed('0.1.6', { checkedMinutesAgo: 2, pending }),
        });
        await offerDye2Update();
        assert.equal(calls.checks, 0);
        assert.equal(calls.prompts.length, 1);
    });

    test('nothing to do when the plugin is already current', async () => {
        const { offerDye2Update, calls } = build({ state: installed('0.1.6') });
        assert.equal(await offerDye2Update(), false);
        assert.equal(calls.prompts.length, 0);
    });
}

// ── Workflow context policy (dyeStrip.js, workflow-note.js) ─────────────────
// Bean, roaster, batch, grinder, barista, drinker, basket and rpm persist across
// shots and reloads; only the note is per shot. The one remaining wipe is the
// Settings switch-off of DYE2.
{
    const { noteClearContext } = await import('../src/modules/workflow-note.js');
    const body = lift('dyeStrip.js', [
        /const DYE2_OWNED_CONTEXT = \{[\s\S]*?\n\};/,
        /export async function clearDye2ContextOnDisable\([\s\S]*?\r?\n\}/,
    ]);
    const build = (context) => {
        const puts = [];
        const fn = new Function('getWorkflow', 'updateWorkflow', 'logger',
            `${body}\nreturn { clearDye2ContextOnDisable };`);
        const api = fn(async () => ({ context }), async (p) => { puts.push(p); return p; }, { info() {}, warn() {} });
        return { ...api, puts };
    };

    const dirty = {
        targetDoseWeight: 22, targetYield: 44, grinderSetting: '21.00',
        beanBatchId: 'b1', coffeeName: 'Colombia El Paraiso', coffeeRoaster: 'La Cabra',
        grinderId: 'g1', baristaName: 'Mark', drinkerName: 'John',
        extras: { note: 'Well balanced', rpm: 0, basketId: 'k1', basketName: 'ims 18g', dye: { v: 1 } },
    };

    test('the note is cleared after a shot only when one is set, and nothing else is touched', () => {
        assert.deepEqual(noteClearContext(dirty), { extras: { note: null } });
        assert.deepEqual(noteClearContext({ extras: { note: '' } }), { extras: { note: null } });
        assert.equal(noteClearContext({ extras: { note: null } }), null);
        assert.equal(noteClearContext({ coffeeName: 'x', baristaName: 'y' }), null);
        assert.equal(noteClearContext(null), null);
        assert.deepEqual(Object.keys(noteClearContext(dirty)), ['extras']);
    });

    test('the DYE2 switch-off wipes every DYE2-owned field including grinderSetting', async () => {
        const { clearDye2ContextOnDisable, puts } = build(dirty);
        assert.equal(await clearDye2ContextOnDisable(), true);
        assert.equal(puts.length, 1);
        const sent = puts[0].context;
        for (const key of ['beanBatchId', 'coffeeName', 'coffeeRoaster', 'grinderId', 'grinderModel',
            'grinderSetting', 'baristaName', 'drinkerName']) {
            assert.equal(sent[key], null, key);
        }
        assert.deepEqual(sent.extras, { basketId: null, basketName: null, rpm: null, note: null, dye: null });
        assert.ok(!('targetDoseWeight' in sent) && !('targetYield' in sent) && !('profile' in sent));
    });

    test('no PUT when nothing is set; rpm 0 and an empty note count as set', async () => {
        const empty = build({ targetDoseWeight: 18, targetYield: 36 });
        assert.equal(await empty.clearDye2ContextOnDisable(), false);
        assert.equal(empty.puts.length, 0);
        assert.equal(await build({ extras: { rpm: 0 } }).clearDye2ContextOnDisable(), true);
        assert.equal(await build({ extras: { note: '' } }).clearDye2ContextOnDisable(), true);
        assert.equal(await build({ grinderSetting: '21.00' }).clearDye2ContextOnDisable(), true);
        assert.equal(await build(null).clearDye2ContextOnDisable(), false);
    });

    test('a failed workflow read never throws at the caller', async () => {
        const fn = new Function('getWorkflow', 'updateWorkflow', 'logger',
            `${body}\nreturn { clearDye2ContextOnDisable };`);
        const { clearDye2ContextOnDisable } = fn(
            async () => { throw new Error('bridge down'); },
            async () => { throw new Error('should not be reached'); },
            { info() {}, warn() {} },
        );
        assert.equal(await clearDye2ContextOnDisable(), false);
    });
}

// ── Recipe-cell long-press → DYE2 recipe-edit deep link (dyeStrip.js) ───────
// Current DYE2 recipe-edit opens a recipe by its opaque id ('dye_editRecipeId').
// Older builds read 'dye_editRecipeIdx' (ids '1'..'5', index = id - 1), which is
// still set when the id has that shape. A blank cell clears the id key so
// recipe-edit starts a new recipe.
{
    const body = lift('dyeStrip.js', [
        /function editRecipe\(recipe\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = () => {
        const store = {};
        const opened = [];
        const fn = new Function('sessionStorage', 'openPluginOverlay', `${body}\nreturn editRecipe;`);
        const editRecipe = fn(
            { setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
            (page, params) => opened.push(params ? [page, params] : page),
        );
        return { editRecipe, store, opened };
    };

    test('an opaque id is passed through and sets no legacy index', () => {
        const { editRecipe, store, opened } = build();
        editRecipe({ id: 'rcp_ab12' });
        assert.equal(store.dye_editRecipeId, 'rcp_ab12');
        assert.equal(store.dye_editRecipeIdx, undefined);
        assert.deepEqual(opened, [['recipe-edit', { id: 'rcp_ab12' }]]);
    });

    test('a legacy id "1" also sets index 0 and "5" index 4 for an older DYE2', () => {
        const { editRecipe, store } = build();
        editRecipe({ id: '1' });
        assert.equal(store.dye_editRecipeId, '1');
        assert.equal(store.dye_editRecipeIdx, '0');
        editRecipe({ id: '5' });
        assert.equal(store.dye_editRecipeIdx, '4');
    });

    test('a blank cell clears the id (new recipe) and keeps the slot index for an older DYE2', () => {
        const { editRecipe, store } = build();
        store.dye_editRecipeId = 'stale';
        editRecipe({ id: '3', blank: true });
        assert.equal(store.dye_editRecipeId, undefined);
        assert.equal(store.dye_editRecipeIdx, '2');
    });

    test('a blank cell asks for a new recipe on that slot; a recipe passes its id in the URL', () => {
        const { editRecipe, opened } = build();
        editRecipe({ id: '3', blank: true });
        editRecipe({ id: 'rcp_x' });
        // ?slot is the cell that was tapped: without it DYE2 starts with no slot targeted and
        // SAVE files the recipe in the library, leaving the cell blank. An older DYE2 ignores it.
        assert.deepEqual(opened, [
            ['recipe-edit', { new: 1, slot: '3' }],
            ['recipe-edit', { id: 'rcp_x' }],
        ]);
    });
}

// ── Favourite-cell long-press → DYE2 auto-fav-edit deep link (dyeStrip.js) ──
// Applying a favourite only ever pushes its captured grind (etc.) onto the
// workflow -- it never updates the favourite back (KV_CONTRACT.md's
// single-writer rule), so a grind dialed in afterward is lost on the next
// apply unless the user re-saves it onto the favourite itself. Long-press
// deep-links to DYE2's own per-field editor for that exact favourite instead
// of the generic list, via the same 'dye_editAutoFavId' key auto-favs.ts sets
// before its own edit-pencil navigation.
{
    const body = lift('dyeStrip.js', [
        /function editFavourite\(fav\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = () => {
        const store = {};
        const opened = [];
        const fn = new Function('sessionStorage', 'openPluginOverlay', `${body}\nreturn editFavourite;`);
        const editFavourite = fn(
            { setItem: (k, v) => { store[k] = v; } },
            (page) => opened.push(page),
        );
        return { editFavourite, store, opened };
    };

    test('deep-links straight to the favourite by its own id', () => {
        const { editFavourite, store, opened } = build();
        editFavourite({ id: 'fav-123' });
        assert.equal(store.dye_editAutoFavId, 'fav-123');
        assert.deepEqual(opened, ['auto-fav-edit']);
    });

    test('a favourite with no id falls back to the plain list, not a blank "new favourite" form', () => {
        const { editFavourite, store, opened } = build();
        editFavourite({});
        assert.equal(store.dye_editAutoFavId, undefined);
        assert.deepEqual(opened, ['auto-favs']);
    });
}

// ── Recipe auto-save: which fields one dashboard edit can save (dyeStrip.js) ─
// Applying a recipe only ever pushes it onto the workflow -- this is the other
// direction, folding a dashboard edit back into the active recipe. The only
// safety property that matters here is that it never claims to represent an
// edit the recipe schema has no field for (KV_CONTRACT.md's dashboardVariables
// shape): calibrated auto-steam is a dashboard-only concept with nothing to
// write into, so it must produce no patch at all rather than a guessed one.
// The milk auto-stop DOES have a field -- steamStopAtTempC, added in dye2
// 6aec7f3 along with a Milk stop control in the recipe editor.
{
    const recipeAutoSaveFields = new Function(
        `${readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8')
            .match(/export function recipeAutoSaveFields\(dataToSend, workflow\) \{[\s\S]*?\r?\n\}/)[0]
            .replace('export ', '')}\nreturn recipeAutoSaveFields;`
    )();

    test('grind edit -- the workflow response wins over the sent payload', () => {
        const patch = recipeAutoSaveFields(
            { context: { grinderSetting: '21.00' } },
            { context: { grinderSetting: '21.50' } }, // e.g. server-side rounding
        );
        assert.deepEqual(patch, { grind: 21.5 });
    });

    test('dose and yield map to dose/drink', () => {
        const patch = recipeAutoSaveFields(
            { context: { targetDoseWeight: 18, targetYield: 36 } },
            { context: { targetDoseWeight: 18, targetYield: 36 } },
        );
        assert.deepEqual(patch, { dose: 18, drink: 36 });
    });

    test('a full profile PUT (brew temp tile) reads the first step\'s temperature', () => {
        const patch = recipeAutoSaveFields(
            { profile: { steps: [{ temperature: 93 }, { temperature: 93 }] } },
            { profile: { steps: [{ temperature: 93 }] } },
        );
        assert.deepEqual(patch, { brewC: 93 });
    });

    test('a steam duration edit sets steamMode time, not flow', () => {
        const patch = recipeAutoSaveFields(
            { steamSettings: { duration: 25 } },
            { steamSettings: { duration: 25, flow: 1.2 } },
        );
        assert.deepEqual(patch, { steamMode: 'time', steamTimeS: 25 });
    });

    test('a steam flow edit sets steamMode flow, not time', () => {
        const patch = recipeAutoSaveFields(
            { steamSettings: { flow: 1.4 } },
            { steamSettings: { duration: 25, flow: 1.4 } },
        );
        assert.deepEqual(patch, { steamMode: 'flow', steamFlowMls: 1.4 });
    });

    test('a milk auto-stop edit records steamStopAtTempC and leaves steamMode alone', () => {
        // steamMode names which of the time/flow PAIR the editor shows; there
        // is no 'milk' value for it, so the stop is recorded on its own.
        const patch = recipeAutoSaveFields(
            { steamSettings: { stopAtTemperature: 65 } },
            { steamSettings: { stopAtTemperature: 65 } },
        );
        assert.deepEqual(patch, { steamStopAtTempC: 65 });
    });

    test('a milk auto-stop of 0 is a real value -- the stop turned off', () => {
        const patch = recipeAutoSaveFields(
            { steamSettings: { stopAtTemperature: 0 } },
            { steamSettings: { stopAtTemperature: 0 } },
        );
        assert.deepEqual(patch, { steamStopAtTempC: 0 });
    });

    test('a steam time edit alongside a stop records both', () => {
        const patch = recipeAutoSaveFields(
            { steamSettings: { duration: 25, stopAtTemperature: 62 } },
            { steamSettings: { duration: 25, stopAtTemperature: 62 } },
        );
        assert.deepEqual(patch, { steamMode: 'time', steamTimeS: 25, steamStopAtTempC: 62 });
    });

    test('hot water volume vs temperature pick the matching mode', () => {
        assert.deepEqual(
            recipeAutoSaveFields({ hotWaterData: { volume: 120 } }, { hotWaterData: { volume: 120 } }),
            { hotWaterMode: 'vol', hotWaterMl: 120 },
        );
        assert.deepEqual(
            recipeAutoSaveFields({ hotWaterData: { targetTemperature: 85 } }, { hotWaterData: { targetTemperature: 85 } }),
            { hotWaterMode: 'temp', hotWaterTempC: 85 },
        );
    });

    test('one write carrying both hot water fields records both, not just the first', () => {
        const patch = recipeAutoSaveFields(
            { hotWaterData: { volume: 120, targetTemperature: 85 } },
            { hotWaterData: { volume: 120, targetTemperature: 85 } },
        );
        assert.deepEqual(patch, { hotWaterMode: 'vol', hotWaterMl: 120, hotWaterTempC: 85 });
    });

    test('the workflow response wins over the sent payload for the stop and hot water too', () => {
        assert.deepEqual(
            recipeAutoSaveFields(
                { steamSettings: { stopAtTemperature: 65 }, hotWaterData: { targetTemperature: 85 } },
                { steamSettings: { stopAtTemperature: 64 }, hotWaterData: { targetTemperature: 86 } },
            ),
            { steamStopAtTempC: 64, hotWaterMode: 'temp', hotWaterTempC: 86 },
        );
    });

    test('flush maps to flushS', () => {
        const patch = recipeAutoSaveFields({ rinseData: { duration: 8 } }, { rinseData: { duration: 8 } });
        assert.deepEqual(patch, { flushS: 8 });
    });

    test('an edit with nothing this schema covers produces an empty patch', () => {
        assert.deepEqual(recipeAutoSaveFields({ context: { extras: { note: 'x' } } }, {}), {});
    });
}

// ── Recipe apply: which held settings reach the machine (dyeStrip.js)
// The other direction. KV_CONTRACT.md is explicit that steamMode/hotWaterMode
// are display-only and "Apply ignores them and writes every setting held" --
// DYE2's own apply says the same (plugin.js RECIPE_MACHINE_FIELDS). Gating the
// write on the mode silently dropped everything the recipe held outside it.
{
    const persisted = [];
    const mergeRecipeLiveSettings = new Function(
        'persistSharedValue', 'STEAM_DURATION_LAST_VALUE_KEY', 'STEAM_FLOW_LAST_VALUE_KEY',
        'MILK_STOP_LAST_VALUE_KEY', 'HOT_WATER_VOLUME_LAST_VALUE_KEY', 'HOT_WATER_TEMP_LAST_VALUE_KEY',
        'FLUSH_DURATION_LAST_VALUE_KEY',
        `${readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8')
            .match(/async function mergeRecipeLiveSettings\(dv\) \{[\s\S]*?\r?\n\}/)[0]}\nreturn mergeRecipeLiveSettings;`
    )(
        async (key, value) => { persisted.push([key, value]); },
        'last-steam-duration', 'last-steam-flow', 'last-milk-stop',
        'last-hot-water-volume', 'last-hot-water-temp', 'last-flush-duration',
    );

    test('a recipe\'s milk stop reaches the machine and is remembered', async () => {
        persisted.length = 0;
        const patch = await mergeRecipeLiveSettings({ steamStopAtTempC: 62 });
        assert.deepEqual(patch, { steamSettings: { stopAtTemperature: 62 } });
        assert.deepEqual(persisted, [['last-milk-stop', 62]]);
    });

    test('a stop of 0 is applied but never remembered', async () => {
        // 0 means the stop is off; remembering it would erase the temperature
        // the user tuned, the same rule api.setStopAtTemperature follows.
        persisted.length = 0;
        const patch = await mergeRecipeLiveSettings({ steamStopAtTempC: 0 });
        assert.deepEqual(patch, { steamSettings: { stopAtTemperature: 0 } });
        assert.deepEqual(persisted, []);
    });

    test('the stop rides along with a steam time without needing a steamMode', async () => {
        persisted.length = 0;
        const patch = await mergeRecipeLiveSettings({ steamMode: 'time', steamTimeS: 25, steamStopAtTempC: 62 });
        assert.deepEqual(patch, { steamSettings: { duration: 25, stopAtTemperature: 62 } });
    });

    test('every hot water setting held is applied, whatever the display mode says', async () => {
        persisted.length = 0;
        const patch = await mergeRecipeLiveSettings({
            hotWaterMode: 'vol', hotWaterMl: 120, hotWaterTempC: 85,
            hotWaterTimeS: 30, hotWaterFlowMls: 6,
        });
        assert.deepEqual(patch, {
            hotWaterData: { volume: 120, targetTemperature: 85, duration: 30, flow: 6 },
        });
        assert.deepEqual(persisted, [['last-hot-water-volume', 120], ['last-hot-water-temp', 85]]);
    });

    test('a recipe holding nothing produces no patch', async () => {
        assert.deepEqual(await mergeRecipeLiveSettings({}), {});
    });
}

// ── Favourite auto-save: which fields one dashboard edit can save (dyeStrip.js)
// A favourite's snapshot has no brew-temp/steam/hot-water/flush field at all
// (KV_CONTRACT.md's autoFavourites[] schema, and auto-fav-edit.ts's own field
// list has no editor for any of them) -- narrower than a recipe on purpose.
{
    const favouriteAutoSaveFields = new Function(
        `${readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8')
            .match(/export function favouriteAutoSaveFields\(dataToSend, workflow\) \{[\s\S]*?\r?\n\}/)[0]
            .replace('export ', '')}\nreturn favouriteAutoSaveFields;`
    )();

    test('dose, yield and grind map onto the snapshot', () => {
        const patch = favouriteAutoSaveFields(
            { context: { targetDoseWeight: 18, targetYield: 36, grinderSetting: '22.00' } },
            { context: { targetDoseWeight: 18, targetYield: 36, grinderSetting: '22.00' } },
        );
        assert.deepEqual(patch, { dose: 18, drink: 36, grindSetting: 22 });
    });

    test('a brew-temp edit has no snapshot field -- produces no patch at all', () => {
        const patch = favouriteAutoSaveFields(
            { profile: { steps: [{ temperature: 93 }] } },
            { profile: { steps: [{ temperature: 93 }] } },
        );
        assert.deepEqual(patch, {});
    });

    test('a steam edit has no snapshot field -- produces no patch at all', () => {
        const patch = favouriteAutoSaveFields({ steamSettings: { duration: 25 } }, { steamSettings: { duration: 25 } });
        assert.deepEqual(patch, {});
    });
}

// ── Auto-save write: only ever touches one item in one array (dyeStrip.js) ──
{
    const body = lift('dyeStrip.js', [
        /async function saveItemFields\(kind, id, fields\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = (initial) => {
        let stored = null;
        const fn = new Function(
            'getDye2KvArray', 'setDye2KvArray', 'AUTOSAVE_TARGETS', 'logger',
            `${body}\nreturn saveItemFields;`
        );
        const saveItemFields = fn(
            async () => initial,
            async (key, items) => { stored = { key, items }; },
            {
                recipe: { key: 'recipes', field: 'dashboardVariables' },
                favourite: { key: 'autoFavourites', field: 'snapshot' },
            },
            { info() {}, error() {} },
        );
        return { saveItemFields, getStored: () => stored };
    };

    test('patches only the matching recipe, leaving every other recipe byte-identical', async () => {
        const other = { id: '2', name: 'Other', dashboardVariables: { dose: 20 } };
        const target = { id: '1', name: 'Mine', dashboardVariables: { dose: 18, grind: 20 } };
        const { saveItemFields, getStored } = build([target, other]);

        await saveItemFields('recipe', '1', { grind: 21.5 });

        const { key, items } = getStored();
        assert.equal(key, 'recipes');
        assert.deepEqual(items[1], other); // untouched, not even a new object
        assert.deepEqual(items[0].dashboardVariables, { dose: 18, grind: 21.5 });
        assert.equal(items[0].name, 'Mine'); // fields outside dashboardVariables preserved
    });

    test('patches only the matching favourite\'s snapshot, leaving every other favourite byte-identical', async () => {
        const other = { id: 'fav-2', title: 'Other', snapshot: { dose: 20 } };
        const target = { id: 'fav-1', title: 'Mine', snapshot: { dose: 18, grindSetting: 20 } };
        const { saveItemFields, getStored } = build([target, other]);

        await saveItemFields('favourite', 'fav-1', { grindSetting: 21.5 });

        const { key, items } = getStored();
        assert.equal(key, 'autoFavourites');
        assert.deepEqual(items[1], other);
        assert.deepEqual(items[0].snapshot, { dose: 18, grindSetting: 21.5 });
        assert.equal(items[0].title, 'Mine');
    });

    test('an id no longer in the array (deleted/renumbered) writes nothing', async () => {
        const { saveItemFields, getStored } = build([{ id: '2', dashboardVariables: {} }]);
        await saveItemFields('recipe', '1', { grind: 21 });
        assert.equal(getStored(), null);
    });
}

// ── Profile-drift guard (dyeStrip.js) ───────────────────────────────────────
// Decaid's workflow.profile carries no `id` (#90), so the guard's original
// id comparison never fires. profileFingerprint is the backup signal, and it
// must ignore step temperature specifically -- that is the one profile field
// a recipe's own brew-temp auto-save rewrites in place.
{
    const profileA = { title: 'Profile A', target_weight: 36, steps: [{ pump: 'flow', flow: 2, temperature: 93 }] };
    const profileB = { title: 'Profile B', target_weight: 18, steps: [{ pump: 'pressure', pressure: 9, temperature: 93 }] };

    // Moved to the DOM-free dye-selection.js, which node can import directly.
    const { profileFingerprint, profileDrifted } = await import('../src/modules/dye-selection.js');

    test('profileFingerprint(profile): unaffected by a temperature-only change, changed by a different profile', () => {
        assert.equal(profileFingerprint(null), null);
        const original = profileFingerprint(profileA);
        const tempTweaked = profileFingerprint({ ...profileA, steps: [{ ...profileA.steps[0], temperature: 96 }] });
        assert.equal(tempTweaked, original);
        assert.notEqual(profileFingerprint(profileB), original);
    });

    const body = lift('dyeStrip.js', [
        /let activeItem = null;[\s\S]*?autoSavePending = \{\};\n\}/,
        /function handleWorkflowUpdatedForAutoSave\(workflow, dataToSend\) \{[\s\S]*?\r?\n\}/,
    ]);

    // `records` is dyeStrip's dye2Armed: true means DYE2 confirmed it armed the item and does
    // this itself and none of the lifted code may write (see pluginRecordsDialIn).
    const build = ({ patch = () => ({ dose: 1 }), records = false } = {}) => {
        const saveCalls = [];
        const fn = new Function(
            'AUTOSAVE_TARGETS', 'AUTOSAVE_DEBOUNCE_MS', 'isDye2Enabled', 'setTimeout', 'clearTimeout', 'saveItemFields', 'logger', 'profileDrifted', 'dye2Armed',
            `${body}\nreturn { handleWorkflowUpdatedForAutoSave, setActiveItem: v => { activeItem = v; }, getActiveItem: () => activeItem };`
        );
        const handler = fn(
            { recipe: { patch } },
            0,
            () => true,
            (task) => { task(); return 0; }, // run the debounced flush inline
            () => {},
            async (kind, id, fields) => { saveCalls.push({ kind, id, fields }); },
            { error() {}, info() {} },
            profileDrifted,
            records,
        );
        return { ...handler, saveCalls };
    };

    test('a PUT for a different profile clears the active item and never reaches the patch', () => {
        const { handleWorkflowUpdatedForAutoSave, setActiveItem, getActiveItem, saveCalls } = build({
            patch: () => { throw new Error('must not run once drift is detected'); },
        });
        setActiveItem({ kind: 'recipe', id: '1', profileId: null, profileFingerprint: profileFingerprint(profileA) });

        handleWorkflowUpdatedForAutoSave({ profile: profileB }, { profile: profileB });

        assert.equal(getActiveItem(), null);
        assert.deepEqual(saveCalls, []);
    });

    test('a brew-temperature-only PUT (same profile, new temperature) keeps the item active and auto-saves', () => {
        const { handleWorkflowUpdatedForAutoSave, setActiveItem, getActiveItem, saveCalls } = build();
        setActiveItem({ kind: 'recipe', id: '1', profileId: null, profileFingerprint: profileFingerprint(profileA) });
        const retempered = { ...profileA, steps: [{ ...profileA.steps[0], temperature: 96 }] };

        handleWorkflowUpdatedForAutoSave({ profile: retempered }, { profile: retempered });

        assert.notEqual(getActiveItem(), null);
        assert.equal(saveCalls.length, 1);
        assert.deepEqual(saveCalls[0], { kind: 'recipe', id: '1', fields: { dose: 1 } });
    });

    test('a DYE2 that records dial-in itself: the skin writes nothing, whatever is armed', () => {
        const { handleWorkflowUpdatedForAutoSave, setActiveItem, getActiveItem, saveCalls } = build({
            records: true,
            patch: () => { throw new Error('must not run while DYE2 records for itself'); },
        });
        setActiveItem({ kind: 'recipe', id: '1', profileId: null, profileFingerprint: profileFingerprint(profileA) });

        handleWorkflowUpdatedForAutoSave({ profile: profileA }, { profile: profileA });

        assert.deepEqual(saveCalls, []);
        assert.notEqual(getActiveItem(), null); // not its job to clear either
    });
}
