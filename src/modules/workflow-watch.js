// workflow-watch.js — pure helpers for noticing that the workflow changed
// underneath us.
//
// Decaid publishes no workflow WebSocket (13 ws/v1 endpoints, none of them the
// workflow) and GET /api/v1/workflow carries no revision or ETag, so a change
// made anywhere else — Decaid's own UI, another skin, a DYE2 page — is invisible
// to the dashboard until something re-reads the document. app.js re-reads it on
// focus/visibility regain and on a slow timer; these functions decide whether
// that re-read is worth repainting for.
//
import { profileFingerprint } from './dye-selection.js';

// A tile press is pushed to Decaid after this debounce (ui.js imports it).
// A burst still costs one PUT, the press-and-hold repeat included, because each
// press restarts the wait: the number only buys how long a settled value waits.
// It was 1000 ms, which Decent Sync paid for twice -- once on the machine that
// set the dose, once reading it back on the other -- for nothing Decaid or the
// plugins need (see issue #174).
export const API_DEBOUNCE_MS = 300;
// A press this recent has not reached Decaid yet: repainting from a read now
// would reassign the variable the pending push is about to send. Derived from
// the debounce so the two cannot drift apart.
export const WORKFLOW_EDIT_GUARD_MS = API_DEBOUNCE_MS + 100;

// Only the values the main-page tiles actually show are compared. Diffing whole
// documents would fire on profile internals the sidebar never renders.

export function workflowTileValues(workflow) {
    if (!workflow) return {};
    const context = workflow.context;
    return {
        profileTitle: workflow.profile?.title,
        // Same title, different steps (an edit/save) must still reach the chart's
        // step tracking. Brew temperature and limiter-noise are excluded by the
        // fingerprint, so a temp tile edit is not a profile change.
        profileSig: profileFingerprint(workflow.profile) ?? undefined,
        grind: context?.grinderSetting ?? workflow.grinderData?.setting,
        dose: context?.targetDoseWeight ?? workflow.doseData?.doseIn,
        yield: context?.targetYield ?? workflow.doseData?.drinkOut,
        brewTemp: workflow.profile?.steps?.[0]?.temperature,
        steamDuration: workflow.steamSettings?.duration,
        steamFlow: workflow.steamSettings?.flow,
        milkStop: workflow.steamSettings?.stopAtTemperature,
        hotWaterVolume: workflow.hotWaterData?.volume,
        hotWaterTemp: workflow.hotWaterData?.targetTemperature,
        flush: workflow.rinseData?.duration,
    };
}

// The subset that moved, as {key: newValue}. A field that vanished from the
// document is not a change worth painting — there is nothing to paint — and an
// unknown previous state (first read) means everything is "unchanged", so the
// first poll after boot never repaints what boot already painted.
export function changedTileValues(previous, next) {
    if (!previous) return {};
    const changed = {};
    for (const [key, value] of Object.entries(next)) {
        if (value == null) continue;
        // Grind is a string in the workflow and writers format it differently
        // ("21" from one client, "21.00" from setTargetGrind), so compare
        // numerically whenever both sides are numbers in any spelling. Titles and
        // other text fall through to plain equality.
        const before = previous[key];
        const numeric = [before, value].every(
            v => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)));
        const same = numeric ? Number(before) === Number(value) : before === value;
        if (!same) changed[key] = value;
    }
    return changed;
}

// Tiles repainted even when the baseline says they are unchanged. After a plugin
// said it wrote the workflow, our baseline may already hold the plugin's value (a
// tile edit or an earlier poll read it) while the tile still shows something
// else, so a diff alone would never repaint. profileTitle/profileSig are not here: a
// profile change runs the heavier loadInitialData path, which a force must not trigger.
export const FORCED_KEYS = ['dose', 'yield', 'grind', 'brewTemp',
    'steamDuration', 'steamFlow', 'milkStop', 'hotWaterVolume', 'hotWaterTemp', 'flush'];

// What to paint: the diff, plus with `force` every present forced key of `next`.
export function tilesToPaint(previous, next, { force = false } = {}) {
    const changed = changedTileValues(previous, next);
    if (!force) return changed;
    for (const key of FORCED_KEYS) {
        if (next?.[key] != null) changed[key] = next[key];
    }
    return changed;
}

// Does this diff mean the profile itself changed (title or steps)? That needs the
// heavier loadInitialData path (chart step tracking, active-profile record,
// favourite highlight), not just a tile repaint.
export function profileChanged(changed) {
    return !!changed && ('profileTitle' in changed || 'profileSig' in changed);
}
