// Sourcing logic for the HISTORICAL GFlow trace -- pure, DOM-free.
//
// A shot record carries up to TWO flow-by-weight series per measurement:
//   machine.weightFlow -- the machine's OWN gravimetric-flow figure, which is
//     the exact series the LIVE chart plotted during the shot;
//   scale.weightFlow   -- the app's d(weight)/dt (FlowCalculator, 600 ms window
//     + MovingAverage(10)), a different smoothing pipeline.
// plotHistoricalShot used to rebuild the trace from the scale series only, so on
// a machine that reports its own gravimetric flow the post-shot repaint visibly
// snapped to the other algorithm a few seconds after the shot ended. Prefer the
// machine series whenever the record actually has one; keep the scale-based chain
// as the fallback for every other record.

// True when the record carries a real machine-side gravimetric flow series.
// A plain DE1 record serializes machine.weightFlow as a constant 0.0 (the 0xA00D
// shot-sample parse never sets it), so field PRESENCE is not sufficient -- any
// NONZERO sample is. An all-zero record degrades harmlessly to the scale path,
// which is also ~0.
export function hasMachineGFlow(measurements) {
    if (!Array.isArray(measurements)) return false;
    return measurements.some(m =>
        typeof m?.machine?.weightFlow === 'number' && m.machine.weightFlow !== 0);
}

// Stateful resolver for the scale-sourced fallback chain: prefer the stored
// server weightFlow (g/s); otherwise derive a local delta+EMA from the raw
// weights (records predating weightFlow). Create one instance per plotted record
// and feed it the scale frames in measurement order.
//
// This is the logic that was duplicated inline in BOTH of plotHistoricalShot's
// measurement loops. It is unchanged, only extracted, so the two loops can no
// longer drift apart.
export function createScaleFlowResolver(smoothingFactor) {
    let lastWeight = 0;
    let lastTime = 0;
    let smoothed = 0;
    return function resolveScaleFlow(scaleData, time) {
        let weightChange = 0;
        if (scaleData.weightFlow !== null && scaleData.weightFlow !== undefined) {
            weightChange = scaleData.weightFlow;
            smoothed = scaleData.weightFlow; // seed EMA in case we fall back later
        } else if (lastTime > 0 && time > lastTime) {
            const timeDiff = time - lastTime;
            const rawWeightChange = (scaleData.weight - lastWeight) / timeDiff;
            smoothed = (smoothingFactor * rawWeightChange) + (1 - smoothingFactor) * smoothed;
            weightChange = smoothed;
        }
        lastWeight = scaleData.weight;
        lastTime = time;
        return weightChange;
    };
}

// The substates every trace in the historical rebuild is gated on -- and that
// the live path gates on too (chart.js updateChart returns early otherwise).
export function isPourPhase(substate) {
    return substate === 'preinfusion' || substate === 'pouring';
}

// Carries the pour phase forward across measurements so SCALE frames can be
// gated the same way machine frames are.
//
// A ShotSnapshot's `machine` and `scale` are both optional (rest_v1.yml:6773),
// so a snapshot may carry a scale reading and no machine frame. Such a frame
// must INHERIT the phase of the last machine frame seen, not be dropped for
// having none -- dropping them would thin or empty the GFlow trace on any
// record whose scale and machine frames are not paired one-to-one.
//
// Feed every machine frame's substate in measurement order; read `inPour` when
// deciding whether a scale frame contributes a GFlow sample.
export function createPourPhaseTracker() {
    let inPour = false;
    return {
        observe(substate) { if (substate) inPour = isPourPhase(substate); return inPour; },
        get inPour() { return inPour; },
    };
}
