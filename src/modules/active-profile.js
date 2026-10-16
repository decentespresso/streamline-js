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
    return matches.find(key => !profiles[key].isDefault) ?? matches[0] ?? null;
}
