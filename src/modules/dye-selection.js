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
export function profileFingerprint(profile) {
    if (!profile) return null;
    const steps = Array.isArray(profile.steps)
        ? profile.steps.map(({ temperature, ...rest }) => rest)
        : profile.steps;
    return JSON.stringify({
        title: profile.title,
        tank_temperature: profile.tank_temperature,
        steps,
    });
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
    const plugin = Array.isArray(plugins) ? plugins.find(p => p?.id === pluginId) : null;
    if (!plugin?.loaded || !Array.isArray(plugin.api)) return false;
    return plugin.api.some(e => e?.type === 'http' && e?.id === 'selection');
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
