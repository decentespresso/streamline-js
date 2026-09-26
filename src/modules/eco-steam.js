// Eco steam — park the steam boiler just above its cutoff while nothing happens.
//
// Ported from de1app, which has four pieces (settings toggle `eco_steam`,
// defaults in machine.tcl, the timer riding the screen-saver in gui.tcl:878,
// and the wire override in binary.tcl:189). Decaid has no equivalent, so all
// four live here:
//
//   setting  -> localStorage 'streamline.ecoSteam' (skin-local, like the
//               steam-stop mode), surfaced as a toggle on the Steam settings page
//   defaults -> ECO_STEAM_TEMP / ECO_STEAM_DELAY_MS in steam-mode.js
//   timer    -> noteActivity() below, re-armed by any interaction, which is the
//               same contract as de1app's delay_screen_saver
//   wire     -> api.setMachineSteamTemp(), a POST /machine/shotSettings that
//               reaches the DE1 without rewriting the stored workflow
//
// That last point is the important one: the user's configured steam temperature
// is never mutated, so it survives the eco round trip and every other reader of
// the workflow (settings page, dashboard, dyeStrip) keeps seeing what the user
// actually set. Exit re-reads the workflow rather than remembering a value, so
// a temperature changed from another device is still what gets restored.

import { currentMachineState, getWorkflow, setMachineSteamTemp } from './api.js';
import { logger } from './logger.js';
import { ECO_STEAM_DELAY_MS, ECO_STEAM_TEMP, STEAM_ENABLED_MIN_TEMP, shouldEnterEcoSteam } from './steam-mode.js';

const STORAGE_KEY = 'streamline.ecoSteam';

let timer = null;
let active = false;
// Bumped by every interaction. An in-flight enter/exit compares it after each
// await and drops out if the user moved on — without this, a touch arriving
// mid-enter is followed by the enter's write, parking the boiler with no timer
// left to bring it back.
let generation = 0;

/** Is the user's eco steam setting on? */
export function isEcoSteamEnabled() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
}

/** Turn eco steam on/off. Turning it off leaves eco immediately. */
export function setEcoSteamEnabled(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (e) { /* non-fatal */ }
    noteEcoSteamActivity();
}

/** Is the boiler parked at the eco target right now? */
export function isEcoSteamActive() {
    return active;
}

/**
 * Any user interaction: leave eco if we are in it, and restart the countdown.
 * One call does both jobs, exactly like de1app's delay_screen_saver.
 */
export function noteEcoSteamActivity() {
    generation++;
    clearTimeout(timer);
    timer = null;

    if (active) exitEco();

    if (!isEcoSteamEnabled()) return;
    timer = setTimeout(() => enterEco(generation), ECO_STEAM_DELAY_MS);
}

export function initEcoSteam() {
    for (const ev of ['pointerdown', 'keydown', 'wheel']) {
        document.addEventListener(ev, noteEcoSteamActivity, { capture: true, passive: true });
    }
    noteEcoSteamActivity();
}

async function enterEco(gen) {
    timer = null;
    let workflow = null;
    try {
        workflow = await getWorkflow();
    } catch (e) {
        logger.warn('Eco steam: could not read the workflow, staying out of eco', e);
        return;
    }
    if (gen !== generation) return; // interaction while we were reading

    const configuredTemp = workflow?.steamSettings?.targetTemperature;
    if (!shouldEnterEcoSteam({ enabled: isEcoSteamEnabled(), machineState: currentMachineState, configuredTemp })) {
        // Busy or steam off. Both pass — check again after another idle spell
        // rather than dropping the feature until the next touch.
        if (isEcoSteamEnabled()) timer = setTimeout(() => enterEco(generation), ECO_STEAM_DELAY_MS);
        return;
    }

    try {
        await setMachineSteamTemp(ECO_STEAM_TEMP);
        if (gen !== generation) { await restoreConfiguredTemp(); return; }
        active = true;
        logger.info(`Eco steam: parked the boiler at ${ECO_STEAM_TEMP}°C (configured ${configuredTemp}°C)`);
    } catch (e) {
        logger.warn('Eco steam: failed to park the boiler', e);
    }
}

async function exitEco() {
    active = false;
    try {
        await restoreConfiguredTemp();
        logger.info('Eco steam: restored the configured steam temperature');
    } catch (e) {
        // The boiler is left cold until the next interaction retries. Louder
        // than the entry failure because this one is the user waiting on steam.
        logger.error('Eco steam: failed to restore the configured steam temperature', e);
        active = true; // still parked — let the next interaction try again
    }
}

async function restoreConfiguredTemp() {
    const temp = (await getWorkflow())?.steamSettings?.targetTemperature;
    // Steam switched off while we were parked: the workflow already says "off"
    // and Decaid will have written it, so there is nothing to restore.
    if (typeof temp === 'number' && temp >= STEAM_ENABLED_MIN_TEMP) await setMachineSteamTemp(temp);
}
