import { callPluginEndpoint, getPlugins, getWorkflow, getMachineState, getCalibratedSteamSamples, setCalibratedSteamSampling, writeAutoSteamSettings, readSharedValue, STEAM_TEMP_LAST_VALUE_KEY, subscribeMachineConnectionChanges } from './api.js';
import { CALIBRATED_STEAM_PLUGIN, createCalibratedSteamController, isCalibratedSteamAvailable } from './calibrated-steam.js';
import { AUTO_STEAM_SESSION_KEY, createAutoSteamSession, readAutoSteamSession } from './auto-steam-session.js';
import { createAutoSteamLifecycle } from './auto-steam-lifecycle.js';
import { settingsReady } from './settingsSync.js';

const PLUGIN_TIMEOUT_MS = 2000;

function callAutoSteamEndpoint(endpoint, body) {
    let timeout;
    const request = callPluginEndpoint(
        CALIBRATED_STEAM_PLUGIN,
        endpoint,
        body,
        body === undefined ? 'GET' : 'POST',
    );
    const expired = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Auto Steam Calculator did not respond in time.')), PLUGIN_TIMEOUT_MS);
    });
    return Promise.race([request, expired]).finally(() => clearTimeout(timeout));
}

export function initCalibratedSteam({ onAvailability, onChange, onSteamSettings, onError }) {
    let disposed = false;
    let session = null;
    let lifecycle = null;
    let unsubscribe = () => {};
    let visible = new URL(window.location.href).searchParams.get('page');
    visible = !visible || visible === 'index';

    const restoreContext = async () => {
        const [workflow, machine] = await Promise.all([getWorkflow(), getMachineState()]);
        return { workflow, machine };
    };
    const context = async () => {
        const [current, status] = await Promise.all([
            restoreContext(),
            callAutoSteamEndpoint('status'),
        ]);
        return { ...current, pluginStatus: status, calibrationActive: status?.calibrationActive === true };
    };
    const calculator = createCalibratedSteamController({
        getContext: context,
        getSamples: getCalibratedSteamSamples,
        calculate: body => callAutoSteamEndpoint('calculate', body),
        apply: async () => {},
    });

    const initialized = settingsReady.then(async () => {
        if (disposed) return;
        session = createAutoSteamSession({
            saved: readAutoSteamSession(localStorage.getItem(AUTO_STEAM_SESSION_KEY)),
            getContext: context,
            getRestoreContext: restoreContext,
            getStatus: () => callAutoSteamEndpoint('status'),
            getHeaterTemperature: () => readSharedValue(STEAM_TEMP_LAST_VALUE_KEY),
            write: async steam => {
                await writeAutoSteamSettings(steam);
                if (!disposed) onSteamSettings(steam);
            },
            calculate: async (pitcher, flow) => calculator.apply(await calculator.preview(pitcher, flow)),
            persist: value => localStorage.setItem(AUTO_STEAM_SESSION_KEY, JSON.stringify(value)),
            onChange,
        });
        lifecycle = createAutoSteamLifecycle({
            session,
            getPlugins,
            getStatus: () => callAutoSteamEndpoint('status'),
            isAvailable: isCalibratedSteamAvailable,
            onAvailability: available => {
                setCalibratedSteamSampling(available);
                onAvailability(available);
            },
            onChange,
            onError,
            initiallyVisible: visible,
        });
        unsubscribe = subscribeMachineConnectionChanges(() => lifecycle?.connectionChanged());
        await lifecycle.initialize();
    }).catch(async error => {
        if (disposed) return;
        setCalibratedSteamSampling(false);
        onAvailability(false);
        try {
            await session?.disable();
        } catch (fallbackError) {
            onError(new AggregateError([error, fallbackError], 'Auto steam initialization failed and manual settings could not be restored.'));
            return;
        }
        onError(error);
    });

    const shown = () => { visible = true; lifecycle?.mainShown(); };
    const hidden = () => { visible = false; lifecycle?.mainHidden().catch(onError); };
    const changed = () => initialized.then(() => lifecycle?.settingsChanged()).catch(onError);
    document.addEventListener('streamline:mainpagevisible', shown);
    document.addEventListener('streamline:mainpagehidden', hidden);
    document.addEventListener('streamline:plugins-changed', changed);

    return {
        refresh: changed,
        snapshot: () => session?.snapshot(),
        async enter() { await initialized; return session.enter(); },
        async leave() { await initialized; return session.leave(); },
        async fallbackToManual() { await initialized; return session?.disable(); },
        async select(pitcher) { await initialized; return session.select(pitcher); },
        async adjustFlow(delta) { await initialized; return session.adjustFlow(delta); },
        observeMachine(state) { lifecycle?.observeMachine(state).catch(onError); },
        dispose() {
            disposed = true;
            calculator.cancel();
            session?.dispose();
            lifecycle?.dispose();
            unsubscribe();
            setCalibratedSteamSampling(false);
            document.removeEventListener('streamline:mainpagevisible', shown);
            document.removeEventListener('streamline:mainpagehidden', hidden);
            document.removeEventListener('streamline:plugins-changed', changed);
        },
    };
}
