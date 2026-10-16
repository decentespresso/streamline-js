// Keeps the Grind tile and a connected grinder in step, per the user's two switches
// (Settings > Connections > Grinder). Policy is in grinder-sync.js; this wires it to
// the snapshot socket, the workflow and the tile. Device-local switches (plain
// localStorage, not the synchronized KV): they describe this tablet's grinder.

import { connectGrinderSnapshot, getGrinderInfo, setGrinderSetting, getWorkflow, onWorkflowUpdated, subscribeGrinderConnectionChanges } from './api.js';
import { applyPluginSetAsync, setGrinderGrindStep } from './ui.js';
import { logger } from './logger.js';
import { deviceSetting, parseDeviceNumber, followDecision, sendDecision, grindStepFromInfo } from './grinder-sync.js';

const KEYS = { follow: 'grinder-follow', send: 'grinder-send' };
export const GRINDER_SYNC_CHANGE = 'streamline:grinder-sync-change';

export function getGrinderSync(name) {
    try { return localStorage.getItem(KEYS[name]) === '1'; } catch { return false; }
}
export function setGrinderSync(name, on) {
    try { localStorage.setItem(KEYS[name], on ? '1' : '0'); } catch { /* non-fatal */ }
    document.dispatchEvent(new Event(GRINDER_SYNC_CHANGE));
}

let socket = null;
let started = false;
let lastDevice = null; // the grinder's last reported number
let lastTile = null;   // the tile's last seen grinderSetting
let info = null;       // GET /grinder/info, read when the socket (re)opens

const tileNumber = workflow => {
    const n = parseFloat(workflow?.context?.grinderSetting);
    return Number.isFinite(n) ? n : null;
};

async function onSnapshot(snapshot) {
    const reading = parseDeviceNumber(deviceSetting(snapshot));
    const previous = lastDevice;
    lastDevice = reading;
    if (!getGrinderSync('follow')) return;
    try {
        const value = followDecision({ deviceValue: reading, lastDevice: previous, tileValue: tileNumber(await getWorkflow()) });
        if (value !== null) {
            lastTile = value; // our own write: the send side must not see it as an edit
            await applyPluginSetAsync('grinderSetting', value);
        }
    } catch (error) { logger.warn('Following the grinder failed:', error); }
}

function onWorkflow(workflow) {
    const tile = tileNumber(workflow);
    const previous = lastTile;
    lastTile = tile;
    if (!getGrinderSync('send') || previous === null) return;
    const setting = sendDecision({ tileValue: tile, lastTile: previous, deviceValue: lastDevice, info });
    if (setting === null) return;
    setGrinderSetting(setting).catch(error => logger.warn('Sending the grind to the grinder failed:', error));
}

function sync() {
    const wanted = getGrinderSync('follow') || getGrinderSync('send');
    if (!wanted) { socket?.close(); socket = null; return; }
    if (socket) return;
    socket = connectGrinderSnapshot(onSnapshot, () => {
        lastDevice = null; // a (re)connected grinder is read afresh
        getGrinderInfo().then(i => { info = i; });
    });
    getWorkflow().then(w => { if (lastTile === null) lastTile = tileNumber(w); }).catch(() => {});
}

// The Grind tile's -/+ follows the connected grinder's declared step whatever the two
// switches say; a grinder that goes away hands the tile back to its own rule.
// Read once at load and again whenever a grinder connects or disconnects (Decaid's
// devices feed says so), not on a timer.
async function refreshGrindStep() {
    const next = await getGrinderInfo();
    info = next; // null once the grinder is gone, so Send stops
    setGrinderGrindStep(grindStepFromInfo(next));
}

/** Idempotent. Safe to call at boot; the socket opens only while a switch is on. */
export function initGrinderSync() {
    if (started) return;
    started = true;
    refreshGrindStep();
    subscribeGrinderConnectionChanges(refreshGrindStep);
    onWorkflowUpdated(onWorkflow);
    document.addEventListener(GRINDER_SYNC_CHANGE, sync);
    sync();
}
