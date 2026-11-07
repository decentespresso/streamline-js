import { AUTO_STEAM_PLUGIN_ID, queryAutoSteamCapability } from './auto-steam-capability.js';

export const CALIBRATED_STEAM_PLUGIN = AUTO_STEAM_PLUGIN_ID;

export function isCalibratedSteamAvailable(plugins) {
    return queryAutoSteamCapability(plugins).available;
}

export function createScaleSampleBuffer() {
    let samples = [];
    let lastTimestamp = null;
    function clear() { samples = []; lastTimestamp = null; }
    return {
        clear,
        push(frame, now = Date.now()) {
            if (!Number.isFinite(frame?.weight)) return;
            if (frame.timestamp != null && frame.timestamp === lastTimestamp) return;
            if (samples.length && now < samples[samples.length - 1].receivedAt) clear();
            if (samples.length && now - samples[samples.length - 1].receivedAt < 50) return;
            lastTimestamp = frame.timestamp ?? null;
            samples = samples.filter(sample => now - sample.receivedAt <= 1500);
            samples.push({ weightGrams: frame.weight, receivedAt: now });
            if (samples.length > 32) samples.shift();
        },
        read(now = Date.now()) {
            if (samples.length && now < samples[samples.length - 1].receivedAt) clear();
            samples = samples.filter(sample => now - sample.receivedAt <= 1500);
            return samples.map(sample => ({ weightGrams: sample.weightGrams, ageMs: now - sample.receivedAt }));
        },
    };
}

export function createCalibratedSteamController({ getContext, getSamples, calculate, apply, now = Date.now }) {
    let generation = 0;
    let applying = false;
    function check(token) {
        if (token !== generation) throw new Error('Calculation cancelled.');
    }
    async function capture(pitcher, token, selection = {}) {
        const startedAt = now();
        const { workflow, machine } = await getContext();
        check(token);
        const steam = workflow?.steamSettings;
        const sampledAt = now();
        const samples = getSamples();
        const calibrationKey = typeof selection.calibrationKey === 'string' ? selection.calibrationKey : null;
        const requestedFlow = Number.isFinite(selection.flow) ? selection.flow : null;
        const expectedFlow = calibrationKey
            ? (Number.isFinite(selection.expectedFlow) ? selection.expectedFlow : null)
            : requestedFlow;
        if ((calibrationKey === null) === (requestedFlow === null)) {
            throw new Error('Choose one Auto steam calibration or flow.');
        }
        const result = await calculate({
            samples, pitcher, ...(calibrationKey === null ? { flow: requestedFlow } : { calibrationKey }),
            machineState: typeof machine?.state === 'object' ? machine.state.state : machine?.state,
            stopAtTemperature: steam?.stopAtTemperature ?? 0,
        });
        check(token);
        const receivedAt = now();
        const newestAge = samples[samples.length - 1]?.ageMs;
        if (receivedAt < startedAt || receivedAt < sampledAt || receivedAt - startedAt > 2500 ||
            !Number.isFinite(newestAge) || newestAge + receivedAt - sampledAt > 1500) {
            throw new Error('Scale or machine observations expired. Calculate again.');
        }
        if (result?.apiVersion !== 5 || !Number.isFinite(result.workflowPatch?.steamSettings?.flow) ||
            result.workflowPatch.steamSettings.flow < 0.4 || result.workflowPatch.steamSettings.flow > 2.5 ||
            result.workflowPatch.steamSettings.flow !== expectedFlow ||
            (calibrationKey === null ? result.calibrationKey !== null : result.calibrationKey !== calibrationKey) ||
            !Number.isFinite(result.targetTemperatureC) || result.targetTemperatureC <= 0 || result.targetTemperatureC > 100 ||
            typeof result.targetLabel !== 'string' || result.targetLabel.length === 0 || result.targetLabel.length > 32 ||
            !Number.isInteger(result?.durationSeconds) || result.durationSeconds < 1 || result.durationSeconds > 255 ||
            !Number.isFinite(result.milkGrams)) {
            throw new Error('The plugin returned an invalid calculation.');
        }
        return { result, pitcher, selection: { ...selection }, token, createdAt: now(), workflowKey: JSON.stringify(workflow) };
    }
    return {
        cancel() { generation++; },
        preview(pitcher = 'auto', selection) {
            if (applying) return Promise.reject(new Error('A steam time is already being applied.'));
            return capture(pitcher, ++generation, selection);
        },
        async apply(preview) {
            if (applying) throw new Error('A steam time is already being applied.');
            check(preview.token);
            if (now() - preview.createdAt > 15000 || now() < preview.createdAt) throw new Error('Preview expired. Calculate again.');
            applying = true;
            try {
                const fresh = await capture(preview.pitcher, preview.token, preview.selection);
                const old = preview.result;
                const next = fresh.result;
                if (preview.workflowKey !== fresh.workflowKey || old.calibrationRevision !== next.calibrationRevision ||
                    old.pitcher !== next.pitcher || old.durationSeconds !== next.durationSeconds ||
                    old.calibrationKey !== next.calibrationKey || old.targetTemperatureC !== next.targetTemperatureC ||
                    old.targetLabel !== next.targetLabel || old.workflowPatch.steamSettings.flow !== next.workflowPatch.steamSettings.flow ||
                    Math.abs(old.milkGrams - next.milkGrams) > 2) {
                    throw new Error('The scale, pitcher or settings changed. Calculate again.');
                }
                check(preview.token);
                await apply(next);
                generation++;
                return next;
            } finally { applying = false; }
        },
    };
}
