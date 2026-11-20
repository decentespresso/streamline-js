// Cup-warmer pure helpers (Bengle).
//
// Machine truth over REST is GET/PUT /machine/cupWarmer with a single
// `temperature` field — the SETPOINT in °C (0 = off). The field name reads
// like a measurement but it is a MatSetPoint read-back; there is no separate
// enable field on the wire, so `temperature > 0` IS the "on" state.
//
// Newer reaprime builds additionally report `currentTemperature` on the GET:
// the live mat temperature in °C (number), or null when the firmware has no
// valid reading. The field is ABSENT entirely on older builds — both null and
// absent must render as "no reading", never as fabricated data.
//
// The UI target floor is 30 °C while the wire accepts 0–80: 0 is reserved for
// "off", so a stored/typed target always normalizes into 30–80.
//
// The GET/PUT also carry the FIRMWARE-owned scheduled pre-warm — see the
// "Scheduled pre-warm" section below.
//
// This module is deliberately DOM-free so the node:test suite can import it
// (see test/cup-warmer.test.mjs and test/README.md).

// localStorage key — shared by the Settings page and the header quick-toggle.
// Renaming it silently orphans users' persisted targets. It holds the DESIRED
// target while the warmer is off, which the machine has nowhere to keep (its
// setpoint 0 *is* "off"). The pre-warm settings, by contrast, live in firmware
// flash and are NOT mirrored here — see below.
export const CUP_WARMER_TARGET_KEY = 'streamline.cupWarmerTarget';

/** True when a cup-warmer setpoint (°C) means "on" — 0 / null / absent = off. */
export function isCupWarmerOn(temperature) {
    return (temperature ?? 0) > 0;
}

/**
 * Stored target string → valid whole °C. In-range values (30–80) pass through;
 * anything else (unset, NaN, out of range) falls to the 70 °C default — the
 * read path snaps to the default rather than clamping.
 */
export function readCupWarmerTarget(stored) {
    const v = parseInt(stored || '70', 10);
    return (v >= 30 && v <= 80) ? v : 70;
}

/** User-entered target → whole °C clamped into 30–80 (NaN and 0 fall to 70). */
export function clampCupWarmerTarget(value) {
    return Math.max(30, Math.min(80, Math.round(value) || 70));
}

// ── Scheduled pre-warm (FIRMWARE-owned) ─────────────────────────────────────
//
// The mat takes tens of minutes to reach temperature — far longer than the
// boilers — so it has to start BEFORE a scheduled wake, not with it. The
// FIRMWARE owns that timing: with `MatPreheatEnable` set it runs the mat from
// `MatPreheatLeadMin` minutes before a wake window opens and holds it until the
// window closes, with no tablet connected and WITHOUT waking the machine (the
// boilers stay cold, only the 24 V mat runs). The skin therefore implements NO
// pre-warm timing of its own: it writes two settings and reads one status flag.
//
// On the wire (GET/PUT /machine/cupWarmer):
//
//   prewarmEnabled      bool | null   MatPreheatEnable      (RW, flash-persisted)
//   prewarmLeadMinutes  int  | null   MatPreheatLeadMin     (RW, flash-persisted, 0–120)
//   prewarmActive       bool | null   MatPreheatActive      (READ-ONLY)
//
// `prewarmActive` is the firmware saying "the SCHEDULE is driving the mat right
// now" — the answer to "why did the cup warmer come on by itself at 06:30?".
// Without surfacing it, a scheduled pre-warm reads as a bug.
//
// A `null` — or the field being ABSENT entirely, on an older reaprime — means
// the FIRMWARE DOES NOT HAVE THE REGISTERS (the bench machine's build 95 has
// none of them). That is "unavailable", NOT "off": the UI disables the controls
// and says so, rather than inventing a state (the `currentTemperature`
// precedent). Writes to unmapped firmware space are silently inert, which is
// why the PUT echoes back what the machine actually reports — we never claim a
// success we cannot verify.

/** Firmware default lead (`MatPreheatLeadMin`), and our fallback when it is unknown. */
export const PREWARM_DEFAULT_MINUTES = 30;
/** UI stepper floor. The wire accepts 0 ("no lead"), but 0 is not worth offering. */
export const PREWARM_MIN_MINUTES = 5;
/** Firmware + wire ceiling — `MatPreheatLeadMin` is clamped to 0–120. */
export const PREWARM_MAX_MINUTES = 120;

/** User-entered pre-warm minutes → clamped into 5–120 (NaN and 0 fall to 30). */
export function clampPrewarmMinutes(value) {
    return Math.max(
        PREWARM_MIN_MINUTES,
        Math.min(PREWARM_MAX_MINUTES, Math.round(value) || PREWARM_DEFAULT_MINUTES),
    );
}

/**
 * Machine snapshot → the pre-warm view state. The MACHINE is the only source of
 * truth here: these settings live in firmware flash, so there is nothing to
 * mirror locally and nothing to re-assert on connect.
 *
 *   supported    the firmware HAS the registers. `prewarmEnabled` comes back
 *                null (or absent) on firmware that does not — "unavailable",
 *                never silently "off".
 *   enabled      `MatPreheatEnable`. Forced false when unsupported; the controls
 *                are disabled in that case, so it is never read as machine truth.
 *   leadMinutes  `MatPreheatLeadMin` AS THE MACHINE REPORTS IT. The wire range is
 *                0–120 while the stepper floor is 5, so a machine-side 0 shows as
 *                0 rather than being snapped up to 5 — displaying a setting the
 *                machine does not hold would be inventing data. The firmware
 *                default stands in only when there is nothing to report.
 *   active       `MatPreheatActive` — the schedule is driving the mat right now.
 *                A null (unsupported) is never fabricated into a `true`.
 */
export function resolvePrewarm(state) {
    const enabled = state?.prewarmEnabled;
    const lead = state?.prewarmLeadMinutes;
    const supported = typeof enabled === 'boolean';
    const leadKnown = typeof lead === 'number' && Number.isFinite(lead)
        && lead >= 0 && lead <= PREWARM_MAX_MINUTES;
    return {
        supported,
        enabled: supported && enabled,
        leadMinutes: leadKnown ? Math.round(lead) : PREWARM_DEFAULT_MINUTES,
        active: state?.prewarmActive === true,
    };
}

/**
 * What the Cup Warmer page must paint: 'ready' (a snapshot exists — render it),
 * 'loading' (nothing fetched yet) or 'error' (a fetch failed and we hold NO
 * machine state at all).
 *
 * This exists because a failed fetch used to be papered over with a synthetic
 * `{ temperature: 0 }` snapshot, which is indistinguishable from a fully-loaded
 * machine whose warmer is off — and `resolvePrewarm()` cannot tell a field that
 * is absent because the FETCH failed from one that is absent because the
 * FIRMWARE lacks the register. So a disconnect, a 500 or a network blip printed
 * "this machine's firmware doesn't support pre-warm — update the firmware to use
 * it": a hardware-capability verdict manufactured out of data we never received.
 * A fetch that did not land is an ERROR, never machine truth.
 */
export function cupWarmerViewMode(state, loadFailed = false) {
    if (state !== null && state !== undefined) return 'ready';
    return loadFailed ? 'error' : 'loading';
}

/**
 * `GET /presence/schedules` → is there at least one ENABLED wake window?
 *
 * `enabled` defaults to true when omitted (REST spec), so only an explicit
 * `false` disables one. Returns `null` for a non-array — not fetched yet, or the
 * fetch failed. An UNKNOWN list is not an empty one, and callers must not warn
 * on data they do not have.
 */
export function hasEnabledWakeSchedule(schedules) {
    if (!Array.isArray(schedules)) return null;
    return schedules.some((s) => s && s.enabled !== false);
}

/**
 * Why an ENABLED pre-warm will silently do NOTHING.
 *
 * The firmware gate is `MatPreheatEnable && MatSetPoint > 0 && (inside a wake
 * window, or within the lead of one opening)`. So a pre-warm switched on with
 * the warmer itself off, or with no wake window configured, is a dead setting
 * the user gets no feedback about — the mat simply never comes on. Both are
 * real, reachable states of the UI, so we name them.
 *
 * Returns warning CODES (this module stays DOM-free; the settings page maps them
 * to copy). An unknown schedule list yields no schedule warning — never cry wolf.
 */
export function prewarmWarnings({ prewarm, temperature, schedules }) {
    const warnings = [];
    if (!prewarm?.supported || !prewarm.enabled) return warnings;
    if (!isCupWarmerOn(temperature)) warnings.push('noSetpoint');
    if (hasEnabledWakeSchedule(schedules) === false) warnings.push('noSchedule');
    return warnings;
}

/**
 * The parts of the pre-warm state that change the page's SHAPE — blocks that
 * appear and disappear — as opposed to the lead value, which is merely a number
 * inside an input.
 *
 * The cup-warmer page polls every ~5 s. It re-renders when this signature
 * changes (so a `MatPreheatActive` flip repaints the page) and patches text
 * nodes otherwise, so that an unrelated tick can never clobber a stepper the
 * user is mid-edit in. `leadMinutes` is deliberately NOT in the signature.
 */
export function prewarmShapeSignature(prewarm) {
    return `${prewarm.supported}|${prewarm.enabled}|${prewarm.active}`;
}

/**
 * GET response `currentTemperature` (number | null | absent) → display string
 * with one decimal ("36.5"), or null meaning "no reading" (render a
 * placeholder, never fake data). Non-numbers and non-finite values are
 * defensively treated as "no reading".
 */
export function formatCurrentMatTemp(currentTemperature) {
    return (typeof currentTemperature === 'number' && Number.isFinite(currentTemperature))
        ? currentTemperature.toFixed(1)
        : null;
}

// ── Shared cup-warmer snapshot (the ONE app-side copy of machine state) ──────
// Historically three copies of "is the warmer on" existed: the machine, the
// Settings page's fetch-once cache, and the header quick-toggle's boot-seeded
// boolean — which is how the bench got a cup-warmer page frozen at a
// 20-minute-old temperature (audit I1, bench checklist 2b). ES modules are
// singletons and the router innerHTML-swaps pages without reloading modules,
// so this store IS shared between src/modules/app.js (header toggle) and
// src/settings/settings.js (Cup Warmer page): both render from it, every
// fetch/PUT result folds into it, and machine (re)connects invalidate it.
//
// Snapshot shape mirrors GET /machine/cupWarmer — { temperature,
// currentTemperature?, prewarmEnabled?, prewarmLeadMinutes?, prewarmActive? } —
// or null meaning "not loaded / invalidated, refetch before trusting".
// Deliberately DOM-free so node:test covers it (test/cup-warmer.test.mjs).
let cupWarmerState = null;
const cupWarmerListeners = new Set();

/** Current snapshot ({ temperature, currentTemperature? }) or null when unloaded/stale. */
export function getCupWarmerState() {
    return cupWarmerState;
}

/** Replace the snapshot and notify subscribers (null = invalidate). */
export function setCupWarmerState(next) {
    cupWarmerState = next;
    for (const listener of cupWarmerListeners) {
        try { listener(cupWarmerState); } catch (e) { /* one bad subscriber must not starve the rest */ }
    }
}

/** Merge fields into the snapshot — e.g. a setpoint PUT keeps the last currentTemperature visible. */
export function patchCupWarmerState(patch) {
    setCupWarmerState({ ...(cupWarmerState || {}), ...patch });
}

/** Drop the snapshot on machine (re)connect so every reader refetches. */
export function invalidateCupWarmerState() {
    setCupWarmerState(null);
}

/** Subscribe to snapshot changes; returns an unsubscribe function. */
export function onCupWarmerStateChange(listener) {
    cupWarmerListeners.add(listener);
    return () => cupWarmerListeners.delete(listener);
}
