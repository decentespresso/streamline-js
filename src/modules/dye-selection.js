// Which DYE strip recipe / favourite is being dialled in, and whether that
// selection is still true. DOM-free so node:test can import it.
//
// The selection lives in module memory in dyeStrip.js, but on Decaid the DYE
// button navigates the whole page away (skin and plugin differ in origin), so a
// return from DYE reloads the skin. The selection is parked in sessionStorage
// across that trip and re-validated here on the way back.

export const SELECTION_KEY = 'streamline.dyeSelection';

// Decaid's workflow.profile carries no `id` (confirmed on 0.8.6+2801: a PUT's
// profile.id is dropped, and the next GET has none either), so the id check in
// profileDrifted never actually fires and the profile-drift guard silently never
// fired either -- see decentespresso/streamline-js#90. This fingerprints the
// fields a real profile switch changes and a recipe's own brew-temp auto-save
// does not: `updateTemperatureValue()` PUTs the same profile back with only
// `steps[*].temperature` edited, so temperature is stripped before hashing --
// otherwise every brew-temp tweak would look like switching to a new profile
// and immediately clear the item auto-save is running for. The same goes for
// target_weight / target_volume: the dashboard folds the yield into them, so a
// yield change is dial-in, not a new profile (#147).
// JSON.stringify calls the replacer again on whatever object IT returns, not the original,
// so returning a key-sorted copy at every level makes the whole tree order-independent --
// two profiles equal in content but not in key order (dye2#43: Decent Sync's jsonb storage
// reorders keys, shorter first; Decaid's own toJson order is whatever Workflow wrote) now
// fingerprint the same.
function sortKeysReplacer(_key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const sorted = {};
        for (const k of Object.keys(value).sort()) sorted[k] = value[k];
        return sorted;
    }
    return value;
}

export function profileFingerprint(profile) {
    if (!profile) return null;
    const steps = Array.isArray(profile.steps)
        ? profile.steps.map(({ temperature, limiter, ...rest }) => ({
            ...rest,
            // {value:0}, null and absent all mean "no limiter"; Decaid reports them interchangeably.
            limiter: (limiter && Number(limiter.value) !== 0) ? limiter : null,
        }))
        : profile.steps;
    return JSON.stringify({
        title: profile.title,
        tank_temperature: profile.tank_temperature,
        steps,
    }, sortKeysReplacer);
}

/** Has the live workflow's profile moved away from the one `item` was armed on? */
export function profileDrifted(item, workflow) {
    if (!item) return false;
    const profileId = workflow?.profile?.id;
    const fingerprint = profileFingerprint(workflow?.profile);
    const idDrifted = !!(item.profileId && profileId && profileId !== item.profileId);
    const fingerprintDrifted = !!(item.profileFingerprint && fingerprint && fingerprint !== item.profileFingerprint);
    return idDrifted || fingerprintDrifted;
}

/** The slice of the active item worth carrying across a reload. */
export function serializeSelection(item) {
    if (!item || item.id == null || (item.kind !== 'recipe' && item.kind !== 'favourite')) return null;
    return JSON.stringify({
        kind: item.kind,
        id: item.id,
        profileId: item.profileId ?? null,
        profileFingerprint: item.profileFingerprint ?? null,
    });
}

/**
 * Decide whether a parked selection survives. Returns the item to re-arm, or
 * null to discard: unparseable, the recipe/favourite is gone, or the workflow's
 * profile no longer matches (the barista changed profile inside DYE).
 */
export function restoreSelection(raw, { recipes, favs, workflow }) {
    let saved;
    try { saved = JSON.parse(raw); } catch { return null; }
    if (!saved || saved.id == null) return null;
    const list = saved.kind === 'recipe' ? recipes : saved.kind === 'favourite' ? favs : null;
    if (!Array.isArray(list)) return null;
    if (!list.some(x => x && String(x.id) === String(saved.id))) return null;
    if (profileDrifted(saved, workflow)) return null;
    return {
        kind: saved.kind,
        id: saved.id,
        profileId: saved.profileId ?? null,
        profileFingerprint: saved.profileFingerprint ?? null,
    };
}

// ── Return from DYE2 ────────────────────────────────────────────────────────
// A DYE2 that knows about this skin appends `dyeApplied` to its return URL:
//   ''              nothing was applied inside DYE2
//   'recipe:<id>' / 'favourite:<id>'   the item that was
//   'other'         something with no stable id (a recent shot combination)
// Its mere presence also tells the skin the DYE2 on the other end can be trusted
// about what it applied; an older DYE2 sends nothing, and the skin must then not
// write anything back to the parked item.
export const RETURN_PARAM = 'dyeApplied';

export function parseDyeReturn(search) {
    let params;
    try { params = new URLSearchParams(search); } catch { return { supported: false }; }
    if (!params.has(RETURN_PARAM)) return { supported: false };
    const v = params.get(RETURN_PARAM) || '';
    if (v === '') return { supported: true, applied: 'none' };
    if (v === 'other') return { supported: true, applied: 'other' };
    const i = v.indexOf(':');
    const kind = v.slice(0, i);
    const id = v.slice(i + 1);
    if (i > 0 && id && (kind === 'recipe' || kind === 'favourite')) {
        return { supported: true, applied: 'item', kind, id };
    }
    return { supported: true, applied: 'other' };
}

/**
 * Decide what the strip should hold after a return from DYE2.
 * Returns { item, fold }: item is the selection to arm (or null for none) and
 * fold says the live workflow's dose/yield/grind belong in that item. Fold is
 * only ever true when DYE2 vouched for what it applied.
 */
export function resolveReturn({ parked, ret, recipes, favs, workflow }) {
    const lists = { recipe: recipes, favourite: favs };
    if (ret.supported && ret.applied === 'other') return { item: null, fold: false };
    if (ret.supported && ret.applied === 'item') {
        const list = lists[ret.kind];
        const found = Array.isArray(list) ? list.find(x => x && String(x.id) === ret.id) : null;
        if (!found) return { item: null, fold: false };
        return {
            item: {
                kind: ret.kind,
                id: found.id,
                profileId: found.profileId ?? found.workflow?.profile?.id ?? found.snapshot?.profileId ?? null,
                profileFingerprint: profileFingerprint(workflow?.profile),
            },
            fold: true,
        };
    }
    const item = parked ? restoreSelection(parked, { recipes, favs, workflow }) : null;
    return { item, fold: !!item && ret.supported };
}

/** The entries of `patch` that differ from what `stored` already holds. */
export function changedFields(patch, stored) {
    const out = {};
    for (const [k, v] of Object.entries(patch || {})) {
        const cur = stored?.[k];
        const same = cur === v || (cur != null && v != null && Number.isFinite(Number(cur)) && Number(cur) === Number(v));
        if (!same) out[k] = v;
    }
    return out;
}

// ── DYE2 records its own dial-in ────────────────────────────────────────────
// A DYE2 that declares a `selection` http endpoint holds `events.workflow` and
// records dashboard dial-in edits onto the armed item itself, off Decaid's
// workflowUpdated push. Against that plugin the skin is read-only again (see the
// single-writer rule in dye2-plugin/docs/KV_CONTRACT.md): it POSTs what it
// applied and writes nothing. An older DYE2 declares no such endpoint, and the
// auto-save in dyeStrip.js stays the only way its items follow the dashboard.
// The endpoint list comes from GET /api/v1/plugins, which the strip already reads.
export function pluginRecordsDialIn(plugins, pluginId = 'dye2.reaplugin') {
    return pluginHasEndpoint(plugins, 'selection', pluginId);
}

/**
 * Does the installed plugin serve this http endpoint?
 *
 * DYE2's pages ARE api endpoints (Decaid plugins_handler: an endpoint the
 * manifest does not declare answers 404 `endpoint <id> not available`), so a
 * menu item that opens one the installed build has never heard of lands the
 * barista on that error inside the overlay. The manifest's endpoint list comes
 * with GET /api/v1/plugins, which the strip already reads.
 */
export function pluginHasEndpoint(plugins, endpoint, pluginId = 'dye2.reaplugin') {
    const plugin = Array.isArray(plugins) ? plugins.find(p => p?.id === pluginId) : null;
    if (!plugin?.loaded || !Array.isArray(plugin.api)) return false;
    return plugin.api.some(e => e?.type === 'http' && e?.id === endpoint);
}

/**
 * Which cell to highlight after a trip to DYE2, from the selection DYE2 itself
 * persisted (KV key `selection`). Returns the cached item's own id — compared
 * strictly against it when rendering — or null when that item is gone. Only the
 * highlight: DYE2 owns the arming and the profile-drift check now.
 */
export function armedSelectionId(sel, { recipes, favs }) {
    if (!sel || sel.id == null) return null;
    const list = sel.kind === 'recipe' ? recipes : sel.kind === 'favourite' ? favs : null;
    if (!Array.isArray(list)) return null;
    const found = list.find(x => x && String(x.id) === String(sel.id));
    return found ? found.id : null;
}

/**
 * The steam temperature the selected DYE2 recipe wants, or null. Used when steam
 * is re-armed from off so the recipe's temperature wins over the remembered one.
 * Below 135C the machine treats the target as off, so such values are ignored.
 */
export function selectedRecipeSteamTemp(sel, recipes) {
    if (!sel || sel.kind !== 'recipe' || sel.id == null || !Array.isArray(recipes)) return null;
    const recipe = recipes.find(r => r && String(r.id) === String(sel.id));
    const t = Number(recipe?.dashboardVariables?.steamTempC);
    return Number.isFinite(t) && t >= 135 ? Math.round(t) : null;
}

/**
 * The R strip as fixed positional slots, like the profile strip. DYE2 recipe ids are
 * opaque; a recipe's position is its `stripSlot` (1..5, KV_CONTRACT `recipes[]`), and a
 * row whose stripSlot is null/absent/out of range is saved in the library only and stays
 * off the strip. A cleared recipe (showOnStreamlineDashboard:false) leaves a blank in
 * place; nothing shifts left. The first row for a slot wins. There is no "strays fill
 * the blanks" step in this mode: DYE2 guarantees one recipe per slot, and a null slot
 * means "not on the strip", so back-filling would put library rows on it.
 *
 * A cell a clear emptied is not a free blank even where back-filling does apply: the
 * cleared button must stay empty, not be handed to the next recipe in line.
 *
 * Compat: a DYE2 older than stripSlot writes no `stripSlot` key on any row and uses
 * ids '1'..'5' as the slots. When no row carries the key at all, the old id-based
 * placement (strays fill remaining blanks) applies, so a mid-upgrade tablet is not blank.
 * (Key absent, not "no numeric value": a new DYE2 with every slot cleared writes nulls and
 * must show five blanks, not fall back to ids.)
 * Returns [{ slot: '1'..'5', recipe: obj|null }].
 */
export function recipeStripCells(recipes, count = 5) {
    const cells = Array.from({ length: count }, (_, i) => ({ slot: String(i + 1), recipe: null }));
    const rows = (Array.isArray(recipes) ? recipes : []).filter(r => r && typeof r === 'object');
    const visible = rows.filter(r => r.showOnStreamlineDashboard !== false);
    const legacy = !rows.some(r => r.stripSlot !== undefined);
    // Legacy placement is by id, so that is where a cleared row's cell comes from. Modern
    // placement back-fills nothing, so it needs no reservation.
    const idCell = recipe => {
        const n = parseInt(recipe.id, 10);
        return String(recipe.id) === String(n) && n >= 1 && n <= count ? n - 1 : null;
    };
    const clearedCells = new Set(legacy
        ? rows.filter(r => r.showOnStreamlineDashboard === false).map(idCell).filter(i => i !== null)
        : []);
    const strays = [];
    for (const recipe of visible) {
        let cell;
        if (legacy) {
            const n = parseInt(recipe.id, 10);
            cell = String(recipe.id) === String(n) ? cells[n - 1] : undefined;
            if (!cell) { strays.push(recipe); continue; }
        } else {
            const n = typeof recipe.stripSlot === 'number' ? recipe.stripSlot : NaN;
            cell = Number.isInteger(n) ? cells[n - 1] : undefined;
        }
        if (cell && !cell.recipe) cell.recipe = recipe;
    }
    for (const recipe of strays) {
        const blank = cells.find((c, i) => !c.recipe && !clearedCells.has(i));
        if (!blank) break;
        blank.recipe = recipe;
    }
    return cells;
}

/**
 * Does the mirrored DYE2 selection say the highlighted recipe has drifted from its
 * stored values (`modified: true`, dye2#36)? Only a recipe can be modified -- a
 * favourite or recent that drifts is deselected by DYE2 -- and only while the
 * selection still names a row we hold.
 */
export function selectionModified(sel, { recipes }) {
    if (!sel || sel.kind !== 'recipe' || sel.modified !== true) return false;
    return armedSelectionId(sel, { recipes, favs: [] }) != null;
}

/**
 * What a recipe cell shows: highlighted or not, and the `*` marker -- on the highlighted
 * cell only, when modified.
 */
export function recipeCellState(recipe, activeId, modified) {
    const active = recipe?.id != null && recipe.id === activeId;
    return { active, marker: active && modified ? '*' : '' };
}

/** Favourites in strip order: favSlot first, then capturedAt. Hidden ones included. */
export function sortFavs(favs) {
    return (Array.isArray(favs) ? favs : [])
        .filter(f => f && typeof f === 'object')
        .sort((a, b) => {
            const sa = a.favSlot ?? Infinity, sb = b.favSlot ?? Infinity;
            if (sa !== sb) return sa - sb;
            return String(a.capturedAt || '').localeCompare(String(b.capturedAt || ''));
        });
}

/**
 * The F strip as fixed positions, placed by `favSlot` the way recipeStripCells places by
 * `stripSlot`: a favourite goes in cell `favSlot` (1..max), a slot nobody holds is blank, and
 * a hidden row (alwaysOnDashboard:false) leaves its cell blank. Nothing shifts. A row with no
 * slot or one outside 1..max does not appear. If two rows share a slot (DYE2 keeps them
 * exclusive, but older data may not) a shown row beats a hidden one, otherwise the first in
 * sort order wins.
 *
 * Compat: if NO row carries a usable favSlot (an older DYE2), fall back to sorting and taking
 * the first `max`, with a hidden one left as a gap.
 * Returns [{ fav: visible fav | null, hidden: the hidden fav of a gap | null }].
 */
export function favStripCells(favs, max = 4) {
    const sorted = sortFavs(favs);
    const slotOf = f => (Number.isInteger(f.favSlot) && f.favSlot >= 1 && f.favSlot <= max ? f.favSlot : null);
    const cellOf = f => (f.alwaysOnDashboard === false ? { fav: null, hidden: f } : { fav: f, hidden: null });
    if (!sorted.some(f => slotOf(f) != null)) return sorted.slice(0, max).map(cellOf);
    const cells = Array.from({ length: max }, () => ({ fav: null, hidden: null }));
    for (const f of sorted) {
        const n = slotOf(f);
        if (n == null) continue;
        const cur = cells[n - 1];
        if (cur.fav || (cur.hidden && f.alwaysOnDashboard === false)) continue;
        cells[n - 1] = cellOf(f);
    }
    return cells;
}

// A failed DYE2 KV read (getDye2KvArray -> null) or plugin-list read must not
// replace what the strip already shows: a transient error would otherwise empty
// the F/R cells and flip dial-in recording back to the legacy auto-save.
// `null`/non-array means "read failed"; a real [] is a genuinely empty list.
export function keepPreviousOnFailure(previous, next) {
    return Array.isArray(next) ? next : previous;
}

// `plugins` is null when the plugin list could not be read; the previous
// capability then stands. Otherwise it is re-derived from the fresh list.
export function resolveRecordsDialIn(previous, plugins, derive) {
    return plugins == null ? previous : derive(plugins);
}

/**
 * The patch that claims, or releases, the recipe being dialled in.
 *
 * The recipe rides in the workflow itself (`context.extras.dye.recipeId`,
 * dye2#36) and DYE2 derives its selection from it -- there is no POST for this.
 * The governing rule is that **a recipe's identity is its profile**, which
 * produces the whole table:
 *
 *   apply a recipe                  -> set
 *   apply a favourite or a recent   -> null
 *   profile change, from any source -> null
 *   skin tile edit (dose/yield/grind) -> leave alone; that is the `*`
 *   machine-originated change       -> leave alone
 *
 * A write that forgets to null it leaves a stale recipe highlighted and records
 * the next shot's dial-in onto the wrong recipe -- #153/#155 in a new field.
 *
 * Returns only the delta: PUT /workflow deep-merges, so the other `extras` keys
 * (rpm, note) survive without being re-sent. Mirrors the plugin's own
 * setRecipeId, including the `v: 1` tag.
 */
export function recipeIdPatch(id) {
    return { extras: { dye: { v: 1, recipeId: id == null ? null : String(id) } } };
}

/**
 * The profile a workflow patch may carry, or null when there is none to send.
 *
 * PUT /workflow deep-merges (Decaid json_utils.deepMergeJson), so a profile
 * object without steps does not replace the loaded profile -- it *renames* it.
 * The machine keeps running the previous curve, the dashboard shows the item's
 * name over it, and the shot record is saved under that name with the other
 * profile's steps, notes and author. DYE2 stores exactly such stubs: a thin
 * `{ id, title }`, an older row's `{ id, title, steps: [] }`, and sometimes a
 * bare `{}`. A profile that cannot be resolved to its full record must drop out
 * of the patch entirely instead.
 */
export function profilePatchWithSteps(profile) {
    const steps = profile && profile.steps;
    return Array.isArray(steps) && steps.length ? profile : null;
}
