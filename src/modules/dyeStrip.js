// dyeStrip.js — Phase B of the DYE2 → Streamline dashboard bridge.
//
// Streamline's header carries a vertical P / F / R toggle (top-left):
//   P = Profile favourites  (the existing profile <nav>, untouched — DEFAULT)
//   F = DYE2 auto-favourites (bean + recipe snapshots)
//   R = DYE2 recipes
// F and R are driven by data DYE2 writes to the generic KV store; Streamline is
// a read-only consumer of it (see dye2-plugin/KV_CONTRACT.md) whenever the installed
// DYE2 records dial-in edits itself (pluginRecordsDialIn): then the strip only POSTs
// what it applied to DYE2's `selection` endpoint. Against an older DYE2 the recipe
// auto-save below is the fallback, and patches single fields back itself.
// When the DYE2 keys are empty/missing the header behaves exactly as today:
// default P, F/R render empty.
//
// Apply semantics mirror dye2-plugin/src/pages/dashboard.ts (applyAutoFavourite /
// applyRecipe): PUT the item's ready-made `workflow` ({context, profile?}); for
// recipes ALSO live-merge steam / hot-water / flush onto the fetched workflow
// (those need targetTemperature/flow a recipe doesn't capture, so they can't live
// in the stored `workflow`). Legacy items without `workflow` fall back to
// snapshot+copyMask / dashboardVariables.

import { API_BASE_URL, getWorkflow, updateWorkflow, getDye2KvArray, setDye2KvArray, getKVValue, DYE2_KV_NAMESPACE, onWorkflowUpdated, getPlugins, installPluginFromRelease, enablePlugin, checkPluginUpdates, approvePluginUpdate, persistSharedValue, FLUSH_DURATION_LAST_VALUE_KEY, HOT_WATER_VOLUME_LAST_VALUE_KEY, HOT_WATER_TEMP_LAST_VALUE_KEY, STEAM_DURATION_LAST_VALUE_KEY, STEAM_FLOW_LAST_VALUE_KEY, getProfiles } from './api.js';
import { applyWorkflowToMainPageUI } from './profileManager.js';
import { logger } from './logger.js';
import { fitTextToBox, getTranslation } from './i18n.js';
import { stripRightInset } from './header-strip-inset.js';
import { openContextMenu } from './context-menu.js';
import { setupPressAndHold, setSteamTileModeIfSafe, setHotWaterTileMode, showToast } from './ui.js';
import { settingsReady, SETTINGS_RESTORED_EVENT } from './settingsSync.js';
import { recipeIdPatch, SELECTION_KEY, RETURN_PARAM, profileFingerprint, profileDrifted, profilePatchWithSteps, serializeSelection, resolveReturn, parseDyeReturn, changedFields, pluginRecordsDialIn, pluginHasEndpoint, keepPreviousOnFailure, resolveRecordsDialIn, armedSelectionId, selectionModified, recipeCellState, recipeStripCells, favStripCells } from './dye-selection.js';

const AF_KEY = 'autoFavourites';
const RECIPES_KEY = 'recipes';
const MODE_KEY = 'streamline.dyeStripMode';
// Master on/off for the whole DYE2 header UI (set in Extensions settings).
// DEFAULT OFF: when this is not 'true' the header is byte-identical to stock
// Streamline (profile favourites only, no toggle / DYE button / strip).
const ENABLED_KEY = 'streamline.dye2Enabled';
const PLUGIN_BASE = `${API_BASE_URL}/plugins/dye2.reaplugin`; // …/api/v1/plugins/dye2.reaplugin
const MAX_FAV_CELLS = 4; // + a trailing "VIEW ALL AUTO FAV" cell

// Plugin install / update state (see getDye2VersionInfo below).
const PLUGIN_ID = 'dye2.reaplugin';
export const PLUGIN_REPO = 'decentespresso/dye2';
export const PLUGIN_RELEASES_PAGE = 'https://github.com/decentespresso/dye2/releases/latest';

// Cell classes mirror the existing profile favourite buttons (index.html) so the
// F/R strip is visually identical to the P strip.
const CELL_BASE =
    'flex justify-center items-center text-center text-balance px-3 leading-tight ' +
    'overflow-hidden [overflow-wrap:anywhere] w-[225px] h-[90px] text-[21px] rounded-[15px] ' +
    'border-2 font-semibold cursor-pointer';
const CELL_IDLE = ' border-[var(--profile-button-outline-color)] bg-[var(--profile-button-background-color)] text-[var(--profile-button-text-color)]';
const CELL_ACTIVE = ' border-[var(--mimoja-blue-v2)] bg-[var(--mimoja-blue-v2)] text-[var(--button-primary-text)]';
const CELL_ACCENT = ' border-[var(--mimoja-blue-v2)] bg-[var(--box-color)] text-[var(--mimoja-blue-v2)]'; // VIEW ALL
// Empty-state hint. Carries the cell height explicitly: in R mode it is the only
// child, so without it the strip collapses to one line of text and the hint sits
// at the top of the band instead of centred against where the cells would be.
const HINT_CLASS =
    'flex items-center h-[90px] text-[20px] text-[var(--low-contrast-white)] px-2';

let favCache = [];
let recipeCache = [];
let currentMode = 'P';
let activeItemId = null; // transient highlight of the last-applied F/R cell
let activeModified = false; // DYE2 says the highlighted recipe has drifted: its cell shows `*`
// Does the installed DYE2 record dial-in edits itself? Re-read with the strip data
// (a plugin update lands without a skin reload). False keeps the legacy auto-save.
let dye2RecordsDialIn = false;
// Does the installed DYE2 serve its recipe-library page? The "Select recipe" /
// "Replace ..." menu items open it, and a DYE2 that never declared the endpoint
// answers Decaid's 404 inside the overlay instead. Optimistic until a readable
// plugin list says otherwise, so an unreachable bridge hides nothing.
let dye2HasSelectRecipe = true;
// DYE2 confirmed (200) the item the last apply armed, so it is the one recording and
// the skin writes nothing. The capability flag above is only a hint read from the
// plugin list; this is what decides who records, per apply.
let dye2Armed = false;
let applySeq = 0; // taps in quick succession: only the newest apply arms
// What the header is currently showing, not what the flag says: null until the first
// decision. disableDye2Ui() is not inert (it bumps applySeq, clears the armed item and
// releases DYE2's selection), so it must only run when the header really is changing.
let dye2UiOn = null;
let restoreListenerRegistered = false;

// ─── Data ────────────────────────────────────────────────────────────────────

export async function loadDyeStripData() {
    const [favs, recipes, plugins] = await Promise.all([
        getDye2KvArray(AF_KEY),
        getDye2KvArray(RECIPES_KEY),
        getPlugins().catch(() => null),
    ]);
    // A failed read (null) keeps the previous cache: a transient error must not
    // empty the strip or flip the recording mode mid-session.
    favCache = keepPreviousOnFailure(favCache, favs);
    recipeCache = keepPreviousOnFailure(recipeCache, recipes);
    // First load with an unreachable bridge reads as "does not record" (the
    // initial false), so the fallback auto-save stays on: writing the same values
    // twice is recoverable, writing them nowhere is not.
    dye2RecordsDialIn = resolveRecordsDialIn(dye2RecordsDialIn, plugins, p => pluginRecordsDialIn(p, PLUGIN_ID));
    if (plugins != null) dye2HasSelectRecipe = pluginHasEndpoint(plugins, 'select-recipe', PLUGIN_ID);
    logger.info(`dyeStrip: loaded ${favCache.length} favs, ${recipeCache.length} recipes${dye2RecordsDialIn ? ' (DYE2 records dial-in)' : ''}`);
}

function favLabel(fav) {
    const snp = fav.snapshot || {};
    // User-typed title wins: DYE2 always fills subtitle (roaster / coffee name), so a
    // subtitle-first order would never show the name the user actually entered.
    return fav.title || fav.subtitle || snp.coffeeName || 'Favourite';
}

function recipeLabel(recipe) {
    return recipe.title || recipe.name || 'Recipe';
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

function makeCell(label, extraClass, onClick, onLongPress) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = CELL_BASE + extraClass;
    btn.textContent = label;
    if (onLongPress) {
        btn.title = 'Long-press for options';
        setupPressAndHold(btn, onClick || (() => {}), () => onLongPress(btn));
    } else if (onClick) {
        btn.addEventListener('click', onClick);
    }
    return btn;
}

// Long-press menu on an R / F cell: jump into DYE2's editor, save the dial-in made since the
// item was applied onto it, or free the button.
//
// Saving is explicit. DYE2 used to write every workflow change onto whatever was selected,
// which meant the machine's state quietly became the recipe -- steam switched off, a one-off
// dose, a stale value from another app. Applying an item now only selects it; the barista
// decides when it becomes the recipe. Offered on the selected cell only: DYE2 records onto its
// own selection, so on any other cell it would write to the wrong item.
function openCellMenu(btn, edit, kind, item, slot) {
    // Only against a DYE2 that records dial-in, and only when no legacy auto-save item is
    // armed (a non-null activeItem means the skin is recording and DYE2's selection may differ).
    const selected = item.id != null && item.id === activeItemId && dye2RecordsDialIn && !activeItem;
    openContextMenu(btn, [
        { label: getTranslation('Edit in DYE2'), onSelect: edit },
        ...(selected ? [{ label: getTranslation('Save changes'), onSelect: () => saveChanges(kind, item) }] : []),
        // Opens DYE2's recipe library targeted at THIS cell's slot: the barista picks a card and
        // it is assigned to the button they long-pressed, replacing the recipe named in the label
        // (which drops to the library, not deleted). R strip only: the F strip holds no slots.
        ...(kind === 'recipe' && dye2HasSelectRecipe ? [{ label: `${getTranslation('Replace')} ${recipeLabel(item)}`, onSelect: () => openPluginOverlay('select-recipe', { slot }) }] : []),
        // A favourite and a recent have no save target of their own, so keeping a dial-in from one
        // means making a recipe of it (#159 acceptance 4). Saved to the library with no slot: it
        // shows up as a card in DYE2's recipe list, and the barista gives it a button from there.
        // F strip only -- a recipe cell already has "Save changes" for its own dial-in.
        ...(kind === 'favourite' ? [{ label: getTranslation('Save to recipes'), onSelect: () => saveToRecipes(null, item.beverage) }] : []),
        { divider: true },
        { label: getTranslation('Clear button'), danger: true, onSelect: () => clearCell(kind, item) },
    ]);
}

// The strip's one source for "which item is selected, and has it drifted". DYE2's /selection
// route derives that from the live workflow and the item's stored values on every call, so it
// is correct the moment a record lands. The KV key `selection` is only a mirror, written when
// the workflow changes: a record that rewrites the recipe without touching the workflow leaves
// the mirror saying modified:true. So the route is read first and the mirror is a fallback
// for a DYE2 without the route (`mirror:false` for callers that cannot afford a stale answer).
// undefined = could not tell; null/{} = nothing selected.
async function readSelection({ mirror = true } = {}) {
    try {
        const res = await fetch(`${PLUGIN_BASE}/selection`);
        if (res.ok) return await res.json();
    } catch (e) { /* fall through to the mirror */ }
    if (!mirror) return undefined;
    return getKVValue(DYE2_KV_NAMESPACE, 'selection').catch(() => undefined);
}

// Refresh activeItemId and activeModified TOGETHER from DYE2, so the highlight and the `*`
// can never describe two different selections. A no-op while the skin's own legacy auto-save
// is armed (DYE2 is not recording then; the `*` means nothing, so it is cleared). Never over a
// tap or apply that landed during the GET. Returns true when the state was refreshed.
async function syncSelection(opts) {
    if (!dye2RecordsDialIn) return false;
    if (activeItem) { activeModified = false; return false; }
    const before = activeItemId;
    const seq = applySeq;
    const sel = await readSelection(opts);
    if (sel === undefined || activeItemId !== before || applySeq !== seq) return false;
    activeItemId = armedSelectionId(sel, { recipes: recipeCache, favs: favCache });
    activeModified = selectionModified(sel, { recipes: recipeCache });
    return true;
}

// Ask DYE2 to patch the selected item with the dial-in now on the machine. DYE2 owns the diff
// (it knows what the item held when it was applied), so this just asks; it answers saved:false
// when nothing actually moved.
async function saveChanges(kind, item, retried = false) {
    const label = kind === 'recipe' ? recipeLabel(item) : favLabel(item);
    try {
        const res = await fetch(`${PLUGIN_BASE}/record`, { method: 'POST' });
        if (res.status === 404) { // an older DYE2 (< v0.1.23) has no such endpoint
            if (!retried && await updateDye2Now()) return saveChanges(kind, item, true);
            showToast('Update DYE2 to save changes', 2400, 'info');
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json().catch(() => null);
        if (body && body.saved) {
            // DYE2 wrote the dial-in onto the item, so it now matches the live workflow: the
            // `*` is stale. Cleared locally rather than re-read from DYE2's selection route
            // (no extra round trip, and that route may not have caught up yet). Only on
            // saved:true -- saved:false means nothing moved and the drift is still real.
            activeModified = false;
            // The caches still hold the pre-save values; reapplying a cell would use them.
            await loadDyeStripData().catch(e => logger.warn('dyeStrip: reload after save failed', e));
            // Then take DYE2's own answer, from the derived route only: the KV mirror may not
            // have caught up and would bring the `*` straight back. If the route is
            // unreachable the local clear above stands.
            await syncSelection({ mirror: false }).catch(() => {});
            if (currentMode !== 'P') renderStrip(currentMode);
            showToast(`${label} updated`, 2000, 'info');
        } else {
            // saved:false can mean "already saved" (an earlier save, or DYE2 itself, wrote the
            // dial-in), so a lingering `*` is not proof of drift: take DYE2's derived answer.
            await syncSelection({ mirror: false }).catch(() => {});
            if (currentMode !== 'P') renderStrip(currentMode);
            showToast('No changes to save', 2000, 'info');
        }
    } catch (e) {
        logger.error('dyeStrip: save changes failed', e);
        showToast(`Could not save to ${label}`, 2400, 'error');
    }
}

// Save what is on the machine now as a recipe in the pressed cell's slot (POST save-recipe
// {slot}); DYE2 picks the name and demotes the slot's previous holder to the library. The 409
// (all slots taken) cannot happen with a slot given but the route can still answer it.
async function saveToRecipes(slot, beverage = '', retried = false) {
    try {
        const res = await fetch(`${PLUGIN_BASE}/save-recipe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // No slot for a favourite's "Save to recipes": the recipe goes to DYE2's library, where
            // the barista picks a button for it. explicitRecipeSlot() reads a missing slot as that.
            // The beverage is the item's own typed field, not a workflow one, so DYE2 cannot read
            // it back from the live workflow -- it is sent, and is the only drink word in the name.
            body: JSON.stringify({
                ...(slot == null ? {} : { slot: Number(slot) }),
                ...(beverage ? { beverage } : {}),
            }),
        });
        if (res.status === 404) { // an older DYE2 has no such endpoint
            if (!retried && await updateDye2Now()) return saveToRecipes(slot, beverage, true);
            showToast('Update DYE2 to save recipes', 2400, 'info');
            return;
        }
        if (res.status === 409) {
            showToast('All recipe slots are full. Clear a recipe first', 3000, 'info');
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json().catch(() => null);
        await loadDyeStripData().catch(e => logger.warn('dyeStrip: reload after save failed', e));
        // save-recipe arms the new recipeId in the workflow, so the new cell is the selected one.
        // From the derived route only -- the KV mirror may still name the item saved from.
        await syncSelection({ mirror: false }).catch(() => {});
        if (currentMode !== 'P') renderStrip(currentMode);
        showToast(body && body.name ? `Saved as ${body.name}` : 'Saved as a recipe', 2000, 'info');
    } catch (e) {
        logger.error('dyeStrip: save to recipes failed', e);
        showToast('Could not save recipe', 2400, 'error');
    }
}

// Take the item off its strip button, the way the profile strip's own "Clear button" frees a
// favourite slot. DYE2 owns the flag -- showOnStreamlineDashboard for a recipe,
// alwaysOnDashboard for a favourite -- and both default to shown when absent, so clearing
// means writing false rather than deleting anything. The item itself is untouched: it stays in
// DYE2 and can be put back from its editor.
async function clearCell(kind, item) {
    const label = kind === 'recipe' ? recipeLabel(item) : favLabel(item);
    const field = kind === 'recipe' ? 'showOnStreamlineDashboard' : 'alwaysOnDashboard';
    try {
        if (!(await saveItemTopLevel(kind, item.id, { [field]: false }))) {
            showToast(`${label} is no longer in DYE2`, 2000, 'info');
            return;
        }
    } catch (e) {
        logger.error('dyeStrip: clear button failed', e);
        showToast(`Could not clear ${label}`, 2400, 'error');
        return;
    }
    // An item that is no longer on the strip must not stay armed for dial-in recording.
    // clearSelection re-renders for us; otherwise do it here.
    if (item.id != null && item.id === activeItemId) clearSelection();
    else if (currentMode !== 'P') renderStrip(currentMode);
    showToast(`${label} cleared`, 2000, 'info');
}

function clearSelection() {
    applySeq++; // stop an arm still retrying in the background
    activeItemId = null;
    activeModified = false;
    clearActiveItem();
    forgetParkedSelection();
    if (dye2Armed || dye2RecordsDialIn) postSelection('', null).catch(() => {});
    dye2Armed = false;
    if (currentMode !== 'P') renderStrip(currentMode);
}

export function renderStrip(mode) {
    const strip = document.getElementById('dye-strip');
    if (!strip) return;
    strip.innerHTML = '';

    if (mode === 'F') {
        // Fixed positions, like the profile strip: a cleared favourite leaves a blank cell
        // in place instead of shifting the rest left. A tap on the blank opens the DYE2 list.
        favStripCells(favCache, MAX_FAV_CELLS).forEach(({ fav }) => {
            if (!fav) {
                strip.appendChild(makeCell('', CELL_IDLE, () => openPluginOverlay('auto-favs')));
                return;
            }
            const active = fav.id != null && fav.id === activeItemId;
            const cell = makeCell(favLabel(fav), active ? CELL_ACTIVE : CELL_IDLE, () => {
                // Highlighted means the live workflow already IS this favourite (the highlight is
                // derived from it), so re-applying it would write the same values back and could
                // undo an edit made since. The tap is inert instead (#159 acceptance 1).
                if (active) return;
                activeItemId = fav.id;
                activeModified = false;
                renderStrip('F');
                applyFavourite(fav).catch(e => logger.error('applyFavourite failed', e));
            }, btn => openCellMenu(btn, () => editFavourite(fav), 'favourite', fav));
            strip.appendChild(cell);
        });
        // Trailing "VIEW ALL AUTO FAV" cell (always present, opens the DYE2 page).
        strip.appendChild(makeCell('VIEW ALL AUTO FAV', CELL_ACCENT, () => openPluginOverlay('auto-favs')));
        if (!favCache.some(Boolean)) {
            // Nothing captured yet — a soft hint before the VIEW ALL cell.
            const hint = document.createElement('span');
            hint.className = HINT_CLASS;
            hint.textContent = 'No auto-favourites yet';
            strip.insertBefore(hint, strip.firstChild);
        }
    } else if (mode === 'R') {
        // A recipe sits at its stripSlot, a cleared or unassigned one leaves a blank in
        // place, and a tap on a blank opens DYE2's recipe editor.
        recipeStripCells(recipeCache).forEach(({ slot, recipe }) => {
            if (!recipe) {
                // Two ways to fill an empty button: pick an existing recipe from DYE2's library
                // (the same assign flow a filled cell's "Replace" uses, which needs no recipe to
                // already be there), or capture what is on the machine now as a new one. A tap
                // still opens a blank recipe form on this slot.
                strip.appendChild(makeCell('', CELL_IDLE, () => editRecipe({ id: slot, blank: true }),
                    btn => openContextMenu(btn, [
                        ...(dye2HasSelectRecipe ? [{ label: getTranslation('Select recipe'), onSelect: () => openPluginOverlay('select-recipe', { slot }) }] : []),
                        { label: `${getTranslation('Save to recipe')} ${slot}`, onSelect: () => saveToRecipes(slot) },
                    ])));
                return;
            }
            const { active, marker } = recipeCellState(recipe, activeItemId, activeModified);
            const cls = active ? CELL_ACTIVE : CELL_IDLE;
            const cell = makeCell(recipeLabel(recipe) + marker, cls, () => {
                // Inert on the highlighted cell, `*` included: a drifted recipe is still the one
                // being dialled in, so a tap must not revert the machine to the stored values --
                // "Save changes" or DYE2 decides what happens to the drift (#159 acceptance 1).
                if (active) return;
                activeItemId = recipe.id;
                activeModified = false;
                renderStrip('R');
                applyRecipe(recipe).catch(e => logger.error('applyRecipe failed', e));
            }, btn => openCellMenu(btn, () => editRecipe(recipe), 'recipe', recipe, slot));
            strip.appendChild(cell);
        });
    }
    // Fit only once attached: wrapping depends on the real box width, which an
    // unattached node does not have.
    fitStripCells(strip);
}

// Shrink any label that wraps past its cell. Cells are a fixed 90px tall and the
// box only clips, so without this a long bean name loses its last line under the
// bottom border.
function fitStripCells(nav) {
    if (nav) nav.querySelectorAll('button').forEach(el => fitTextToBox(el));
}

// ─── Apply ─────────────────────────────────────────────────────────────────────

// Tell DYE2 which item was just applied, so it records later dial-in edits onto it
// (it holds events.workflow and sees every workflow change; the skin does not need to
// know what the user touched). Posted right AFTER the apply's PUT, the order DYE2's own
// dashboard.ts uses: DYE2 reads the live workflow to fingerprint the profile and to
// recognise this apply as its own echo. Arming also cancels whatever record DYE2 had
// pending for the item armed before. An id with no stable identity (a `recent:` entry)
// posts an empty body, which clears the selection.
async function postSelection(kind, id) {
    const body = (id != null && String(id).indexOf('recent:') !== 0) ? { kind, id: String(id) } : {};
    // One retry: until DYE2 answers, whatever it had armed before still has a record
    // pending that only a successful arm cancels.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetch(`${PLUGIN_BASE}/selection`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) return true;
            if (res.status === 404) return false; // an older DYE2 has no such endpoint
        } catch (e) { logger.warn('dyeStrip: selection post failed', e); }
    }
    return false;
}

// Arm through postSelection, but never hand a DYE2 that records dial-in itself to the
// legacy auto-save: it would keep the item armed before and record this apply into
// it while the skin saved later changes into the new one (#148). Treat the arm as
// pending, retry in the background until it lands or a newer apply supersedes it, and
// release DYE2's selection if it never does.
async function armSelection(kind, id, seq) {
    if (await postSelection(kind, id)) return true;
    if (!dye2RecordsDialIn) return false;
    (async () => {
        for (const wait of [2000, 5000, 10000, 20000, 30000]) {
            await new Promise(r => setTimeout(r, wait));
            if (seq !== applySeq || !isDye2Enabled()) return;
            if (await postSelection(kind, id)) return;
        }
        if (seq === applySeq && isDye2Enabled()) await postSelection('', null);
    })().catch(e => logger.warn('dyeStrip: selection retry failed', e));
    return true;
}

// Fetch the live workflow, merge the item onto it, PUT, then refresh the left
// controls — the same GET→mutate→PUT shape DYE2's dashboard.ts uses so no other
// workflow field is clobbered.
export async function applyFavourite(fav) {
    if (!fav) return;
    const live = (await getWorkflow()) || {};
    const patch = fav.workflow
        ? await applyStoredWorkflow(fav.workflow)
        : await applyFavLegacy(fav); // snapshot + copyMask
    // A favourite is not a recipe: release whatever recipe was being dialled in,
    // or the next shot records onto it (dye2#36).
    mergeContext(patch, recipeIdPatch(null));
    const seq = ++applySeq;
    await withAutoSaveSuppressed(() => updateWorkflow(patch, 'dye.applyFavourite'));
    if (seq !== applySeq) return; // a newer tap owns the arming
    // Arm the item the dial-in belongs to, after the PUT lands so a failed apply never
    // arms anything on a stale item. DYE2 always hears about it: it records off the
    // workflow push whatever the skin believes, so a missed arm would write this
    // item's values onto the one armed before. A DYE2 that confirms records for
    // itself; otherwise (older plugin, or the post failed) the legacy auto-save below
    // needs the drift anchors: profileId from fav.workflow?.profile (items saved by this
    // version) or snapshot.profileId (legacy), with profileFingerprint backing it up
    // for Decaid, whose workflow.profile carries no id at all.
    dye2Armed = await armSelection('favourite', fav.id, seq);
    if (seq !== applySeq) return;
    if (dye2Armed) {
        activeItem = null;
    } else {
        activeItem = {
            kind: 'favourite',
            id: fav.id,
            profileId: fav.workflow?.profile?.id ?? fav.snapshot?.profileId ?? null,
            profileFingerprint: profileFingerprint(patch.profile ?? live.profile),
        };
    }
    await refreshAfterApply();
}

export async function applyRecipe(recipe) {
    if (!recipe) return;
    const live = (await getWorkflow()) || {};
    const patch = recipe.workflow
        ? await applyStoredWorkflow(recipe.workflow)
        : await applyRecipeLegacy(recipe); // dashboardVariables + top-level fields
    // Steam / hot-water / flush are NOT in the stored workflow — add them here.
    const dv = recipe.dashboardVariables || {};
    Object.assign(patch, await mergeRecipeLiveSettings(dv));
    // This recipe is now the one being dialled in (dye2#36).
    mergeContext(patch, recipeIdPatch(recipe.id));
    const seq = ++applySeq;
    await withAutoSaveSuppressed(() => updateWorkflow(patch, 'dye.applyRecipe'));
    if (seq !== applySeq) return; // a newer tap owns the arming
    // Arm this recipe for the dial-in that follows — see applyFavourite for why it
    // happens after the PUT, is always posted, and why only the legacy path needs the
    // drift anchors.
    dye2Armed = await armSelection('recipe', recipe.id, seq);
    if (seq !== applySeq) return;
    if (dye2Armed) {
        activeItem = null;
    } else {
        activeItem = {
            kind: 'recipe',
            id: recipe.id,
            profileId: recipe.profileId ?? recipe.workflow?.profile?.id ?? null,
            profileFingerprint: profileFingerprint(patch.profile ?? live.profile),
        };
    }
    // Pass the recipe's own mode along so the tile's bold sub-value matches
    // what was actually just applied, not whatever unit the tile happened to
    // be showing before (see refreshAfterApply).
    await refreshAfterApply({ steamMode: dv.steamMode, hotWaterMode: dv.hotWaterMode });
}

// PUT /api/v1/workflow deep-merges the request body onto whatever workflow is
// currently loaded (reaprime workflow_handler.dart _applyUpdate:
// deepMergeJson(currentJson, merge) then Workflow.fromJson) -- it does not
// replace it. So a `profile` of only { id, title } overwrites just those two
// keys on the profile ALREADY on the machine: the `steps` array (the actual
// brew recipe) stays whatever was loaded before. The machine keeps brewing
// the old profile, now mislabeled with the new one's name.
//
// Resolve `stub` (an { id, title } thin reference, an id string, or an
// already-full Profile) to the full Profile object (steps included) via
// GET /profiles, so callers can PUT the real thing. Returns null (never
// throws) when there is nothing to resolve it from -- an ad-hoc profile with no
// library record -- and the caller then leaves the loaded profile alone.
async function resolveFullProfile(stub) {
    if (!stub) return null;
    // Before the id guard below, not after: a DYE2 row that captured the whole
    // profile stores Decaid's `workflow.profile`, which carries no id at all, so
    // reading the id first threw away every fully-captured recipe.
    //
    // steps.length, not just Array.isArray: older DYE2 rows store the profile as
    // { id, title, steps: [] }, and treating that as full PUTs a profile with no steps --
    // the live curve keeps running under the recipe's name, which reads as "the recipe did
    // not load". An empty array means the steps were never captured, so resolve by id.
    if (typeof stub === 'object' && profilePatchWithSteps(stub)) return stub; // already full
    const id = typeof stub === 'string' ? stub : stub.id;
    if (!id) return null;
    try {
        const records = await getProfiles();
        const record = Array.isArray(records) ? records.find(r => r && r.id === id) : null;
        if (record && record.profile) return record.profile;
    } catch (e) {
        logger.warn(`resolveFullProfile: failed to fetch profiles while resolving ${id}`, e);
    }
    logger.warn(`resolveFullProfile: could not resolve profile ${id} to a full record (purged/ad-hoc profile?) — the loaded profile is left alone`);
    return null;
}

// The stored `workflow` is a ready-to-PUT { context, profile? }. Merge its context
// over the live context (preserving fields it doesn't set) and its profile if any.
// The profile is resolved to its full record regardless of what shape was
// actually stored (older KV items may still carry the legacy thin { id, title }
// stub — see resolveFullProfile), and is left out of the patch when it cannot
// be resolved.
// Fold a context fragment into a patch, keeping `extras` a merge rather than a
// replace: the legacy paths may already have put rpm or note there.
function mergeContext(patch, fragment) {
    const ctx = patch.context || {};
    patch.context = {
        ...ctx, ...fragment,
        ...(ctx.extras || fragment.extras
            ? { extras: { ...(ctx.extras || {}), ...(fragment.extras || {}) } }
            : {}),
    };
    return patch;
}

async function applyStoredWorkflow(workflow) {
    const patch = {};
    if (workflow.context) patch.context = { ...workflow.context };
    if (workflow.profile) {
        // Never the stored stub as a fallback -- see profilePatchWithSteps. An
        // unresolvable profile leaves the loaded one alone, name included.
        const full = profilePatchWithSteps(await resolveFullProfile(workflow.profile));
        if (full) patch.profile = full;
    }
    return patch;
}

// Legacy favourite (no `workflow`): copyMask-gated snapshot → context. Mirrors
// dashboard.ts applyAutoFavourite. Absent mask key ⇒ on.
async function applyFavLegacy(fav) {
    const snp = fav.snapshot || {};
    const mask = fav.copyMask || {};
    const on = k => mask[k] !== false;
    // Seeded empty, not from the live context: PUT deep-merges, so carrying the
    // live values forward only re-sends fields this favourite does not own --
    // which is how a stale number overwrote a newer one (#165).
    const ctx = {};
    if (on('dose') && snp.dose != null) ctx.targetDoseWeight = snp.dose;
    if (on('drink') && snp.drink != null) ctx.targetYield = snp.drink;
    if (on('grindSetting')) {
        if (snp.grindSetting != null) ctx.grinderSetting = String(snp.grindSetting);
        if (snp.rpm != null) ctx.extras = { ...(ctx.extras || {}), rpm: snp.rpm };
    }
    if (on('grinder')) {
        if (snp.grinderId) ctx.grinderId = snp.grinderId;
        if (snp.grinderModel) ctx.grinderModel = snp.grinderModel;
    }
    if (on('beans')) {
        if (snp.beanBatchId) ctx.beanBatchId = snp.beanBatchId;
        if (snp.coffeeName) ctx.coffeeName = snp.coffeeName;
        if (snp.coffeeRoaster) ctx.coffeeRoaster = snp.coffeeRoaster;
    }
    if (on('roastDate') && snp.roastDate) ctx.roastDate = snp.roastDate;
    if (on('barista') && snp.barista) ctx.baristaName = snp.barista;
    if (on('drinker') && snp.drinker) ctx.drinkerName = snp.drinker;
    if (on('note') && snp.note) ctx.extras = { ...(ctx.extras || {}), note: snp.note };
    const patch = Object.keys(ctx).length ? { context: ctx } : {};
    if (on('profile') && (snp.profileId || snp.profileTitle)) {
        // Snapshot first, the stored id second, and nothing at all if neither
        // yields steps -- a title-only patch renames the loaded profile instead
        // of replacing it (see profilePatchWithSteps).
        const full = profilePatchWithSteps(snp.profileSnapshot)
            || profilePatchWithSteps(snp.profileId ? await resolveFullProfile(snp.profileId) : null);
        if (full) patch.profile = full;
    }
    return patch;
}

// Legacy recipe (no `workflow`): dashboardVariables → context. Mirrors dashboard.ts
// applyRecipe (context portion; steam/hw/flush handled by mergeRecipeLiveSettings).
async function applyRecipeLegacy(recipe) {
    const dv = recipe.dashboardVariables || {};
    const ctx = {}; // see applyFavLegacy: deep-merge means only what changed
    if (dv.dose != null) ctx.targetDoseWeight = dv.dose;
    if (dv.drink != null) ctx.targetYield = dv.drink;
    else if (dv.ratio != null && dv.dose != null) ctx.targetYield = Math.round(dv.dose * dv.ratio * 10) / 10;
    if (dv.grind != null) ctx.grinderSetting = String(dv.grind);
    if (dv.rpm != null) ctx.extras = { ...(ctx.extras || {}), rpm: dv.rpm };
    if (dv.grinderId) ctx.grinderId = dv.grinderId;
    if (recipe.barista) ctx.baristaName = recipe.barista;
    if (recipe.drinker) ctx.drinkerName = recipe.drinker;
    const patch = Object.keys(ctx).length ? { context: ctx } : {};
    if (recipe.profileId || recipe.profileTitle) {
        // Same as applyFavLegacy: no steps, no profile in the patch.
        const full = profilePatchWithSteps(recipe.profileSnapshot)
            || profilePatchWithSteps(recipe.profileId ? await resolveFullProfile(recipe.profileId) : null);
        if (full) patch.profile = full;
    }
    return patch;
}

// Override only the recipe's steam/hot-water/flush fields on the LIVE sub-objects
// (which already carry the required targetTemperature/flow). Guarded so we never
// send a partial. Identical to dashboard.ts applyRecipe.
//
// Also persists each field we touch to its "last value" KV record
// (api.persistSharedValue — a plain KV write, no hardware call). Those records
// are what api.resyncIfDrifted compares against on the very next
// loadInitialData() (see refreshAfterApply): applyRecipe PUTs the new value
// straight onto the workflow, bypassing the api.setTargetSteam*/setTargetHotWater*
// setters that normally keep the KV record in sync. Without this, the refresh
// right after applying the recipe sees the new value as *drift* from the old
// remembered one and immediately pushes the OLD value back over both the
// workflow and the live machine — silently reverting the recipe's own change.
async function mergeRecipeLiveSettings(dv) {
    const patch = {};
    const steam = {};
    if (dv.steamMode === 'time' && dv.steamTimeS != null) {
        steam.duration = dv.steamTimeS;
        await persistSharedValue(STEAM_DURATION_LAST_VALUE_KEY, dv.steamTimeS);
    }
    if (dv.steamMode === 'flow' && dv.steamFlowMls != null) {
        steam.flow = dv.steamFlowMls;
        await persistSharedValue(STEAM_FLOW_LAST_VALUE_KEY, dv.steamFlowMls);
    }
    if (Object.keys(steam).length) patch.steamSettings = steam;

    const water = {};
    if (dv.hotWaterMode === 'vol' && dv.hotWaterMl != null) {
        water.volume = dv.hotWaterMl;
        await persistSharedValue(HOT_WATER_VOLUME_LAST_VALUE_KEY, dv.hotWaterMl);
    }
    if (dv.hotWaterMode === 'temp' && dv.hotWaterTempC != null) {
        water.targetTemperature = dv.hotWaterTempC;
        await persistSharedValue(HOT_WATER_TEMP_LAST_VALUE_KEY, dv.hotWaterTempC);
    }
    if (Object.keys(water).length) patch.hotWaterData = water;

    if (dv.flushS != null) {
        patch.rinseData = { duration: dv.flushS };
        await persistSharedValue(FLUSH_DURATION_LAST_VALUE_KEY, dv.flushS);
    }
    return patch;
}

// Re-pull the workflow and update the left-rail controls — the same path used on
// initial load / after a profile change (window.loadInitialData is set by app.js).
//
// modeHints (optional, recipe apply only): { steamMode: 'time'|'flow',
// hotWaterMode: 'vol'|'temp' } straight off the recipe's dashboardVariables.
// Neither repaint path above has any notion of "which unit was the recipe's
// own" — they repaint the tiles' numbers straight from the live workflow and
// never touch ui.js's private steamMode/hotWaterMode display-mode variables.
// Applied here, directly against ui.js, after the repaint settles, so the
// tile's bold sub-value matches what the recipe actually set instead of
// whatever unit happened to be showing before. Hot water has no hardware
// side effect either way; steam is routed through setSteamTileModeIfSafe,
// which refuses to touch 'auto'/'temperature' (real hardware/firmware calls —
// see ui.js toggleSteamMode) and only moves between plain 'time'/'flow'.
async function refreshAfterApply(modeHints) {
    try {
        if (typeof window.loadInitialData === 'function') {
            await window.loadInitialData();
        } else {
            const wf = await getWorkflow();
            applyWorkflowToMainPageUI(wf);
        }
    } catch (e) {
        logger.error('dyeStrip refreshAfterApply failed', e);
    }
    if (modeHints) {
        if (modeHints.steamMode === 'time' || modeHints.steamMode === 'flow') {
            setSteamTileModeIfSafe(modeHints.steamMode);
        }
        if (modeHints.hotWaterMode === 'vol' || modeHints.hotWaterMode === 'temp') {
            setHotWaterTileMode(modeHints.hotWaterMode === 'temp' ? 'temperature' : 'volume');
        }
    }
}

// ─── DYE2 page navigation (iframe overlay, same-origin) ────────────────────────
//
// In production reaprime serves the skin and the plugin from the same origin, so
// the DYE2 page can load in a same-origin <iframe> overlay and the parent can read
// iframe.contentWindow.location on `load` to detect the plugin returning. The DYE2
// pages honour a `?return=` param; we point it at a sentinel skin URL and close +
// refresh when the iframe navigates there.
//
// In dev the skin (:8000) and bridge (:8080) are cross-origin: X-Frame-Options
// SAMEORIGIN blocks the iframe and reading contentWindow.location throws, so we
// fall back to a full-page navigation with ?return set to this page.

function sentinelReturnUrl() {
    return `${window.location.origin}${window.location.pathname}?dyeReturn=1`;
}

function isSameOrigin(url) {
    try {
        return new URL(url, window.location.href).origin === window.location.origin;
    } catch (e) {
        return false;
    }
}

// `params` adds query params (e.g. { id }) next to `return`. They travel in the URL because
// sessionStorage is per-origin: in the cross-origin fallback below DYE2 cannot see ours.
// `onClose(refresh)` runs when the overlay goes away: `refresh` is true when the plugin
// navigated back to the sentinel return URL (it saved/deleted something), false for the
// skin's own Close button. Only the caller that needs a repaint passes one.
let overlayCloseHook = null;
export function openPluginOverlay(page, params, onClose) {
    overlayCloseHook = typeof onClose === 'function' ? onClose : null;
    const pluginUrl = `${PLUGIN_BASE}/${page}`;
    const query = (returnTo) => {
        const q = new URLSearchParams({ return: returnTo });
        for (const [k, v] of Object.entries(params || {})) q.set(k, String(v));
        return q.toString();
    };
    const ret = sentinelReturnUrl();

    // Cross-origin (dev): iframe would be blocked → full-page navigation instead.
    if (!isSameOrigin(pluginUrl)) {
        // The reload on return would drop the selection and auto-save target. A DYE2
        // that records for itself already holds the selection in its own storage,
        // so there is nothing to park.
        try {
            const parked = dye2Armed ? null : serializeSelection(activeItem);
            if (parked) sessionStorage.setItem(SELECTION_KEY, parked);
            else sessionStorage.removeItem(SELECTION_KEY);
        } catch (e) { /* private mode: selection simply does not survive */ }
        window.location.href = `${pluginUrl}?${query(window.location.href)}`;
        return;
    }

    let overlay = document.getElementById('dye-plugin-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dye-plugin-overlay';
        overlay.style.cssText =
            'position:fixed;inset:0;z-index:9999;background:var(--bgmain-color, #fff);display:flex;flex-direction:column;';
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;justify-content:flex-end;padding:8px 12px;background:var(--box-color,#f3f4f6);';
        const close = document.createElement('button');
        close.textContent = 'Close';
        close.style.cssText =
            'padding:8px 22px;border:2px solid var(--mimoja-blue-v2);color:var(--mimoja-blue-v2);border-radius:20px;font-weight:600;font-size:20px;cursor:pointer;';
        close.addEventListener('click', () => closePluginOverlay(false));
        bar.appendChild(close);
        const frame = document.createElement('iframe');
        frame.id = 'dye-plugin-frame';
        frame.style.cssText = 'flex:1;width:100%;border:0;';
        // Same-origin load handler: when the plugin navigates back to our sentinel
        // return URL, tear down the overlay and refresh the strip + controls. The plugin
        // adds `dyeShot=<id>` for the shot it was showing on the way out (it may have moved
        // off the one we opened), so the caller repaints the right row.
        frame.addEventListener('load', () => {
            let href = '';
            try { href = frame.contentWindow.location.href; } catch (e) { return; } // cross-origin, ignore
            if (!href.includes('dyeReturn=1')) return;
            let editedShotId = null;
            try { editedShotId = new URL(href).searchParams.get('dyeShot'); } catch (e) { /* ignore */ }
            closePluginOverlay(true, editedShotId);
        });
        overlay.appendChild(bar);
        overlay.appendChild(frame);
        document.body.appendChild(overlay);
    }
    const frame = document.getElementById('dye-plugin-frame');
    frame.src = `${pluginUrl}?${query(ret)}`;
    overlay.style.display = 'flex';
}

function closePluginOverlay(refresh, editedShotId) {
    const overlay = document.getElementById('dye-plugin-overlay');
    if (overlay) overlay.style.display = 'none';
    const hook = overlayCloseHook;
    overlayCloseHook = null;
    if (refresh) {
        // DYE2 may have applied a fav/recipe or edited the collections while open.
        loadDyeStripData().then(() => { if (currentMode !== 'P') renderStrip(currentMode); }).catch(() => {});
        refreshAfterApply();
    }
    if (hook) {
        try { hook(!!refresh, editedShotId || null); } catch (e) { logger.warn('plugin overlay close hook failed', e); }
    }
}

// Jump straight to DYE2's own recipe-edit screen for one recipe, instead of the
// dashboard root. Current DYE2 opens a recipe by its opaque id (`dye_editRecipeId`);
// a blank cell has no row, so the key is cleared and recipe-edit starts a new recipe on
// the slot that cell stands for (`?slot=`, honoured since DYE2 0.1.25 — an older build
// ignores it and the recipe is saved to the library, as before). Older DYE2 builds read `dye_editRecipeIdx`, the
// position of the recipe in a list of ids '1'..'5', so that key is still set when the
// id has that shape (harmless to a newer DYE2). The sessionStorage keys only reach DYE2
// when it shares our origin; the page is normally opened on the bridge origin, so the
// real handoff is the URL: `?id=<recipeId>` opens that recipe, `?new=1` starts a blank one.
function editRecipe(recipe) {
    try {
        if (recipe.blank) sessionStorage.removeItem('dye_editRecipeId');
        else sessionStorage.setItem('dye_editRecipeId', String(recipe.id));
        const n = parseInt(recipe.id, 10);
        if (String(recipe.id) === String(n) && n >= 1 && n <= 5) sessionStorage.setItem('dye_editRecipeIdx', String(n - 1));
        else sessionStorage.removeItem('dye_editRecipeIdx');
    } catch (e) { /* private mode */ }
    openPluginOverlay('recipe-edit', recipe.blank ? { new: 1, slot: recipe.id } : { id: recipe.id });
}

// Same idea for a favourite: jump to DYE2's own auto-fav-edit screen, which has
// a per-field pencil (including "Grind Setting") so a grind you dialed in on
// the dashboard after applying this favourite can be saved back onto it --
// applying a favourite only ever pushes its captured grind onto the workflow,
// it never updates the favourite (see KV_CONTRACT.md's single-writer rule and
// applyFavLegacy above). Favourites are keyed by their own id, not a fixed
// slot, hence 'dye_editAutoFavId' (a string) rather than recipe's numeric idx.
// No id ⇒ fall back to the plain favourites list rather than opening a blank
// "new favourite" form.
function editFavourite(fav) {
    if (fav.id == null) { openPluginOverlay('auto-favs'); return; }
    try { sessionStorage.setItem('dye_editAutoFavId', String(fav.id)); } catch (e) { /* private mode */ }
    openPluginOverlay('auto-fav-edit');
}

// ─── Plugin install / version state ───────────────────────────────────────────
//
// Streamline is a read-only consumer of DYE2's KV contract, so an outdated plugin
// shows up here as missing keys / empty strips rather than an error. Decaid owns
// distribution now: it records where dye2.reaplugin came from and installs new
// releases itself, holding back only updates that ask for new permissions (those
// surface as pendingUpdate on GET /plugins). So there is nothing to nag about —
// Streamline just reads the bridge and never talks to GitHub.
//
// Dialogs here are inline-styled like openPluginOverlay's overlay, not Tailwind:
// any new utility class would need a CSS rebuild to exist in app.css (see CLAUDE.md).

// ponytail: numeric compare only — dye2 tags are plain vMAJOR.MINOR.PATCH. If it
// ever ships `-beta` tags, borrow settings.js's compareVersions, which orders them.
function isOlderVersion(a, b) {
    const nums = (v) => String(v || '').trim().replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const x = nums(a), y = nums(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d !== 0) return d < 0;
    }
    return false;
}

// ─── Enable-time plugin requirement gate ────────────────────────────────────
// Toggling DYE2 on in Settings requires the plugin actually installed, loaded,
// and at least MIN_PLUGIN_VERSION — otherwise the header lights up with no data
// behind it. This floor is about the KV contract, not about being current: Decaid
// keeps the plugin up to date on its own, so bump it only when the contract moves.
const MIN_PLUGIN_VERSION = '0.1.4';

export async function checkDye2PluginRequirement() {
    const plugins = await getPlugins();
    if (!plugins) return { ok: false, reason: 'unreachable' };
    const plugin = plugins.find(p => p?.id === PLUGIN_ID);
    if (!plugin) return { ok: false, reason: 'missing' };
    if (!plugin.loaded) return { ok: false, reason: 'not-loaded', installed: plugin.version };
    if (isOlderVersion(plugin.version, MIN_PLUGIN_VERSION)) return { ok: false, reason: 'outdated', installed: plugin.version };
    return { ok: true, installed: plugin.version };
}

// Resolves true once the plugin is installed, loaded and at the required floor —
// so the Settings toggle can go on — and false if the user backed out or the
// install failed. Decaid installs plugins itself now (POST
// /plugins/install/github-release), so "missing" and "outdated" are one button,
// not a download-and-sideload errand; the releases page stays as the fallback for
// when that call fails (offline, GitHub down, a release with no single zip).
function promptPluginRequired(reason, installed) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.id = 'dye2-required-dialog';
        dlg.style.cssText =
            'border:0;border-radius:24px;padding:0;background:transparent;color:var(--text-primary);';
        const body = {
            missing: `The DYE2 plugin isn't installed (need v${MIN_PLUGIN_VERSION}+). Install it from ${PLUGIN_REPO} and it will be enabled for you.`,
            'not-loaded': `The DYE2 plugin (v${installed || '?'}) is installed but not loaded. Open Decaid's Plugin settings and enable it, then come back and turn DYE2 on again.`,
            outdated: `Installed DYE2 plugin is v${installed}, older than the required v${MIN_PLUGIN_VERSION}. Install the current release to continue.`,
            unreachable: `Couldn't reach the plugin bridge to verify DYE2 is installed. Check the connection and try again.`,
        }[reason] || `DYE2 plugin v${MIN_PLUGIN_VERSION}+ is required to enable this.`;
        // Only missing/outdated are fixable from here. "not-loaded" needs a human in
        // Decaid's plugin settings and "unreachable" has no bridge to install through.
        const canInstall = reason === 'missing' || reason === 'outdated';
        dlg.innerHTML = `
            <div style="background:var(--bgmain-color,#fff);border-radius:24px;padding:36px 40px;max-width:640px;display:flex;flex-direction:column;gap:18px;">
                <div style="font-size:30px;font-weight:700;color:var(--mimoja-blue-v2);">DYE2 plugin required</div>
                <div id="dye2-required-body" style="font-size:23px;line-height:1.4;">${body}</div>
                <div style="display:flex;justify-content:flex-end;gap:14px;padding-top:6px;">
                    <button id="dye2-required-cancel" style="padding:10px 26px;border:2px solid var(--mimoja-blue-v2);background:transparent;color:var(--mimoja-blue-v2);border-radius:20px;font-size:22px;font-weight:600;cursor:pointer;">${canInstall ? 'Cancel' : 'OK'}</button>
                    ${canInstall ? `<button id="dye2-required-install" style="padding:10px 26px;border:0;background:var(--button-primary-bg);color:#fff;border-radius:20px;font-size:22px;font-weight:600;cursor:pointer;">Install</button>` : ''}
                </div>
            </div>`;
        document.body.appendChild(dlg);

        const close = (ok) => { dlg.close(); dlg.remove(); resolve(ok); };
        dlg.querySelector('#dye2-required-cancel').addEventListener('click', () => close(false));

        const installBtn = dlg.querySelector('#dye2-required-install');
        installBtn?.addEventListener('click', async () => {
            const text = dlg.querySelector('#dye2-required-body');
            installBtn.disabled = true;
            installBtn.textContent = 'Installing…';
            try {
                await installDye2Plugin();
                const recheck = await checkDye2PluginRequirement();
                if (recheck.ok) { close(true); return; }
                text.textContent = `Installed v${recheck.installed || '?'}, but it still isn't usable (${recheck.reason}). Open Decaid's Plugin settings to finish enabling it.`;
                installBtn.remove();
                dlg.querySelector('#dye2-required-cancel').textContent = 'OK';
            } catch (e) {
                logger.error('dyeStrip: DYE2 install failed', e);
                // textContent, not innerHTML: the message is a server/network error string.
                text.textContent = `Install failed: ${e.message || e}. You can install the zip by hand from the releases page instead.`;
                installBtn.disabled = false;
                installBtn.textContent = 'Releases';
                installBtn.replaceWith(installBtn.cloneNode(true)); // drop this handler
                dlg.querySelector('#dye2-required-install').addEventListener('click', () => {
                    close(false);
                    // Same-frame nav, no _blank/window.open: in the tablet webview the
                    // host intercepts the external URL and hands it to the OS browser.
                    window.location.href = PLUGIN_RELEASES_PAGE;
                });
            }
        });
        dlg.showModal();
    });
}

// Called from the Settings toggle before flipping DYE2 on. Prompts and returns
// false if the plugin isn't ready; the caller should leave the toggle off.
export async function ensureDye2PluginReady() {
    const check = await checkDye2PluginRequirement();
    if (check.ok) return true;
    // The prompt can fix "missing"/"outdated" in place, so its result — not the
    // original check — decides whether the toggle may go on.
    return promptPluginRequired(check.reason, check.installed);
}

// Everything the Settings → DYE2 card needs, straight off the bridge:
// GET /plugins carries the installed version, the recorded `source` and, when an
// update was held back for asking new permissions, `pendingUpdate`. An
// unreachable bridge is reported as such rather than guessed at.
export async function getDye2VersionInfo() {
    const plugins = await getPlugins().catch(() => null);
    if (!plugins) return { reachable: false, installed: null, loaded: false, source: null, pending: null };
    const plugin = plugins.find(p => p?.id === PLUGIN_ID);
    return {
        reachable: true,
        installed: plugin?.version || null,
        loaded: !!plugin?.loaded,
        source: plugin?.source || null,
        pending: plugin?.pendingUpdate || null,
    };
}

// Install from the canonical repo's latest release and enable it. Decaid installs
// plugins with auto-load off, so the enable call is what actually starts it and
// makes it load on the next app start.
export async function installDye2Plugin() {
    const result = await installPluginFromRelease(PLUGIN_REPO);
    await enablePlugin(PLUGIN_ID);
    logger.info(`dyeStrip: installed ${PLUGIN_ID} v${result?.version || '?'} from ${PLUGIN_REPO}`);
    return result;
}

const CHECK_COOLDOWN_MS = 15 * 60 * 1000; // see checkDye2UpdatesIfDue

// Ask Decaid to compare the installed copy against the release its recorded
// source points at. An update that asks for no new permission is downloaded AND
// installed inside this call — Decaid restarts the plugin on it — so afterwards
// the bridge already reports the new version. One that asks for more becomes a
// pendingUpdate that only an explicit approval installs.
//
// Decaid queries api.github.com unauthenticated: 60 requests an hour for the
// whole tablet, shared with its own periodic check and with skin updates. Past
// that GitHub answers 403 and the check records a lastError instead of an answer.
// Opening a settings page or flipping a toggle is something a user can do
// repeatedly, so honour the recorded lastChecked and skip a check that would only
// re-ask a question Decaid asked minutes ago. Anything an earlier check already
// found is still on the bridge to read.
//
// Returns the state after the check. Never throws: a failed check (offline,
// GitHub down, rate-limited) leaves the installed plugin working and untouched.
export async function checkDye2UpdatesIfDue() {
    const before = await getDye2VersionInfo();
    // An untracked copy (local ZIP or folder) has no source to check against, and
    // updateAllPlugins skips it anyway.
    if (!before.reachable || !before.installed || !before.source) return before;

    const lastChecked = Date.parse(before.source.lastChecked || '');
    if (Number.isFinite(lastChecked) && Date.now() - lastChecked < CHECK_COOLDOWN_MS) return before;

    try {
        await checkPluginUpdates();
    } catch (e) {
        logger.info(`dyeStrip: update check failed (${e.message || e})`);
    }
    const after = await getDye2VersionInfo();
    if (after.installed && after.installed !== before.installed) {
        logger.info(`dyeStrip: DYE2 updated v${before.installed} -> v${after.installed}`);
    }
    return after;
}

// Called after the DYE2 toggle goes on. Same check, plus the prompt: an update
// held back for asking new permissions is the one thing that needs a decision,
// and the toggle is where the user is looking. Resolves true if the plugin ended
// up on a new version, either because Decaid installed it or because the user
// approved the escalating one.
//
// Never blocks the toggle: the requirement gate already established the plugin is
// usable, so nothing here can leave DYE2 off.
export async function offerDye2Update() {
    const before = await getDye2VersionInfo();
    const after = await checkDye2UpdatesIfDue();
    if (after.installed && after.installed !== before.installed) return true;
    if (after.pending) return promptPluginUpdate(after);
    return false;
}

// Force an update check now (no cooldown: the user just hit a feature the installed copy lacks).
// Decaid installs a no-new-permission update inside the check; one asking for more permissions
// still goes through the consent dialog. Resolves true if DYE2 ended up on a new version.
async function updateDye2Now() {
    const before = await getDye2VersionInfo();
    if (!before.reachable || !before.source) return false;
    showToast('Updating DYE2…', 2000, 'info');
    await checkPluginUpdates().catch(e => logger.info(`dyeStrip: update check failed (${e.message || e})`));
    const after = await getDye2VersionInfo();
    if (after.installed && after.installed !== before.installed) return true;
    return after.pending ? promptPluginUpdate(after) : false;
}

// Resolves true if the update was installed. The added permissions are listed
// verbatim: approving is consent to those, not to "an update", so nothing here
// approves on the user's behalf.
function promptPluginUpdate(info) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.id = 'dye2-update-dialog';
        dlg.style.cssText =
            'border:0;border-radius:24px;padding:0;background:transparent;color:var(--text-primary);';
        const permissions = (info.pending.addedPermissions || []).join(', ') || 'none listed';
        dlg.innerHTML = `
            <div style="background:var(--bgmain-color,#fff);border-radius:24px;padding:36px 40px;max-width:640px;display:flex;flex-direction:column;gap:18px;">
                <div style="font-size:30px;font-weight:700;color:var(--mimoja-blue-v2);">DYE2 update available</div>
                <div id="dye2-update-body" style="font-size:23px;line-height:1.4;">
                    Installed <b>v${info.installed}</b>, available <b>v${info.pending.version}</b>.
                    It asks for permissions the installed version does not have:
                    <b>${permissions}</b>. Update only if you trust this.
                </div>
                <div style="display:flex;justify-content:flex-end;gap:14px;padding-top:6px;">
                    <button id="dye2-update-later" style="padding:10px 26px;border:2px solid var(--mimoja-blue-v2);background:transparent;color:var(--mimoja-blue-v2);border-radius:20px;font-size:22px;font-weight:600;cursor:pointer;">Later</button>
                    <button id="dye2-update-now" style="padding:10px 26px;border:0;background:var(--button-primary-bg);color:#fff;border-radius:20px;font-size:22px;font-weight:600;cursor:pointer;">Update</button>
                </div>
            </div>`;
        document.body.appendChild(dlg);

        const close = (updated) => { dlg.close(); dlg.remove(); resolve(updated); };
        dlg.querySelector('#dye2-update-later').addEventListener('click', () => close(false));

        const updateBtn = dlg.querySelector('#dye2-update-now');
        updateBtn.addEventListener('click', async () => {
            const text = dlg.querySelector('#dye2-update-body');
            updateBtn.disabled = true;
            updateBtn.textContent = 'Updating…';
            try {
                const result = await approvePluginUpdate(PLUGIN_ID);
                logger.info(`dyeStrip: DYE2 approved and updated to v${result?.version || '?'}`);
                close(true);
            } catch (e) {
                // 409: the release moved after this permission delta was shown. Decaid
                // has recorded the new candidate, so the fresh delta has to be reviewed
                // — retrying this call would only 409 again.
                text.textContent = e.status === 409
                    ? 'The update changed since it was shown. Open Settings → Extensions to review the new one.'
                    : `Update failed: ${e.message || e}`;
                if (e.status !== 409) logger.error('dyeStrip: DYE2 update approval failed', e);
                updateBtn.remove();
                dlg.querySelector('#dye2-update-later').textContent = 'OK';
            }
        });
        dlg.showModal();
    });
}

// ─── Toggle + init ─────────────────────────────────────────────────────────────

export function setStripMode(mode) {
    currentMode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* private mode */ }

    // Active pill styling.
    ['P', 'F', 'R'].forEach(m => {
        const pill = document.getElementById(`dye-toggle-${m}`);
        if (!pill) return;
        const active = m === mode;
        pill.classList.toggle('bg-[var(--button-primary-bg)]', active);
        pill.classList.toggle('text-[var(--button-primary-text)]', active);
        pill.classList.toggle('text-[var(--tab-text-inactive)]', !active);
        pill.classList.toggle('bg-[var(--dye-toggle-inactive-bg)]', !active);
    });

    // Visibility via inline display (a Tailwind `flex` utility overrides [hidden]).
    const profileNav = document.getElementById('profile-fav-nav');
    const dyeStrip = document.getElementById('dye-strip');
    if (mode === 'P') {
        if (profileNav) profileNav.style.display = '';
        if (dyeStrip) dyeStrip.style.display = 'none';
    } else {
        if (profileNav) profileNav.style.display = 'none';
        if (dyeStrip) dyeStrip.style.display = '';
        renderStrip(mode);
        // DYE2 may have changed the selection or recorded onto it since the last redraw.
        syncSelection().then(ok => { if (ok && currentMode === mode) renderStrip(mode); }).catch(() => {});
    }
}

// ─── Header collision guard ──────────────────────────────────────────────────
// The favourite strip and the right-hand controls are both absolutely positioned,
// so neither pushes the other out of the way. With DYE2 on the strip starts 50px
// further right and the DYE button widens the controls; add the Bengle cup warmer
// and the five 225px cells run underneath them. Bound the strips at the controls'
// measured edge and let the cells shrink into what is left — measured rather than
// hardcoded so it follows cup-warmer/fullscreen visibility and translated labels.
const STRIP_GAP = 20;
const STRIP_IDS = ['profile-fav-nav', 'dye-strip'];
let controlsObserver = null;

function syncStripBounds() {
    const controls = document.getElementById('header-right-controls');
    const header = controls?.closest('header');
    if (!controls || !header) return;
    const box = header.getBoundingClientRect();
    const right = stripRightInset({ headerRight: box.right, headerWidth: box.width, headerLayoutWidth: header.offsetWidth,
        controlsLeft: controls.getBoundingClientRect().left, gap: STRIP_GAP });
    STRIP_IDS.forEach(id => {
        const nav = document.getElementById(id);
        if (!nav) return;
        nav.style.right = `${right}px`;
        fitStripCells(nav); // narrower cells wrap more, so the fit has to be redone
    });
}

// The controls resize when the cup warmer or fullscreen button shows/hides and when
// data-fit-text refits a translated label. Width is anchored to the header's right
// edge, so a plain window resize needs no handling.
function observeControls() {
    if (controlsObserver || typeof ResizeObserver === 'undefined') return;
    const controls = document.getElementById('header-right-controls');
    if (!controls) return;
    controlsObserver = new ResizeObserver(() => syncStripBounds());
    controlsObserver.observe(controls);
}

function clearStripBounds() {
    controlsObserver?.disconnect();
    controlsObserver = null;
    STRIP_IDS.forEach(id => {
        const nav = document.getElementById(id);
        if (!nav) return;
        nav.style.right = '';
        fitStripCells(nav); // cells are back to full width — labels can grow again
    });
}

// ─── Master enable/disable (gates the whole DYE2 header UI) ─────────────────────

export function isDye2Enabled() {
    try { return localStorage.getItem(ENABLED_KEY) === 'true'; } catch (e) { return false; }
}

let wired = false; // one-time listener wiring, so re-enabling doesn't double-bind

function wireOnce() {
    if (wired) return;
    wired = true;
    ['P', 'F', 'R'].forEach(m => {
        const pill = document.getElementById(`dye-toggle-${m}`);
        if (pill) pill.addEventListener('click', () => setStripMode(m));
    });
    const dyeBtn = document.getElementById('dye-open-btn');
    if (dyeBtn) dyeBtn.addEventListener('click', () => openPluginOverlay('dashboard'));

    // No push channel for the KV store — re-poll on focus / tab visibility so edits
    // DYE2 made while Streamline was idle appear (KV_CONTRACT "Freshness").
    const repoll = () => {
        if (document.hidden || !isDye2Enabled()) return;
        loadDyeStripData().then(async () => {
            // DYE2 owns the arming: a selection cleared or changed inside it while this
            // page sat idle must not leave a stale highlight. Only when nothing is
            // armed here, and never over a tap that landed during the GET.
            await syncSelection();
            if (currentMode !== 'P') renderStrip(currentMode);
        }).catch(() => {});
    };
    window.addEventListener('focus', repoll);
    // A plugin said the workflow changed (DYE2 may have written it). Leading call
    // plus one trailing call, at least 2 s apart.
    let lastRepoll = 0;
    let repollTimer = null;
    document.addEventListener('streamline:workflow-refresh', () => {
        if (repollTimer) return;
        const wait = 2000 - (Date.now() - lastRepoll);
        if (wait <= 0) { lastRepoll = Date.now(); repoll(); return; }
        repollTimer = setTimeout(() => { repollTimer = null; lastRepoll = Date.now(); repoll(); }, wait);
    });
    document.addEventListener('visibilitychange', repoll);
    // The DYE button is a same-frame top-level nav away to the DYE2 plugin (see
    // openPluginOverlay); returning via the browser Back button restores this page
    // from bfcache — a frozen pre-edit snapshot that fires `pageshow` (persisted),
    // not focus/visibilitychange. Mirrors profile_selector.js's plugin-return guard.
    // A fetch fired right as the browser wakes the network stack back up from
    // bfcache can intermittently fail (getDye2KvArray -> null, caches kept).
    // Retry once shortly after to cover that.
    // bfcache restore also means this page never reloaded, so a selection parked
    // for the trip is stale: it would re-arm over whatever is chosen next.
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) forgetParkedSelection();
        repoll();
        setTimeout(repoll, 500);
    });
}

// Reveal the DYE2 UI: shift the profile nav right to make room, show the toggle +
// DYE button, wire listeners, load KV data, restore the saved P/F/R mode.
export async function enableDye2Ui() {
    dye2UiOn = true;
    const profileNav = document.getElementById('profile-fav-nav');
    const toggle = document.getElementById('dye-strip-toggle');
    const dyeBtn = document.getElementById('dye-open-btn');
    if (profileNav) { profileNav.classList.remove('left-[37.5px]'); profileNav.classList.add('left-[80px]'); }
    if (toggle) toggle.style.display = '';   // revert to class-defined flex
    if (dyeBtn) dyeBtn.style.display = '';
    syncStripBounds();
    observeControls();
    wireOnce();
    try { await loadDyeStripData(); } catch (e) { logger.error('dyeStrip load failed', e); }
    let saved = 'P';
    try { saved = localStorage.getItem(MODE_KEY) || 'P'; } catch (e) { /* private mode */ }
    setStripMode(saved);
}

// Restore the stock header: hide the toggle + DYE button + strip and move the
// profile nav back to its original position (byte-identical to stock Streamline).
export function disableDye2Ui() {
    dye2UiOn = false;
    applySeq++; // drop any arm still retrying in the background
    clearActiveItem();
    // DYE2 keeps recording against what it has armed whatever the header shows, so a
    // switched-off strip must release it, or later dial-in edits land on that recipe.
    if (dye2Armed || dye2RecordsDialIn) {
        dye2Armed = false;
        postSelection('', null).catch(() => {});
    }
    forgetParkedSelection(); // a trip made while DYE2 was on must not re-arm later
    const profileNav = document.getElementById('profile-fav-nav');
    const toggle = document.getElementById('dye-strip-toggle');
    const dyeBtn = document.getElementById('dye-open-btn');
    const dyeStrip = document.getElementById('dye-strip');
    if (toggle) toggle.style.display = 'none';
    if (dyeBtn) dyeBtn.style.display = 'none';
    if (dyeStrip) { dyeStrip.style.display = 'none'; dyeStrip.innerHTML = ''; }
    if (profileNav) {
        profileNav.style.display = '';
        profileNav.classList.remove('left-[80px]');
        profileNav.classList.add('left-[37.5px]');
    }
    clearStripBounds();
}

// ─── Workflow context hygiene ──────────────────────────────────────────────────
//
// Bean, roaster, batch, grinder, barista, drinker, basket and rpm are persistent
// description state: they survive shots and reloads, and Decaid copies them into every
// ShotRecord. Only the note is per shot (see workflow-note.js). The one time this file
// wipes them is when DYE2 itself is switched off in Settings, so the plugin's leftovers
// do not keep labelling shots with nobody left to change them.
//
// Left alone on purpose: targetDoseWeight / targetYield, which this dashboard owns, and
// `profile`, the espresso profile the machine actually runs (non-nullable in Decaid's
// Workflow model).
const DYE2_OWNED_CONTEXT = {
    beanBatchId: null, coffeeName: null, coffeeRoaster: null,
    grinderId: null, grinderModel: null, grinderSetting: null,
    baristaName: null, drinkerName: null,
    extras: { basketId: null, basketName: null, rpm: null, note: null, dye: null },
};

export async function clearDye2ContextOnDisable() {
    try {
        const live = await getWorkflow();
        const context = live?.context;
        if (!context) return false;
        const extras = context.extras || {};
        const set = Object.keys(DYE2_OWNED_CONTEXT).some(k => k !== 'extras' && context[k] != null)
            || Object.keys(DYE2_OWNED_CONTEXT.extras).some(k => extras[k] != null);
        if (!set) return false;
        await updateWorkflow({ context: DYE2_OWNED_CONTEXT }, 'dye.clearOnDisable');
        logger.info('dyeStrip: cleared DYE2 workflow context');
        return true;
    } catch (err) {
        logger.warn('Failed to clear DYE2 workflow context:', err);
        return false;
    }
}

// ─── Recipe / favourite auto-save (dial in on the fly from the dashboard) ───
//
// FALLBACK PATH. A DYE2 that declares a `selection` endpoint does all of this
// itself, from Decaid's workflowUpdated push, and then none of this runs (see
// pluginRecordsDialIn and the gate in handleWorkflowUpdatedForAutoSave). What
// follows is what an older DYE2, which cannot, still relies on.
//
// Applying a recipe or favourite only ever pushes its stored values onto the
// workflow -- tuning the dashboard afterward changed nothing about the item
// until the user went into DYE2's own editor (see editRecipe/editFavourite
// above). This closes that loop for whichever one is currently active: a
// dashboard edit is folded back into that item's own KV entry shortly after
// the user stops adjusting.
//
// Deliberately narrow, to keep the risk this creates (see the DYE2 KV bridge
// note in api.js -- no field-level API, no version/ETag) as small as
// possible:
//  - Never a blanket resync. Each updateWorkflow call's own payload says
//    which single field it touched (see recipeAutoSaveFields /
//    favouriteAutoSaveFields); only that field is patched. An edit with no
//    faithful field on the target -- milk auto-stop steam, calibrated
//    auto-steam (no recipe equivalent); anything beyond dose/drink/grind on a
//    favourite, whose snapshot has no brew-temp/steam/hot-water/flush field
//    at all -- yields no patch and touches nothing.
//  - Re-GETs the array immediately before every write rather than reusing
//    recipeCache/favCache, so the window for racing a concurrent DYE2 edit is
//    as small as this endpoint allows.
//  - Suppressed for the PUT that applies a recipe/favourite itself (see
//    withAutoSaveSuppressed) -- otherwise every apply would immediately
//    "save" the same values straight back.
//  - Drops out the moment the workflow's profile no longer matches the one
//    the item carried (the user moved on to a different profile some other
//    way), rather than silently mis-saving onto a stale item.
const AUTOSAVE_DEBOUNCE_MS = 1500;

// kind → which KV array it lives in, which sub-object on the item holds the
// dashboard-derived values, and how to turn one updateWorkflow call into a
// patch of those values.
const AUTOSAVE_TARGETS = {
    recipe: { key: RECIPES_KEY, field: 'dashboardVariables', patch: recipeAutoSaveFields },
    favourite: { key: AF_KEY, field: 'snapshot', patch: favouriteAutoSaveFields },
};

let activeItem = null; // { kind: 'recipe'|'favourite', id, profileId } from the apply that made it active
let autoSaveSuppressDepth = 0; // overlapping applies: suppression holds until the LAST one finishes
let autoSaveTimer = null;
let autoSavePending = {}; // accumulated patch, flushed on the timer

async function withAutoSaveSuppressed(fn) {
    // The apply's own workflowUpdated echo must never be auto-saved, and neither may an
    // echo that lands while an earlier apply is still unwinding: drop the previous active
    // item up front so nothing can be written onto it (activeItemId, the highlight, stays).
    // A debounced dial-in edit still waiting on the timer belongs to that previous item, so
    // write it there first rather than discarding it.
    flushPendingAutoSave();
    clearActiveItem();
    autoSaveSuppressDepth++;
    try { return await fn(); } finally { autoSaveSuppressDepth--; }
}

function flushPendingAutoSave() {
    if (autoSaveTimer === null || !activeItem) return;
    const { kind, id } = activeItem;
    const fields = autoSavePending;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    autoSavePending = {};
    if (Object.keys(fields).length === 0) return;
    saveItemFields(kind, id, fields).catch(e => logger.error(`dyeStrip: ${kind} auto-save failed`, e));
}

function forgetParkedSelection() {
    try { sessionStorage.removeItem(SELECTION_KEY); } catch (e) { /* private mode */ }
}

function clearActiveItem() {
    activeItem = null;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    autoSavePending = {};
}

// One updateWorkflow call → the dashboardVariables fields it can faithfully
// represent on a recipe, straight from that call's own payload (never the
// whole workflow) so a write this schema has no field for touches nothing.
export function recipeAutoSaveFields(dataToSend, workflow) {
    const patch = {};
    const ctx = dataToSend.context || {};
    if (ctx.targetDoseWeight != null) patch.dose = workflow?.context?.targetDoseWeight ?? ctx.targetDoseWeight;
    if (ctx.targetYield != null) patch.drink = workflow?.context?.targetYield ?? ctx.targetYield;
    if (ctx.grinderSetting != null) {
        const g = parseFloat(workflow?.context?.grinderSetting ?? ctx.grinderSetting);
        if (Number.isFinite(g)) patch.grind = g;
    }
    const temp = dataToSend.profile?.steps?.[0]?.temperature;
    if (temp != null) {
        const t = parseFloat(workflow?.profile?.steps?.[0]?.temperature ?? temp);
        if (Number.isFinite(t)) patch.brewC = t;
    }
    const steam = dataToSend.steamSettings || {};
    if (steam.duration != null) {
        patch.steamMode = 'time';
        patch.steamTimeS = workflow?.steamSettings?.duration ?? steam.duration;
    } else if (steam.flow != null) {
        patch.steamMode = 'flow';
        patch.steamFlowMls = workflow?.steamSettings?.flow ?? steam.flow;
    } // stopAtTemperature (milk) / auto-steam fields: no recipe equivalent -- skip.
    const hw = dataToSend.hotWaterData || {};
    if (hw.volume != null) {
        patch.hotWaterMode = 'vol';
        patch.hotWaterMl = workflow?.hotWaterData?.volume ?? hw.volume;
    } else if (hw.targetTemperature != null) {
        patch.hotWaterMode = 'temp';
        patch.hotWaterTempC = workflow?.hotWaterData?.targetTemperature ?? hw.targetTemperature;
    }
    const rinse = dataToSend.rinseData || {};
    if (rinse.duration != null) patch.flushS = workflow?.rinseData?.duration ?? rinse.duration;
    return patch;
}

// A favourite's snapshot only ever carries dose/drink/grindSetting as
// dashboard-derived values (confirmed against KV_CONTRACT.md's
// autoFavourites[] schema and auto-fav-edit.ts's own field list -- there is
// no brew-temp/steam/hot-water/flush editor for a favourite at all), so
// unlike a recipe, any edit outside those three produces no patch.
export function favouriteAutoSaveFields(dataToSend, workflow) {
    const patch = {};
    const ctx = dataToSend.context || {};
    if (ctx.targetDoseWeight != null) patch.dose = workflow?.context?.targetDoseWeight ?? ctx.targetDoseWeight;
    if (ctx.targetYield != null) patch.drink = workflow?.context?.targetYield ?? ctx.targetYield;
    if (ctx.grinderSetting != null) {
        const g = parseFloat(workflow?.context?.grinderSetting ?? ctx.grinderSetting);
        if (Number.isFinite(g)) patch.grindSetting = g;
    }
    return patch;
}

function handleWorkflowUpdatedForAutoSave(workflow, dataToSend) {
    // The installed DYE2 records dial-in itself: writing here too would race it on the
    // same array, and it is the one that owns the schema. (activeItem is never set in
    // that mode either — this is belt and braces, and documents why.)
    if (dye2Armed) return;
    if (autoSaveSuppressDepth > 0 || !activeItem || !isDye2Enabled()) return;
    if (profileDrifted(activeItem, workflow)) {
        clearActiveItem();
        return;
    }
    const target = AUTOSAVE_TARGETS[activeItem.kind];
    const patch = target.patch(dataToSend, workflow);
    if (Object.keys(patch).length === 0) return;
    Object.assign(autoSavePending, patch);

    clearTimeout(autoSaveTimer);
    const { kind, id } = activeItem;
    autoSaveTimer = setTimeout(() => {
        const fields = autoSavePending;
        autoSavePending = {};
        saveItemFields(kind, id, fields).catch(e => logger.error(`dyeStrip: ${kind} auto-save failed`, e));
    }, AUTOSAVE_DEBOUNCE_MS);
}

// Read-modify-write the whole array -- DYE2's own pattern, there is no
// field-level endpoint (see the api.js DYE2 KV bridge note) -- touching only
// the one item and only the given fields.
async function saveItemFields(kind, id, fields) {
    const target = AUTOSAVE_TARGETS[kind];
    const list = await getDye2KvArray(target.key);
    if (!list) return; // read failed -- never write back over data we could not see
    const idx = list.findIndex(r => r && String(r.id) === String(id));
    if (idx === -1) return; // deleted or renumbered since — nothing to save onto
    const next = list.slice();
    next[idx] = { ...next[idx], [target.field]: { ...(next[idx][target.field] || {}), ...fields } };
    await setDye2KvArray(target.key, next);
    if (kind === 'recipe') recipeCache = next; else favCache = next; // keep the strip's own cache in step
    logger.info(`dyeStrip: auto-saved to ${kind} ${id}: ${Object.keys(fields).join(', ')}`);
}

// saveItemFields' sibling for the item's own top-level fields: the strip-visibility flags live
// there, not inside snapshot / dashboardVariables. Same read-modify-write, same reason.
// Returns false when the item has gone from DYE2 since the strip read it.
async function saveItemTopLevel(kind, id, fields) {
    const key = kind === 'recipe' ? RECIPES_KEY : AF_KEY;
    const list = await getDye2KvArray(key);
    if (!list) throw new Error('DYE2 read failed'); // never write back over data we could not see
    const idx = list.findIndex(r => r && String(r.id) === String(id));
    if (idx === -1) return false;
    const next = list.slice();
    next[idx] = { ...next[idx], ...fields };
    await setDye2KvArray(key, next);
    if (kind === 'recipe') recipeCache = next; else favCache = next; // keep the strip's cache in step
    logger.info(`dyeStrip: cleared ${kind} ${id} off the strip`);
    return true;
}

// Strip DYE2's return param: one-shot, a reload must not replay it. A DYE2 that
// records for itself still sends it, for an older skin.
function stripReturnParam() {
    try {
        const url = new URL(window.location.href);
        if (!url.searchParams.has(RETURN_PARAM)) return;
        url.searchParams.delete(RETURN_PARAM);
        window.history.replaceState(window.history.state, '', url.toString());
    } catch (e) { /* non-critical */ }
}

// Settle the selection after a full-page trip to DYE2: re-arm the one parked by
// openPluginOverlay, or the one DYE2 says it applied, and fold what DYE2 wrote to
// the Workflow (dose/yield/grind) back into that item -- the dashboard does the
// same for its own edits, so the two entry points should agree. The parked key is
// read once and cleared; runs after the strip data is loaded, so an item deleted
// in DYE is dropped rather than highlighted.
async function restoreParkedSelection() {
    // DYE2 holds the selection itself: read it back for the highlight and write
    // nothing. It kept recording while this page was away, so there is no fold to do
    // and no param to trust — the KV key IS the answer (host.storage writes land in
    // the ordinary KV store, see dye2-plugin/docs/KV_CONTRACT.md).
    // A parked selection means the skin, not DYE2, was recording when the page left
    // (the arm post failed): the legacy restore below applies to it.
    let parkedRaw = null;
    try { parkedRaw = sessionStorage.getItem(SELECTION_KEY); } catch (e) { /* private mode */ }
    if (dye2RecordsDialIn && !parkedRaw) {
        stripReturnParam();
        await syncSelection(); // a tap during the GET wins
        if (currentMode !== 'P') renderStrip(currentMode);
        return;
    }
    let raw = null;
    try {
        raw = sessionStorage.getItem(SELECTION_KEY);
        sessionStorage.removeItem(SELECTION_KEY);
    } catch (e) { /* private mode */ }
    const ret = parseDyeReturn(window.location.search);
    stripReturnParam();
    if (!raw && !(ret.supported && ret.applied !== 'none')) return;
    // The strip is already tappable: a selection made during the GET below wins.
    const before = { item: activeItem, id: activeItemId };
    const workflow = (await getWorkflow()) || {};
    if (activeItem !== before.item || activeItemId !== before.id) return;
    const { item, fold } = resolveReturn({ parked: raw, ret, recipes: recipeCache, favs: favCache, workflow });
    if (!item) {
        if (ret.supported && ret.applied === 'other') { activeItem = null; activeItemId = null; }
        if (currentMode !== 'P') renderStrip(currentMode);
        return;
    }
    activeItem = item;
    activeItemId = item.id;
    if (currentMode !== 'P') renderStrip(currentMode);
    if (fold) await foldWorkflowIntoItem(item, workflow);
}

async function foldWorkflowIntoItem(item, workflow) {
    const target = AUTOSAVE_TARGETS[item.kind];
    const list = item.kind === 'recipe' ? recipeCache : favCache;
    const stored = list.find(x => x && String(x.id) === String(item.id));
    if (!stored || !workflow?.context) return;
    // Only the context: DYE2 edits dose, yield and grind, nothing else here.
    const patch = target.patch({ context: workflow.context }, workflow);
    const fields = changedFields(patch, stored[target.field]);
    if (Object.keys(fields).length === 0) return;
    await saveItemFields(item.kind, item.id, fields);
}

let workflowListenerRegistered = false;

// Show or hide the DYE2 header surfaces, but only on a real change -- see dye2UiOn. The flag
// is set here rather than left to the two functions below, so the decision does not depend on
// a side effect of what it calls; they set it too, for a caller that reaches them directly
// (window.applyDye2Enabled, from the Extensions toggle).
async function applyDye2Ui(on) {
    if (on === dye2UiOn) return;
    dye2UiOn = on;
    if (on) await enableDye2Ui(); else disableDye2Ui();
}

export async function initDyeStrip() {
    // Bridge for the Extensions-settings toggle to flip the header live (the header
    // stays in the DOM behind the settings overlay); if it isn't present the flag
    // still applies on the next dashboard load.
    window.applyDye2Enabled = (on) => { on ? enableDye2Ui() : disableDye2Ui(); };

    if (!workflowListenerRegistered) {
        workflowListenerRegistered = true;
        onWorkflowUpdated(handleWorkflowUpdatedForAutoSave);
    }

    // settingsReady resolves either way, so a Decaid that is not listening yet leaves the
    // flag unhydrated and hands the real value over later, through the retry ladder's restore
    // event (settingsSync's `boot`). Registered BEFORE the await: the on-time hydrate
    // dispatches the event while settingsReady is still pending.
    if (!restoreListenerRegistered) {
        restoreListenerRegistered = true;
        window.addEventListener(SETTINGS_RESTORED_EVENT, event => {
            if (!(ENABLED_KEY in (event.detail || {}))) return;
            applyDye2Ui(isDye2Enabled()).catch(e => logger.warn('dyeStrip: late enable failed', e));
        });
    }

    // This flag is synchronized, and reading it before settingsSync has hydrated answers with
    // the DEFAULT (off). Nothing repainted it afterwards, so a second client -- or any client
    // after an app update, since WebView storage does not survive one -- lost the DYE button
    // for the whole session while Settings showed the extension enabled (#168).
    await settingsReady;

    const on = isDye2Enabled();
    await applyDye2Ui(on);
    if (on) await restoreParkedSelection().catch(e => logger.warn('dyeStrip: could not restore selection', e));
}
