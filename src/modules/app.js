import { connectWebSocket, getWorkflow, connectScaleWebSocket, ensureGatewayModeTracking, reconnectingWebSocket, getDevices, reconnectDevice, scanForDevices,connectShotSettingsWebSocket, getDe1AdvancedSettings, updateShotSettingsCache, getDe1Settings, MachineState, getShotIds, getShots, getValueFromStore, verifyVisualizerCredentials, connectScaleDevice, tareScale, connectTimeToReadyWebSocket, connectShotStateWebSocket, sendDeviceCommand, saveScaleDeviceId, getScaleDeviceId, getDeviceWebSocket, initDeviceWebSocketWithCallback, connectDeviceWebSocket, connectDisplayWebSocket, restoreBrightnessFromStorage, getMachineInfo, getMachineState, setMachineState, getReaSettings, getAppInfo, getCachedRefillKitSetting, getSensors, connectSensorSnapshotWebSocket, closeSensorSnapshotWebSocket } from './api.js';
import { initScaling } from './scaling.js';
import * as chart from './chart.js';
import * as ui from './ui.js';
import { initI18n, getTranslation, fitTelemetry } from './i18n.js';
import { settingsReady } from './settingsSync.js';
import { initUnits, formatTemp, fromDisplayTemp } from './units.js';
import * as history from './history.js';
import * as shotData from './shotData.js';
import * as profileManager from './profileManager.js';
import * as api from './api.js';
import { loadPage, initRouter, isSubPage, prefetchSettingsPage } from './router.js';
import { initWaterTankSocket } from './waterTank.js';
import { logger } from './logger.js';
import { deriveScreensaverAction, isMachineAsleep, isScreensaverSuppressed } from './screensaver-policy.js';
import { createMachineLinkWatcher, machineFromDevicesPayload } from './machine-link.js';
import { setMachineModel, isBengleMachine, setRefillKitPresent, isRefillKitPresent } from './machine.js';
import { classifyStopReason, canonicalStopReason, STOP_TARGET_WEIGHT, STOP_TARGET_VOLUME, STOP_PROFILE_ENDED } from './stop-reason.js';
import { resolveMilkProbePresence, MILK_PROBE_ABSENT_AFTER_MS, selectMilkProbeSensorId } from './steam-mode.js';
import { readTimeToReadyFrame, heatingSecondsLeft } from './heating-countdown.js';
import { workflowTileValues, changedTileValues } from './workflow-watch.js';
import { isCupWarmerOn, readCupWarmerTarget, resolvePrewarm, getCupWarmerState, setCupWarmerState, patchCupWarmerState, invalidateCupWarmerState, onCupWarmerStateChange, CUP_WARMER_TARGET_KEY } from './cup-warmer.js';
import { openDB, setSetting } from './idb.js';
import { openContextMenu } from './context-menu.js';
import { shouldHandleMachineShortcut } from './machine-shortcut.js';
import { initEcoSteam, noteEcoSteamActivity } from './eco-steam.js';
import { loadStyle } from './vendor-loader.js';
import { loadECharts } from './echarts-loader.js';
import { initHelpLauncher } from './help-launcher.js';
import { isVisualizerEnabled, isAutoUploadEnabled } from './visualizer.js';

window.app = { api, ui, chart };

// Export functions for UI and router access
window.handleWeightClick = handleWeightClick;
window.handleScaleData = handleScaleData;
window.loadInitialData = loadInitialData;
window.resetDataTimeout = resetDataTimeout;
window.onScaleDisconnect = onScaleDisconnect;
window.onScaleReconnect = onScaleReconnect;

// Array.prototype.at() is missing on the older Android WebViews some DE1
// tablets ship with, so read the last element by index instead.
function lastOf(arr) {
    return arr && arr.length ? arr[arr.length - 1] : undefined;
}

function initClockTicker() {
    const el = document.getElementById('data-clock');
    if (!el) return;
    const tick = () => {
        const now = new Date();
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        el.textContent = `${h}:${m}`;
    };
    tick();
    // Re-align to wall-clock minute so updates land on the second hand crossing 0.
    const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
    setTimeout(() => {
        tick();
        setInterval(tick, 60_000);
    }, msToNextMinute);
}

function initMobileValueInputs({ openModal, shouldUseNumpad }) {
    if (!shouldUseNumpad()) return;
    
    const valueElements = [
        { id: 'dose-in-value', type: 'dose-in', label: 'Dose In' },
        { id: 'drink-out-value', type: 'drink-out', label: 'Drink Out' },
        { id: 'temp-value', type: 'temperature', label: 'Temperature' },
        { id: 'grind-value', type: 'grind', label: 'Grind' },
        { id: 'steam-duration-value', type: 'steam-duration', label: 'Steam Duration' },
        { id: 'steam-flow-value', type: 'steam-flow', label: 'Steam Flow' },
        { id: 'flush-value', type: 'flush', label: 'Flush' },
        { id: 'hot-water-vol-value', type: 'hot-water-vol', label: 'Hot Water Volume' },
        { id: 'hot-water-temp-value', type: 'hot-water-temp', label: 'Hot Water Temp' }
    ];
    
    valueElements.forEach(({ id, type, label }) => {
        const el = document.getElementById(id);
        if (!el) return;
        
        el.style.cursor = 'pointer';
        // Tell browser this is for clicking, not text input
        el.style.touchAction = 'manipulation';
        el.style.webkitTapHighlightColor = 'transparent';
        el.setAttribute('tabindex', '-1');
        
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const currentValue = el.textContent.replace(/[^0-9.]/g, '') || '0';
            
            const mockInput = {
                value: currentValue,
                setAttribute: () => {},
                dispatchEvent: (event) => {
                    if (event.type === 'change' || event.type === 'input') {
                        const newVal = mockInput.value;
                        // temperature / hot-water-temp: newVal is in the active display
                        // unit (the numpad was seeded from el.textContent) — convert to
                        // Celsius before writing/displaying so the writer always gets Celsius.
                        const tempC = fromDisplayTemp(parseFloat(newVal));
                        el.textContent = type === 'temperature' ? formatTemp(tempC, 0) :
                                        type === 'grind' ? newVal :
                                        type === 'steam-duration' ? window.app.ui.formatSteamDuration((newVal === '' || isNaN(parseFloat(newVal))) ? 0 : parseFloat(newVal)) :
                                        type === 'steam-flow' ? newVal :
                                        type === 'flush' ? `${newVal}s` :
                                        type === 'hot-water-vol' ? `${newVal}ml` :
                                        type === 'hot-water-temp' ? formatTemp(tempC, 0) :
                                        `${newVal}g`;

                        if (type === 'dose-in') {
                            window.app.ui.updateDoseValue('in', newVal);
                            window.app.ui.updateDrinkRatio();
                        } else if (type === 'drink-out') {
                            window.app.ui.updateDoseValue('out', newVal);
                            window.app.ui.updateDrinkRatio();
                        } else if (type === 'temperature') {
                            window.app.ui.updateTemperatureValue(tempC);
                        } else if (type === 'steam-duration') {
                            // The numpad blanks a bare "0" to '' — treat empty/NaN as 0.
                            // 0 = steam off. Duration alone does NOT touch the heater
                            // (rest_v1.yml: SteamSettings.duration "does not control
                            // steam-heater preheating") — api.setTargetSteamDuration
                            // sends targetTemperature 0 alongside it, and restores the
                            // remembered temperature when steam is re-armed.
                            const v = (newVal === '' || isNaN(parseFloat(newVal))) ? 0 : parseFloat(newVal);
                            window.app.ui.updateSteamDisplay({ targetSteamDuration: v });
                            window.app.ui.pushSteamSetting('duration', window.app.api.setTargetSteamDuration(v));
                            // Per-profile save, same call the tile's +/- and presets make
                            // (ui.js) — this full-screen numpad entry point is mobile/tablet
                            // only (initMobileValueInputs guards on shouldUseNumpad()) and
                            // was missing it entirely, so a value typed here never stuck
                            // across a profile switch even though +/- worked fine.
                            window.app?.saveContextToActiveProfile?.({ targetSteamDuration: v });
                        } else if (type === 'steam-flow') {
                            // Numpad blanks a bare "0" to ''. Unlike duration, 0 steam
                            // flow has no meaning (steam is gated on duration, not flow),
                            // so floor empty/0/NaN to the 0.4 minimum the inline editor
                            // enforces — avoids NaN on screen.
                            const parsed = parseFloat(newVal);
                            const v = (newVal === '' || isNaN(parsed) || parsed < 0.4) ? 0.4 : parsed;
                            window.app.ui.updateSteamDisplay({ targetSteamFlow: v });
                            window.app.ui.pushSteamSetting('flow', window.app.api.setTargetSteamFlow(v));
                            window.app?.saveContextToActiveProfile?.({ targetSteamFlow: v });
                        } else if (type === 'flush') {
                            window.app.ui.updateFlushValue(parseFloat(newVal));
                            window.app.ui.updateFlushDisplay(parseFloat(newVal));
                        } else if (type === 'hot-water-vol') {
                            // The numpad blanks a bare "0" to '' — treat empty/NaN as 0.
                            // 0 = no volume cap: hot water then stops by time/manual, not
                            // volume. Sending 0 (not null) avoids the middleware 500.
                            const v = (newVal === '' || isNaN(parseFloat(newVal))) ? 0 : parseFloat(newVal);
                            window.app.ui.updateHotWaterDisplay({ targetHotWaterVolume: v });
                            window.app.api.setTargetHotWaterVolume(v).catch(e => logger.error('setTargetHotWaterVolume failed:', e));
                        } else if (type === 'hot-water-temp') {
                            window.app.ui.updateHotWaterDisplay({ targetHotWaterTemp: tempC });
                            window.app.api.setTargetHotWaterTemp(tempC).catch(e => logger.error('setTargetHotWaterTemp failed:', e));
                        } else if (type === 'grind') {
                            window.app.ui.updateGrindValue(newVal);
                        }
                    }
                }
            };
            
            openModal(mockInput, {
                previousValues: [],
                onConfirm: (val) => {},
                fieldType: type
            });
        });
    });
    
    logger.info('Mobile value inputs initialized');
}

// Display-label overrides for raw machine states whose camelCase split reads
// poorly. 'Out of water' is also an existing i18n key.
const STATE_LABEL_OVERRIDES = {
    needsWater: 'Out of water'
};

// Helper function to format state strings
function formatStateString(text) {
    if (!text) return '';
    if (STATE_LABEL_OVERRIDES[text]) return STATE_LABEL_OVERRIDES[text];
    // "camelCase" -> "Camel Case"
    const result = text.replace(/([A-Z])/g, ' $1');
    return result.charAt(0).toUpperCase() + result.slice(1).trim();
}

let shotStartTime = null;
let shotEndedAt = null;
// Bumped every time a new shot actually starts. shotStartTime itself can't
// serve as a "same shot?" token: it's nulled by the machine-snapshot feed
// (leaves ESPRESSO state) independently of the shotState feed's 'stop', so a
// weight-stop captured while it happened to already be null, followed by a
// second shot that also starts and ends before a slow 'finalize' arrives,
// would read as null === null and misidentify the shots as the same one.
// A counter that only ever increases has no such collision.
let shotGeneration = 0;
const SHOT_RESTART_COOLDOWN_MS = 5000;
let dataTimeout;
let de1DeviceId = null;
let isDe1Connected = false;
let isNonGhcMachine = false;
let isScaleConnected = false; // New variable to track Scale connection status
let previousState = {}; // Track previous machine state object {state, substate}
let currentActiveProfile = null; // Track active profile for shot-end reason detection

let latestScaleWeight = 0;
let latestScaleWeightFlow = null; // server-smoothed g/s from ScaleSnapshot; null until a frame arrives
let latestScaleBattery = null;
window.getLatestScaleBattery = () => latestScaleBattery;
window.getIsScaleConnected = () => isScaleConnected;
let isConnectingScale = false;
// Latest time-to-ready estimate ({ deadline, at } | null). The ttr socket owns the
// number, the DE1 snapshot owns "am I heating" — see heating-countdown.js.
let ttrHeating = null;

// Scale reconnect text state — driven by /ws/v1/devices scanning flag + wake grace window
let isScaleScanning = false;
let isInWakeGracePeriod = false;
let wakeGraceTimeout = null;
const WAKE_RECONNECT_GRACE_MS = 4000;

// Whether the devices feed currently lists any scale-type entry, connected or
// not (see handleDeviceWsData). This is what decides whether the not-connected
// weight slot shows "Retry" (a scale exists somewhere, worth retrying) or hides
// outright (nothing has ever been discovered/paired — nothing to retry). The
// devices feed is shared across the whole session (see connectDeviceWebSocket
// in api.js), so a scale connected from the Settings page while this page is
// hidden behind it updates this the same way and the slot is already showing
// the right thing by the time the user navigates back.
let isScaleKnown = false;
function deviceListHasScale(devices) {
    return devices.some(d => d.type === 'scale' ||
        (d.name && (d.name.toLowerCase().includes('scale') || d.name.toLowerCase().includes('weight'))));
}

// Scale auto-retry on disconnect
let scaleAutoRetryCount = 0;
let scaleAutoRetryTimer = null;
const SCALE_AUTO_RETRY_MAX = 3;
const SCALE_AUTO_RETRY_INTERVAL_MS = 5000;

function clearScaleAutoRetry() {
    clearTimeout(scaleAutoRetryTimer);
    scaleAutoRetryTimer = null;
    scaleAutoRetryCount = 0;
}

async function attemptScaleAutoRetry() {
    if (isScaleConnected) { clearScaleAutoRetry(); return; }
    if (scaleAutoRetryCount >= SCALE_AUTO_RETRY_MAX) { clearScaleAutoRetry(); return; }
    if (!getScaleDeviceId()) { clearScaleAutoRetry(); return; }
    try {
        const reaSettings = await getReaSettings();
        if (reaSettings?.scalePowerMode === 'disconnect') { clearScaleAutoRetry(); return; }
    } catch (_) { /* proceed */ }

    scaleAutoRetryCount++;
    logger.info(`Scale auto-retry ${scaleAutoRetryCount}/${SCALE_AUTO_RETRY_MAX}`);
    handleWeightClick();
    scaleAutoRetryTimer = setTimeout(attemptScaleAutoRetry, SCALE_AUTO_RETRY_INTERVAL_MS);
}

// Spinner shown in the weight slot while a scale scan is in flight. SMIL-animated
// so it spins without a CSS class (keeps the weight item narrow — no text width —
// so it never overflows the GHC column, and needs no Tailwind rebuild).
const SCAN_ICON_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="display:inline-block;vertical-align:middle" aria-label="Scanning"><path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" stroke-width="3" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/></path></svg>`;

function renderScanIcon() {
    const weightEl = document.getElementById('data-weight');
    const weightTextEl = document.getElementById('weight-text');
    if (weightTextEl) weightTextEl.classList.add('text-red-600');
    if (weightEl) {
        weightEl.classList.add('text-[var(--mimoja-blue)]');
        weightEl.classList.remove('text-[var(--text-primary)]');
        weightEl.innerHTML = SCAN_ICON_SVG;
    }
}

// Renders the not-connected weight slot. Two outcomes:
// - No scale has ever been discovered/paired (isScaleKnown false): hide the
//   slot outright. "Retry" implies there is something to retry; there isn't.
// - A scale is known but not currently connected: show it, with a scanning
//   spinner while a scan/wake-retry is actually in flight, "Retry" otherwise.
// Container is display:none by default in the HTML and only ever revealed
// here or on the first real weight frame (handleScaleData).
function renderScaleDisconnectedText() {
    if (isScaleConnected) return;
    const scaleInfoContainer = document.getElementById('scale-info-container');
    if (!isScaleKnown) {
        if (scaleInfoContainer) scaleInfoContainer.style.display = 'none';
        return;
    }
    if (scaleInfoContainer) scaleInfoContainer.style.display = '';
    const showScanning = isScaleScanning || isInWakeGracePeriod;
    if (showScanning) {
        renderScanIcon();
    } else {
        // 'Retry' is translated; most languages are short (German is longer but
        // the user accepts it here).
        ui.updateWeight(getTranslation('Retry'), {
            weightText: { add: ['text-red-600'] },
            dataWeight: { add: ['text-[var(--mimoja-blue)]'], remove: ['text-[var(--text-primary)]'] }
        });
    }
    // Retry text / spinner change the row's width — re-fit so it stays one line.
    fitTelemetry();
}

// ---------------------------------------------------------------------------
// Machine link: surviving the machine's power-cycle
//
// reaprime binds /ws/v1/machine/snapshot (and shotSettings, and waterLevels) to a
// De1 *instance*. On a power-cycle it builds a NEW machine object and neither
// re-binds those sockets nor CLOSES them — so they go open-but-silent, forever.
// ReconnectingWebSocket only retries on *close*, so it never notices, and the 5 s
// data timeout below used to latch isDe1Connected = false with nothing left alive
// to ever set it true again: "disconnected" until the app was reloaded.
//
// The /ws/v1/devices socket is bound to reaprime's DevicesStateAggregator, not to
// a machine instance, so it SURVIVES the power-cycle and keeps telling us the
// truth. We were already holding it open and reading only `scanning` from it.
// It is now the authority on link state, and a link-up re-opens the machine-bound
// sockets so the server re-binds them to the live machine.
//
// Belt and braces: this must be correct whether or not reaprime's server-side
// re-bind fix is present. Both fixes are safe together — the worst case is that
// the server closes the socket first and ReconnectingWebSocket heals it before we
// get here.
// ---------------------------------------------------------------------------

// Re-open every socket reaprime binds to a De1 instance, forcing it to re-run
// `_withDe1Ws` against the CURRENT machine. Proven on the bench: a fresh snapshot
// socket streams 97 frames in 6 s while the pre-existing one sits silent.
//
// All three factories close-before-open, so this does not leak a socket per
// power-cycle (the tell would be a doubled snapshot frame rate).
function resyncMachineSockets(reason) {
    logger.info(`Re-binding machine WebSockets to the live machine (${reason}).`);
    connectWebSocket(handleData, onMachineSnapshotSocketOpen);
    connectShotSettingsWebSocket(handleShotSettingsData);
    initWaterTankSocket();
    resetDataTimeout(); // fresh socket: give it the full window before judging it
}

const machineLink = createMachineLinkWatcher({
    onLinkUp: (deviceId) => {
        logger.info(`Machine link up (${deviceId}). Snapshot socket may be bound to a dead machine — resyncing.`);
        if (deviceId) de1DeviceId = deviceId;
        // Also un-sticks the Bluetooth-banner suppression in
        // handleDeviceConnectionError, which is gated on this same flag.
        isDe1Connected = true;
        resyncMachineSockets('machine link up');
        // The machine may come back ASLEEP, in which case handleData's reconnect
        // branch deliberately skips the reload — so do it here.
        loadInitialData();
    },
    onLinkDown: () => {
        logger.warn('Machine link down (devices feed).');
        isDe1Connected = false;
        ui.updateMachineStatus({ status: "Disconnected" });
    },
});

function handleDeviceWsData(data) {
    // reaprime #591 also broadcasts a DeviceConnectResult (deviceId/operation/
    // outcome/state) on this same channel after a connect command; it carries
    // no 'scanning' key, so don't let its absence read as "scanning stopped".
    if (data && 'scanning' in data) {
        const next = !!data.scanning;
        if (next !== isScaleScanning) {
            isScaleScanning = next;
            renderScaleDisconnectedText();
        }
    }
    // Same predicate settings.js's Bluetooth device list uses (renderDeviceListFromCache)
    // so "found" means the same thing in both places.
    if (data && Array.isArray(data.devices)) {
        const knownNow = deviceListHasScale(data.devices);
        if (knownNow !== isScaleKnown) {
            isScaleKnown = knownNow;
            if (!isScaleConnected) renderScaleDisconnectedText();
        }
    }
    // Edge-triggered, NOT id-diffed: the USB device id is byte-identical across a
    // power-cycle (it comes from the SAMD21 factory unique id), so watching for an
    // id change would silently never fire.
    //
    // This watcher supersedes the earlier ad-hoc rising-edge REST sync that lived
    // here (the DE1 late-connect fix): a late connect is a not-connected ->
    // connected edge, so onLinkUp resyncs the machine sockets and reloads data
    // for that case too.
    machineLink.update(data);
}

function onScaleReconnect() {
    logger.info('Scale WebSocket reconnected.');
}

function onScaleDisconnect() {
    logger.warn('Scale has disconnected.');
    isScaleConnected = false;
    window.onScaleConnectionChange?.(false);
    renderScaleDisconnectedText();
    clearScaleAutoRetry();
    scaleAutoRetryTimer = setTimeout(attemptScaleAutoRetry, SCALE_AUTO_RETRY_INTERVAL_MS);
}

const deviceErrorCopy = {
    scaleConnectFailed: 'Scale did not connect. Wake it and retry.',
    machineConnectFailed: 'DE1 did not connect. Retry scan.',
    scaleDisconnected: 'Scale dropped. Retry scan.',
    machineDisconnected: 'DE1 dropped. Retry scan.',
    adapterOff: 'Bluetooth is off. Turn it on to continue.',
    bluetoothPermissionDenied: 'Grant Bluetooth permission to continue.',
    scanFailed: 'Scan could not start. Retry.',
};

function handleDeviceConnectionError(err) {
    // scaleDisconnected is handled silently — the [Reconnect] UI on the main page covers it
    if (err.kind === 'scaleDisconnected') return;
    // Rea's quick-connect re-adopt emits machineDisconnected for the De1 instance
    // it just REPLACED -- "Quick-connect: machine adopted" -> "De1Controller -
    // resetting de1" -> emit, all inside 1 ms -- while the machine never left
    // (decaid#634 logs). The devices feed is the authority on link state (see the
    // machineLink block below), and it is now dispatched ahead of errors, so a
    // real drop has already flipped this to false by the time we read it.
    if (err.kind === 'machineDisconnected' && machineLink.isConnected()) return;
    // Adapter-level nags (Bluetooth off / permission missing) are meaningless
    // while a machine is already connected -- connected over USB serial with BT
    // off is a fully valid state, so don't tell the user to turn BT on. If the
    // machine is NOT connected the banner still shows, since BT may genuinely be
    // the missing piece.
    if ((err.kind === 'adapterOff' || err.kind === 'bluetoothPermissionDenied') && isDe1Connected) return;
    const msg = deviceErrorCopy[err.kind] ?? `${err.message}${err.suggestion ? `\n${err.suggestion}` : ''}`;
    ui.showToast(msg, 5000, 'error');
}

// The snapshot socket's onopen fires on every (re)connect — boot, a
// ReconnectingWebSocket auto-retry, and our own resync. Boot and resync share this
// handler so the two call sites cannot drift apart.
function onMachineSnapshotSocketOpen() {
    logger.info('Machine snapshot WebSocket (re)opened. Awaiting a frame to confirm the machine.');
    isDe1Connected = false; // the first frame re-confirms it (handleData)
}

// A silent snapshot socket is NOT proof of a disconnected machine — it is exactly
// what a stale, open-but-silent socket looks like after a power-cycle . Ask
// REA who is actually connected before painting a lie. Rate-limited so a genuinely
// absent machine is not hammered.
const DEVICES_PROBE_MIN_INTERVAL_MS = 10000;
let lastDevicesProbeAt = 0;
let devicesProbeInFlight = false;

function markMachineDisconnected() {
    ui.updateMachineStatus({ status: "disconnected" });
    isDe1Connected = false;
}

async function probeMachineOnSilentSocket() {
    const now = Date.now();
    if (devicesProbeInFlight || (now - lastDevicesProbeAt) < DEVICES_PROBE_MIN_INTERVAL_MS) {
        markMachineDisconnected(); // rate-limited: fall back to believing the silence
        return;
    }
    devicesProbeInFlight = true;
    lastDevicesProbeAt = now;
    try {
        const link = machineFromDevicesPayload(await getDevices());
        if (link.known && link.connected) {
            logger.warn('Snapshot socket silent for 5 s but REA reports the machine connected — stale socket. Resyncing.');
            if (link.deviceId) de1DeviceId = link.deviceId;
            isDe1Connected = true;
            resyncMachineSockets('stale snapshot socket');
            return;
        }
    } catch (err) {
        logger.warn('Devices probe failed while checking a silent machine socket:', err);
    } finally {
        devicesProbeInFlight = false;
    }
    markMachineDisconnected();
}

// Sets a timer. If no data is received within 5 seconds, the connection is stale —
// but "stale" may mean a dead socket rather than a dead machine, so check first.
function resetDataTimeout() {
    clearTimeout(dataTimeout);
    dataTimeout = setTimeout(() => {
        logger.warn('No WebSocket data received for 5 seconds. Checking whether the machine or the socket is gone.');
        probeMachineOnSilentSocket();
    }, 5000); // 5-second timeout
}

function isHeatingState(state, substate) {
    return state === MachineState.HEATING || (state === MachineState.IDLE && substate === 'preparingForShot');
}

async function pollForUploadConfirmation(shotId, timeout = 30000) {
    // Only wait on a confirmation the plugin is actually going to produce: with
    // auto-upload off, nothing uploads by itself and the poll would end in a
    // "Upload to Visualizer Failed." toast after every shot.
    if (!isAutoUploadEnabled()) {
        logger.info('Visualizer auto-upload is off. Skipping upload confirmation for shot ID:', shotId);
        return Promise.resolve(false); // Return resolved promise with false to indicate no upload happened
    }
    
    logger.info(`Polling for upload confirmation for shot ID: ${shotId}`);
    const pollInterval = 3000; // 3 seconds
    const startTime = Date.now();

    const checkUploadStatus = async (resolve, reject) => {
        if (Date.now() - startTime > timeout) {
            logger.warn(`Polling timed out for shot ${shotId}.`);
            ui.showToast(`Upload to Visualizer Failed.`, 3000, 'error');
            return reject(new Error('Polling timed out'));
        }

        try {
            const lastUploadedShotId = await getValueFromStore('visualizer.reaplugin', 'lastUploadedShot');
            logger.debug(`Polled lastUploadedShotId: ${lastUploadedShotId}`);

            if (lastUploadedShotId === shotId) {
                logger.info(`Successfully confirmed upload for shot ${shotId}.`);
                ui.showToast('Shot uploaded successfully!', 3000, 'success');
                return resolve(true);
            } else {
                setTimeout(() => checkUploadStatus(resolve, reject), pollInterval);
            }
        } catch (error) {
            logger.error('Error during polling for upload confirmation:', error);
            // Don't reject immediately, let it retry until timeout
            setTimeout(() => checkUploadStatus(resolve, reject), pollInterval);
        }
    };

    return new Promise(checkUploadStatus);
}

// Records the estimate only — handleData does the painting.
function handleTimeToReadyData(data) {
    ttrHeating = readTimeToReadyFrame(data, Date.now());
}

// The screensaver is a pure function of the machine's CONFIRMED state.
//
// The derived action is paint-only -- 'show' | 'hide' | 'none' -- so a snapshot
// frame is structurally incapable of commanding the machine. That is the whole
// bug: 'hide' used to be spelled ui.deactivateScreensaver(), which sent
// setMachineState('idle'), so this branch -- whose precondition is "the machine is
// awake" -- WOKE the machine. In the 46 ms after a sleep press, with the overlay
// optimistically up and the snapshot still reporting 'idle', that is the command
// that cancelled the user's sleep.
//
// The one concession to latency runs the OTHER way. When the user taps to wake, we
// hide the overlay immediately instead of making them watch it for a round-trip —
// so for the next frame or three the machine still (honestly) reports 'sleeping'
// and this function would raise the overlay straight back up. `wakePending` marks
// those frames as stale by our own doing. It is time-bounded, so a wake that never
// lands expires and the overlay returns: we decline to repaint a state we have
// asked the machine to leave, we never paint one it never reported.
function applyScreensaverAction(state) {
    // A firmware flash sleeps the machine for minutes; the overlay would cover the
    // progress bar the user is watching. Take it down if it is up, and stay down.
    if (isScreensaverSuppressed()) {
        if (ui.isScreensaverActive()) ui.hideScreensaver(); // PURE UI -- never a machine command
        return;
    }
    const action = deriveScreensaverAction({
        machineState: state,
        screensaverActive: ui.isScreensaverActive(),
        // Either mode raises the overlay: the image saver, or the black cover.
        // They are mutually exclusive in settings, but both need the overlay up --
        // the black one because tapping it is what wakes the machine.
        screensaverEnabled: localStorage.getItem('screensaverEnabled') !== 'false'
            || localStorage.getItem('blackScreenSaver') === 'true',
        wakePending: ui.isWakeRequestPending(),
    });
    if (action === 'show') {
        logger.info('Machine confirmed sleeping. Activating screensaver.');
        ui.activateScreensaver();
    } else if (action === 'hide') {
        ui.hideScreensaver(); // PURE UI -- never a machine command
    }

    // The machine has confirmed it is awake: the wake we were waiting on has
    // landed, so stop suppressing. (A wake superseded by a sleep press is cleared
    // by the sleep button itself.)
    if (!isMachineAsleep(state)) ui.clearWakeRequest();
}

// ── Milk probe (Bengle) ──────────────────────────────────────────────────────
// A Bengle's onboard milk probe is NOT part of the machine snapshot: reaprime's
// MachineSnapshot has no milkTemperature field (confirmed against reaprime's
// machine.dart and rest_v1.yml's MachineSnapshot schema — neither has ever had
// one). The value only exists on SteamSnapshot, which itself is never streamed
// live; the actual live path is the generic sensor bus — GET /api/v1/sensors
// lists the probe (auto-registered by reaprime's BengleProbeBridge while
// physically attached) and ws/v1/sensors/<id>/snapshot streams its readings.
// pollMilkProbeSensor() below owns discovery/(re)subscription; each resolved
// reading is folded here the same way a per-frame value would be, so presence
// survives brief drop-outs and only clears after a sustained absence
// (resolveMilkProbePresence, steam-mode.js). The main-screen steam tile
// consumes this through ui.setMilkProbePresent (Milk-mode gating + probe-loss
// un-arm); the settings steam page through window.app.getMilkProbe (render-time
// state) and window.onMilkProbeUpdate (live ticks + presence flips).
let milkProbeState = { present: false, lastPositiveMs: null };
let latestMilkTemp = 0; // last positive reading while present; 0 when absent
function updateMilkProbeFromSnapshot(tempC) {
    milkProbeState = resolveMilkProbePresence(milkProbeState, tempC, Date.now());
    if (typeof tempC === 'number' && isFinite(tempC) && tempC > 0) {
        latestMilkTemp = tempC;
    } else if (!milkProbeState.present) {
        latestMilkTemp = 0;
    }
    ui.setMilkProbePresent(milkProbeState.present); // no-op until presence flips
    ui.updateMilkTelemetry(milkProbeState.present, latestMilkTemp); // top-row Milk °C field, per frame
    window.onMilkProbeUpdate?.(milkProbeState.present, latestMilkTemp);
}
window.app.getMilkProbe = () => ({ present: milkProbeState.present, temperature: latestMilkTemp });

// Sensor-bus feed for the milk probe (see comment above). currentMilkSensorId
// tracks which sensor id the snapshot socket is bound to so a change (or
// disappearance) on the next poll re-subscribes instead of leaking a socket.
// latestSensorReadingAtMs marks when a reading last actually arrived; a
// reading older than MILK_PROBE_ABSENT_AFTER_MS is treated as no reading this
// tick, same as resolveMilkProbePresence would treat a 0/absent snapshot field.
let currentMilkSensorId = null;
let latestSensorTemp = null;
let latestSensorReadingAtMs = null;

function handleMilkSensorSnapshot(frame) {
    const t = frame?.temperature;
    if (typeof t === 'number' && isFinite(t)) {
        latestSensorTemp = t;
        latestSensorReadingAtMs = Date.now();
    }
}

const MILK_PROBE_SENSOR_POLL_MS = 3000; // comfortably under MILK_PROBE_ABSENT_AFTER_MS (5s)

async function pollMilkProbeSensor() {
    let sensors;
    try {
        sensors = await getSensors();
    } catch (error) {
        logger.warn('Milk-probe sensor poll failed:', error);
        return;
    }
    const id = selectMilkProbeSensorId(sensors);
    if (id === currentMilkSensorId) return;
    currentMilkSensorId = id;
    latestSensorTemp = null;
    latestSensorReadingAtMs = null;
    if (id) {
        connectSensorSnapshotWebSocket(id, handleMilkSensorSnapshot);
    } else {
        closeSensorSnapshotWebSocket();
    }
}

function initMilkProbeSensorPolling() {
    pollMilkProbeSensor();
    setInterval(pollMilkProbeSensor, MILK_PROBE_SENSOR_POLL_MS);
}

/** Reading to feed updateMilkProbeFromSnapshot this machine-snapshot tick. */
function currentMilkProbeReading() {
    if (latestSensorReadingAtMs === null) return undefined;
    if (Date.now() - latestSensorReadingAtMs >= MILK_PROBE_ABSENT_AFTER_MS) return undefined;
    return latestSensorTemp;
}

function handleData(data) {
    if (!data?.state) {
        logger.warn('Received WebSocket message with missing state:', data);
        return;
    }

    resetDataTimeout(); // Reset the timer every time data is received.

    const { state, substate } = data.state;
    const wasHeating = isHeatingState(previousState.state, previousState.substate);
    const isHeating = isHeatingState(state, substate);
    // 0 = no fresh estimate; the snapshot still decides whether we're heating at all.
    const heatingSeconds = isHeating ? heatingSecondsLeft(ttrHeating, Date.now()) : 0;
    let statusString;

    // Drop a stale estimate as soon as the machine leaves any heating state, so a
    // later heat-up can't briefly inherit the previous one.
    if (wasHeating && !isHeating) {
        ttrHeating = null;
    }

    // Determine the status string based on state and substate
    if (state === MachineState.ERROR) {
        statusString = "Error";
    } else if (state === MachineState.SLEEPING) {
        applyScreensaverAction(state);
        statusString = "Sleeping";
    } else {
        applyScreensaverAction(state);
        if (isHeating) {
            // English on purpose: ui.updateMachineStatus pattern-matches this string
            // and translates at render time (ui.js heatingStatusParts).
            statusString = heatingSeconds > 0 ? `Heating: ${heatingSeconds}s remaining` : "Heating";
        } else {
            const formattedState = formatStateString(state);
            const formattedSubstate = formatStateString(substate);
            statusString = formattedState;

            // Append substate if it's meaningful and not redundant
            if (formattedSubstate && formattedSubstate.toLowerCase() !== 'idle' && formattedSubstate.toLowerCase() !== formattedState.toLowerCase()) {
                statusString += ` (${formattedSubstate})`;
            }
        }

        // No tank-level warning here on purpose: "Out of water" now means the
        // DE1's own needsWater state and nothing else. The level-vs-threshold
        // heuristic used to overwrite statusString while decaid still reported
        // idle, so the skin and the machine disagreed.
    }

    // Detect DE1 reconnection
    if (state !== MachineState.ERROR && !isDe1Connected) {
        isDe1Connected = true;
        // No paint here: the full-payload updateMachineStatus below runs in this same
        // tick. Painting statusString without the isHeating flags made the reconnect
        // frame fall through to the generic renderer (plain text, no coloured spans).
        if (state !== MachineState.SLEEPING) {
            logger.info('DE1 machine reconnected. Loading initial data.');
            loadInitialData(); // Refresh all configuration data
        }
        // Do not clear chart or reset shotStartTime as per user request
    } else if (state === MachineState.ERROR && isDe1Connected) {
        logger.warn('DE1 machine connected with error status.');
        isDe1Connected = false;
        ui.updateMachineStatus({ status: "Disconnected" }); // Show disconnected when in error state
    }

    // Reload data when machine wakes from sleep
    const wasSleeping = previousState.state === MachineState.SLEEPING;
    if (wasSleeping && state !== MachineState.SLEEPING && state !== MachineState.ERROR) {
        logger.info('Machine woke from sleep. Reloading initial data.');
        loadInitialData();

        // Hold off "[Reconnect]" — REA fires devices ws scanning ~3s after wake.
        // Show "Scanning..." until grace window expires or scanning flag arrives.
        if (!isScaleConnected) {
            isInWakeGracePeriod = true;
            clearTimeout(wakeGraceTimeout);
            wakeGraceTimeout = setTimeout(() => {
                isInWakeGracePeriod = false;
                renderScaleDisconnectedText();
            }, WAKE_RECONNECT_GRACE_MS);
            renderScaleDisconnectedText();
        }
    }

    // Check if the machine is in an error state that indicates disconnection
    if (state === MachineState.ERROR) {
        // Log the edge only. Snapshots keep arriving at ~10 Hz while the machine is
        // gone, and logging every one of them filled the host's WebView console log
        // (1 MB every ~2 min) for as long as the DE1 stayed disconnected.
        if (previousState.state !== MachineState.ERROR) {
            logger.warn('DE1 machine in error state, likely disconnected.');
        }
        isDe1Connected = false;
        ui.updateMachineStatus({ status: "Disconnected" });
    }

    // Check for shot completion (transition from 'espresso' to 'ready' or 'idle').
    // If the shotState feed tracked this shot, it already owns the stop toast,
    // history refresh, and upload confirmation — the heuristics below are the
    // gateway-mode fallback (no sequencer -> feed stays idle -> seqTrackedShot false).
    if (previousState.state === MachineState.ESPRESSO && (state === MachineState.READY || state === MachineState.IDLE) && seqTrackedShot) {
        logger.info('Shot finished — handled by shotState feed; skipping stop-reason heuristics.');
        scheduleStopToastBackstop();
    } else if (previousState.state === MachineState.ESPRESSO && (state === MachineState.READY || state === MachineState.IDLE)) {
        logger.info('Shot finished. Checking for upload confirmation and refreshing history.');

        (async () => {
            const totalS = shotData.getTotalTime();

            // Detect REA-side block: very short transition + no scale + setting enabled
            const BLOCKED_SHOT_THRESHOLD_S = 3;
            if (totalS < BLOCKED_SHOT_THRESHOLD_S && !isScaleConnected) {
                try {
                    const reaSettings = await getReaSettings();
                    if (reaSettings?.blockOnNoScale) {
                        ui.showToast(getTranslation('Shot blocked: no scale connected'), 4000, 'error');
                        return;
                    }
                } catch { /* fall through to normal stop reason */ }
            }

            // Stop-reason reconstruction — gateway-mode fallback only; when the
            // shotState feed ran this shot it owns the toast (guard above).
            // Ordering and tolerances live in stop-reason.js, which explains why
            // TIME is decided first.
            ui.showToast(fallbackStopToast(), 6000, 'info');

            // Start polling for upload confirmation
            setTimeout(async () => {
                try {
                    const shotIds = await getShotIds();
                    if (shotIds && shotIds.length > 0) {
                        const latestShotId = shotIds[shotIds.length - 1];
                        pollForUploadConfirmation(latestShotId);
                    } else {
                        logger.warn('Could not get latest shot ID to confirm upload.');
                    }
                } catch (error) {
                    logger.error('Failed to initiate upload polling:', error);
                }
            }, 2000); // Delay to ensure shot is saved on server

            // Capture the current newest id NOW (before the new shot lands) so
            // the refresh knows which record is the just-finished one to wait for.
            const previousNewestId = history.getNewestShotId();
            history.refreshToNewestShot(previousNewestId);
        })();
    }
    previousState = data.state; // Update previous state

    // Update GHC stop button opacity: active (not idle/sleeping/error) = fully opaque
    const isActiveState = state !== MachineState.IDLE &&
                          state !== MachineState.SLEEPING &&
                          state !== MachineState.ERROR;
    // Using the machine from its own buttons counts as interaction for eco
    // steam -- without this, a steam pulled from the GHC leaves the tablet
    // untouched and the boiler drops as if the machine had sat idle.
    if (isActiveState) noteEcoSteamActivity();
    ui.updateGhcStopButton(isActiveState);
    ui.updateSidebarOverlay(state);

    // Update UI elements
    // Pass detailed status information to match the enhanced updateMachineStatus function
    ui.updateMachineStatus({
        status: statusString,
        state: state,
        substate: substate,
        stepName: formatStateString(substate), // Use formatted substate as step name
        timeValue: data.elapsedTime, // Use elapsed time from data if available
        isClickable: (substate === 'preinfusion' || substate === 'pouring'), // Make preinfusion/pouring steps clickable
        isHeating: isHeating, // Pass heating state to UI
        isHeatingFromTimeToReady: heatingSeconds > 0, // countdown available -> render the two-colour form
        steamTemperature: data.steamTemperature // Steam boiler temp — gates the steam "Heating" message
    });
    ui.updateSleepButton(state);
    ui.updateTemperatures({ mix: data.mixTemperature, group: data.groupTemperature, steam: data.steamTemperature });
    updateMilkProbeFromSnapshot(currentMilkProbeReading());

    // Update Chart and Shot Data Table
    if (MachineState.ESPRESSO.includes(state)) {
        // Only start the shot clock and chart when preinfusion or pouring starts
        // This excludes the "preparingForShot" phase from the shot timing
        if (substate === 'preinfusion' || substate === 'pouring') {
            if (!shotStartTime) {
                if (shotEndedAt && (Date.now() - shotEndedAt) < SHOT_RESTART_COOLDOWN_MS) {
                    return;
                }
                shotStartTime = new Date(data.timestamp);
                shotGeneration++;
                // Feed frames during this shot re-assert it; stays false in
                // gateway mode so the fallback heuristics run at shot end.
                seqTrackedShot = false;
                seqStopToastShown = false;
                chart.clearChart();
                shotData.clearShotData();
                const historyLabelEl = document.getElementById('shot-history-label');
                if (historyLabelEl) {
                    historyLabelEl.textContent = getTranslation('NEWEST');
                }
            }
            // Bengle: use the machine's true gravimetric flow (GFlow) straight from
            // the snapshot — no local delta+EMA smoothing. Non-Bengle keeps the
            // external-scale path (ScaleSnapshot server-smoothed g/s → EMA fallback).
            // `?? null` (not || 0): 0 is a real GFlow value; only an ABSENT field
            // may fall through to the chart's local EMA.
            const chartWeightFlow = isBengleMachine() ? (data.weightFlow ?? null) : latestScaleWeightFlow;
            chart.updateChart(shotStartTime, data, latestScaleWeight, chartWeightFlow);
            shotData.updateShotData(data, latestScaleWeight);
        }
    } else {
        if (shotStartTime) {
            shotEndedAt = Date.now();
            // Clear before finalizing, and guard the finalize itself. A throw
            // in there used to unwind past the reset and strand shotStartTime:
            // every later idle frame retried the same failing finalize, and --
            // because the next shot's reset hangs off `if (!shotStartTime)` --
            // that shot appended to the previous shot's arrays instead of
            // starting clean. Issue #73, where a 3s flush reported 72995s
            // because it was still measuring from a shot 20 hours earlier.
            // The catch also keeps the blame local: uncaught, this surfaced in
            // the WebView console as "Error parsing WebSocket message", which
            // points at the JSON parser rather than the chart.
            shotStartTime = null;
            try {
                chart.finalizeLiveChart();
            } catch (error) {
                logger.error('finalizeLiveChart failed; shot ended without final labels:', error);
            }
        }
    }
}

// Throttle function to limit the rate of execution
function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

const throttledUpdateWeight = throttle(ui.updateWeight, 100); // 100ms throttle interval

function handleScaleData(data) {
    // Any message at all on the scale's own snapshot socket proves one exists,
    // regardless of whether the devices feed has confirmed it yet — don't let
    // renderScaleDisconnectedText's isScaleKnown gate hide a scale that is
    // demonstrably right here sending us frames (e.g. a battery-only frame).
    isScaleKnown = true;
    const scaleInfoContainer = document.getElementById('scale-info-container');
    const currentWeight = data.weight;
    latestScaleWeight = currentWeight;
    latestScaleWeightFlow = data.weightFlow ?? null; // server-smoothed flow for the chart's weight trace
    const batteryValue = data.batteryLevel ?? data.battery;
    if (batteryValue !== null && batteryValue !== undefined) {
        const wasNull = latestScaleBattery === null;
        latestScaleBattery = batteryValue;
        if (wasNull && document.getElementById('bluetooth-scale-devices-container')) {
            window.renderDeviceListFromCache?.();
        }
    }

    // Receiving any message means the websocket and BLE link are up.
    // The timeout in api.js will trigger a disconnect if data stops flowing.

    if (currentWeight !== null && currentWeight !== undefined) {
        // We have a weight, so we are fully connected.
        if (!isScaleConnected) {
            logger.info('Scale reconnected.');
            isScaleConnected = true;
            window.onScaleConnectionChange?.(true);
            clearScaleAutoRetry();
            if (scaleInfoContainer) {
                scaleInfoContainer.style.display = '';
            }
        }
        // Update the UI with the new weight and reset styles.
        throttledUpdateWeight(currentWeight, {
            weightText: { remove: ['text-red-600'] },
            dataWeight: { remove: ['text-[var(--mimoja-blue)]'] }
        });
        // Carry settled weight through to the shot total card so it tracks the scale
        // after substate leaves 'pouring' (drip-down).
        shotData.setFinalWeight(currentWeight);
    } else {
        // We received a message without a weight.
        if (!isScaleConnected) {
            renderScaleDisconnectedText();
        }
        // debug, not warn: weightless frames repeat for as long as the scale is
        // away (and some scales send battery-only frames while connected), so one
        // warn each flooded the host's WebView console log. The connect and
        // disconnect edges are already logged either side of this.
        logger.debug('Scale message received without weight data.');
    }
}

async function handleWeightClick() {
    if (isScaleConnected) {
        try {
            await tareScale();
            ui.showToast('Scale tared', 2000, 'success');
        } catch (error) {
            ui.showToast('Failed to tare scale', 3000, 'error');
        }
        return;
    }

    // Untappable while a scan is already in flight (or grace window after wake)
    if (isScaleScanning || isInWakeGracePeriod) return;

    if (isConnectingScale) return;

    isConnectingScale = true;
    // Show the scanning spinner immediately (instead of a 'Connecting...' text
    // placeholder that flashed briefly and was wider/unstyled).
    renderScanIcon();

    try {
        const deviceWs = getDeviceWebSocket();
        if (!deviceWs || deviceWs.readyState !== WebSocket.OPEN) {
            initDeviceWebSocketWithCallback(
                () => {
                    sendDeviceCommand({ command: 'scan', connect: true });
                },
                handleDeviceWsData,
                () => {},
                () => {},
                handleDeviceConnectionError
            );
        } else {
            sendDeviceCommand({ command: 'scan', connect: true });
        }
        logger.info('Scale connection initiated via WebSocket, waiting for weight data...');
        let attempts = 0;
        const maxAttempts = 15;
        const poll = setInterval(async () => {
            attempts++;

            // Checked BEFORE the give-up branch: weight arriving on the last tick
            // must still count as success, not as a "Scale Not Found" toast.
            //
            // Weight already flowing = connected, whatever the transport. A USB or
            // integrated scale never produces a `state: "connected"` row in
            // /devices (no BLE connect handshake — it sits at "discovered"), so
            // the devices check below would run out the clock and toast "Scale
            // Not Found" at a scale that is plainly working. handleScaleData is
            // the app's authority on this everywhere else; defer to it here too.
            if (isScaleConnected) {
                clearInterval(poll);
                isConnectingScale = false;
                return;
            }

            if (attempts > maxAttempts) {
                clearInterval(poll);
                ui.showToast('Scale Not Found', 3000, 'error');
                isConnectingScale = false;
                // Show vs. hide is decided by isScaleKnown (the live devices feed),
                // not by this one attempt's own outcome — see renderScaleDisconnectedText.
                renderScaleDisconnectedText();
                return;
            }

            try {
                const devices = await getDevices();
                const scale = devices.find(d => d.type === 'scale' && d.state === 'connected');

                if (scale) {
                    clearInterval(poll);
                    saveScaleDeviceId(scale.id);
                    logger.info('Scale BLE link established. Re-initializing WebSocket connection.');
                    isConnectingScale = false;
                    // Re-create the WebSocket with proper handlers to ensure a clean connection.
                    connectScaleWebSocket(
                        handleScaleData,
                        onScaleReconnect,
                        onScaleDisconnect
                    );
                }
            } catch (pollError) {
                // Ignore poll errors, let it retry
            }
        }, 1000);
    } catch (error) {
        ui.showToast('Failed to initiate scale connection', 3000, 'error');
        isConnectingScale = false;
        renderScaleDisconnectedText();
    }
}

// ── ShotState feed (ws/v1/machine/shotState) ────────────────────────────────
// Authoritative shot phase + decision frames from Rea's shot sequencer. When
// frames arrive for a shot they replace the snapshot-based stop-reason
// heuristics in handleData, which stay as fallback: in full gateway mode no
// sequencer runs and this feed stays idle.
let seqTrackedShot = false;   // sequencer emitted frames for the current shot
let seqLastState = 'idle';
let seqScaleLostWarned = false;
let seqHistoryRefreshed = false;
let seqUploadPolled = false;
let seqStopToastShown = false; // a stop/abort/terminal toast fired for this shot

// Reconstruct the stop toast from the finished shot. Used when no sequencer
// decision is available: gateway mode, and the backstop below.
function fallbackStopToast() {
    const finishedShot = shotData.getCurrentShot();
    const totalS = shotData.getTotalTime();
    const finalWeight = finishedShot.finalWeight ?? lastOf(finishedShot.weights) ?? latestScaleWeight;
    const finalVolume = lastOf(finishedShot.volumes) ?? 0;
    const reason = classifyStopReason({
        totalS, finalWeight, finalVolume, isScaleConnected, ...getActiveShotTargets(),
    });
    return formatStopReason(reason, { weight: finalWeight, volume: finalVolume, totalS });
}

// The feed owns the stop toast, so handleData stands its fallback down as soon
// as the sequencer emits ANY frame for the shot — which a pouring frame does,
// long before the decision. If the socket then blips at shot end and swallows
// the stop frame, nobody toasts and the shot ends silently. That is the same
// blip seqRefreshHistory already guards the history refresh against (it accepts
// stop OR finalize); the toast had no equivalent.
//
// The delay is not optional: the two sockets are independent, so on a perfectly
// healthy connection the machine's ESPRESSO->READY snapshot can arrive before
// the decision frame. Toasting immediately would double up. It must also stay
// well under SHOT_RESTART_COOLDOWN_MS, which is what stops a new shot from
// calling clearShotData() out from under the deferred read below.
const STOP_TOAST_BACKSTOP_MS = 2000;
function scheduleStopToastBackstop() {
    setTimeout(() => {
        if (seqStopToastShown) return; // the feed delivered it after all
        // Nothing was poured (fewer than two samples), so there is no ending to
        // report — an espresso state entered and left without a pour.
        if (shotData.getTotalTime() === 0) return;
        logger.warn('Shot finished but no shotState decision arrived — using reconstructed stop reason.');
        ui.showToast(fallbackStopToast(), 6000, 'info');
    }, STOP_TOAST_BACKSTOP_MS);
}

// Refresh the history panel to the finished shot and confirm its upload.
// Fired from stop/terminal AND finalize (first one wins): the feed replays
// only its latest frame on reconnect, so a socket blip at shot end can
// swallow the finalize frame — hanging the refresh on it alone left the
// panel showing the previous shot.
function seqRefreshHistory(shotId) {
    if (!seqHistoryRefreshed) {
        seqHistoryRefreshed = true;
        history.refreshToNewestShot(history.getNewestShotId(), 6, 2000, shotId ?? null);
    }
    if (shotId && !seqUploadPolled) {
        seqUploadPolled = true;
        pollForUploadConfirmation(shotId);
    }
}

// The translation sheet's stop-reason keys end at the colon ("Stopped by weight:",
// with fr "Arrêt en fonction du poids :"), so the measured value is appended rather
// than substituted into a {value} placeholder. Asking for a key that carries the
// placeholder finds no row and silently falls back to English.
function stopReasonText(key, value) {
    return `${getTranslation(key)} ${value}`;
}

// Weight-stop label with no number (see formatStopReason) — the translated key
// still ends in a colon meant for an appended value, so drop it rather than
// show a dangling "Stopped by weight:". Handles the half-width colon used by
// most languages and the full-width "：" used by the zh rows, each optionally
// preceded by a space (fr: "poids :").
function stopReasonLabel(key) {
    return getTranslation(key).replace(/[:：]\s*$/, '');
}

// Render a canonical stop reason (see stop-reason.js) as the toast text. Both
// the shotState feed and the gateway-mode fallback answer in that one
// vocabulary, so this is the only place the four messages are built.
// `weight` is still computed by both callers — canonicalStopReason/
// classifyStopReason need it to decide the reason — it is just no longer
// rendered, so it is not destructured here.
function formatStopReason(reason, { volume, totalS }) {
    switch (reason) {
        // Weight is intentionally not shown for now: projectedWeight is a live
        // estimate that can read a couple grams off the settled annotations.actualYield,
        // and showing a number that then silently corrects itself a few seconds
        // later (see the 'finalize' handling below) read as more confusing than
        // just naming the reason.
        case STOP_TARGET_WEIGHT:
            return stopReasonLabel('Stopped by weight:');
        case STOP_TARGET_VOLUME:
            return stopReasonText('Stopped by volume:', `${Math.round(volume)}ml`);
        case STOP_PROFILE_ENDED:
            return stopReasonText('Stopped by time:', `${totalS.toFixed(1)}s`);
    }
    // apiStop / appStop / stoppingBackstop, a machineEnded we could not pin to a
    // cause, 'unknown' from the fallback, a reason whose number did not parse —
    // and any unrecognised value: the wire enum is an open set.
    return `${getTranslation('Shot Stopped')}: ${totalS.toFixed(1)}s`;
}

// The active profile's stop targets. Prefer the live active record: favorite-button
// switches update profileManager's active record but not the local
// currentActiveProfile (only set on page load). targetYield (metadata, set via UI)
// overrides profile.target_weight everywhere else (profileManager.js:599) — mirror
// that precedence or the weight stop reason is missed when only the metadata yield
// was changed.
function getActiveShotTargets() {
    const activeRecord = profileManager.getActiveProfileRecord();
    const activeProfile = activeRecord?.profile ?? currentActiveProfile;
    return {
        targetWeight: parseFloat(activeRecord?.metadata?.targetYield ?? activeProfile?.target_weight ?? 0),
        targetVolume: parseFloat(activeProfile?.target_volume ?? 0),
        profileSeconds: (activeProfile?.steps ?? [])
            .reduce((sum, st) => sum + (parseFloat(st.seconds) || 0), 0),
    };
}

function shotStateStopMessage(decision, machineHasAutonomousSAW) {
    const { targetWeight, profileSeconds } = getActiveShotTargets();
    const totalS = shotData.getTotalTime();
    const weight = parseFloat(decision.data?.projectedWeight ?? latestScaleWeight);
    const volume = lastOf(shotData.getCurrentShot()?.volumes) ?? 0;

    // Normalise the one reason whose meaning is hardware-dependent BEFORE
    // rendering, so the same shot reads the same on a Bengle and a plain DE1.
    const reason = canonicalStopReason(decision.reason, {
        machineHasAutonomousSAW, isScaleConnected, weight, targetWeight, totalS, profileSeconds,
    });
    return { text: formatStopReason(reason, { weight, volume, totalS }), reason };
}

// Set once a weight-stop toast has fired for the shot currently settling, so
// the 'finalize' branch below knows whether a corrected weight is worth
// fetching. projectedWeight at 'stop' is a live estimate; annotations.actualYield
// only exists a few seconds later, once the server has measured the decaying
// post-stop flow and clamped for a removed cup — 'finalize' is exactly that
// "settling closed" moment, so it's the first point the real number exists.
// `gen` is the shotGeneration at the moment of the stop: currentShot
// (shotData.js) has no id of its own, so this stands in for one — if a new
// shot has started by the time 'finalize' arrives, shotGeneration has moved
// on and the guard below skips writing a stale shot's yield onto it. A
// counter, not shotStartTime, because shotStartTime is nulled independently
// by the machine-snapshot feed and can be null at both capture and check time
// even after a full extra shot has started and ended in between.
let seqWeightStop = null; // { shotId, gen } | null

function handleShotStateEvent(frame) {
    if (!frame?.event) return;

    const active = frame.state && frame.state !== 'idle' && frame.state !== 'finished';
    // Any active-shot or decision frame proves the sequencer is running this
    // shot, so handleData's fallback heuristics stand down.
    if (active || frame.decision) seqTrackedShot = true;
    if (active && (seqLastState === 'idle' || seqLastState === 'finished')) {
        seqScaleLostWarned = false;
        seqHistoryRefreshed = false;
        seqUploadPolled = false;
        seqStopToastShown = false;
    }
    seqLastState = frame.state ?? seqLastState;

    // Scale dropped mid-shot. Sticky per spec: stop-at-weight stays disabled
    // for the rest of the shot even if the scale reconnects — warn once.
    if (frame.scaleLost && active && !seqScaleLostWarned) {
        seqScaleLostWarned = true;
        ui.showToast(getTranslation('Scale lost — stop at weight disabled'), 6000, 'error');
    }

    const d = frame.decision;
    if (!d) return;

    // Every branch below that toasts an ENDING marks the backstop satisfied.
    if (d.kind === 'abort' || d.kind === 'stop' || d.kind === 'terminal') seqStopToastShown = true;

    switch (d.kind) {
        case 'abort':
            ui.showToast(d.reason === 'noScale'
                ? getTranslation('Shot blocked: no scale connected')
                : (d.details || `${getTranslation('Shot Stopped')}: ${shotData.getTotalTime().toFixed(1)}s`),
                4000, 'error');
            break;
        case 'stop': {
            const { text, reason } = shotStateStopMessage(d, frame.machineHasAutonomousSAW);
            ui.showToast(text, 6000, 'info');
            seqWeightStop = reason === STOP_TARGET_WEIGHT ? { shotId: frame.shotId, gen: shotGeneration } : null;
            seqRefreshHistory(frame.shotId);
            break;
        }
        case 'terminal':
            // Abnormal end (error / disconnect).
            ui.showToast(d.details || `${getTranslation('Shot Stopped')}: ${shotData.getTotalTime().toFixed(1)}s`, 6000, 'error');
            seqWeightStop = null;
            seqRefreshHistory(frame.shotId);
            break;
        case 'finalize':
            // Post-stop settling closed — the shot record is persisted, so
            // annotations.actualYield now exists if the shot was weight-stopped.
            // Correct the shot-total card with the real settled figure. No
            // toast: the 'stop' toast no longer shows a number to correct
            // (see formatStopReason), so a second toast here would just repeat
            // the same text with nothing new to say.
            if (frame.shotId && seqWeightStop?.shotId === frame.shotId) {
                const capturedGen = seqWeightStop.gen;
                seqWeightStop = null;
                api.getShots({ ids: frame.shotId, limit: 1 }).then(({ items } = {}) => {
                    const actualYield = items?.[0]?.annotations?.actualYield;
                    if (!Number.isFinite(actualYield)) return;
                    // Only stamp the card if this is still the same shot —
                    // a new shot may have started while the fetch was in flight.
                    if (shotGeneration === capturedGen) shotData.setFinalWeight(actualYield);
                }).catch(error => logger.warn('Could not fetch actualYield for finalized shot:', error));
            }
            seqRefreshHistory(frame.shotId);
            break;
        // advance frames: chart already tracks step changes via profileFrame
    }
}

// The three ShotSettings fields that are also main-page tile values with a KV
// record behind them (websocket_v1.yml ShotSettings). Steam flow, the milk stop
// and the flush duration are NOT in that payload, so no frame can move them.
const SHOT_SETTINGS_KV_FIELDS = [
    ['targetSteamDuration', api.STEAM_DURATION_LAST_VALUE_KEY, api.setTargetSteamDuration],
    ['targetHotWaterVolume', api.HOT_WATER_VOLUME_LAST_VALUE_KEY, api.setTargetHotWaterVolume],
    ['targetHotWaterTemp', api.HOT_WATER_TEMP_LAST_VALUE_KEY, api.setTargetHotWaterTemp],
];
// Last value each field arrived with, so a steady stream of identical frames
// doesn't become a steady stream of KV lookups.
const lastSeenShotSettings = {};
// When each field was last actually re-pushed. The seen-check above only
// suppresses REPEATS of one value, so a machine that ALTERNATES between the
// drifted value and ours slips past it on every single frame -- one lagging DE1
// shot-settings echo is enough to start that, and nothing stopped it. decaid
// gh-678: 190 PUT /workflow in 27 s (~7/s), each one a KV read, a KV write and
// two BLE writes, with the DE1 reporting 54 C and 75 C in near-perfect
// alternation (284 frames vs 287) until the BLE link was reset mid-shot and the
// shot went unrecorded.
//
// A genuine drift is still corrected on the FIRST frame that shows it; only a
// second correction of the same field is made to wait. The clock starts when we
// actually push -- a check that found nothing to do costs nothing and must not
// delay the next real one.
const RESYNC_COOLDOWN_MS = 30000;
const lastResyncAt = {};

// The boot resync runs once; a shotSettings frame can move these at any time
// after it (BLE reconnect, Rea restart, the machine's own tablet, another skin)
// and updateSteamDisplay/updateHotWaterDisplay repaint from it unconditionally.
// Re-run the same comparison on every frame that actually changes one, so the
// user's setting is restored instead of silently sitting wrong until reload.
//
// Rate-limited per field: see RESYNC_COOLDOWN_MS. Without that this does not
// converge -- it only converges if a machine that will not take our value keeps
// reporting the SAME number, and a DE1 under a fast write stream reports the
// old one and the new one alternately instead.
function resyncDriftedShotSettings(data) {
    const now = Date.now();
    for (const [field, key, push] of SHOT_SETTINGS_KV_FIELDS) {
        const value = data[field];
        if (value === undefined || value === lastSeenShotSettings[field]) continue;
        lastSeenShotSettings[field] = value;
        if (now - (lastResyncAt[field] ?? 0) < RESYNC_COOLDOWN_MS) continue;
        // Claimed before the await, not after: at frame rate a dozen more frames
        // arrive before this resolves, and every one of them would pass the
        // check above. Released again only when there was nothing to push -- an
        // outright failure keeps the cooldown, since retrying it at frame rate
        // is the storm this exists to stop.
        lastResyncAt[field] = now;
        api.resyncIfDrifted(key, value, push)
            .then(pushed => { if (pushed == null) delete lastResyncAt[field]; })
            .catch(e => logger.warn(`${field} drift resync failed:`, e));
    }
}

async function handleShotSettingsData(data) {
    updateShotSettingsCache(data);
    ui.updateHotWaterDisplay(data);

    // Update steam display with the data received from the WebSocket
    // Avoiding unnecessary API call to get DE1 settings on every WebSocket message
    ui.updateSteamDisplay(data);

    resyncDriftedShotSettings(data);
}

async function loadInitialData() {
    logger.debug("loadInitialData triggered.");
    try {
        if (document.readyState === 'loading') {
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
        }

        const workflow = await getWorkflow();
        logger.debug("Workflow data received:", workflow);

        const profile = workflow?.profile;
        const context = workflow?.context;
        const doseData = workflow?.doseData; // Legacy fallback
        const grinderData = workflow?.grinderData; // Legacy fallback
        const flushtimeout = workflow?.rinseData;

        // Get the profile manager to access the favorite assignments
        const profileManagerModule = await import('./profileManager.js');
        const favoriteButtons = [];
        const FAV_COUNT = 5;

        for (let i = 0; i < FAV_COUNT; i++) {
            const button = document.getElementById(`fav-profile-btn-${i}`);
            if (button) {
                favoriteButtons.push(button);
                logger.info(`Found favorite button with ID: fav-profile-btn-${i}`); // Log found buttons
            } else {
                logger.info(`Favorite button with ID: fav-profile-btn-${i} not found`);
            }
        }
        
        if (profile) {
            ui.updateProfileName(profile.title || "Untitled Profile");
            logger.info(`Active profile: ${profile.title}`);
            currentActiveProfile = profile;

            // Bind the save target for the sidebar tiles BEFORE anything can be
            // edited. The favourite-button scan below used to be the only thing
            // that did this, so a loaded profile sitting in no favourite slot
            // left the id null and every dose/yield/grind/temp edit was thrown
            // away instead of being saved onto that profile.
            profileManagerModule.syncActiveProfileFromTitle(profile.title);

            // Set the current profile in the chart module for step change detection
            chart.setCurrentProfile(profile);
            logger.info('Profile set in chart module for step change detection');
            
            // Highlight the active profile button based on assignment rather than text matching
            // This is more reliable since it uses the internal assignment mapping
            if (profileManagerModule.favoriteAssignments && favoriteButtons.length > 0) {
                logger.debug('Using assignment mapping to highlight favorite button');
                
                // Find which button has the current profile assigned to it
                for (let i = 0; i < FAV_COUNT; i++) {
                    const assignedProfileKey = profileManagerModule.favoriteAssignments[i];
                    const button = favoriteButtons[i];
                    
                    logger.debug(`Checking favorite button ${i}: assignedProfileKey=${assignedProfileKey}, button exists=${!!button}`);
                    
                    if (button && assignedProfileKey) {
                        // Get the profile record to compare with the active profile
                        const assignedProfileRecord = profileManagerModule.availableProfiles[assignedProfileKey];
                        
                        logger.debug(`Assigned profile record for button ${i}: `, assignedProfileRecord);
                        
if (assignedProfileRecord && assignedProfileRecord.profile &&
                            assignedProfileRecord.profile.title === profile.title) {
                            // This button has the active profile assigned to it
                            const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                            const activeTextClass = 'text-white';
                            const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                            const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                            const defaultBgClass = 'bg-[var(--profile-button-background-color)]';

                            logger.info(`Marking button at index ${i} as active for profile ${profile.title}. Adding: ${activeBgClass}, ${activeTextClass}. Removing: ${inactiveTextClass}. Current classes: ${button.className}`);
                            button.classList.add(activeBgClass, activeTextClass);
                            button.classList.remove(inactiveTextClass, defaultTextClass, defaultBgClass);
                            logger.info(`Button ${i} classes after change: ${button.className}`);
                        } else {
                            // This button doesn't have the active profile, ensure it's not highlighted
                            const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                            const activeTextClass = 'text-white';
                            const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                            const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                            const defaultBgClass = 'bg-[var(--profile-button-background-color)]';

                            logger.info(`Marking button ${i} as inactive. Removing: ${activeBgClass}, ${activeTextClass}. Adding: ${inactiveTextClass}. Current classes: ${button.className}`);
                            button.classList.remove(activeBgClass, activeTextClass);
                            button.classList.add(inactiveTextClass, defaultTextClass, defaultBgClass);
                            logger.info(`Button ${i} classes after change: ${button.className}`);
                        }
                    } else if (button) {
                        // Button exists but no profile assigned, ensure it's not highlighted
                        const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                        const activeTextClass = 'text-white';
                        const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                        const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                        const defaultBgClass = 'bg-[var(--profile-button-background-color)]';

                        logger.info(`Button ${i} has no assignment. Removing: ${activeBgClass}, ${activeTextClass}. Adding: ${inactiveTextClass}. Current classes: ${button.className}`);
                        button.classList.remove(activeBgClass, activeTextClass);
                        button.classList.add(inactiveTextClass, defaultTextClass, defaultBgClass);
                        logger.info(`Button ${i} classes after change: ${button.className}`);
                    }
                }
            } else {
                logger.debug('Assignment mapping not available, using text matching fallback');
                
                // Fallback to the original text matching approach if the assignment mapping isn't available
                favoriteButtons.forEach((btn, index) => {
                    const activeBgClass = 'bg-[var(--mimoja-blue-v2)]';
                    const activeTextClass = 'text-white';
                    const inactiveTextClass = 'text-[var(--mimoja-blue)]';
                    const defaultTextClass = 'text-[var(--profile-button-text-color)]';
                    const defaultBgClass = 'bg-[var(--profile-button-background-color)]';
                    const buttonText = btn.textContent.trim();
                    const profileTitle = profile.title;

                    logger.debug(`Checking button ${index} with text: \"${buttonText}\" against profile: \"${profileTitle}\"`);

                    if (buttonText === profileTitle) {
                        logger.info(`[FALLBACK] Marking button ${index} as active for profile ${profileTitle}. Adding: bg-[var(--mimoja-blue-v2)], text-white. Current classes: ${btn.className}`);
                        btn.classList.add(activeBgClass, activeTextClass);
                        btn.classList.remove(inactiveTextClass, defaultTextClass, defaultBgClass);
                        logger.info(`[FALLBACK] Button ${index} classes after change: ${btn.className}`);
                    } else {
                        logger.info(`[FALLBACK] Marking button ${index} as inactive. Removing: bg-[var(--mimoja-blue-v2)], text-white. Adding: text-[var(--mimoja-blue)]. Current classes: ${btn.className}`);
                        btn.classList.remove(activeBgClass, activeTextClass);
                        btn.classList.add(inactiveTextClass, defaultTextClass, defaultBgClass);
                        logger.info(`[FALLBACK] Button ${index} classes after change: ${btn.className}`);
                    }
                });
            }
            
            if (profile.steps && profile.steps.length > 0) {
                ui.updateTemperatureDisplay(profile.steps[0].temperature || 0);
            }
        }

        if (flushtimeout !== undefined) {
            logger.debug('Received flush timeout data:', flushtimeout);
            ui.updateFlushDisplay(flushtimeout.duration);
        }
        // Outside the guard on purpose: a workflow with no rinseData at all is
        // exactly the case where the user's remembered value most needs
        // pushing. resyncIfDrifted no-ops when nothing was ever remembered.
        // Repaint what the resync pushed: the tile above was painted from the
        // workflow, which is by definition the value the push just overrode.
        api.resyncIfDrifted(api.FLUSH_DURATION_LAST_VALUE_KEY, flushtimeout?.duration, (v) => ui.updateFlushValue(v))
            .then(v => { if (v != null) ui.updateFlushDisplay(v); })
            .catch(e => logger.warn('Flush duration resync failed:', e));

        // Update grind display - prefer context.grinderSetting over legacy grinderData.setting
        if (context?.grinderSetting) {
            ui.updateGrindDisplay({ grinderSetting: context.grinderSetting });
        } else if (grinderData?.setting) {
            ui.updateGrindDisplay(grinderData);
        } else {
            const grindEl = document.getElementById('grind-value');
            if (grindEl) grindEl.textContent = '0';
        }
        logger.debug("Dose data received:", context || doseData);
        
        const doseInValue = context?.targetDoseWeight ?? doseData?.doseIn;
        const doseOutValue = context?.targetYield ?? doseData?.doseOut;
        
        if (doseInValue !== undefined) ui.updateDoseInDisplay(doseInValue);
        if (doseOutValue !== undefined) ui.updateDrinkOut(doseOutValue);
        ui.updateDrinkRatio();

        const hotwatersettings = workflow?.hotWaterData;
        const steamsettings = workflow?.steamSettings;
        if (hotwatersettings) {
            ui.updateHotWaterDisplay({ targetHotWaterVolume: hotwatersettings.volume, targetHotWaterTemp: hotwatersettings.targetTemperature });
        }
        // Re-push whenever the workflow disagrees with what the user last set — a
        // plain GET can't tell us the device itself stayed in sync (BLE reconnect
        // / Rea restart can leave it stale). Runs outside the guard above so an
        // absent hotWaterData still gets the remembered values. See
        // api.resyncIfDrifted.
        api.resyncIfDrifted(api.HOT_WATER_VOLUME_LAST_VALUE_KEY, hotwatersettings?.volume, api.setTargetHotWaterVolume)
            .then(v => { if (v != null) ui.updateHotWaterDisplay({ targetHotWaterVolume: v }); })
            .catch(e => logger.warn('Hot water volume resync failed:', e));
        api.resyncIfDrifted(api.HOT_WATER_TEMP_LAST_VALUE_KEY, hotwatersettings?.targetTemperature, api.setTargetHotWaterTemp)
            .then(v => { if (v != null) ui.updateHotWaterDisplay({ targetHotWaterTemp: v }); })
            .catch(e => logger.warn('Hot water temp resync failed:', e));

        // Resolve the machine model BEFORE the first updateSteamDisplay:
        // Bengle-only steam UI (an armed milk stop persisted in the workflow)
        // must be able to restore visually on boot, so the Bengle gate has to
        // be set before the steam display first renders.
        let machineInfo = null;
        try {
            machineInfo = await getMachineInfo();
        } catch (e) {
            logger.warn('Could not fetch machine info; Bengle gating stays off:', e);
        }
        setMachineModel(machineInfo?.model ?? null);
        // Undocumented but reported: MachineInfo.extra.refillKit. A plumbed
        // machine parks the tank on the refill line, so the level-based
        // low-water warning has to stay quiet on one (issue #60).
        setRefillKitPresent(machineInfo?.extra?.refillKit ?? null);

        // Bengle-only cup-warmer entry in the telemetry row. Fails closed: a
        // failed machine-info fetch leaves the gate off and the entry hidden.
        // Also re-runs on a live machine swap (loadInitialData fires again via
        // machineLink.onLinkUp) -- hide it explicitly when the newly connected
        // machine isn't a Bengle, since the entry starts hidden but nothing
        // else re-hides it once shown.
        if (isBengleMachine()) {
            initCupWarmerToggle();
        } else {
            const cupWarmerEl = document.getElementById('cupwarmer-info-container');
            if (cupWarmerEl) cupWarmerEl.style.display = 'none';
        }

        if (steamsettings) {
            // Workflow steamSettings speaks {flow, duration, ...} while
            // updateSteamDisplay speaks {targetSteamFlow, targetSteamDuration},
            // so both have to be mapped by name -- the spread alone contributes
            // nothing, and an unmapped duration leaves steam-duration-value on
            // its 0 default until a shot-settings frame happens to arrive.
            // This boot paint is the ONLY feed of the persisted flow into the
            // tile: the shot-settings WS carries no steam flow field, and the
            // old "restore selected preset" push in
            // setSteamFlowPresetsFromMachineModel is gone (it was
            // resetting the stored flow, not painting it).
            ui.updateSteamDisplay({
                ...steamsettings,
                ...(typeof steamsettings.duration === 'number' && isFinite(steamsettings.duration)
                    ? { targetSteamDuration: steamsettings.duration } : {}),
                ...(typeof steamsettings.flow === 'number' && isFinite(steamsettings.flow)
                    ? { targetSteamFlow: steamsettings.flow } : {}),
            });
        }
        // Outside the guard: an absent steamSettings is not a reason to drop the
        // user's remembered targets. The milk stop keeps its own armed-only
        // guard — 0/absent there means the stop is off, a real choice.
        api.resyncIfDrifted(api.STEAM_DURATION_LAST_VALUE_KEY, steamsettings?.duration, api.setTargetSteamDuration)
            .then(v => { if (v != null) ui.updateSteamDisplay({ targetSteamDuration: v }); })
            .catch(e => logger.warn('Steam duration resync failed:', e));
        api.resyncIfDrifted(api.STEAM_FLOW_LAST_VALUE_KEY, steamsettings?.flow, api.setTargetSteamFlow)
            .then(v => { if (v != null) ui.updateSteamDisplay({ targetSteamFlow: v }); })
            .catch(e => logger.warn('Steam flow resync failed:', e));
        api.resyncMilkStopIfDrifted(steamsettings?.stopAtTemperature)
            .then(v => { if (v != null) ui.updateSteamDisplay({ stopAtTemperature: v }); })
            .catch(e => logger.warn('Milk stop resync failed:', e));

        // Show GHC machine controls column only for non-GHC machines, and pick steam-flow
        // presets based on machine model (group-head size).
        try {
            if (machineInfo && machineInfo.GHC === false) {
                isNonGhcMachine = true;
                ui.showGhcControls();
            }
            await ui.setSteamFlowPresetsFromMachineModel(machineInfo?.model ?? null);
        } catch (e) {
            logger.warn('Could not init GHC controls / steam presets:', e);
            // Fall back to standard presets so the UI still works offline
            await ui.setSteamFlowPresetsFromMachineModel(null);
        }

        // Boot painted every tile from this document, so it is the baseline the
        // watch diffs against -- without it the first poll would repaint
        // everything as "changed".
        seedWorkflowTiles(workflow);
        startWorkflowWatch();
        return workflow;
    } catch (error) {
        logger.error("Failed to load initial data:", error);
        ui.updateProfileName("Error loading profile");
        return null;
    }
}

// ── Workflow watch ───────────────────────────────────────────────────────────
//
// Nothing pushes workflow changes to us: Decaid has no workflow WebSocket and
// GET /workflow has no revision to poll cheaply, so a change made in Decaid's UI,
// another skin, or a DYE2 page sits invisible on the dashboard until something
// re-reads the document. Re-read it when the user comes back to the app, and on
// a slow timer for a change made while they are looking at it.
//
// Only fields that actually moved on the server get repainted, so a poll landing
// while the user is mid-edit cannot overwrite the value they are setting -- their
// tile has not reached the server yet, so it reads as unchanged. A different
// profile means a wholesale repaint, name included, since a profile switch moves
// the brew temp and the title together.
const WORKFLOW_POLL_MS = 60_000;
const WORKFLOW_REFRESH_MIN_GAP_MS = 2000; // focus + visibilitychange can both fire
// A tile's push is debounced by a second, so "the server matches my baseline" is
// not enough to prove the user is not mid-edit: their first press can already
// have landed while a later one is still pending. Hold off entirely while a tile
// was touched recently -- repainting then would reassign the very variable the
// pending push is about to send.
const WORKFLOW_EDIT_GUARD_MS = 5000;
let lastWorkflowTiles = null;
let lastWorkflowRefreshAt = 0;
let workflowWatchStarted = false;

const WORKFLOW_TILE_PAINTERS = {
    grind: v => ui.updateGrindDisplay({ grinderSetting: String(v) }),
    dose: v => ui.updateDoseInDisplay(v),
    yield: v => { ui.updateDrinkOut(v); ui.updateDrinkRatio(); },
    brewTemp: v => ui.updateTemperatureDisplay(v),
    steamDuration: v => ui.updateSteamDisplay({ targetSteamDuration: v }),
    steamFlow: v => ui.updateSteamDisplay({ targetSteamFlow: v }),
    milkStop: v => ui.updateSteamDisplay({ stopAtTemperature: v }),
    hotWaterVolume: v => ui.updateHotWaterDisplay({ targetHotWaterVolume: v }),
    hotWaterTemp: v => ui.updateHotWaterDisplay({ targetHotWaterTemp: v }),
    flush: v => ui.updateFlushDisplay(v),
};

export function seedWorkflowTiles(workflow) {
    lastWorkflowTiles = workflowTileValues(workflow);
}

async function refreshWorkflowTiles() {
    // On a sub-page the tiles are not mounted, so a repaint would go nowhere and
    // updating the snapshot would swallow the change. Skip entirely; the next
    // tick after the user returns to the dashboard picks it up.
    if (isSubPage()) return;
    // Leaves the snapshot untouched so the change is re-detected on the next tick,
    // once the user has stopped adjusting.
    if (ui.msSinceTileInteraction() < WORKFLOW_EDIT_GUARD_MS) return;
    const now = Date.now();
    if (now - lastWorkflowRefreshAt < WORKFLOW_REFRESH_MIN_GAP_MS) return;
    lastWorkflowRefreshAt = now;

    let workflow;
    try {
        workflow = await getWorkflow();
    } catch (e) {
        logger.warn('Workflow refresh failed:', e);
        return;
    }
    if (!workflow) return;

    const tiles = workflowTileValues(workflow);
    const changed = changedTileValues(lastWorkflowTiles, tiles);
    lastWorkflowTiles = tiles;
    const keys = Object.keys(changed);
    if (keys.length === 0) return;

    logger.info(`Workflow changed elsewhere: ${keys.join(', ')}`);
    if ('profileTitle' in changed) {
        // A profile switch moves more than the tiles: the chart's step tracking,
        // the active-profile record and the favourite highlight all follow it.
        // loadInitialData is the path that does all of that -- dyeStrip's
        // refreshAfterApply picks it for the same reason -- and it re-seeds the
        // snapshot on the way out.
        await loadInitialData();
        return;
    }
    for (const key of keys) WORKFLOW_TILE_PAINTERS[key]?.(changed[key]);
}

function startWorkflowWatch() {
    if (workflowWatchStarted) return;
    workflowWatchStarted = true;
    setInterval(refreshWorkflowTiles, WORKFLOW_POLL_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshWorkflowTiles();
    });
    window.addEventListener('focus', refreshWorkflowTiles);
}

async function isShotBlockedByNoScale() {
    if (isScaleConnected) return false;
    try {
        const reaSettings = await getReaSettings();
        if (!reaSettings?.blockOnNoScale) return false;
    } catch {
        return false;
    }
    ui.showToast('No scale connected — shot blocked', 4000, 'error');
    return true;
}

// ── Bengle cup-warmer quick toggle (telemetry row) ────────────────────────
// Reflects/toggles the warmer live via /machine/cupWarmer (temperature 0 = off).
// Uses the same target the Settings → Cup Warmer page stores in localStorage.
//
// On/off state is NOT kept here: this button and the Settings → Cup Warmer
// page both render from the ONE shared snapshot in ./cup-warmer.js (the old
// boot-seeded local boolean was one of three diverging copies — audit I1 /
// bench checklist 2b). initCupWarmerToggle runs from loadInitialData on boot
// AND on every machine (re)connect/wake, so a reconnect invalidates the
// snapshot and re-seeds it fresh; the subscription below repaints the button
// whenever anyone (this button, the Settings page, its ~5 s poll) updates the
// store — #main-page is display-toggled, never rebuilt, so the element and
// this one subscription live for the whole session.
async function initCupWarmerToggle() {
    invalidateCupWarmerState(); // (re)connect: drop any stale snapshot before re-seeding
    const el = document.getElementById('cupwarmer-info-container');
    if (!el) return;
    el.style.display = '';
    try {
        const data = await api.getCupWarmer();
        setCupWarmerState(data || { temperature: 0 });
    } catch (e) {
        // Model already said Bengle — keep the button. The snapshot stays null
        // (renders as "off") and the Settings page refetches on entry.
    }
    if (!el.dataset.wired) { // idempotent: init runs again on reconnect flows
        el.dataset.wired = '1';
        el.addEventListener('click', toggleCupWarmerFromHeader);
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCupWarmerFromHeader(); }
        });
    }
    startCupWarmerHeaderPoll();
}

// The whole point of a scheduled pre-warm is that the FIRMWARE starts the mat on
// its own — typically at 06:30, with the tablet sitting on the main page and
// nobody touching it. Nothing else on that page ever refetches the cup warmer
// (the ~5 s poll belongs to the Settings page), so without this the button would
// only ever learn about a pre-warm on a reconnect: the "Pre-warming" label would
// essentially never appear in the one scenario it exists for.
//
// A minute is the right cadence — the firmware's lead time is minute-granular —
// and it costs one GET/min. On firmware without the registers the app latches the
// failed register read per connection, so this does not re-enter a read-timeout
// ladder every tick. The revalidate folds into the SHARED store, so when the
// Settings page is open its faster poll simply supersedes this one.
let cupWarmerHeaderPollTimer = null;
const CUP_WARMER_HEADER_POLL_MS = 60_000;
function startCupWarmerHeaderPoll() {
    if (cupWarmerHeaderPollTimer !== null) return; // idempotent across reconnects
    cupWarmerHeaderPollTimer = setInterval(async () => {
        try {
            const data = await api.getCupWarmer();
            if (data) setCupWarmerState(data);
        } catch (e) {
            // Transient/disconnected: keep the last snapshot rather than
            // inventing an "off". A reconnect re-seeds it via initCupWarmerToggle.
        }
    }, CUP_WARMER_HEADER_POLL_MS);
}
onCupWarmerStateChange(() => updateCupWarmerButton());
function updateCupWarmerButton() {
    const el = document.getElementById('cupwarmer-info-container');
    if (!el) return;
    const state = getCupWarmerState();
    const on = isCupWarmerOn(state?.temperature);
    // A scheduled pre-warm runs the mat BY ITSELF -- at 06:30, with the machine
    // still asleep and the boilers cold. The reading would just come up with no
    // explanation, which reads as a bug. MatPreheatActive is the firmware saying
    // "that was me", so we say so in the label. It is null on firmware without
    // the register, and a null is never fabricated into a `true` -- old firmware
    // simply keeps the plain "Cups" label.
    const prewarming = resolvePrewarm(state).active;
    const labelKey = prewarming ? 'Pre-warming' : 'Cups';
    const labelEl = document.getElementById('cupwarmer-text');
    if (labelEl && labelEl.dataset.i18nKey !== labelKey) {
        // Swap the i18n KEY too, not just the text: translatePage() rewrites
        // textContent from the key on every language change, and would otherwise
        // silently revert the label (the #sleep-button precedent in ui.js).
        labelEl.setAttribute('data-i18n-key', labelKey);
        labelEl.textContent = getTranslation(labelKey);
    }
    el.setAttribute('aria-label', getTranslation(
        prewarming ? 'Cup warmer pre-warming for a scheduled wake' : 'Toggle Cup Warmer',
    ));
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    // The VALUE carries the on/off state -- an off warmer reads "--". Dimming the
    // entry was tried and rejected: it made the row's blue look unlike Weight's,
    // and the entry IS the toggle, so it must stay full-strength and tappable.
    const valueEl = document.getElementById('data-cupwarmer-temp');
    if (!valueEl) return;
    // Prefer the live mat reading; firmware without `currentTemperature` falls
    // back to the setpoint the mat is holding.
    const live = state?.currentTemperature;
    const shown = !on ? null
        : ((typeof live === 'number' && Number.isFinite(live)) ? live : state.temperature);
    valueEl.textContent = shown === null ? '--' : formatTemp(shown, 0);
}
// The reading is Celsius-canonical; a unit-preference flip must repaint it now
// rather than at the next ~60 s poll (the ui.js telemetry precedent).
document.addEventListener('streamline:unitchange', () => updateCupWarmerButton());
async function toggleCupWarmerFromHeader() {
    const target = readCupWarmerTarget(localStorage.getItem(CUP_WARMER_TARGET_KEY));
    const next = !isCupWarmerOn(getCupWarmerState()?.temperature);
    try {
        await api.setCupWarmer(next ? target : 0);
        // Store notify repaints this button and any open Settings page; merging
        // keeps the last currentTemperature reading visible there.
        patchCupWarmerState({ temperature: next ? target : 0 });
        ui.showToast(next ? 'Cup warmer on' : 'Cup warmer off', 2000, 'success');
    } catch (e) {
        ui.showToast('Failed to set cup warmer', 3000, 'error');
    }
}

// Delegated listener on document — survives all DOM replacements, no re-wiring needed
const GHC_STATE_MAP = {
    'ghc-coffee-btn': MachineState.ESPRESSO,
    'ghc-water-btn': MachineState.HOT_WATER,
    'ghc-steam-btn': MachineState.STEAM,
    'ghc-flush-btn': MachineState.FLUSH,
    'ghc-stop-btn': MachineState.IDLE,
};
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[id^="ghc-"]');
    if (!btn || !GHC_STATE_MAP[btn.id]) return;
    const targetState = GHC_STATE_MAP[btn.id];
    if (targetState === MachineState.ESPRESSO && await isShotBlockedByNoScale()) return;
    try {
        await setMachineState(targetState);
    } catch (err) {
        logger.error(`GHC state change failed (${btn.id}):`, err);
    }
});

export function initGhcButtonHandlers() {} // no-op — delegation handles it

const DEFAULT_KEY_BINDINGS = {
    'w': MachineState.HOT_WATER,
    'f': MachineState.FLUSH,
    ' ': MachineState.IDLE,
    's': MachineState.STEAM,
    'e': MachineState.ESPRESSO,
    'p': MachineState.SLEEPING,
};

function getKeyboardStateMap() {
    try {
        const saved = JSON.parse(localStorage.getItem('keyboardBindings') || '{}');
        const map = { ...DEFAULT_KEY_BINDINGS };
        for (const [stateValue, newKey] of Object.entries(saved)) {
            // remove old key bound to this state
            for (const [k, v] of Object.entries(map)) {
                if (v === stateValue) { delete map[k]; break; }
            }
            map[newKey] = stateValue;
        }
        return map;
    } catch { return { ...DEFAULT_KEY_BINDINGS }; }
}

document.addEventListener('keydown', async (e) => {
    if (!isDe1Connected || !isNonGhcMachine) return;
    const onMainPage = !isSubPage() && document.getElementById('main-page')?.style.display === '';
    if (!shouldHandleMachineShortcut(e, onMainPage, !!document.querySelector('dialog[open]'))) return;
    const state = getKeyboardStateMap()[e.key];
    if (!state) return;
    e.preventDefault();
    if (state === MachineState.ESPRESSO && await isShotBlockedByNoScale()) return;
    try {
        await setMachineState(state);
    } catch (err) {
        logger.error(`Keyboard shortcut state change failed (${e.key}):`, err);
    }
});

async function initializeDe1Connection() {
    try {
        logger.info('Attempting to find DE1 device...');
        
        // Try fast method first
        let devices = await getDevices();
        let de1Machine = devices.find(d => d.type === 'machine' && d.state === 'connected');
        
        // If not found, try the slower, more reliable scan
        if (!de1Machine) {
            logger.warn('DE1 not found with fast method. Trying fallback scan...');
            devices = await scanForDevices();
            de1Machine = devices.find(d => d.type === 'machine' && d.state === 'connected');
        }
        
        if (de1Machine) {
            de1DeviceId = de1Machine.id;
            logger.info(`DE1 machine ID found and stored: ${de1DeviceId}`);
            
            // Update connection status based on actual device state
            if (de1Machine.state === 'connected') {
                logger.info('DE1 machine is connected.');
                isDe1Connected = true;
                // Don't update status here - let handleData manage it based on actual machine state
            } else {
                logger.warn('DE1 machine is found but not connected.');
                isDe1Connected = false;
                ui.updateMachineStatus({ status: "disconnected" });
            }
        } else {
            logger.error('DE1 machine not found or not connected even after fallback scan.');
            isDe1Connected = false;
            ui.updateMachineStatus({ status: "disconnected" });
        }
    } catch (error) {
        logger.error('Failed to initialize DE1 device ID:', error);
        isDe1Connected = false;
        ui.updateMachineStatus({ status: "disconnected" });
    }
}

async function initVisualizer() {
    if (!isVisualizerEnabled()) {
        logger.info('Visualizer is disabled. Skipping initialization.');
        return;
    }
    
    logger.info('Initializing Visualizer connection...');
    const username = localStorage.getItem('visualizerUsername');
    const encodedPassword = localStorage.getItem('visualizerPassword');

    if (username && encodedPassword) {
        try {
            const password = atob(encodedPassword); // Decode password
            const isValid = await verifyVisualizerCredentials(username, password);
            if (isValid) {
                logger.info('Saved Visualizer credentials are valid.');

            } else {
                logger.warn('Saved Visualizer credentials failed to validate. Please check your settings.');
                // Clearing the invalid credentials
                localStorage.removeItem('visualizerUsername');
                localStorage.removeItem('visualizerPassword');
            }
        } catch (e) {
            logger.error('Failed to decode or verify saved credentials', e);
            // Clear potentially corrupted credentials
            localStorage.removeItem('visualizerUsername');
            localStorage.removeItem('visualizerPassword');
        }
    } else {
        logger.info('No saved Visualizer credentials found.');
    }
}

// Resolves as soon as history.initHistory() has populated the shots array --
// long before the rest of initMainPageOnce() (DE1 connect, visualizer, six+
// websockets) finishes. The router awaits this alone to repaint the chart
// ASAP on return from a sub-page, instead of blocking on unrelated work.
let resolveHistoryReady;
const historyReadyPromise = new Promise(resolve => { resolveHistoryReady = resolve; });

let mainPageInitialized = false;
let mainPageInitPromise = null;
async function initMainPageOnce() {
    if (mainPageInitialized) return;
    if (mainPageInitPromise) return mainPageInitPromise;
    mainPageInitPromise = (async () => {
        logger.info('initMainPageOnce: starting.');
        const historyInit = history.initHistory().then(resolveHistoryReady);
        await Promise.all([historyInit, profileManager.init()]);
        window.app.saveGrindToActiveProfile = (val) => profileManager.saveGrindToActiveProfile(val);
        window.app.saveContextToActiveProfile = (fields) => profileManager.saveContextToActiveProfile(fields);
        window.app.getActiveProfileRecord = () => profileManager.getActiveProfileRecord();
        const workflow = await loadInitialData();
        await initializeDe1Connection();
        connectWebSocket(handleData, onMachineSnapshotSocketOpen);
        connectScaleWebSocket(handleScaleData, onScaleReconnect, onScaleDisconnect);
        connectDeviceWebSocket(handleDeviceWsData, () => {}, () => {}, handleDeviceConnectionError);
        initWaterTankSocket();
        initClockTicker();
        connectTimeToReadyWebSocket(handleTimeToReadyData);
        connectShotStateWebSocket(handleShotStateEvent);
        connectDisplayWebSocket((data) => logger.debug('Display state updated:', data));
        // Re-apply the user's brightness. REA does not persist it, so without this
        // a restart comes back at whatever the OS picks -- and if the app died
        // while the saver had it at 0, the tablet stays dark. Deferred so the
        // display socket has delivered a frame to compare against; it only pushes
        // when the live level actually differs.
        setTimeout(() => { restoreBrightnessFromStorage(); }, 1500);
        ensureGatewayModeTracking();
        resetDataTimeout();
        initMilkProbeSensorPolling();
        connectShotSettingsWebSocket(handleShotSettingsData);
        void initVisualizer().catch(error => logger.error('Visualizer initialization failed:', error));
        mainPageInitialized = true;
        logger.info('initMainPageOnce: finished.');
        return workflow;
    })().catch(err => {
        mainPageInitPromise = null; // allow retry on next showMainPage
        logger.error('initMainPageOnce failed:', err);
        throw err;
    });
    return mainPageInitPromise;
}
window.app.initMainPageOnce = initMainPageOnce;
window.app.historyReady = () => historyReadyPromise;
// True while a shot is being recorded — lets the router skip repainting history
// over a live chart when returning to the main page.
window.app.isShotActive = () => shotStartTime !== null;
// Lets the router blank the shared #plotly-chart element the instant we
// return to the main page, before the async history repaint lands — without
// this the profile-selector's last-plotted profile curve stays visible on
// the shared element for the duration of that repaint.
window.app.clearChart = () => chart.clearChart();

async function prefetchSettingsToIDB(workflow = null) {
    try {
        await openDB();
        const workflowRequest = workflow ? Promise.resolve(workflow) : getWorkflow();
        const [reaResult, de1Result, de1AdvResult, appInfoResult, workflowResult] = await Promise.allSettled([
            getReaSettings(),
            getDe1Settings(),
            getDe1AdvancedSettings(),
            getAppInfo(),
            workflowRequest
        ]);
        const pairs = [
            ['settings-rea',         reaResult],
            ['settings-de1',         de1Result],
            ['settings-de1Advanced', de1AdvResult],
            ['settings-appInfo',     appInfoResult],
            ['settings-workflow',    workflowResult],
        ];
        for (const [key, result] of pairs) {
            if (result.status === 'fulfilled' && result.value) {
                try { await setSetting(key, result.value); } catch(e) { /* non-fatal */ }
            }
        }
        logger.debug('Settings pre-fetched and cached in IDB.');
    } catch(e) {
        logger.debug('Settings prefetch skipped:', e.message);
    }
}

// The webview host opens the system browser ONLY when a top-level navigation
// reaches its shouldOverrideUrlLoading hook (reaprime gh#384): it sees an
// external http(s) URL, launches Chrome, and cancels the in-webview load so the
// skin stays put. target="_blank" never gets there — it routes to the unhandled
// onCreateWindow and dies. So intercept any external (cross-origin) link tap and
// drive a real same-frame navigation; the user gesture is preserved so the
// host's launchUrl works. Internal/same-origin and hash/JS links are left alone.
document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.href;
    if (e.defaultPrevented) return;
    if (!/^https?:\/\//i.test(href)) return;
    if (href.startsWith(location.origin + '/') || href === location.origin) {
        return;
    }

    e.preventDefault();
    try {
        window.location.assign(href); // host's shouldOverrideUrlLoading -> launchUrl -> OS browser
    } catch (err) {
        logger.warn('External navigation failed:', err);
    }
});

// Tap the main chart to open the full-screen live charts;
// Back button / Escape closes it. Bound once at startup.
function wireExpandedChart() {
    const open = () => { try { chart.openExpandedChart(); } catch (e) { console.error('openExpandedChart', e); } };
    const close = () => { try { chart.closeExpandedChart(); } catch (e) { console.error('closeExpandedChart', e); } };

    const chartEl = document.getElementById('plotly-chart');
    if (chartEl) chartEl.addEventListener('click', open);

    const backBtn = document.getElementById('expanded-chart-back');
    if (backBtn) backBtn.addEventListener('click', close);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && chart.isExpandedChartOpen && chart.isExpandedChartOpen()) close();
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        logger.info('App DOMContentLoaded: Starting initialization.');

        // Preferences come back from Decaid's KV store before anything reads
        // them — WebView storage does not survive an app update.
        await settingsReady;

        initScaling();
        if (!isSubPage()) requestAnimationFrame(() => loadECharts().catch(error => logger.error('ECharts load failed:', error)));
        requestAnimationFrame(() => requestAnimationFrame(() => {
            // context-menu.css is not here: context-menu.js loads its own, so a
            // boot that never reaches this line cannot leave the menu unstyled.
            ['numpad-modal.css', 'time-picker-modal.css']
                .forEach(file => loadStyle(`src/css/${file}`).catch(() => {}));
            initHelpLauncher();
            Promise.all([
                import('./numpad-modal.js'),
                import('./time-picker-modal.js')
            ]).then(([numpad, timePicker]) => {
                numpad.initNumpadModal();
                timePicker.initTimePicker();
                initMobileValueInputs(numpad);
            }).catch(error => logger.warn('Deferred input controls failed to load:', error));
        }));
        const i18nReady = initI18n();
        const unitsReady = initUnits();
        chart.initChart();
        wireExpandedChart();
        logger.info('App DOMContentLoaded: Chart initialized.');

        ui.initUI({ onWeightClick: handleWeightClick }); // also inits the screensaver
        initEcoSteam();
        await Promise.all([i18nReady, unitsReady]);
        logger.info('App DOMContentLoaded: UI initialized.');

        // Check URL and load appropriate page if navigating directly to a route
        await initRouter();
        logger.info('App DOMContentLoaded: Router initialized.');

        // Run main-page init unless we booted on a sub-page; sub-page returns will
        // trigger it lazily via window.app.initMainPageOnce() from the router.
        const initialWorkflow = !isSubPage() ? await initMainPageOnce() : null;

        // Pre-warm settings cache so the settings page opens without redirecting on slow Rea responses
        prefetchSettingsToIDB(initialWorkflow);

        logger.info('App initialization finished successfully.');

        // Check if user is on desktop (Windows or macOS) to determine if we should show fullscreen prompt
        const isDesktop = navigator.userAgent.includes('Win') || navigator.userAgent.includes('Mac');
        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                      (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
        const isStandalone = window.navigator.standalone === true;

        // Detect in-app webview: no Chrome/Safari/Firefox branding despite being on mobile,
        // or explicit webview signals (wv flag on Android, no window.safari on iOS)
        const ua = navigator.userAgent;
        const isAndroidWebView = /Android/.test(ua) && /wv/.test(ua);
        const isIOSWebView = isIOS && !isStandalone && !/Safari\//.test(ua);
        const isDecentWebView = ua.includes('Decent');
        // Canonical signal: the reaprime/Decent host injects window.__DECENT_HOST__
        // into the tablet webview. It's the most reliable tablet/kiosk indicator
        // (the UA-sniffing above misses hosts that don't brand their UA), and it's
        // absent in a normal desktop browser — so this only ever hides the
        // fullscreen control on-device, never for a desktop user. Ceiling: a host
        // that neither brands its UA nor injects the global is still treated as a
        // browser (acceptable — the button is harmless there).
        const isDecentHost = !!window.__DECENT_HOST__;
        const isWebView = isAndroidWebView || isIOSWebView || isDecentWebView || isDecentHost;

        if (isWebView) {
            // A root class, not an inline style on the one button that exists right
            // now: index.html, profile_selector.html and settings.html each carry
            // their own #fullscreen-toggle-btn, and the router injects the sub-page
            // ones long after this runs -- so hiding by id here only ever covered
            // the main page. CSS on <html> covers every page, present and future.
            // The host OS owns fullscreen in a webview, so the button is never
            // useful there. See main.css; help-overlay.css deliberately overrides
            // this on the main page to keep the slot laid out for the help button.
            document.documentElement.classList.add('is-webview');
        }

        // Function to determine if we're in fullscreen mode
        // This accounts for both browser fullscreen API and web view fullscreen scenarios
        function isFullscreenMode() {
            // Check if using browser's native fullscreen API
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                return true;
            }

            // Check if viewport dimensions match screen dimensions (indicating fullscreen)
            // This is especially relevant for web views that start in fullscreen
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const screenWidth = screen.width;
            const screenHeight = screen.height;

            // Account for potential UI elements like mobile browsers' address bars
            // If viewport is very close to screen size, consider it fullscreen
            const widthRatio = viewportWidth / screenWidth;
            const heightRatio = viewportHeight / screenHeight;

            // If both dimensions are at least 95% of screen size, consider it fullscreen
            return widthRatio >= 0.95 && heightRatio >= 0.95;
        }

        // Helper function to check if rotation prompt should be shown (mobile + portrait)
        function shouldShowRotationPrompt() {
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            const isPortrait = window.innerHeight > window.innerWidth;
            return isMobile && isPortrait && !sessionStorage.getItem('rotationPromptDismissed');
        }

        // Prompt user to enter fullscreen only if not on desktop, not already in fullscreen,
        // and rotation prompt is not being shown (rotation takes priority on mobile)
        const isRotationPromptActive = shouldShowRotationPrompt();
        
        if (!isDesktop && !isWebView && !isFullscreenMode() && !sessionStorage.getItem('fullscreenPromptDismissed') && !isRotationPromptActive) {
            const toastContainer = document.getElementById('fullscreen-toast-container');
            if (toastContainer) {
                if (isIOS && !isStandalone) {
                    // iOS doesn't support the Fullscreen API — show "Add to Home Screen" tip instead
                    const alertBox = toastContainer.querySelector('.alert');
                    const heading = alertBox?.querySelector('h3');
                    const messageDiv = alertBox?.querySelector('.text-\\[9px\\]');
                    const buttonContainer = alertBox?.querySelector('.flex.gap-2');

                    if (heading) heading.textContent = 'Add to Home Screen';
                    if (messageDiv) messageDiv.textContent = 'Tap the Share button (⬆) in Safari, then "Add to Home Screen" for a fullscreen experience.';
                    if (buttonContainer) {
                        buttonContainer.innerHTML = `
                            <button id="toast-ios-got-it-btn" class="btn btn-primary btn-sm text-white">Got it</button>
                            <button id="toast-ios-later-btn" class="btn btn-ghost btn-sm">Later</button>
                        `;
                        setTimeout(() => {
                            document.getElementById('toast-ios-got-it-btn')?.addEventListener('click', () => {
                                toastContainer.style.display = 'none';
                                sessionStorage.setItem('fullscreenPromptDismissed', 'true');
                            });
                            document.getElementById('toast-ios-later-btn')?.addEventListener('click', () => {
                                toastContainer.style.display = 'none';
                                sessionStorage.setItem('fullscreenPromptDismissed', 'true');
                            });
                        }, 0);
                    }

                    toastContainer.style.display = 'grid';
                } else if (!isIOS) {
                    toastContainer.style.display = 'grid';

                    document.getElementById('toast-fullscreen-btn').onclick = () => {
                        document.getElementById('fullscreen-toggle-btn').click();
                        toastContainer.style.display = 'none';
                        sessionStorage.setItem('fullscreenPromptDismissed', 'true');
                    };

                    document.getElementById('toast-close-btn').onclick = () => {
                        toastContainer.style.display = 'none';
                        sessionStorage.setItem('fullscreenPromptDismissed', 'true');
                    };
                }
            }
        }

        // Add event listener to close the toast when fullscreen mode is entered
        // This handles the case where the user clicks the fullscreen toggle directly
        document.addEventListener('fullscreenchange', () => {
            const toastContainer = document.getElementById('fullscreen-toast-container');
            if (toastContainer && isFullscreenMode()) {
                // If we're now in fullscreen mode, hide the toast
                toastContainer.style.display = 'none';
            }
        });

        // Also handle the WebKit-specific event for Safari
        document.addEventListener('webkitfullscreenchange', () => {
            const toastContainer = document.getElementById('fullscreen-toast-container');
            if (toastContainer && isFullscreenMode()) {
                // If we're now in fullscreen mode, hide the toast
                toastContainer.style.display = 'none';
            }
        });

        const profileNameEl = document.getElementById('profile-name');
        if (profileNameEl) {
            profileNameEl.style.cursor = 'pointer';
            ui.setupPressAndHold(
                profileNameEl,
                () => loadPage('src/profiles/profile_selector.html'),
                (el) => {
                    const activeRecord = profileManager.getActiveProfileRecord()
                        ?? Object.values(profileManager.availableProfiles).find(r => {
                            const t = profileManager.translateProfileTitle(r.profile?.title ?? '');
                            return t === el.textContent.trim();
                        }) ?? null;
                    const profileTitle = activeRecord
                        ? profileManager.translateProfileTitle(activeRecord.profile.title)
                        : null;
                    const items = [
                        {
                            label: getTranslation('Browse Profiles'),
                            onSelect: () => loadPage('src/profiles/profile_selector.html'),
                        },
                        {
                            label: profileTitle ? `${getTranslation('Edit')} "${profileTitle}"` : getTranslation('Edit Profile'),
                            disabled: !activeRecord,
                            onSelect: () => {
                                window.__pendingEditProfile = activeRecord;
                                loadPage('src/profiles/profile_editor.html');
                            },
                        },
                        {
                            label: getTranslation('Use Profile Defaults'),
                            disabled: !activeRecord,
                            onSelect: async () => {
                                const ok = await profileManager.resetActiveProfileToDefaults();
                                ui.showToast(
                                    ok ? 'Reset to profile defaults' : 'Could not reset profile',
                                    3000,
                                    ok ? 'success' : 'error'
                                );
                            },
                        },
                    ];
                    openContextMenu(el, items);
                }
            );
        }

        // Add event listener for the settings button
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('pointerdown', () => {
                prefetchSettingsPage().catch(() => {});
            }, { once: true });
            settingsBtn.addEventListener('click', () => {
                loadPage('src/settings/settings.html');
            });
        }
    } catch (error) {
        logger.error('CRITICAL: Unhandled error during application initialization:', error);
        // Optionally, display a user-friendly error message on the page
        const body = document.querySelector('body');
        if (body) {
            body.innerHTML = `<div style="color: red; padding: 2rem;">
                <h1>Application Error</h1>
                <p>A critical error occurred during startup. Please check the console for details and try refreshing the page.</p>
            </div>`;
        }
    }
});
