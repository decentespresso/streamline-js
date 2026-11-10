// Selection survives the full-page trip to DYE2 only while it is still true.
// Run: node --test test/dye-selection.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    profileFingerprint, profileDrifted, serializeSelection, restoreSelection,
    parseDyeReturn, resolveReturn, changedFields, pluginRecordsDialIn, armedSelectionId, selectedRecipeSteam, recipeStripCells, favStripCells,
    recipeIdPatch, selectionModified, recipeCellState, profilePatchWithSteps, pluginHasEndpoint,
    stableSkinReturnUrl, DECAID_SKIN_ENTRY_PORT, dropDeletedGrinder,
} from '../src/modules/dye-selection.js';

const profile = { title: 'Londinium', target_weight: 36, steps: [{ name: 'fill', temperature: 90 }, { name: 'pour', temperature: 92 }] };
const item = { kind: 'recipe', id: '2', profileId: null, profileFingerprint: profileFingerprint(profile) };
const ctx = { recipes: [{ id: '1' }, { id: '2' }], favs: [{ id: 7 }], workflow: { profile } };

test('brew-temperature edits are not drift, a profile switch is', () => {
    const warmer = { ...profile, steps: profile.steps.map(s => ({ ...s, temperature: 95 })) };
    assert.equal(profileDrifted(item, { profile: warmer }), false);
    assert.equal(profileDrifted(item, { profile: { ...profile, title: 'Blooming' } }), true);
    assert.equal(profileDrifted(item, { profile: { ...profile, id: 'x' }, }), false); // item has no id to compare
    assert.equal(profileDrifted({ ...item, profileId: 'a' }, { profile: { ...profile, id: 'b' } }), true);
    assert.equal(profileDrifted(null, { profile }), false);
});

test('a yield change folded into target_weight/target_volume is not drift (#147)', () => {
    assert.equal(profileDrifted(item, { profile: { ...profile, target_weight: 42, target_volume: 50 } }), false);
});

test('serialize keeps only the four fields and refuses junk', () => {
    assert.deepEqual(JSON.parse(serializeSelection({ ...item, extra: 1 })), item);
    assert.equal(serializeSelection(null), null);
    assert.equal(serializeSelection({ kind: 'other', id: 1 }), null);
    assert.equal(serializeSelection({ kind: 'recipe', id: null }), null);
});

test('restore: round trip re-arms the same item', () => {
    assert.deepEqual(restoreSelection(serializeSelection(item), ctx), item);
});

test('restore: favourites resolve against favs, ids compared as strings', () => {
    const fav = { kind: 'favourite', id: 7, profileId: null, profileFingerprint: item.profileFingerprint };
    assert.deepEqual(restoreSelection(serializeSelection(fav), ctx), fav);
    assert.equal(restoreSelection(serializeSelection({ ...item, id: 2 }), ctx).id, 2);
});

test('restore: discarded when deleted, drifted, or unreadable', () => {
    assert.equal(restoreSelection(serializeSelection({ ...item, id: '9' }), ctx), null);
    assert.equal(restoreSelection(serializeSelection(item), { ...ctx, workflow: { profile: { ...profile, title: 'Other' } } }), null);
    assert.equal(restoreSelection('{not json', ctx), null);
    assert.equal(restoreSelection('null', ctx), null);
    assert.equal(restoreSelection(serializeSelection(item), { ...ctx, recipes: undefined }), null);
});

test('return param: absent means an older DYE2, empty means nothing applied', () => {
    assert.deepEqual(parseDyeReturn(''), { supported: false });
    assert.deepEqual(parseDyeReturn('?_=1'), { supported: false });
    assert.deepEqual(parseDyeReturn('?dyeApplied='), { supported: true, applied: 'none' });
    assert.deepEqual(parseDyeReturn('?dyeApplied=recipe:2'), { supported: true, applied: 'item', kind: 'recipe', id: '2' });
    assert.deepEqual(parseDyeReturn('?dyeApplied=favourite:af-7'), { supported: true, applied: 'item', kind: 'favourite', id: 'af-7' });
    assert.deepEqual(parseDyeReturn('?dyeApplied=other'), { supported: true, applied: 'other' });
    assert.deepEqual(parseDyeReturn('?dyeApplied=bogus'), { supported: true, applied: 'other' });
});

test('resolveReturn: only a DYE2 that vouches for its applies may write back', () => {
    const parked = serializeSelection(item);
    const none = { supported: true, applied: 'none' };
    const old = { supported: false };
    // edited in DYE, nothing applied: keep the parked item and fold
    assert.deepEqual(resolveReturn({ parked, ret: none, ...ctx }), { item, fold: true });
    // older DYE2: keep the highlight, never write
    assert.deepEqual(resolveReturn({ parked, ret: old, ...ctx }), { item, fold: false });
    // DYE2 applied another recipe: that one is armed, fresh against the live profile
    const b = resolveReturn({ parked, ret: { supported: true, applied: 'item', kind: 'recipe', id: '1' }, ...ctx });
    assert.equal(b.item.id, '1');
    assert.equal(b.item.profileFingerprint, profileFingerprint(profile));
    assert.equal(b.fold, true);
    // applied something with no stable id, or an item that is gone: nothing armed
    assert.deepEqual(resolveReturn({ parked, ret: { supported: true, applied: 'other' }, ...ctx }), { item: null, fold: false });
    assert.deepEqual(resolveReturn({ parked, ret: { supported: true, applied: 'item', kind: 'recipe', id: '9' }, ...ctx }), { item: null, fold: false });
    // no parked item and nothing applied: nothing to do
    assert.deepEqual(resolveReturn({ parked: null, ret: none, ...ctx }), { item: null, fold: false });
    // a profile switched inside DYE discards the parked item
    const switched = { ...ctx, workflow: { profile: { ...profile, title: 'Other' } } };
    assert.deepEqual(resolveReturn({ parked, ret: none, ...switched }), { item: null, fold: false });
});

test('changedFields: only real differences, numeric strings compare equal', () => {
    assert.deepEqual(changedFields({ dose: 18, drink: 40, grind: 21.5 }, { dose: 18, drink: '40', grind: 20 }), { grind: 21.5 });
    assert.deepEqual(changedFields({ dose: 18 }, undefined), { dose: 18 });
    assert.deepEqual(changedFields({}, { dose: 1 }), {});
});

test('pluginRecordsDialIn: only a loaded DYE2 that declares the selection endpoint', () => {
    const api = [{ type: 'http', id: 'dashboard' }, { type: 'http', id: 'selection' }, { type: 'websocket', id: 'changed' }];
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: true, api }]), true);
    // an older DYE2: no such endpoint, so the skin keeps its own auto-save
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: true, api: [{ type: 'http', id: 'dashboard' }] }]), false);
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: false, api }]), false);
    // a websocket of the same name is not the endpoint we POST to
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: true, api: [{ type: 'websocket', id: 'selection' }] }]), false);
    assert.equal(pluginRecordsDialIn([{ id: 'other.reaplugin', loaded: true, api }]), false);
    // unreachable bridge / junk: fall back to the skin's own auto-save, never throw
    assert.equal(pluginRecordsDialIn(null), false);
    assert.equal(pluginRecordsDialIn([]), false);
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: true }]), false);
});

// DYE2's pages are api endpoints, so one the installed build never declared
// answers Decaid's 404 inside the overlay -- what the barista sees as a
// page-not-found where "Select recipe" should have opened the library.
test('pluginHasEndpoint: a page the installed DYE2 does not declare is absent', () => {
    const api = [{ type: 'http', id: 'recipe-edit' }, { type: 'http', id: 'select-recipe' }];
    assert.equal(pluginHasEndpoint([{ id: 'dye2.reaplugin', loaded: true, api }], 'select-recipe'), true);
    // an older DYE2: recipe-edit (the blank cell's tap) but no library page
    assert.equal(pluginHasEndpoint([{ id: 'dye2.reaplugin', loaded: true, api: [{ type: 'http', id: 'recipe-edit' }] }], 'select-recipe'), false);
    assert.equal(pluginHasEndpoint([{ id: 'dye2.reaplugin', loaded: false, api }], 'select-recipe'), false);
    assert.equal(pluginHasEndpoint([{ id: 'dye2.reaplugin', loaded: true, api: [{ type: 'websocket', id: 'select-recipe' }] }], 'select-recipe'), false);
    assert.equal(pluginHasEndpoint(null, 'select-recipe'), false);
});

test('armedSelectionId: the cached item own id, or null when it is gone', () => {
    const lists = { recipes: [{ id: '2' }], favs: [{ id: 7 }] };
    assert.equal(armedSelectionId({ kind: 'recipe', id: '2' }, lists), '2');
    // ids compare as strings but the cached item's own type is returned, since the
    // highlight is compared strictly against it
    assert.equal(armedSelectionId({ kind: 'favourite', id: '7' }, lists), 7);
    assert.equal(armedSelectionId({ kind: 'recipe', id: '9' }, lists), null);
    assert.equal(armedSelectionId({ kind: 'other', id: '2' }, lists), null);
    assert.equal(armedSelectionId(null, lists), null);
    assert.equal(armedSelectionId({ kind: 'recipe' }, lists), null);
    assert.equal(armedSelectionId({ kind: 'recipe', id: '2' }, { recipes: undefined, favs: [] }), null);
});

test('profileFingerprint: limiter {value:0}, null and absent hash the same; a real limit differs', () => {
    const withLimiter = limiter => ({ ...profile, steps: [{ name: 'fill', temperature: 90, ...(limiter === undefined ? {} : { limiter }) }] });
    const missing = profileFingerprint(withLimiter(undefined));
    assert.equal(profileFingerprint(withLimiter({ value: 0, range: 0.6 })), missing);
    assert.equal(profileFingerprint(withLimiter(null)), missing);
    assert.notEqual(profileFingerprint(withLimiter({ value: 1.5, range: 0.6 })), missing);
});

test('profileFingerprint: key order does not affect identity (dye2#43)', () => {
    const step = { name: 's', pump: 1, transition: 0, exit: null, volume: 1, seconds: 1, weight: 1, sensor: 'coffee', flow: 1, limiter: null };
    const reorderedStep = Object.fromEntries(Object.entries(step).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)));
    const decaidOrder = { title: 'P', tank_temperature: 93, steps: [step] };
    const jsonbOrder = { steps: [reorderedStep], title: 'P', tank_temperature: 93 };
    assert.equal(profileFingerprint(decaidOrder), profileFingerprint(jsonbOrder));
});

test('profileDrifted: an item fingerprinted with a 0 limiter does not drift against a null limiter', () => {
    const zero = { ...profile, steps: [{ name: 'fill', limiter: { value: 0, range: 0.6 } }] };
    const none = { ...profile, steps: [{ name: 'fill', limiter: null }] };
    assert.equal(profileDrifted({ profileFingerprint: profileFingerprint(zero) }, { profile: none }), false);
});

test('armedSelectionId: an empty selection object arms nothing', () => {
    assert.equal(armedSelectionId({}, { recipes: [{ id: '1' }], favs: [{ id: 7 }] }), null);
});

test('selectedRecipeSteam: the selected recipe steam settings, each null when absent', () => {
    const recipes = [
        { id: '2', dashboardVariables: { steamTempC: 140.4, steamTimeS: 25, steamFlowMls: 0.8 } },
        { id: '3', dashboardVariables: { steamTempC: 0, steamTimeS: 0, steamFlowMls: 0 } },
        { id: '4' },
    ];
    assert.deepEqual(selectedRecipeSteam({ kind: 'recipe', id: 2 }, recipes), { tempC: 140, durationS: 25, flow: 0.8 });
    assert.deepEqual(selectedRecipeSteam({ kind: 'recipe', id: '3' }, recipes), { tempC: null, durationS: null, flow: null },
        'below 135 is off, not a temperature; a 0 duration or flow is not a setting');
    const none = { tempC: null, durationS: null, flow: null };
    assert.deepEqual(selectedRecipeSteam({ kind: 'recipe', id: '4' }, recipes), none);
    assert.deepEqual(selectedRecipeSteam({ kind: 'recipe', id: '9' }, recipes), none);
    assert.deepEqual(selectedRecipeSteam({ kind: 'favourite', id: '2' }, recipes), none);
    assert.deepEqual(selectedRecipeSteam(null, recipes), none);
    assert.deepEqual(selectedRecipeSteam({ kind: 'recipe', id: '2' }, null), none);
});

const recipeIds = cells => cells.map(c => c.recipe && String(c.recipe.id));

test('recipeStripCells places each recipe at its id slot whatever the KV order', () => {
    const cells = recipeStripCells([{ id: '3' }, { id: 1 }]);
    assert.deepEqual(cells.map(c => c.slot), ['1', '2', '3', '4', '5']);
    assert.deepEqual(recipeIds(cells), ['1', null, '3', null, null]);
});

test('recipeStripCells leaves a hidden recipe as a blank and moves nothing', () => {
    const recipes = [1, 2, 3, 4, 5].map(id => ({ id: String(id), showOnStreamlineDashboard: id === 2 ? false : undefined }));
    assert.deepEqual(recipeIds(recipeStripCells(recipes)), ['1', null, '3', '4', '5']);
});

test('recipeStripCells gives five blanks for null or garbage input', () => {
    for (const bad of [null, undefined, 'x', {}, [null, 7, 'a']]) {
        assert.deepEqual(recipeIds(recipeStripCells(bad)), [null, null, null, null, null]);
    }
});

test('recipeStripCells puts an out-of-range id into the first blank, and a duplicate id once', () => {
    assert.deepEqual(recipeIds(recipeStripCells([{ id: 'x' }, { id: '1' }, { id: '3' }])), ['1', 'x', '3', null, null]);
    const dup = recipeStripCells([{ id: '2', title: 'first' }, { id: '2', title: 'second' }]);
    assert.equal(dup[1].recipe.title, 'first');
    assert.equal(dup.filter(c => c.recipe).length, 1, 'the duplicate is dropped, not placed twice');
});

test('recipeStripCells does not back-fill a cell a clear emptied', () => {
    // Legacy ids, so strays DO back-fill blanks -- but not the button the user just
    // cleared, which must stay empty instead of being handed to the next recipe.
    const cells = recipeStripCells([
        { id: '1' }, { id: '2' },
        { id: '3', showOnStreamlineDashboard: false },
        { id: '4' }, { id: 'rcp_x' },
    ]);
    assert.deepEqual(recipeIds(cells), ['1', '2', null, '4', 'rcp_x']);
    // Without a clear the same stray still takes slot 3, so the reservation is the only change.
    assert.deepEqual(recipeIds(recipeStripCells([{ id: '1' }, { id: '2' }, { id: '4' }, { id: 'rcp_x' }])),
        ['1', '2', 'rcp_x', '4', null]);
    // A cleared row whose id is not a slot reserves nothing.
    assert.deepEqual(recipeIds(recipeStripCells([{ id: 'gone', showOnStreamlineDashboard: false }, { id: 'rcp_x' }])),
        ['rcp_x', null, null, null, null]);
});

test('recipeStripCells places opaque-id recipes by stripSlot and leaves blanks', () => {
    const cells = recipeStripCells([
        { id: 'rcp_b', stripSlot: 4 }, { id: 'rcp_a', stripSlot: 1 }, { id: 'rcp_c', stripSlot: 4 },
    ]);
    assert.deepEqual(recipeIds(cells), ['rcp_a', null, null, 'rcp_b', null]);
});

test('recipeStripCells keeps a null-stripSlot row off the strip and does not back-fill it', () => {
    const cells = recipeStripCells([{ id: 'x', stripSlot: null }, { id: 'y', stripSlot: 2 }, { id: 'z' , stripSlot: 9 }]);
    assert.deepEqual(recipeIds(cells), [null, 'y', null, null, null]);
});

test('recipeStripCells: hidden stays a blank under stripSlot', () => {
    const cells = recipeStripCells([{ id: 'a', stripSlot: 1, showOnStreamlineDashboard: false }, { id: 'b', stripSlot: 2 }]);
    assert.deepEqual(recipeIds(cells), [null, 'b', null, null, null]);
});

test('recipeStripCells falls back to ids only when no row carries a stripSlot key', () => {
    assert.deepEqual(recipeIds(recipeStripCells([{ id: '2' }, { id: '5' }])), [null, '2', null, null, '5']);
    // one row with the key (even null) means a stripSlot-aware DYE2: ids mean nothing
    assert.deepEqual(recipeIds(recipeStripCells([{ id: '2', stripSlot: null }, { id: '3' }])), [null, null, null, null, null]);
    assert.deepEqual(recipeIds(recipeStripCells([{ id: '2', stripSlot: 4 }, { id: '3' }])), [null, null, null, '2', null]);
});

test('a recipe cell is idle or highlighted, nothing else', () => {
    const cells = recipeStripCells([{ id: 's', stripSlot: 3 }]);
    assert.equal(cells[2].recipe.id, 's');
    assert.deepEqual(recipeCellState(cells[2].recipe, null, false), { active: false, marker: '' });
    assert.deepEqual(recipeCellState(cells[2].recipe, 's', false), { active: true, marker: '' });
});

test('modified puts a * on the highlighted recipe cell only', () => {
    const recipes = [{ id: 'a', stripSlot: 1 }, { id: 'b', stripSlot: 2 }];
    const sel = { kind: 'recipe', id: 'a', modified: true };
    const modified = selectionModified(sel, { recipes });
    assert.equal(modified, true);
    assert.equal(recipeCellState(recipes[0], 'a', modified).marker, '*');
    assert.equal(recipeCellState(recipes[0], 'a', modified).active, true);
    assert.equal(recipeCellState(recipes[1], 'a', modified).marker, '');
    assert.equal(recipeCellState(recipes[0], 'a', false).marker, '');
});

test('selectionModified ignores favourites, unflagged, unknown and null selections', () => {
    const recipes = [{ id: 'a' }];
    assert.equal(selectionModified({ kind: 'recipe', id: 'a', modified: false }, { recipes }), false);
    assert.equal(selectionModified({ kind: 'favourite', id: 'a', modified: true }, { recipes }), false);
    assert.equal(selectionModified({ kind: 'recipe', id: 'gone', modified: true }, { recipes }), false);
    assert.equal(selectionModified(null, { recipes }), false);
});

test('a derived recent (kind favourite, auto: true) highlights its favourites-strip cell like a saved favourite', () => {
    const favs = [{ id: 'f1', favSlot: 0 }, { id: 'r1', auto: true, favSlot: 1 }];
    assert.equal(armedSelectionId({ kind: 'favourite', id: 'r1', auto: true, modified: false }, { recipes: [], favs }), 'r1');
    assert.equal(favStripCells(favs).find(c => c.fav.id === 'r1').fav.id, 'r1');
});

test('favStripCells places by favSlot: a hidden row is a blank cell and nothing shifts', () => {
    const favs = [1, 2, 3, 4, 5].map(n => ({ id: 'f' + n, favSlot: n, alwaysOnDashboard: n === 2 ? false : undefined }));
    const cells = favStripCells(favs);
    assert.equal(cells.length, 4);
    assert.deepEqual(cells.map(c => c.fav && c.fav.id), ['f1', null, 'f3', 'f4']);
    assert.equal(cells[1].hidden.id, 'f2');
});

test('favStripCells leaves an empty slot blank and drops rows with no or out-of-range slots', () => {
    const cells = favStripCells([{ id: 'b', favSlot: 2 }, { id: 'd', favSlot: 4 }, { id: 'none', favSlot: null }, { id: 'five', favSlot: 5 }, { id: 'zero', favSlot: 0 }]);
    assert.deepEqual(cells.map(c => c.fav && c.fav.id), [null, 'b', null, 'd']);
    assert.ok(cells.every(c => c.hidden === null));
});

test('favStripCells: two rows on slot 1, one hidden -- the visible one lands in cell 1 and nothing shifts', () => {
    const favs = [
        { id: 'ssssss', favSlot: 1, alwaysOnDashboard: false, capturedAt: '1' },
        { id: 'jailbreak', favSlot: 1, alwaysOnDashboard: true, capturedAt: '2' },
        { id: 'red', favSlot: 2, alwaysOnDashboard: true },
        { id: 'lr', favSlot: 3, alwaysOnDashboard: true },
        { id: 'old', favSlot: 4, alwaysOnDashboard: true },
    ];
    assert.deepEqual(favStripCells(favs).map(c => c.fav && c.fav.id), ['jailbreak', 'red', 'lr', 'old']);
    assert.deepEqual(favStripCells(favs.slice().reverse()).map(c => c.fav && c.fav.id), ['jailbreak', 'red', 'lr', 'old'], 'order of the rows does not matter');
});

test('favStripCells compat: with no usable favSlot anywhere it sorts and takes the first max', () => {
    const cells = favStripCells([{ id: 'c', capturedAt: '3' }, { id: 'b', capturedAt: '2', alwaysOnDashboard: false }, { id: 'a', capturedAt: '1', favSlot: null }, { id: 'd', capturedAt: '4' }, { id: 'e', capturedAt: '5' }]);
    assert.deepEqual(cells.map(c => c.fav && c.fav.id), ['a', null, 'c', 'd']);
    assert.equal(favStripCells([{ id: 'a' }, { id: 'b' }]).length, 2);
    assert.deepEqual(favStripCells([]), []);
    assert.deepEqual(favStripCells(null), []);
});

test('favStripCells honours max', () => {
    assert.deepEqual(favStripCells([{ id: 'a', favSlot: 1 }, { id: 'c', favSlot: 3 }], 2).map(c => c.fav && c.fav.id), ['a', null]);
});


// --- the recipe being dialled in (dye2#36) --------------------------------
// It rides in the workflow itself; DYE2 derives its selection from it, so
// there is no POST and a write that forgets to null it leaves a stale recipe
// highlighted and records the next shot's dial-in onto the wrong one.

test('claiming a recipe tags the patch the way the plugin expects', () => {
    assert.deepEqual(recipeIdPatch('r1'), { extras: { dye: { v: 1, recipeId: 'r1' } } });
    // The plugin stores the id as a string; a numeric id must not arrive as one.
    assert.deepEqual(recipeIdPatch(7), { extras: { dye: { v: 1, recipeId: '7' } } });
    assert.equal(typeof recipeIdPatch(7).extras.dye.recipeId, 'string');
});

test('releasing is an explicit null, never an omission', () => {
    // Omitting the key would leave the previous recipe claimed, because
    // PUT /workflow deep-merges: absent means "unchanged", not "cleared".
    for (const id of [null, undefined]) {
        assert.deepEqual(recipeIdPatch(id), { extras: { dye: { v: 1, recipeId: null } } });
        assert.ok('recipeId' in recipeIdPatch(id).extras.dye);
    }
});

test('the patch carries nothing but the claim', () => {
    // Only the delta: the other extras keys (rpm, note) survive the deep merge
    // on their own and must not be re-sent by a writer that does not own them.
    const patch = recipeIdPatch('r1');
    assert.deepEqual(Object.keys(patch), ['extras']);
    assert.deepEqual(Object.keys(patch.extras), ['dye']);
    assert.deepEqual(Object.keys(patch.extras.dye).sort(), ['recipeId', 'v']);
});


// --- what a workflow patch may carry as its profile ------------------------
// PUT /workflow deep-merges, so a profile without steps does not replace the
// loaded one, it renames it: the machine keeps the previous curve and the shot
// record is saved under the DYE item's name with the other profile's steps,
// notes and author. Every stub shape DYE2 actually stores is checked here.

test('a profile patch is only ever one that carries steps', () => {
    assert.equal(profilePatchWithSteps(profile), profile);
    // The shapes seen in live DYE2 KV rows.
    assert.equal(profilePatchWithSteps({ id: 'profile:abc', title: 'Cremina&Gusto' }), null);
    assert.equal(profilePatchWithSteps({ id: 'profile:abc', title: 'Cremina&Gusto', steps: [] }), null);
    assert.equal(profilePatchWithSteps({}), null);
    assert.equal(profilePatchWithSteps(null), null);
    assert.equal(profilePatchWithSteps(undefined), null);
    // Not a list of steps at all.
    assert.equal(profilePatchWithSteps({ title: 'x', steps: 'fill' }), null);
});

test('dyeStrip never patches the workflow with a stepless profile', () => {
    // The three apply paths run against window/fetch, so the wiring is asserted
    // on the source: a `patch.profile =` that is not gated by the helper is the
    // regression this guards (a stub fallback renaming the loaded profile).
    const strip = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const assignments = strip.match(/patch\.profile = .*/g) || [];
    assert.equal(assignments.length, 3, 'one per apply path: stored workflow, legacy favourite, legacy recipe');
    for (const line of assignments) {
        assert.match(line, /patch\.profile = full;$/,
            `a profile patch must come from profilePatchWithSteps, not a stub: ${line}`);
    }
});

test('the recipe-library menu items are offered only when DYE2 serves that page', () => {
    const strip = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const lines = strip.split('\n').filter(l => l.includes("openPluginOverlay('select-recipe'"));
    assert.equal(lines.length, 2, 'the empty cell\'s "Select recipe" and a filled cell\'s "Replace ..."');
    for (const line of lines) {
        assert.match(line, /dye2HasSelectRecipe/,
            `ungated: an older DYE2 answers 404 in the overlay instead: ${line.trim()}`);
    }
});

// --- the way home from DYE2 outlives a re-serve ----------------------------
//
// Decaid serves the skin on an ephemeral port and re-picks it whenever it serves the
// folder again, so the `?return=` captured when DYE opens can name a dead port by the
// time DYE2 sends the user back -- a browser error page instead of Streamline. Seen
// live: a return to :25261 after the skin had moved to :26950.

test('a Decaid-served skin returns through the stable entry port', () => {
    assert.equal(
        stableSkinReturnUrl('http://localhost:25261/?page=index', { decaidServed: true }),
        `http://localhost:${DECAID_SKIN_ENTRY_PORT}/?page=index`);
    // The path and the whole query ride along: the entry server redirects with them.
    assert.equal(
        stableSkinReturnUrl('http://10.0.0.5:26950/sub/?page=index&foo=1', { decaidServed: true }),
        `http://10.0.0.5:${DECAID_SKIN_ENTRY_PORT}/sub/?page=index&foo=1`);
});

test('anything not served by Decaid keeps its own address', () => {
    // A dev server or a static host has no entry port to send anyone to, and rewriting
    // would send the user to a different copy of the skin entirely.
    const dev = 'http://localhost:8044/?page=index';
    assert.equal(stableSkinReturnUrl(dev, { decaidServed: false }), dev);
    assert.equal(stableSkinReturnUrl(dev), dev, 'absent options means not Decaid-served');
});

test('the entry port itself, odd schemes and junk are left alone', () => {
    const entry = `http://localhost:${DECAID_SKIN_ENTRY_PORT}/?page=index`;
    assert.equal(stableSkinReturnUrl(entry, { decaidServed: true }), entry, 'already stable');
    const file = 'file:///Users/x/index.html';
    assert.equal(stableSkinReturnUrl(file, { decaidServed: true }), file, 'no port to swap');
    assert.equal(stableSkinReturnUrl('not a url', { decaidServed: true }), 'not a url');
    assert.equal(stableSkinReturnUrl('', { decaidServed: true }), '');
});

test('the DYE navigation sends the stable URL, and detects Decaid by its injected script', () => {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const nav = source.match(/window\.location\.href = `\$\{pluginUrl\}\?\$\{query\((.*?)\)\}`/);
    assert.ok(nav, 'the cross-origin fallback should still navigate to the plugin');
    assert.match(nav[1], /stableSkinReturnUrl\(window\.location\.href/,
        'it must not hand DYE2 a raw location.href');
    // webui_service.dart injects this script into every HTML response it serves.
    assert.match(source, /__decent\/skin-api\.js/);
});

// --- a deleted grinder does not survive in a recipe's stored body ----------
//
// The body is written once, at save time, and nothing rewrites it when the
// grinder is deleted afterwards. DYE2's own apply resolves the id against the
// live list (dashboard.ts applyRecipe); the strip applies the body directly.

test('a recipe naming a grinder the catalogue no longer holds applies none', () => {
    const ctx = { grinderId: 'gone', grinderModel: 'Niche Zero', targetDoseWeight: 18 };
    const out = dropDeletedGrinder(ctx, [{ id: 'g-1' }, { id: 'g-2' }]);
    assert.equal(out.grinderId, null);
    assert.equal(out.grinderModel, null, 'the stale model goes with the dead id');
    assert.equal(out.targetDoseWeight, 18, 'nothing else is touched');
    assert.deepEqual(ctx, { grinderId: 'gone', grinderModel: 'Niche Zero', targetDoseWeight: 18 },
        'pure: the input context is not mutated');
});

test('a grinder that still exists is kept, envelope or bare array', () => {
    const ctx = { grinderId: 'g-2', grinderModel: 'Comandante C40' };
    assert.equal(dropDeletedGrinder(ctx, [{ id: 'g-1' }, { id: 'g-2' }]), ctx);
    assert.equal(dropDeletedGrinder(ctx, { items: [{ id: 'g-2' }] }), ctx, 'GET /grinders envelope');
});

test('an unreadable catalogue keeps what the recipe names', () => {
    // A fetch that failed must not read as a deletion: grinderCatalogue returns null
    // for that case, and null means "could not check".
    const ctx = { grinderId: 'g-2', grinderModel: 'Comandante C40' };
    assert.equal(dropDeletedGrinder(ctx, null), ctx);
    assert.equal(dropDeletedGrinder(ctx, undefined), ctx);
    assert.equal(dropDeletedGrinder(ctx, {}), ctx, 'a body with no items is not an empty catalogue');
    // An empty ARRAY is a real answer: every grinder really is gone.
    assert.equal(dropDeletedGrinder(ctx, []).grinderId, null);
});

test('a recipe naming no grinder is returned untouched', () => {
    const cleared = { grinderId: null, grinderModel: null };
    assert.equal(dropDeletedGrinder(cleared, []), cleared, 'no fetch result can change it');
    assert.equal(dropDeletedGrinder(undefined, []), undefined);
});

test('the apply path asks the catalogue for archived grinders too', () => {
    // An archived grinder still exists and a recipe naming one still means it;
    // getGrinders() without the flag would hide it and the apply would null it.
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    assert.match(source, /getGrinders\(true\)/);
    assert.match(source, /dropDeletedGrinder\(patch\.context, await grinderCatalogue\(\)\)/);
});
