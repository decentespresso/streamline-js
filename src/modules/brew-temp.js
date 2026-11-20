// Brew temperature that keeps a profile's shape. DOM-free so node:test can import it.
//
// Setting the Brew tile to N moves the whole curve: the first step goes to N and
// every other step moves by the same amount, so 94 -> 90 -> 88 set to 92 becomes
// 92 -> 88 -> 86. A profile with one temperature is unchanged by this.

const round = n => Math.round(n * 100) / 100;

// `baseTemps` are the profile's own step temperatures (the saved profile, not a
// copy that may already have been flattened). -> the shifted list, or null when
// the base has no usable first step to measure the offsets from.
export function shiftedTemperatures(baseTemps, first) {
    if (!Array.isArray(baseTemps) || baseTemps.length === 0) return null;
    const target = Number(first);
    const origin = baseTemps[0];
    if (!Number.isFinite(target) || typeof origin !== 'number' || !Number.isFinite(origin)) return null;
    const shift = target - origin;
    return baseTemps.map(t => (typeof t === 'number' && Number.isFinite(t) ? round(t + shift) : round(target)));
}

// A COPY of `profile` with its first step at `first` and the others kept relative
// to it. Without a usable first step it falls back to one temperature for every
// step, as before. Never mutates `profile`.
export function profileAtBrewTemp(profile, first) {
    if (!Array.isArray(profile?.steps)) return profile;
    const target = Number(first);
    if (!Number.isFinite(target)) return profile;
    const temps = shiftedTemperatures(profile.steps.map(step => step.temperature), target)
        || profile.steps.map(() => target);
    return { ...profile, steps: profile.steps.map((step, i) => ({ ...step, temperature: temps[i] })) };
}

// ── Partial `profile` payloads for PUT /workflow ────────────────────────────
// Decaid deep-merges the PUT body into its current workflow (objects merge, lists
// are replaced wholesale), and its GET only advances once the BLE write completes.
// So a debounced read-modify-write of the whole profile can overwrite a change made
// moments earlier. Sending only the field being changed keeps overlapping writes
// from reverting each other.

// -> { target_weight } or null when the weight is unusable.
export function targetWeightProfilePatch(targetWeight) {
    const weight = Number(targetWeight);
    return Number.isFinite(weight) && weight > 0 ? { target_weight: weight } : null;
}

// -> { steps } with the first step at `first` and the rest kept relative to it, or
// null when the live profile has no steps. `liveProfile` is the workflow's profile;
// `savedProfile` is the stored record, used for the step distances only when it is
// the same profile (same title and step count). Never mutates its inputs and never
// carries any other profile field (notably not target_weight).
export function brewTempProfilePatch(liveProfile, savedProfile, first) {
    const live = liveProfile?.steps;
    if (!Array.isArray(live) || live.length === 0) return null;
    const target = Number(first);
    if (!Number.isFinite(target)) return null;
    const shapeOf = savedProfile && Array.isArray(savedProfile.steps)
        && savedProfile.steps.length === live.length && savedProfile.title === liveProfile.title
        ? savedProfile.steps : live;
    const temps = shiftedTemperatures(shapeOf.map(step => step.temperature), target);
    return { steps: live.map((step, i) => ({ ...step, temperature: temps ? temps[i] : target })) };
}
