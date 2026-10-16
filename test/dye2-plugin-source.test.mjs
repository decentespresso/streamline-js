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

// ── Workflow context cleanup (dyeStrip.js) ──────────────────────────────────
// DYE2 stamps bean/barista identity onto the workflow context and Decaid copies
// the workflow into every persisted ShotRecord, so anything left there labels
// later shots nobody meant to label. The clear runs after each persisted shot
// and at boot when DYE2 isn't running; what matters is that it nulls exactly the
// plugin-owned fields, leaves the dashboard's own dose/yield/grind alone, and
// stays silent when there is nothing to clear.
{
    const body = lift('dyeStrip.js', [
        /const DYE_CONTEXT_FIELDS = \{[\s\S]*?\n\};/,
        /export function hasDyeContext\([\s\S]*?\r?\n\}/,
        /export async function clearDyeWorkflowContext\([\s\S]*?\r?\n\}/,
    ]);

    const { scopedClearContext, hasDyeMarker } = await import('../src/modules/dye-context.js');
    const build = (context, { scoped = false } = {}) => {
        const puts = [];
        const fn = new Function('getWorkflow', 'updateWorkflow', 'logger', 'scopedClearSupported', 'scopedClearContext', 'hasDyeMarker',
            `${body}\nreturn { hasDyeContext, clearDyeWorkflowContext };`);
        const api = fn(
            async () => ({ context }),
            async (payload) => { puts.push(payload); return payload; },
            { info() {}, warn() {} },
            async () => scoped,
            scopedClearContext,
            hasDyeMarker,
        );
        return { ...api, puts };
    };

    const dirty = {
        targetDoseWeight: 22, targetYield: 44, grinderSetting: '21.00',
        beanBatchId: 'b1', coffeeName: 'Colombia El Paraiso', coffeeRoaster: 'La Cabra',
        grinderId: 'g1', baristaName: 'Mark', drinkerName: 'John',
        extras: { note: 'Well balanced', rpm: 0, basketId: 'k1', basketName: 'ims 18g' },
    };

    test('clears every plugin-owned field and nothing the dashboard owns', async () => {
        const { clearDyeWorkflowContext, puts } = build(dirty);
        assert.equal(await clearDyeWorkflowContext(), true);
        assert.equal(puts.length, 1);
        const sent = puts[0].context;
        for (const key of ['beanBatchId', 'coffeeName', 'coffeeRoaster', 'grinderId',
            'grinderModel', 'baristaName', 'drinkerName']) {
            assert.equal(sent[key], null, key);
        }
        assert.deepEqual(sent.extras, { basketId: null, basketName: null, rpm: null, note: null, dye: null });
        assert.ok(!('targetDoseWeight' in sent));
        assert.ok(!('targetYield' in sent));
        assert.ok(!('grinderSetting' in sent), 'the grind tile is not DYE2-owned');
        assert.ok(!('profile' in puts[0]));
    });

    test('coffee picker selection is cleared for the following shot without changing dose or grind', async () => {
        const context = {
            targetDoseWeight: 18, targetYield: 36, grinderSetting: '21',
            ...currentBeanContext({ id: 'bean', name: 'Lot', roaster: 'Roaster' }, { id: 'batch', beanId: 'bean' }),
        };
        const { clearDyeWorkflowContext, puts } = build(context);
        assert.equal(context.beanBatchId, 'batch');
        assert.equal(await clearDyeWorkflowContext(), true);
        const followingShot = { ...context, ...puts[0].context };
        assert.equal(followingShot.beanBatchId, null);
        assert.equal(followingShot.coffeeName, null);
        assert.equal(followingShot.coffeeRoaster, null);
        assert.equal(followingShot.targetDoseWeight, 18);
        assert.equal(followingShot.targetYield, 36);
        assert.equal(followingShot.grinderSetting, '21');
    });

    test('a DYE2 that marks its writes: only the flagged fields are cleared, another plugin\'s stay', async () => {
        const context = {
            ...dirty,
            grinderModel: 'EG-1', // set by another plugin, never flagged
            extras: { ...dirty.extras, dye: { v: 1, coffeeName: true, beanBatchId: true, note: true } },
        };
        const { clearDyeWorkflowContext, puts } = build(context, { scoped: true });
        assert.equal(await clearDyeWorkflowContext(), true);
        const sent = puts[0].context;
        assert.equal(sent.coffeeName, null);
        assert.equal(sent.beanBatchId, null);
        assert.equal(sent.extras.note, null);
        assert.deepEqual(sent.extras.dye, { coffeeName: null, beanBatchId: null, note: null });
        for (const kept of ['coffeeRoaster', 'grinderId', 'grinderModel', 'baristaName', 'drinkerName']) {
            assert.ok(!(kept in sent), kept);
        }
        assert.ok(!('rpm' in sent.extras) && !('basketId' in sent.extras));
    });

    test('marked DYE2 that wrote nothing: nothing is cleared, no PUT', async () => {
        const { clearDyeWorkflowContext, puts } = build({ ...dirty, extras: { ...dirty.extras, dye: { v: 1 } } }, { scoped: true });
        assert.equal(await clearDyeWorkflowContext(), false);
        assert.equal(puts.length, 0);
    });

    test('a marker-capable version that sent no marker still gets the blanket clear', async () => {
        // The version gate says the plugin COULD mark its writes, not that it did: a
        // build that declares the version and writes no marker must not silently stop
        // the clear, or one shot's bean identity labels every later shot.
        const { clearDyeWorkflowContext, puts } = build(dirty, { scoped: true });
        assert.equal(await clearDyeWorkflowContext(), true);
        assert.equal(puts[0].context.coffeeName, null);
        assert.equal(puts[0].context.beanBatchId, null);
        assert.ok(!('grinderSetting' in puts[0].context));
    });

    test('the settings switch-off still clears everything, marked or not', async () => {
        const { clearDyeWorkflowContext, puts } = build({ ...dirty, extras: { ...dirty.extras, dye: { v: 1, note: true } } }, { scoped: true });
        await clearDyeWorkflowContext({ includeGrinderSetting: true });
        assert.equal(puts[0].context.coffeeName, null);
        assert.equal(puts[0].context.grinderSetting, null);
    });

    test('grinderSetting goes only when the whole plugin is switched off', async () => {
        const { clearDyeWorkflowContext, puts } = build(dirty);
        await clearDyeWorkflowContext({ includeGrinderSetting: true });
        assert.equal(puts[0].context.grinderSetting, null);
    });

    test('no PUT when there is nothing to clear -- every shot and every boot calls this', async () => {
        const { clearDyeWorkflowContext, puts } = build({ targetDoseWeight: 18, targetYield: 36, grinderSetting: '21.00' });
        assert.equal(await clearDyeWorkflowContext(), false);
        assert.equal(puts.length, 0);
    });

    test('rpm 0 and an empty-string note still count as set', async () => {
        const { hasDyeContext } = build({});
        assert.equal(hasDyeContext({ extras: { rpm: 0 } }), true);
        assert.equal(hasDyeContext({ extras: { note: '' } }), true);
        assert.equal(hasDyeContext({ extras: { note: null } }), false);
        assert.equal(hasDyeContext(null), false);
        assert.equal(hasDyeContext({ grinderSetting: '21.00' }), false);
        assert.equal(hasDyeContext({ grinderSetting: '21.00' }, true), true);
    });

    test('a failed workflow read never throws at the caller', async () => {
        const fn = new Function('getWorkflow', 'updateWorkflow', 'logger',
            `${body}\nreturn { clearDyeWorkflowContext };`);
        const { clearDyeWorkflowContext } = fn(
            async () => { throw new Error('bridge down'); },
            async () => { throw new Error('should not be reached'); },
            { info() {}, warn() {} },
        );
        assert.equal(await clearDyeWorkflowContext(), false);
    });
}

// ── Recipe-cell long-press → DYE2 recipe-edit deep link (dyeStrip.js) ───────
// Long-pressing a recipe cell should land the user directly on that recipe in
// DYE2, not DYE2's dashboard root -- recipe-edit.ts reads the same
// 'dye_editRecipeIdx' sessionStorage key dashboard.ts writes before its own
// "Recipes" settings entry, and recipe ids are the fixed slots '1'..'5', so
// id-1 is the reliable index (not the cell's filtered/sorted position).
{
    const body = lift('dyeStrip.js', [
        /function editRecipe\(recipe\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = () => {
        const store = {};
        const opened = [];
        const fn = new Function('sessionStorage', 'openPluginOverlay', `${body}\nreturn editRecipe;`);
        const editRecipe = fn(
            { setItem: (k, v) => { store[k] = v; } },
            (page) => opened.push(page),
        );
        return { editRecipe, store, opened };
    };

    test('recipe id is the slot index plus one -- id "1" maps to index 0', () => {
        const { editRecipe, store, opened } = build();
        editRecipe({ id: '1' });
        assert.equal(store.dye_editRecipeIdx, '0');
        assert.deepEqual(opened, ['recipe-edit']);
    });

    test('recipe id "5" maps to index 4', () => {
        const { editRecipe, store } = build();
        editRecipe({ id: '5' });
        assert.equal(store.dye_editRecipeIdx, '4');
    });

    test('a missing or non-numeric id falls back to index 0, never negative', () => {
        const { editRecipe, store } = build();
        editRecipe({});
        assert.equal(store.dye_editRecipeIdx, '0');
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
// shape): milk auto-stop and calibrated auto-steam are dashboard-only concepts
// with nothing to write into, so those must produce no patch at all rather than
// a guessed one.
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

    test('a milk auto-stop edit has no recipe field -- produces no steam patch at all', () => {
        const patch = recipeAutoSaveFields(
            { steamSettings: { stopAtTemperature: 65 } },
            { steamSettings: { stopAtTemperature: 65 } },
        );
        assert.deepEqual(patch, {});
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

    test('flush maps to flushS', () => {
        const patch = recipeAutoSaveFields({ rinseData: { duration: 8 } }, { rinseData: { duration: 8 } });
        assert.deepEqual(patch, { flushS: 8 });
    });

    test('an edit with nothing this schema covers produces an empty patch', () => {
        assert.deepEqual(recipeAutoSaveFields({ context: { extras: { note: 'x' } } }, {}), {});
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

// ── A recipe's machine settings on apply (dyeStrip.js) ───────────────────────
//
// DYE2's own apply writes every setting a recipe holds (dye2#23); the strip used to write
// only the active mode's steam/hot-water value plus the flush time, so which page applied a
// recipe decided whether it brewed at the right steam temperature, milk stop, hot-water
// time/flow or flush temperature/flow.
{
    const body = lift('dyeStrip.js', [
        /const RECIPE_MACHINE_FIELDS = \[[\s\S]*?\r?\n\];/,
        /async function mergeRecipeLiveSettings\(wf, dv\) \{[\s\S]*?\r?\n\}/,
    ]);

    const build = () => {
        const persisted = [];
        const merge = new Function(
            'persistSharedValue', 'STEAM_TEMP_LAST_VALUE_KEY', 'STEAM_DURATION_LAST_VALUE_KEY',
            'STEAM_FLOW_LAST_VALUE_KEY', 'MILK_STOP_LAST_VALUE_KEY', 'HOT_WATER_TEMP_LAST_VALUE_KEY',
            'HOT_WATER_VOLUME_LAST_VALUE_KEY', 'FLUSH_DURATION_LAST_VALUE_KEY',
            `${body}\nreturn mergeRecipeLiveSettings;`
        )(async (k, v) => persisted.push([k, v]), 'last-steam-temp', 'last-steam-duration',
            'last-steam-flow', 'last-milk-stop', 'last-hot-water-temp', 'last-hot-water-volume',
            'last-flush-duration');
        return { merge, persisted };
    };

    const live = () => ({
        steamSettings: { targetTemperature: 160, duration: 30, flow: 1.5, stopAtTemperature: 0 },
        hotWaterData: { targetTemperature: 85, duration: 30, volume: 120, flow: 6 },
        rinseData: { targetTemperature: 90, duration: 5, flow: 4 },
    });
    const everything = {
        steamMode: 'time', steamTempC: 150, steamTimeS: 40, steamFlowMls: 1.2, steamStopAtTempC: 60,
        hotWaterMode: 'vol', hotWaterTempC: 80, hotWaterTimeS: 20, hotWaterMl: 150, hotWaterFlowMls: 8,
        flushTempC: 88, flushS: 8, flushFlowMls: 3,
    };

    test('every setting the recipe holds is applied, whatever the mode says', async () => {
        const { merge } = build();
        const wf = live();
        await merge(wf, everything);
        assert.deepEqual(wf.steamSettings, { targetTemperature: 150, duration: 40, flow: 1.2, stopAtTemperature: 60 });
        assert.deepEqual(wf.hotWaterData, { targetTemperature: 80, duration: 20, volume: 150, flow: 8 });
        assert.deepEqual(wf.rinseData, { targetTemperature: 88, duration: 8, flow: 3 });
    });

    test('a setting the recipe does not hold leaves the live value alone', async () => {
        const { merge } = build();
        const wf = live();
        await merge(wf, { steamTimeS: 40 });
        assert.deepEqual(wf.steamSettings, { targetTemperature: 160, duration: 40, flow: 1.5, stopAtTemperature: 0 });
        assert.deepEqual(wf.hotWaterData, live().hotWaterData);
        assert.deepEqual(wf.rinseData, live().rinseData);
    });

    test('a sub-object the live workflow has not got is not invented', async () => {
        const { merge } = build();
        const wf = { steamSettings: { duration: 30 } };
        await merge(wf, everything);
        assert.deepEqual(wf, { steamSettings: { duration: 40, targetTemperature: 150, flow: 1.2, stopAtTemperature: 60 } });
    });

    test('the remembered records follow, except a switch turned off', async () => {
        const { merge, persisted } = build();
        await merge(live(), { ...everything, steamStopAtTempC: 0 });
        assert.deepEqual(Object.fromEntries(persisted), {
            'last-steam-temp': 150, 'last-steam-duration': 40, 'last-steam-flow': 1.2,
            'last-hot-water-temp': 80, 'last-hot-water-volume': 150, 'last-flush-duration': 8,
        }, 'the milk stop at 0 is "off", not a target worth remembering');
    });

    test('a steam temperature of 0 is the heater off, and is not remembered either', async () => {
        const { merge, persisted } = build();
        const wf = live();
        await merge(wf, { steamTempC: 0 });
        assert.equal(wf.steamSettings.targetTemperature, 0, 'still applied');
        assert.deepEqual(persisted, [], 'but not recorded as the value to switch back on to');
    });
}
