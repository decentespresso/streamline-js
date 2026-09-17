import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    STEAM_FLOW_PRESETS_BY_MODEL,
    MILK_STOP_PRESETS,
    resolveSteamFlowPresetsForModel,
    resolveSteamStopMode,
    MILK_PROBE_ABSENT_AFTER_MS,
    resolveMilkProbePresence,
    selectMilkProbeSensorId,
    applyMilkProbeGate,
    resolveSteamTileMode,
    milkTelemetryText,
    milkTelemetryValue,
    steamFlowHighlightIndex,
    STEAM_SYNC_RETRY_LIMIT,
    STEAM_SYNC_SYNCED,
    steamSyncField,
    foldSteamSyncState,
    shouldRetrySteamSync,
    ECO_STEAM_TEMP,
    ECO_STEAM_DELAY_MS,
    shouldEnterEcoSteam,
} from '../src/modules/steam-mode.js';

// ── resolveSteamFlowPresetsForModel ─────────────────────────────────────────

test('unknown/null/empty models resolve to the standard preset group', () => {
    assert.equal(resolveSteamFlowPresetsForModel(null), STEAM_FLOW_PRESETS_BY_MODEL.standard);
    assert.equal(resolveSteamFlowPresetsForModel(undefined), STEAM_FLOW_PRESETS_BY_MODEL.standard);
    assert.equal(resolveSteamFlowPresetsForModel(''), STEAM_FLOW_PRESETS_BY_MODEL.standard);
    assert.equal(resolveSteamFlowPresetsForModel('DE1Pro'), STEAM_FLOW_PRESETS_BY_MODEL.standard);
});

test('plain "Bengle" (what the app serializes today) is the standard group', () => {
    assert.equal(resolveSteamFlowPresetsForModel('Bengle'), STEAM_FLOW_PRESETS_BY_MODEL.standard);
});

test('15A models resolve to the high group (forward-looking)', () => {
    assert.equal(resolveSteamFlowPresetsForModel('Bengle 15A'), STEAM_FLOW_PRESETS_BY_MODEL.highGroup);
    assert.equal(resolveSteamFlowPresetsForModel('bengle 15a'), STEAM_FLOW_PRESETS_BY_MODEL.highGroup);
});

test('10A and XXL models resolve to the mid group', () => {
    assert.equal(resolveSteamFlowPresetsForModel('Bengle 10A'), STEAM_FLOW_PRESETS_BY_MODEL.midGroup);
    assert.equal(resolveSteamFlowPresetsForModel('DE1XXL'), STEAM_FLOW_PRESETS_BY_MODEL.midGroup);
});

test('15A wins over 10A/XXL when both substrings appear', () => {
    assert.equal(resolveSteamFlowPresetsForModel('Bengle 15A XXL'), STEAM_FLOW_PRESETS_BY_MODEL.highGroup);
});

test('preset groups have four ascending values each', () => {
    for (const group of Object.values(STEAM_FLOW_PRESETS_BY_MODEL)) {
        assert.equal(group.length, 4);
        for (let i = 1; i < group.length; i++) assert.ok(group[i] > group[i - 1]);
    }
});

// ── MILK_STOP_PRESETS ───────────────────────────────────────────────────────
// Milk-mode counterpart of the main-page Time presets (15/30/45/60 s): four
// tappable stop-target defaults shown on the steam tile while in Milk mode.

test('milk-stop presets are 55/60/65/70 °C, mirroring the Time preset row', () => {
    assert.deepEqual(MILK_STOP_PRESETS, [55, 60, 65, 70]);
});

test('milk-stop presets are four ascending values inside the 30–85 °C clamp', () => {
    assert.equal(MILK_STOP_PRESETS.length, 4);
    for (let i = 1; i < MILK_STOP_PRESETS.length; i++) {
        assert.ok(MILK_STOP_PRESETS[i] > MILK_STOP_PRESETS[i - 1]);
    }
    for (const t of MILK_STOP_PRESETS) {
        assert.ok(Number.isInteger(t) && t >= 30 && t <= 85);
    }
});

// ── resolveSteamStopMode ────────────────────────────────────────────────────
// Server field stopAtTemperature (0 = off) wins; 'time' vs 'off' comes from the
// skin-local stored preference; 'temperature' is never valid off a Bengle.

test('armed target (stopTemp > 0) forces temperature mode on a Bengle', () => {
    assert.equal(resolveSteamStopMode(65, null, true), 'temperature');
    assert.equal(resolveSteamStopMode(30, 'off', true), 'temperature');
});

test('armed target degrades to time mode on a non-Bengle', () => {
    assert.equal(resolveSteamStopMode(65, null, false), 'time');
    assert.equal(resolveSteamStopMode(65, 'off', false), 'time');
});

test('disarmed + stored preference resolves off/time as stored', () => {
    assert.equal(resolveSteamStopMode(0, 'off', true), 'off');
    assert.equal(resolveSteamStopMode(0, 'off', false), 'off');
    assert.equal(resolveSteamStopMode(0, 'time', true), 'time');
    assert.equal(resolveSteamStopMode(0, 'time', false), 'time');
});

test('stored temperature preference only holds on a Bengle', () => {
    assert.equal(resolveSteamStopMode(0, 'temperature', true), 'temperature');
    assert.equal(resolveSteamStopMode(0, 'temperature', false), 'time');
});

test('no/unknown stored preference defaults to time', () => {
    assert.equal(resolveSteamStopMode(0, null, true), 'time');
    assert.equal(resolveSteamStopMode(0, undefined, false), 'time');
    assert.equal(resolveSteamStopMode(0, 'bogus', true), 'time');
});

// ── resolveMilkProbePresence ────────────────────────────────────────────────
// Snapshot milkTemperature contract: 0 / absent = no probe or no reading.
// Present from the first positive reading; brief 0-glitches don't drop it;
// a sustained absence does. Never fake a probe that was never seen.

test('probe starts (and stays) absent while readings are 0/absent/garbage', () => {
    let s = resolveMilkProbePresence(null, 0, 1000);
    assert.equal(s.present, false);
    s = resolveMilkProbePresence(s, undefined, 2000);
    assert.equal(s.present, false);
    s = resolveMilkProbePresence(s, NaN, 3000);
    assert.equal(s.present, false);
    s = resolveMilkProbePresence(s, 'hot', 4000);
    assert.deepEqual(s, { present: false, lastPositiveMs: null });
});

test('a positive reading makes the probe present immediately', () => {
    const s = resolveMilkProbePresence(null, 22.5, 1000);
    assert.deepEqual(s, { present: true, lastPositiveMs: 1000 });
});

test('brief 0-glitches inside the window keep the probe present', () => {
    let s = resolveMilkProbePresence(null, 60.1, 1000);
    s = resolveMilkProbePresence(s, 0, 1000 + MILK_PROBE_ABSENT_AFTER_MS - 1);
    assert.equal(s.present, true);
    assert.equal(s.lastPositiveMs, 1000); // glitches don't refresh the window
});

test('a sustained absence drops the probe after the window elapses', () => {
    let s = resolveMilkProbePresence(null, 60.1, 1000);
    s = resolveMilkProbePresence(s, 0, 1000 + MILK_PROBE_ABSENT_AFTER_MS);
    assert.equal(s.present, false);
});

test('a fresh positive reading revives an absent probe', () => {
    let s = resolveMilkProbePresence(null, 60, 1000);
    s = resolveMilkProbePresence(s, 0, 1000 + MILK_PROBE_ABSENT_AFTER_MS + 5000);
    assert.equal(s.present, false);
    s = resolveMilkProbePresence(s, 21.0, 50000);
    assert.deepEqual(s, { present: true, lastPositiveMs: 50000 });
});

// ── selectMilkProbeSensorId ─────────────────────────────────────────────────
// Picks the Bengle milk probe out of a GET /api/v1/sensors response. Matched
// by info.name (a documented SensorManifest field), never by the sensor's
// `id`, which is an undocumented reaprime implementation detail. Never
// invents an id for a malformed/empty/non-matching response.

test('sensor select: empty/malformed responses resolve to no probe', () => {
    assert.equal(selectMilkProbeSensorId([]), null);
    assert.equal(selectMilkProbeSensorId(null), null);
    assert.equal(selectMilkProbeSensorId(undefined), null);
    assert.equal(selectMilkProbeSensorId('not an array'), null);
});

test('sensor select: a sensor list with no milk probe resolves to no probe', () => {
    const sensors = [
        { id: 'de1-temp-sensor', info: { name: 'DE1 Group Temp', vendor: 'DecentEspresso' } },
    ];
    assert.equal(selectMilkProbeSensorId(sensors), null);
});

test('sensor select: finds the Bengle milk probe by name', () => {
    const sensors = [
        { id: 'de1-temp-sensor', info: { name: 'DE1 Group Temp', vendor: 'DecentEspresso' } },
        { id: '17B33560-milkprobe', info: { name: 'Bengle Milk Probe', vendor: 'DecentEspresso' } },
    ];
    assert.equal(selectMilkProbeSensorId(sensors), '17B33560-milkprobe');
});

test('sensor select: a name match with no usable id resolves to no probe', () => {
    const sensors = [{ info: { name: 'Bengle Milk Probe' } }, { id: '', info: { name: 'Bengle Milk Probe' } }];
    assert.equal(selectMilkProbeSensorId(sensors), null);
});

// ── applyMilkProbeGate ──────────────────────────────────────────────────────
// 'temperature' is only offerable with a probe; without one it falls back to
// the previously-set non-temperature mode. Other modes pass through untouched.

test('gate: temperature with a probe passes through', () => {
    assert.equal(applyMilkProbeGate('temperature', true, 'off'), 'temperature');
});

test('gate: temperature without a probe falls back to the stored mode', () => {
    assert.equal(applyMilkProbeGate('temperature', false, 'off'), 'off');
    assert.equal(applyMilkProbeGate('temperature', false, 'time'), 'time');
});

test('gate: missing/unknown fallback defaults to time', () => {
    assert.equal(applyMilkProbeGate('temperature', false, null), 'time');
    assert.equal(applyMilkProbeGate('temperature', false, 'temperature'), 'time');
    assert.equal(applyMilkProbeGate('temperature', false, 'bogus'), 'time');
});

test('gate: non-temperature modes are untouched regardless of the probe', () => {
    assert.equal(applyMilkProbeGate('time', false, 'off'), 'time');
    assert.equal(applyMilkProbeGate('off', true, 'time'), 'off');
});

// ── resolveSteamTileMode ────────────────────────────────────────────────────
// The MAIN-PAGE steam tile's display mode, re-resolved on probe-presence and
// armed-milk-stop changes. Milk ('temperature') is only reachable while it's
// usable (Bengle + probe); a probe loss lands the tile on the recorded
// Time/Off fallback, and probe return does not jump back to Milk on its own.

test('tile: an armed milk stop with milk available pins Milk mode', () => {
    // Boot restore: the workflow kept an armed stop and the probe reports in.
    assert.equal(resolveSteamTileMode('flow', true, true, 'time'), 'temperature');
    assert.equal(resolveSteamTileMode('time', true, true, null), 'temperature');
    assert.equal(resolveSteamTileMode('temperature', true, true, 'off'), 'temperature');
});

test('tile: with milk available but un-armed, the pair is Milk|Flow and nothing auto-arms', () => {
    // Probe returned after a loss (the loss un-armed the stop): the tile does
    // NOT jump back to Milk — the user has to re-select it.
    assert.equal(resolveSteamTileMode('temperature', true, false, 'time'), 'flow');
    // 'time' is not in the Milk|Flow pair — it lands on the flow knob.
    assert.equal(resolveSteamTileMode('time', true, false, 'time'), 'flow');
    assert.equal(resolveSteamTileMode('flow', true, false, 'off'), 'flow');
});

test('tile: probe loss in Milk mode falls back to the recorded Time/Off mode', () => {
    // Same record the settings page falls back to (streamline.steamStopModeFallback):
    // 'time' → the duration knob; 'off' → the flow knob (no auto-stop, duration
    // is meaningless); missing/unknown → 'time'.
    assert.equal(resolveSteamTileMode('temperature', false, false, 'time'), 'time');
    assert.equal(resolveSteamTileMode('temperature', false, false, 'off'), 'flow');
    assert.equal(resolveSteamTileMode('temperature', false, false, null), 'time');
    // An armed value arriving with no probe stays gated off the display too.
    assert.equal(resolveSteamTileMode('temperature', false, true, 'time'), 'time');
});

test('tile: without milk, non-Milk modes pass through untouched', () => {
    assert.equal(resolveSteamTileMode('time', false, false, 'off'), 'time');
    assert.equal(resolveSteamTileMode('flow', false, false, 'time'), 'flow');
    // …even when the workflow still reports an armed stop (boot with no probe).
    assert.equal(resolveSteamTileMode('flow', false, true, 'time'), 'flow');
});

// ── milkTelemetryText ───────────────────────────────────────────────────────
// Top-telemetry-row Milk field (after Weight): a string only while the probe
// is present AND has a usable reading; null = hide the field entirely.

test('milk telemetry: present probe with a positive reading formats to 0.1°c', () => {
    assert.equal(milkTelemetryText(true, 43.25), '43.3°c');
    assert.equal(milkTelemetryText(true, 4), '4.0°c');
});

test('milk telemetry: absent probe hides the field regardless of the reading', () => {
    assert.equal(milkTelemetryText(false, 43.2), null);
    assert.equal(milkTelemetryText(false, 0), null);
});

test('milk telemetry: unusable readings hide the field — never a fake value or dashes', () => {
    assert.equal(milkTelemetryText(true, 0), null);       // snapshot contract: 0 = no reading
    assert.equal(milkTelemetryText(true, -1), null);
    assert.equal(milkTelemetryText(true, NaN), null);
    assert.equal(milkTelemetryText(true, Infinity), null);
    assert.equal(milkTelemetryText(true, undefined), null);
    assert.equal(milkTelemetryText(true, '60'), null);
});

// ── milkTelemetryValue ──────────────────────────────────────────────────────
// Same gating as milkTelemetryText, but the raw Celsius number (or null) —
// ui.js formats it via units.js so the reading honors the C/F preference.

test('milk telemetry value: present probe with a positive reading returns the raw °C number', () => {
    assert.equal(milkTelemetryValue(true, 43.25), 43.25);
    assert.equal(milkTelemetryValue(true, 4), 4);
});

test('milk telemetry value: absent probe or unusable reading returns null', () => {
    assert.equal(milkTelemetryValue(false, 43.2), null);
    assert.equal(milkTelemetryValue(true, 0), null);
    assert.equal(milkTelemetryValue(true, NaN), null);
    assert.equal(milkTelemetryValue(true, undefined), null);
});

// ── steamFlowHighlightIndex ─────────────────────────────────────────────────
// The preset highlight is DERIVED from the current flow value -- selecting
// or restoring a highlight never produces a flow value. (The old boot path did
// the reverse: it pushed the persisted tap-index's VALUE into the workflow,
// silently resetting a hand-dialed flow on every app load.)

test('highlight: a flow equal to a preset highlights that preset', () => {
    const presets = resolveSteamFlowPresetsForModel('Bengle'); // [0.4, 0.5, 0.6, 0.8]
    assert.equal(steamFlowHighlightIndex(presets, 0.4), 0);
    assert.equal(steamFlowHighlightIndex(presets, 0.5), 1);
    assert.equal(steamFlowHighlightIndex(presets, 0.8), 3);
});

test('highlight: a hand-dialed non-preset flow highlights nothing', () => {
    const presets = resolveSteamFlowPresetsForModel('Bengle');
    assert.equal(steamFlowHighlightIndex(presets, 0.7), -1);
    assert.equal(steamFlowHighlightIndex(presets, 1.5), -1); // old ui.js module default
});

test('highlight: matching is at the tile\'s 0.1 ml/s display precision', () => {
    const presets = resolveSteamFlowPresetsForModel('Bengle');
    assert.equal(steamFlowHighlightIndex(presets, 0.6000000000000001), 2); // float noise still matches
});

test('highlight: garbage input never throws — just no highlight', () => {
    assert.equal(steamFlowHighlightIndex(null, 0.5), -1);
    assert.equal(steamFlowHighlightIndex(undefined, 0.5), -1);
    assert.equal(steamFlowHighlightIndex([], 0.5), -1);
    assert.equal(steamFlowHighlightIndex([0.4, 0.5], NaN), -1);
    assert.equal(steamFlowHighlightIndex([0.4, 0.5], Infinity), -1);
    assert.equal(steamFlowHighlightIndex([0.4, 0.5], '0.5'), -1);
    assert.equal(steamFlowHighlightIndex([0.4, 'x', 0.5], 0.5), 2); // bad preset entries skipped
});

test('highlight derivation is read-only — presets are never mutated', () => {
    const presets = [...resolveSteamFlowPresetsForModel('Bengle')];
    const before = [...presets];
    steamFlowHighlightIndex(presets, 0.7);
    steamFlowHighlightIndex(presets, 0.5);
    assert.deepEqual(presets, before);
});

test('boot semantics: model resolution + persisted tap index yield highlight state WITHOUT a flow value', () => {
    // Simulated boot: the workflow persisted a hand-dialed 0.7, and the last
    // preset the user ever TAPPED was index 1 (0.5). Resolving the model's
    // presets and deriving the highlight must leave the flow alone: the honest
    // result is "no preset selected", not a 0.5 push (the old boot clobber).
    const persistedWorkflowFlow = 0.7;
    const presets = resolveSteamFlowPresetsForModel('Bengle');
    assert.equal(steamFlowHighlightIndex(presets, persistedWorkflowFlow), -1);

    // The tap index regains relevance only through an explicit user tap, which
    // sets the flow to that preset's value — and then the highlight follows
    // the VALUE, index-agnostically.
    const tappedFlow = presets[1];
    assert.equal(steamFlowHighlightIndex(presets, tappedFlow), 1);
});

// ── Steam push sync state ────────────────────────────────────────────────────

test('foldSteamSyncState: a failed push marks the field and arms the retries', () => {
    const s = foldSteamSyncState(STEAM_SYNC_SYNCED, { type: 'push-failed', field: 'duration' });
    assert.equal(s.field, 'duration');
    assert.equal(s.retriesLeft, STEAM_SYNC_RETRY_LIMIT);
    assert.equal(shouldRetrySteamSync(s), true);
});

test('foldSteamSyncState: a successful push of the same field clears the mark', () => {
    const failed = foldSteamSyncState(STEAM_SYNC_SYNCED, { type: 'push-failed', field: 'duration' });
    const ok = foldSteamSyncState(failed, { type: 'push-ok', field: 'duration' });
    assert.deepEqual(ok, STEAM_SYNC_SYNCED);
    assert.equal(shouldRetrySteamSync(ok), false);
});

test('foldSteamSyncState: another field succeeding does NOT clear the mark', () => {
    // A flow write landing says nothing about a duration that never did —
    // clearing on it would put the stale number back to normal colour.
    const failed = foldSteamSyncState(STEAM_SYNC_SYNCED, { type: 'push-failed', field: 'duration' });
    const other = foldSteamSyncState(failed, { type: 'push-ok', field: 'flow' });
    assert.equal(other.field, 'duration');
    assert.equal(other.retriesLeft, STEAM_SYNC_RETRY_LIMIT);
});

test('foldSteamSyncState: retries count down and stop at the limit', () => {
    let s = foldSteamSyncState(STEAM_SYNC_SYNCED, { type: 'push-failed', field: 'flow' });
    for (let i = STEAM_SYNC_RETRY_LIMIT; i > 0; i--) {
        assert.equal(shouldRetrySteamSync(s), true);
        s = foldSteamSyncState(s, { type: 'retry-failed' });
    }
    assert.equal(s.field, 'flow');          // still visibly unsynced
    assert.equal(s.retriesLeft, 0);
    assert.equal(shouldRetrySteamSync(s), false); // but no longer chasing it
    // Never goes negative on a stray extra event.
    assert.equal(foldSteamSyncState(s, { type: 'retry-failed' }).retriesLeft, 0);
});

test('foldSteamSyncState: a successful retry clears whichever field was marked', () => {
    // resyncSteamFromStore reconciles every steam field at once, so its success
    // is unconditional — unlike push-ok.
    const failed = foldSteamSyncState(STEAM_SYNC_SYNCED, { type: 'push-failed', field: 'flow' });
    assert.deepEqual(foldSteamSyncState(failed, { type: 'retry-ok' }), STEAM_SYNC_SYNCED);
});

test('foldSteamSyncState: unknown/absent events leave the state untouched', () => {
    const failed = foldSteamSyncState(STEAM_SYNC_SYNCED, { type: 'push-failed', field: 'duration' });
    assert.equal(foldSteamSyncState(failed, undefined), failed);
    assert.equal(foldSteamSyncState(failed, { type: 'nonsense' }), failed);
    assert.deepEqual(foldSteamSyncState(null, { type: 'retry-failed' }), STEAM_SYNC_SYNCED);
});

test('steamSyncField: milk stop marks the duration element it shares', () => {
    // The tile renders duration AND milk stop in #steam-duration-value.
    assert.equal(steamSyncField('time'), 'duration');
    assert.equal(steamSyncField('temperature'), 'duration');
    assert.equal(steamSyncField('flow'), 'flow');
});


// ── Eco steam ────────────────────────────────────────────────────────────────

test('eco steam parks one degree above the 135C heater cutoff', () => {
    // 135 turns the heater off (de1app binary.tcl:184, Decaid's >= 135 rule), so
    // 136 is barely-heated rather than cold. Not a tunable number.
    assert.equal(ECO_STEAM_TEMP, 136);
    assert.equal(ECO_STEAM_DELAY_MS, 600000); // de1app steam_eco_delay_seconds 600
});

test('shouldEnterEcoSteam: only from an idle machine with steam armed', () => {
    const idle = { enabled: true, machineState: 'idle', configuredTemp: 150 };
    assert.equal(shouldEnterEcoSteam(idle), true);
    assert.equal(shouldEnterEcoSteam({ ...idle, configuredTemp: 135 }), true); // bottom of the range is still armed
});

test('shouldEnterEcoSteam: the setting gates everything', () => {
    assert.equal(shouldEnterEcoSteam({ enabled: false, machineState: 'idle', configuredTemp: 150 }), false);
});

test('shouldEnterEcoSteam: never while the machine is doing something', () => {
    for (const state of ['steam', 'espresso', 'hotWater', 'flush', 'sleeping', 'heating', null]) {
        assert.equal(
            shouldEnterEcoSteam({ enabled: true, machineState: state, configuredTemp: 150 }),
            false,
            `entered eco from ${state}`,
        );
    }
});

test('shouldEnterEcoSteam: steam already off is left off, never armed', () => {
    // 0 is the off state. Entering would raise the target to 136 -- switching a
    // heater ON that the user switched off.
    for (const temp of [0, 134, undefined, null, '150']) {
        assert.equal(
            shouldEnterEcoSteam({ enabled: true, machineState: 'idle', configuredTemp: temp }),
            false,
            `entered eco with configuredTemp ${temp}`,
        );
    }
});
