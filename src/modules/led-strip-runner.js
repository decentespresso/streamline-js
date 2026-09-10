// Bengle LED strip — shared colour-sequence playback runner.
//
// Two callers drive the physical strip through the same push-loop:
//   - src/settings/settings.js: a manual "test run" the user starts/stops
//     from the Lighting settings page.
//   - src/modules/app.js: a machine-state-triggered run, resolved from the
//     persisted sequence's `triggerStates` (see led-sequence.js) on every
//     machine-state change, so it keeps running on the MAIN page -- settings.js
//     is not even mounted there.
//
// Both MUST go through this one module rather than keep separate timers/
// write-chains, or they could interleave writes and fight over the strip.
// Ownership is explicit and arbitrated here:
//   - 'manual' always preempts -- starting a manual run stops whatever else
//     was running (including a trigger run) and takes over.
//   - 'trigger' can only start when nothing owns the strip, or when it
//     already owns it (replacing its own run for a new state). It is
//     silently refused while 'manual' owns the strip.
//   - Stopping a 'manual' run HANDS BACK CONTROL: it immediately re-resolves
//     the trigger for the machine's current state and resumes it if mapped,
//     so leaving the Lighting page (or pressing Stop) does not leave a
//     state-triggered animation off until the next state change.
//
// This module is NOT DOM-free by design -- it calls api.js (fetch, and a
// live read of api.js's `currentMachineState`), same as app.js/settings.js.
// The pure step/playback math it uses lives in led-sequence.js so node:test
// can cover it without importing this module.

import { previewLedStrip, clearLedStripPreview, currentMachineState } from './api.js';
import { logger } from './logger.js';
import { LED_SEQUENCE_KEY, parseLedSequence, resolveTriggerSequence, nextStepIndex, stepPreviewColors } from './led-sequence.js';

const MAX_CONSECUTIVE_FAILURES = 3; // stop rather than hammer a machine that stopped listening

// ── Serialized write chain ───────────────────────────────────────────────
// Every write that changes what the strip shows funnels through one promise
// chain so writes land in order and can never interleave -- same rationale as
// the palette write-chain in settings.js (ledEnqueue), just shared here so a
// sequence step and (were they ever concurrent) another write can't race.
let writeChain = Promise.resolve();
function enqueue(op) {
    const p = writeChain.then(op);
    writeChain = p.catch(() => {}); // keep the chain alive whatever op did
    return p;
}

// ── Run state ─────────────────────────────────────────────────────────────
let owner = null;       // null | 'manual' | 'trigger'
let runSteps = [];
let runLoop = false;
let runIndex = -1;      // step currently on the strip, -1 = nothing played yet
let runTimer = null;    // setTimeout handle for the next step
let failures = 0;       // consecutive push failures
const listeners = new Set();

function notify() {
    const snapshot = getRunState();
    for (const fn of listeners) {
        try { fn(snapshot); } catch (e) { logger.error('LED sequence run listener failed:', e); }
    }
}

/** Subscribe to run-state changes (owner/index/running). Returns an unsubscribe function. */
export function onRunChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Current { owner, running, index, steps, loop } snapshot. */
export function getRunState() {
    return { owner, running: owner !== null, index: runIndex, steps: runSteps, loop: runLoop };
}

function pushStep() {
    const step = runSteps[runIndex];
    if (!step) return;
    const { front, back } = stepPreviewColors(step);
    enqueue(async () => {
        try {
            await previewLedStrip(front, back);
            failures = 0;
        } catch (e) {
            failures += 1;
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                logger.warn('LED sequence: stopping after repeated preview-write failures (machine unreachable?)');
                forceStop();
            }
        }
    });
}

function advance() {
    runTimer = null;
    if (owner === null) return;
    const next = nextStepIndex(runSteps.length, runIndex, runLoop);
    if (next === null) { stopAndSettle(owner); return; } // natural end of a non-looping sequence
    runIndex = next;
    pushStep();
    notify();
    runTimer = setTimeout(advance, runSteps[runIndex].durationMs);
}

// Tear down the timer/run state and hand the strip back to its real
// (awake/sleeping) palette. Does NOT notify listeners and does NOT resolve a
// trigger hand-back -- callers decide that, since requestStart's takeover
// path needs neither (a new run is about to own the strip).
function stopInternal() {
    if (runTimer) { clearTimeout(runTimer); runTimer = null; }
    const wasRunning = owner !== null;
    owner = null;
    runSteps = [];
    runLoop = false;
    runIndex = -1;
    failures = 0;
    if (wasRunning) enqueue(() => clearLedStripPreview().catch(() => {}));
}

// Stop + notify + (if a MANUAL run just ended, by request or by reaching the
// end of a non-looping sequence) hand control back to the trigger by
// re-resolving the current machine state. A trigger run ending needs no
// hand-back -- it does not own anything to give away.
function stopAndSettle(finishedOwner) {
    stopInternal();
    notify();
    if (finishedOwner === 'manual') onMachineStateChange(currentMachineState);
}

/**
 * Start a run. `source` is 'manual' or 'trigger'. 'manual' always preempts
 * whatever is running; 'trigger' is refused while 'manual' owns the strip
 * (returns false, nothing changes). An empty step list is a no-op.
 */
export function requestStart(steps, loop, source) {
    if (owner === 'manual' && source === 'trigger') return false;
    if (!Array.isArray(steps) || !steps.length) return false;
    stopInternal();
    owner = source;
    runSteps = steps;
    runLoop = !!loop;
    runIndex = -1;
    failures = 0;
    advance();
    return true;
}

/**
 * Stop the run, but only if `source` currently owns it (a no-op otherwise --
 * e.g. `requestStop('trigger')` while 'manual' owns the strip changes
 * nothing). Stopping a 'manual' run hands control back to the trigger: it
 * re-resolves the current machine state and resumes its mapped sequence, if
 * any. Returns true iff a run was actually stopped.
 */
export function requestStop(source) {
    if (owner !== source) return false;
    stopAndSettle(source);
    return true;
}

/**
 * Unconditional stop regardless of owner -- machine disconnect or a dead
 * write link, never a routine exit. No hand-back: if the link just failed
 * repeatedly, resuming anything would only fail again; a disconnect means
 * there is nothing to resume against either.
 */
export function forceStop() {
    const was = owner;
    stopInternal();
    if (was !== null) notify();
}

// ── Machine-state trigger ────────────────────────────────────────────────

function loadPersistedSequence() {
    let stored = null;
    try { stored = localStorage.getItem(LED_SEQUENCE_KEY); } catch (e) { /* private mode */ }
    return parseLedSequence(stored);
}

/**
 * Call on every machine-state change (app.js's snapshot handler). Starts the
 * sequence mapped to `stateId`, if any, as the 'trigger' owner (silently
 * refused while a manual run is active -- see requestStart). If nothing is
 * mapped and a trigger run is currently active, stops it; a manual run is
 * never touched by this either way.
 */
export function onMachineStateChange(stateId) {
    const sequence = loadPersistedSequence();
    const mapped = resolveTriggerSequence(sequence, stateId);
    if (mapped) {
        requestStart(mapped.steps, mapped.loop, 'trigger');
    } else if (owner === 'trigger') {
        requestStop('trigger');
    }
}
