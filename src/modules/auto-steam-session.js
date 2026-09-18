import { autoSteamFlowSettings } from './auto-steam-flow.js';

export const AUTO_STEAM_SESSION_KEY = 'streamline.autoSteamSession';
export const AUTO_STEAM_PITCHERS = ['small', 'medium', 'large', 'auto'];

export function readAutoSteamSession(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
}

export function createAutoSteamSession({ saved = {}, getContext, getRestoreContext = getContext, getStatus, getHeaterTemperature = async () => null, write, calculate, persist, onChange }) {
    saved ||= {};
    let active = saved.active === true;
    let manual = saved.manual ?? null;
    let pitcher = AUTO_STEAM_PITCHERS.includes(saved.pitcher) ? saved.pitcher : null;
    let busy = false;
    let ready = false;
    let used = false;
    let disabled = false;
    let state = null;
    let disposed = false;
    let applied = null;
    let availablePitchers = [];
    let configurationReady = false;
    let operationPromise = null, resetPromise = null;
    let offConfirmed = false, needsReset = false, retryBlocked = false;
    let cancellation = 0, configurationKey = saved.configurationKey ?? null;
    let flow = saved.flow ?? null, flowSettings = null;
    const snapshot = () => ({ active, busy, ready, pitcher, manual, applied, disabled, availablePitchers: [...availablePitchers], configurationReady,
        flow, adjustableFlow: flowSettings?.adjustable === true, minimumFlow: flowSettings?.minimum, maximumFlow: flowSettings?.maximum });
    function publish() {
        persist({ active, manual, pitcher, flow, configurationKey });
        if (!disposed) onChange(snapshot());
    }
    function updateStatus(status) {
        const key = JSON.stringify(status.settings ?? {});
        const changed = configurationKey !== null && configurationKey !== key;
        configurationKey = key;
        if (changed) offConfirmed = false;
        flowSettings = autoSteamFlowSettings(status);
        if (flowSettings && (changed || !flowSettings.adjustable || !Number.isFinite(flow) || flow < flowSettings.minimum || flow > flowSettings.maximum)) flow = flowSettings.defaultFlow;
        availablePitchers = Array.isArray(status.availablePitchers) ? AUTO_STEAM_PITCHERS.filter(choice => status.availablePitchers.includes(choice)) : [];
        configurationReady = status.calibrationActive !== true && status.apiVersion === 4 && status.ready === true && availablePitchers.length > 0 && flowSettings !== null;
        if (!availablePitchers.includes(pitcher)) {
            pitcher = availablePitchers.includes(status.settings?.defaultPitcher) ? status.settings.defaultPitcher : (availablePitchers[0] ?? null);
        }
        publish();
        return changed;
    }
    async function context() {
        const value = await getContext();
        if (value.calibrationActive) throw new Error('Finish or cancel guided calibration in the extension settings first.');
        state = typeof value.machine?.state === 'object' ? value.machine.state.state : value.machine?.state;
        if (state !== 'idle') throw new Error('Wait until the machine is idle.');
        if (disposed) throw new Error('Auto steam session closed.');
        return value;
    }
    function run(operation) {
        if (busy) return Promise.reject(new Error('Wait for the steam setting to finish.'));
        busy = true;
        publish();
        operationPromise = Promise.resolve().then(operation).finally(() => {
            busy = false; operationPromise = null; publish();
        });
        return operationPromise;
    }
    async function off(current) {
        current ||= await context();
        const status = current.pluginStatus || await getStatus();
        if (status.apiVersion !== 4) throw new Error('Update the Auto Steam Calculator extension.');
        updateStatus(status);
        if (status.calibrationActive) throw new Error('Finish or cancel guided calibration in the extension settings first.');
        const steam = { duration: 0, stopAtTemperature: 0, flow: current.workflow.steamSettings.flow };
        if (Number.isFinite(flow) && flow >= 0.4 && flow <= 2.5) steam.flow = flow;
        ready = false; applied = null;
        if (!Object.entries(steam).every(([key, value]) => (current.workflow.steamSettings[key] ?? (key === 'stopAtTemperature' ? 0 : undefined)) === value)) {
            offConfirmed = false;
            await write(steam);
        }
        offConfirmed = true; used = false; retryBlocked = false;
        publish();
        return status;
    }
    async function restoreManual() {
        if (!manual || !Number.isFinite(manual.duration) || !Number.isFinite(manual.flow) || !Number.isFinite(manual.targetTemperature)) {
            throw new Error('Manual steam settings are unavailable. Restore them in Settings.');
        }
        await write(manual);
        applied = { workflowPatch: { steamSettings: manual } };
        active = false; manual = null; ready = false; used = false; needsReset = false; offConfirmed = false;
    }
    function resetInBackground() {
        if (resetPromise) return resetPromise;
        resetPromise = Promise.resolve().then(async () => {
            while (active && !disposed && needsReset) {
                while (operationPromise) await operationPromise.catch(() => {});
                if (!active || disposed || !needsReset) break;
                let completed = false;
                await run(async () => {
                    const current = await (disabled ? getRestoreContext() : getContext());
                    state = typeof current.machine?.state === 'object' ? current.machine.state.state : current.machine?.state;
                    if (state !== 'idle' || current.calibrationActive) return;
                    needsReset = false;
                    if (disabled) await restoreManual();
                    else await off(current);
                    completed = true;
                });
                if (!completed) break;
            }
        }).catch(error => { needsReset = active; retryBlocked = true; throw error; }).finally(() => { resetPromise = null; });
        return resetPromise;
    }
    async function leave() {
        if (!active) return;
        return run(async () => {
            await context();
            cancellation++;
            await restoreManual();
        });
    }
    return {
        snapshot,
        updateStatus,
        async enter() {
            disabled = false;
            return run(async () => {
                const current = await context();
                if (!active) {
                    const steam = current.workflow?.steamSettings;
                    if (!steam || !Number.isFinite(steam.duration) || !Number.isFinite(steam.flow) || !Number.isFinite(steam.targetTemperature)) throw new Error('Steam settings are unavailable.');
                    manual = { duration: steam.duration, flow: steam.flow, targetTemperature: steam.targetTemperature, stopAtTemperature: steam.stopAtTemperature ?? 0 };
                    active = true;
                    publish();
                }
                await off(current);
                needsReset = false;
            });
        },
        leave,
        async adjustFlow(delta) {
            if (!active || disabled) throw new Error('Select Auto steam mode first.');
            if (!Number.isFinite(delta)) throw new Error('Choose a valid flow adjustment.');
            return run(async () => {
                const current = await context();
                updateStatus(current.pluginStatus || await getStatus());
                if (!configurationReady || !flowSettings?.adjustable) throw new Error('Complete multiple-flow calibration before adjusting Auto flow.');
                const next = Math.max(flowSettings.minimum, Math.min(flowSettings.maximum, Math.round((flow + delta) * 10) / 10));
                if (next === flow) return;
                flow = next; cancellation++; ready = false; applied = null; offConfirmed = false; needsReset = true;
                await off(current);
                needsReset = false;
            });
        },
        async select(choice) {
            if (!active || disabled) throw new Error('Select Auto steam mode first.');
            if (!AUTO_STEAM_PITCHERS.includes(choice)) throw new Error('Choose Small, Medium, Large or Auto.');
            const startedAt = cancellation;
            return run(async () => {
                const current = await context();
                await off(current);
                if (!configurationReady) throw new Error('Complete Auto Steam Calculator calibration in Settings > Extensions.');
                if (!availablePitchers.includes(choice)) throw new Error('Choose a configured pitcher selection.');
                pitcher = choice;
                const targetTemperature = manual?.targetTemperature > 0 ? manual.targetTemperature : await getHeaterTemperature();
                if (!Number.isInteger(targetTemperature) || targetTemperature < 135 || targetTemperature > 165) {
                    throw new Error('Set the heater temperature in normal Steam settings, then calculate again.');
                }
                const result = await calculate(pitcher, flow);
                await context();
                if (startedAt !== cancellation) return null;
                if (disabled) throw new Error('Auto Steam Calculator was disabled.');
                const steamSettings = { ...result.workflowPatch.steamSettings, targetTemperature, stopAtTemperature: 0 };
                offConfirmed = false;
                await write(steamSettings);
                if (startedAt !== cancellation) { ready = false; return null; }
                applied = { ...result, workflowPatch: { steamSettings } };
                ready = true;
                return applied;
            });
        },
        async observeMachine(next) {
            const previous = state;
            state = next;
            if (active && state === 'steam') { used = true; ready = false; offConfirmed = false; needsReset = true; }
            if (!active || state !== 'idle' || retryBlocked || !needsReset) return;
            if (resetPromise) return resetPromise;
            if (previous !== 'idle') return resetInBackground();
        },
        invalidate({ verify = false } = {}) {
            if (!active) return Promise.resolve();
            if (verify) { offConfirmed = false; retryBlocked = false; }
            if (!verify && ((offConfirmed && !busy) || retryBlocked)) return Promise.resolve();
            cancellation++; needsReset = true; ready = false; applied = null;
            publish();
            return resetInBackground();
        },
        disable() {
            disabled = true; ready = false; cancellation++;
            if (!active) return Promise.resolve();
            needsReset = true; retryBlocked = false;
            return resetInBackground();
        },
        connectionLost() { cancellation++; offConfirmed = false; ready = false; configurationReady = false; needsReset = active; retryBlocked = true; publish(); },
        dispose() { disposed = true; },
    };
}
