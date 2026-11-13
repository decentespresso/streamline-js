// Which stored profile record is "the one the machine currently has loaded"?
//
// The main-page tiles (dose, yield, grind, brew temp) save the user's number
// onto that record's metadata, so an unresolved answer means the edit is
// silently dropped and a wrong answer means it lands on someone else's profile.
// Rea's workflow document hands us only the profile *title*, so title is the
// only handle there is.
//
// Ties: prefer a non-default record. Editing a bundled profile forks it under
// the same title, and an edit belongs to the fork the user is actually running.
//
// A superseded version is kept as a 'hidden' record (an edit retires the old id
// but keeps it for revert history), and Decaid lists by updatedAt desc, so after
// the retire the dead record can sort first. Visible records therefore rank above
// hidden ones before the non-default preference applies.
//
// `translate` covers the case where the title came off the screen
// (#profile-name renders the translated title) rather than out of the workflow.
export function resolveProfileKeyByTitle(profiles, title, translate = t => t) {
    const wanted = String(title ?? '').trim().toLowerCase();
    if (!wanted || !profiles) return null;
    const matches = Object.keys(profiles).filter(key => {
        const stored = profiles[key]?.profile?.title;
        if (!stored) return false;
        return stored.trim().toLowerCase() === wanted
            || String(translate(stored) ?? '').trim().toLowerCase() === wanted;
    });
    const rank = key => (profiles[key].visibility === 'hidden' ? 2 : 0) + (profiles[key].isDefault ? 1 : 0);
    let best = null;
    for (const key of matches) if (best === null || rank(key) < rank(best)) best = key;
    return best;
}
