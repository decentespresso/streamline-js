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
// Only the values the main-page tiles actually show are compared. Diffing whole
// documents would fire on profile internals the sidebar never renders.

export function workflowTileValues(workflow) {
    if (!workflow) return {};
    const context = workflow.context;
    return {
        profileTitle: workflow.profile?.title,
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
