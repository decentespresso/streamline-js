// Single source of truth for every numeric bound a profile field can carry.
//
// This started as a local block inside profile_editor.js (see its own comment
// history: the grid and text tabs each used to keep their own copy of these
// numbers and drifted — weight/volume clamped at 1000 in one tab but 500 in
// the other, pressure at 12 vs 16). It moved into its own DOM-free module so
// the legacy-TCL profile importer (tcl-profile.js) can clamp incoming values
// against the exact same bounds the editor enforces, without a second copy
// that can drift the same way the grid/text tabs once did.
//
// Pure module: no DOM, storage, or network access, so it can be imported by
// both the editor (which touches the DOM) and node:test-run pure modules.

export const FIELD_LIMITS = {
    // 105 is the ceiling the TCL skin enforces (skin.tcl:1848). The grid's ±
    // buttons used to allow 110 while its numpad clamped to 105 — and the
    // numpad's own label read "0–110".
    temperature:   { min: 0, max: 105, step: 0.5 },
    flow:          { min: 0, max: 15,  step: 0.1 },
    // 0 bar is a valid "pump off" target, same as a 0 limiter — the grid used
    // to set min 1, making it impossible to reach from the − button.
    pressure:      { min: 0, max: 12,  step: 0.1 },
    flowLimit:     { min: 0, max: 8,   step: 0.1 }, // flow limit on a pressure step
    pressureLimit: { min: 0, max: 12,  step: 0.1 }, // pressure limit on a flow step
    weight:        { min: 0, max: 500, step: 1 },
    // 127 is the protocol ceiling, not a taste call: frame length goes over the
    // wire as F8_1_7 (de1app binary.tcl:1053), whose encoder clamps anything
    // above 127 — "Numbers over 127 are not allowed this F8_1_7; limiting at
    // 127" (binary.tcl:555-559). The old 300 let the grid show a duration the
    // machine could never run, with the truncation logged only firmware-side.
    seconds:       { min: 0, max: 127, step: 1 },
    volume:        { min: 0, max: 500, step: 1 },
};

// Rea API only supports pressure/flow exit types (profile.dart:129 ExitType
// enum). 'off' is a UI-only state that maps to `step.exit = null` on save.
// Weight-based stop is expressed via profile-level `target_weight`; time-based
// stop is expressed via step `seconds`.
export const EXIT_TYPES    = ['pressure', 'flow', 'off'];
export const EXIT_UNIT_MAP = { pressure: 'bar', flow: 'mL/s' };
export const EXIT_STEP_MAP = { pressure: 0.1, flow: 0.1 };
// Exit-condition ceilings are deliberately lower than the pump target ceilings
// above (flow tops out at 15 mL/s as a pump target but only 8 as an exit
// trigger) — these gate "stop the shot", not "run the pump at".
export const EXIT_MAX_MAP  = { pressure: 12,  flow: 8 };

// `range` is the softness of a limiter: 0 clamps hard at the limit, larger
// values taper into it (decaid's _applyLimiter). This is what a limiter gets
// when nothing in the profile already carries one to inherit a tolerance from.
export const DEFAULT_LIMITER_RANGE = 0.6;
