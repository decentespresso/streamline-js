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

    const build = (context) => {
        const puts = [];
        const fn = new Function('getWorkflow', 'updateWorkflow', 'logger',
            `${body}\nreturn { hasDyeContext, clearDyeWorkflowContext };`);
        const api = fn(
            async () => ({ context }),
            async (payload) => { puts.push(payload); return payload; },
            { info() {}, warn() {} },
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
        assert.deepEqual(sent.extras, { basketId: null, basketName: null, rpm: null, note: null });
        assert.ok(!('targetDoseWeight' in sent));
        assert.ok(!('targetYield' in sent));
        assert.ok(!('grinderSetting' in sent), 'the grind tile is not DYE2-owned');
        assert.ok(!('profile' in puts[0]));
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
