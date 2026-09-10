import { isEcoSteamEnabled, setEcoSteamEnabled } from '../modules/eco-steam.js';
import {  getReaSettings, getDe1Settings, getDe1AdvancedSettings, setReaSettings, setDe1Settings, setDe1AdvancedSettings, resetDe1Settings, setMachineState, connectScaleDevice, connectDeviceWebSocket, sendDeviceCommand, awaitDeviceConnectResult, dimDisplay, restoreDisplay, isBlackScreenSaver, setBlackScreenSaver as apiSetBlackScreenSaver, rememberBrightness, getLastDisplayState, currentMachineState, signalHeartbeat, MachineState, getDeviceWebSocket, initDeviceWebSocketWithCallback, saveScaleDeviceId, getScaleDeviceId, connectDisplayWebSocket, sendDisplayCommand, connectUpdateWebSocket, sendUpdateCommand, enableWakeLock, disableWakeLock, isWakeLockEnabled, getPresenceSettings, setPresenceSettings, getPresenceSchedules, createPresenceSchedule, updatePresenceSchedule, deletePresenceSchedule, getAppInfo, getMachineInfo, getWorkflow, updateWorkflow, getAllSkins, getDefaultSkin, setDefaultSkin, updateSkins, stopWebuiServer, startWebuiServer, getWebuiServerStatus, uploadFirmware, applyFirmware, cancelFirmwareUpdate, getFirmwareCatalog, setWaterLevels, API_BASE_URL, listWifiScales, addWifiScale, removeWifiScale, forgetDevice, getLedStrip, setLedStrip, commitLedStrip, resetLedStrip, previewLedStrip, clearLedStripPreview, getCupWarmer, setCupWarmer, setCupWarmerPrewarm, calibrateScale, tareScale, getSensorCalibration, setSensorCalibration, getLastMachineSnapshot, ensureMachineSnapshotSocket, connectScaleWebSocket, setFirmwareFlashInFlight, persistSharedValue, MILK_STOP_LAST_VALUE_KEY, STEAM_DURATION_LAST_VALUE_KEY, STEAM_FLOW_LAST_VALUE_KEY, STEAM_TEMP_LAST_VALUE_KEY, HOT_WATER_VOLUME_LAST_VALUE_KEY, HOT_WATER_TEMP_LAST_VALUE_KEY, approvePluginUpdate, getPlugins, getDecentAccountStatus, getPluginSettings, setPluginSettings, callPluginEndpoint, enablePlugin } from '../modules/api.js';
import * as ui from '../modules/ui.js';
import { initScaling } from '../modules/scaling.js';
import { getSupportedLanguages, getCurrentLanguage, setLanguage, translatePage, getTranslation } from '../modules/i18n.js';
import { getTempUnit, setTempUnit, formatTemp, fromDisplayTemp, boundToDisplay } from '../modules/units.js';
import { loadPage } from '../modules/router.js'; // Singular and correctly formatted import
import { logger } from '../modules/logger.js';
import { isBengleMachine, setMachineModel } from '../modules/machine.js';
import { resolveSteamStopMode, applyMilkProbeGate } from '../modules/steam-mode.js';
import { summarizeFirmwareCatalog, isFirmwareCancellationError, estimateRemainingSeconds, isUploadComplete, estimateVerifyRemainingSeconds, estimateTotalRemainingSeconds, FIRMWARE_VERIFY_SECONDS, formatDuration } from '../modules/firmware-progress.js';
import { setScreensaverSuppressed, isMachineAsleep } from '../modules/screensaver-policy.js';
import { ledRgbToColor16, ledColor16ToHex8, ledHexToRgb, ledPreviewComposite } from '../modules/led-color.js';
import { LED_SEQUENCE_KEY, MIN_STEP_DURATION_MS, MAX_STEP_DURATION_MS, LED_TRIGGER_STATES, parseLedSequence, serializeLedSequence, addStep, removeStep, updateStep, moveStep, toggleTriggerState } from '../modules/led-sequence.js';
import { requestStart as ledRunRequestStart, requestStop as ledRunRequestStop, forceStop as ledRunForceStop, onRunChange as ledRunOnChange, getRunState as ledRunGetState, onMachineStateChange as ledRunOnMachineStateChange } from '../modules/led-strip-runner.js';
import { isCupWarmerOn, readCupWarmerTarget, clampCupWarmerTarget, clampPrewarmMinutes, resolvePrewarm, prewarmWarnings, prewarmShapeSignature, cupWarmerViewMode, formatCurrentMatTemp, getCupWarmerState, setCupWarmerState, patchCupWarmerState, onCupWarmerStateChange, CUP_WARMER_TARGET_KEY, PREWARM_MIN_MINUTES, PREWARM_MAX_MINUTES } from '../modules/cup-warmer.js';
import { clampCalWeight, calActionState, CAL_WEIGHT_DEFAULT_G, CAL_WEIGHT_MIN_G, CAL_WEIGHT_MAX_G } from '../modules/loadcell-cal.js';
import { SENSOR_CAL_TARGETS, sensorCalTarget, parseSensorCalInput, previewCalibration, absoluteSetCorrection, formatCalValue, snapshotReading, averageReadings, correctionBlocked, SENSOR_CAL_SAMPLE_WINDOW_MS } from '../modules/sensor-cal.js';
import { APP_VERSION, SKIN_ID } from '../version.js';
import { openNotesModal } from '../modules/notes-modal.js';
import { openDB, getSetting, setSetting, addEmails, getAllEmails, getLatestEmailTimestamp } from '../modules/idb.js';
import { openModal, shouldUseNumpad, initializeNumpadModal } from '../modules/numpad-modal.js';
import { ensureDye2PluginReady, getDye2VersionInfo, installDye2Plugin, offerDye2Update, checkDye2UpdatesIfDue } from '../modules/dyeStrip.js';
import { pluginKeywords, pluginListKeywords, subcategoryMatches, textFromHtml, tokenPattern, HIGHLIGHT_CLASS } from '../modules/settings-search.js';
import { haYamlBlocks } from '../modules/home-assistant.js';
import { loadIro } from '../modules/vendor-loader.js';
import { readSettingsLocation, writeSettingsLocation } from './settings-location.js';
import { SETTINGS_TREE as settingsTree } from './settings-tree.js';

// Config for each numeric input that should get two-click numpad support
const SETTINGS_NUMPAD_CONFIGS = {
    flushTempInput:          { title: 'FLUSH TEMPERATURE',   unit: '°C',   min: 5,   max: 95,   fieldType: 'settings-flush-temp' },
    flushFlowInput:          { title: 'FLUSH FLOW',          unit: 'ml/s', min: 1,   max: 8,    fieldType: 'settings-flush-flow' },
    tankTempInput:           { title: 'TANK TEMPERATURE',    unit: '°C',   min: 10,  max: 40,   fieldType: 'settings-tank-temp' },
    waterAlertInput:         { title: 'WATER ALERT LEVEL',   unit: 'mm',   min: 0,   max: 30,   fieldType: 'settings-water-alert' },
    calibFanInput:           { title: 'FAN THRESHOLD',       unit: '%',    min: 0,   max: 100,  fieldType: 'settings-calib-fan' },
    calibWeightInput:        { title: 'CALIBRATION WEIGHT',  unit: 'g',    min: 1,   max: 10000,fieldType: 'settings-calib-weight' },
    // DE1 sensor calibration: only the measured half is typed — the DE1's own
    // reading is captured off the machine. The temperature box is entered in
    // the display unit (the '°C' unit makes attachSettingsNumpad convert
    // min/max), flow and pressure have no alternate unit.
    'sensor-cal-temperature-measured': { title: 'MEASURED TEMP',     unit: '°C',   min: 0, max: 200, fieldType: 'settings-sensor-cal-temp-measured' },
    'sensor-cal-pressure-measured':    { title: 'MEASURED BAR',      unit: 'bar',  min: 0, max: 20,  fieldType: 'settings-sensor-cal-pressure-measured' },
    'sensor-cal-flow-measured':        { title: 'MEASURED FLOW',     unit: 'ml/s', min: 0, max: 20,  fieldType: 'settings-sensor-cal-flow-measured' },
    steamCalibTempInput:     { title: 'STEAM TEMPERATURE',   unit: '°C',   min: 135, max: 170,  fieldType: 'settings-steam-calib-temp' },
    steamTempInput:          { title: 'STEAM TEMPERATURE',   unit: '°C',   min: 0,   max: 170,  fieldType: 'settings-steam-temp' },
    steamDurationInput:      { title: 'STEAM DURATION',      unit: 'sec',  min: 10,  max: 120,  fieldType: 'settings-steam-duration' },
    steamFlowInput:          { title: 'STEAM FLOW',          unit: 'ml/s', min: 0.4, max: 2.5,  fieldType: 'settings-steam-flow' },
    hotWaterTempInput:       { title: 'HOT WATER TEMP',      unit: '°C',   min: 50,  max: 95,   fieldType: 'settings-hw-temp' },
    hotWaterVolumeInput:     { title: 'HOT WATER VOLUME',    unit: 'ml',   min: 10,  max: 500,  fieldType: 'settings-hw-volume' },
    hotWaterDurationInput:   { title: 'HOT WATER DURATION',  unit: 'sec',  min: 5,   max: 120,  fieldType: 'settings-hw-duration' },
    hotWaterFlowInput:       { title: 'HOT WATER FLOW',      unit: 'ml/s', min: 0.1, max: 8,    fieldType: 'settings-hw-flow' },
    heaterPh1FlowInput:      { title: 'HEATER WARMUP FLOW',  unit: 'ml/s', min: 0,   max: 10,   fieldType: 'settings-heater-ph1' },
    heaterPh2FlowInput:      { title: 'HEATER TEST FLOW',    unit: 'ml/s', min: 0,   max: 10,   fieldType: 'settings-heater-ph2' },
    heaterIdleTempInput:     { title: 'IDLE TEMPERATURE',    unit: '°C',   min: 0,   max: 99,   fieldType: 'settings-heater-idle-temp' },
    heaterPh2TimeoutInput:   { title: 'HEATER TEST TIMEOUT', unit: 'sec',  min: 0,   max: 60,   fieldType: 'settings-heater-ph2-timeout' },
    weightFlowMultiplierInput: { title: 'WEIGHT FLOW MULT',  unit: '',     min: 0,              fieldType: 'settings-weight-mult' },
    volumeFlowMultiplierInput: { title: 'VOLUME FLOW MULT',  unit: '',     min: 0,              fieldType: 'settings-volume-mult' },
    hotWaterFlowMultiplierInput: { title: 'HW FLOW MULT',    unit: 's',    min: 0,              fieldType: 'settings-hw-flow-mult' },
    // Native type=number fields migrated onto the in-app numpad for a single,
    // consistent numeric-entry surface on the tablet (desktop keeps the native
    // control, since attachSettingsNumpad is gated on shouldUseNumpad()). The
    // keep-awake pair lives inside the Add Schedule <dialog>; the numpad
    // re-homes into that dialog's top layer -- see openModal in numpad-modal.js.
    'sleep-timeout-input':       { title: 'SLEEP TIMEOUT',     unit: 'min',  min: 1,   max: 120,  fieldType: 'settings-sleep-timeout' },
    'brightness-number':         { title: 'BRIGHTNESS',        unit: '%',    min: 0,   max: 100,  fieldType: 'settings-brightness' },
    'screensaver-cycle-seconds': { title: 'IMAGE CYCLE',       unit: 'sec',  min: 2,   max: 600,  fieldType: 'settings-screensaver-cycle' },
    'visualizer-min-duration':   { title: 'MIN SHOT DURATION', unit: 'sec',  min: 1,              fieldType: 'settings-visualizer-min' },
    'keep-awake-hours-input':    { title: 'KEEP AWAKE HOURS',  unit: 'hr',   min: 0,   max: 12,   fieldType: 'settings-keep-awake-hours' },
    'keep-awake-mins-input':     { title: 'KEEP AWAKE MINS',   unit: 'min',  min: 0,   max: 59,   fieldType: 'settings-keep-awake-mins' },
    // Bengle cup-warmer fields -- register so they open the in-app numpad on the
    // tablet like every other settings number, instead of the OS keyboard.
    cupWarmerTempInput:      { title: 'CUP WARMER TEMP',   unit: '°C',   min: 30,  max: 80,   fieldType: 'settings-cupwarmer-temp' },
    cupWarmerPrewarmInput:   { title: 'PRE-WARM LEAD',     unit: 'min',  min: PREWARM_MIN_MINUTES, max: PREWARM_MAX_MINUTES, fieldType: 'settings-cupwarmer-prewarm' },
    steamMilkStopInput:      { title: 'STOP AT MILK TEMP', unit: '°C',   min: 30,  max: 80,   fieldType: 'settings-steam-milk-stop' },
};

// Settings-page numeric temperature inputs hold their number in the ACTIVE
// display unit (like every other field on the page) — Celsius only exists at
// the API boundary. These three helpers are the boundary: render a stored
// Celsius value into the box, read the box back out to Celsius, and label it.
function tempInputValue(celsius) {
    return boundToDisplay(celsius);
}
function tempInputToCelsius(raw) {
    return fromDisplayTemp(parseFloat(raw));
}
function tempUnitLabel() {
    return getTempUnit() === 'F' ? '°F' : '°C';
}
// Inline onchange="..." attributes execute in the global scope, not this
// module's — expose the Celsius conversion the same way updateXSetting is.
window.tempInputToCelsius = tempInputToCelsius;

let _settingsNumpadSelected = null;
let _settingsNumpadTimer = null;

function attachSettingsNumpad() {
    if (!shouldUseNumpad()) return;
    initializeNumpadModal();

    Object.entries(SETTINGS_NUMPAD_CONFIGS).forEach(([id, config]) => {
        const input = document.getElementById(id);
        if (!input || input.dataset.settingsNumpadAttached) return;
        input.dataset.settingsNumpadAttached = 'true';
        input.readOnly = true;
        input.style.cursor = 'pointer';

        // One tap opens the numpad. (Was a two-tap select-then-open; the numpad is
        // now a lightweight popup card, so the guard tap is just friction.)
        input.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Temperature fields' min/max are stored in Celsius (the config table is
            // static); the box itself and the numpad both operate in the active
            // display unit, so resolve them here rather than baking one unit in.
            const liveConfig = config.unit === '°C'
                ? { ...config, unit: tempUnitLabel(), min: tempInputValue(config.min), max: tempInputValue(config.max) }
                : config;

            const currentVal = String(parseFloat(input.value) || liveConfig.min);
            const mockEl = {
                value: currentVal,
                getAttribute: () => currentVal,
                dispatchEvent: () => {}
            };
            openModal(mockEl, {
                fieldType: liveConfig.fieldType,
                config: liveConfig,
                onConfirm: (val) => {
                    const num = parseFloat(val);
                    if (!isNaN(num)) {
                        const clamped = Math.max(liveConfig.min ?? -Infinity, Math.min(liveConfig.max ?? Infinity, num));
                        input.value = clamped;
                        input.dispatchEvent(new Event('change'));
                    }
                }
            });
        });
    });
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let screensaverImagesCache = [];

// A firmware upload outlives the page that started it: the fetch streams on
// while the settings router swaps HTML underneath. These two survive the swap so
// a re-render of the Firmware page can repaint the bar and keep Upload disabled
// instead of pretending nothing is happening. See window.uploadFirmware.
let firmwareUploadInFlight = false;
// Which button started the in-flight operation. Distinguishes "the manual
// card's own Upload button is mid-upload" (card must stay visible — it's
// showing that button's progress) from "the catalog's Download & Install
// button is running" (the manual card is irrelevant noise and hides).
let firmwareOperationSource = null; // 'manual' | 'catalog' | null
let lastFirmwareProgress = null;
// Set on window.cancelFirmwareUpdate, read once the stream's 'error' event
// lands, so that expected termination reads as "cancelled" not "failed".
let firmwareCancelRequested = false;
// When the current operation started, and the 1 Hz repaint that shows it.
// The stream is silent for the whole erase, and then again for the first ~1% of
// the upload (the handler emits one event per percent, and a percent is ~290
// BLE round-trips) -- in a real log the label sat on "Erase…" for minutes while
// the machine was in fact uploading. A running clock is what separates "silent
// because it is working" from "silent because it is dead".
let firmwareStartedAt = 0;
let firmwareElapsedTimer = null;
// When the upload proper began, and the percentage the first event reported.
// The countdown is measured from here, not from firmwareStartedAt: the erase
// carries no percentages, so timing the upload from the start of the operation
// would price minutes of erase into the upload's rate and overstate what is left.
let firmwareUploadStartedAt = 0;
let firmwareUploadStartPercent = 0;
// When the last progress event landed — the countdown ticks down from there
// between events instead of re-estimating against the clock (see
// estimateRemainingSeconds).
let firmwareProgressAt = 0;
// When the bytes were all sent — i.e. when the silent CRC verification started.
// It gets its own clock because it is the one phase with a hard, known bound
// (decaid's 30s firmwareVerificationTimeout); counting it against the
// whole-operation ballpark instead claimed minutes of "remaining" for a phase
// that has half a minute at most. Latched by firmwareNoteVerifyStart from the
// measured rate, NOT from a 100% event — there isn't one; see isUploadComplete.
let firmwareVerifyStartedAt = 0;

// Enhanced cache for settings data with loading states
let settingsCache = {
    rea: null,
    de1: null,
    de1Advanced: null,
    workflow: null,
    reaLoading: false,
    de1Loading: false,
    de1AdvancedLoading: false,
    workflowLoading: false,
    reaError: null,
    de1Error: null,
    de1AdvancedError: null,
    workflowError: null,
    appInfo: null,
    appInfoLoading: false,
    appInfoError: null,
    machineInfo: null,
    machineInfoLoading: false,
    machineInfoError: null,
    // summarizeFirmwareCatalog output; null = not checked yet this session.
    firmwareCheck: null,
    skinInfo: null,
    skinInfoLoading: false,
    skinInfoError: null,
    allSkins: null,
    allSkinsLoading: false,
    allSkinsError: null,
    appUpdateState: null
};

// Latest DisplayState from ws/v1/display (REA replays a snapshot on connect via
// its seeded BehaviorSubject). Source of truth for wake-lock/brightness render,
// so we don't fall back to a stale localStorage intent.
let displayStateCache = null;
// The page cache can be null before its first frame; api.js keeps one from boot.
function displayState() { return displayStateCache ?? getLastDisplayState(); }

let activeSettingsCategory = null; // New global variable to track the currently active category
let settingsLanguageListenerInstalled = false;

let pendingChanges = { rea: {}, de1: {}, de1Advanced: {}, workflow: {} };
function resetPendingChanges() { pendingChanges = { rea: {}, de1: {}, de1Advanced: {}, workflow: {} }; }
function hasPendingChanges() {
    return Object.keys(pendingChanges.rea).length > 0 ||
        Object.keys(pendingChanges.de1).length > 0 ||
        Object.keys(pendingChanges.de1Advanced).length > 0 ||
        Object.keys(pendingChanges.workflow).length > 0;
}
const isNum = (v) => typeof v === 'number' && isFinite(v);

async function flushPendingChanges() {
    const tasks = [];
    if (Object.keys(pendingChanges.rea).length) tasks.push(setReaSettings(pendingChanges.rea));
    if (Object.keys(pendingChanges.de1).length) tasks.push(setDe1Settings(pendingChanges.de1));
    if (Object.keys(pendingChanges.de1Advanced).length) tasks.push(setDe1AdvancedSettings(pendingChanges.de1Advanced));
    // The boot resync (api.resyncIfDrifted) compares Rea's workflow record
    // against the shared KV record of what the user last set, and KV wins. This
    // page writes the workflow directly instead of going through the api
    // setters that maintain that record, so every field with a KV key has to be
    // written here too -- otherwise the older main-page value is pushed back
    // over whatever was just saved here, on the next load.
    if (pendingChanges.workflow.steamSettings) {
        const steam = pendingChanges.workflow.steamSettings;
        tasks.push(updateWorkflow({ steamSettings: steam }));
        if (isNum(steam.duration)) persistSharedValue(STEAM_DURATION_LAST_VALUE_KEY, steam.duration);
        if (isNum(steam.flow)) persistSharedValue(STEAM_FLOW_LAST_VALUE_KEY, steam.flow);
        // Enabled temperatures only: 0 is the heater switched off, and the main
        // page reads this key to decide what to switch back ON to when steam is
        // re-armed -- see api.setTargetSteamDuration.
        if (steam.targetTemperature > 0) persistSharedValue(STEAM_TEMP_LAST_VALUE_KEY, steam.targetTemperature);
        // Armed targets only: 0 means the stop was switched off, not a
        // temperature worth remembering -- see api.setStopAtTemperature.
        if (steam.stopAtTemperature > 0) persistSharedValue(MILK_STOP_LAST_VALUE_KEY, steam.stopAtTemperature);
    }
    if (pendingChanges.workflow.hotWaterData) {
        const water = pendingChanges.workflow.hotWaterData;
        tasks.push(updateWorkflow({ hotWaterData: water }));
        if (isNum(water.volume)) persistSharedValue(HOT_WATER_VOLUME_LAST_VALUE_KEY, water.volume);
        if (isNum(water.targetTemperature)) persistSharedValue(HOT_WATER_TEMP_LAST_VALUE_KEY, water.targetTemperature);
    }
    if (tasks.length) await Promise.all(tasks);
    saveSettingsBackup();
    resetPendingChanges();
}

// Live device state cache from WebSocket
let deviceStateCache = {
    devices: [],
    scanning: false,
    initialized: false
};

// Render generic loading state
function renderLoadingState(title) {
    return `
        <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden" role="status" aria-busy="true">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]">${title}</p>
            </div>
            <div class="text-[var(--text-primary)] p-4 text-[24px] text-center w-full" data-i18n-key="Loading settings...">Loading settings...</div>
        </div>
    `;
}

function formatMachineExtra(extra) {
    if (!extra || typeof extra !== 'object') {
        return 'N/A';
    }

    const entries = Object.entries(extra);
    if (entries.length === 0) {
        return 'N/A';
    }

    return entries
        .map(([key, value]) => {
            const readableKey = key
                .replace(/([A-Z])/g, ' $1')
                .replace(/^./, (char) => char.toUpperCase());
            let readableValue;
            if (typeof value === 'boolean') {
                readableValue = value ? 'on' : 'off';
            } else {
                readableValue = String(value);
            }
            return `${readableKey} : ${readableValue}`;
        })
        .join(', ');
}

function formatBuildTimestamp(timestamp) {
    if (!timestamp) {
        return 'Unavailable';
    }

    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
        return timestamp;
    }

    return parsed.toLocaleString();
}

// Render generic error state
function renderErrorState(title, message) {
    return `
        <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden" role="alert">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]">${escapeHtml(title)}</p>
            </div>
            <div class="text-red-500 p-4 text-[24px] text-center w-full">Failed to load settings: ${escapeHtml(message)}</div>
            <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold mx-auto mt-4" onclick="window.retryLoadSettings()" data-i18n-key="Retry">Retry</button>
        </div>
    `;
}

// Helper function to update the settings content area in the DOM
/**
 * Paint the brightness slider's filled portion so it lines up with the thumb.
 *
 * A range input's thumb centre does not travel the full track: it runs from
 * thumbW/2 to trackW - thumbW/2, so a gradient stop at the raw value% drifts
 * from the dot by up to half a thumb at each end (~7% on the 200px slider) and
 * only agrees at 50%. Convert value -> thumb-centre -> percentage instead.
 *
 * Must run after the element is laid out, since the two sliders have different
 * widths (200px in Miscellaneous, flex-grow in the Brightness panel).
 */
const BRIGHTNESS_THUMB_PX = 28; // 24px thumb + 2px border each side, see main.css

function syncBrightnessSliderFill(slider, value) {
    if (!slider) return;
    const track = slider.offsetWidth;
    if (!track) return; // not laid out yet
    const v = Math.min(100, Math.max(0, parseFloat(value)));
    const thumb = Math.min(BRIGHTNESS_THUMB_PX, track);
    const centrePx = (thumb / 2) + (v / 100) * (track - thumb);
    const stop = (centrePx / track) * 100;
    slider.style.background =
        `linear-gradient(to right, #385a92 0%, #385a92 ${stop}%, #e8e8e8 ${stop}%, #e8e8e8 100%)`;
}

// Light up the search words inside the page itself, not only in the nav on the
// left. Most of the words a person searches for live in the body copy — typing
// "upload" surfaces the Shot Uploader page, and the word it matched is in the
// paragraph under the toggle, so it has to be visible there.
//
// Text nodes are rewritten one at a time instead of reassigning innerHTML: the
// content area is full of live inputs, sliders and inline handlers, and
// re-serialising it would reset values and drop state. Nothing needs undoing —
// updateSettingsContentArea rebuilds the area from scratch on every render, so
// the marks disappear with it.
function highlightSearchInContent() {
    const area = document.getElementById('settings-content-area');
    const pattern = tokenPattern(document.getElementById('settings-search')?.value || '');
    if (!area || !pattern) return;

    const SKIP = new Set(['SCRIPT', 'STYLE', 'MARK', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (SKIP.has(node.parentElement?.tagName)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    // Collect first: replacing a node while walking would move the cursor onto
    // the fragment just inserted.
    const targets = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        pattern.lastIndex = 0;
        if (pattern.test(node.nodeValue)) targets.push(node);
    }

    for (const node of targets) {
        const frag = document.createDocumentFragment();
        let last = 0;
        pattern.lastIndex = 0;
        for (let m = pattern.exec(node.nodeValue); m; m = pattern.exec(node.nodeValue)) {
            if (m.index > last) frag.appendChild(document.createTextNode(node.nodeValue.slice(last, m.index)));
            const mark = document.createElement('mark');
            mark.className = HIGHLIGHT_CLASS;
            mark.textContent = m[0];
            frag.appendChild(mark);
            last = m.index + m[0].length;
        }
        if (last < node.nodeValue.length) frag.appendChild(document.createTextNode(node.nodeValue.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }
}

// Maintenance is an extracted category (categories/maintenance.js). The shell
// loads it directly, but once this legacy module mounts it owns the nav clicks
// too — so route these categories to the same module instead of keeping a
// second copy of the screens here. A category with no case at all would fall
// through to renderGeneralSettings().
const MAINTENANCE_CATEGORIES = new Set(['maint_cleaning', 'maint_descaling', 'maint_airpurge']);
let maintenanceCleanup = null;
let maintenanceSequence = 0;

async function mountMaintenanceCategory(category, container) {
    const sequence = ++maintenanceSequence;
    try {
        const module = await import('./categories/maintenance.js');
        // Guard a fast switch away: a late import must not paint over the page
        // the user is now looking at.
        if (sequence !== maintenanceSequence) return;
        maintenanceCleanup = await module.mountSettingsCategory({ container, category });
    } catch (error) {
        logger.error('Failed to mount maintenance category:', error);
    }
}

function updateSettingsContentArea(category) {
    // Always tear the previous maintenance mount down, including when moving
    // between two maintenance pages — its poller and listeners are per-mount.
    maintenanceSequence += 1;
    maintenanceCleanup?.();
    maintenanceCleanup = null;
    // Leaving the Lighting page → flush any deferred cross-state palette PUT,
    // THEN stop previewing (flush-before-clear: one strip transition, and the
    // edit persists exactly as the old always-PUT behaviour did). Also release
    // this page's 'manual' sequence-run ownership -- a state-triggered run
    // (led-strip-runner.js, driven from app.js) is untouched by this and keeps
    // running on whatever page the user goes to next.
    if (category !== 'ledstrip') { ledFlushDirty(); ledClearPreview(); ledSeqReleaseManual(); }
    // Leaving the Load Cells page → hand the scale WS back to the main page.
    if (category !== 'calib_loadcell' && calWsClaimed) calReleaseScaleWs();
    if (category !== 'calib_sensors') {
        sensorCalStopLive();
        // Leaving clears a failed read, so returning to the page tries once
        // more — the machine may have come back in the meantime.
        sensorCalLoadError = '';
        ({ shown: sensorCalWarningShown, ack: sensorCalWarningAck } = sensorCalWarningNextState(
            { shown: sensorCalWarningShown, ack: sensorCalWarningAck }, 'leave').state);
        document.getElementById('sensor-cal-warning-modal')?.close();
    }
    // Leaving the Cup Warmer page → stop its ~5 s revalidate poll.
    if (category !== 'cupwarmer' && cupWarmerPollTimer !== null) stopCupWarmerPoll();
    // A render of calib_sensors rebuilds #settings-content-area from scratch,
    // which recreates <dialog id="sensor-cal-warning-modal"> as a brand new,
    // closed node -- silently destroying it if it happened to be open when an
    // UNRELATED render lands (preloadSettings() finishing in the background,
    // a language change, another settings write's re-render -- none of which
    // have anything to do with the calibration read). Capture the real,
    // browser-reported open state of the node THAT IS ABOUT TO BE REPLACED,
    // before the rebuild below destroys it, so it can be restored afterwards.
    // This is deliberately read from the DOM, not from sensorCalWarningShown:
    // shown only means "opened at some point this visit" and must NOT itself
    // reopen a dialog the user already dismissed (Ok, or Cancel navigating
    // away) or closed with Escape -- .open naturally goes false in all of
    // those cases, so this only fires for a genuine mid-flight interruption.
    const sensorCalWarningWasOpen = category === 'calib_sensors'
        && document.getElementById('sensor-cal-warning-modal')?.open === true;
    const contentArea = document.getElementById('settings-content-area');
    if (contentArea) {
        contentArea.innerHTML = renderSettingsContent(category);
        translatePage();
        // The CSS default is a fixed 75% stop, so without this the bar sits at 75%
        // on first paint no matter what the value is.
        const slider = contentArea.querySelector('#brightness-slider');
        if (slider) syncBrightnessSliderFill(slider, slider.value);
        if (category === 'theme') {
            setTimeout(() => {
                ui.initThemeToggle();
            }, 100);
        }
        if (category === 'plugins') {
            setTimeout(() => window.loadPluginList?.(), 0);
        }
        if (category === 'fontsize') {
            setTimeout(initFontSizeSettings, 0);
        }
        if (category === 'tempunit') {
            setTimeout(initTempUnitSettings, 0);
        }
        if (category === 'talkdecent') {
            setTimeout(() => window.updateTalkToDecentUI?.(), 0);
        }
        if (category === 'firmware' || category === 'firmwareupdate') {
            setTimeout(initFirmwareCheck, 0);
        }
        // #app-update-section lives on the Decaid page now, not the firmware one.
        if (category === 'rea') {
            setTimeout(initAppUpdateSection, 0);
        }
        if (category === 'quickstart') {
            setTimeout(initQuickstartGuideSettings, 0);
        }
        if (category === 'ledstrip') {
            setTimeout(initLedPicker, 0);
        }
        if (MAINTENANCE_CATEGORIES.has(category)) {
            mountMaintenanceCategory(category, contentArea);
        }
        if (category === 'calib_sensors') {
            setTimeout(initSensorCal, 0);
            // Every render of this page (load completing, capture, edits,
            // apply/restore) reaches this same branch -- sensorCalWarningNextState
            // only opens on the first one of a visit, so the modal no longer
            // reopens on each subsequent re-render.
            const { state, open } = sensorCalWarningNextState(
                { shown: sensorCalWarningShown, ack: sensorCalWarningAck }, 'render');
            sensorCalWarningShown = state.shown;
            sensorCalWarningAck = state.ack;
            // `open` alone would leave the warning gone for good the moment an
            // unrelated render interrupts it before the user has acted on it
            // -- see sensorCalWarningShouldReopen for why folding in
            // sensorCalWarningWasOpen (captured above, before the rebuild) is
            // safe against reopening on a user-driven render.
            if (sensorCalWarningShouldReopen(open, sensorCalWarningWasOpen)) setTimeout(sensorCalShowWarning, 0);
        }
        // Step 4's live readout needs the scale WS — claim it on every render
        // of the page at step 4 (idempotent), so returning to a resumed wizard
        // re-wires it after a reclaim.
        if (category === 'calib_loadcell' && calStep === 4) calEnsureScaleWs();
        setTimeout(attachSettingsNumpad, 0);
        // After translatePage(), so the marks land on the text actually shown.
        highlightSearchInContent();
    }
}

// Helper function to check if settings are loaded
function areSettingsLoaded() {
    return settingsCache.rea !== null &&
           settingsCache.de1 !== null &&
           settingsCache.de1Advanced !== null;
}

// Update settings
export function updateReaSetting(key, value, rerender = true) {
    if (!settingsCache.rea) settingsCache.rea = {};
    settingsCache.rea[key] = value;
    pendingChanges.rea[key] = value;
    if (rerender && activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
}

// Update DE1 settings
export function updateDe1Setting(key, value) {
    if (!settingsCache.de1) settingsCache.de1 = {};
    settingsCache.de1[key] = value;
    pendingChanges.de1[key] = value;
    if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
}

// Update DE1 advanced settings
export function updateDe1AdvancedSetting(key, value) {
    updateDe1AdvancedSettings({ [key]: value });
}

// Stage several DE1 advanced settings at once, repainting the page a single
// time at the end -- a preset that writes four fields should not rebuild the
// content area four times.
export function updateDe1AdvancedSettings(values) {
    if (!settingsCache.de1Advanced) settingsCache.de1Advanced = {};
    for (const [key, value] of Object.entries(values)) {
        settingsCache.de1Advanced[key] = value;
        pendingChanges.de1Advanced[key] = value;
    }
    if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
}

// Update steam settings via workflow API
export function updateSteamSetting(key, value) {
    if (!settingsCache.workflow) settingsCache.workflow = {};
    if (!settingsCache.workflow.steamSettings) settingsCache.workflow.steamSettings = {};
    settingsCache.workflow.steamSettings[key] = value;
    if (!pendingChanges.workflow.steamSettings) pendingChanges.workflow.steamSettings = { ...(settingsCache.workflow.steamSettings) };
    pendingChanges.workflow.steamSettings[key] = value;
}

// Update hot water settings via workflow API
export function updateHotWaterSetting(key, value) {
    if (!settingsCache.workflow) settingsCache.workflow = {};
    if (!settingsCache.workflow.hotWaterData) settingsCache.workflow.hotWaterData = {};
    settingsCache.workflow.hotWaterData[key] = value;
    if (!pendingChanges.workflow.hotWaterData) pendingChanges.workflow.hotWaterData = { ...(settingsCache.workflow.hotWaterData) };
    pendingChanges.workflow.hotWaterData[key] = value;
}


// ── Settings backup / reconcile ─────────────────────────────────────────────

async function preSeedFromIDB() {
    try {
        await openDB();
        const backup = await getSetting('settingsBackup');
        if (!backup?.ts || (Date.now() - backup.ts) > 30 * 24 * 60 * 60 * 1000) return false;
        if (backup.rea)         { settingsCache.rea         = backup.rea;         settingsCache.reaLoading         = false; }
        if (backup.de1)         { settingsCache.de1         = backup.de1;         settingsCache.de1Loading         = false; }
        if (backup.de1Advanced) { settingsCache.de1Advanced = backup.de1Advanced; settingsCache.de1AdvancedLoading = false; }
        if (backup.steamSettings || backup.hotWaterData) {
            settingsCache.workflow = settingsCache.workflow || {};
            if (backup.steamSettings) settingsCache.workflow.steamSettings = backup.steamSettings;
            if (backup.hotWaterData)  settingsCache.workflow.hotWaterData  = backup.hotWaterData;
        }
        return true;
    } catch (e) {
        console.warn('preSeedFromIDB failed:', e);
        return false;
    }
}

async function saveSettingsBackup() {
    try {
        await openDB();
        await setSetting('settingsBackup', {
            ts: Date.now(),
            rea:         settingsCache.rea         ? { ...settingsCache.rea }         : null,
            de1:         settingsCache.de1         ? { ...settingsCache.de1 }         : null,
            de1Advanced: settingsCache.de1Advanced ? { ...settingsCache.de1Advanced } : null,
            steamSettings: settingsCache.workflow?.steamSettings
                ? { ...settingsCache.workflow.steamSettings } : null,
            hotWaterData:  settingsCache.workflow?.hotWaterData
                ? { ...settingsCache.workflow.hotWaterData }  : null,
        });
    } catch (e) {
        console.warn('saveSettingsBackup failed:', e);
    }
}

// NOTE: the settingsBackup written by saveSettingsBackup() is consumed ONLY by
// preSeedFromIDB() above, which seeds the in-memory display cache and never PUTs.
// A "reconcile" step that re-applied backup diffs to the SERVER used to live here,
// together with its loadSettings() caller -- both dead code, with no call sites
// anywhere in the repo. It was deleted rather than left dormant: main-page edits
// (steam flow, steam duration, the stop-at-weight target) never rewrite the
// backup, so the backup is chronically stale for exactly the fields users touch
// most, and re-applying it would silently revert their changes. If a
// restore-after-a-server-reset feature is ever wanted, it must either exclude
// every main-page-editable field or rewrite the backup on every main-page edit.

// ── Render settings content based on selected category
export function renderSettingsContent(category) {
    // Determine loading state for the specific category
    let isLoading = false;
    let error = null;

    switch(category) {
        case 'rea':
        case 'quickadjustments':
        case 'flowmultiplier':
            isLoading = settingsCache.reaLoading;
            error = settingsCache.reaError;
            break;
        case 'de1':
        case 'fanthreshold':
        case 'watertank':
        case 'flush':
        case 'steam':
        case 'hotwater':
        case 'calib_fan':
            isLoading = settingsCache.de1Loading;
            error = settingsCache.de1Error;
            break;
        case 'usbchargermode':
            isLoading = settingsCache.de1Loading || settingsCache.reaLoading;
            error = settingsCache.de1Error || settingsCache.reaError;
            break;
        case 'machineinfo':
            isLoading = settingsCache.machineInfoLoading;
            error = settingsCache.machineInfoError;
            break;
        case 'de1advanced':
        case 'calib_refillkit':
        case 'calib_voltage':
            isLoading = settingsCache.de1AdvancedLoading;
            error = settingsCache.de1AdvancedError;
            break;
        default:
            // For categories that don't require specific settings, check if any settings are loading
            isLoading = settingsCache.reaLoading || settingsCache.de1Loading || settingsCache.de1AdvancedLoading;
            break;
    }

    // Show loading state if the required settings are still loading
    if (isLoading) {
        return renderLoadingState(getTranslation(getCategoryTitle(category)));
    }

    // Show error state if there was an error loading the required settings
    if (error && (
        category === 'rea' ||
        category === 'quickadjustments' ||
        category === 'flowmultiplier' ||
        category === 'de1' ||
        category === 'fanthreshold' ||
        category === 'usbchargermode' ||
        category === 'watertank' ||
        category === 'flush' ||
        category === 'steam' ||
        category === 'hotwater' ||
        category === 'de1advanced' ||
        category === 'calib_fan' ||
        category === 'calib_refillkit' ||
        category === 'calib_voltage'
    )) {
        return renderErrorState(getTranslation(getCategoryTitle(category)), error);
    }

    // Render actual content once settings are loaded
    switch(category) {
        case 'rea':
            return renderReaSettingsForm(settingsCache.rea);
        case 'quickadjustments':
        case 'flowmultiplier':
            return renderFlowMultiplierSettings(settingsCache.rea);
        case 'steam':
            return renderSteamSettings();
        case 'hotwater':
            return renderHotWaterSettings();
        case 'watertank':
            return renderWaterTankSettings();
        case 'flush':
            return renderFlushSettingsForm(settingsCache.de1);
        case 'ble_scale':
            return renderBluetoothScaleSettings(settingsCache.rea);
        case 'ble_machine':
            return renderBluetoothMachineSettings();
        case 'calib_fan':
            return renderCalibFanSettings(settingsCache.de1);
        case 'calib_defaultload':
            return renderCalibDefaultLoadSettings();
        case 'calib_refillkit':
            return renderCalibRefillKitSettings();
        case 'calib_voltage':
            return renderCalibVoltageSettings();
        case 'calib_steam':
            return renderCalibSteamSettings();
        case 'calib_sensors':
            return renderSensorCalSettings();
        case 'calib_loadcell':
            return renderLoadCellCalibration();
        case 'maint_cleaning':
        case 'maint_descaling':
        case 'maint_airpurge':
            // Mounted by the extracted category module, not rendered here.
            return '';
        case 'theme':
            return renderThemeSettings();
        case 'skin':
        case 'appearance':
            return renderSkinSettings();
        case 'language':
        case 'selectlanguage':
            return renderLanguageSettings();
        case 'plugins':
            return renderPluginManagerSettings();
        case 'shotupload':
            return renderShotUploadSettings();
        case 'dye2':
            return renderDye2Settings();
        case 'printtheshot':
            return renderPrintTheShotSettings();
        case 'extensions':
        case 'extention1':
        case 'extention2':
            return renderExtensionsSettings();
        case 'screensaver':
            return renderScreenSaverSettings();
        case 'brightness':
            return renderBrightnessSettings();
        case 'wakelock':
            return renderWakeLockSettings();
        case 'presence':
            return renderPresenceSettings();
        case 'unitssettings':
            return renderUnitsSettings();
        case 'fontsize':
            return renderFontSizeSettings();
        case 'tempunit':
            return renderTempUnitSettings();
        case 'resolution':
            return renderResolutionSettings();
        case 'machineadvancedsettings':
        case 'misc':
        case 'miscellaneous':
            return renderMiscellaneousSettings();
        case 'firmware':
        case 'firmwareupdate':
            return renderFirmwareUpdateSettings();
        case 'feedback':
            return renderFeedbackSettings();
        case 'talkdecent':
            return renderTalkToDecentSettings();
        case 'quickstart':
            return renderQuickstartGuideSettings();
        case 'de1':
        case 'fanthreshold':
            return renderFanThresholdSettings(settingsCache.de1);
        case 'usbchargermode':
            return renderUsbChargerModeSettings(settingsCache.de1);
        case 'cupwarmer':
            return renderCupWarmerSettings();
        case 'ledstrip':
            return renderLedSettings();
        case 'machineinfo':
            return renderMachineInformationSettings();
        case 'de1advanced':
            return renderDe1AdvancedSettingsForm(settingsCache.de1Advanced);
        case 'hot water':
            return renderHotWaterSettings(settingsCache.de1);
        case 'keyboard_shortcuts':
            return renderKeyboardShortcutsSettings();
        case 'homeassistant':
            return renderHomeAssistantSettings();
        default:
            return renderGeneralSettings();
    }
}

// Render Flow Multiplier settings
export function renderFlowMultiplierSettings(settings) {
    if (!settings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]" data-i18n-key="Flow Multiplier Settings">Flow Multiplier Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]" data-i18n-key="Failed to load flow multiplier settings">Failed to load flow multiplier settings</div>
            </div>
        `;
    }

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Flow Multiplier Settings">Flow Multiplier Settings</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[20px] items-center px-[60px] py-[20px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p id="weight-flow-multiplier-label" class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]" data-i18n-key="Weight Flow Multiplier">
                            Weight Flow Multiplier
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="weight-flow-mult-minus" aria-label="Decrease weight flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustWeightFlowMultiplier(-0.1);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="decimal" id="weightFlowMultiplierInput" aria-labelledby="weight-flow-multiplier-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${settings.weightFlowMultiplier !== undefined ? settings.weightFlowMultiplier : 1.0}"
                                   step="0.1" min="0"
                                   onchange="window.updateReaSetting('weightFlowMultiplier', parseFloat(this.value))">
                        </div>
                        <button id="weight-flow-mult-plus" aria-label="Increase weight flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustWeightFlowMultiplier(0.1);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Multiplier factor applied to weight flow for projected weight calculation when stopping shots by weight. Default is 1.0. Higher values stop the shot earlier, lower values stop later.
                    </p>
                </div>

                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[20px] items-center px-[60px] py-[20px] relative shrink-0 w-[590px] mt-[30px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p id="volume-flow-multiplier-label" class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]" data-i18n-key="Volume Flow Multiplier (s)">
                            Volume Flow Multiplier (s)
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="volume-flow-mult-minus" aria-label="Decrease volume flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustVolumeFlowMultiplier(-0.05);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="decimal" id="volumeFlowMultiplierInput" aria-labelledby="volume-flow-multiplier-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${settings.volumeFlowMultiplier !== undefined ? settings.volumeFlowMultiplier : 0.3}"
                                   step="0.05" min="0"
                                   onchange="window.updateReaSetting('volumeFlowMultiplier', parseFloat(this.value))">
                            <span class="ml-2 text-nowrap" aria-hidden="true">s</span>
                        </div>
                        <button id="volume-flow-mult-plus" aria-label="Increase volume flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustVolumeFlowMultiplier(0.05);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center">
                        Multiplier factor (in seconds) applied to machine flow for projected volume calculation when stopping shots by volume. Default is 0.3. This accounts for system lag between stop command and actual flow stop.
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Host exit, moved off the old floating home button. The host can inject its API
// after this module runs, so decentApp is resolved on click, not at load.
//
// Only good while the skin server has not been restarted under us: the URL
// skin-api.js bakes in carries the port this page was served on, and Decaid
// compares it against the port it is serving right now (see setActiveSkin).
// After a restart no exit URL can pass, which is why switching skins navigates
// into the new skin rather than going out through the dashboard.
function exitToDecentDashboard() {
    const app = window.decentApp;
    // Gate on __DECENT_HOST__, not on the function: skin-api.js is served to plain
    // browsers too, where exitToDashboard exists but no-ops on its own host check.
    if (window.__DECENT_HOST__ && typeof app?.exitToDashboard === 'function') { app.exitToDashboard(); return; }
    console.log('[exit-dashboard] no host exit API', JSON.stringify({
        decentApp: app ? Object.keys(app) : null,
        host: window.__DECENT_HOST__ || null,
        ua: navigator.userAgent,
    }));
    window.app?.ui?.showToast?.('No dashboard exit API in this host', 3000, 'error');
}

// Render REA settings form matching design
export function renderReaSettingsForm(settings) {
    if (!settings) {
        return `
            <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                    <p class="leading-[1.2]" data-i18n-key="Decaid Settings">Decaid Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]">Failed to load settings</div>
            </div>
        `;
    }

    // Decaid's own build info and update control. It used to sit at the bottom of
    // the Firmware Update page, under the DE1 firmware controls it has nothing to do
    // with -- one page updating two different things. This is the Decaid page, and
    // Automatic Update Checks right above already governs the check this card runs.
    const appInfo = settingsCache.appInfo;
    const appInfoDetails = appInfo ? `
                <div class="grid gap-[12px] sm:grid-cols-2">
                    <div class="rounded-[10px] border border-[#c9c9c9] px-4 py-3 bg-[var(--box-color)]">
                        <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]" data-i18n-key="Version">Version</p>
                        <p class="text-[24px] font-['Inter:Regular',sans-serif]">${appInfo.version} (${appInfo.buildNumber})</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">${appInfo.fullVersion} &middot; ${formatBuildTimestamp(appInfo.buildTime)}</p>
                    </div>
                    <div id="app-update-section" class="rounded-[10px] border border-[#c9c9c9] px-4 py-3 bg-[var(--box-color)]">${renderAppUpdateBlock(settingsCache.appUpdateState)}</div>
                </div>
            ` : `
                <div class="grid gap-[12px] sm:grid-cols-2">
                    <div class="rounded-[10px] border border-[#c9c9c9] px-4 py-3 bg-[var(--box-color)]">
                        <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]" data-i18n-key="Version">Version</p>
                        <p class="text-[24px] font-['Inter:Regular',sans-serif]" data-i18n-key="Fetching build metadata...">Fetching build metadata...</p>
                    </div>
                    <div id="app-update-section" class="rounded-[10px] border border-[#c9c9c9] px-4 py-3 bg-[var(--box-color)]">${renderAppUpdateBlock(settingsCache.appUpdateState)}</div>
                </div>
            `;

    return `
        <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]" data-i18n-key="Decaid Settings">Decaid Settings</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex flex-col items-start relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px] mb-[20px]">
                            <p id="gateway-mode-label" class="leading-[1.2]" data-i18n-key="Gateway Mode">Gateway Mode</p>
                        </div>
                        <div class="flex items-center justify-between w-full max-w-[885px]" role="group" aria-labelledby="gateway-mode-label">
                            <button class="h-[120px] w-[295px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[30px] flex items-center justify-center cursor-pointer transition-colors duration-200
                                ${settings.gatewayMode === 'disabled' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                                aria-pressed="${settings.gatewayMode === 'disabled'}"
                                onclick="window.updateReaSetting('gatewayMode', 'disabled')" data-i18n-key="Disabled">
                                Disabled
                            </button>
                            <button class="h-[120px] w-[295px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[30px] flex items-center justify-center cursor-pointer transition-colors duration-200
                                ${settings.gatewayMode === 'tracking' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                                aria-pressed="${settings.gatewayMode === 'tracking'}"
                                onclick="window.updateReaSetting('gatewayMode', 'tracking')">
                                Tracking
                            </button>
                            <button class="h-[120px] w-[295px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[30px] flex items-center justify-center cursor-pointer transition-colors duration-200
                                ${settings.gatewayMode === 'full' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                                aria-pressed="${settings.gatewayMode === 'full'}"
                                onclick="window.updateReaSetting('gatewayMode', 'full')">
                                Full
                            </button>
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words" data-i18n-key="Controls how the gateway monitors and controls the espresso machine">
                        Controls how the gateway monitors and controls the espresso machine
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex items-center justify-between relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p id="log-level-label" class="leading-[1.2]" data-i18n-key="Log Level">Log Level</p>
                        </div>
                        <select id="logLevelSelect" aria-labelledby="log-level-label" class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[250px] text-white text-[24px] p-2 max-w-[250px]"
                                onchange="window.updateReaSetting('logLevel', this.value)">
                            <option value="ALL" ${settings.logLevel === 'ALL' ? 'selected' : ''} data-i18n-key="ALL">ALL</option>
                            <option value="FINEST" ${settings.logLevel === 'FINEST' ? 'selected' : ''} data-i18n-key="FINEST">FINEST</option>
                            <option value="FINER" ${settings.logLevel === 'FINER' ? 'selected' : ''} data-i18n-key="FINER">FINER</option>
                            <option value="FINE" ${settings.logLevel === 'FINE' ? 'selected' : ''} data-i18n-key="FINE">FINE</option>
                            <option value="CONFIG" ${settings.logLevel === 'CONFIG' ? 'selected' : ''} data-i18n-key="CONFIG">CONFIG</option>
                            <option value="INFO" ${settings.logLevel === 'INFO' ? 'selected' : ''} data-i18n-key="INFO">INFO</option>
                            <option value="WARNING" ${settings.logLevel === 'WARNING' ? 'selected' : ''} data-i18n-key="WARNING">WARNING</option>
                            <option value="SEVERE" ${settings.logLevel === 'SEVERE' ? 'selected' : ''} data-i18n-key="SEVERE">SEVERE</option>
                            <option value="SHOUT" ${settings.logLevel === 'SHOUT' ? 'selected' : ''} data-i18n-key="SHOUT">SHOUT</option>
                            <option value="OFF" ${settings.logLevel === 'OFF' ? 'selected' : ''} data-i18n-key="OFF">OFF</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words" data-i18n-key="Sets the verbosity of application logging output">
                        Sets the verbosity of application logging output
                    </p>
                </div>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex items-center justify-between relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Automatic Update Checks">Automatic Update Checks</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[250px] text-white text-[24px] p-2 max-w-[250px]"
                                onchange="window.updateReaSetting('automaticUpdateCheck', this.value === 'true')">
                            <option value="true" ${settings.automaticUpdateCheck !== false ? 'selected' : ''} data-i18n-key="Enabled">Enabled</option>
                            <option value="false" ${settings.automaticUpdateCheck === false ? 'selected' : ''} data-i18n-key="Disabled">Disabled</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words pr-[270px]" data-i18n-key="Check for app updates every 12 hours automatically">
                        Check for app updates every 12 hours automatically
                    </p>
                </div>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="w-full flex flex-col gap-[12px]">
                <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px] leading-[1.2]">Decaid <span data-i18n-key="Update info">Update info</span></p>
                ${appInfoDetails}
            </div>

            ${settings.webUiPath ? `
            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[20px] items-start relative w-full max-w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]" data-i18n-key="Web UI Path">Web UI Path</p>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal text-[20px] text-[var(--text-secondary)] break-all">${settings.webUiPath}</p>
                </div>
            </div>
            ` : ''}

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex items-center justify-between relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Go to Dashboard">Go to Dashboard</p>
                        </div>
                        <button type="button" class="bg-[#385a92] h-[62.88px] px-[48px] rounded-[2617.374px] text-white text-[24px] font-bold"
                                onclick="window.exitToDecentDashboard()" data-i18n-key="Go">Go</button>
                    </div>
                </div>
            </div>

        </div>
    `;
}

// Render Flush settings form
export function renderFlushSettingsForm(settings) {
    console.log("rendering flush settings form with settings: ", settings);
    if (!settings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]" data-i18n-key="Flush Settings">Flush Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]" data-i18n-key="Failed to load flush settings">Failed to load flush settings</div>
            </div>
        `;
    }

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Flush Settings">Flush Settings</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[20px] items-center px-[60px] py-[20px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-baseline gap-[14px] relative shrink-0">
                        <p id="flush-temp-label" class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]" data-i18n-key="Temperature for flush cycles">
                            Temperature for flush cycles
                        </p>
                        <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)] whitespace-nowrap">${tempInputValue(5)} – ${tempInputValue(95)} ${tempUnitLabel()}</span>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="flush-temp-minus" aria-label="Decrease flush temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFlushTemp(-5);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="flushTempInput" aria-labelledby="flush-temp-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${settings.flushTemp !== undefined ? tempInputValue(settings.flushTemp) : ''}"
                                   step="5" min="${tempInputValue(5)}" max="${tempInputValue(95)}"
                                   onchange="window.updateDe1Setting('flushTemp', window.tempInputToCelsius(this.value))">
                            <span class="ml-2" aria-hidden="true">${tempUnitLabel()}</span>
                        </div>
                        <button id="flush-temp-plus" aria-label="Increase flush temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFlushTemp(5);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                </div>

                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[20px] items-center px-[60px] py-[20px] relative shrink-0 w-[590px] mt-[30px]">
                    <div class="content-stretch flex items-baseline gap-[14px] relative shrink-0">
                        <p id="flush-flow-label" class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]" data-i18n-key="Flush flow rate">
                            Flush flow rate
                        </p>
                        <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)] whitespace-nowrap">1 – 8 ml/s</span>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="flush-flow-minus" aria-label="Decrease flush flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFlushFlow(-1);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="flushFlowInput" aria-labelledby="flush-flow-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${settings.flushFlow !== undefined ? settings.flushFlow : ''}"
                                   step="1" min="1" max="8"
                                   onchange="window.updateDe1Setting('flushFlow', parseFloat(this.value))">
                            <span class="ml-2 text-nowrap" aria-hidden="true">ml/s</span>
                        </div>
                        <button id="flush-flow-plus" aria-label="Increase flush flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFlushFlow(1);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Render Fan Threshold settings
export function renderFanThresholdSettings(settings) {
    if (!settings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]" data-i18n-key="Fan Threshold">Fan Threshold</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]" data-i18n-key="Failed to load DE1 settings">Failed to load DE1 settings</div>
            </div>
        `;
    }

    const fanVal = settings.fan !== undefined ? settings.fan : 40;
    const pct = Math.round(Math.max(0, Math.min(100, fanVal)));

    return `
        <div class="content-stretch flex flex-col gap-[48px] items-start relative w-full">

            <!-- Page title -->
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Fan Threshold">Fan Threshold</p>
            </div>

            <!-- Central stepper card -->
            <div class="w-full bg-[var(--box-color)] border-2 border-[var(--profile-button-outline-color)] rounded-[24px] p-[40px] flex flex-col items-center gap-[32px]">

                <!-- Label row -->
                <div class="flex items-center gap-[10px]">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-[#385a92]">
                        <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
                    </svg>
                    <span class="text-[#385a92] text-[24px] font-bold tracking-wide uppercase" data-i18n-key="Fan Activation Temperature">Fan Activation Temperature</span>
                </div>

                <!-- Stepper controls -->
                <div class="flex items-center gap-[24px]">
                    <button id="fan-decrement"
                            onclick="window.stepFanThreshold(-1)"
                            class="w-[88px] h-[88px] rounded-full border-2 border-[#385a92] bg-[var(--box-color)] text-[#385a92] text-[40px] font-bold flex items-center justify-center active:bg-[#385a92] active:text-white transition-colors select-none"
                            aria-label="Decrease fan threshold">
                        −
                    </button>

                    <div class="flex flex-col items-center gap-[4px]">
                        <div class="flex items-end gap-[6px]">
                            <span id="fan-display" class="text-[var(--text-primary)] font-bold leading-none"
                                  style="font-size: 96px; font-family: 'Inter', monospace; letter-spacing: -2px;">${pct}</span>
                            <span class="text-[#385a92] text-[36px] font-bold mb-[12px]">°C</span>
                        </div>
                        <input type="hidden" id="fanThresholdInput" value="${pct}">
                    </div>

                    <button id="fan-increment"
                            onclick="window.stepFanThreshold(1)"
                            class="w-[88px] h-[88px] rounded-full border-2 border-[#385a92] bg-[var(--box-color)] text-[#385a92] text-[40px] font-bold flex items-center justify-center active:bg-[#385a92] active:text-white transition-colors select-none"
                            aria-label="Increase fan threshold">
                        +
                    </button>
                </div>

                <!-- Range track -->
                <div class="w-full flex flex-col gap-[8px]">
                    <div class="w-full h-[8px] rounded-full bg-[var(--profile-button-outline-color)] overflow-hidden">
                        <div id="fan-track-fill"
                             class="h-full rounded-full bg-[#385a92] transition-all duration-150"
                             style="width: ${pct}%"></div>
                    </div>
                    <div class="flex justify-between text-[18px] text-[var(--text-primary)] opacity-50">
                        <span>0°C</span>
                        <span data-i18n-key="Range: 0 – 100°C">Range: 0 – 100°C</span>
                        <span>100°C</span>
                    </div>
                </div>
            </div>

            <!-- Description -->
            <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.5] text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="The fan activates when the machine's internal temperature exceeds this threshold.">
                The fan activates when the machine's internal temperature exceeds this threshold.
                Lower values run the fan more often; higher values keep it quieter during operation.
            </p>
        </div>
    `;
}

// Render USB Charger settings — combines USB charger toggle + Smart Charging controls
export function renderUsbChargerModeSettings(settings) {
    const reaSettings = settingsCache.rea;
    if (!settings || !reaSettings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">USB</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]" data-i18n-key="Failed to load settings">Failed to load settings</div>
            </div>
        `;
    }

    const chargingMode = reaSettings.chargingMode || 'disabled';
    const nightModeEnabled = reaSettings.nightModeEnabled || false;
    const sleepTime = reaSettings.nightModeSleepTime ?? 1320;
    const morningTime = reaSettings.nightModeMorningTime ?? 420;
    const chargingState = reaSettings.chargingState;
    // Native time picker (dropdown + spinner) follows color-scheme, not our
    // CSS vars — match it to the active theme so it renders dark.
    const pickerScheme = (localStorage.getItem('theme') || 'light') === 'dark' ? 'dark' : 'light';

    const phaseLabels = {
        inactive: 'Inactive',
        normal: 'Normal',
        hovering: 'Hovering',
        chargingToMax: 'Charging to Max',
        sleeping: 'Sleeping'
    };

    // Sleep/Morning share one row — they're both night-mode params, so nesting
    // them keeps the page short instead of two full-height stacked sections.
    const timeField = (id, label, value, kind) => `
        <div class="flex-1 flex items-center justify-between gap-[16px] bg-[var(--box-color)] border-2 border-[#385a92] rounded-[16px] px-[24px] h-[80px]">
            <span class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[26px]">${label}</span>
            <input type="time" id="${id}" lang="en-US"
                   style="color-scheme: ${pickerScheme}"
                   class="bg-transparent text-[var(--text-primary)] text-[28px] font-bold text-right w-[210px] outline-none cursor-pointer"
                   value="${minutesToTimeString(value)}"
                   onclick="this.showPicker?.()"
                   onchange="handleNightModeTimeChange('${kind}', this.value)">
        </div>`;

    const nightModeSection = chargingMode !== 'disabled' ? `
        <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

        <div class="flex flex-col gap-[16px] w-full">
            <div class="flex items-center justify-between gap-[24px] w-full">
                <div class="flex flex-col gap-[4px]">
                    <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px] leading-[1.2]" data-i18n-key="Night Mode">Night Mode</p>
                    <p class="font-['Inter:Regular',sans-serif] font-normal text-[var(--text-primary)] text-[22px] leading-[1.3]" data-i18n-key="Charge conservatively overnight between a sleep and morning time">Charge conservatively overnight between a sleep and morning time</p>
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <input type="checkbox" id="night-mode-toggle"
                           class="sr-only peer"
                           ${nightModeEnabled ? 'checked' : ''}
                           onchange="handleNightModeToggle(this.checked)">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>
            ${nightModeEnabled ? `
            <div class="flex gap-[16px] w-full">
                ${timeField('night-mode-sleep-time', 'Sleep', sleepTime, 'sleep')}
                ${timeField('night-mode-morning-time', 'Morning', morningTime, 'morning')}
            </div>` : ''}
        </div>
    ` : '';

    const statusSection = chargingState ? `
        <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

        <div class="content-stretch flex flex-col items-start relative w-full">
            <div class="content-stretch flex flex-col gap-[12px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]" data-i18n-key="Charging Status">Charging Status</p>
                </div>
                <div class="grid grid-cols-2 gap-x-8 gap-y-4 w-full text-[22px] text-[var(--text-primary)]">
                    <span class="font-semibold" data-i18n-key="Battery">Battery</span>
                    <span>${chargingState.batteryPercent ?? '--'}%${chargingState.isEmergency ? ' (emergency)' : ''}</span>
                    <span class="font-semibold" data-i18n-key="Phase">Phase</span>
                    <span>${getTranslation(phaseLabels[chargingState.currentPhase] || chargingState.currentPhase || '--')}</span>
                    <span class="font-semibold">USB</span>
                    <span>${getTranslation(chargingState.usbChargerOn ? 'ON' : 'OFF')}</span>
                </div>
            </div>
        </div>
    ` : '';

    return `
        <div class="content-stretch flex flex-col gap-[24px] items-start relative w-full">

            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">USB</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="flex items-center justify-between gap-[24px] w-full">
                <div class="flex flex-col gap-[4px]">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]" id="usbChargerModeLabel" data-i18n-key="USB Charger Mode">USB Charger Mode</p>
                    </div>
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <!-- Default on: an unset usb value means the machine never had
                         the setting written, and USB power is on out of the box. -->
                    <input type="checkbox" id="usbChargerModeToggle"
                           class="sr-only peer"
                           ${(settings.usb === false || settings.usb === 'disable') ? '' : 'checked'}
                           onchange="window.updateDe1Setting('usb', this.checked ? 'enable' : 'disable')">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[12px] items-start relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]" data-i18n-key="Charging Mode">Charging Mode</p>
                    </div>
                    <div class="grid grid-cols-2 gap-[12px] w-full">
                        ${[
                            { value: 'disabled',         label: 'Charge to 100%',   sub: 'no battery management' },
                            { value: 'highAvailability', label: 'Charge to 95%',    sub: 'slightly better battery life' },
                            { value: 'balanced',         label: 'Charge up to 80%', sub: 'better battery life' },
                            { value: 'longevity',        label: 'Charge up to 55%', sub: 'best battery life' }
                        ].map(({ value, label, sub }) => {
                            const active = chargingMode === value;
                            return `<button
                                onclick="handleSmartChargingModeChange('${value}')"
                                aria-pressed="${active}"
                                class="flex flex-col items-start justify-center gap-[4px] px-[24px] py-[14px] rounded-[14px] border-2 transition-colors duration-150 cursor-pointer text-left
                                    ${active
                                        ? 'bg-[#385a92] border-[#385a92] text-white'
                                        : 'bg-[var(--box-color)] border-[var(--profile-button-outline-color)] text-[var(--text-primary)]'}">
                                <span class="font-['Inter:Bold',sans-serif] font-bold text-[26px] leading-tight">${label}</span>
                                <span class="font-['Inter:Regular',sans-serif] text-[19px] leading-snug opacity-80">${sub}</span>
                            </button>`;
                        }).join('')}
                    </div>
                </div>
            </div>

            ${nightModeSection}

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex items-center justify-between gap-[24px] relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]" data-i18n-key="Dim the screen when low battery">Dim the screen when low battery</p>
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <input type="checkbox" id="low-battery-brightness-limit-toggle"
                           class="sr-only peer"
                           ${reaSettings.lowBatteryBrightnessLimit ? 'checked' : ''}
                           onchange="window.updateReaSetting('lowBatteryBrightnessLimit', this.checked)">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>

            ${statusSection}
        </div>
    `;
}

// Render DE1 Advanced settings form
export function renderDe1AdvancedSettingsForm(settings) {
    if (!settings) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]" data-i18n-key="Before espresso starts">Before espresso starts</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]" data-i18n-key="Failed to load DE1 advanced settings">Failed to load DE1 advanced settings</div>
            </div>
        `;
    }

    return `
        <div class="content-stretch flex flex-col gap-[40px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Before espresso starts">Before espresso starts</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Idle temperature">Idle temperature</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)] whitespace-nowrap">${tempInputValue(0)} – ${tempInputValue(99)} ${tempUnitLabel()}</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease idle temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterIdleTemp(-1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="heaterIdleTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${settings.heaterIdleTemp !== undefined ? tempInputValue(settings.heaterIdleTemp) : ''}"
                                       step="1" min="${tempInputValue(0)}" max="${tempInputValue(99)}"
                                       onchange="window.updateDe1AdvancedSetting('heaterIdleTemp', window.tempInputToCelsius(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">${tempUnitLabel()}</span>
                            </div>
                            <button aria-label="Increase idle temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterIdleTemp(1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Heater warmup flow rate">Heater warmup flow rate</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)] whitespace-nowrap">0 – 10 ml/s</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease heater warmup flow rate" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh1Flow(-0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="decimal" id="heaterPh1FlowInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${settings.heaterPh1Flow !== undefined ? settings.heaterPh1Flow : ''}"
                                       step="0.1" min="0" max="10"
                                       onchange="window.updateDe1AdvancedSetting('heaterPh1Flow', parseFloat(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml/s</span>
                            </div>
                            <button aria-label="Increase heater warmup flow rate" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh1Flow(0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Heater test flow rate">Heater test flow rate</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)] whitespace-nowrap">0 – 10 ml/s</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease heater test flow rate" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh2Flow(-0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="decimal" id="heaterPh2FlowInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${settings.heaterPh2Flow !== undefined ? settings.heaterPh2Flow : ''}"
                                       step="0.1" min="0" max="10"
                                       onchange="window.updateDe1AdvancedSetting('heaterPh2Flow', parseFloat(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml/s</span>
                            </div>
                            <button aria-label="Increase heater test flow rate" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh2Flow(0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Heater test time-out">Heater test time-out</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)] whitespace-nowrap">0 – 60 sec</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease heater test time-out" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh2Timeout(-1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="heaterPh2TimeoutInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${settings.heaterPh2Timeout !== undefined ? settings.heaterPh2Timeout : ''}"
                                       step="1" min="0" max="60"
                                       onchange="window.updateDe1AdvancedSetting('heaterPh2Timeout', parseInt(this.value, 10))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">sec</span>
                            </div>
                            <button aria-label="Increase heater test time-out" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHeaterPh2Timeout(1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Fast Start Defaults">Fast Start Defaults</p>
                        </div>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="window.applyFastStartDefaults()" data-i18n-key="Apply">
                            Apply
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Sets the four settings above to the cafe preset, for the shortest wait before the first espresso.">
                        Sets the four settings above to the cafe preset, for the shortest wait before the first espresso.
                    </p>
                </div>
            </div>
        </div>
    `;
}


// Render user manual settings
export function renderQuickstartGuideSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Quickstart Guide">Quickstart Guide</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Quickstart Guide">Quick Start Guide</p>
                        </div>
                        <a href="https://decentespresso.com/doc/quickstart/" class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold flex items-center justify-center">
                            View
                        </a>
                    </div>

                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Streamline User Manual">Streamline User Manual</p>
                        </div>
                        <a href="https://github.com/decentespresso/streamline-js/blob/main/README.md" class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold flex items-center justify-center">
                            View
                        </a>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="The full manual for this skin: every screen, setting and gesture.">
                        The full manual for this skin: every screen, setting and gesture.
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col gap-[12px] items-start relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]" data-i18n-key="Show help button">Show help button</p>
                    </div>
                    <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                        <input type="checkbox" id="help-icon-toggle" class="sr-only peer">
                        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                        <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                    </label>
                </div>
            </div>
        </div>
    `;
}

// Wire the "Show help button" toggle. Reflects whether the overlay's ? button
// is currently hidden, and restores/hides it via helpOverlay's global hooks.
function initQuickstartGuideSettings() {
    const toggle = document.getElementById('help-icon-toggle');
    if (!toggle) return;
    toggle.checked = !(window.isHelpButtonHidden?.() ?? false);
    toggle.addEventListener('change', () => {
        if (toggle.checked) window.showHelpButton?.();
        else window.hideHelpButton?.();
    });
}

export function renderTalkToDecentSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[48px] items-start relative w-full">

            <!-- Header -->
            <div class="flex flex-col gap-[8px] w-full">
                <div class="flex items-center gap-[16px]">
                    <div class="w-[48px] h-[48px] rounded-full bg-[#385a92] flex items-center justify-center flex-shrink-0">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z" fill="white"/>
                        </svg>
                    </div>
                    <div>
                        <p class="text-[36px] font-semibold text-[var(--text-primary)] leading-[1.1]" data-i18n-key="Talk to Decent">Talk to Decent</p>
                        <p class="text-[20px] text-[var(--low-contrast-white)] leading-[1.3]">Direct line to the Decent support team</p>
                    </div>
                </div>
            </div>

            <!-- Not logged in state -->
            <div id="talkdecent-logged-out" class="w-full">
                <div class="flex flex-col gap-[24px] p-[36px] rounded-[20px] border-2 border-dashed border-[var(--profile-button-outline-color)] bg-[var(--box-color)] items-center text-center">
                    <div class="w-[64px] h-[64px] rounded-full bg-[var(--button-grey)] flex items-center justify-center">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 12C14.7614 12 17 9.76142 17 7C17 4.23858 14.7614 2 12 2C9.23858 2 7 4.23858 7 7C7 9.76142 9.23858 12 12 12Z" fill="currentColor" class="text-[var(--low-contrast-white)]"/>
                            <path d="M12 14C7.58172 14 4 17.5817 4 22H20C20 17.5817 16.4183 14 12 14Z" fill="currentColor" class="text-[var(--low-contrast-white)]"/>
                        </svg>
                    </div>
                    <div class="flex flex-col gap-[8px]">
                        <p class="text-[26px] font-bold text-[var(--text-primary)]">No Decent account linked</p>
                        <p class="text-[22px] text-[var(--low-contrast-white)] max-w-[500px] leading-[1.4]" data-i18n-key="Link your Decent account in the Decent app to send messages to support.">
                            Link your Decent account in the Decent app to send messages to support.
                        </p>
                    </div>
                </div>
            </div>

            <!-- Logged in / compose state -->
            <div id="talkdecent-logged-in" class="hidden w-full flex flex-col gap-[36px]">

                <!-- Account badge -->
                <div class="flex items-center p-[20px] rounded-[14px] bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] gap-[14px]">
                    <div class="w-[40px] h-[40px] rounded-full bg-[#385a92] flex items-center justify-center text-white text-[18px] font-bold">D</div>
                    <div>
                        <p class="text-[20px] font-semibold text-[var(--text-primary)]">Decent account linked</p>
                        <p class="text-[18px] text-[var(--low-contrast-white)]" id="talkdecent-account-serial"></p>
                    </div>
                </div>

                <!-- Chat thread -->
                <div class="flex flex-col gap-[12px] w-full">
                    <div class="flex items-center justify-between">
                        <p class="text-[22px] font-bold text-[#385a92]">Conversation History</p>
                        <button id="talkdecent-refresh-btn"
                                onclick="window.talkDecentRefresh()"
                                class="h-[38px] px-[20px] rounded-[38px] bg-[var(--button-grey)] text-[var(--text-primary)] text-[18px] flex items-center gap-[8px] transition-opacity hover:opacity-80 disabled:opacity-40">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M1 4V10H7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M3.51 15a9 9 0 1 0 .49-4.17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            Refresh
                        </button>
                    </div>
                    <div id="talkdecent-thread-messages"
                         class="flex flex-col gap-[14px] max-h-[480px] overflow-y-auto p-[20px] bg-[var(--box-color)] rounded-[16px] border border-[var(--profile-button-outline-color)]">
                        <p class="text-center text-[18px] text-[var(--low-contrast-white)] py-[16px]">Loading messages…</p>
                    </div>
                    <p id="talkdecent-thread-status" class="text-[18px] text-[var(--low-contrast-white)] text-center hidden"></p>
                </div>

                <!-- New message compose -->
                <div class="flex flex-col gap-[24px] w-full">
                    <p class="text-[22px] font-bold text-[#385a92]">New Message</p>
                    <input id="talkdecent-subject" type="hidden" value="">
                    <textarea id="talkdecent-message" class="hidden"></textarea>
                    <div id="talkdecent-compose-preview"
                         onclick="window.openTalkDecentMessageEditor()"
                         class="cursor-pointer rounded-[14px] p-[20px] bg-[var(--box-color)] border-2 border-[#385a92] w-full min-h-[90px] select-none transition-colors hover:border-blue-400">
                        <p class="text-[20px] text-[var(--low-contrast-white)]">Tap to compose a message…</p>
                    </div>
                    <!-- Attach machine info toggle -->
                    <div class="flex items-center justify-between p-[20px] rounded-[12px] bg-[var(--box-color)] border border-[var(--profile-button-outline-color)]">
                        <div class="flex flex-col gap-[4px]">
                            <p class="text-[22px] font-bold text-[#385a92]">Attach Machine Info</p>
                            <p class="text-[20px] text-[var(--low-contrast-white)]">Appends machine model, firmware version, and serial number</p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="talkdecent-attach-machine" checked class="sr-only peer">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>
                    <div class="flex items-center gap-[20px]">
                        <button id="talkdecent-send-btn"
                                onclick="window.sendDecentMessage()"
                                class="h-[64px] px-[48px] rounded-[64px] bg-[#385a92] text-white text-[24px] font-bold transition-opacity hover:opacity-90">
                            Send Message
                        </button>
                        <span id="talkdecent-send-status" class="text-[22px] leading-[1.4]"></span>
                    </div>
                </div>
            </div>

        </div>
    `;
}

// Render Feedback / bug report page

export function renderFeedbackSettings() {
    const categories = [
        { value: 'bug',      label: 'Bug Report',       sub: 'Something isn\'t working' },
        { value: 'feature',  label: 'Feature Request',  sub: 'Suggest an improvement'   },
        { value: 'question', label: 'General Feedback', sub: 'Share thoughts or ideas'  },
    ];

    const categoryCards = categories.map(({ value, label, sub }) => `
        <button data-feedback-card="${value}"
                aria-pressed="${value === 'bug'}"
                onclick="window.selectFeedbackCategory('${value}')"
                class="flex flex-col items-start gap-[4px] p-[14px] rounded-[12px] border-2 transition-colors
                       ${value === 'bug'
                           ? 'bg-[#385a92] border-[#385a92] text-white'
                           : 'bg-[var(--box-color)] border-[var(--profile-button-outline-color)] text-[var(--text-primary)]'}">
            <span class="text-[20px] font-bold leading-tight">${label}</span>
            <span class="text-[16px] opacity-75 leading-tight">${sub}</span>
        </button>
    `).join('');

    return `
        <div class="content-stretch flex flex-col gap-[24px] items-start relative w-full">
            <p class="font-semibold text-[var(--text-primary)] text-[32px] w-full text-center" data-i18n-key="Send Feedback">Send Feedback</p>
            <p class="text-[19px] text-[var(--low-contrast-white)] w-full text-center">Feedback is submitted as a public GitHub issue. Do not include personal or private information.</p>

            <!-- Category -->
            <div class="flex flex-col gap-[10px] w-full">
                <p class="font-bold text-[#385a92] text-[22px]" data-i18n-key="Category">Category</p>
                <input type="hidden" id="feedback-category" value="bug">
                <div class="grid grid-cols-3 gap-[10px] w-full">
                    ${categoryCards}
                </div>
            </div>

            <!-- Title -->
            <div class="flex flex-col gap-[8px] w-full">
                <p class="font-bold text-[#385a92] text-[22px]" data-i18n-key="Title">Title</p>
                <input type="text" id="feedback-title"
                       class="bg-[var(--box-color)] border-2 border-[#385a92] h-[54px] rounded-[54px] w-full text-[var(--text-primary)] text-[22px] px-[24px]"
                       placeholder="Short summary of your feedback…">
            </div>

            <!-- Description -->
            <div class="flex flex-col gap-[8px] w-full">
                <p class="font-bold text-[#385a92] text-[22px]" data-i18n-key="Description">Description</p>
                <textarea id="feedback-description" class="hidden"></textarea>
                <div id="feedback-description-preview"
                     onclick="window.openFeedbackDescriptionEditor()"
                     class="cursor-pointer bg-[var(--box-color)] border-2 border-[#385a92] rounded-[14px] w-full min-h-[110px] text-[21px] p-[18px] whitespace-pre-wrap select-none text-[var(--low-contrast-white)]" data-i18n-key="Tap to write description…">
                    Tap to write description…
                </div>
            </div>

            <!-- System info toggle -->
            <div class="flex items-center justify-between w-full">
                <div class="flex flex-col gap-[4px]">
                    <p class="font-bold text-[#385a92] text-[22px]">Attach Diagnostics</p>
                    <p class="text-[var(--text-primary)] text-[19px]">Includes application logs in a secret (unlisted) Gist. The Gist URL is added to the public GitHub issue, so anyone who can view the issue can access the logs. Also includes Decaid app version, platform, and OS version</p>
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <input type="checkbox" id="feedback-attach-sysinfo" checked class="sr-only peer">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>

            <!-- Submit -->
            <div class="flex flex-col gap-[12px] w-full">
                <button id="feedback-submit-btn"
                        onclick="window.submitFeedback()"
                        class="bg-[#385a92] h-[54px] px-[40px] rounded-[54px] text-white text-[22px] font-bold self-start" data-i18n-key="Submit">
                    Submit
                </button>
                <div id="feedback-status" class="text-[22px] leading-[1.4]"></div>
            </div>
        </div>
    `;
}

// Render Screen Saver settings
export function renderScreenSaverSettings() {
    const enabled = localStorage.getItem('screensaverEnabled') !== 'false';
    const hasCustom = screensaverImagesCache.length > 0;
    const cycleSeconds = parseInt(localStorage.getItem('screensaverCycleSeconds'), 10) || 10;
    const blackSaver = isBlackScreenSaver();
    // Hide the control where REA says the platform cannot set brightness --
    // DisplayState.platformSupported.brightness. Assume supported until the first
    // snapshot lands, so the row does not flicker in on load.
    const brightnessSupported = displayState()?.platformSupported?.brightness !== false;

    const thumbnails = screensaverImagesCache.map((src, i) => `
        <div class="relative w-[120px] h-[80px] rounded-[10px] overflow-hidden flex-shrink-0">
            <img src="${src}" class="w-full h-full object-cover" alt="Screensaver ${i + 1}">
        </div>
    `).join('');

    const imageButtons = hasCustom ? `
        <button class="bg-[#385a92] h-[62px] px-[36px] rounded-[72px] text-white text-[22px] font-bold"
                onclick="document.getElementById('screensaver-file-input').click()">
            Add Images
        </button>
        <button class="bg-[var(--box-color)] border-2 border-[#385a92] h-[62px] px-[36px] rounded-[72px] text-[#385a92] text-[22px] font-bold"
                onclick="window.clearScreensaverImages()">
            Clear All
        </button>
    ` : `
        <button class="bg-[#385a92] h-[62px] px-[36px] rounded-[72px] text-white text-[22px] font-bold"
                onclick="document.getElementById('screensaver-file-input').click()">
            Choose Images
        </button>
    `;

    const imageInfo = hasCustom ? `
        <div class="flex flex-wrap gap-[12px]">${thumbnails}</div>
        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-secondary)] text-[22px] w-full">
            ${screensaverImagesCache.length} image${screensaverImagesCache.length !== 1 ? 's' : ''} selected
        </p>
    ` : `
        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-secondary)] text-[22px] w-full" data-i18n-key="No custom images — using default. Select images from your device.">
            No custom images — using default. Select images from your device.
        </p>
    `;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Screen Saver">Screen Saver</p>
            </div>

            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                        <p class="leading-[1.2]" data-i18n-key="Show screen saver when the machine sleeps">Show screen saver when the machine sleeps</p>
                    </div>
                    <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                        <input type="checkbox" class="sr-only peer"
                               ${enabled && !blackSaver ? 'checked' : ''}
                               onchange="window.setScreensaverEnabled(this.checked)">
                        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                        <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                    </label>
                </div>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                        <p class="leading-[1.2]">Images</p>
                    </div>
                    <div class="flex items-center gap-[16px]">
                        ${imageButtons}
                    </div>
                </div>
                ${imageInfo}
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative ${screensaverImagesCache.length > 1 ? 'text-[#385a92]' : 'text-[var(--text-secondary)] opacity-50'} text-[30px]">
                        <p class="leading-[1.2]" data-i18n-key="Change image every:">Change image every:</p>
                        <span class="text-[20px] font-normal opacity-60">(2 – 600s)</span>
                    </div>
                    <input type="number"
                           id="screensaver-cycle-seconds"
                           min="2"
                           max="600"
                           step="1"
                           value="${cycleSeconds}"
                           ${screensaverImagesCache.length > 1 ? '' : 'disabled'}
                           class="w-[140px] h-[62px] px-[20px] rounded-[12px] border-2 border-[#385a92] bg-[var(--box-color)] text-[var(--text-primary)] text-[24px] text-center disabled:opacity-40 disabled:cursor-not-allowed"
                           onchange="window.handleScreensaverCycleChange(this.value)">
                </div>
                ${screensaverImagesCache.length > 1 ? '' : `
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                    Add more than one image to enable cycling.
                </p>`}
            </div>

            ${brightnessSupported ? `
            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                        <p class="leading-[1.2]" data-i18n-key="Black screen saver">Black screen saver</p>
                    </div>
                    <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                        <input type="checkbox" class="sr-only peer"
                               id="black-screen-saver"
                               ${blackSaver ? 'checked' : ''}
                               onchange="window.setBlackScreenSaver(this.checked)">
                        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                        <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                    </label>
                </div>
            </div>
            ` : ''}

            <input type="file" id="screensaver-file-input" class="hidden" multiple accept="image/*"
                   onchange="window.addScreensaverFiles(this.files)">
        </div>
    `;
}

// Render Brightness settings
export function renderBrightnessSettings() {
    // The slider reflects reality: `brightness` is the level actually applied,
    // which REA caps at 20 while lowBatteryBrightnessActive. requestedBrightness
    // (what was asked for) is only the fallback. This must match what the
    // ws/v1/display handler writes on later frames, or the controls jump from one
    // to the other the moment a frame lands. Then api.js's cached frame, then 100
    // -- the API's "OS-managed" value -- never an invented 75, which used to show
    // whenever displayStateCache was null and got written back on first touch.
    const ds = displayState();
    const brightnessVal = ds?.brightness ?? ds?.requestedBrightness ?? 100;
    return `
        <div class="content-stretch flex flex-col gap-[80px] items-start relative w-full px-[60px] py-[80px]">
            <div class="content-stretch flex items-center justify-between relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px]">
                    <p class="leading-[1.2]" data-i18n-key="Screen Brightness">Screen Brightness</p>
                </div>
                
            </div>

            <div class="content-stretch flex flex-col gap-[40px] items-start relative w-full">
                <div class="flex items-center gap-[30px] w-full">
                    <input type="range" id="brightness-slider" min="0" max="100" value="${brightnessVal}" class="brightness-slider flex-grow" oninput="handleBrightnessChange(this.value)">
                    <input type="number" id="brightness-number" min="0" max="100" step="1" value="${brightnessVal}"
                           class="w-[140px] h-[62px] px-[20px] rounded-[12px] border-2 border-[#385a92] bg-[var(--box-color)] text-[var(--text-primary)] text-[24px] text-center"
                           onchange="handleBrightnessChange(this.value)">
                </div>
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[32px] w-full" data-i18n-key="Adjust screen brightness level">
                    Adjust screen brightness level
                </p>
            </div>
        </div>
    `;
}

// Render Wake Lock settings
export function renderWakeLockSettings() {
    // Prefer REA's live DisplayState; fall back to last-known localStorage intent
    // only before the first display frame has arrived. wakeLockOverride (not
    // wakeLockEnabled) is whether THIS APP asked for the lock -- see the
    // display-socket listener below for why that distinction matters.
    const wakeLockEnabled = displayStateCache?.wakeLockOverride
        ?? isWakeLockEnabled();

    return `
        <div class="space-y-6 px-[60px] py-[80px]">
            <div>
                <h2 class="text-[28px] font-bold text-[var(--text-primary)] mb-4" data-i18n-key="Wake Lock Settings">Wake Lock Settings</h2>
                <p class="text-[var(--text-primary)] text-[20px] mb-6 opacity-75" data-i18n-key="Control screen wake-lock to prevent the display from sleeping during operation.">
                    Control screen wake-lock to prevent the display from sleeping during operation.
                </p>
            </div>

            <div class="bg-[var(--presence-card-bg)] rounded-lg p-6">
                <div class="flex items-center justify-between">
                    <div>
                        <label class="text-[24px] font-semibold text-[var(--presence-card-text)]" data-i18n-key="Enable Wake Lock">Enable Wake Lock</label>
                        <p class="text-[18px] text-[var(--presence-card-text)] opacity-75 mt-1" data-i18n-key="Keep the screen on while the app is active">
                            Keep the screen on while the app is active
                        </p>
                    </div>
                    <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                        <input type="checkbox" id="wake-lock-toggle" class="sr-only peer"
                               ${wakeLockEnabled ? 'checked' : ''}
                               onchange="handleWakeLockToggle(this.checked)">
                        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                        <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                    </label>
                </div>
            </div>

            <div class="text-[18px] text-[var(--text-primary)] opacity-75 mt-4">
                <p><strong>Note:</strong> Wake-lock automatically releases when the WebSocket disconnects.</p>
            </div>
        </div>
    `;
}

// Render Presence Detection settings (async — populates container after fetch)
export function renderPresenceSettings() {
    // Return a loading placeholder synchronously, then populate async
    loadPresenceSettingsAsync();
    return `
        <div id="presence-settings-container">
            <div class="flex items-center justify-center p-8">
                <span class="loading loading-spinner loading-lg"></span>
                <span class="ml-4 text-[20px] text-[var(--text-secondary)]" data-i18n-key="Loading presence settings...">Loading presence settings...</span>
            </div>
        </div>
    `;
}

// Helper function to format days of week
function formatDaysOfWeek(days) {
    if (!days || days.length === 0) return 'Every day';
    // ISO 8601: 1=Monday, 7=Sunday
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return days.map(d => dayNames[d - 1]).join(', ');
}

function formatKeepAwakeDuration(minutes) {
    if (!minutes || minutes < 1) return '';
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hrs > 0 && mins > 0) return `${hrs} hr ${mins} min`;
    if (hrs > 0) return `${hrs} hr`;
    return `${mins} min`;
}

// Async loader for presence settings content
async function loadPresenceSettingsAsync() {
    // Small delay to ensure the placeholder DOM is rendered first
    await new Promise(resolve => setTimeout(resolve, 50));

    const container = document.getElementById('presence-settings-container');
    if (!container) return;

    try {
        const settings = await getPresenceSettings();
        const schedules = settings.schedules || [];
        const schedulesHtml = schedules.map(schedule => {
            const keepAwakeLabel = schedule.keepAwakeFor ? formatKeepAwakeDuration(schedule.keepAwakeFor) : '';
            return `
            <div class="bg-[var(--presence-card-alt-bg)] rounded-lg p-4 flex items-center justify-between" data-schedule-id="${schedule.id}">
                <div class="flex-grow">
                    <div class="text-[22px] font-semibold text-[var(--presence-card-text)]">
                        ${schedule.time} - ${formatDaysOfWeek(schedule.daysOfWeek)}
                        ${keepAwakeLabel ? `<span class="text-[18px] opacity-75 ml-2">(${keepAwakeLabel})</span>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-4">
                    <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                        <input type="checkbox" class="sr-only peer"
                               ${schedule.enabled ? 'checked' : ''}
                               onchange="handleScheduleToggle('${schedule.id}', this.checked)">
                        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                        <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                    </label>
                    <button class="btn btn-sm btn-error" onclick="handleDeleteSchedule('${schedule.id}')" data-i18n-key="Delete">
                        Delete
                    </button>
                </div>
            </div>
        `}).join('');

        container.innerHTML = `
            <div class="space-y-6 px-[60px] py-[80px]">
                <div>
                    <h2 class="text-[28px] font-bold text-[var(--text-primary)] mb-4" data-i18n-key="Presence Detection">Presence Detection</h2>
                    <p class="text-[var(--text-primary)] text-[20px] mb-6 opacity-75" data-i18n-key="Automatically manage machine sleep/wake based on user presence and schedules.">
                        Automatically manage machine sleep/wake based on user presence and schedules.
                    </p>
                </div>

                <div class="bg-[var(--presence-card-bg)] rounded-lg p-6">
                    <div class="flex items-center justify-between mb-6">
                        <div>
                            <label class="text-[24px] font-semibold text-[var(--presence-card-text)]" data-i18n-key="Enable Presence Detection">Enable Presence Detection</label>
                            <p class="text-[18px] text-[var(--presence-card-text)] opacity-75 mt-1" data-i18n-key="Track user presence to automatically sleep the machine">
                                Track user presence to automatically sleep the machine
                            </p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="presence-enabled-toggle" class="sr-only peer"
                                   ${settings.userPresenceEnabled ? 'checked' : ''}
                                   onchange="handlePresenceToggle(this.checked)">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>

                    <div class="mt-6">
                        <label class="text-[22px] font-semibold text-[var(--presence-card-text)] block mb-3">
                            Sleep Timeout (minutes)
                        </label>
                        <input type="number"
                               id="sleep-timeout-input"
                               class="input input-bordered w-full max-w-xs text-[20px] bg-[var(--presence-input-bg)] text-[var(--presence-input-text)] border-[var(--presence-input-border)]"
                               value="${settings.sleepTimeoutMinutes ?? 30}"
                               min="1"
                               max="120"
                               onchange="this.value = Math.max(1, Math.min(120, this.value)); handleSleepTimeoutChange(this.value)">
                        <p class="text-[18px] text-[var(--presence-card-text)] opacity-75 mt-2" data-i18n-key="Minutes of inactivity before auto-sleep">
                            Minutes of inactivity before auto-sleep
                        </p>
                    </div>
                </div>

                <div class="bg-[var(--presence-card-bg)] rounded-lg p-6">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-[24px] font-semibold text-[var(--presence-card-text)]" data-i18n-key="Wake Schedules">Wake Schedules</h3>
                        <button class="btn btn-primary" onclick="handleAddSchedule()" data-i18n-key="Add Schedule">
                            Add Schedule
                        </button>
                    </div>

                    <div class="space-y-3">
                        ${schedules.length > 0 ? schedulesHtml : '<p class="text-[var(--presence-card-text)] opacity-75 text-[18px]" data-i18n-key="No schedules configured">No schedules configured</p>'}
                    </div>
                </div>

                <dialog id="add-schedule-modal" class="modal">
                    <div class="modal-box bg-[var(--presence-card-bg)] max-w-2xl">
                        <h3 class="font-bold text-[24px] text-[var(--presence-card-text)] mb-4" data-i18n-key="Add Schedule">Add Schedule</h3>

                        <div class="space-y-4">
                            <div>
                                <label class="text-[20px] text-[var(--presence-card-text)] block mb-2" data-i18n-key="Wake Time">Wake Time</label>
                                <input type="time" id="schedule-time-input" class="input input-bordered w-full text-[20px] bg-[var(--presence-input-bg)] text-[var(--presence-input-text)] border-[var(--presence-input-border)]">
                            </div>

                            <div>
                                <label class="text-[20px] text-[var(--presence-card-text)] block mb-2" data-i18n-key="Days of Week">Days of Week</label>
                                <div class="flex gap-2 flex-wrap">
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="1" class="checkbox checkbox-primary mr-1"> Mon</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="2" class="checkbox checkbox-primary mr-1"> Tue</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="3" class="checkbox checkbox-primary mr-1"> Wed</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="4" class="checkbox checkbox-primary mr-1"> Thu</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="5" class="checkbox checkbox-primary mr-1"> Fri</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="6" class="checkbox checkbox-primary mr-1"> Sat</label>
                                    <label class="cursor-pointer text-[var(--presence-card-text)]"><input type="checkbox" value="7" class="checkbox checkbox-primary mr-1"> Sun</label>
                                </div>
                            </div>

                            <div>
                                <label class="text-[20px] text-[var(--presence-card-text)] block mb-2" data-i18n-key="Keep Awake For">Keep Awake For</label>
                                <div class="flex items-center gap-3">
                                    <div class="flex items-center gap-2">
                                        <input type="number" id="keep-awake-hours-input" class="input input-bordered w-20 text-[20px] bg-[var(--presence-input-bg)] text-[var(--presence-input-text)] border-[var(--presence-input-border)]"
                                               min="0" max="12" placeholder="0" value="0"
                                               onchange="this.value = Math.max(0, Math.min(12, this.value)); if (this.value == 12) { document.getElementById('keep-awake-mins-input').value = 0; } if (this.value > 12) { ui.showToast('Maximum 12 hours', 3000, 'error'); }">
                                        <span class="text-[var(--presence-card-text)]">hr</span>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <input type="number" id="keep-awake-mins-input" class="input input-bordered w-20 text-[20px] bg-[var(--presence-input-bg)] text-[var(--presence-input-text)] border-[var(--presence-input-border)]"
                                               min="0" max="59" placeholder="0" value="0"
                                               onchange="this.value = Math.max(0, Math.min(59, this.value))">
                                        <span class="text-[var(--presence-card-text)]">min</span>
                                    </div>
                                </div>
                                <p class="text-[18px] text-[var(--presence-card-text)] opacity-75 mt-1" data-i18n-key="Duration to keep machine awake after schedule fires. Max 12 hours.">
                                    Duration to keep machine awake after schedule fires. Max 12 hours.
                                </p>
                            </div>
                        </div>

                        <div class="modal-action">
                            <button class="btn" onclick="document.getElementById('add-schedule-modal').close()" data-i18n-key="Cancel">Cancel</button>
                            <button class="btn btn-primary" onclick="handleSaveSchedule()" data-i18n-key="Save">Save</button>
                        </div>
                    </div>
                </dialog>
            </div>
        `;

        // These presence fields (sleep timeout, keep-awake) are injected here,
        // asynchronously, AFTER updateSettingsContentArea's one-shot attach has
        // already run -- so re-attach the settings numpad now that they exist,
        // otherwise they fall through to the OS keyboard. Same reason for the
        // translatePage() call: this content lands after the page's one-shot
        // translation pass, so every data-i18n-key here would otherwise sit
        // untranslated regardless of the selected language.
        attachSettingsNumpad();
        translatePage();
    } catch (error) {
        console.error('Error rendering presence settings:', error);
        container.innerHTML = `<div class="text-error text-[20px]" data-i18n-key="Failed to load presence settings">Failed to load presence settings</div>`;
        translatePage();
    }
}

// Render App Version settings
export function renderAppVersionSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="App Version">App Version</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="App Version">App Version</p>
                        </div>
                        <div class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold flex items-center justify-center">
                            1.0.0
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Current application version">
                        Current application version
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Render miscellaneous settings (legacy - for backward compatibility)
export function renderUnitsSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Units Settings">Units Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Measurement Units">Measurement Units</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option data-i18n-key="Metric">Metric</option>
                            <option data-i18n-key="Imperial">Imperial</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Select measurement units used throughout the application">
                        Select measurement units used throughout the application
                    </p>
                </div>
            </div>
        </div>
    `;
}

const UI_ZOOM_MAP = { 'Small': '0.85', 'Medium': '1.0', 'Large': '1.15', 'Extra Large': '1.3' };

function getUiZoomLabel() {
    const stored = localStorage.getItem('uiZoom') || '1.0';
    return Object.entries(UI_ZOOM_MAP).find(([, v]) => v === stored)?.[0] ?? 'Medium';
}

export function renderFontSizeSettings() {
    const current = getUiZoomLabel();
    const options = Object.keys(UI_ZOOM_MAP).map(label =>
        `<option${label === current ? ' selected' : ''}>${label}</option>`
    ).join('');
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Display Size">Display Size</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Display Size">Display Size</p>
                        </div>
                        <select id="text-size-select" class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[220px] text-white text-[24px] p-2">
                            ${options}
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Adjust the display size for better readability. Changes apply after saving.">
                        Adjust the display size for better readability. Changes apply after saving.
                    </p>
                </div>
            </div>
        </div>
    `;
}

function initFontSizeSettings() {
    const select = document.getElementById('text-size-select');
    if (!select) return;
    select.addEventListener('change', (e) => {
        const multiplier = UI_ZOOM_MAP[e.target.value] ?? '1.0';
        localStorage.setItem('uiZoom', multiplier);
        // scaling.js only re-reads uiZoom inside its resize handler — kick it
        // so the new size applies immediately instead of after the next reload.
        window.dispatchEvent(new Event('resize'));
    });
}

export function renderTempUnitSettings() {
    const current = getTempUnit();
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Temperature">Temperature</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Temperature">Temperature</p>
                        </div>
                        <select id="temp-unit-select" class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option value="C"${current === 'C' ? ' selected' : ''}>Celsius (°C)</option>
                            <option value="F"${current === 'F' ? ' selected' : ''}>Fahrenheit (°F)</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function initTempUnitSettings() {
    const select = document.getElementById('temp-unit-select');
    if (!select) return;
    select.addEventListener('change', (e) => {
        setTempUnit(e.target.value);
    });
}

export function renderResolutionSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Resolution">Resolution</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Display Resolution">Display Resolution</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option>1920x1200</option>
                            <option>1280x800</option>
                            <option>1024x768</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Set the display resolution">
                        Set the display resolution
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderMiscellaneousSettings() {
    // The slider reflects reality: `brightness` is the level actually applied,
    // which REA caps at 20 while lowBatteryBrightnessActive. requestedBrightness
    // (what was asked for) is only the fallback. This must match what the
    // ws/v1/display handler writes on later frames, or the controls jump from one
    // to the other the moment a frame lands. Then api.js's cached frame, then 100
    // -- the API's "OS-managed" value -- never an invented 75, which used to show
    // whenever displayStateCache was null and got written back on first touch.
    const ds = displayState();
    const brightnessVal = ds?.brightness ?? ds?.requestedBrightness ?? 100;
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Miscellaneous Settings">Miscellaneous Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Screen Saver">Screen Saver</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option data-i18n-key="Enabled">Enabled</option>
                            <option data-i18n-key="Disabled">Disabled</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Enable or disable screen saver functionality
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Brightness">Brightness</p>
                        </div>
                        <input type="range" id="brightness-slider" min="0" max="100" value="${brightnessVal}" class="brightness-slider w-[200px]" onchange="handleBrightnessChange(this.value)">
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Adjust screen brightness level">
                        Adjust screen brightness level
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="App Version">App Version</p>
                        </div>
                        <div class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold flex items-center justify-center">
                            1.0.0
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Current application version">
                        Current application version
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Units Settings">Units Settings</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option data-i18n-key="Metric">Metric</option>
                            <option data-i18n-key="Imperial">Imperial</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Select measurement units for the application">
                        Select measurement units for the application
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Display Size">Display Size</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option data-i18n-key="Small">Small</option>
                            <option data-i18n-key="Medium">Medium</option>
                            <option data-i18n-key="Large">Large</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Adjust the display size for better readability">
                        Adjust the display size for better readability
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Resolution">Resolution</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option>1920x1200</option>
                            <option>1280x800</option>
                            <option>1024x768</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Set the display resolution">
                        Set the display resolution
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Smart Charging">Smart Charging</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2">
                            <option data-i18n-key="Enabled">Enabled</option>
                            <option data-i18n-key="Disabled">Disabled</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Enable smart charging for connected devices">
                        Enable smart charging for connected devices
                    </p>
                </div>
            </div>
        </div>
    `;
}


// Helper: convert minutes-since-midnight to HH:MM string
function minutesToTimeString(minutes) {
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
}

// Helper: convert HH:MM string to minutes-since-midnight
function timeStringToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

// Render Steam settings
// Steam-stop mode is a skin-side concept: reaprime stores only the independent
// `stopAtTemperature` field (0 = off), not a mode enum. The pure derivation
// lives in ../modules/steam-mode.js (node-tested); this wraps it with the
// settings cache and the skin-local preference.
function getSteamStopMode() {
    const stopTemp = settingsCache.workflow?.steamSettings?.stopAtTemperature ?? 0;
    let stored = null;
    try {
        stored = localStorage.getItem('streamline.steamStopMode');
    } catch (e) { /* localStorage unavailable */ }
    return resolveSteamStopMode(stopTemp, stored, isBengleMachine());
}

// Milk-probe state tracked in app.js from the live machine snapshot
// (milkTemperature; 0/absent = no probe, sustained-absence debounced).
// Absent tracker (page loaded standalone / before the main page) = no probe —
// never fake a reading.
function getMilkProbe() {
    return window.app?.getMilkProbe?.() ?? { present: false, temperature: 0 };
}

// Last non-temperature stop mode the user chose ('time'|'off') — what the page
// falls back to while the probe is absent. Probe loss is NOT display-only:
// ui.js un-arms an active stop on the machine (stopAtTemperature = 0) and
// lands the stop-mode record on this fallback (onMilkProbeUpdate below mirrors
// the un-arm into this page's cached/staged workflow), so re-attaching the
// probe restores the Milk Temp OPTION but not the mode — Milk Temp comes back
// only when the user re-selects it (or an armed stop survived, e.g. a boot
// with the probe attached).
function getSteamStopFallbackMode() {
    try {
        return localStorage.getItem('streamline.steamStopModeFallback');
    } catch (e) { return null; }
}

// The steam page's effective stop mode: the resolved mode gated on probe
// presence ('temperature' is not offerable without a probe).
function getEffectiveSteamStopMode(probePresent) {
    return applyMilkProbeGate(getSteamStopMode(), probePresent, getSteamStopFallbackMode());
}

// Live milk-probe feed from app.js (one call per machine snapshot, ~10 Hz).
// A presence FLIP while the steam page is open re-renders the section (gates
// the Milk Temp option and applies/undoes the Time/Off fallback); a plain
// temperature tick patches only the live text node so input focus isn't
// clobbered mid-edit. renderSteamSettings re-baselines the flip detector.
let steamMilkProbeWasPresent = null;
let milkProbeLastPresent = null; // page-independent flip tracker (cache mirror below)
window.onMilkProbeUpdate = function(present, temperatureC) {
    // On a probe LOSS the main screen un-arms the milk stop on the machine
    // (ui.setMilkProbePresent writes stopAtTemperature = 0 and records the
    // Time/Off fallback as the stop mode). Mirror that into this page's cached
    // and STAGED workflow state whatever category is open, so a later steam
    // render can't resurrect Milk Temp from a stale armed value and a pending
    // Save can't silently re-arm it.
    const flippedAbsent = milkProbeLastPresent === true && !present;
    milkProbeLastPresent = present;
    if (flippedAbsent) {
        if (settingsCache.workflow?.steamSettings?.stopAtTemperature > 0) {
            settingsCache.workflow.steamSettings.stopAtTemperature = 0;
        }
        if (pendingChanges.workflow?.steamSettings?.stopAtTemperature > 0) {
            delete pendingChanges.workflow.steamSettings.stopAtTemperature;
        }
    }
    if (activeSettingsCategory !== 'steam') { steamMilkProbeWasPresent = null; return; }
    if (steamMilkProbeWasPresent !== null && present !== steamMilkProbeWasPresent) {
        steamMilkProbeWasPresent = present;
        updateSettingsContentArea('steam');
        return;
    }
    steamMilkProbeWasPresent = present;
    if (!present) return;
    const el = document.getElementById('steam-milk-live-temp');
    if (el) el.textContent = `${temperatureC.toFixed(1)} °C`;
};

export function renderSteamSettings() {
    if (!settingsCache.de1 && !settingsCache.workflow) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]">${getTranslation('Steam')} ${getTranslation('Settings')}</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]" data-i18n-key="Failed to load settings">Failed to load settings</div>
            </div>
        `;
    }

    const steamSettings = settingsCache.workflow?.steamSettings || {};
    const targetTemp = steamSettings.targetTemperature ?? 150;
    const duration = steamSettings.duration ?? 60;
    const flow = steamSettings.flow ?? 0.9;
    const stopTemp = steamSettings.stopAtTemperature ?? 0;
    const bengle = isBengleMachine();
    const probe = getMilkProbe(); // { present, temperature } — live snapshot state
    steamMilkProbeWasPresent = probe.present; // baseline for the live flip detector
    // Effective mode: 'temperature' only offerable with the probe attached;
    // absent probe falls back to the previously-set Time/Off (display-level).
    const stopMode = getEffectiveSteamStopMode(probe.present); // 'off' | 'time' | 'temperature'
    const milkTarget = stopTemp > 0 ? Math.round(stopTemp) : 60;

    // Steam-stop segmented button (mimics the gatewayMode segmented control).
    // A disabled button (Milk Temp with no probe) renders grayed and inert.
    const stopSegBtn = (value, label, disabled = false) => {
        if (disabled) {
            return `<button class="flex-1 h-[96px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[28px] flex items-center justify-center cursor-not-allowed transition-colors duration-200 bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7] opacity-40"
                    aria-pressed="false" aria-disabled="true" disabled data-i18n-key="${label}">${getTranslation(label)}</button>`;
        }
        const active = stopMode === value;
        return `<button class="flex-1 h-[96px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[28px] flex items-center justify-center cursor-pointer transition-colors duration-200 ${active ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                    aria-pressed="${active}"
                    onclick="window.setSteamStopMode('${value}')" data-i18n-key="${label}">${getTranslation(label)}</button>`;
    };
    const stopDescriptions = {
        off: 'Steam runs until you stop it (subject to the machine safety timeout).',
        time: 'Steam stops automatically after the set duration.',
        temperature: 'Steam stops automatically when the milk reaches the target temperature.'
    };

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">${getTranslation('Steam')} ${getTranslation('Settings')}</p>
            </div>

            <!-- Steam Temperature -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Steam temperature">Steam temperature</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">${tempInputValue(0)}, ${tempInputValue(135)} – ${tempInputValue(165)} ${tempUnitLabel()}</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease steam temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamTemp(-1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="steamTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${tempInputValue(targetTemp)}" step="1" min="${tempInputValue(0)}" max="${tempInputValue(165)}"
                                       onchange="window.updateSteamSetting('targetTemperature', Math.round(window.tempInputToCelsius(this.value)))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">${tempUnitLabel()}</span>
                            </div>
                            <button aria-label="Increase steam temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamTemp(1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <p class="text-[20px] font-normal opacity-60 text-[var(--text-primary)] leading-[1.2]" data-i18n-key="The lowest setting turns the steam heater off">The lowest setting turns the steam heater off</p>
                </div>
            </div>

            <!-- Eco steam -->
            <div class="content-stretch flex items-center justify-between gap-[24px] relative w-full">
                <div class="flex flex-col gap-[10px] font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                    <p class="leading-[1.2]" data-i18n-key="Eco steam">Eco steam</p>
                    <p class="text-[20px] font-normal opacity-60 leading-[1.2]" data-i18n-key="After ten idle minutes the steam boiler drops to just above its cutoff. Any touch brings it straight back.">After ten idle minutes the steam boiler drops to just above its cutoff. Any touch brings it straight back.</p>
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <input type="checkbox" id="eco-steam-toggle"
                           class="sr-only peer"
                           ${isEcoSteamEnabled() ? 'checked' : ''}
                           onchange="window.setEcoSteam(this.checked)">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>

            <!-- Steam Flow -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Flow">Flow</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">0.4 – 2.5 ml/s</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease steam flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamFlow(-0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="decimal" id="steamFlowInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${flow.toFixed(1)}" step="0.1" min="0.4" max="2.5"
                                       onchange="window.updateSteamSetting('flow', parseFloat(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml/s</span>
                            </div>
                            <button aria-label="Increase steam flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamFlow(0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Steam Stop mode -->
            <div class="content-stretch flex flex-col gap-[24px] items-start relative w-full">
                <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                    <p class="leading-[1.2]" data-i18n-key="Steam Stop">Steam Stop</p>
                </div>
                <div class="flex gap-[16px] w-full">
                    ${stopSegBtn('off', 'Off')}
                    ${stopSegBtn('time', 'Time')}
                    ${bengle ? stopSegBtn('temperature', 'Milk Temp', !probe.present) : ''}
                </div>
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="${stopDescriptions[stopMode]}">${getTranslation(stopDescriptions[stopMode])}</p>
                ${bengle && !probe.present ? `
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] opacity-60 text-[24px] w-full" data-i18n-key="Requires the Bengle milk temperature probe.">${getTranslation('Requires the Bengle milk temperature probe.')}</p>
                ` : ''}
            </div>

            <!-- Steam Duration (Time mode) -->
            ${stopMode === 'time' ? `
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Duration (seconds)">Duration (seconds)</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">10 – 120 s</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease steam duration" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamDuration(-5);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="steamDurationInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${duration}" step="5" min="10" max="120"
                                       onchange="window.updateSteamSetting('duration', parseInt(this.value))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">s</span>
                            </div>
                            <button aria-label="Increase steam duration" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustSteamDuration(5);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            ` : ''}

            <!-- Stop at Milk Temperature (Milk Temp mode — Bengle) -->
            ${stopMode === 'temperature' && bengle ? `
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Stop at Milk Temperature (°C)">Stop at Milk Temperature (°C)</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">${tempInputValue(30)} – ${tempInputValue(80)} ${tempUnitLabel()}</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease milk target temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustMilkStopTemp(-1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="steamMilkStopInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${tempInputValue(milkTarget)}" step="1" min="${tempInputValue(30)}" max="${tempInputValue(80)}"
                                       onchange="window.updateSteamSetting('stopAtTemperature', Math.max(30, Math.min(80, Math.round(window.tempInputToCelsius(this.value)) || 30)))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">${tempUnitLabel()}</span>
                            </div>
                            <button aria-label="Increase milk target temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustMilkStopTemp(1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <!-- Probe present (this section is unreachable without it) → show the
                         LIVE reading instead of the old "requires the probe" note; the text
                         node is patched per snapshot by window.onMilkProbeUpdate. -->
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">${getTranslation('Live milk temperature:')} <span id="steam-milk-live-temp" class="font-bold">${probe.temperature.toFixed(1)} °C</span></p>
                </div>
            </div>
            ` : ''}

            <!-- Steam Purge Mode -->
            ${settingsCache.de1 ? `
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Steam Purge Mode">Steam Purge Mode</p>
                        </div>
                        <select class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[200px] text-white text-[24px] p-2"
                                onchange="window.updateDe1Setting('steamPurgeMode', this.value)">
                            <option value="0" ${settingsCache.de1.steamPurgeMode === 0 ? 'selected' : ''} data-i18n-key="Normal">Normal</option>
                            <option value="1" ${settingsCache.de1.steamPurgeMode === 1 ? 'selected' : ''} data-i18n-key="Two Tap Stop">Two Tap Stop</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Set the steam purge mode for the machine">
                        Set the steam purge mode for the machine
                    </p>
                </div>
            </div>
            ` : ''}
        </div>
    `;
}

// ── Cup Warmer (Bengle) ─────────────────────────────────────────────────────
// Machine truth is a single `temperature` setpoint (0 = off). We keep the
// user's desired target in localStorage so toggling off (PUT 0) doesn't lose
// it. Pure clamp/format helpers live in ../modules/cup-warmer.js so node:test
// covers them.
//
// State lives in the SHARED store in ../modules/cup-warmer.js — one copy for
// this page AND app.js's header quick-toggle (see the note there; the old
// fetch-once cupWarmerCache here froze the bench display at a 20-minute-old
// reading, audit I1 / checklist 2b). Freshness while the page is open comes
// from startCupWarmerPoll(): an immediate revalidate on entry (stale-while-
// revalidate — cached values paint instantly, fresh data patches in) plus a
// ~5 s repeat whose ticks touch ONLY the #cupWarmerCurrentTemp text node so
// input focus survives. The poll stops on category change (top of
// updateSettingsContentArea — the same exit seam the Lighting preview and the
// Load-Cell scale WS use), on Save/Cancel page exit, and self-guards against
// any other page swap.
let cupWarmerPollTimer = null;      // interval handle; non-null only while this page owns the poll
const CUP_WARMER_POLL_MS = 5000;    // revalidate cadence while the page is open

// Wake-schedule list, for the "pre-warm will do nothing" warning. The cup-warmer
// page has no other reason to know about schedules, so it fetches the list on
// entry and caches it here.
//   null = UNKNOWN (not fetched yet, or the fetch failed) — we do NOT warn
//   []   = genuinely no wake windows — we DO warn
// Conflating those two is how a UI ends up crying wolf at a user whose schedule
// simply hasn't loaded.
let cupWarmerSchedules = null;
// Pre-warm shape + warnings as last RENDERED, so a poll tick can tell a repaint
// that is needed (a block appeared/disappeared) from one that would merely
// clobber a stepper the user is mid-edit in.
let cupWarmerRenderedSig = null;
let cupWarmerRenderedWarnings = null;
// A revalidate failed with NOTHING in the store: we hold no machine state at
// all. Distinct from "not fetched yet" (also a null store) — the page renders
// the error state rather than a made-up machine (see cupWarmerViewMode). Reset
// on page entry and by the next successful fetch.
let cupWarmerLoadFailed = false;

// One store subscription paints the open page: a missing enable-toggle
// (loading/error placeholder on screen) or an on/off flip (header toggle,
// reconnect invalidation, machine-side change) re-renders the section; a
// plain temperature tick patches only the text node so it can never clobber
// input focus mid-edit (same flip-vs-tick split as onMilkProbeUpdate above).
onCupWarmerStateChange((state) => {
    if (activeSettingsCategory !== 'cupwarmer') return;
    const toggleEl = document.getElementById('cupWarmerEnableToggle');
    if (!toggleEl || toggleEl.checked !== isCupWarmerOn(state?.temperature)) {
        updateSettingsContentArea('cupwarmer');
        return;
    }
    // Same flip-vs-tick split for the pre-warm: a change of SHAPE (support
    // appearing, the toggle flipping, the firmware starting or stopping a
    // scheduled pre-warm) adds or removes whole blocks and must repaint. The
    // lead value is deliberately not in the signature — a tick must never
    // rewrite an input under the user's fingers.
    if (prewarmShapeSignature(resolvePrewarm(state)) !== cupWarmerRenderedSig) {
        updateSettingsContentArea('cupwarmer');
        return;
    }
    patchCupWarmerCurrentTemp(state?.currentTemperature);
});

// Refresh the wake-schedule list for the empty-schedule warning. Repaints only
// when the warning set actually changed, so the fetch landing cannot clobber a
// stepper the user is already editing.
async function refreshCupWarmerSchedules() {
    let schedules = null;
    try {
        const list = await getPresenceSchedules();
        schedules = Array.isArray(list) ? list : null;
    } catch (e) {
        schedules = null; // unknown, not empty — stay quiet rather than warn wrongly
    }
    cupWarmerSchedules = schedules;
    if (activeSettingsCategory !== 'cupwarmer') return;
    const state = getCupWarmerState();
    const warnings = prewarmWarnings({
        prewarm: resolvePrewarm(state),
        temperature: state?.temperature,
        schedules: cupWarmerSchedules,
    }).join(',');
    if (warnings !== cupWarmerRenderedWarnings) updateSettingsContentArea('cupwarmer');
}

// Patch just the current-temperature line (bold reading vs dimmed "No
// reading"), leaving the rest of the rendered page — and any focused input —
// untouched. Mirrors the two render variants in renderCupWarmerSettings.
function patchCupWarmerCurrentTemp(currentTemperature) {
    const el = document.getElementById('cupWarmerCurrentTemp');
    if (!el) return;
    const text = formatCurrentMatTemp(currentTemperature);
    if (text !== null) {
        el.textContent = `${text} °C`;
        el.classList.add('font-bold');
        el.classList.remove('font-normal', 'opacity-60');
        el.removeAttribute('data-i18n-key');
    } else {
        el.textContent = getTranslation('No reading');
        el.classList.add('font-normal', 'opacity-60');
        el.classList.remove('font-bold');
        el.setAttribute('data-i18n-key', 'No reading');
    }
}

// Fetch fresh machine state and fold it into the shared store; the store
// subscription above paints the page (and app.js's header button). A failed
// fetch keeps the last snapshot on screen — the next tick retries — and with
// nothing loaded at all it paints the error state.
//
// What it must NOT do is invent a snapshot. It used to fall back to a synthetic
// `{ temperature: 0 }`, which reads as a fully-loaded machine with the warmer
// off — so the render skipped its loading guard and resolvePrewarm(), unable to
// tell a field absent because the FETCH failed from one absent because the
// FIRMWARE lacks the register, reported the pre-warm unsupported: a network blip
// told the user to go update their firmware. See cupWarmerViewMode().
async function revalidateCupWarmer() {
    try {
        const data = await getCupWarmer();
        cupWarmerLoadFailed = false;
        setCupWarmerState(data || { temperature: 0 });
    } catch (e) {
        if (getCupWarmerState() !== null) return;   // last good snapshot stands; next tick retries
        if (cupWarmerLoadFailed) return;            // already saying so — don't repaint over it
        cupWarmerLoadFailed = true;
        // Nothing in the store changed, so the store subscription cannot repaint
        // for us: swap the loading placeholder for the error state ourselves. A
        // later tick that succeeds clears the flag and the subscription repaints.
        if (activeSettingsCategory === 'cupwarmer') updateSettingsContentArea('cupwarmer');
    }
}

function startCupWarmerPoll() {
    if (cupWarmerPollTimer !== null) return; // already armed — a re-render, not a page entry
    cupWarmerLoadFailed = false; // fresh page entry: a stale error must not pre-empt the retry
    cupWarmerPollTimer = setInterval(() => {
        // Self-guard: an exit path that misses stopCupWarmerPoll() (e.g. a
        // history/back page swap) lands here at most one tick later.
        if (activeSettingsCategory !== 'cupwarmer' || !document.getElementById('settings-content-area')) {
            stopCupWarmerPoll();
            return;
        }
        revalidateCupWarmer();
    }, CUP_WARMER_POLL_MS);
    revalidateCupWarmer(); // stale-while-revalidate: refresh immediately on entry
    // Schedules can be edited on the Presence page between visits, so re-fetch
    // on entry rather than caching for the session. Once per entry, not per tick.
    refreshCupWarmerSchedules();
}

function stopCupWarmerPoll() {
    if (cupWarmerPollTimer === null) return;
    clearInterval(cupWarmerPollTimer);
    cupWarmerPollTimer = null;
}

export function renderCupWarmerSettings() {
    startCupWarmerPoll(); // idempotent: page entry kicks a revalidate + arms the ~5 s poll
    const cupWarmer = getCupWarmerState();
    // A fetch that never landed is an error, not a machine with everything
    // switched off: with no snapshot we know NOTHING about this machine — least
    // of all whether its firmware has the pre-warm registers. Say so, and let
    // the ~5 s poll heal it. (Same loading → error split as the Lighting page.)
    const mode = cupWarmerViewMode(cupWarmer, cupWarmerLoadFailed);
    if (mode === 'loading') return renderLoadingState(getTranslation('Cup Warmer'));
    if (mode === 'error') {
        return renderErrorState(
            getTranslation('Cup Warmer'),
            getTranslation('Failed to load cup warmer settings'),
        );
    }

    const machineTemp = Math.round(cupWarmer.temperature ?? 0);
    const enabled = machineTemp > 0;
    // When enabled the machine's setpoint is truth; when off, show the stored
    // desired target. Either way the display stays within the 30–80 UI range.
    let target = enabled ? machineTemp : readCupWarmerTarget(localStorage.getItem(CUP_WARMER_TARGET_KEY));
    if (!(target >= 30 && target <= 80)) target = 70;
    // Pre-warm is seeded from the MACHINE, never from localStorage: the firmware
    // owns the schedule-driven pre-warm and persists these two settings in flash,
    // so a local mirror could only ever disagree with it. `supported === false`
    // means the firmware has no such registers (the bench build 95) — the
    // controls render disabled and say so rather than faking a state.
    const prewarm = resolvePrewarm(cupWarmer);
    const prewarmWarns = prewarmWarnings({
        prewarm,
        temperature: cupWarmer.temperature,
        schedules: cupWarmerSchedules,
    });
    // Remember what this paint is showing, so a 5 s poll tick can tell a needed
    // repaint from one that would clobber a focused input.
    cupWarmerRenderedSig = prewarmShapeSignature(prewarm);
    cupWarmerRenderedWarnings = prewarmWarns.join(',');
    // Live mat temperature: shown when
    // the app reports a non-null `currentTemperature`; "No reading" when it is
    // null OR when the field is absent (older reaprime). Never fake data.
    const currentTempText = formatCurrentMatTemp(cupWarmer.currentTemperature);

    const minusSvg = `<svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const plusSvg = `<svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    // `disabled` renders the toggle inert AND visibly so — used when the firmware
    // does not support pre-warm, where a live-looking switch would be a lie.
    const toggle = (id, checked, onchange, disabled = false) => `
        <label class="relative flex items-center flex-shrink-0 w-[100px] h-[50px] ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}">
            <input type="checkbox" id="${id}" class="sr-only peer" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="${onchange}">
            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
        </label>`;

    return `
        <div class="content-stretch flex flex-col gap-[48px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Cup Warmer">Cup Warmer</p>
            </div>

            <!-- Enable -->
            <div class="flex items-center justify-between gap-[24px] w-full">
                <div class="flex flex-col gap-[4px]">
                    <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px] leading-[1.2]" data-i18n-key="Cup Warmer">Cup Warmer</p>
                    <p class="font-['Inter:Regular',sans-serif] font-normal text-[var(--text-primary)] text-[22px] leading-[1.3]" data-i18n-key="Warm your cups on the top plate">Warm your cups on the top plate</p>
                </div>
                ${toggle('cupWarmerEnableToggle', enabled, "window.toggleCupWarmer(this.checked)")}
            </div>

            <!-- Target Temperature -->
            <div class="content-stretch flex items-center justify-between relative w-full">
                <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                    <p class="leading-[1.2]" data-i18n-key="Target Temperature (°C)">Target Temperature (°C)</p>
                    <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">${tempInputValue(30)} – ${tempInputValue(80)} ${tempUnitLabel()}</span>
                </div>
                <div class="flex gap-[20px] h-[72px] items-center">
                    <button aria-label="Decrease cup warmer temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center" onclick="window.flashPlusMinusButton(this); window.adjustCupWarmerTemp(-1);">${minusSvg}</button>
                    <div class="flex items-center justify-center" style="width: 130px;">
                        <input type="text" inputmode="numeric" pattern="[0-9]*" id="cupWarmerTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full" value="${tempInputValue(target)}" step="1" min="${tempInputValue(30)}" max="${tempInputValue(80)}" onchange="window.setCupWarmerTarget(window.tempInputToCelsius(this.value))">
                        <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">${tempUnitLabel()}</span>
                    </div>
                    <button aria-label="Increase cup warmer temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center" onclick="window.flashPlusMinusButton(this); window.adjustCupWarmerTemp(1);">${plusSvg}</button>
                </div>
            </div>

            <!-- Current temperature (read-only; placeholder when no reading) -->
            <div class="content-stretch flex items-center justify-between gap-[24px] relative w-full">
                <div class="flex flex-col gap-[4px]">
                    <p class="font-['Inter:Bold',sans-serif] font-bold text-[var(--text-primary)] text-[30px] leading-[1.2]" data-i18n-key="Current Temperature (°C)">Current Temperature (°C)</p>
                    <p class="font-['Inter:Regular',sans-serif] font-normal text-[var(--text-primary)] text-[22px] leading-[1.3]" data-i18n-key="Live temperature of the cup-warming plate">Live temperature of the cup-warming plate</p>
                </div>
                ${currentTempText !== null
                    ? `<p id="cupWarmerCurrentTemp" class="text-[var(--text-primary)] text-[24px] font-bold leading-[1.2] whitespace-nowrap">${formatTemp(cupWarmer.currentTemperature, 1)}</p>`
                    : `<p id="cupWarmerCurrentTemp" class="text-[var(--text-primary)] text-[24px] font-normal opacity-60 leading-[1.2] whitespace-nowrap" data-i18n-key="No reading">No reading</p>`}
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <!-- Pre-warm — the FIRMWARE owns the timing; we write two settings
                 and read one status flag. Disabled + explained on firmware that
                 does not have the registers: never a switch that pretends. -->
            <div class="flex flex-col gap-[24px] w-full">
                <div class="flex items-center justify-between gap-[24px] w-full">
                    <div class="flex flex-col gap-[4px]">
                        <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px] leading-[1.2]" data-i18n-key="Pre-warm before wake-up">Pre-warm before wake-up</p>
                        <p class="font-['Inter:Regular',sans-serif] font-normal text-[var(--text-primary)] text-[22px] leading-[1.3]" data-i18n-key="Warm the cups automatically ahead of a scheduled wake time">Warm the cups automatically ahead of a scheduled wake time</p>
                    </div>
                    ${toggle('cupWarmerPrewarmToggle', prewarm.enabled, "window.toggleCupWarmerPrewarm(this.checked)", !prewarm.supported)}
                </div>
                ${!prewarm.supported ? `
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic text-amber-600 text-[22px] w-full" data-i18n-key="This machine's firmware doesn't support pre-warm — update the firmware to use it.">This machine's firmware doesn't support pre-warm — update the firmware to use it.</p>
                ` : ''}
                ${prewarm.supported && prewarm.active ? `
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic text-[#385a92] text-[22px] w-full" data-i18n-key="Pre-warming now for a scheduled wake.">Pre-warming now for a scheduled wake.</p>
                ` : ''}
                ${prewarm.supported && prewarm.enabled ? `
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                        <p class="leading-[1.2]" data-i18n-key="Minutes before wake">Minutes before wake</p>
                        <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">${PREWARM_MIN_MINUTES} – ${PREWARM_MAX_MINUTES} min</span>
                    </div>
                    <div class="flex gap-[20px] h-[72px] items-center">
                        <button aria-label="Decrease pre-warm minutes" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center" onclick="window.flashPlusMinusButton(this); window.adjustCupWarmerPrewarmMinutes(-5);">${minusSvg}</button>
                        <div class="flex items-center justify-center" style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="cupWarmerPrewarmInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full" value="${prewarm.leadMinutes}" step="5" min="${PREWARM_MIN_MINUTES}" max="${PREWARM_MAX_MINUTES}" onchange="window.setCupWarmerPrewarmMinutes(parseFloat(this.value))">
                            <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">min</span>
                        </div>
                        <button aria-label="Increase pre-warm minutes" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center" onclick="window.flashPlusMinusButton(this); window.adjustCupWarmerPrewarmMinutes(5);">${plusSvg}</button>
                    </div>
                </div>
                ` : ''}
                ${prewarmWarns.includes('noSchedule') ? `
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic text-amber-600 text-[22px] w-full" data-i18n-key="No wake schedule set — add one in Presence Detection.">No wake schedule set — add one in Presence Detection.</p>
                ` : ''}
                ${prewarmWarns.includes('noSetpoint') ? `
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic text-amber-600 text-[22px] w-full" data-i18n-key="Cup warmer is off — pre-warm needs it on to heat the plate.">Cup warmer is off — pre-warm needs it on to heat the plate.</p>
                ` : ''}
            </div>
        </div>
    `;
}

// Cup-warmer window handlers — the settings UI is innerHTML-injected template
// strings, so interactivity must go through window-scoped inline handlers.
// Toggling / editing applies live via PUT /machine/cupWarmer.
window.toggleCupWarmer = async function(on) {
    const target = readCupWarmerTarget(localStorage.getItem(CUP_WARMER_TARGET_KEY));
    const temp = on ? target : 0;
    try {
        await setCupWarmer(temp);
        // Merge keeps currentTemperature visible across toggles;
        // the store notify also repaints app.js's header quick-toggle.
        patchCupWarmerState({ temperature: temp });
        ui.showToast(on ? getTranslation('Cup warmer on') : getTranslation('Cup warmer off'), 2000, 'success');
    } catch (e) {
        ui.showToast(getTranslation('Failed to set cup warmer'), 3000, 'error');
    }
    if (activeSettingsCategory === 'cupwarmer') updateSettingsContentArea('cupwarmer');
};

window.adjustCupWarmerTemp = function(change) {
    const input = document.getElementById('cupWarmerTempInput');
    if (input) {
        let v = parseInt(input.value, 10) + change;
        v = Math.max(tempInputValue(30), Math.min(tempInputValue(80), v));
        input.value = v;
        input.dispatchEvent(new Event('change'));
    }
};

window.setCupWarmerTarget = async function(value) {
    const v = clampCupWarmerTarget(value);
    try { localStorage.setItem(CUP_WARMER_TARGET_KEY, String(v)); } catch (e) { /* non-fatal */ }
    // Apply live only if the warmer is currently on — editing the target while
    // off must not power the mat.
    if (isCupWarmerOn(getCupWarmerState()?.temperature)) {
        try { await setCupWarmer(v); patchCupWarmerState({ temperature: v }); }
        catch (e) { ui.showToast(getTranslation('Failed to set cup warmer'), 3000, 'error'); }
    }
};

// Pre-warm writes go to the MACHINE (the firmware owns the timing and persists
// the settings in flash) — there is no localStorage mirror to keep.
//
// `MatPreheatEnable` and `MatPreheatLeadMin` are one register PAIR written
// together, so each write sends both; the untouched half is re-sent as the
// machine currently holds it. The PUT echoes the pair back READ FROM THE
// MACHINE, and on firmware without the registers the write landed in unmapped
// space and did nothing — so the echo comes back null. Folding that echo into
// the store is what turns the block into an honest "unavailable" instead of a
// toggle that silently springs back.
async function applyCupWarmerPrewarm(enabled, leadMinutes, okToast) {
    try {
        const applied = await setCupWarmerPrewarm(enabled, leadMinutes);
        patchCupWarmerState({
            prewarmEnabled: applied?.prewarmEnabled ?? null,
            prewarmLeadMinutes: applied?.prewarmLeadMinutes ?? null,
        });
        if (applied?.prewarmEnabled == null) {
            // A 200 is not proof the setting took: this firmware has no pre-warm.
            ui.showToast(getTranslation("This machine's firmware doesn't support pre-warm"), 3000, 'error');
            return false;
        }
        ui.showToast(okToast, 2000, 'success');
        return true;
    } catch (e) {
        ui.showToast(getTranslation('Failed to set pre-warm'), 3000, 'error');
        return false;
    }
}

window.toggleCupWarmerPrewarm = async function(on) {
    const prewarm = resolvePrewarm(getCupWarmerState());
    await applyCupWarmerPrewarm(
        on,
        prewarm.leadMinutes,
        getTranslation(on ? 'Pre-warm on' : 'Pre-warm off'),
    );
    // Re-check the schedule: switching pre-warm ON with no wake window silently
    // does nothing, and that warning is the only thing that would tell the user.
    if (on) refreshCupWarmerSchedules();
    if (activeSettingsCategory === 'cupwarmer') updateSettingsContentArea('cupwarmer');
};

window.adjustCupWarmerPrewarmMinutes = function(change) {
    const input = document.getElementById('cupWarmerPrewarmInput');
    if (input) {
        let v = parseInt(input.value, 10) + change;
        v = Math.max(PREWARM_MIN_MINUTES, Math.min(PREWARM_MAX_MINUTES, v));
        input.value = v;
        input.dispatchEvent(new Event('change'));
    }
};

window.setCupWarmerPrewarmMinutes = async function(value) {
    const v = clampPrewarmMinutes(value);
    const prewarm = resolvePrewarm(getCupWarmerState());
    // No re-render on success: the store patch notifies, and the lead is not in
    // the shape signature, so a focused stepper survives its own edit.
    await applyCupWarmerPrewarm(prewarm.enabled, v, getTranslation('Pre-warm lead updated'));
};

// ── Lighting / LED strip (Bengle) ────────────────────────────────────────────
// State = { frontStrip, backStrip, frontSwitch } × { awake, sleeping }, each a
// 12-char 'RRRRGGGGBBBB' hex (16-bit/channel). PUT previews live on the machine;
// commit persists to NVM; reset reloads NVM. Uses the vendored iro.js colour wheel.
// Colour maps (8-bit↔16-bit) live in ../modules/led-color.js so node:test covers them.
let ledState = null;           // working LedStripState, or null until loaded
let ledCommitted = null;       // JSON snapshot at last load/commit
let ledSelectedZone = 'front'; // 'front' | 'rear' | 'both' | 'switch'
let ledSelectedState = 'awake';// 'awake' | 'sleeping'
let ledPicker = null;          // iro.ColorPicker instance
let ledPutTimer = null;        // debounce handle for the wheel-driven flush/preview
let ledError = false;
let ledPreviewActive = false;  // a live colour is being previewed on the strip
let ledPaletteDirty = false;   // cross-state edits not yet PUT (deferred to a preview-end seam)
let ledLastLit = {};           // last lit colour per 'zoneKey:state', restored on power-on
// Colour step-sequence editor (REAL capability — see led-sequence.js header:
// repeated previewLedStrip() calls, not a CSS stand-in). The ACTUAL playback
// timer/writes/ownership arbitration live in led-strip-runner.js, shared with
// app.js's machine-state trigger -- this page only edits the persisted
// sequence and drives the runner's 'manual' owner slot. ledSeqSteps/Loop/
// TriggerStates are the persisted editor state, loaded lazily on first
// render; ledSeqRunSnapshot mirrors the shared runner's state for painting.
let ledSeqSteps = null;
let ledSeqLoop = false;
let ledSeqTriggerStates = [];
let ledSeqLoaded = false;
let ledSeqRunUnsubscribe = null; // set once subscribed to led-strip-runner.js's onRunChange
let ledSeqRunSnapshot = { owner: null, running: false, index: -1 };
let iroLoadPromise = null;
let iroLoadFailed = false;
const LED_DEFAULT_ON = 'FFFFAAAA5555'; // warm white — default colour when powering a zone on with no history

const LED_PRESETS = [
    ['Off', '#000000'], ['Warm White', '#FFAA55'], ['Soft White', '#FFD9A0'],
    ['Daylight', '#EAF2FF'], ['Blue', '#385A92'], ['Amber', '#FF7A00'],
    ['Red', '#FF2200'], ['Green', '#0CA581'], ['Cyan', '#00C2D1'], ['Purple', '#7A3FF2']
];

const ledZoneKeys = (zone) => zone === 'front' ? ['frontStrip']
    : zone === 'rear' ? ['backStrip']
    : zone === 'switch' ? ['frontSwitch']
    : ['frontStrip', 'backStrip']; // both
// The palette bank the machine is currently rendering on the strips: 'sleeping'
// only when the machine is actually asleep; every other (or unknown) state runs
// the awake palette.
const ledMachinePaletteState = () =>
    currentMachineState === MachineState.SLEEPING ? 'sleeping' : 'awake';
function ledCellColor16(zoneKey, stateKey) { return ledState?.[zoneKey]?.[stateKey] || '000000000000'; }
function ledCurrentColor16() { return ledCellColor16(ledZoneKeys(ledSelectedZone)[0], ledSelectedState); }
function ledNormalize(data) {
    const z = (o) => ({ awake: o?.awake || '000000000000', sleeping: o?.sleeping || '000000000000' });
    return { frontStrip: z(data?.frontStrip), backStrip: z(data?.backStrip), frontSwitch: z(data?.frontSwitch) };
}

// Lazy-load the persisted step sequence (steps + loop + trigger states).
// Re-reads localStorage whenever the in-memory copy hasn't been loaded yet
// so a settings re-open after a KV sync from another device picks up the
// synced value.
function ledSeqLoad() {
    if (!ledSeqLoaded) {
        let stored = null;
        try { stored = localStorage.getItem(LED_SEQUENCE_KEY); } catch (e) { /* private mode */ }
        const sequence = parseLedSequence(stored);
        ledSeqSteps = sequence.steps;
        ledSeqLoop = sequence.loop;
        ledSeqTriggerStates = sequence.triggerStates;
        ledSeqLoaded = true;
    }
    return ledSeqSteps;
}

function ledSeqPersist() {
    try {
        localStorage.setItem(LED_SEQUENCE_KEY, serializeLedSequence({
            steps: ledSeqSteps || [], loop: ledSeqLoop, triggerStates: ledSeqTriggerStates,
        }));
    } catch (e) { /* private mode — in-memory state still updates */ }
}

// Mirror led-strip-runner.js's shared run state (owner/index) into this page
// so the active-step highlight and Start/Stop buttons reflect it, including a
// trigger run that started while the user happens to be on this page. Wired
// once per Settings visit; ledSeqReleaseManual() below tears it down at every
// exit seam.
function ledSeqEnsureSubscribed() {
    if (ledSeqRunUnsubscribe) return;
    ledSeqRunSnapshot = ledRunGetState();
    ledSeqRunUnsubscribe = ledRunOnChange((snapshot) => {
        ledSeqRunSnapshot = snapshot;
        ledSeqPaintActiveStep();
    });
}

// Release this page's 'manual' ownership (a no-op if 'manual' doesn't
// currently own the strip -- e.g. only a trigger run, or nothing, is
// active) and drop the run-state subscription. Stopping a manual run hands
// control back to the state trigger -- see led-strip-runner.js.
function ledSeqReleaseManual() {
    ledRunRequestStop('manual');
    if (ledSeqRunUnsubscribe) { ledSeqRunUnsubscribe(); ledSeqRunUnsubscribe = null; }
}

export function renderLedSettings() {
    if (!window.iro) {
        if (!iroLoadPromise && !iroLoadFailed) {
            iroLoadPromise = loadIro()
                .then(() => {
                    iroLoadPromise = null;
                    if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
                })
                .catch(error => {
                    console.error('Colour picker failed to load.', error);
                    iroLoadPromise = null;
                    iroLoadFailed = true;
                    if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
                });
        }
        return iroLoadFailed
            ? renderErrorState(getTranslation('Lighting'), getTranslation('Colour picker failed to load'))
            : renderLoadingState(getTranslation('Lighting'));
    }
    if (ledState === null && !ledError) {
        getLedStrip()
            .then((data) => { ledState = ledNormalize(data); ledCommitted = JSON.stringify(ledState); if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip'); })
            .catch(() => { ledError = true; if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip'); });
        return renderLoadingState(getTranslation('Lighting'));
    }
    if (ledError || !ledState) {
        return renderErrorState(getTranslation('Lighting'), getTranslation('Failed to load lighting settings'));
    }
    ledSeqEnsureSubscribed();

    const isOn = ledCurrentColor16() !== '000000000000';
    const seg = (value, label, current, handler) => {
        const active = current === value;
        return `<button class="flex-1 h-[80px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[26px] flex items-center justify-center cursor-pointer transition-colors duration-200 ${active ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[var(--text-primary)]'}"
                    aria-pressed="${active}" onclick="window.${handler}('${value}')" data-i18n-key="${label}">${getTranslation(label)}</button>`;
    };
    const cell = (zoneKey, zoneLabel, stateKey) => {
        const isActive = ledZoneKeys(ledSelectedZone).includes(zoneKey) && ledSelectedState === stateKey;
        return `<button aria-label="${zoneLabel} ${stateKey}" data-led-cell="${zoneKey}:${stateKey}" onclick="window.ledSelectCell('${zoneKey}','${stateKey}')"
                    class="h-[64px] rounded-[10px] border-2 ${isActive ? 'border-[var(--mimoja-blue)]' : 'border-[var(--profile-button-outline-color)]'}"
                    style="background-color: ${ledColor16ToHex8(ledCellColor16(zoneKey, stateKey))}"></button>`;
    };
    const presetSwatches = LED_PRESETS.map(([name, hex]) =>
        `<button title="${name}" aria-label="${name}" onclick="window.ledApplyPreset('${hex}')"
            class="w-[64px] h-[64px] rounded-full border-2 border-[var(--profile-button-outline-color)]" style="background-color: ${hex}"></button>`
    ).join('');

    // Colour step sequence — a REAL capability (see led-sequence.js header):
    // Start walks the steps, pushing each one to the strip via the same
    // previewLedStrip() the wheel above uses, on a per-step timer.
    const seqSteps = ledSeqLoad();
    const seqStepRow = (step, index) => `
        <div class="led-seq-step ${ledSeqRunSnapshot.index === index ? 'led-seq-step-active' : ''} flex items-center gap-[14px] w-full flex-wrap px-[14px] py-[10px]" data-led-seq-step="${index}">
            <span class="text-[var(--text-secondary)] text-[18px] font-semibold w-[28px]">${index + 1}</span>
            <input type="color" aria-label="${getTranslation('Front')}" value="${step.frontColor}"
                onchange="window.ledSeqUpdateStep(${index}, { frontColor: this.value })"
                class="w-[48px] h-[48px] rounded-[8px] border-2 border-[var(--profile-button-outline-color)] cursor-pointer" />
            <input type="color" aria-label="${getTranslation('Rear')}" value="${step.rearColor}"
                onchange="window.ledSeqUpdateStep(${index}, { rearColor: this.value })"
                class="w-[48px] h-[48px] rounded-[8px] border-2 border-[var(--profile-button-outline-color)] cursor-pointer" />
            <input type="number" min="${MIN_STEP_DURATION_MS}" max="${MAX_STEP_DURATION_MS}" step="100" value="${step.durationMs}"
                aria-label="${getTranslation('Duration (ms)')}"
                onchange="window.ledSeqUpdateStep(${index}, { durationMs: this.value })"
                class="w-[110px] h-[48px] rounded-[8px] border-2 border-[var(--profile-button-outline-color)] bg-[var(--box-color)] text-[var(--text-primary)] text-[18px] px-[10px]" />
            <span class="text-[var(--text-secondary)] text-[16px]" data-i18n-key="ms">ms</span>
            <div class="flex gap-[6px] ml-auto">
                <button aria-label="${getTranslation('Move step up')}" ${index === 0 ? 'disabled' : ''} onclick="window.ledSeqMoveStep(${index}, 'up')"
                    class="w-[40px] h-[40px] rounded-[8px] border border-[var(--profile-button-outline-color)] text-[var(--text-primary)] disabled:opacity-30">&uarr;</button>
                <button aria-label="${getTranslation('Move step down')}" ${index === seqSteps.length - 1 ? 'disabled' : ''} onclick="window.ledSeqMoveStep(${index}, 'down')"
                    class="w-[40px] h-[40px] rounded-[8px] border border-[var(--profile-button-outline-color)] text-[var(--text-primary)] disabled:opacity-30">&darr;</button>
                <button aria-label="${getTranslation('Remove step')}" onclick="window.ledSeqRemoveStep(${index})"
                    class="w-[40px] h-[40px] rounded-[8px] border border-[var(--status-red-color)] text-[var(--status-red-color)]">&times;</button>
            </div>
        </div>`;

    return `
        <div class="content-stretch flex flex-col gap-[40px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Lighting">Lighting</p>
            </div>

            <div class="flex flex-row gap-[48px] w-full items-start flex-wrap">
                <div class="flex flex-col gap-[28px] flex-1 min-w-[420px]">
                    <div class="flex flex-col gap-[12px] w-full">
                        <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[26px]" data-i18n-key="Zone">Zone</p>
                        <div class="flex gap-[12px] w-full">
                            ${seg('front', 'Front', ledSelectedZone, 'ledSelectZone')}
                            ${seg('rear', 'Rear', ledSelectedZone, 'ledSelectZone')}
                            ${seg('both', 'Both', ledSelectedZone, 'ledSelectZone')}
                        </div>
                    </div>
                    <div class="flex flex-col gap-[12px] w-full">
                        <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[26px]" data-i18n-key="State">State</p>
                        <div class="flex gap-[12px] w-full">
                            ${seg('awake', 'Awake', ledSelectedState, 'ledSelectState')}
                            ${seg('sleeping', 'Asleep', ledSelectedState, 'ledSelectState')}
                        </div>
                    </div>
                    <div class="flex flex-col gap-[12px] w-full">
                        <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[26px]" data-i18n-key="Current Colours">Current Colours</p>
                        <div class="grid w-full gap-[12px] items-center" style="grid-template-columns: 120px 1fr 1fr;">
                            <div></div>
                            <div class="text-center text-[var(--text-primary)] text-[22px] font-semibold" data-i18n-key="Awake">Awake</div>
                            <div class="text-center text-[var(--text-primary)] text-[22px] font-semibold" data-i18n-key="Asleep">Asleep</div>
                            <div class="text-[var(--text-primary)] text-[22px] font-semibold" data-i18n-key="Front">Front</div>
                            ${cell('frontStrip', 'Front', 'awake')}
                            ${cell('frontStrip', 'Front', 'sleeping')}
                            <div class="text-[var(--text-primary)] text-[22px] font-semibold" data-i18n-key="Rear">Rear</div>
                            ${cell('backStrip', 'Rear', 'awake')}
                            ${cell('backStrip', 'Rear', 'sleeping')}
                        </div>
                    </div>
                    <div class="flex flex-col gap-[12px] w-full">
                        <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[26px]" data-i18n-key="Presets">Presets</p>
                        <div class="flex flex-wrap gap-[14px]">${presetSwatches}</div>
                    </div>
                </div>

                <div class="flex flex-col gap-[20px] items-center">
                    <div class="flex items-center justify-between gap-[20px] w-full">
                        <span class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[26px]" data-i18n-key="Power">Power</span>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="ledPowerToggle" class="sr-only peer" ${isOn ? 'checked' : ''} onchange="window.ledSetPower(this.checked)">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>
                    <div id="led-picker-slot" style="position:relative;"><div id="led-picker" style="${isOn ? '' : 'opacity:0.35;pointer-events:none;'}"></div></div>
                    <p class="text-[var(--text-secondary)] text-[20px]" data-i18n-key="Wheel picks colour · slider sets brightness">Wheel picks colour · slider sets brightness</p>
                    <div class="flex items-center gap-[16px]" style="${isOn ? '' : 'opacity:0.35;'}">
                        <div id="led-current-swatch" class="w-[56px] h-[56px] rounded-[10px] border-2 border-[var(--profile-button-outline-color)]" style="background-color: ${ledColor16ToHex8(ledCurrentColor16())}"></div>
                        <span id="led-hex-readout" class="font-['NotoSansMono'] text-[var(--text-primary)] text-[24px]">${isOn ? ledColor16ToHex8(ledCurrentColor16()) : 'Off'}</span>
                    </div>
                </div>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="flex flex-col gap-[20px] w-full">
                <div class="flex items-center justify-between w-full flex-wrap gap-[16px]">
                    <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[26px]" data-i18n-key="Colour Sequence">Colour Sequence</p>
                    <div class="flex items-center gap-[12px]">
                        <span class="text-[var(--text-primary)] text-[18px] font-semibold" data-i18n-key="Loop">Loop</span>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[76px] h-[38px]">
                            <input type="checkbox" class="sr-only peer" ${ledSeqLoop ? 'checked' : ''} onchange="window.ledSeqSetLoop(this.checked)">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[4px] -translate-y-1/2 peer-checked:translate-x-[34px] size-[30px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>
                </div>
                <div class="led-seq-notice flex items-center px-[16px] py-[10px] text-[18px]">
                    <span data-i18n-key="Steps run live on the strip, at least 500ms apart -- BLE/REST round trips make faster steps unreliable.">Steps run live on the strip, at least 500ms apart -- BLE/REST round trips make faster steps unreliable.</span>
                </div>
                <div class="flex flex-col gap-[10px] w-full">
                    ${seqSteps.length ? seqSteps.map(seqStepRow).join('')
                        : `<p class="text-[var(--text-secondary)] text-[18px]" data-i18n-key="No steps yet -- add one to build a sequence.">No steps yet -- add one to build a sequence.</p>`}
                </div>
                <div class="flex items-center justify-between w-full flex-wrap gap-[16px]">
                    <button class="border-2 border-[var(--mimoja-blue)] text-[var(--mimoja-blue)] h-[56px] px-[28px] rounded-[28px] text-[18px] font-bold" onclick="window.ledSeqAddStep()" data-i18n-key="Add Step">Add Step</button>
                    <div class="flex items-center gap-[12px] flex-wrap">
                        ${ledSeqRunSnapshot.running
                            ? `<span class="text-[16px] font-semibold ${ledSeqRunSnapshot.owner === 'manual' ? 'text-[var(--mimoja-blue)]' : 'text-[var(--text-secondary)]'}" data-i18n-key="${ledSeqRunSnapshot.owner === 'manual' ? 'Playing (manual)' : 'Playing (auto)'}">${getTranslation(ledSeqRunSnapshot.owner === 'manual' ? 'Playing (manual)' : 'Playing (auto)')}</span>`
                            : ''}
                        <button id="led-seq-start-btn" ${!seqSteps.length ? 'disabled' : ''} onclick="window.ledSeqStart()"
                            class="bg-[var(--mimoja-blue)] text-white h-[56px] px-[32px] rounded-[28px] text-[18px] font-bold disabled:opacity-40" data-i18n-key="Start">Start</button>
                        <button id="led-seq-stop-btn" ${ledSeqRunSnapshot.owner === 'manual' ? '' : 'disabled'} onclick="window.ledSeqStop()"
                            class="border-2 border-[var(--status-red-color)] text-[var(--status-red-color)] h-[56px] px-[32px] rounded-[28px] text-[18px] font-bold disabled:opacity-40" data-i18n-key="Stop">Stop</button>
                    </div>
                </div>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="flex flex-col gap-[12px] w-full">
                <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[26px]" data-i18n-key="Auto-Run">Auto-Run</p>
                <p class="text-[var(--text-secondary)] text-[18px]" data-i18n-key="Runs this sequence automatically when the machine reaches:">Runs this sequence automatically when the machine reaches:</p>
                <div class="flex flex-wrap gap-[10px]">
                    ${LED_TRIGGER_STATES.map((s) => {
                        const active = ledSeqTriggerStates.includes(s.id);
                        return `<button type="button" aria-pressed="${active}" onclick="window.ledSeqToggleTriggerState('${s.id}', ${!active})"
                            class="h-[44px] px-[18px] rounded-full text-[16px] font-['Inter:Bold',sans-serif] font-bold transition-colors duration-200 ${active ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[var(--text-primary)]'}"
                            data-i18n-key="${s.label}">${getTranslation(s.label)}</button>`;
                    }).join('')}
                </div>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="flex justify-end gap-[20px] w-full">
                <button class="border-2 border-[var(--mimoja-blue)] text-[var(--mimoja-blue)] h-[82px] px-[48px] rounded-[67.5px] text-[24px] font-bold" onclick="window.ledReset()" data-i18n-key="Reset">Reset</button>
                <button class="bg-[var(--mimoja-blue)] text-white h-[82px] px-[48px] rounded-[67.5px] text-[24px] font-bold" onclick="window.ledSave()" data-i18n-key="Save">Save</button>
            </div>
        </div>
    `;
}

function initLedPicker() {
    const el = document.getElementById('led-picker');
    if (!el || !window.iro || !ledState) return;
    el.innerHTML = '';
    el.style.transform = '';
    el.style.width = '';
    el.style.height = '';
    ledPicker = new window.iro.ColorPicker(el, {
        width: 300,
        color: ledColor16ToHex8(ledCurrentColor16()),
        borderWidth: 2,
        borderColor: 'var(--box-color)',
        handleRadius: 18,
        padding: 8,
        layout: [
            { component: window.iro.ui.Wheel, options: { wheelLightness: false } },
            { component: window.iro.ui.Slider, options: { sliderType: 'value' } }
        ]
    });
    // The whole UI is CSS-scaled (transform: scale(S)). iro reads the *scaled*
    // getBoundingClientRect for the touch position but its unscaled config `width`
    // for the wheel geometry, so touches land off by S (worse toward the right).
    // Counter-scale the picker by 1/S so its rendered size == its config size and
    // the pointer math lines up; reserve the visual footprint so siblings don't overlap.
    let s = 1;
    try {
        const sc = document.getElementById('scaled-content');
        if (sc) { const m = new DOMMatrix(getComputedStyle(sc).transform); if (m && m.a) s = m.a; }
    } catch (e) { /* ignore — no scale */ }
    const slot = document.getElementById('led-picker-slot');
    if (s && Math.abs(s - 1) > 0.02 && slot) {
        // Counter-scaling makes the picker's *visual* size exceed its layout box,
        // so pin the picker absolutely and give its wrapper slot the visual size —
        // the slot reserves the flow space, the picker fills it, siblings don't overlap.
        const nat = el.getBoundingClientRect(); // natural (in-flow) size
        slot.style.width = `${nat.width / (s * s)}px`;
        slot.style.height = `${nat.height / (s * s)}px`;
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.left = '0';
        el.style.transformOrigin = 'top left';
        el.style.transform = `scale(${1 / s})`;
    }
    ledPicker.on('input:change', (color) => {
        const c16 = ledRgbToColor16(color.rgb);
        ledZoneKeys(ledSelectedZone).forEach((k) => { if (ledState[k]) ledState[k][ledSelectedState] = c16; });
        ledUpdateSwatchesDom(color.hexString);
        ledSchedulePut();
    });
    ledPicker.on('input:end', () => ledCommitEdit());
}

function ledUpdateSwatchesDom(hex8) {
    const sw = document.getElementById('led-current-swatch');
    const hx = document.getElementById('led-hex-readout');
    if (sw) sw.style.backgroundColor = hex8;
    if (hx) hx.textContent = hex8.toUpperCase();
    ledZoneKeys(ledSelectedZone).forEach((k) => {
        const c = document.querySelector(`[data-led-cell="${k}:${ledSelectedState}"]`);
        if (c) c.style.backgroundColor = hex8;
    });
}

// ── LED strip write sequencing ───────────────────────────────────────────────
// Every write that changes what the strip SHOWS (palette PUT, preview POST,
// preview clear) is funnelled through ONE promise chain, so writes land in
// enqueue order and can never interleave. This is what keeps a cross-state
// preview steady: the FW unconditionally re-applies the machine-state bank to
// the live registers on EVERY palette-register write, so any PUT
// that lands while a cross-state preview is up repaints the strip with the
// awake palette until the next preview write — a visible flash. The rules
// that make that flash impossible:
//   1. While a cross-state edit is active, NO stored-palette PUT is issued —
//      not per move (which alternated visibly) and not at gesture end (which
//      left a residual flash). Moves and gesture ends are PREVIEW writes only,
//      coalesced update-in-place (never a clear between two previews); the
//      pending palette is only marked dirty (ledCommitEdit).
//   2. The deferred PUT flushes at the seams where the preview ENDS — target
//      switch, Save, Reset, settings Cancel/Save, leaving the Lighting page —
//      enqueued immediately BEFORE that seam's preview-clear (ledFlushDirty →
//      ledPutPalette, no preview chase). The cross-state edit never touched
//      the bank the machine is rendering, so the FW re-apply this PUT
//      triggers paints exactly the palette the clear then writes to the live
//      registers: the strip makes ONE transition, picked colour → final.
//   3. Same-state edits keep the immediate PUT (ledFlushPut) — there the FW
//      re-apply repaints the very colour just edited, so nothing can flash.
//   4. The chain serializes all of it: a queued PUT can never slip between a
//      preview and the eye, and a seam's clear can never run before its flush.
let ledOpChain = Promise.resolve(); // serialized LED I/O; tail never rejected
let ledPreviewQueued = false;       // a preview op is queued but not yet started
let ledFlushQueued = false;         // a PUT+preview flush op is queued but not yet started
let ledFlushPromise = Promise.resolve(); // the queued flush, for coalesced awaiters (Save)

function ledEnqueue(op) {
    const p = ledOpChain.then(op);
    ledOpChain = p.catch(() => {}); // keep the chain alive whatever op did
    return p;
}

// A preview colour is on the strip, or a queued op is about to put one there —
// the exit seams must clear in either case or a late op would latch the strip.
const ledPreviewPending = () => ledPreviewActive || ledPreviewQueued || ledFlushQueued;

// POST a live preview of what the user is looking at (edited zones show the
// bank being edited, all other zones the bank the machine is rendering).
// Coalesced: at most one op waits in the chain, and it reads the freshest
// palette/target state only when it actually runs.
function ledPushPreview() {
    if (ledPreviewQueued) return;
    ledPreviewQueued = true;
    ledEnqueue(async () => {
        ledPreviewQueued = false;
        if (!ledState) return;
        const { front, back } = ledPreviewComposite(
            ledState, ledZoneKeys(ledSelectedZone), ledSelectedState, ledMachinePaletteState());
        try { await previewLedStrip(front, back); ledPreviewActive = true; }
        catch (e) { /* preview is a nicety — non-fatal */ }
    });
}

function ledSchedulePut() {
    if (ledPutTimer) clearTimeout(ledPutTimer);
    ledPutTimer = setTimeout(() => {
        ledPutTimer = null;
        // The user may leave the page inside the debounce window; a late write
        // would land after the exit seam's clear and latch a preview colour.
        if (activeSettingsCategory !== 'ledstrip') return;
        if (ledSelectedState === ledMachinePaletteState()) {
            ledFlushPut(); // same-state: the PUT itself repaints the strip correctly
        } else {
            ledPushPreview(); // cross-state: preview only — no PUT between moves
        }
    }, 120);
}

// Commit an edit gesture (wheel release, preset tap, power toggle).
// Same-state: PUT now — the FW re-apply repaints the colour just edited.
// Cross-state: NO PUT (it would flash the awake palette over the preview) --
// mark the palette dirty and land the final position as one more
// coalesced preview write; the preview-end seams flush the PUT later.
function ledCommitEdit() {
    if (ledPutTimer) { clearTimeout(ledPutTimer); ledPutTimer = null; }
    // Same late-write guard as ledSchedulePut: with multi-touch, input:end can
    // fire AFTER an exit seam (one finger navigates while another still holds
    // the wheel) — a late commit would re-post a preview after that seam's
    // clear and latch it on the strip until the next navigation event.
    if (activeSettingsCategory !== 'ledstrip') return;
    if (ledSelectedState === ledMachinePaletteState()) {
        ledFlushPut();
    } else {
        ledPaletteDirty = true;
        ledPushPreview();
    }
}

// PUT the stored palette, then immediately re-assert the preview in the same
// chain link (the FW re-applies the machine's wake-state bank on every palette
// write, so an unchased PUT would knock a cross-state preview off the strip).
// Returns a promise that resolves once both writes have landed (Save awaits it).
function ledFlushPut() {
    if (ledPutTimer) { clearTimeout(ledPutTimer); ledPutTimer = null; }
    if (!ledState) return Promise.resolve();
    if (ledFlushQueued) return ledFlushPromise; // the queued op reads fresh state when it runs
    ledFlushQueued = true;
    ledFlushPromise = ledEnqueue(async () => {
        ledFlushQueued = false;
        if (!ledState) return;
        ledPaletteDirty = false; // this PUT carries the full current palette
        // The front-switch LED can't be set independently — it mirrors the front strip.
        ledState.frontSwitch = { awake: ledState.frontStrip.awake, sleeping: ledState.frontStrip.sleeping };
        try { await setLedStrip(ledState); } catch (e) { /* non-fatal */ }
        const { front, back } = ledPreviewComposite(
            ledState, ledZoneKeys(ledSelectedZone), ledSelectedState, ledMachinePaletteState());
        try { await previewLedStrip(front, back); ledPreviewActive = true; }
        catch (e) { /* preview is a nicety — non-fatal */ }
    });
    return ledFlushPromise;
}

// PUT the stored palette with NO preview chase. Exit-seam use only: enqueue it
// immediately BEFORE that seam's ledClearPreview(). A cross-state edit never
// touched the bank the machine is rendering, so the FW re-apply this PUT
// triggers paints exactly the palette the following clear writes to the live
// registers — the strip makes one transition (preview → final), and with no
// chased preview left in flight there is nothing to flash back from. Also the
// pre-commit flush for Save, which needs the registers current before
// commitLedStrip persists them.
function ledPutPalette() {
    if (ledPutTimer) { clearTimeout(ledPutTimer); ledPutTimer = null; }
    if (!ledState) { ledPaletteDirty = false; return Promise.resolve(); }
    return ledEnqueue(() => {
        if (!ledState) return;
        ledPaletteDirty = false;
        // The front-switch LED can't be set independently — it mirrors the front strip.
        ledState.frontSwitch = { awake: ledState.frontStrip.awake, sleeping: ledState.frontStrip.sleeping };
        return setLedStrip(ledState).catch(() => { /* non-fatal */ });
    });
}

// Flush a deferred cross-state PUT (no-op when nothing was deferred). Call at
// every seam where the preview ends, immediately before that seam's
// ledClearPreview() — the shared chain guarantees the flush lands first.
function ledFlushDirty() {
    if (ledPaletteDirty) ledPutPalette();
}

// Restore the strip to its real (wake-state) palette after previewing. Chained,
// so it lands after any queued preview/PUT (whose chase would otherwise win),
// and it re-drops the active flag the moment it runs. Safe to call anytime.
function ledClearPreview() {
    if (!ledPreviewPending()) return;
    ledPreviewActive = false;
    ledEnqueue(() => { ledPreviewActive = false; return clearLedStripPreview().catch(() => {}); });
}

// Browser/OS back navigation exits settings through the router's popstate
// handler, not the Cancel/Save buttons — without this seam a cross-state
// preview stays latched on the strip and the deferred palette PUT is
// postponed until the next settings visit (lost entirely on an app reload).
// Flush → clear, exactly like the Cancel/Save seams; both calls are no-ops
// when nothing is pending, so firing on every popstate is safe. The settings
// DOM is being torn down, so no category is active any more — dropping
// activeSettingsCategory also disarms the late-write guards (ledSchedulePut,
// ledCommitEdit) and lets the cup-warmer poll self-stop on its next tick.
// Module-level: registered once, not per initializeSettings call.
window.addEventListener('popstate', () => {
    ledFlushDirty();
    ledClearPreview();
    ledSeqReleaseManual();
    activeSettingsCategory = null;
});

// Switching the edit target (zone or state bank) ends the current preview —
// the strip returns to the machine's real palette until the user picks again.
// A deferred cross-state PUT flushes first (flush → clear, one transition).
window.ledSelectZone = function(zone) {
    if (ledSelectedZone !== zone) { ledFlushDirty(); ledClearPreview(); }
    ledSelectedZone = zone;
    if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
};
window.ledSelectState = function(state) {
    if (ledSelectedState !== state) { ledFlushDirty(); ledClearPreview(); }
    ledSelectedState = state;
    if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
};
window.ledSelectCell = function(zoneKey, stateKey) {
    const zone = zoneKey === 'frontStrip' ? 'front' : zoneKey === 'backStrip' ? 'rear' : 'switch';
    if (ledSelectedZone !== zone || ledSelectedState !== stateKey) { ledFlushDirty(); ledClearPreview(); }
    ledSelectedZone = zone;
    ledSelectedState = stateKey;
    if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
};
window.ledApplyPreset = function(hex8) {
    if (!ledState) return;
    const c16 = ledRgbToColor16(ledHexToRgb(hex8));
    ledZoneKeys(ledSelectedZone).forEach((k) => {
        if (!ledState[k]) return;
        const cur = ledState[k][ledSelectedState];
        if (c16 === '000000000000' && cur && cur !== '000000000000') ledLastLit[k + ':' + ledSelectedState] = cur;
        ledState[k][ledSelectedState] = c16;
    });
    if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
    ledCommitEdit();
};
// Power toggle (Hue-style): Off = black (0,0,0), remembers the last lit colour;
// On = restore that colour (or a warm-white default). Note the value slider CAN
// reach black on its own — power is derived from the colour (never stored), so
// a slider dragged to zero reads as Off on the next full render.
window.ledSetPower = function(on) {
    if (!ledState) return;
    ledZoneKeys(ledSelectedZone).forEach((k) => {
        if (!ledState[k]) return;
        const key = k + ':' + ledSelectedState;
        const cur = ledState[k][ledSelectedState];
        if (!on) {
            if (cur && cur !== '000000000000') ledLastLit[key] = cur;
            ledState[k][ledSelectedState] = '000000000000';
        } else {
            ledState[k][ledSelectedState] = ledLastLit[key] || LED_DEFAULT_ON;
        }
    });
    if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
    ledCommitEdit();
};
// ── Colour step-sequence editor ──────────────────────────────────────────
// A REAL capability (see led-sequence.js header). Editing is local to this
// page: every edit persists to localStorage and re-renders the category, same
// as every other control here. Playback itself -- the timer, the actual
// previewLedStrip() writes, and arbitration against app.js's machine-state
// trigger -- lives entirely in led-strip-runner.js, shared with app.js, so it
// can keep running on the main page after the user leaves Settings. This page
// only drives that shared runner's 'manual' owner slot (ledSeqEnsureSubscribed/
// ledSeqReleaseManual above) and mirrors its state to paint the active-step
// highlight and Start/Stop buttons -- see ledSeqPaintActiveStep.

function ledSeqEdit(next) {
    ledSeqSteps = next;
    ledSeqPersist();
    if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
}
window.ledSeqAddStep = function() {
    ledSeqEdit(addStep(ledSeqLoad(), { frontColor: '#FFAA55', rearColor: '#FFAA55' }));
};
window.ledSeqRemoveStep = function(index) {
    ledSeqEdit(removeStep(ledSeqLoad(), index));
};
window.ledSeqUpdateStep = function(index, patch) {
    ledSeqEdit(updateStep(ledSeqLoad(), index, patch));
};
window.ledSeqMoveStep = function(index, direction) {
    ledSeqEdit(moveStep(ledSeqLoad(), index, index + (direction === 'up' ? -1 : 1)));
};
window.ledSeqSetLoop = function(checked) {
    ledSeqLoop = !!checked;
    ledSeqPersist();
};
// Which machine states auto-run this sequence (app.js's trigger, via
// led-strip-runner.js). Re-resolving immediately against the machine's
// CURRENT state makes toggling feel live instead of waiting for the next
// state change -- a no-op if 'manual' currently owns the strip (it always
// wins) or the current state isn't the one just toggled.
window.ledSeqToggleTriggerState = function(stateId, enabled) {
    ledSeqLoad();
    const next = toggleTriggerState({ steps: ledSeqSteps, loop: ledSeqLoop, triggerStates: ledSeqTriggerStates }, stateId, enabled);
    ledSeqTriggerStates = next.triggerStates;
    ledSeqPersist();
    ledRunOnMachineStateChange(currentMachineState);
    if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
};

// Patch just the active-step highlight + Start/Stop buttons -- no re-render.
// ledSeqRunSnapshot reflects led-strip-runner.js's shared state, so this
// highlights whichever step is ACTUALLY on the strip right now, even if a
// trigger run (not this page) put it there.
function ledSeqPaintActiveStep() {
    document.querySelectorAll('[data-led-seq-step]').forEach((el) => {
        el.classList.toggle('led-seq-step-active', Number(el.dataset.ledSeqStep) === ledSeqRunSnapshot.index);
    });
    const startBtn = document.getElementById('led-seq-start-btn');
    const stopBtn = document.getElementById('led-seq-stop-btn');
    if (startBtn) startBtn.disabled = !ledSeqSteps?.length;
    if (stopBtn) stopBtn.disabled = ledSeqRunSnapshot.owner !== 'manual';
}

// 'manual' always preempts whatever is running (including a trigger run) --
// see led-strip-runner.js. A no-op if there are no steps.
window.ledSeqStart = function() {
    ledSeqLoad();
    ledRunRequestStart(ledSeqSteps, ledSeqLoop, 'manual');
};
// Stops only if THIS page's manual run currently owns the strip; hands
// control back to the trigger for the machine's current state if it does.
// A no-op while a trigger run (started from app.js) is what's active.
window.ledSeqStop = function() {
    ledRunRequestStop('manual');
};
window.ledSave = async function() {
    // Chaseless PUT, then commit, then clear — the PUT's FW re-apply and the
    // clear paint the same (machine-state) palette: one strip transition.
    try { await ledPutPalette(); await commitLedStrip(); ledClearPreview(); ledCommitted = JSON.stringify(ledState); ui.showToast(getTranslation('Lighting saved'), 2000, 'success'); }
    catch (e) { ui.showToast(getTranslation('Failed to save lighting'), 3000, 'error'); }
};
window.ledReset = async function() {
    try {
        const data = await resetLedStrip();
        ledState = ledNormalize(data);
        ledCommitted = JSON.stringify(ledState);
        ledPaletteDirty = false; // deferred edits are discarded with the rest
        await ledEnqueue(() => setLedStrip(ledState)); // push reloaded NVM values back to the live registers (the seam flush, pre-clear)
        ledClearPreview();
        if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
        ui.showToast(getTranslation('Lighting reset'), 2000, 'success');
    } catch (e) { ui.showToast(getTranslation('Failed to reset lighting'), 3000, 'error'); }
};

// Render Hot Water settings
export function renderHotWaterSettings() {
    if (!settingsCache.de1 && !settingsCache.workflow) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]" data-i18n-key="Hot Water Settings">Hot Water Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]" data-i18n-key="Failed to load settings">Failed to load settings</div>
            </div>
        `;
    }

    const hotWaterData = settingsCache.workflow?.hotWaterData || {};
    const targetTemp = hotWaterData.targetTemperature ?? 75;
    const volume = hotWaterData.volume ?? 50;
    const duration = hotWaterData.duration ?? 30;
    const flow = hotWaterData.flow ?? 2.5;
    // Stop-at-weight toggle + its lookahead multiplier — Rea (not workflow) settings.
    // The toggle only works with a scale: on (default) when one is connected,
    // forced off and locked when not (see applyStopHotWaterToggleState for live sync).
    const scaleConnected = window.getIsScaleConnected?.() ?? false;
    const stopHwAtWeight = scaleConnected && (settingsCache.rea?.stopHotWaterAtWeight ?? true);
    const hwFlowMult = settingsCache.rea?.hotWaterFlowMultiplier ?? 0.3;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Hot Water Settings">Hot Water Settings</p>
            </div>

            <!-- Hot Water Temperature -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Target Temperature (°C)">Target Temperature (°C)</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">${tempInputValue(50)} – ${tempInputValue(95)} ${tempUnitLabel()}</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease hot water temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterTemp(-1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="hotWaterTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${tempInputValue(targetTemp)}" step="1" min="${tempInputValue(50)}" max="${tempInputValue(95)}"
                                       onchange="window.updateHotWaterSetting('targetTemperature', Math.round(window.tempInputToCelsius(this.value)))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">${tempUnitLabel()}</span>
                            </div>
                            <button aria-label="Increase hot water temperature" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterTemp(1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Hot Water Volume -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Volume">Volume</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">10 – 500 ml</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease hot water volume" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterVolume(-10);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="hotWaterVolumeInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${volume}" step="10" min="10" max="500"
                                       onchange="window.updateHotWaterSetting('volume', parseInt(this.value))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml</span>
                            </div>
                            <button aria-label="Increase hot water volume" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterVolume(10);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Hot Water Duration -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Duration (seconds)">Duration (seconds)</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">5 – 120 s</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease hot water duration" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterDuration(-5);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="numeric" pattern="[0-9]*" id="hotWaterDurationInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${duration}" step="5" min="5" max="120"
                                       onchange="window.updateHotWaterSetting('duration', parseInt(this.value))">
                                <span class="ml-1 text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">s</span>
                            </div>
                            <button aria-label="Increase hot water duration" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterDuration(5);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Hot Water Flow -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Flow">Flow</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">0.1 – 8.0 ml/s</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease hot water flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterFlow(-0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="decimal" id="hotWaterFlowInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${flow.toFixed(1)}" step="0.1" min="0.1" max="8"
                                       onchange="window.updateHotWaterSetting('flow', parseFloat(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">ml/s</span>
                            </div>
                            <button aria-label="Increase hot water flow" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterFlow(0.1);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Stop Hot Water at Weight (needs a scale connected to take effect) -->
            <div class="flex items-center justify-between gap-[24px] w-full">
                <div class="flex flex-col gap-[4px]">
                    <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                        <p class="leading-[1.2]" data-i18n-key="Stop at Weight">Stop at Weight</p>
                        <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]" data-i18n-key="Requires a connected scale">Requires a connected scale</span>
                    </div>
                </div>
                <label class="stopHotWaterAtWeightLabel relative flex items-center flex-shrink-0 w-[100px] h-[50px] ${scaleConnected ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}">
                    <input type="checkbox" id="stopHotWaterAtWeightToggle"
                           class="sr-only peer"
                           ${stopHwAtWeight ? 'checked' : ''}
                           ${scaleConnected ? '' : 'disabled'}
                           onchange="window.updateReaSetting('stopHotWaterAtWeight', this.checked)">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>

            <!-- Hot Water Flow Multiplier (stop-at-weight lookahead) -->
            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex items-baseline gap-[14px] font-['Inter:Bold',sans-serif] font-bold leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Flow Multiplier">Flow Multiplier</p>
                            <span class="text-[20px] font-normal opacity-60 text-[var(--text-primary)]">Lookahead for stop-at-weight</span>
                        </div>
                        <div class="flex gap-[20px] h-[72px] items-center">
                            <button aria-label="Decrease hot water flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterFlowMultiplier(-0.05);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="flex items-center justify-center" style="width: 130px;">
                                <input type="text" inputmode="decimal" id="hotWaterFlowMultiplierInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                       value="${hwFlowMult}" step="0.05" min="0"
                                       onchange="window.updateReaSetting('hotWaterFlowMultiplier', parseFloat(this.value))">
                                <span class="ml-1 text-nowrap text-[var(--text-primary)] text-[24px] font-bold" aria-hidden="true">s</span>
                            </div>
                            <button aria-label="Increase hot water flow multiplier" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                    onclick="window.flashPlusMinusButton(this); window.adjustHotWaterFlowMultiplier(0.05);">
                                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Render Water Tank settings
export function renderWaterTankSettings() {
    if (!settingsCache.de1) {
        return `
            <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                    <p class="leading-[1.2]" data-i18n-key="Water Tank Settings">Water Tank Settings</p>
                </div>
                <div class="text-red-500 p-4 text-[24px]" data-i18n-key="Failed to load DE1 settings">Failed to load DE1 settings</div>
            </div>
        `;
    }

    return `
        <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Water Tank Settings">Water Tank Settings</p>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col gap-[20px] items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[20px] items-center px-[60px] py-[20px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]" data-i18n-key="Tank Temperature (°c)">
                            Tank Temperature (°c)
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="tank-temp-minus" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustTankTemp(-1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="tankTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${tempInputValue(settingsCache.de1.tankTemp !== undefined ? settingsCache.de1.tankTemp : 25)}"
                                   step="1" min="${tempInputValue(10)}" max="${tempInputValue(40)}"
                                   onchange="window.updateDe1Setting('tankTemp', Math.round(window.tempInputToCelsius(this.value)))">
                            <span class="ml-2 text-nowrap">${tempUnitLabel()}</span>
                        </div>
                        <button id="tank-temp-plus" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustTankTemp(1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center" data-i18n-key="Set the water tank temperature (10-40°C)">
                        Set the water tank temperature (10-40°C)
                    </p>
                </div>

                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[20px] items-center px-[60px] py-[20px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]" data-i18n-key="Water level">
                            Water level
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="water-alert-minus" aria-label="Decrease water alert level" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustWaterAlert(-5);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="waterAlertInput" aria-label="Water alert level" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${getWaterAlertLevel()}"
                                   step="5" min="0" max="30"
                                   onchange="window.commitWaterAlert(parseInt(this.value))">
                            <span class="ml-2 text-nowrap">mm</span>
                        </div>
                        <button id="water-alert-plus" aria-label="Increase water alert level" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustWaterAlert(5);">
                            <svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center" data-i18n-key="Alert when tank water level drops below this height (0, 5, 10, 15, 20, 25, 30 mm)">
                        Alert when tank water level drops below this height (0, 5, 10, 15, 20, 25, 30 mm)
                    </p>
                </div>

                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[20px] items-center px-[60px] py-[20px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]" data-i18n-key="Measurement Units">
                            Measurement Units
                        </p>
                    </div>
                    <div class="flex items-center gap-[8px]" role="group" aria-label="Water tank display unit">
                        <button class="h-[80px] w-[200px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[26px] flex items-center justify-center cursor-pointer transition-colors duration-200
                            ${getWaterTankUnit() === 'mm' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                            aria-pressed="${getWaterTankUnit() === 'mm'}"
                            onclick="window.setWaterTankUnit('mm')" data-i18n-key="mm">
                            mm
                        </button>
                        <button class="h-[80px] w-[200px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[26px] flex items-center justify-center cursor-pointer transition-colors duration-200
                            ${getWaterTankUnit() === 'ml' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                            aria-pressed="${getWaterTankUnit() === 'ml'}"
                            onclick="window.setWaterTankUnit('ml')" data-i18n-key="mL">
                            mL
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center" data-i18n-key="Show tank level on the home screen in millimeters or millilitres">
                        Show tank level on the home screen in millimeters or millilitres
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Allowed refill levels (mm) — coarse 5mm steps from 0 to 30.
const WATER_ALERT_LEVELS = [0, 5, 10, 15, 20, 25, 30];

function snapWaterAlertLevel(value) {
    if (isNaN(value)) return 15;
    const clamped = Math.max(0, Math.min(30, value));
    return WATER_ALERT_LEVELS.reduce((best, v) =>
        Math.abs(v - clamped) < Math.abs(best - clamped) ? v : best,
    WATER_ALERT_LEVELS[0]);
}

// Read persisted water alert refill level (mm). Default 15mm.
function getWaterAlertLevel() {
    const stored = parseInt(localStorage.getItem('waterRefillLevel'), 10);
    return WATER_ALERT_LEVELS.includes(stored) ? stored : 15;
}

// Read persisted water tank display unit ('mm' default, or 'ml').
function getWaterTankUnit() {
    return localStorage.getItem('waterTankUnit') === 'ml' ? 'ml' : 'mm';
}

// Render quick adjustments settings
export function renderQuickAdjustmentsSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Quick Adjustments">Quick Adjustments</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Flow Multiplier">Flow Multiplier</p>
                        </div>
                        <div class="flex items-center gap-4">
                            <input type="number" class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[160px] text-[var(--text-primary)] text-[26px] font-bold text-center" value="1.0" step="0.1">
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Adjust the flow multiplier for shot timing">
                        Adjust the flow multiplier for shot timing
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Steam">Steam</p>
                        </div>
                        <div class="flex items-center gap-4">
                            <input type="number" class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[160px] text-[var(--text-primary)] text-[26px] font-bold text-center" value="120" step="1">
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Set steam temperature
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Water">Water</p>
                        </div>
                        <div class="flex items-center gap-4">
                            <input type="number" class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[160px] text-[var(--text-primary)] text-[26px] font-bold text-center" value="80" step="1">
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full">
                        Set water temperature
                    </p>
                </div>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Limit">Limit</p>
                        </div>
                        <div class="flex items-center gap-4">
                            <input type="number" class="bg-[var(--box-color)] border-2 border-[#385a92] h-[72px] rounded-[72px] w-[160px] text-[var(--text-primary)] text-[26px] font-bold text-center" value="30" step="1">
                        </div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Set brewing time limit">
                        Set brewing time limit
                    </p>
                </div>
            </div>
        </div>
    `;
}

// --- Load-cell calibration wizard (Bengle two-point) -----------------------
// Firmware two-point cal: precision-zero on an empty platform, then latch the
// same known mass on the LEFT half (point 1) and the RIGHT half (point 2); the
// firmware solves both per-cell gains. Each cal REST call blocks ~15 s (10 s
// settle + 5 s average). State is module-level; the 4-step flow re-renders the
// settings content area on each transition (the app's "swap innerHTML" idiom).
let calStep = 1;                 // 1=zero 2=left 3=right 4=verify
let calWeightG = CAL_WEIGHT_DEFAULT_G; // reference mass (g)
let calBusy = false;             // a cal/tare call is in flight
let calError = '';               // last error message
let calDone = { 1: false, 2: false, 3: false };
let calWsClaimed = false;        // the step-4 readout owns the scale WS

function calResetWizard() {
    calStep = 1;
    calBusy = false;
    calError = '';
    calDone = { 1: false, 2: false, 3: false };
    calReleaseScaleWs();
}

function calRerender() {
    updateSettingsContentArea('calib_loadcell');
}

// The scale WebSocket is a process-wide singleton (connectScaleWebSocket
// closes any existing socket before opening a new one), so claiming it for
// the step-4 readout steals it from app.js's main-page weight display — and
// nothing over there re-registers it (initMainPageOnce is once-guarded).
// Claim whenever step 4 renders; hand it back via calReleaseScaleWs() when
// the wizard is left (page switch, settings exit, retry/finish).
function calEnsureScaleWs() {
    if (calWsClaimed) return;
    calWsClaimed = true;
    connectScaleWebSocket((data) => {
        const el = document.getElementById('calib-live-weight');
        if (el && data && typeof data.weight === 'number') {
            el.textContent = `${data.weight.toFixed(1)} g`;
        }
    });
}

function calReleaseScaleWs() {
    if (!calWsClaimed) return;
    calWsClaimed = false;
    if (typeof window.handleScaleData === 'function') {
        connectScaleWebSocket(window.handleScaleData, window.onScaleReconnect, window.onScaleDisconnect);
    }
}

function calStepIndicator() {
    const labels = ['Zero', 'Left cell', 'Right cell', 'Verify'];
    let dots = '';
    for (let i = 1; i <= 4; i++) {
        const isDone = calDone[i] || i < calStep;
        const isActive = i === calStep;
        const dotBg = isDone ? '#0ca581' : (isActive ? '#385a92' : 'var(--button-grey)');
        const dotColor = (isDone || isActive) ? '#ffffff' : '#959595';
        dots += `<div class="rounded-full flex items-center justify-center text-[22px] font-bold shrink-0" style="width:44px;height:44px;background:${dotBg};color:${dotColor}">${isDone ? '&#10003;' : i}</div>`;
        if (i < 4) dots += `<div class="shrink-0" style="width:40px;height:3px;background:${i < calStep ? '#0ca581' : 'var(--button-grey)'}"></div>`;
    }
    return `
        <div class="flex items-center justify-center w-full" style="gap:10px">${dots}</div>
        <p class="text-center text-[24px] text-[#959595] w-full">Step ${calStep} of 4 &middot; ${labels[calStep - 1]}</p>`;
}

const CAL_PRIMARY_BTN = "bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold";
const CAL_SECONDARY_BTN = "h-[72px] px-[48px] rounded-[72px] text-[24px] font-bold bg-[var(--box-color)] border-2 border-[#385a92] text-[var(--text-primary)]";
const CAL_CARD = "border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[30px] items-center px-[60px] py-[30px] relative shrink-0 max-w-full";
const CAL_HEADING = "font-['Inter:Semi_Bold',sans-serif] font-semibold leading-[1.2] not-italic text-[var(--text-primary)] text-[30px] text-center";
const CAL_BODY = "font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic text-[var(--text-primary)] text-[24px] w-full text-center";

// Fixed-height status line + ONE button that swaps label/action with state
// (see calActionState in loadcell-cal.js), so the card height stays constant
// and the buttons never jump:
//   idle  -> [status blank]          [Calibrate …]
//   busy  -> [status "Calibrating…"] [Cancel] (aborts the in-flight step)
//   error -> [status <error> (red)]  [Calibrate …]  (retry)
//   done  -> [status "✓ Done"]       [Next]
function calActionArea({ step, runLabel, runOnclick, nextStep, busyLabel }) {
    const st = calActionState({ busy: calBusy, error: calError, done: calDone[step], runLabel, busyLabel });
    let status = '&nbsp;';
    if (st.status === 'busy') status = `<span style="color:#959595">${st.statusText}</span>`;
    else if (st.status === 'error') status = `<span class="text-red-500">${escapeHtml(st.statusText)}</span>`;
    else if (st.status === 'done') status = `<span style="color:#0ca581;font-weight:700">&#10003; Done</span>`;
    const click = st.action === 'next' ? `window.calGoToStep(${nextStep})`
        : st.action === 'cancel' ? 'window.calAbort()'
        : runOnclick;
    return `
        <div class="text-center text-[22px] flex items-center justify-center px-[20px] w-full" style="min-height:36px">${status}</div>
        <button class="${st.primary ? CAL_PRIMARY_BTN : CAL_SECONDARY_BTN}" onclick="${click}" data-i18n-key="${st.label}">${st.label}</button>`;
}

// Editable reference-mass entry (step 2): label on its own line, then a
// minus / value / plus stepper (same component as the Fan Threshold setting).
// Tapping the value opens the numpad (via SETTINGS_NUMPAD_CONFIGS.calibWeightInput).
function calWeightInputBlock() {
    return `
        <div class="flex flex-col items-center" style="gap:12px">
            <p class="text-[var(--text-primary)] text-[24px]" data-i18n-key="Calibration Weight Mass:">Calibration Weight Mass:</p>
            <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0">
                <button aria-label="Decrease weight"
                        class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                        onclick="window.flashPlusMinusButton(this); window.calAdjustWeight(-1);">
                    <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <div class="text-center text-[var(--text-primary)] text-[24px] font-bold flex items-center justify-center" style="width:150px;">
                    <input type="text" inputmode="numeric" pattern="[0-9]*" id="calibWeightInput"
                           class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                           value="${calWeightG}" step="1" min="${CAL_WEIGHT_MIN_G}" max="${CAL_WEIGHT_MAX_G}"
                           onchange="window.calSetWeight(this.value)">
                    <span class="ml-2 text-nowrap text-[24px] text-[#959595]">g</span>
                </div>
                <button aria-label="Increase weight"
                        class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                        onclick="window.flashPlusMinusButton(this); window.calAdjustWeight(1);">
                    <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
            </div>
        </div>`;
}

// Read-only reference-mass display (step 3): the same mass, moved to the other
// cell — not re-entered (both points must use the same known weight).
function calWeightDisplayBlock() {
    return `
        <div class="flex flex-col items-center" style="gap:12px">
            <p class="text-[var(--text-primary)] text-[24px]" data-i18n-key="Calibration Weight Mass:">Calibration Weight Mass:</p>
            <p class="text-[var(--text-primary)] font-bold" style="font-size:30px">${calWeightG} g</p>
        </div>`;
}

export function renderLoadCellCalibration() {
    let body = '';
    if (calStep === 1) {
        body = `
            <div class="${CAL_CARD}" style="width:760px">
                <p class="${CAL_HEADING}" data-i18n-key="Zero the load cells">Zero the load cells</p>
                <p class="${CAL_BODY}" data-i18n-key="Remove the cup platform and the drip tray so the load cells are empty, then press Zero. This takes about 15 seconds (settle + average).">Remove the cup platform and the drip tray so the load cells are empty, then press Zero. This takes about 15 seconds (settle + average).</p>
                ${calActionArea({ step: 1, runLabel: 'Zero', runOnclick: 'window.calRunZero()', nextStep: 2, busyLabel: 'Zeroing&hellip; (~15s)' })}
            </div>`;
    } else if (calStep === 2) {
        body = `
            <div class="${CAL_CARD}" style="width:760px">
                <p class="${CAL_HEADING}" data-i18n-key="Calibrate the RIGHT cell">Calibrate the RIGHT cell</p>
                ${calWeightInputBlock()}
                <p class="${CAL_BODY}" data-i18n-key="Place weight on the right leg load cell.">Place weight on the right leg load cell.</p>
                ${calActionArea({ step: 2, runLabel: 'Calibrate RIGHT', runOnclick: "window.calRunPoint('first')", nextStep: 3, busyLabel: 'Calibrating&hellip; (~15s)' })}
                <button class="${CAL_SECONDARY_BTN}" onclick="window.calGoToStep(1)" ${calBusy ? 'disabled' : ''} data-i18n-key="Back">Back</button>
            </div>`;
    } else if (calStep === 3) {
        body = `
            <div class="${CAL_CARD}" style="width:760px">
                <p class="${CAL_HEADING}" data-i18n-key="Calibrate the LEFT cell">Calibrate the LEFT cell</p>
                ${calWeightDisplayBlock()}
                <p class="${CAL_BODY}" data-i18n-key="Place weight on the left leg load cell.">Place weight on the left leg load cell.</p>
                ${calActionArea({ step: 3, runLabel: 'Calibrate LEFT', runOnclick: "window.calRunPoint('second')", nextStep: 4, busyLabel: 'Calibrating&hellip; (~15s)' })}
                <button class="${CAL_SECONDARY_BTN}" onclick="window.calGoToStep(2)" ${calBusy ? 'disabled' : ''} data-i18n-key="Back">Back</button>
            </div>`;
    } else {
        body = `
            <div class="${CAL_CARD}" style="width:760px">
                <p class="${CAL_HEADING}" data-i18n-key="Check the calibration">Check the calibration</p>
                <p class="${CAL_BODY}" data-i18n-key="Put the drip tray and platform back on, press Tare, then place your weight and check the reading.">Put the drip tray and platform back on, press Tare, then place your weight and check the reading.</p>
                <button class="${CAL_SECONDARY_BTN}" onclick="window.calTare()" data-i18n-key="Tare">Tare</button>
                <div class="flex flex-col items-center" style="gap:6px">
                    <span id="calib-live-weight" class="text-[var(--text-primary)] font-bold leading-none" style="font-size:64px">&ndash;</span>
                    <span class="text-[#959595] text-[22px]">Expected: ${calWeightG} g</span>
                </div>
                <div class="flex gap-[20px] flex-wrap justify-center">
                    <button class="${CAL_PRIMARY_BTN}" onclick="window.calFinish()" data-i18n-key="Looks good — Finish">Looks good &mdash; Finish</button>
                    <button class="${CAL_SECONDARY_BTN}" onclick="window.calRetry()" data-i18n-key="Retry calibration">Retry calibration</button>
                </div>
            </div>`;
    }

    return `
        <div class="content-stretch flex flex-col gap-[30px] items-center relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]" data-i18n-key="Load Cell Calibration">Load Cell Calibration</p>
            </div>
            ${calStepIndicator()}
            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="content-stretch flex flex-col items-center relative w-full">
                ${body}
            </div>
            ${calStep < 4 ? `<button class="${CAL_SECONDARY_BTN}" onclick="window.calStartOver()" ${calBusy ? 'disabled' : ''} data-i18n-key="Start over">Start over</button>` : ''}
        </div>`;
}

// Render calibration settings with additional subcategories
export function renderCalibFanSettings(settings) {
    const fanValue = settings?.fan !== undefined ? settings.fan : 40;
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Fan Threshold Settings">Fan Threshold Settings</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[20px] items-center px-[60px] py-[20px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]" data-i18n-key="Fan Threshold">
                            Fan Threshold
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="calib-fan-minus" aria-label="Decrease fan threshold"
                                class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFanThreshold(-1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="calibFanInput"
                                   class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${fanValue}" step="1" min="0" max="100"
                                   onchange="window.updateDe1Setting('fan', parseInt(this.value))">
                            <span class="ml-2 text-nowrap">°C</span>
                        </div>
                        <button id="calib-fan-plus" aria-label="Increase fan threshold"
                                class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustFanThreshold(1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center" data-i18n-key="Temperature threshold at which the fan turns on (0–100°C)">
                        Temperature threshold at which the fan turns on (0–100°C)
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderCalibDefaultLoadSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]">${getTranslation('Default Load Settings')}</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">${getTranslation('Default Load Settings')}</p>
                        </div>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="window.resetDe1Settings()" data-i18n-key="Reset">
                            Reset
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Restores fan threshold, idle temperature, heater warmup and test flow rates, heater test time-out, refill kit mode, flow multiplier, and steam purge to factory defaults.">
                        Restores fan threshold, idle temperature, heater warmup and test flow rates, heater test time-out, refill kit mode, flow multiplier, and steam purge to factory defaults.
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderCalibRefillKitSettings() {
    const current = settingsCache.de1Advanced?.refillKitSetting ?? -1;
    const options = [
        { label: 'Auto-Detect', value: 2 },
        { label: 'Force On',    value: 1 },
        { label: 'Force Off',   value: 0 },
    ];
    const buttons = options.map(o => {
        const active = current === o.value;
        return `<button class="h-[72px] px-[36px] rounded-[72px] text-[24px] font-bold ${active ? 'bg-[#385a92] text-white' : 'bg-[var(--box-color)] border-2 border-[#385a92] text-[var(--text-primary)]'}"
                        onclick="window.updateDe1AdvancedSetting('refillKitSetting', ${o.value})" data-i18n-key="${o.label}">${o.label}</button>`;
    }).join('');
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Refill Kit">Refill Kit</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Refill Kit">Refill Kit</p>
                        </div>
                        <div class="flex items-center gap-[12px]">${buttons}</div>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Auto lets the machine decide. Force On keeps the refill kit always active. Force Off disables it.">
                        Auto lets the machine decide. Force On keeps the refill kit always active. Force Off disables it.
                    </p>
                </div>
            </div>
        </div>
    `;
}

export function renderCalibVoltageSettings() {
    const raw = settingsCache.de1Advanced?.heaterVoltage ?? -1;
    const current = raw > 1000 ? raw - 1000 : raw;
    const options = [
        { label: '110V', value: 120 },
        { label: '220V', value: 230 },
    ];
    const buttons = options.map(o => {
        const active = current === o.value;
        return `<button class="h-[72px] px-[48px] rounded-[72px] text-[24px] font-bold ${active ? 'bg-[#385a92] text-white' : 'bg-[var(--box-color)] border-2 border-[#385a92] text-[#385a92]'}"
                        onclick="window.updateHeaterVoltage(${o.value})">${o.label}</button>`;
    }).join('');
    const unsetNote = current === -1 ? `<p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-secondary)] text-[22px] w-full">No voltage set yet — select your mains voltage.</p>` : '';
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Voltage">Voltage</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Voltage">Voltage</p>
                        </div>
                        <div class="flex items-center gap-[12px]">${buttons}</div>
                    </div>
                    ${unsetNote}
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Set to match your local mains voltage. Incorrect setting may affect heater performance.">
                        Set to match your local mains voltage. Incorrect setting may affect heater performance.
                    </p>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-secondary)] text-[22px] w-full" data-i18n-key="Restart the machine after changing voltage for the setting to take effect.">
                        Restart the machine after changing voltage for the setting to take effect.
                    </p>
                </div>
            </div>
        </div>
    `;
}


export function renderCalibSteamSettings() {
    const targetTemp = settingsCache.workflow?.steamSettings?.targetTemperature ?? 155;
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Steam temperature">Steam temperature</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col items-center relative w-full">
                <div class="border border-[#c9c9c9] border-solid content-stretch flex flex-col gap-[20px] items-center px-[60px] py-[20px] relative shrink-0 w-[590px]">
                    <div class="content-stretch flex items-center relative shrink-0">
                        <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] not-italic relative shrink-0 text-[var(--text-primary)] text-[30px]" data-i18n-key="Steam temperature">
                            Steam temperature
                        </p>
                    </div>
                    <div class="content-stretch flex gap-[20px] h-[72px] items-center justify-center relative shrink-0 w-full">
                        <button id="steam-temp-minus" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustSteamCalibTemp(-1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none flex items-center justify-center"
                             style="width: 130px;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" id="steamCalibTempInput" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full"
                                   value="${tempInputValue(targetTemp)}"
                                   step="1" min="${tempInputValue(135)}" max="${tempInputValue(170)}"
                                   onchange="window.updateSteamSetting('targetTemperature', Math.round(window.tempInputToCelsius(this.value)))">
                            <span class="ml-2 text-nowrap">${tempUnitLabel()}</span>
                        </div>
                        <button id="steam-temp-plus" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center"
                                onclick="window.flashPlusMinusButton(this); window.adjustSteamCalibTemp(1);">
                            <svg width="36" height="36" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full text-center" data-i18n-key="Set steam temperature (135-170°C)">
                        Set steam temperature (135-170°C)
                    </p>
                </div>
            </div>
        </div>
    `;
}

// ── DE1 sensor calibration (temperature / pressure / flow) ──────────────────
// Decaid: GET|PUT /api/v1/machine/calibration/{target}, de1app's calibration
// page. A write is a CORRECTION, not a set (the firmware folds it into the
// value it already holds — see sensor-cal.js), so every leg here is
// read -> preview -> write -> re-read, and a successful write clears the two
// inputs: they are one observation, and re-sending them corrects twice.
let sensorCal = {};             // target id -> {current, previous, captured, capturedAt, samples, measured, busy, error}
let sensorCalLoading = false;   // the initial three-target read is in flight
let sensorCalLoaded = false;    // ponytail: read once per session, refreshed
                                // after each write. Re-read on reconnect if
                                // anyone ever calibrates across a swap.
let sensorCalLoadError = '';
// Re-armed every time the page is left, so the danger warning is shown once
// per visit rather than once per session: a bad write here can leave the
// machine unusable.
let sensorCalWarningAck = false;
// Separate from sensorCalWarningAck: this page re-renders on every
// keystroke, capture, apply/restore, and the initial calibration load
// completing -- each render rebuilds the <dialog> from scratch (closed), so
// gating on "acknowledged?" alone reopened the modal on every one of those
// renders until Ok was clicked. "shown" gates opening; "ack" is still
// tracked for callers that care whether the user actually clicked through.
let sensorCalWarningShown = false;

// ─── sensor-cal warning visit policy ────────────────────────────────────────
// Pure state transition, DOM-free on purpose: test/sensor-cal-warning.test.mjs
// slices this block straight out of the source (see that file's header) so
// coverage can't silently drift from what actually ships in this legacy file.
// Events: 'render' (page mount or any later re-render), 'ack' (Ok clicked),
// 'leave' (navigated to a different settings category).
function sensorCalWarningNextState(state, event) {
    switch (event) {
        case 'render':
            return state.shown
                ? { state, open: false }
                : { state: { shown: true, ack: state.ack }, open: true };
        case 'ack':
            return { state: { shown: state.shown, ack: true }, open: false };
        case 'leave':
            return { state: { shown: false, ack: false }, open: false };
        default:
            return { state, open: false };
    }
}
// ─── end sensor-cal warning visit policy ───────────────────────────────────

// ─── sensor-cal warning reopen-after-interruption policy ───────────────────
// Whether THIS render should (re)open the dialog, combining what
// sensorCalWarningNextState('render') decided (`open`: true only for the
// very first render of a visit) with whether the dialog that render is about
// to destroy was actually showing when the render started (`wasOpen`, read
// straight from the browser -- see updateSettingsContentArea, which captures
// it before contentArea.innerHTML tears the old <dialog> down).
//
// `wasOpen` can only be true for a render NOT caused by the user: showModal()
// makes the rest of the page inert, so nothing the user does inside
// calib_sensors (a keystroke, Capture, Apply, Restore -- all of which call
// sensorCalRerender()) can happen while the dialog is genuinely open. Only an
// UNRELATED render landing mid-flight (a background settings refresh, a
// language change, the calibration read itself completing) can interrupt it.
// So this reopens exactly the interrupted showing, resumed on the fresh node
// within the same task -- one continuous appearance, not a second one -- and
// never reopens a dialog the user already dismissed (Ok, Cancel navigating
// away, or Escape all leave the node's own .open false, so wasOpen is false
// on the next render regardless of `shown`/`ack`).
function sensorCalWarningShouldReopen(open, wasOpen) {
    return open || wasOpen;
}
// ─── end sensor-cal warning reopen-after-interruption policy ──────────────

function sensorCalRerender() {
    updateSettingsContentArea('calib_sensors');
}

function sensorCalEntry(id) {
    if (!sensorCal[id]) {
        sensorCal[id] = {
            current: null, previous: null, captured: null, capturedAt: 0,
            samples: [], measured: '', busy: false, error: '',
        };
    }
    return sensorCal[id];
}

// Temperatures are entered in the display unit; the firmware works in °C.
// The STORED value is an offset, and an offset converts by scale, not by the
// absolute conversion boundToDisplay() does — so it is always shown in °C
// with the unit spelled out, rather than converted subtly wrong.
function sensorCalToCelsius(id, value) {
    return id === 'temperature' ? fromDisplayTemp(value) : value;
}

// The machine's factory baseline is deliberately NOT read here. Decaid's
// ?source=factory answers with the CURRENT calibration on this firmware
// (v1357): the request and the response filter are byte-identical to
// de1app's, and a mismatched command would time out rather than return, so
// what comes back is a command-3-tagged packet carrying current data. A
// column fed by that is a duplicate of Saved wearing a different name.
//
// The undo value is ours instead: whatever the calibration was immediately
// before the last write made from this page, kept in IndexedDB so it
// survives a reload. It cannot know about changes made from de1app or
// another skin -- hence "Previous", not "Factory".
const SENSOR_CAL_PREV_KEY = (id) => `sensorCalPrevious:${id}`;

async function sensorCalRead(id) {
    const entry = sensorCalEntry(id);
    const current = await getSensorCalibration(id, 'current');
    entry.current = current?.measuredValue ?? null;
}

async function sensorCalLoadPrevious(id) {
    const entry = sensorCalEntry(id);
    try {
        const stored = await getSetting(SENSOR_CAL_PREV_KEY(id));
        entry.previous = Number.isFinite(stored) ? stored : null;
    } catch (error) {
        // A missing store is not worth failing the page over -- it only
        // costs the undo button.
        logger.warn(`No stored previous calibration for ${id}:`, error);
        entry.previous = null;
    }
}

async function sensorCalRememberPrevious(id, value) {
    const entry = sensorCalEntry(id);
    entry.previous = Number.isFinite(value) ? value : null;
    try {
        await setSetting(SENSOR_CAL_PREV_KEY(id), entry.previous);
    } catch (error) {
        logger.warn(`Could not store previous calibration for ${id}:`, error);
    }
}

// ── sensor-cal load re-entry policy (pure) ──────────────────────────────────
// initSensorCal runs from the render path, and its own `finally` re-renders —
// so every flag that means "do not start another read" has to be checked here
// or the read loops. `error` is the one that used to be missing: a failure
// recorded the message, re-rendered, and started another read, so a machine
// answering /machine/calibration with a 504 produced one failed read per
// gateway timeout (~12 s) for as long as the page stayed open. A failure now
// stops until the Retry button (or leaving the page) clears the error.
function shouldStartSensorCalLoad({ loaded, loading, error }) {
    return !loaded && !loading && !error;
}
// ── end sensor-cal load re-entry policy ─────────────────────────────────────

async function initSensorCal() {
    // The live column is fed by the snapshot socket, which nobody has opened
    // if the app booted straight onto this page (a reload while in Settings).
    ensureMachineSnapshotSocket();
    sensorCalStartLive();
    if (!shouldStartSensorCalLoad({ loaded: sensorCalLoaded, loading: sensorCalLoading, error: sensorCalLoadError })) return;
    sensorCalLoading = true;
    sensorCalLoadError = '';
    // Paint the "Reading calibration…" state before awaiting the read below --
    // without this, sensorCalLoading flips true and back to false around the
    // await with no render in between (the only rerender was in `finally`),
    // so the page silently sat on its stale first paint (an empty table) for
    // however long the read took, then jumped straight to the result. Safe
    // against the render this itself causes re-entering: that render's own
    // setTimeout(initSensorCal, 0) sees loading=true and returns immediately.
    sensorCalRerender();
    try {
        await Promise.all(SENSOR_CAL_TARGETS.flatMap((t) => [
            sensorCalRead(t.id),
            sensorCalLoadPrevious(t.id),
        ]));
        sensorCalLoaded = true;
    } catch (error) {
        logger.error('Failed to read sensor calibration:', error);
        sensorCalLoadError = error.message;
    } finally {
        sensorCalLoading = false;
        sensorCalRerender();
    }
}

// Re-render the Sensor Calibration page ONLY if it is what's actually on
// screen right now. sensorCalRerender() (used above) is safe to call
// unconditionally because it only ever runs from within calib_sensors's own
// render path -- but warmSensorCalibration() below is kicked off as soon as
// Settings is reached and can finish well after that, by which point the
// user may be on a completely different settings category, or have left
// Settings altogether. activeSettingsCategory alone isn't a safe enough
// signal for that: it is legacy settings.js module state that persists
// across page visits and can be stale. The dialog's own id only exists in
// the DOM while renderSensorCalSettings() is the last thing painted into
// #settings-content-area, so its presence is the truth.
function sensorCalRerenderIfVisible() {
    if (document.getElementById('sensor-cal-warning-modal')) sensorCalRerender();
}

// Warms the calibration read in the background as soon as Settings is
// reached, rather than waiting for the user to open Sensor Calibration --
// so the table usually has values the moment they get there instead of a
// loading flash (or, on a struggling machine, the read having barely
// started). Deliberately narrow: reuses shouldStartSensorCalLoad, the SAME
// re-entry gate initSensorCal already has, so this can never race a read
// initSensorCal has already started (or vice versa) -- there is exactly one
// gate for "is a read in flight", not two. No socket, no live timer, no
// render-on-start: nothing is on screen yet to feed or animate, and those
// are initSensorCal's job for when the page actually mounts.
//
// A failed warm attempt is logged and then left exactly as if it never ran
// (loading/loaded/error all reset to their starting values) rather than
// recorded as sensorCalLoadError -- it must not spend the page's one real
// attempt on a failure the user never saw, and must not leave the page
// showing a stale error with nothing in flight the moment they do open it.
export async function warmSensorCalibration() {
    if (!shouldStartSensorCalLoad({ loaded: sensorCalLoaded, loading: sensorCalLoading, error: sensorCalLoadError })) return;
    sensorCalLoading = true;
    try {
        await Promise.all(SENSOR_CAL_TARGETS.flatMap((t) => [
            sensorCalRead(t.id),
            sensorCalLoadPrevious(t.id),
        ]));
        sensorCalLoaded = true;
    } catch (error) {
        logger.warn('Background sensor calibration warm-up failed (the page will try again when opened):', error);
    } finally {
        sensorCalLoading = false;
        // Covers the narrow window where the user opened the page while this
        // warm attempt was still in flight: initSensorCal's own call saw
        // loading=true and returned without a render, so this is the only
        // thing that will paint the result now that it's done.
        sensorCalRerenderIfVisible();
    }
}

const SENSOR_CAL_INPUT = "text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border border-[#c9c9c9] rounded-[10px] h-[60px] w-[130px]";
const SENSOR_CAL_SMALL_BTN = "h-[56px] px-[28px] rounded-[56px] text-[22px] font-bold";

// The live "DE1 reads" column, repainted off the snapshot socket's last
// frame while this page is open, and the rolling sample window a capture
// averages. This is the sensor's OWN reading — the de1ReportedValue half of
// every correction — so the user only types what their instrument said.
let sensorCalLiveTimer = null;

function sensorCalLiveReading(target) {
    return snapshotReading(target, getLastMachineSnapshot());
}

function sensorCalReadingText(target, value) {
    if (value === null || value === undefined) return '—';
    const shown = target.id === 'temperature' ? tempInputValue(value) : value;
    const unit = target.id === 'temperature' ? tempUnitLabel() : target.unit;
    return `${Number(shown).toFixed(target.kind === 'offset' ? 1 : 2)} ${unit}`;
}

// Every tick feeds the sample window and repaints the live cell. A captured
// row keeps its own number on screen — that is the pair being written.
function sensorCalPaintLive() {
    const now = Date.now();
    SENSOR_CAL_TARGETS.forEach((target) => {
        const entry = sensorCalEntry(target.id);
        const reading = sensorCalLiveReading(target);
        if (reading !== null) {
            entry.samples.push({ value: reading, at: now });
            entry.samples = entry.samples.filter((sample) => now - sample.at <= SENSOR_CAL_SAMPLE_WINDOW_MS);
        }
        const el = document.getElementById(`sensor-cal-live-${target.id}`);
        if (el) el.textContent = sensorCalReadingText(target, reading);
    });
}

function sensorCalStartLive() {
    if (sensorCalLiveTimer) return;
    sensorCalLiveTimer = setInterval(sensorCalPaintLive, 1000);
}

function sensorCalStopLive() {
    if (!sensorCalLiveTimer) return;
    clearInterval(sensorCalLiveTimer);
    sensorCalLiveTimer = null;
}

function sensorCalRow(target) {
    const entry = sensorCalEntry(target.id);
    const stored = Number.isFinite(entry.current);
    // The captured reading is the de1ReportedValue half. It is taken while
    // the machine runs, never read at Apply time — by then the user has
    // walked back to Settings and the machine reports nothing.
    const captured = entry.captured;
    const live = sensorCalLiveReading(target);
    const measured = parseSensorCalInput(entry.measured);
    const unit = target.id === 'temperature' ? tempUnitLabel() : target.unit;
    const canCapture = live !== null && !entry.busy;
    const filled = stored && captured !== null && measured !== null && !entry.busy;
    const blocked = filled
        ? correctionBlocked(target.kind, captured, sensorCalToCelsius(target.id, measured))
        : '';
    const preview = filled && !blocked
        ? previewCalibration(target.kind, entry.current, captured, sensorCalToCelsius(target.id, measured))
        : null;
    const ready = filled && !blocked && Number.isFinite(preview);
    const suffix = target.kind === 'offset' ? ' °C' : '';
    // Floats never come back bit-identical from the machine, so an exact
    // comparison would leave Restore lit on a value already restored.
    const canRestore = stored && Number.isFinite(entry.previous) && !entry.busy
        && Math.abs(entry.current - entry.previous) > 1e-6;

    // Default is blank, not guidance: the row shows only what is happening
    // right now. The cell keeps a min-height so rows do not jump as this
    // fills and empties.
    let status = '&nbsp;';
    if (entry.error) status = `<span class="text-red-500">${escapeHtml(entry.error)}</span>`;
    else if (blocked) status = `<span class="text-red-500" data-i18n-key="${blocked}">${escapeHtml(blocked)}</span>`;
    else if (entry.busy) status = `<span style="color:#959595" data-i18n-key="Writing…">Writing…</span>`;
    else if (Number.isFinite(preview)) {
        status = `<span style="color:#0ca581;font-weight:700">${formatCalValue(target.kind, entry.current)}${suffix} &rarr; ${formatCalValue(target.kind, preview)}${suffix}</span>`;
    } else if (captured !== null) {
        status = `<span class="text-[var(--text-secondary)]" data-i18n-key="Captured. Now enter what your instrument measured.">Captured. Now enter what your instrument measured.</span>`;
    } else if (live === null) {
        status = `<span class="text-[var(--text-secondary)]" data-i18n-key="Waiting for a reading from the machine…">Waiting for a reading from the machine…</span>`;
    }

    return `
        <tr class="border-t border-[#c9c9c9]">
            <td class="py-[20px] pr-[20px] align-middle">
                <p class="text-[28px] font-bold text-[var(--text-primary)]" data-i18n-key="${target.label}">${target.label}</p>
            </td>
            <td class="py-[20px] px-[10px] text-center align-middle">
                <p class="text-[24px] font-bold text-[var(--text-primary)]">${formatCalValue(target.kind, entry.current)}${suffix}</p>
            </td>
            <td class="py-[20px] px-[10px] text-center align-middle">
                <p class="text-[24px] text-[var(--text-secondary)]">${formatCalValue(target.kind, entry.previous)}${suffix}</p>
            </td>
            <td class="py-[20px] px-[10px] text-center align-middle">
                <p id="sensor-cal-live-${target.id}" class="text-[24px] text-[var(--text-secondary)]">${sensorCalReadingText(target, live)}</p>
                ${captured !== null ? `<p class="text-[24px] font-bold text-[var(--text-primary)]">${sensorCalReadingText(target, captured)}</p>` : ''}
                <button class="${SENSOR_CAL_SMALL_BTN} mt-[10px] bg-[var(--box-color)] border-2 border-[#385a92] text-[var(--text-primary)] ${canCapture ? '' : 'opacity-40'}" ${canCapture ? '' : 'disabled'}
                        onclick="window.sensorCalCapture('${target.id}')" data-i18n-key="Capture">Capture</button>
            </td>
            <td class="py-[20px] px-[10px] align-middle">
                <div class="flex items-center justify-center">
                    <input type="text" inputmode="decimal" id="sensor-cal-${target.id}-measured"
                           class="${SENSOR_CAL_INPUT}"
                           value="${escapeHtml(entry.measured)}"
                           onchange="window.sensorCalInput('${target.id}', this.value)">
                    <span class="ml-2 text-nowrap text-[22px] ">${unit}</span>
                </div>
            </td>
            <td class="py-[20px] pl-[10px] align-middle">
                <div class="flex flex-col items-stretch" style="gap:10px">
                    <button class="${SENSOR_CAL_SMALL_BTN} bg-[#385a92] text-white ${ready ? '' : 'opacity-40'}" ${ready ? '' : 'disabled'}
                            onclick="window.sensorCalApply('${target.id}')" data-i18n-key="Apply">Apply</button>
                    <button class="${SENSOR_CAL_SMALL_BTN} bg-[var(--box-color)] border-2 border-[#385a92] text-[var(--text-primary)] ${canRestore ? '' : 'opacity-40'}" ${canRestore ? '' : 'disabled'}
                            onclick="window.sensorCalRestorePrevious('${target.id}')" data-i18n-key="Restore">Restore</button>
                </div>
            </td>
        </tr>
        <tr>
            <td colspan="6" class="pb-[20px] text-[22px] leading-[1.4]" style="min-height:32px">${status}</td>
        </tr>`;
}

// Opening is guarded on .open: the dialog is re-rendered with the page, and
// showModal() on an already-open dialog throws InvalidStateError.
function sensorCalShowWarning() {
    const dlg = document.getElementById('sensor-cal-warning-modal');
    if (dlg && !dlg.open) dlg.showModal();
}

function sensorCalWarningModal() {
    return `
            <dialog id="sensor-cal-warning-modal" class="modal">
                <div class="modal-box bg-[var(--box-color)] max-w-2xl">
                    <h3 class="font-bold text-[28px] text-[var(--text-primary)] mb-2" data-i18n-key="Sensor Calibration">Sensor Calibration</h3>
                    <p class="text-[24px] text-[var(--text-primary)] leading-[1.4] break-words" data-i18n-key="Bad calibration settings might make your espresso machine unuseable.  Only proceed if you have been told to or have read the relevant manual sections and know what you are doing.">Bad calibration settings might make your espresso machine unuseable.  Only proceed if you have been told to or have read the relevant manual sections and know what you are doing.</p>
                    <div class="modal-action">
                        <button class="border-[var(--mimoja-blue)] text-[var(--mimoja-blue)] h-[62px] rounded-[67.5px] border px-[32px] text-[24px] font-bold transition-colors duration-200 hover:bg-[var(--mimoja-blue)] hover:text-white"
                                onclick="window.sensorCalWarningCancel()" data-i18n-key="Cancel">
                            Cancel
                        </button>
                        <button class="bg-[#385a92] h-[62px] px-[32px] rounded-[67.5px] text-white text-[24px] font-bold"
                                onclick="window.sensorCalWarningProceed()" data-i18n-key="Ok">
                            Ok
                        </button>
                    </div>
                </div>
            </dialog>`;
}

export function renderSensorCalSettings() {
    let body;
    if (sensorCalLoading) {
        body = `<p class="${CAL_BODY}" data-i18n-key="Reading calibration from the machine…">Reading calibration from the machine…</p>`;
    } else if (sensorCalLoadError) {
        // The read no longer retries on its own, so the error has to offer the
        // way back — otherwise a transient 504 stranded the page until the user
        // navigated away and returned. Lead with something a user can act on
        // rather than the raw status line (logged in full via logger.error in
        // initSensorCal's catch, for anyone who needs the technical detail).
        body = `<p class="${CAL_BODY} text-red-500" data-i18n-key="Couldn't read calibration from the machine. Check the connection and try again.">Couldn't read calibration from the machine. Check the connection and try again.</p>
            <button onclick="window.sensorCalRetryLoad()"
                    class="${SENSOR_CAL_SMALL_BTN} mt-[16px] bg-[var(--button-primary-bg)] text-white"
                    data-i18n-key="Retry">Retry</button>`;
    } else {
        body = `
            <div class="w-full" style="overflow-x:auto">
                <table class="w-full">
                    <thead>
                        <tr class="text-[22px] text-[var(--text-secondary)] text-left">
                            <th class="pb-[10px] font-normal" data-i18n-key="Sensor">Sensor</th>
                            <th class="pb-[10px] font-normal text-center" data-i18n-key="Saved">Saved</th>
                            <th class="pb-[10px] font-normal text-center" data-i18n-key="Previous">Previous</th>
                            <th class="pb-[10px] font-normal text-center" data-i18n-key="DE1 Reading">DE1 Reading</th>
                            <th class="pb-[10px] font-normal text-center" data-i18n-key="Measured">Measured</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>${SENSOR_CAL_TARGETS.map(sensorCalRow).join('')}</tbody>
                </table>
            </div>`;
    }
    return `
        <div class="content-stretch flex flex-col gap-[40px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Sensor Calibration">Sensor Calibration</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="w-full">${body}</div>
            ${sensorCalWarningModal()}
        </div>
    `;
}


// ── Skin update check ────────────────────────────────────────────────────────
// For every bundled skin installed from a GitHub release, "Update available"
// compares the installed version the bridge reports (GET /api/v1/webui/skins ->
// s.version) against the latest release tag of that skin's own repo. Older
// installed version => update available. Skins not installed from a GitHub release
// have no signal and show "Up to date". APP_VERSION is NOT used here — it is a
// hardcoded build marker shown only so dist/preview users know which build runs.

function compareVersions(a, b) {
    const parse = (v) => {
        const [core, pre] = String(v || '').trim().replace(/^v/i, '').split('-');
        return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
    };
    const pa = parse(a), pb = parse(b);
    const len = Math.max(pa.nums.length, pb.nums.length);
    for (let i = 0; i < len; i++) {
        const d = (pa.nums[i] || 0) - (pb.nums[i] || 0);
        if (d !== 0) return d < 0 ? -1 : 1;
    }
    // Equal core: a release outranks a prerelease (1.0.0 > 1.0.0-beta.1).
    if (pa.pre && !pb.pre) return -1;
    if (!pa.pre && pb.pre) return 1;
    if (pa.pre && pb.pre) {
        const c = pa.pre.localeCompare(pb.pre, undefined, { numeric: true });
        return c < 0 ? -1 : c > 0 ? 1 : 0;
    }
    return 0;
}

// owner/repo for a skin from the bridge's install metadata, or null when it wasn't
// installed from a GitHub release. Our own skin falls back to the canonical repo so
// it stays checkable even if its metadata is missing.
function skinRepoSlug(s) {
    const m = (s?.reaMetadata?.sourceUrl || '').match(/github_release:([^@\s]+)/i);
    if (m) return m[1];
    if (s?.id === SKIN_ID) return 'decentespresso/streamline-js';
    return null;
}

// Fetch each repo's latest release tag once per settings session (deduped by repo),
// then re-render. Non-fatal per repo: offline / rate-limited / no releases leaves
// that skin at "Up to date".
function maybeCheckLatestRelease(slug, categories) {
    const cache = settingsCache.latestReleases || (settingsCache.latestReleases = {});
    const inFlight = settingsCache.releaseInFlight || (settingsCache.releaseInFlight = new Set());
    if (!slug || slug in cache || inFlight.has(slug)) return;
    inFlight.add(slug);
    fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
    })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { cache[slug] = data?.tag_name?.trim() || null; })
        .catch(() => { cache[slug] = null; })
        .finally(() => {
            inFlight.delete(slug);
            // A page can be reached under more than one category id — re-render
            // whichever is active so the freshly-fetched release tag is shown.
            if (categories.includes(activeSettingsCategory)) {
                updateSettingsContentArea(activeSettingsCategory);
            }
        });
}

function maybeCheckLatestReleases() {
    const slugs = new Set((settingsCache.allSkins || []).map(skinRepoSlug).filter(Boolean));
    for (const slug of slugs) maybeCheckLatestRelease(slug, ['skin', 'appearance']);
}

// Decaid's own repo. Its release tags ('v0.8.4') are compared against the running
// build with the same compareVersions used for skins, which strips the leading 'v'.
const DECAID_REPO = 'decentespresso/decaid';
const DECAID_RELEASES_URL = 'https://github.com/decentespresso/decaid/releases';

// English gets the shorter, current phrasing directly; every other language
// still reads from the existing "Check for current skin updates" translation
// key so its already-translated copy keeps working untouched.
function skinUpdateCheckText() {
    return getCurrentLanguage() === 'en' ? 'Check for skin updates' : getTranslation('Check for current skin updates');
}

// Render theme settings
export function renderThemeSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Theme Settings">Theme Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Theme">Theme</p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="theme-toggle" class="sr-only peer">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full pr-[220px]" data-i18n-key="Toggle between light and dark themes">
                        Toggle between light and dark themes
                    </p>
                </div>
            </div>
        </div>
    `;
}

// Render skin settings
export function renderSkinSettings() {
    const activeSkin = settingsCache.skinInfo;
    const allSkins = settingsCache.allSkins || [];
    const activeSkinId = activeSkin?.id || '';

    maybeCheckLatestReleases();

    // Per-skin update badge: each skin installed from a GitHub release is compared
    // against the latest release tag of its own repo. Skins without a GitHub-release
    // source (or whose release we couldn't fetch) show "Up to date".
    const releases = settingsCache.latestReleases || {};
    const skinBadge = (s, isActive) => {
        const slug = skinRepoSlug(s);
        const latest = slug ? releases[slug] : null;
        const needsUpdate = !!latest && !!s.version && compareVersions(s.version, latest) < 0;
        const base = 'text-[16px] font-semibold px-[8px] py-[2px] rounded-full';
        if (isActive) return needsUpdate
            ? `<span class="${base} bg-white/20 text-white" data-i18n-key="Update available">Update available</span>`
            : `<span class="${base} bg-white/20 text-white" data-i18n-key="Up to date">Up to date</span>`;
        return needsUpdate
            ? `<span class="${base} bg-[#da515e]/15 text-[#da515e]" data-i18n-key="Update available">Update available</span>`
            : `<span class="${base} bg-[#0ca581]/15 text-[#0ca581]" data-i18n-key="Up to date">Up to date</span>`;
    };

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Active Skin">Active Skin</p>
            </div>

            <div class="content-stretch flex flex-col gap-[24px] items-start relative w-full">
                <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[22px] w-full" data-i18n-key="Tap a skin to make it active.">
                    Tap a skin to make it active.
                </p>
                <div class="grid grid-cols-2 gap-[14px] w-full">
                    ${(allSkins.length > 0 ? allSkins : (activeSkin ? [activeSkin] : [])).map(s => {
                        const isActive = s.id === activeSkinId;
                        // Prefer the version the bridge reports (the actually-installed
                        // release, which tracks GitHub) so the card matches the update
                        // badge. Fall back to the hardcoded build marker only when the
                        // bridge reports no version for our skin (dist/preview builds).
                        const displayVersion = s.version || (s.id === SKIN_ID ? APP_VERSION : '');
                        return `
                        <button
                            onclick="${isActive ? '' : `window.setActiveSkin('${s.id}')`}"
                            aria-pressed="${isActive}"
                            ${isActive ? 'disabled' : ''}
                            class="relative flex flex-col items-start justify-between gap-[10px] px-[22px] py-[18px] rounded-[14px] border-2 text-left transition-colors duration-150
                                ${isActive
                                    ? 'bg-[#385a92] border-[#385a92] text-white cursor-default'
                                    : 'bg-[var(--box-color)] border-[var(--profile-button-outline-color)] text-[var(--text-primary)] cursor-pointer hover:border-[#385a92]'}">
                            <div class="flex items-start justify-between w-full gap-2">
                                <span class="font-['Inter:Bold',sans-serif] font-bold text-[24px] leading-tight">${getTranslation(s.i18nKey || s.name)}</span>
                                ${isActive ? `<span class="text-[14px] font-bold tracking-widest uppercase px-[10px] py-[4px] rounded-full bg-white bg-opacity-20 text-white shrink-0" data-i18n-key="Active">Active</span>` : ''}
                            </div>
                            <div class="flex items-center gap-[10px]">
                                ${displayVersion ? `<span class="text-[17px] font-['Inter:Regular',sans-serif] opacity-80">v${displayVersion}</span>` : ''}
                                ${skinBadge(s, isActive)}
                                <span class="text-[14px] font-['Inter:Regular',sans-serif] opacity-60 uppercase tracking-wider">${s.isBundled ? 'Bundled' : 'Installed'}</span>
                            </div>
                        </button>`;
                    }).join('')}
                </div>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]">${skinUpdateCheckText()}</p>
                        </div>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="window.updateSkin()" data-i18n-key="Check">
                            Check
                        </button>
                    </div>
                </div>
            </div>

        </div>
    `;
}

// Render language settings with additional subcategories
export function renderLanguageSettings() {
    setTimeout(() => {
        const switcher = document.getElementById('language-switcher');
        if (!switcher) return;

        const supported = getSupportedLanguages();
        const current = getCurrentLanguage();

        switcher.innerHTML = '';
        supported.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            try {
                option.textContent = new Intl.DisplayNames([lang], { type: 'language' }).of(lang);
            } catch {
                option.textContent = lang;
            }
            if (lang === current) {
                option.selected = true;
            }
            switcher.appendChild(option);
        });

        switcher.addEventListener('change', async (event) => {
            event.target.disabled = true;
            try {
                await setLanguage(event.target.value);
                event.target.value = getCurrentLanguage();
            } finally {
                event.target.disabled = false;
            }
        });
    }, 0);

    return `
        <div class="flex flex-col gap-[60px] items-start relative w-full max-w-full overflow-x-hidden">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] not-italic relative text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]" data-i18n-key="Language Settings">Language Settings</p>
            </div>
            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="flex flex-col items-start relative w-full max-w-full">
                <div class="flex flex-col gap-[30px] items-start relative w-full max-w-full">
                    <div class="flex items-center justify-between relative w-full max-w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Display Language">Display Language</p>
                        </div>
                        <select id="language-switcher" class="bg-[#385a92] border-2 border-[#385a92] border-solid h-[62.88px] rounded-[2617.374px] w-[250px] text-white text-[24px] p-2 max-w-[250px]">
                            <option data-i18n-key="Loading...">Loading...</option>
                        </select>
                    </div>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full max-w-full break-words" data-i18n-key="Choose the language for the application interface.">
                        Choose the language for the application interface.
                    </p>
                </div>
            </div>


    `;
}

// Render plugin manager — lists all installed plugins with enable/disable toggles
export function renderPluginManagerSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Plugins">Plugins</p>
            </div>

            <div id="plugin-list-container" class="flex flex-col gap-[0px] w-full">
                <div class="flex items-center justify-center w-full py-[40px]">
                    <span class="loading loading-spinner loading-lg text-[#385a92]"></span>
                </div>
            </div>
        </div>
    `;
}

// Shot Uploader — the settings UI for the bundled shot-upload.reaplugin, which
// posts finished shots to the user's Decent account at decentespresso.com.
//
// Unlike Visualizer, there are no credentials to type here: the plugin uploads
// through Decaid's account proxy, which attaches the linked Decent login in Dart
// and never exposes it. So this page gates on the account instead of collecting
// one — and linking happens in the Decent app, since the bridge exposes only a
// status read (GET /account/decent) and no login endpoint.
//
// The controls are built from the plugin's OWN manifest rather than written out
// here. GET /api/v1/plugins returns PluginManifest.toJson(), which carries the
// `settings` schema verbatim -- type, description and default
// (plugin_manifest.dart).
//
// Hand-written controls cannot track a plugin that ships on its own schedule.
// shot-upload 0.2.0 declares DrainHistory; 0.2.1 removes it, because backlog
// reconciliation follows AutoUpload now (doc/Plugins.md, and decaid's own
// "reconciliation follows AutoUpload, not old DrainHistory" test). A page with
// the switch hard-coded is wrong on exactly one of those two versions, whichever
// way it is written -- and Decaid updates underneath us, so which one that is
// changes without this file being touched. Reading the schema at runtime means
// the page shows the toggle on 0.2.0 and drops it on 0.2.1 on its own.
export function renderShotUploadSettings() {
    setTimeout(setupShotUploadListeners, 0);

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" id="shotupload-title" data-i18n-key="Shot Uploader">Shot Uploader</p>
            </div>

            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <p id="shotupload-description" class="text-[24px] text-[var(--text-primary)] leading-[1.4] opacity-75"></p>

                <!-- Account gate. One of these three is visible at a time; the controls
                     below stay disabled until the account one says linked. -->
                <div id="shotupload-account" class="w-full">
                    <div class="flex items-center justify-center w-full py-[20px]">
                        <span class="loading loading-spinner loading-lg text-[#385a92]"></span>
                    </div>
                </div>

                <!-- Filled from the manifest schema by setupShotUploadListeners. -->
                <div id="shotupload-controls" class="content-stretch flex flex-col gap-[30px] items-start relative w-full"></div>

                <div class="flex items-center gap-[14px] flex-wrap w-full">
                    <button id="shotupload-upload-now" class="bg-[#385a92] h-[56px] px-[28px] rounded-[64px] text-white text-[22px] font-bold" data-i18n-key="Upload latest shot">Upload latest shot</button>
                    <span id="shotupload-status" class="text-[20px] text-[var(--text-primary)] opacity-60"></span>
                </div>
            </div>
        </div>
    `;
}

// "AutoUpload" -> "Auto Upload". The schema names a setting but never labels it,
// so the key is split rather than a friendlier label being invented here -- an
// invented one is exactly what goes stale. The sentence the user actually reads
// is the manifest's own `description`.
export function pluginSettingLabel(key) {
    return String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim();
}

// One control per manifest setting, for the types the plugins on these pages
// declare. A type we have no control for renders nothing and is logged by the
// caller, which is the signal to add it -- guessing at widgets before a plugin
// here asks for one is how this page drifted in the first place.
//
// `idPrefix` exists because more than one page renders a plugin's schema now
// (Shot Uploader, Print The Shot); the ids have to stay distinct per page.
export function renderPluginSettingControl(key, schema, idPrefix = 'shotupload') {
    const id = `${idPrefix}-setting-${key}`;
    const label = escapeHtml(getTranslation(pluginSettingLabel(key)));
    const description = schema?.description
        ? `<p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="${escapeHtml(schema.description)}">${escapeHtml(getTranslation(schema.description))}</p>`
        : '';

    if (schema?.type === 'boolean') {
        return `
            <div class="content-stretch flex items-center justify-between relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]">${label}</p>
                    ${description}
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <input type="checkbox" id="${id}" data-setting-key="${escapeHtml(key)}" data-setting-type="boolean" class="sr-only peer">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>`;
    }

    if (schema?.type === 'number') {
        return `
            <div class="flex flex-col gap-[8px] w-full">
                <div class="flex items-center gap-4">
                    <label for="${id}" class="text-[var(--text-primary)] text-[24px]">${label}</label>
                    <input type="number" id="${id}" min="0" data-setting-key="${escapeHtml(key)}" data-setting-type="number" class="w-24 p-3 rounded-lg border border-[var(--border-color)] bg-[var(--profile-button-background-color)] text-[var(--text-primary)] text-[24px] focus:outline-none focus:ring-2 focus:ring-[var(--mimoja-blue)]">
                </div>
                ${description}
            </div>`;
    }

    // `secure` is the manifest's own flag for a value that should not be read off
    // the screen (visualizer's Password sets it) -- honour it rather than
    // rendering every string in the clear.
    if (schema?.type === 'string') {
        return `
            <div class="flex flex-col gap-[8px] w-full">
                <label for="${id}" class="text-[var(--text-primary)] text-[24px]">${label}</label>
                <input type="${schema.secure ? 'password' : 'text'}" id="${id}" data-setting-key="${escapeHtml(key)}" data-setting-type="string" class="w-full max-w-[500px] p-3 rounded-lg border border-[var(--border-color)] bg-[var(--profile-button-background-color)] text-[var(--text-primary)] text-[24px] focus:outline-none focus:ring-2 focus:ring-[var(--mimoja-blue)]">
                ${description}
            </div>`;
    }

    return '';
}

// Every control writes straight through to the plugin's settings -- there is no
// Save button because there is nothing to type. Which controls exist, and what
// they say, comes from the manifest; see renderShotUploadSettings.
function setupShotUploadListeners() {
    const PLUGIN_ID = 'shot-upload.reaplugin';
    const accountEl = document.getElementById('shotupload-account');
    const controlsEl = document.getElementById('shotupload-controls');
    if (!accountEl || !controlsEl) return;

    const uploadNowBtn = document.getElementById('shotupload-upload-now');
    const statusEl = document.getElementById('shotupload-status');

    const notice = (title, body) => `
        <div class="flex flex-col gap-[24px] p-[36px] rounded-[20px] border-2 border-dashed border-[var(--profile-button-outline-color)] bg-[var(--box-color)] items-center text-center">
            <div class="flex flex-col gap-[8px]">
                <p class="text-[26px] font-bold text-[var(--text-primary)]">${title}</p>
                <p class="text-[22px] text-[var(--low-contrast-white)] max-w-[500px] leading-[1.4]">${body}</p>
            </div>
        </div>`;

    const linkedBadge = `
        <div class="flex items-center p-[20px] rounded-[14px] bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] gap-[14px]">
            <div class="w-[40px] h-[40px] rounded-full bg-[#385a92] flex items-center justify-center text-white text-[18px] font-bold">D</div>
            <div>
                <p class="text-[20px] font-semibold text-[var(--text-primary)]" data-i18n-key="Decent account linked">Decent account linked</p>
            </div>
        </div>`;

    // Controls are disabled rather than hidden: the user can see what turning the
    // feature on will offer them before they go and link an account.
    const setControlsEnabled = (enabled) => {
        controlsEl.style.opacity = enabled ? '1' : '0.4';
        controlsEl.querySelectorAll('input').forEach(el => { el.disabled = !enabled; });
        if (uploadNowBtn) uploadNowBtn.disabled = !enabled;
    };

    const setStatus = (text) => { if (statusEl) statusEl.textContent = text || ''; };

    (async () => {
        setControlsEnabled(false);

        let account;
        try {
            account = await getDecentAccountStatus();
        } catch (e) {
            logger.warn('Decent account status unavailable:', e);
            accountEl.innerHTML = notice(
                getTranslation('Could not check'),
                getTranslation("Couldn't reach the bridge to check your Decent account."));
            return;
        }

        // getPlugins answers null when the request failed and [] when there really
        // are none, so the two cases must not collapse into "not installed" -- that
        // would tell a user with a working plugin to go update Decaid.
        const plugins = await getPlugins();
        if (!plugins) {
            accountEl.innerHTML = notice(
                getTranslation('Could not check'),
                getTranslation("Couldn't reach the bridge to check the shot upload plugin."));
            return;
        }
        const plugin = plugins.find(p => p?.id === PLUGIN_ID);
        if (!plugin) {
            accountEl.innerHTML = notice(
                getTranslation('Shot upload plugin not installed'),
                getTranslation('This feature ships with Decaid. Update Decaid to get it.'));
            return;
        }

        // The plugin names and explains itself. Both are optional on the wire, so
        // the static header stands in if either is missing.
        const titleEl = document.getElementById('shotupload-title');
        if (titleEl && plugin.name) {
            titleEl.textContent = getTranslation(plugin.name);
            titleEl.setAttribute('data-i18n-key', plugin.name);
        }
        const descriptionEl = document.getElementById('shotupload-description');
        if (descriptionEl && plugin.description) {
            descriptionEl.textContent = getTranslation(plugin.description);
            descriptionEl.setAttribute('data-i18n-key', plugin.description);
        }

        if (!account.loggedIn) {
            // No login endpoint exists on the bridge, so the Decent app is the only
            // place an account can be linked.
            accountEl.innerHTML = notice(
                getTranslation('No Decent account linked'),
                getTranslation('Link your Decent account in the Decent app, then come back to turn uploads on.'));
            return;
        }

        accountEl.innerHTML = linkedBadge;

        let settings;
        try {
            // Strict: the lenient default returns {} for a failed read, which would
            // paint the controls at their defaults while uploads are in fact running.
            settings = await getPluginSettings(PLUGIN_ID, { strict: true }) || {};
        } catch (e) {
            logger.warn('Shot upload settings unavailable:', e);
            accountEl.innerHTML = notice(
                getTranslation('Could not check'),
                getTranslation("Couldn't read the shot upload settings. Reopen this page to try again."));
            return;
        }
        // The page can be left while those awaits are in flight, which drops the
        // form -- same hazard loadVisualizerSettings guards against.
        if (!document.getElementById('shotupload-controls')) return;

        const schema = plugin.settings && typeof plugin.settings === 'object' ? plugin.settings : {};
        const keys = Object.keys(schema);
        const controls = keys.map(key => {
            const html = renderPluginSettingControl(key, schema[key]);
            if (!html) logger.warn(`Shot upload: no control for setting ${key} of type ${schema[key]?.type}`);
            return html;
        }).join('');

        controlsEl.innerHTML = controls || notice(
            getTranslation('Nothing to configure'),
            getTranslation('This plugin does not expose any settings.'));

        // Stored value first, manifest default second -- a plugin that has never
        // been written to has no stored value, and the default is what it is
        // actually running with.
        for (const key of keys) {
            const el = document.getElementById(`shotupload-setting-${key}`);
            if (!el) continue;
            const value = settings[key] !== undefined ? settings[key] : schema[key]?.default;
            if (el.type === 'checkbox') el.checked = value === true;
            else if (value !== undefined && value !== null) el.value = value;
        }
        setControlsEnabled(true);

        // A setting means nothing while the plugin is unloaded, so switching one ON
        // loads it first. Switching off leaves it loaded: the manual upload button
        // and the status endpoint still work.
        const saveSetting = async (patch, { needsPlugin = false } = {}) => {
            if (needsPlugin && !plugin.loaded) {
                await enablePlugin(PLUGIN_ID);
                plugin.loaded = true;
            }
            await setPluginSettings(PLUGIN_ID, patch);
        };

        controlsEl.querySelectorAll('[data-setting-key]').forEach(el => {
            el.addEventListener('change', async function () {
                const key = this.dataset.settingKey;
                const type = this.dataset.settingType;
                const previous = settings[key] !== undefined ? settings[key] : schema[key]?.default;

                let value;
                if (type === 'boolean') {
                    value = this.checked;
                } else if (type === 'string') {
                    value = this.value;
                } else {
                    value = parseFloat(this.value);
                    // Rejected rather than written: a NaN or a negative would be
                    // persisted and read back as a broken threshold on every
                    // later load. The schema carries no bounds, so this keeps the
                    // one rule the hand-written field already enforced.
                    if (!isFinite(value) || value < 0) {
                        this.value = previous ?? '';
                        return;
                    }
                }

                this.disabled = true;
                try {
                    await saveSetting({ [key]: value }, { needsPlugin: value === true });
                    settings[key] = value;
                    if (type === 'boolean') {
                        ui.showToast(
                            `${getTranslation(pluginSettingLabel(key))}: ${getTranslation(value ? 'On' : 'Off')}`,
                            2000, 'success');
                    }
                } catch (e) {
                    logger.error(`Failed to change shot upload setting ${key}`, e);
                    ui.showToast(`${getTranslation('Failed')}: ${e.message || e}`, 4000, 'error');
                    if (type === 'boolean') this.checked = previous === true;
                    else this.value = previous ?? '';
                }
                this.disabled = false;
            });
        });

        uploadNowBtn?.addEventListener('click', async function () {
            this.disabled = true;
            setStatus(`${getTranslation('Uploading')}…`);
            try {
                if (!plugin.loaded) { await enablePlugin(PLUGIN_ID); plugin.loaded = true; }
                const result = await callPluginEndpoint(PLUGIN_ID, 'upload');
                // The endpoint answers 200 with ok:false for a shot it declined to
                // send (too short, already uploaded), which is not a failure.
                setStatus(result?.ok
                    ? getTranslation('Uploaded')
                    : `${getTranslation('Not uploaded')}: ${result?.error || getTranslation('skipped')}`);
            } catch (e) {
                logger.error('Shot upload failed', e);
                setStatus(`${getTranslation('Upload failed')}: ${e.message || e}`);
            }
            this.disabled = false;
        });
    })();
}

// Render extensions settings
export function renderExtensionsSettings() {
    // Return the HTML template
    const template = `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Extensions Settings">Extensions Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Visualizer">Visualizer</p>
                             <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Upload shots to visualizer.coffee">
                        Upload shots to visualizer.coffee
                    </p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="visualizer-enabled" class="sr-only peer">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>

                    <div class="justify-between grid-cols-4 mt-2 w-full">
                        <div id="visualizer-form-container" class="w-full mt-6">
                            <div class="grid grid-cols-4">
                                <div class="col-span-3 flex flex-col gap-6">
                                    <div class="flex flex-col gap-2">
                                        <label for="visualizer-username" class="text-[var(--text-primary)] text-[24px]" data-i18n-key="Username:">Username:</label>
                                        <input type="text" id="visualizer-username" class="w-full max-w-[500px] p-3 rounded-lg border border-[var(--border-color)] bg-[var(--profile-button-background-color)] text-[var(--text-primary)] text-[24px] focus:outline-none focus:ring-2 focus:ring-[var(--mimoja-blue)]" placeholder="Enter your Visualizer username">
                                    </div>
                                    <div class="flex flex-col gap-2">
                                        <label for="visualizer-password" class="text-[var(--text-primary)] text-[24px]" data-i18n-key="Password:">Password:</label>
                                        <input type="password" id="visualizer-password" class="w-full max-w-[500px] p-3 rounded-lg border border-[var(--border-color)] bg-[var(--profile-button-background-color)] text-[var(--text-primary)] text-[24px] focus:outline-none focus:ring-2 focus:ring-[var(--mimoja-blue)]" placeholder="Enter your Visualizer password">
                                    </div>
                                    <div class="flex items-center justify-between gap-4 max-w-[500px]">
                                        <div class="flex flex-col">
                                            <label for="visualizer-auto-upload" class="text-[var(--text-primary)] text-[24px]" data-i18n-key="Auto-upload shots to Visualizer">Auto-upload shots to Visualizer</label>
                                            <p class="text-[var(--text-primary)] text-[20px]" data-i18n-key="Off: long-press the shot history panel to upload a shot yourself.">Off: long-press the shot history panel to upload a shot yourself.</p>
                                        </div>
                                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                                            <input type="checkbox" id="visualizer-auto-upload" class="sr-only peer">
                                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                                        </label>
                                    </div>
                                    <div class="flex items-center gap-4">
                                        <label for="visualizer-min-duration" class="text-[var(--text-primary)] text-[24px]" data-i18n-key="Minimum Shot Duration (seconds):">Minimum Shot Duration (seconds):</label>
                                        <input type="number" id="visualizer-min-duration" class="w-24 p-3 rounded-lg border border-[var(--border-color)] bg-[var(--profile-button-background-color)] text-[var(--text-primary)] text-[24px] focus:outline-none focus:ring-2 focus:ring-[var(--mimoja-blue)]" min="1" value="5">
                                    </div>
                                </div>
                                <div class="col-span-1 col-end-5 flex justify-end">
                                    <button id="save-visualizer-credentials" class=" w-[150px] h-[50px] pt-3 pb-[15px] border border-solid border-[var(--mimoja-blue)] text-[var(--profile-button-text-color)] rounded-[22.5px]">
                                        Save Credentials
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    </div>

                   

                    
                </div>
            </div>

            
        </div>
    `;

    // After returning the template, set up the event listeners
    setTimeout(setupVisualizerEventListeners, 0);

    return template;
}

// Decaid routes /api/v1/plugins/<id>/<endpoint> from the manifest's api
// declarations, so a plugin's page is only real when the manifest declares an
// http endpoint named "ui" -- anything else 404s. Module scope because both the
// Plugins list and the Print The Shot page link to one.
function pluginUiUrl(plugin) {
    const endpoints = Array.isArray(plugin?.api) ? plugin.api : [];
    const hasUi = endpoints.some(e => e?.type === 'http' && e?.id === 'ui');
    return hasUi ? `${API_BASE_URL}/plugins/${encodeURIComponent(plugin.id)}/ui` : null;
}

// Some plugins append their own ui URL to the end of their description
// (decent-profile, settings). The list renders that endpoint as an Open button,
// so the raw URL is a second copy of the same link -- and being the bridge's own
// address it is useless as reading matter. Manifest text is third-party, so this
// only strips, never rewrites.
function pluginDescription(plugin) {
    return String(plugin?.description || '')
        .replace(/\s*https?:\/\/\S*\/api\/v1\/plugins\/\S*/g, '')
        .trim();
}

// Print The Shot -- the settings half of print-the-shot.reaplugin, which sends a
// finished shot to a local print server that renders it as a paper receipt.
//
// Settings only, on purpose. The plugin ships its own complete page at its `ui`
// endpoint -- shot browser, log, print buttons, the 3x retry -- and printing
// there means converting the shot to the TCL wire format the print server wants,
// which is ~130 lines living inside the plugin's own bundle. A copy of that here
// would be wrong the first time the plugin's format changed, for the same reason
// hand-written setting controls go stale (see renderShotUploadSettings). So this
// page owns what the skin is better at -- the settings, in the skin's own
// styling, generated from the manifest -- and hands printing to the page that
// owns the format.
const PRINT_THE_SHOT_PLUGIN_ID = 'print-the-shot.reaplugin';

export function renderPrintTheShotSettings() {
    setTimeout(setupPrintTheShotListeners, 0);

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" id="printtheshot-title" data-i18n-key="Print The Shot">Print The Shot</p>
            </div>

            <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                <p id="printtheshot-description" class="text-[24px] text-[var(--text-primary)] leading-[1.4] opacity-75"></p>

                <!-- Replaced with a notice when the plugin is missing or unreachable. -->
                <div id="printtheshot-gate" class="w-full">
                    <div class="flex items-center justify-center w-full py-[20px]">
                        <span class="loading loading-spinner loading-lg text-[#385a92]"></span>
                    </div>
                </div>

                <!-- Filled from the manifest schema by setupPrintTheShotListeners. -->
                <div id="printtheshot-controls" class="content-stretch flex flex-col gap-[30px] items-start relative w-full"></div>

                <!-- Filled with a link to the plugin's own page once we know it has one. -->
                <div id="printtheshot-ui-link" class="w-full"></div>
            </div>
        </div>
    `;
}

function setupPrintTheShotListeners() {
    const gateEl = document.getElementById('printtheshot-gate');
    const controlsEl = document.getElementById('printtheshot-controls');
    if (!gateEl || !controlsEl) return;

    const notice = (title, body) => `
        <div class="flex flex-col gap-[24px] p-[36px] rounded-[20px] border-2 border-dashed border-[var(--profile-button-outline-color)] bg-[var(--box-color)] items-center text-center">
            <div class="flex flex-col gap-[8px]">
                <p class="text-[26px] font-bold text-[var(--text-primary)]">${title}</p>
                <p class="text-[22px] text-[var(--low-contrast-white)] max-w-[500px] leading-[1.4]">${body}</p>
            </div>
        </div>`;

    (async () => {
        controlsEl.style.opacity = '0.4';

        // getPlugins answers null when the request failed and [] when there really
        // are none, so the two must not collapse into "not installed" -- that would
        // tell a user with a working plugin to go and install it again.
        const plugins = await getPlugins();
        if (!document.getElementById('printtheshot-gate')) return;
        if (!plugins) {
            gateEl.innerHTML = notice(
                getTranslation('Could not check'),
                getTranslation("Couldn't reach the bridge to check the Print The Shot plugin."));
            return;
        }
        const plugin = plugins.find(p => p?.id === PRINT_THE_SHOT_PLUGIN_ID);
        if (!plugin) {
            gateEl.innerHTML = notice(
                getTranslation('Print The Shot plugin not installed'),
                getTranslation('Decaid has no Print The Shot plugin installed. Install it on Decaid, then come back to set up printing.'));
            return;
        }

        // The plugin names and explains itself. Both are optional on the wire, so
        // the static header stands in if either is missing.
        const titleEl = document.getElementById('printtheshot-title');
        if (titleEl && plugin.name) {
            titleEl.textContent = getTranslation(plugin.name);
            titleEl.setAttribute('data-i18n-key', plugin.name);
        }
        const descriptionEl = document.getElementById('printtheshot-description');
        if (descriptionEl && plugin.description) {
            descriptionEl.textContent = getTranslation(plugin.description);
            descriptionEl.setAttribute('data-i18n-key', plugin.description);
        }

        let settings;
        try {
            // Strict: the lenient default returns {} for a failed read, which would
            // paint the controls at their defaults while printing is in fact set up.
            settings = await getPluginSettings(PRINT_THE_SHOT_PLUGIN_ID, { strict: true }) || {};
        } catch (e) {
            logger.warn('Print The Shot settings unavailable:', e);
            gateEl.innerHTML = notice(
                getTranslation('Could not check'),
                getTranslation("Couldn't read the Print The Shot settings. Reopen this page to try again."));
            return;
        }
        // The page can be left while those awaits are in flight, which drops the
        // form -- same hazard loadVisualizerSettings guards against.
        if (!document.getElementById('printtheshot-controls')) return;

        gateEl.innerHTML = '';

        const schema = plugin.settings && typeof plugin.settings === 'object' ? plugin.settings : {};
        const keys = Object.keys(schema);
        controlsEl.innerHTML = keys.map(key => {
            const html = renderPluginSettingControl(key, schema[key], 'printtheshot');
            if (!html) logger.warn(`Print The Shot: no control for setting ${key} of type ${schema[key]?.type}`);
            return html;
        }).join('');

        for (const key of keys) {
            const el = document.getElementById(`printtheshot-setting-${key}`);
            if (!el) continue;
            const value = settings[key] !== undefined ? settings[key] : schema[key]?.default;
            if (el.type === 'checkbox') el.checked = value === true;
            else if (value !== undefined && value !== null) el.value = value;
        }
        controlsEl.style.opacity = '1';

        // Plain same-frame link, as on the Plugins page: the tablet's host opens an
        // OS browser on this navigation, and a _blank would die in the webview.
        const uiUrl = pluginUiUrl(plugin);
        const linkEl = document.getElementById('printtheshot-ui-link');
        if (linkEl && uiUrl) {
            linkEl.innerHTML = `
                <div class="flex flex-col gap-[10px] p-[24px] rounded-[14px] bg-[var(--box-color)] border border-[var(--profile-button-outline-color)]">
                    <p class="text-[22px] font-bold text-[var(--text-primary)]" data-i18n-key="Printing">Printing</p>
                    <p class="text-[20px] text-[var(--low-contrast-white)] leading-[1.4]" data-i18n-key="Browse shots, print one by hand and watch the upload log on the plugin's own page.">Browse shots, print one by hand and watch the upload log on the plugin's own page.</p>
                    <a href="${escapeHtml(uiUrl)}" class="text-[20px] text-[#385a92] underline font-mono break-words">${escapeHtml(uiUrl)}</a>
                </div>`;
        }
        translatePage();

        controlsEl.querySelectorAll('[data-setting-key]').forEach(el => {
            el.addEventListener('change', async function () {
                const key = this.dataset.settingKey;
                const type = this.dataset.settingType;
                const previous = settings[key] !== undefined ? settings[key] : schema[key]?.default;

                let value;
                if (type === 'boolean') {
                    value = this.checked;
                } else if (type === 'string') {
                    value = this.value.trim();
                } else {
                    value = parseFloat(this.value);
                    // Rejected rather than written: a NaN or a negative would be
                    // persisted and read back as a broken threshold on every later
                    // load. The schema carries no bounds.
                    if (!isFinite(value) || value < 0) {
                        this.value = previous ?? '';
                        return;
                    }
                }

                this.disabled = true;
                try {
                    // A setting means nothing while the plugin is unloaded, so
                    // switching one ON loads it first.
                    if (value === true && !plugin.loaded) {
                        await enablePlugin(PRINT_THE_SHOT_PLUGIN_ID);
                        plugin.loaded = true;
                    }
                    await setPluginSettings(PRINT_THE_SHOT_PLUGIN_ID, { [key]: value });
                    settings[key] = value;
                    if (type === 'boolean') {
                        ui.showToast(
                            `${getTranslation(pluginSettingLabel(key))}: ${getTranslation(value ? 'On' : 'Off')}`,
                            2000, 'success');
                    }
                } catch (e) {
                    logger.error(`Failed to change Print The Shot setting ${key}`, e);
                    ui.showToast(`${getTranslation('Failed')}: ${e.message || e}`, 4000, 'error');
                    if (type === 'boolean') this.checked = previous === true;
                    else this.value = previous ?? '';
                }
                this.disabled = false;
            });
        });
    })();
}

// Render DYE2 (Describe Your Espresso 2) settings — its own Extensions sub-page.
export function renderDye2Settings() {
    setTimeout(setupDye2SettingsListeners, 0);

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Describe Your Espresso">Describe Your Espresso</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full">
                <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
                    <!-- DYE2 master switch — gates the whole DYE2 dashboard header UI. Default OFF. -->
                    <div class="content-stretch flex items-center justify-between relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="DYE2">DYE2</p>
                            <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[24px] w-full" data-i18n-key="Show DYE auto-favourites and recipes on the dashboard header.">
                                Show DYE auto-favourites and recipes on the dashboard header.
                            </p>
                        </div>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox" id="dye2-enabled" class="sr-only peer">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>

                    <!-- Installed version, where Decaid tracks it from, and any update held back for asking new permissions. -->
                    <div class="content-stretch flex flex-col gap-[10px] items-start relative w-full">
                        <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                            <p class="leading-[1.2]" data-i18n-key="Plugin Version">Plugin Version</p>
                        </div>
                        <div id="dye2-version-info" class="w-full text-[24px] text-[var(--text-secondary)]">
                            ${getTranslation('Checking')}…
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Paint the DYE2 plugin card. Everything shown comes from the bridge (GET
// /plugins): Decaid tracks where the plugin came from and installs new releases
// itself, so there is no "latest version" to fetch and nothing to compare. The
// only state that needs a human is a pendingUpdate — an update Decaid downloaded
// and refused to install because it asks for permissions the installed version
// does not hold. Unknowns stay "—" rather than being guessed at.
function renderDye2VersionInfo(info) {
    const el = document.getElementById('dye2-version-info');
    if (!el) return;
    const pill = (text, cls) =>
        `<span class="text-[20px] font-bold px-[16px] py-[6px] rounded-full ${cls}">${text}</span>`;
    const button = (id, label) =>
        `<button id="${id}" class="bg-[#385a92] h-[56px] px-[28px] rounded-[64px] text-white text-[22px] font-bold">${label}</button>`;

    let status;
    if (!info.reachable) {
        status = pill(getTranslation('Could not check'), 'bg-[var(--profile-button-outline-color)]/30 text-[var(--text-primary)] opacity-70');
    } else if (!info.installed) {
        status = pill(getTranslation('Not installed'), 'bg-[var(--profile-button-outline-color)]/30 text-[var(--text-primary)] opacity-70');
    } else if (!info.loaded) {
        status = pill(getTranslation('Not loaded'), 'bg-amber-500/15 text-amber-600');
    } else if (info.pending) {
        status = pill(getTranslation('Update needs approval'), 'bg-amber-500/15 text-amber-600');
    } else {
        status = pill(getTranslation('Up to date'), 'bg-[#385a92]/15 text-[#385a92]');
    }

    const row = (label, value) => `
        <div class="flex items-center justify-between w-full">
            <span data-i18n-key="${label}">${getTranslation(label)}</span>
            <span class="font-bold text-[var(--text-primary)]">${value}</span>
        </div>`;

    // A tracked source is a repo plus the exact release tag or commit installed;
    // a ZIP or folder install is a snapshot Decaid cannot update.
    const src = info.source;
    let sourceText = '—';
    if (src?.kind === 'github_release') sourceText = `${escapeHtml(src.repo || '')} ${escapeHtml(src.releaseTag || '')}`.trim();
    else if (src?.kind === 'github_branch') sourceText = `${escapeHtml(src.repo || '')} ${escapeHtml(src.branch || '')}@${escapeHtml((src.commit || '').slice(0, 7))}`;
    else if (src?.kind === 'local_zip') sourceText = getTranslation('Local ZIP');
    else if (src?.kind === 'local_folder') sourceText = getTranslation('Local folder');

    // The added permissions are the whole point of the prompt, so list them
    // verbatim — approving is consent to those, not to "an update".
    const pendingBlock = info.pending ? `
        <div class="flex flex-col gap-[10px] w-full pt-[4px]">
            <span class="text-[20px] text-[var(--text-primary)]">
                v${escapeHtml(info.pending.version || '?')} ${getTranslation('is available but asks for new permissions')}:
            </span>
            <span class="text-[20px] font-bold text-[var(--text-primary)] break-words">
                ${(info.pending.addedPermissions || []).map(escapeHtml).join(', ') || '—'}
            </span>
        </div>` : '';

    el.innerHTML = `
        <div class="flex flex-col gap-[10px] w-full">
            ${row('Installed version', info.installed ? `v${escapeHtml(info.installed)}` : '—')}
            ${row('Source', sourceText)}
            ${src?.lastError ? row('Last error', `<span class="text-amber-600">${escapeHtml(src.lastError)}</span>`) : ''}
            ${pendingBlock}
            <div class="flex items-center gap-[14px] flex-wrap pt-[4px]">
                ${status}
                ${info.reachable && !info.installed ? button('dye2-install-plugin', getTranslation('Install')) : ''}
                ${info.pending ? button('dye2-approve-update', getTranslation('Approve update')) : ''}
            </div>
        </div>`;

    const refresh = () => getDye2VersionInfo().then(renderDye2VersionInfo).catch(() => {});
    const busy = (btn, label) => { btn.disabled = true; btn.textContent = label; };

    document.getElementById('dye2-install-plugin')?.addEventListener('click', async function () {
        busy(this, `${getTranslation('Installing')}…`);
        try {
            await installDye2Plugin();
            ui.showToast(getTranslation('DYE2 plugin installed'), 2000, 'success');
        } catch (e) {
            logger.error('DYE2 install failed', e);
            ui.showToast(`${getTranslation('Install failed')}: ${e.message || e}`, 4000, 'error');
        }
        refresh();
    });

    document.getElementById('dye2-approve-update')?.addEventListener('click', async function () {
        busy(this, `${getTranslation('Updating')}…`);
        try {
            const result = await approvePluginUpdate('dye2.reaplugin');
            ui.showToast(`${getTranslation('DYE2 updated to')} v${result?.version || '?'}`, 2500, 'success');
        } catch (e) {
            // 409: the release or branch moved after this permission delta was shown.
            // Decaid has already recorded the new candidate, so re-reading shows the
            // fresh delta to approve — retrying this call would only 409 again.
            if (e.status === 409) {
                ui.showToast(getTranslation('The update changed since it was shown — review it again'), 5000, 'error');
            } else {
                logger.error('DYE2 update approval failed', e);
                ui.showToast(`${getTranslation('Update failed')}: ${e.message || e}`, 4000, 'error');
            }
        }
        refresh();
    });
}

// DYE2 master on/off. Persists streamline.dye2Enabled (default OFF). Flipping it
// live-updates the dashboard header via the window.applyDye2Enabled bridge that
// dyeStrip.js installs on the main page; if the header isn't mounted (e.g. deep in
// settings on some flows) the flag still takes effect on the next dashboard load.
function setupDye2SettingsListeners() {
    // Opening this page is the update check — no button for it. Paint what the
    // bridge already knows first so the card is never blank, then let the check
    // (rate-limit aware, see checkDye2UpdatesIfDue) repaint it with the outcome.
    // Decaid installs anything that needs no new permission on its own; what
    // survives is a pendingUpdate, which the card renders with its Approve button.
    getDye2VersionInfo()
        .then(renderDye2VersionInfo)
        .catch(() => renderDye2VersionInfo({ reachable: false, installed: null, loaded: false, source: null, pending: null }));
    checkDye2UpdatesIfDue()
        .then(renderDye2VersionInfo)
        .catch((e) => logger.error('DYE2 update check failed', e));

    const toggle = document.getElementById('dye2-enabled');
    if (!toggle) return;
    const KEY = 'streamline.dye2Enabled';
    let enabled = false;
    try { enabled = localStorage.getItem(KEY) === 'true'; } catch (e) { /* private mode */ }
    toggle.checked = enabled;
    toggle.addEventListener('change', async function () {
        const on = this.checked;
        // Turning on requires the plugin installed, loaded, and >= its minimum
        // version — ensureDye2PluginReady prompts with a download link and
        // returns false if not, in which case we revert the toggle.
        if (on) {
            const ready = await ensureDye2PluginReady();
            if (!ready) { this.checked = false; return; }
        }
        try { localStorage.setItem(KEY, on ? 'true' : 'false'); } catch (e) { /* private mode */ }
        if (typeof window.applyDye2Enabled === 'function') window.applyDye2Enabled(on);
        try { ui.showToast(`DYE2 ${on ? 'enabled' : 'disabled'}`, 1500, 'success'); } catch (e) { /* ui not ready */ }
        // Switching on is the moment the user cares whether the plugin is current.
        // Deliberately not awaited before the toggle is saved: an update check is a
        // network round-trip and DYE2 is already usable without it.
        if (on) {
            offerDye2Update()
                .then((changed) => {
                    if (changed) ui.showToast(getTranslation('DYE2 plugin updated'), 2500, 'success');
                    return getDye2VersionInfo().then(renderDye2VersionInfo);
                })
                .catch((e) => logger.error('DYE2 update offer failed', e));
        }
    });
}

// Whether the visualizer plugin currently has a stored (secure) password.
// PR #588: secure values are returned as { isSet } state, never plaintext.
let visualizerPasswordIsSet = false;

// Function to set up event listeners for the Visualizer settings
function setupVisualizerEventListeners() {
    const saveButton = document.getElementById('save-visualizer-credentials');
    const usernameInput = document.getElementById('visualizer-username');
    const passwordInput = document.getElementById('visualizer-password');
    const autoUploadCheckbox = document.getElementById('visualizer-auto-upload');
    const minDurationInput = document.getElementById('visualizer-min-duration');
    const statusDiv = document.getElementById('visualizer-status');
    const formContainer = document.getElementById('visualizer-form-container');
    const enabledToggle = document.getElementById('visualizer-enabled');

    if (!saveButton) {
        console.warn('Save button for Visualizer credentials not found');
        return;
    }

    // Load existing settings when the form loads
    loadVisualizerSettings();

    // Initially hide the form if the Visualizer integration is off
    if (enabledToggle && formContainer && !enabledToggle.checked) {
        formContainer.style.display = 'none';
    }

    // Two independent switches over the plugin's one AutoUpload flag: the master
    // toggle is the integration itself (credentials form, manual upload from the
    // shot history), the inner one is whether a finished shot goes up by itself.
    // visualizer.js writes the AND of the two to the plugin.
    if (enabledToggle) {
        enabledToggle.addEventListener('change', async function() {
            const isEnabled = this.checked;
            if (formContainer) formContainer.style.display = isEnabled ? 'block' : 'none';
            try {
                const { setVisualizerEnabled } = await import('../modules/visualizer.js');
                await setVisualizerEnabled(isEnabled);
                ui.showToast(`${getTranslation('Visualizer')} ${isEnabled ? getTranslation('Enabled') : getTranslation('Disabled')}`, 1500, 'success');
            } catch (error) {
                console.error('Failed to save Visualizer state:', error);
                ui.showToast('Failed to update Visualizer state', 2000, 'error');
            }
        });
    }

    if (autoUploadCheckbox) {
        autoUploadCheckbox.addEventListener('change', async function() {
            const isAutoUpload = this.checked;
            try {
                const { setAutoUpload } = await import('../modules/visualizer.js');
                await setAutoUpload(isAutoUpload);
                ui.showToast(
                    isAutoUpload
                        ? getTranslation('Shots upload automatically')
                        : getTranslation('Upload shots from the history long-press menu'),
                    2000,
                    'success'
                );
            } catch (error) {
                console.error('Failed to save Visualizer auto-upload state:', error);
                ui.showToast('Failed to update auto-upload', 2000, 'error');
            }
        });
    }

    // Add click handler for the save button
    saveButton.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value; // Don't trim password as spaces might be valid

        if (!username) {
            ui.showToast('Please enter your Visualizer username', 1500, 'error');
            return;
        }

        // Settings POST is a patch (Decaid #588): a typed password sets the
        // credential, an empty field preserves the stored one via the isSet
        // marker, an empty field with nothing stored leaves it unset.
        let passwordPayload;
        if (password) {
            try {
                // Import verifyVisualizerCredentials from api.js
                const { verifyVisualizerCredentials } = await import('../modules/api.js');

                const isValid = await verifyVisualizerCredentials(username, password);

                if (!isValid) {
                    ui.showToast('Visualizer log-in failed, check credentials', 900, 'error');
                    return; // Stop here if credentials are bad
                }

                ui.showToast('Visualizer log-in success', 900, 'success');
            } catch (error) {
                console.error('Error during credential validation:', error);
                ui.showToast(`Error validating credentials: ${error.message}`, 3000, 'error');
                return;
            }
            passwordPayload = password;
        } else {
            passwordPayload = { isSet: visualizerPasswordIsSet }; // preserve current state
        }

        // Proceed to save to plugin
        const autoUpload = autoUploadCheckbox.checked;
        const minDuration = parseInt(minDurationInput.value, 10) || 5;

        // 1. Save UI-only settings to localStorage
        localStorage.setItem('visualizerAutoUpload', autoUpload.toString());

        // 2. Prepare and save plugin settings - use correct field names expected by visualizer plugin manifest
        const { setPluginSettings } = await import('../modules/api.js');
        const { isAutoUploadEnabled } = await import('../modules/visualizer.js');
        const pluginId = 'visualizer.reaplugin';

        const settingsPayload = {
            Username: username,
            Password: passwordPayload,
            // Both switches gate it — saving credentials must not start uploads
            // while the integration itself is switched off.
            AutoUpload: isAutoUploadEnabled(),
            LengthThreshold: minDuration
        };

        try {
            await setPluginSettings(pluginId, settingsPayload);
            ui.showToast('Visualizer settings saved successfully', 3000, 'success');
        } catch (error) {
            console.error('Failed to save visualizer plugin settings:', error);
            ui.showToast(`Failed to save plugin settings: ${error.message}`, 3000, 'error');
        }
    });
}

// Function to load existing Visualizer settings
async function loadVisualizerSettings() {
    try {
        const { getPluginSettings } = await import('../modules/api.js');
        const pluginId = 'visualizer.reaplugin';

        const savedSettings = await getPluginSettings(pluginId);

        const usernameInput = document.getElementById('visualizer-username');
        const passwordInput = document.getElementById('visualizer-password');
        const autoUploadCheckbox = document.getElementById('visualizer-auto-upload');
        const minDurationInput = document.getElementById('visualizer-min-duration');
        const formContainer = document.getElementById('visualizer-form-container');
        const enabledToggle = document.getElementById('visualizer-enabled');

        // The awaits above can outlive the page: leaving the Visualizer sub-page
        // re-renders the content area and drops the form, so by the time settings
        // arrive these lookups return null. Nothing to populate — bail.
        if (!usernameInput || !passwordInput || !autoUploadCheckbox || !minDurationInput) return;

        if (savedSettings && savedSettings.Username) {
            usernameInput.value = savedSettings.Username;
        } else {
            usernameInput.value = '';
        }

        // Always clear the password field for security
        passwordInput.value = '';

        // Secure values are returned as { isSet } state, never plaintext (Decaid #588).
        const passwordVal = savedSettings?.Password;
        visualizerPasswordIsSet = passwordVal != null &&
            (typeof passwordVal === 'object' ? passwordVal.isSet === true : !!passwordVal);
        passwordInput.placeholder = visualizerPasswordIsSet
            ? 'Password saved — leave empty to keep'
            : 'Enter your Visualizer password';

        // The master switch used to be the plugin's AutoUpload flag and nothing
        // else, so it left no key of its own behind: for an existing install,
        // "configured" (a username is stored) means the integration is on.
        if (localStorage.getItem('visualizerEnabled') === null) {
            localStorage.setItem('visualizerEnabled', String(!!savedSettings?.Username));
        }
        const isEnabled = localStorage.getItem('visualizerEnabled') === 'true';

        // Auto-upload keeps the user's own choice even while the master switch is
        // off (the plugin flag is then false, and says nothing about the choice).
        const storedAutoUpload = localStorage.getItem('visualizerAutoUpload');
        const autoUploadValue = storedAutoUpload !== null
            ? storedAutoUpload === 'true'
            : (typeof savedSettings.AutoUpload !== 'undefined' ? !!savedSettings.AutoUpload : true);
        autoUploadCheckbox.checked = autoUploadValue;
        if (enabledToggle) enabledToggle.checked = isEnabled;

        // Visualizer plugin uses 'Length' not 'LengthThreshold'
        if (typeof savedSettings.Length !== 'undefined') {
            minDurationInput.value = parseInt(savedSettings.Length, 10) || 5;
        }

        // Set form visibility based on the master switch
        if (formContainer) {
            formContainer.style.display = isEnabled ? 'block' : 'none';
        }
    } catch (error) {
        console.error('Failed to load Visualizer settings:', error);
        ui.showToast('Could not load Visualizer plugin settings', 3000, 'error');
    }
}

export function renderMachineInformationSettings() {
    const machineInfo = settingsCache.machineInfo;

    const extraRows = (machineInfo?.extra && typeof machineInfo.extra === 'object')
        ? Object.entries(machineInfo.extra).map(([key, value]) => {
            const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
            const val = typeof value === 'boolean' ? (value ? getTranslation('Enabled') : getTranslation('Disabled')) : String(value);
            return `
            <div class="flex items-center justify-between py-[16px] border-t border-[#c9c9c9]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]">${getTranslation(label)}</span>
                <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${val}</span>
            </div>`;
        }).join('')
        : '';

    const body = machineInfo ? `
        <div class="rounded-[10px] border border-[#c9c9c9] p-6 bg-[var(--box-color)] flex flex-col gap-0">

            <div class="flex items-center justify-between py-[16px]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]">${getTranslation('Model')}</span>
                <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${machineInfo.model}</span>
            </div>

            <div class="flex items-center justify-between py-[16px] border-t border-[#c9c9c9]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]">${getTranslation('Firmware')} ${getTranslation('Version')}</span>
                <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${machineInfo.version}</span>
            </div>

            <div class="flex items-center justify-between py-[16px] border-t border-[#c9c9c9]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]" data-i18n-key="Serial number:">Serial number:</span>
                <div class="flex items-center gap-3">
                    <button onclick="navigator.clipboard.writeText('${machineInfo.serialNumber}').then(()=>{ this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy',1500); })"
                            class="text-[18px] font-semibold text-[#385a92] px-3 py-1 rounded-[8px] border border-[#385a92] hover:bg-[#385a92] hover:text-white transition-colors">
                        ${getTranslation('Copy')}
                    </button>
                    <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${machineInfo.serialNumber}</span>
                </div>
            </div>

            <div class="flex items-center justify-between py-[16px] border-t border-[#c9c9c9]">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)]">${getTranslation('Group Head Controller')}</span>
                <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${machineInfo.GHC ? getTranslation('Enabled') : getTranslation('Disabled')}</span>
            </div>

            ${extraRows}
        </div>
    ` : `
        <div class="rounded-[10px] border border-[#c9c9c9] p-6 bg-[var(--box-color)]">
            <p class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]" data-i18n-key="Fetching machine info...">Fetching machine info...</p>
        </div>
    `;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Machine Info">Machine Info</p>
            </div>
            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>
            <div class="w-full flex flex-col gap-4">
                ${body}
            </div>
        </div>
    `;
}

// Why a check could not reach a verdict, in the user's terms. Keys are the
// FirmwareEligibility.reasons enum (rest_v1.yml).
const FIRMWARE_REASON_TEXT = {
    machine_not_connected: 'No machine connected',
    machine_model_unknown: 'Machine model unknown',
    installed_build_unknown: 'Installed build unknown',
    model_incompatible: 'Not compatible with this machine',
    artifact_invalid: 'Bundled firmware failed validation',
    unreachable: 'Could not reach the firmware service',
};

// The update-check block under the Firmware Version row. Rendered from the pure
// summary so the four outcomes stay visually distinct — in particular "could not
// check" must never look like "up to date".
function renderFirmwareCheckBlock(summary) {
    if (!summary) {
        return `<p class="text-[22px] text-[var(--text-secondary)]">${getTranslation('Check for firmware updates')}…</p>`;
    }

    const { status, latestBuild, latestLabel, releaseNotes, reason, operationState } = summary;

    if (operationState && operationState !== 'idle') {
        return `<p class="text-[22px] font-bold text-[#385a92]">${getTranslation('A firmware update is already in progress')} (${escapeHtml(operationState)})</p>`;
    }

    const pill = (text, cls) =>
        `<span class="text-[20px] font-bold px-[16px] py-[6px] rounded-full ${cls}">${text}</span>`;

    // Installed build is already shown next to "Firmware Version" above (the
    // #de1-firmware-version row) — this block only needs to say what's new.
    if (status === 'updateAvailable') {
        const artifactId = summary.artifactId;
        return `
            <div class="flex flex-col gap-[10px]">
                <div class="flex items-center gap-[14px] flex-wrap">
                    ${pill(getTranslation('Firmware update available'), 'bg-green-500/15 text-green-600')}
                    <span class="text-[22px] text-[var(--text-primary)]">${getTranslation('Build')} ${escapeHtml(String(latestLabel ?? latestBuild ?? '—'))}</span>
                </div>
                ${releaseNotes ? `<p class="text-[20px] text-[var(--text-secondary)] leading-[1.4]">${escapeHtml(releaseNotes)}</p>` : ''}
                <p class="text-[20px] font-bold text-[var(--text-primary)] leading-[1.4]">${getTranslation(FIRMWARE_DURATION_NOTE)}</p>
                <button id="firmware-apply-btn" class="self-start bg-[#385a92] h-[56px] px-[28px] rounded-[64px] text-white text-[22px] font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                        ${artifactId ? `onclick="window.applyFirmwareUpdate('${escapeHtml(artifactId)}')"` : 'disabled'}>
                    ${getTranslation('Download & Install')}
                </button>
            </div>`;
    }

    if (status === 'upToDate') {
        return pill(getTranslation('Up to date'), 'bg-[#385a92]/15 text-[#385a92]');
    }

    // Installed build is newer than anything bundled — a beta machine, not a
    // failed check. Saying "up to date" here would be a guess.
    if (status === 'ahead') {
        return pill(getTranslation('Newer than bundled'), 'bg-amber-500/15 text-amber-600');
    }

    const why = FIRMWARE_REASON_TEXT[reason];
    return `<div class="flex items-center gap-[14px] flex-wrap">
                ${pill(getTranslation('Could not check'), 'bg-[var(--profile-button-outline-color)]/30 text-[var(--text-primary)] opacity-70')}
                ${why ? `<span class="text-[22px] text-[var(--text-secondary)]">${getTranslation(why)}</span>` : ''}
            </div>`;
}

// Fetch + paint the check. Fired from the firmware page's render hook, not from
// preloadSettings: no reason to hit the endpoint on every settings open when
// only this one page shows the result.
async function initFirmwareCheck() {
    const paint = () => {
        const section = document.getElementById('firmware-check-section');
        if (section) section.innerHTML = renderFirmwareCheckBlock(settingsCache.firmwareCheck);
    };
    settingsCache.firmwareCheck = null;
    paint();
    // The endpoint itself would report this as reason: 'machine_model_unknown'
    // (it doesn't require a connection — see rest_v1.yml), which is technically
    // true but reads as a broken check rather than "plug your machine in". We
    // already know the answer from preloadSettings, so skip the round trip and
    // give the clearer, already-translated reason instead.
    settingsCache.firmwareCheck = settingsCache.machineInfo
        ? summarizeFirmwareCatalog(await getFirmwareCatalog())
        : { status: 'unknown', installedBuild: null, model: null, latestBuild: null,
            latestLabel: null, artifactId: null, releaseNotes: null,
            reason: 'machine_not_connected', operationState: 'idle' };
    paint();
}

// Said before the update starts, everywhere it can be started from: the manual
// upload block, the "update available" block, and the install confirm. A flash is
// ~50 minutes of erase, upload and CRC verification, most of it with the bar
// barely moving — someone who expected "a few minutes" reads that as a hang and
// pulls the plug, which is the one thing that turns a slow update into a broken
// machine. One constant so the number cannot drift between the three places.
// Keep in sync with FIRMWARE_ESTIMATED_TOTAL_SECONDS in firmware-progress.js —
// that's this same number driving the countdown, not an independent guess.
const FIRMWARE_DURATION_NOTE = 'The whole update takes at least 50 minutes. Do not power off the machine or leave this page until it finishes.';

// Phase -> user-facing line. Shared by the live progress callback and the page
// re-render, so a rejoined update reads identically to one watched throughout.
function firmwareProgressLabel(progress) {
    if (!progress) return '';
    const { phase, percent } = progress;
    const text = {
        erasing: `${getTranslation('Erase')}…`,
        // The stream stays on `uploading` right through verification — it never
        // reports 100% and never says 'verifying' (see isUploadComplete), so the
        // latch is what moves this on. Neither is "update applied": only `done`.
        uploading: firmwareVerifyStartedAt
            ? `${getTranslation('Check')}…`
            : `${getTranslation('Uploading...')} ${percent}%`,
        done: getTranslation('Your DE1 firmware has been upgraded. Restart the machine to apply it.'),
    }[phase] || '';
    // Only while something is actually running: a finished or failed update
    // must not keep a clock next to it.
    return text && phase !== 'done' ? `${text}${firmwareClock(percent)}` : text;
}

// The clock beside the phase. Three sources, best first, because each phase
// knows a different amount about how long it has left:
//
//  1. Upload — measured. The rate comes from bytes actually sent, and it
//     already includes the verification still to come, so it counts down to
//     `done` rather than to 0:00-then-wait.
//  2. Verification — bounded. No percentages on the wire, but decaid's own
//     30s timeout (FIRMWARE_VERIFY_SECONDS) is a real ceiling to count against.
//     Past it, say so: the next thing to happen is that timeout firing.
//  3. Erase / before the first upload tick — ballpark only. Nothing has been
//     measured yet, so it counts down against FIRMWARE_ESTIMATED_TOTAL_SECONDS
//     (the same "at least 50 minutes" FIRMWARE_DURATION_NOTE promises) and the
//     silence reads as "still within the estimate" rather than as a hang.
//
// Returns '' when nothing is running.
function firmwareClock(percent, now = Date.now()) {
    // Verification first: the stream sits on `uploading` at 99% for the whole of
    // it, so an upload-rate estimate is still answerable here and would win the
    // branch with a projection for bytes that already went out.
    if (firmwareVerifyStartedAt) {
        const verifying = estimateVerifyRemainingSeconds(firmwareVerifyStartedAt, now);
        return verifying !== null
            ? ` — ${formatDuration(verifying)} ${getTranslation('remaining')}`
            : ` — ${getTranslation('taking longer than usual')}`;
    }
    const remaining = estimateRemainingSeconds({
        startedAt: firmwareUploadStartedAt,
        startPercent: firmwareUploadStartPercent,
        percent,
        updatedAt: firmwareProgressAt,
        now,
    });
    // The verification still to come is part of what's remaining — without it the
    // countdown reaches 0:00 with up to half a minute of CRC left to sit through.
    if (remaining !== null) return ` — ${formatDuration(remaining + FIRMWARE_VERIFY_SECONDS)} ${getTranslation('remaining')}`;
    if (!firmwareStartedAt) return '';
    const estimated = estimateTotalRemainingSeconds(firmwareStartedAt, now);
    if (estimated !== null) return ` — ~${formatDuration(estimated)} ${getTranslation('remaining')}`;
    return ` — ${getTranslation('taking longer than usual')}`;
}

// Which of the four real phases a flash is in, as a step index (0-3). 'verify'
// is synthetic on the wire — the stream never says it, it's just 'uploading'
// with all bytes sent (see the phase === 'done' comment in firmwareProgressLabel) —
// but it is a real, distinct wait server-side (its own 30s BLE timeout, same as
// erase; see unified_de1.dart's firmwareVerificationTimeout) and worth its own
// node rather than looking like Upload is still running at 100%.
function firmwareStepIndex(progress) {
    if (!progress) return -1;
    const { phase } = progress;
    if (phase === 'erasing') return 0;
    // Same latch as the label: `uploading` covers verification too on the wire.
    if (phase === 'uploading') return firmwareVerifyStartedAt ? 2 : 1;
    if (phase === 'done') return 3;
    return -1;
}

// Latch the start of verification the moment the measured upload projection runs
// out. Called from every repaint — each stream event AND the 1 Hz tick — because
// the event that would otherwise mark it never arrives (see isUploadComplete):
// the last thing the stream says is 99%, and then it is silent to the end.
function firmwareNoteVerifyStart(now = Date.now()) {
    if (lastFirmwareProgress?.phase !== 'uploading') return;
    if (firmwareVerifyStartedAt) return;
    const complete = isUploadComplete({
        startedAt: firmwareUploadStartedAt,
        startPercent: firmwareUploadStartPercent,
        percent: lastFirmwareProgress.percent,
        updatedAt: firmwareProgressAt,
        now,
    });
    if (complete) firmwareVerifyStartedAt = now;
}

// Erase, Upload, Verify, Done: the actual, ordered phases a flash goes through
// (FirmwareHandler._streamFirmwareUpload on the decaid side emits exactly this
// sequence). Shown as a tracker instead of a single bar because most of a
// ~50-minute flash is spent on the two silent phases either side of Upload —
// someone watching a bar that hasn't moved in ten minutes can't tell "step 1 of
// 4, working" from "hung"; a lit-up node can.
const FIRMWARE_STEP_LABELS = ['Erase', 'Upload', 'Verify', 'Done'];

function renderFirmwareSteps(progress, { failed = false, cancelled = false } = {}) {
    const current = firmwareStepIndex(progress);
    if (current < 0) return '';
    const last = FIRMWARE_STEP_LABELS.length - 1;
    return `<div class="flex w-full">${FIRMWARE_STEP_LABELS.map((key, i) => {
        // Done (current === last) means every node completed, this one included.
        const isPast = current === last ? true : i < current;
        const isCurrent = i === current && current !== last;
        const stoppedHere = isCurrent && (failed || cancelled);
        const circleCls = stoppedHere
            ? (failed ? 'bg-[#da515e] text-white' : 'bg-[var(--text-secondary)] text-white')
            : isPast ? 'bg-[#0CA581] text-white'
            : isCurrent ? 'bg-[#385a92] text-white'
            : 'bg-transparent border-2 border-[#c9c9c9]';
        const glyph = stoppedHere ? '✕' : isPast ? '✓' : '';
        const lineCls = isPast && i < last ? 'bg-[#0CA581]' : 'bg-[#c9c9c9]';
        const labelCls = isCurrent || isPast ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]';
        return `
            <div class="relative flex-1 flex flex-col items-center gap-[8px]">
                ${i < last ? `<div class="absolute top-[17px] left-1/2 w-full h-[3px] ${lineCls}"></div>` : ''}
                <div class="relative z-10 flex items-center justify-center size-[36px] rounded-full text-[18px] font-bold ${circleCls}">${glyph}</div>
                <p class="text-[16px] font-bold ${labelCls}">${getTranslation(key)}</p>
            </div>`;
    }).join('')}</div>`;
}

export function renderFirmwareUpdateSettings() {
    // Currently installed DE1 firmware, so the version you're about to overwrite is
    // on the same page as the Upload button (Machine Info also shows it, :5167).
    // Read from the cache only — no fetch: this page isn't gated on machineInfo
    // loading, so it can render before the info lands, hence the em dash fallback.
    const de1Version = settingsCache.machineInfo?.version;

    return `
        <div class="content-stretch flex flex-col gap-[22px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Firmware Update">Firmware Update</p>
            </div>

            <div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>

            <div class="content-stretch flex flex-col gap-[10px] relative w-full">
                <div class="content-stretch flex items-center justify-between relative w-full">
                    <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px] leading-[1.2]"><span data-i18n-key="Firmware">Firmware</span> <span data-i18n-key="Version">Version</span></p>
                    <p id="de1-firmware-version" class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">${de1Version || '—'}</p>
                </div>
                <!-- Filled by initFirmwareCheck from GET /machine/firmware. Seeded from
                     the cache so returning to the page doesn't flash "Checking...". -->
                <div id="firmware-check-section">${renderFirmwareCheckBlock(settingsCache.firmwareCheck)}</div>
            </div>

            <div class="content-stretch flex flex-col gap-[12px] items-start relative w-full">
                <!-- Folded away behind "Advanced" so the page pushes Download & Install:
                     that path is the safe one (a validated, model-checked bundled image),
                     while hand-picking a .bin is the expert escape hatch for a file Decent
                     support sent you. Native <details> — no JS to open and close it.
                     (It re-renders closed after leaving the page: this whole subtree is
                     rebuilt from a template string, so there is no element left to hold
                     the open state. Folding back to the safe default is the right way
                     round for this particular control.)
                     Hidden outright while the catalog's Download & Install is running (see
                     runFirmwareOperation): this card's own Select File/Upload controls are
                     moot for an update it didn't start. Kept open when it's the one running,
                     so a re-render mid-upload doesn't fold its own Upload button away. -->
                <details id="firmware-manual-upload-section" class="w-full" ${firmwareUploadInFlight && firmwareOperationSource === 'manual' ? 'open' : ''}
                         style="display:${firmwareUploadInFlight && firmwareOperationSource === 'catalog' ? 'none' : ''}">
                    <!-- Both marker rules: list-none covers modern browsers, the webkit
                         pseudo-element covers the older WebKit the tablet webview ships. -->
                    <summary class="list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none text-[22px] font-bold text-[var(--text-secondary)] py-[8px]">
                        <span data-i18n-key="Advanced">Advanced</span> ▾
                    </summary>

                    <div class="content-stretch flex flex-col gap-[12px] items-start relative w-full pt-[8px]">
                        <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px] leading-[1.2]" data-i18n-key="DE1 Firmware File">DE1 Firmware File</p>

                        <!-- The file and the buttons that act on it live in one card so the
                             "what did I pick" state reads as a unit with "what happens to it".
                             Select File and Upload stay paired on the same row/level — they're
                             the two steps of one action, in reading order. -->
                        <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)] flex items-center justify-between gap-[20px] flex-wrap w-full">
                            <div class="min-w-0">
                                <p id="firmware-filename" class="font-['Inter:Regular',sans-serif] text-[22px] text-[var(--text-primary)] truncate" data-i18n-key="No file selected">No file selected</p>
                                <!-- Filled by onFirmwareFileSelected: size in KB/MB, plus a plain-
                                     language flag once it's bigger than any real DE1 image — a toast
                                     fades, this stays on screen next to the file it's about. -->
                                <p id="firmware-filename-hint" class="text-[16px] text-[var(--text-secondary)]"></p>
                            </div>
                            <div class="flex items-center gap-[16px] flex-shrink-0">
                                <button class="bg-[#385a92] h-[56px] px-[28px] rounded-[64px] text-white text-[20px] font-bold"
                                        onclick="document.getElementById('firmware-file-input').click()">
                                    ${getTranslation('Select')} ${getTranslation('File')}
                                </button>
                                <button id="firmware-upload-btn" class="bg-[#385a92] h-[56px] px-[28px] rounded-[64px] text-white text-[20px] font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                                        disabled onclick="window.uploadFirmware()">
                                    ${getTranslation(firmwareUploadInFlight ? 'Uploading...' : 'Upload')}
                                </button>
                            </div>
                        </div>
                    </div>
                </details>

                <!-- Filled by window.uploadFirmware from the NDJSON progress stream. Hidden
                     via inline display, not the hidden attribute: the flex utility would override it.
                     Seeded from lastFirmwareProgress so leaving this page and coming back
                     mid-update rejoins it where it is, not at zero-and-hidden. -->
                <div id="firmware-progress" class="w-full flex flex-col gap-3" style="display:${lastFirmwareProgress ? 'flex' : 'none'}">
                    <div id="firmware-steps">${renderFirmwareSteps(lastFirmwareProgress)}</div>
                    <p id="firmware-progress-label" class="text-[20px] font-bold text-[var(--text-primary)]">${firmwareProgressLabel(lastFirmwareProgress)}</p>
                    <!-- Only Upload has a real byte-level percentage (see firmwareStepIndex) —
                         showing this bar during the silent erase/verify phases would just be
                         a second thing sitting still next to the tracker. The verify latch,
                         not the percentage, is what ends Upload: the stream stops at 99%. -->
                    <div id="firmware-progress-bar-wrap" class="w-full h-[10px] rounded-full bg-[#c9c9c9] overflow-hidden" style="display:${lastFirmwareProgress?.phase === 'uploading' && !firmwareVerifyStartedAt ? 'block' : 'none'}">
                        <div id="firmware-progress-bar" class="h-full bg-[#385a92] transition-[width] duration-200" style="width:${lastFirmwareProgress?.phase === 'uploading' && !firmwareVerifyStartedAt ? lastFirmwareProgress.percent : 0}%"></div>
                    </div>
                    <!-- Visibility toggled imperatively by runFirmwareOperation, not re-render:
                         it must appear the instant an update starts and disappear once the
                         stream settles, same as the panel it lives in. -->
                    <button id="firmware-cancel-btn" type="button"
                            class="self-start h-[48px] px-[28px] rounded-[64px] border-2 border-[var(--border-color)] text-[var(--text-primary)] text-[20px] font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                            style="display:${firmwareUploadInFlight ? 'inline-flex' : 'none'}"
                            onclick="window.cancelFirmwareUpdate()">
                        ${getTranslation('Cancel')}
                    </button>
                </div>
            </div>

            <!-- No accept filter: firmware ships as .dat as well as .bin/.fw/.dfu, and a
                 picker that hides the file you were given is worse than no filter at all.
                 onFirmwareFileSelected blocks anything drastically bigger than a real DE1
                 image; the endpoint is the backstop (400 on empty, error event on bad CRC). -->
            <input type="file" id="firmware-file-input" class="hidden"
                   onchange="window.onFirmwareFileSelected(this)">
        </div>
    `;
}

// Render the app-update panel from an AppUpdateState snapshot (ws/v1/update).
// Re-rendered in place on every state change by initAppUpdateSection().
function renderAppUpdateBlock(state) {
    // The badge answers one question -- is the running build older than the newest
    // release in Decaid's repo -- and answers it the same way the skin cards do,
    // with the same compareVersions. Asking GitHub directly is what makes it work
    // everywhere: Decaid's own check never runs on macOS (UpdateCheckService
    // returns at its `if (_isMacOS)` guard, Sparkle owns updates there), so a badge
    // driven off its state machine was blank on exactly the platform being used.
    maybeCheckLatestRelease(DECAID_REPO, ['rea']);

    const current = settingsCache.appInfo?.version || state?.currentVersion || '';
    const latest = (settingsCache.latestReleases || {})[DECAID_REPO];
    // No tag yet (still fetching, offline, or rate-limited) is not "up to date" --
    // say nothing rather than guess.
    const known = !!latest && !!current;
    const needsUpdate = known && compareVersions(current, latest) < 0;
    const latestPlain = String(latest || '').replace(/^v/i, '');

    const base = 'text-[16px] font-semibold px-[8px] py-[2px] rounded-full';
    const badge = !known ? ''
        : needsUpdate
            ? `<span class="${base} bg-[#da515e]/15 text-[#da515e]" data-i18n-key="Update available">Update available</span>`
            : `<span class="${base} bg-[#0ca581]/15 text-[#0ca581]" data-i18n-key="Up to date">Up to date</span>`;

    const phase = state?.phase;
    const busy = phase === 'downloading' || phase === 'installing';
    const pct = Math.round((state?.progress || 0) * 100);
    const btn = 'inline-flex items-center justify-center h-[40px] px-[20px] rounded-[40px] text-[16px] font-bold';

    // In-app install is Android-only (AppUpdateState.installable is `_isAndroid &&
    // hasUpdate`). Everywhere else the release page is the only way through, so
    // that is what the button offers. Plain same-frame navigation: the tablet
    // webview has no second window to open, and the host hands the URL to the OS
    // browser itself.
    let action = '';
    if (busy) {
        action = `<button disabled class="${btn} bg-[#385a92] opacity-50 text-white">${getTranslation('Updating')}…</button>`;
    } else if (needsUpdate && state?.installable) {
        action = `<button onclick="window.installAppUpdate()" class="${btn} bg-[#2e7d32] text-white">${getTranslation('Update App')}</button>`;
    } else if (needsUpdate) {
        action = `<a href="${DECAID_RELEASES_URL}" class="${btn} bg-[#385a92] text-white no-underline">${getTranslation('Download')}</a>`;
    }

    const progressBar = phase === 'downloading'
        ? `<div class="w-full h-[10px] rounded-full bg-[#c9c9c9] overflow-hidden mt-2"><div class="h-full bg-[#385a92] transition-[width] duration-200" style="width:${pct}%"></div></div>`
        : '';

    // Card *contents* only -- this renders into #app-update-section, which carries
    // the same box classes as the Version card it sits beside.
    return `
        <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]" data-i18n-key="Update">Update</p>
        <div class="flex items-center gap-[10px] flex-wrap">
            ${badge}
            ${needsUpdate ? `<span class="text-[24px] font-['Inter:Regular',sans-serif]">${latestPlain}</span>` : ''}
            ${action}
        </div>
        ${progressBar}
    `;
}

// Connect ws/v1/update and keep #app-update-section in sync with AppUpdateState.
// The badge no longer comes from here -- it compares the running build against
// Decaid's newest GitHub release (renderAppUpdateBlock) -- so this exists only for
// the Android in-app install: `installable`, and the download/install progress.
// The check on open is what populates `installable` there; it is deliberately
// silent, since on macOS Decaid answers it with nothing at all.
function initAppUpdateSection() {
    const send = (command) => {
        try {
            sendUpdateCommand({ command });
        } catch (error) {
            ui.showToast(error.message, 5000, 'error');
        }
    };
    window.installAppUpdate = () => send('install');

    connectUpdateWebSocket((data) => {
        // Command-level errors arrive as a direct {error[, url]} reply.
        if (data && data.error && !data.phase) {
            ui.showToast(data.url ? `${data.error} — ${data.url}` : data.error, 5000, 'error');
            return;
        }
        settingsCache.appUpdateState = data;
        const section = document.getElementById('app-update-section');
        if (section) section.innerHTML = renderAppUpdateBlock(data);
    }, () => send('check'));
}

// Render updates settings
export function renderUpdatesSettings() {
    const appInfo = settingsCache.appInfo;
    const infoAvailable = !!appInfo;
    const appInfoDetails = infoAvailable ? `
                <div class="grid gap-4 sm:grid-cols-2">
                    <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)]">
                        <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]" data-i18n-key="Version">Version</p>
                        <p class="text-[24px] font-['Inter:Regular',sans-serif]">${appInfo.version} (${appInfo.buildNumber})</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">Full: ${appInfo.fullVersion}</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">${formatBuildTimestamp(appInfo.buildTime)}</p>
                    </div>
                    <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)]">
                        <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]" data-i18n-key="Source">Source</p>
                        <p class="text-[24px] font-['Inter:Regular',sans-serif]">${appInfo.branch}</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">Commit: ${appInfo.commitShort}</p>
                        <p class="text-[16px] text-[var(--text-secondary)]">App Store: ${appInfo.appStore ? 'Yes' : 'No'}</p>
                    </div>
                </div>
            ` : `
                <div class="rounded-[10px] border border-[#c9c9c9] p-4 bg-[var(--box-color)]">
                    <p class="text-[20px] font-['Inter:Bold',sans-serif] font-bold text-[#385a92]" data-i18n-key="Update info">Update info</p>
                    <p class="text-[24px] font-['Inter:Regular',sans-serif]" data-i18n-key="Fetching build metadata...">Fetching build metadata...</p>
                </div>
            `;

    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Updates Settings">Updates Settings</p>
            </div>

            <div class="content-stretch flex flex-col items-start relative w-full space-y-10">
                <div class="flex flex-col gap-[30px] w-full">
                    <div class="flex flex-col gap-3">
                        <div class="flex items-center justify-between">
                            <div class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px]" data-i18n-key="Firmware Update">Firmware Update</div>
                            <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"Check></button>
                        </div>
                        <p class="text-[24px] text-[var(--text-primary)]" data-i18n-key="Check for firmware updates">Check for firmware updates</p>
                    </div>

                    <div class="flex flex-col gap-3">
                        <div class="flex items-center justify-between">
                            <div class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px]">App Update</div>
                            <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold" data-i18n-key="Check">Check</button>
                        </div>
                        <p class="text-[24px] text-[var(--text-primary)]" data-i18n-key="Check for application updates">Check for application updates</p>
                    </div>
                </div>

                <div class="w-full flex flex-col gap-4">
                    <div class="flex flex-col gap-4">
                        <p class="font-['Inter:Bold',sans-serif] font-bold text-[#385a92] text-[30px]">Decaid Information</p>
                        ${appInfoDetails}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Render general settings
export function renderGeneralSettings() {
    return `
        <div class="content-stretch flex flex-col gap-[60px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="General Settings">General Settings</p>
            </div>

            <div class="text-[24px] text-[var(--text-primary)] p-4" data-i18n-key="Select a category from the navigation panel to view and edit settings.">
                Select a category from the navigation panel to view and edit settings.
            </div>
        </div>
    `;
}

// Render subcategories for a selected main category
export function renderSubcategories(mainCategoryKey) {
    const category = settingsTree[mainCategoryKey];
    if (!category || !category.subcategories || category.subcategories.length === 0) {
        return `<div class="p-4 text-center text-gray-500" data-i18n-key="No sub-categories.">No sub-categories.</div>`;
    }

    let subcategoryItems = '';
    category.subcategories
        .filter((subcat) => !subcat.bengleOnly || isBengleMachine())
        .forEach((subcat) => {
        const prefixMatch = subcat.name.match(/^(\d+\.\s*)/);
        const prefix = prefixMatch ? prefixMatch[1] : '';
        const label = prefix ? subcat.name.slice(prefix.length) : subcat.name;
        subcategoryItems += `
            <li>
                <button class="settings-subnav-btn w-full text-left px-4 py-3 rounded-lg text-[24px] text-[#959595] hover:text-white hover:bg-[#2c4a7a] flex items-center"
                        data-category="${subcat.settingsCategory}">
                    ${prefix}<span data-i18n-key="${subcat.i18nKey || label}">${label}</span>
                </button>
            </li>
        `;
    });

    return `<ul class="space-y-1">${subcategoryItems}</ul>`;
}


// Cache for loading promises to prevent multiple simultaneous requests
let settingsLoadingPromises = {};

// Preload all settings in the background
export async function preloadSettings() {
    // If we're already preloading, return the existing promise
    if (settingsLoadingPromises.preload) {
        return settingsLoadingPromises.preload;
    }

    settingsLoadingPromises.preload = _preloadSettingsInternal();
    return settingsLoadingPromises.preload;
}

// Internal function to preload all settings
async function _preloadSettingsInternal() {
    try {
        await openDB();
        // Only show "Loading" state if we have no stale IDB data to display
        if (!settingsCache.rea)         settingsCache.reaLoading         = true;
        if (!settingsCache.de1)         settingsCache.de1Loading         = true;
        if (!settingsCache.de1Advanced) settingsCache.de1AdvancedLoading = true;
        settingsCache.appInfoLoading = true;

        // Reset error flags
        settingsCache.reaError = null;
        settingsCache.de1Error = null;
        settingsCache.de1AdvancedError = null;
        settingsCache.appInfoError = null;

        // Fetch all settings in parallel using Promise.allSettled to handle individual failures
        const [reaSettingsResult, de1SettingsResult, de1AdvancedSettingsResult, appInfoResult, machineInfoResult, skinInfoResult, allSkinsResult, workflowResult] = await Promise.allSettled([
            getReaSettings(),
            getDe1Settings(),
            getDe1AdvancedSettings(),
            getAppInfo(),
            getMachineInfo(),
            getDefaultSkin(),
            getAllSkins(),
            getWorkflow()
        ]);

        // Process results and handle errors appropriately
        let reaSettings = null;
        let de1Settings = null;
        let de1AdvancedSettings = null;
        let appInfo = null;
        let machineInfo = null;

        let usedCache = false;

        // Handle REA settings result — fall back to IDB on any failure
        if (reaSettingsResult.status === 'fulfilled') {
            reaSettings = reaSettingsResult.value;
            try { await setSetting('settings-rea', reaSettings); } catch(e) { /* non-fatal */ }
        } else {
            console.error('Error loading Decaid settings:', reaSettingsResult.reason);
            settingsCache.reaError = reaSettingsResult.reason?.message;
            try { reaSettings = await getSetting('settings-rea'); } catch(e) { /* non-fatal */ }
            if (reaSettings) usedCache = true;
        }

        // Handle DE1 settings result — fall back to IDB on any failure
        if (de1SettingsResult.status === 'fulfilled') {
            de1Settings = de1SettingsResult.value;
            try { await setSetting('settings-de1', de1Settings); } catch(e) { /* non-fatal */ }
        } else {
            console.error('Error loading DE1 settings:', de1SettingsResult.reason);
            settingsCache.de1Error = de1SettingsResult.reason?.message;
            try { de1Settings = await getSetting('settings-de1'); } catch(e) { /* non-fatal */ }
            if (de1Settings) usedCache = true;
        }

        // Handle DE1 advanced settings result — fall back to IDB on any failure
        if (de1AdvancedSettingsResult.status === 'fulfilled') {
            de1AdvancedSettings = de1AdvancedSettingsResult.value;
            try { await setSetting('settings-de1Advanced', de1AdvancedSettings); } catch(e) { /* non-fatal */ }
        } else {
            console.error('Error loading DE1 advanced settings:', de1AdvancedSettingsResult.reason);
            settingsCache.de1AdvancedError = de1AdvancedSettingsResult.reason?.message;
            try { de1AdvancedSettings = await getSetting('settings-de1Advanced'); } catch(e) { /* non-fatal */ }
            if (de1AdvancedSettings) usedCache = true;
        }

        // All critical settings failed and no IDB cache — show retry UI, auto-retry in background
        if (!reaSettings && !de1Settings && !de1AdvancedSettings) {
            const contentArea = document.getElementById('settings-content-area');
            if (contentArea) {
                contentArea.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full gap-[40px] p-8">
                        <p class="text-[var(--text-primary)] text-[30px] font-bold text-center">Unable to reach De1</p>
                        <p class="text-[var(--text-primary)] text-[24px] text-center opacity-60">Retrying automatically every 3 seconds...</p>
                        <button class="bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold"
                                onclick="window.retryLoadSettings()">${getTranslation('Retry')} ${getTranslation('Now')}</button>
                    </div>`;
            }
            ui.showToast('Unable to reach De1. Retrying...', 3000, 'warning');
            setTimeout(() => {
                preloadSettings().then(() => {
                    if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
                });
            }, 3000);
            return { reaSettings: null, de1Settings: null, de1AdvancedSettings: null, appInfo: null, machineInfo: null };
        }

        if (usedCache) {
            ui.showToast('Some settings loaded from cache — showing last known values', 4000, 'warning');
        }

        // Handle App Info result
        if (appInfoResult.status === 'fulfilled') {
            appInfo = appInfoResult.value;
        } else {
            console.error('Error loading app info:', appInfoResult.reason);
            settingsCache.appInfoError = appInfoResult.reason?.message || 'Failed to load update information';
        }

        // Handle Machine Info result
        if (machineInfoResult.status === 'fulfilled') {
            machineInfo = machineInfoResult.value;
        } else {
            console.error('Error loading machine info:', machineInfoResult.reason);
            settingsCache.machineInfoError = machineInfoResult.reason?.message || 'Failed to load machine details';
        }

        // Handle Skin Info result
        if (skinInfoResult.status === 'fulfilled') {
            settingsCache.skinInfo = skinInfoResult.value;
        } else {
            console.error('Error loading skin info:', skinInfoResult.reason);
            settingsCache.skinInfoError = skinInfoResult.reason?.message || 'Failed to load skin info';
        }

        // Handle All Skins result
        if (allSkinsResult.status === 'fulfilled') {
            settingsCache.allSkins = allSkinsResult.value;
        } else {
            console.error('Error loading all skins:', allSkinsResult.reason);
            settingsCache.allSkinsError = allSkinsResult.reason?.message || 'Failed to load skins';
        }


        // Handle Workflow result
        if (workflowResult.status === 'fulfilled') {
            settingsCache.workflow = workflowResult.value;
        } else {
            console.error('Error loading workflow data:', workflowResult.reason);
        }

        // Update cache with results
        settingsCache.rea = reaSettings ? { ...reaSettings, ...pendingChanges.rea } : reaSettings;
        settingsCache.de1 = de1Settings;
        settingsCache.de1Advanced = de1AdvancedSettings;
        settingsCache.appInfo = appInfo;
        settingsCache.machineInfo = machineInfo;
        // Keep the shared Bengle gate fresh (the machine may have changed since
        // boot); a failed fetch keeps the last known model rather than wiping it.
        if (machineInfo) setMachineModel(machineInfo.model);

        // Update loading flags
        settingsCache.reaLoading = false;
        settingsCache.de1Loading = false;
        settingsCache.de1AdvancedLoading = false;
        settingsCache.appInfoLoading = false;
        settingsCache.machineInfoLoading = false;
        settingsCache.skinInfoLoading = false;

        return { reaSettings, de1Settings, de1AdvancedSettings, appInfo, machineInfo };
    } catch (error) {
        console.error('Error during settings preload:', error);
        ui.showToast('Failed to preload settings', 5000, 'error');

        // Ensure loading flags are reset even in case of error
        settingsCache.reaLoading = false;
        settingsCache.de1Loading = false;
        settingsCache.de1AdvancedLoading = false;

        return { reaSettings: null, de1Settings: null, de1AdvancedSettings: null };
    } finally {
        // Clear the preload promise after completion
        delete settingsLoadingPromises.preload;
    }
}


// Helper function to get title for a category
function getCategoryTitle(category) {
    switch(category) {
        case 'rea': return 'Decaid Settings';
        case 'quickadjustments': return 'Quick Adjustments';
        case 'flowmultiplier': return 'Flow Multiplier Settings';
        case 'steam': return 'Steam Settings';
        case 'hotwater': return 'Hot Water Settings';
        case 'watertank': return 'Water Tank Settings';
        case 'flush': return 'Flush Settings';
        case 'de1': return 'DE1 Settings';
        case 'fanthreshold': return 'Fan Threshold Settings';
        case 'usbchargermode': return 'USB Charger Settings';
        case 'cupwarmer': return 'Cup Warmer';
        case 'ledstrip': return 'Lighting';
        case 'machineinfo': return 'Machine Info';
        case 'calib_sensors': return 'Sensor Calibration';
        case 'de1advanced': return 'Before espresso starts';
        case 'homeassistant': return 'Home Assistant';
        default: return 'Settings';
    }
}

function handleSettingsLanguageChange() {
    translatePage();
    if (activeSettingsCategory) {
        updateSettingsContentArea(activeSettingsCategory);
    }
}

// Initialize the settings page
export async function initializeSettings({ initialMainCategory = null, initialCategory = null, initialReaChanges = {} } = {}) {
    const savedLocation = readSettingsLocation();
    const restoredMainCategory = initialMainCategory || savedLocation?.mainCategory || 'quickadjustments';
    const restoredCategory = initialCategory
        || (savedLocation?.mainCategory === restoredMainCategory ? savedLocation.category : null);
    resetPendingChanges();
    // Pre-seed cache from IDB backup for instant render, then fetch from network in background
    await preSeedFromIDB();
    Object.entries(initialReaChanges).forEach(([key, value]) => updateReaSetting(key, value, false));
    preloadSettings().then(() => {
        if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
    });

    // Initialize WebSocket for live device state updates
    initDeviceWebSocket();

    // Initialize WebSocket for live display state updates
    initDisplayWebSocket();

    // Set up event listeners
    const cancelBtn = document.getElementById('cancel-settings-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            resetPendingChanges();
            // Exiting settings straight from the Lighting page must not leave a
            // preview colour latched on the strip — and a deferred cross-state
            // palette PUT flushes first (flush → clear, one transition). Also
            // release this page's manual sequence run (a state-triggered run
            // is untouched -- it belongs to app.js, not this page).
            ledFlushDirty();
            ledClearPreview();
            ledSeqReleaseManual();
            // …and exiting from the Load Cells verify step must hand the
            // scale WS back to the main page's live weight readout.
            calReleaseScaleWs();
            // …and exiting from the Cup Warmer page must stop its revalidate poll.
            stopCupWarmerPoll();
            loadPage('index.html');
        });
    }

    const saveBtn = document.getElementById('save-settings-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const visualizerAutoUpload = document.getElementById('visualizer-auto-upload');
            if (visualizerAutoUpload) {
                localStorage.setItem('visualizerAutoUpload', visualizerAutoUpload.checked.toString());
            }
            try {
                await flushPendingChanges();
            } catch (error) {
                console.error('Error saving settings:', error);
                ui.showToast(`Failed to save settings: ${error.message}`, 5000, 'error');
                return;
            }
            ui.showToast('Settings updated', 3000, 'success');
            // Exiting settings straight from the Lighting page must not leave a
            // preview colour latched on the strip — and a deferred cross-state
            // palette PUT flushes first (flush → clear, one transition). Also
            // release this page's manual sequence run (a state-triggered run
            // is untouched -- it belongs to app.js, not this page).
            ledFlushDirty();
            ledClearPreview();
            ledSeqReleaseManual();
            // …and exiting from the Load Cells verify step must hand the
            // scale WS back to the main page's live weight readout.
            calReleaseScaleWs();
            // …and exiting from the Cup Warmer page must stop its revalidate poll.
            stopCupWarmerPoll();
            loadPage('index.html');
        });
    }

    const mainCategoriesPanel = document.getElementById('main-categories-panel');
    const subCategoriesPanel = document.getElementById('sub-categories-panel');
    let activeMainCategoryKey = restoredMainCategory;

    const activateSubcategory = button => {
        subCategoriesPanel?.querySelectorAll('.settings-subnav-btn').forEach(item => {
            const active = item === button;
            item.classList.toggle('text-white', active);
            item.classList.toggle('bg-[#2c4a7a]', active);
            item.classList.toggle('text-[#959595]', !active);
        });
        activeSettingsCategory = button.dataset.category;
        writeSettingsLocation(activeMainCategoryKey, activeSettingsCategory);
        updateSettingsContentArea(activeSettingsCategory);
    };

    const activateMainCategory = (button, requestedCategory = null) => {
        document.querySelectorAll('.settings-nav-btn').forEach(item => {
            const active = item === button;
            item.classList.toggle('text-white', active);
            item.classList.toggle('bg-[#2c4a7a]', active);
            item.classList.toggle('text-[#959595]', !active);
        });
        activeMainCategoryKey = button.id.replace(/-btn$/, '').replace(/-/g, '');
        if (subCategoriesPanel) subCategoriesPanel.innerHTML = renderSubcategories(activeMainCategoryKey);
        const subcategories = Array.from(subCategoriesPanel?.querySelectorAll('.settings-subnav-btn') || []);
        const target = subcategories.find(item => item.dataset.category === requestedCategory) || subcategories[0];
        if (target) activateSubcategory(target);
    };

    mainCategoriesPanel?.addEventListener('click', event => {
        const button = event.target.closest('.settings-nav-btn');
        if (button) activateMainCategory(button);
    });
    subCategoriesPanel?.addEventListener('click', event => {
        const button = event.target.closest('.settings-subnav-btn');
        if (button) activateSubcategory(button);
    });

    const firstMainCategoryBtn = document.getElementById(`${restoredMainCategory}-btn`)
        || document.querySelector('.settings-nav-btn');
    if (firstMainCategoryBtn) activateMainCategory(firstMainCategoryBtn, restoredCategory);

    setupSettingsSearch((mainCategory, category) => {
        const mainButton = document.getElementById(`${mainCategory}-btn`);
        if (mainButton) activateMainCategory(mainButton, category);
    });

    // Apply translations to the settings page
    await setLanguage(getCurrentLanguage());

    // Re-translate settings content whenever language changes
    if (!settingsLanguageListenerInstalled) {
        document.addEventListener('streamline:languagechange', handleSettingsLanguageChange);
        settingsLanguageListenerInstalled = true;
    }

    // Expose update functions to global scope for inline event handlers
    window.updateReaSetting = updateReaSetting;
    window.exitToDecentDashboard = exitToDecentDashboard;
    window.updateDe1Setting = updateDe1Setting;
    window.updateDe1AdvancedSetting = updateDe1AdvancedSetting;
    // The "Defaults for cafe" preset from insight-js (src/views/settings.js):
    // idle heater near boiling and the warm-up test cut short, trading standby
    // power for the shortest wait before the first espresso.
    window.applyFastStartDefaults = function() {
        updateDe1AdvancedSettings({
            heaterIdleTemp: 99,
            heaterPh1Flow: 2,
            heaterPh2Flow: 4,
            heaterPh2Timeout: 1,
        });
        ui.showToast(getTranslation('Fast Start Defaults'), 2000, 'success');
    };
    window.setScreensaverEnabled = function(enabled) {
        localStorage.setItem('screensaverEnabled', enabled ? 'true' : 'false');
        // If turning OFF while currently shown, hide immediately — the gate in
        // app.js only checks on state transition, so without this the overlay
        // would persist until next wake.
        //
        // hideScreensaver(), NOT the old deactivateScreensaver(): that one sent
        // setMachineState('idle'), so turning a DISPLAY PREFERENCE off woke the
        // machine. Changing a setting is not a wake.
        if (!enabled && ui.isScreensaverActive()) {
            ui.hideScreensaver();
        }
        // The other half of the either/or: turning the image saver on means the
        // black cover is off.
        if (enabled) apiSetBlackScreenSaver(false);
        ui.showToast(`${getTranslation('Screen saver')} ${enabled ? getTranslation('Enabled') : getTranslation('Disabled')}`, 2000, 'success');
        if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
    };

    window.handleScreensaverCycleChange = function(value) {
        const applied = ui.setScreensaverCycleSeconds(value);
        const input = document.getElementById('screensaver-cycle-seconds');
        if (input) input.value = applied;
        ui.showToast(`Cycle set to ${applied}s`, 2000, 'success');
    };

    window.setBlackScreenSaver = function(enabled) {
        apiSetBlackScreenSaver(enabled);
        // Either/or: a black cover IS the screen saver, so switching it on turns
        // the image saver off. Switching it off hands the image saver back.
        localStorage.setItem('screensaverEnabled', enabled ? 'false' : 'true');
        // Repaint a saver that is already up, so the change is visible now rather
        // than only after the next sleep.
        if (ui.isScreensaverActive()) {
            ui.hideScreensaver();
            ui.activateScreensaver();
        }
        // "Saved" is an existing translated key in the de1 gui translation sheet;
        // showToast does not translate, so do it here. The brightness itself is
        // applied on the next sleep -- changing it must not dim the screen being read.
        ui.showToast(getTranslation('Saved'), 2000, 'success');
        if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
    };

    window.setWaterTankUnit = function(unit) {
        const next = unit === 'ml' ? 'ml' : 'mm';
        localStorage.setItem('waterTankUnit', next);
        if (typeof window.refreshWaterTankUnit === 'function') window.refreshWaterTankUnit();
        if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
    };

    window.addScreensaverFiles = async function(files) {
        if (!files || files.length === 0) return;
        const readFile = f => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(f);
        });
        try {
            const newImages = await Promise.all(Array.from(files).map(readFile));
            screensaverImagesCache = [...screensaverImagesCache, ...newImages];
            await openDB();
            await setSetting('screensaverImages', screensaverImagesCache);
            ui.setScreensaverImages(screensaverImagesCache);
            ui.showToast(`${newImages.length} image${newImages.length !== 1 ? 's' : ''} added`, 2000, 'success');
            if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
        } catch (e) {
            ui.showToast('Failed to save images', 3000, 'error');
        }
    };

    window.clearScreensaverImages = async function() {
        try {
            screensaverImagesCache = [];
            await openDB();
            await setSetting('screensaverImages', []);
            ui.setScreensaverImages([]);
            ui.showToast('Custom images cleared', 2000, 'success');
            if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
        } catch (e) {
            ui.showToast('Failed to clear images', 3000, 'error');
        }
    };
    window.updateHeaterVoltage = async function(value) {
        await window.updateDe1AdvancedSetting('heaterVoltage', value);
        ui.showToast(getTranslation('Restart the machine after changing voltage for the setting to take effect.'), 6000, 'warning');
    };
    window.resetDe1Settings = async function() {
        try {
            await resetDe1Settings();
            settingsCache.de1Advanced = await getDe1AdvancedSettings();
            settingsCache.de1 = await getDe1Settings();
            ui.showToast('Machine settings reset to defaults', 3000, 'success');
            if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
        } catch (error) {
            ui.showToast(`Failed to reset settings: ${error.message}`, 5000, 'error');
        }
    };

    // A plugin serves a web UI only if its manifest declares an http endpoint
    // named "ui" -- Decaid routes /api/v1/plugins/<id>/<endpoint> from that
    // declaration, so anything else 404s. Built off API_BASE_URL, not a literal
    // localhost, so it stays right when the bridge hostname is configured.

    // Plugin manager
    window.loadPluginList = async function() {
        const container = document.getElementById('plugin-list-container');
        if (!container) return;
        try {
            const { getPlugins } = await import('../modules/api.js');
            const plugins = await getPlugins();
            if (!plugins || plugins.length === 0) {
                container.innerHTML = `<p class="text-[24px] text-[var(--text-primary)] opacity-60" data-i18n-key="No plugins installed.">No plugins installed.</p>`;
                return;
            }
            // Manifest text is third-party content -- plugins install from arbitrary
            // GitHub repos -- so every field is escaped before it reaches innerHTML.
            container.innerHTML = plugins.map((p, i) => {
                const uiUrl = pluginUiUrl(p);
                const description = pluginDescription(p);
                return `
                ${i > 0 ? '<div class="h-0 relative w-full"><hr class="border-t border-[#c9c9c9] w-full" /></div>' : ''}
                <div class="flex items-center justify-between w-full py-[30px] gap-[24px]">
                    <div class="flex flex-col gap-[8px] flex-1 min-w-0">
                        <div class="flex items-center gap-[12px] flex-wrap">
                            <span class="font-bold text-[#385a92] text-[28px] leading-tight">${escapeHtml(p.name || p.id)}</span>
                            <span class="text-[20px] text-[var(--text-primary)] opacity-50">v${escapeHtml(p.version || '?')}</span>
                            ${uiUrl ? `<a href="${escapeHtml(uiUrl)}" class="bg-[#385a92] h-[54px] px-[40px] rounded-[54px] text-white text-[22px] font-bold flex items-center justify-center" data-i18n-key="Open">Open</a>` : ''}
                        </div>
                        ${description ? `<p class="text-[22px] text-[var(--text-primary)] leading-[1.4] opacity-75">${escapeHtml(description)}</p>` : ''}
                    </div>
                    <div class="flex flex-col items-center gap-[6px] flex-shrink-0">
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                            <input type="checkbox"
                                   class="sr-only peer"
                                   ${p.loaded ? 'checked' : ''}
                                   data-plugin-id="${escapeHtml(p.id)}">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                        <span class="text-[18px] text-[var(--text-primary)] opacity-60">${p.loaded ? 'Enabled' : 'Disabled'}</span>
                    </div>
                </div>
            `;
            }).join('');

            // Listener rather than an inline onchange: the id is manifest text, and
            // Decaid's id rule allows an apostrophe, which would end the JS string
            // in an inline handler. Nothing about an id can escape a data attribute.
            container.querySelectorAll('input[data-plugin-id]').forEach(input => {
                input.addEventListener('change', function () {
                    window.togglePlugin(this.dataset.pluginId, this.checked, this);
                });
            });
        } catch (err) {
            logger.error('Failed to load plugins:', err);
            container.innerHTML = `<p class="text-[22px] text-red-500">Failed to load plugins: ${err.message}</p>`;
        }
    };

    const DYE2_PLUGIN_ID = 'dye2.reaplugin';

    // Bean/grinder identity lives in Decaid's workflow context, not inside DYE2,
    // and every ShotRecord embeds a copy of the workflow at pull time. DYE2 cannot
    // clear it on the way out: Decaid bumps the plugin generation *before* calling
    // onUnload, so any fetch from onUnload is rejected as "plugin generation
    // changed" and never leaves the tablet. Decaid has no native UI that clears
    // these fields either (WorkflowContext.clearBeanBatch/clearGrinder have zero
    // callers), so a disabled DYE2 would leave the last bean stamping every
    // future shot indefinitely. Clear here, where switching the plugin off is the
    // user's explicit intent -- unlike a reload, upgrade, removal, failed load,
    // or app shutdown, which all also unload plugins but must keep the selection.
    //
    // Cleared: everything DYE2 alone writes as bean/equipment identity, including
    // the basket, grinder RPM, and auto-favourite note it stores under extras.
    // extras.note is the auto-favourite's "Note" field, copied forward under the
    // same copyMask as beans and basket -- recipe payload, not the user's tasting
    // notes, which live in the shot annotation's espressoNotes and are untouched.
    //
    // Left alone on purpose: targetDoseWeight/targetYield, core shot params with
    // app defaults that other skins rely on and DYE2 does not exclusively own,
    // and `profile`, which is the espresso profile the machine actually runs
    // (non-nullable in Decaid's Workflow model, and not stale metadata).
    async function clearDye2WorkflowContext() {
        try {
            await updateWorkflow({
                context: {
                    beanBatchId: null, coffeeName: null, coffeeRoaster: null,
                    grinderId: null, grinderModel: null, grinderSetting: null,
                    baristaName: null, drinkerName: null,
                    extras: { basketId: null, basketName: null, rpm: null, note: null },
                }
            });
        } catch (err) {
            // Turning the plugin off matters more than the cleanup succeeding.
            logger.warn('Failed to clear DYE2 workflow context:', err);
        }
    }

    window.togglePlugin = async function(pluginId, enable, toggleEl) {
        const toggle = toggleEl || null;
        // The input sits inside the <label> that draws the switch; the status text
        // is the label's sibling, not the input's (whose sibling is the track div).
        const label  = toggle?.closest('label')?.nextElementSibling;
        if (toggle) toggle.disabled = true;
        try {
            const { enablePlugin, disablePlugin } = await import('../modules/api.js');
            if (enable) {
                await enablePlugin(pluginId);
            } else {
                // Before the plugin loses its ability to do this itself.
                // ponytail: covers the switch in this skin only -- disabling DYE2
                // from Decaid's own settings page bypasses it. Move to
                // PluginLoaderService.disablePlugin upstream if that path matters.
                if (pluginId === DYE2_PLUGIN_ID) await clearDye2WorkflowContext();
                await disablePlugin(pluginId);
            }
            if (label) label.textContent = enable ? 'Enabled' : 'Disabled';
            ui.showToast(`Plugin ${enable ? 'enabled' : 'disabled'}`, 2500, 'success');
        } catch (err) {
            logger.error('Failed to toggle plugin:', err);
            ui.showToast(`Failed: ${err.message}`, 4000, 'error');
            // Revert toggle on failure
            if (toggle) toggle.checked = !enable;
            if (label) label.textContent = enable ? 'Disabled' : 'Enabled';
        } finally {
            if (toggle) toggle.disabled = false;
        }
    };

    window.updateTalkToDecentUI = async function() {
        const loggedOut = document.getElementById('talkdecent-logged-out');
        const loggedIn  = document.getElementById('talkdecent-logged-in');
        if (!loggedOut || !loggedIn) return;
        try {
            const res = await fetch(`${API_BASE_URL}/account/decent`);
            const { loggedIn: linked } = await res.json();
            if (linked) {
                loggedOut.classList.add('hidden');
                loggedIn.classList.remove('hidden');
                const token    = window.__REA_PROXY_TOKEN__;
                const serialEl = document.getElementById('talkdecent-account-serial');
                if (token && serialEl) {
                    try {
                        const snRes = await fetch(`${API_BASE_URL}/account/proxy/support/api/sn`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        const snText = (await snRes.text()).trim();
                        const serial = snText.split(/[\r\n]/)[0].trim();
                        serialEl.textContent = serial ? `Serial: ${serial}` : '';
                    } catch (_) {
                        serialEl.textContent = '';
                    }
                }
                window.talkDecentFetchEmails();
            } else {
                loggedIn.classList.add('hidden');
                loggedOut.classList.remove('hidden');
            }
        } catch (_) {
            loggedIn.classList.add('hidden');
            loggedOut.classList.remove('hidden');
        }
    };

    function updateTalkDecentComposePreview(subject, body) {
        const tile = document.getElementById('talkdecent-compose-preview');
        if (!tile) return;
        if (!subject && !body) {
            tile.innerHTML = '<p class="text-[20px] text-[var(--low-contrast-white)]">Tap to compose a message…</p>';
            return;
        }
        let html = '';
        if (subject) html += `<p class="text-[19px] font-semibold text-[var(--text-primary)] leading-tight mb-[6px]">${escapeHtml(subject)}</p>`;
        if (body) {
            const snippet = body.length > 120 ? body.substring(0, 120) + '…' : body;
            html += `<p class="text-[18px] text-[var(--low-contrast-white)] leading-snug whitespace-pre-wrap">${escapeHtml(snippet)}</p>`;
        }
        tile.innerHTML = html;
    }

    window.openTalkDecentMessageEditor = function() {
        const currentSubject = document.getElementById('talkdecent-subject')?.value || '';
        const currentBody    = document.getElementById('talkdecent-message')?.value || '';
        openNotesModal(currentBody, ({ subject, body }) => {
            const subjectEl = document.getElementById('talkdecent-subject');
            const bodyEl    = document.getElementById('talkdecent-message');
            if (subjectEl) subjectEl.value = subject || '';
            if (bodyEl)    bodyEl.value    = body    || '';
            updateTalkDecentComposePreview(subject, body);
        }, {
            title: 'New Message',
            subject: currentSubject,
            subjectPlaceholder: 'What can we help you with?',
        });
    };

    window.sendDecentMessage = async function() {
        const subject   = (document.getElementById('talkdecent-subject')?.value || '').trim();
        const message   = (document.getElementById('talkdecent-message')?.value || '').trim();
        const statusEl  = document.getElementById('talkdecent-send-status');
        const sendBtn   = document.getElementById('talkdecent-send-btn');
        const token     = window.__REA_PROXY_TOKEN__;

        if (!subject) {
            if (statusEl) statusEl.innerHTML = '<span class="text-red-500">Please enter a subject.</span>';
            return;
        }
        if (!message) {
            if (statusEl) statusEl.innerHTML = '<span class="text-red-500">Please enter a message.</span>';
            return;
        }
        if (!token) {
            if (statusEl) statusEl.innerHTML = '<span class="text-red-500">No proxy token available.</span>';
            return;
        }

        if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }
        if (statusEl) statusEl.innerHTML = '';

        const attachMachine = document.getElementById('talkdecent-attach-machine')?.checked;

        try {
            let body = message;
            const machineInfo = settingsCache.machineInfo;
            const appInfo     = settingsCache.appInfo;
            if (attachMachine && (machineInfo || appInfo)) {
                body += '\n\n---\n**Machine Info**';
                if (machineInfo?.model)        body += `\n- Model: ${machineInfo.model}`;
                if (machineInfo?.version)      body += `\n- Firmware: ${machineInfo.version}`;
                if (machineInfo?.serialNumber) body += `\n- Serial: ${machineInfo.serialNumber}`;
                if (appInfo?.version)          body += `\n- App version: ${appInfo.version}`;
            }
            const params = new URLSearchParams({ subject, body });
            const res = await fetch(
                `${API_BASE_URL}/account/proxy/support/api/email?${params.toString()}`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            const text = (await res.text()).trim();
            if (!res.ok || text === '0') throw new Error('Message could not be delivered. Check your connection.');

            if (statusEl) statusEl.innerHTML = `
                <span class="text-green-600 font-bold text-[22px]">Message sent!</span>
                <span class="text-[20px] text-[var(--low-contrast-white)] ml-[8px]">Decent support will reply to your email.</span>`;
            document.getElementById('talkdecent-subject').value = '';
            document.getElementById('talkdecent-message').value = '';
            updateTalkDecentComposePreview('', '');
            window.talkDecentFetchEmails();
        } catch (err) {
            if (statusEl) statusEl.innerHTML = `<span class="text-red-500 text-[22px]">Error: ${err.message}</span>`;
        } finally {
            if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send Message'; }
        }
    };

    window.talkDecentRefresh = async function() {
        await window.talkDecentFetchEmails();
    };

    window.talkDecentFetchEmails = async function() {
        const token = window.__REA_PROXY_TOKEN__;
        if (!token) {
            await window.talkDecentRenderThread();
            return;
        }

        const statusEl   = document.getElementById('talkdecent-thread-status');
        const refreshBtn = document.getElementById('talkdecent-refresh-btn');
        if (refreshBtn) refreshBtn.disabled = true;

        try {
            const since = await getLatestEmailTimestamp();
            const url = new URL(`${API_BASE_URL}/account/proxy/support/api/emails`);
            if (since) url.searchParams.set('since', String(since));

            const res = await fetch(url.toString(), {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const text = await res.text();
            if (!res.ok || text.trim() === '0') throw new Error(`Failed to load messages`);

            const sanitized = text.replace(/"(\w+)":\s*,/g, '"$1": null,');
            const newEmails = JSON.parse(sanitized);
            if (Array.isArray(newEmails) && newEmails.length > 0) {
                await addEmails(newEmails);
            }
            await window.talkDecentRenderThread();
            if (statusEl) { statusEl.textContent = ''; statusEl.classList.add('hidden'); }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = `Could not load messages: ${err.message}`;
                statusEl.classList.remove('hidden');
            }
            await window.talkDecentRenderThread();
        } finally {
            if (refreshBtn) refreshBtn.disabled = false;
        }
    };

    window.talkDecentRenderThread = async function() {
        const container = document.getElementById('talkdecent-thread-messages');
        if (!container) return;

        let emails;
        try {
            emails = await getAllEmails();
        } catch (_) {
            emails = [];
        }

        if (!emails.length) {
            container.innerHTML = '<p class="text-center text-[18px] text-[var(--low-contrast-white)] py-[24px]">No messages yet. Send one below to start!</p>';
            return;
        }

        container.innerHTML = emails.map(msg => {
            const isDecent = msg.from_user && String(msg.from_user).trim();
            const date = msg.now
                ? new Date(msg.now * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '';
            const bodyText = escapeHtml(msg.body || msg.message || msg.subject || '');
            const subjectText = msg.subject ? escapeHtml(msg.subject) : '';

            if (isDecent) {
                const name = String(msg.from_user).trim();
                const avatarUrl = `https://decentespresso.com/img/cartoon_${encodeURIComponent(name)}_small.png`;
                return `
                    <div class="flex gap-[12px] items-start">
                        <img src="${avatarUrl}"
                             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
                             class="w-[40px] h-[40px] rounded-full flex-shrink-0 object-cover"
                             alt="${escapeHtml(name)}">
                        <div style="display:none" class="w-[40px] h-[40px] rounded-full bg-[#385a92] flex-shrink-0 items-center justify-center text-white text-[16px] font-bold">${escapeHtml(name[0].toUpperCase())}</div>
                        <div class="flex flex-col gap-[4px] max-w-[80%]">
                            <div class="flex items-center gap-[8px] flex-wrap">
                                <span class="text-[16px] font-semibold text-[#385a92]">${escapeHtml(name)}</span>
                                ${msg.automsg ? '<span class="text-[12px] px-[6px] py-[1px] rounded-full bg-[var(--button-grey)] text-[var(--low-contrast-white)]">auto</span>' : ''}
                                <span class="text-[14px] text-[var(--low-contrast-white)] opacity-60">${date}</span>
                            </div>
                            <div class="bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] rounded-[16px] rounded-tl-[4px] overflow-hidden">
                                ${subjectText ? `<div class="px-[16px] pt-[10px] pb-[8px] border-b border-[var(--profile-button-outline-color)]"><p class="text-[15px] font-semibold text-[var(--low-contrast-white)]">${subjectText}</p></div>` : ''}
                                <div class="px-[16px] py-[12px] text-[19px] text-[var(--text-primary)] whitespace-pre-wrap leading-[1.5]">${bodyText}</div>
                            </div>
                        </div>
                    </div>`;
            } else {
                return `
                    <div class="flex gap-[12px] items-start justify-end">
                        <div class="flex flex-col gap-[4px] max-w-[80%] items-end">
                            <span class="text-[14px] text-[var(--low-contrast-white)] opacity-60">${date}</span>
                            <div class="bg-[#385a92] rounded-[16px] rounded-tr-[4px] overflow-hidden">
                                ${subjectText ? `<div class="px-[16px] pt-[10px] pb-[8px] border-b border-white/20"><p class="text-[15px] font-semibold text-white/70">${subjectText}</p></div>` : ''}
                                <div class="px-[16px] py-[12px] text-[19px] text-white whitespace-pre-wrap leading-[1.5]">${bodyText}</div>
                            </div>
                        </div>
                    </div>`;
            }
        }).join('');

        container.scrollTop = container.scrollHeight;
    };

    window.openFeedbackDescriptionEditor = function() {
        const hiddenTA = document.getElementById('feedback-description');
        const currentText = hiddenTA ? hiddenTA.value : '';
        openNotesModal(currentText, (text) => {
            const ta = document.getElementById('feedback-description');
            if (ta) ta.value = text;
            const preview = document.getElementById('feedback-description-preview');
            if (!preview) return;
            if (text) {
                preview.textContent = text;
                preview.style.color = 'var(--text-primary)';
            } else {
                preview.textContent = 'Tap to write description…';
                preview.style.color = 'var(--low-contrast-white)';
            }
        });
    };

    window.selectFeedbackCategory = function(value) {
        document.getElementById('feedback-category').value = value;
        document.querySelectorAll('[data-feedback-card]').forEach(btn => {
            const active = btn.dataset.feedbackCard === value;
            btn.setAttribute('aria-pressed', active);
            btn.classList.toggle('bg-[#385a92]', active);
            btn.classList.toggle('border-[#385a92]', active);
            btn.classList.toggle('text-white', active);
            btn.classList.toggle('bg-[var(--box-color)]', !active);
            btn.classList.toggle('border-[var(--profile-button-outline-color)]', !active);
            btn.classList.toggle('text-[var(--text-primary)]', !active);
        });
    };

    window.submitFeedback = async function() {
        const category  = document.getElementById('feedback-category')?.value || 'bug';
        const title     = (document.getElementById('feedback-title')?.value || '').trim();
        const desc      = (document.getElementById('feedback-description')?.value || '').trim();
        const attachSys = document.getElementById('feedback-attach-sysinfo')?.checked;
        const statusEl  = document.getElementById('feedback-status');
        const submitBtn = document.getElementById('feedback-submit-btn');

        if (!title) {
            statusEl.innerHTML = '<span class="text-red-500" data-i18n-key="Please enter a title.">Please enter a title.</span>';
            return;
        }

        const fullDesc = `**${title}**\n\n${desc}`;

        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }
        statusEl.innerHTML = '';

        try {
            const { submitFeedback: submitToREA } = await import('../modules/api.js');
            const data = await submitToREA({
                description: fullDesc,
                type: category,
                includeLogs: attachSys,
                includeSystemInfo: attachSys,
            });
            statusEl.innerHTML = `
                <span class="text-green-600 font-bold text-[24px]" data-i18n-key="Submitted!">Submitted!</span>
                ${data.issueUrl ? `<a href="${data.issueUrl}"
                   class="ml-3 text-[#385a92] underline text-[22px]">View issue</a>` : ''}`;
            document.getElementById('feedback-title').value = '';
            document.getElementById('feedback-description').value = '';
            const preview = document.getElementById('feedback-description-preview');
            if (preview) {
                preview.textContent = 'Tap to write description…';
                preview.style.color = 'var(--low-contrast-white)';
            }
        } catch (err) {
            logger.error('Feedback submit error:', err);
            statusEl.innerHTML = `<span class="text-red-500 text-[22px]">Error: ${err.message}</span>`;
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = getTranslation('Submit'); }
        }
    };

    // --- DE1 sensor calibration handlers ---
    // Capture takes the DE1's own reading WHILE the machine runs, averaged
    // over the sample window so one noisy frame cannot set the correction.
    // It has to happen here and not at Apply time: by the time the user has
    // read their gauge and walked back to this page the machine is idle and
    // reports 0.
    window.sensorCalCapture = function(id) {
        const target = sensorCalTarget(id);
        const entry = sensorCalEntry(id);
        if (!target || entry.busy) return;
        const averaged = averageReadings(entry.samples, Date.now());
        const value = averaged !== null ? averaged : sensorCalLiveReading(target);
        if (value === null) {
            entry.error = 'No reading from the machine yet';
        } else {
            entry.captured = value;
            entry.capturedAt = Date.now();
            entry.error = '';
        }
        sensorCalRerender();
    };

    // Acknowledging is per visit, not per session -- sensorCalWarningAck is
    // re-armed on leaving the page.
    window.sensorCalWarningProceed = function() {
        ({ shown: sensorCalWarningShown, ack: sensorCalWarningAck } = sensorCalWarningNextState(
            { shown: sensorCalWarningShown, ack: sensorCalWarningAck }, 'ack').state);
        document.getElementById('sensor-cal-warning-modal')?.close();
    };

    // Declining leaves the page entirely rather than sitting on a live
    // calibration screen the user just said they did not want. Reuses the
    // settings sub-nav so the highlighted menu item follows.
    window.sensorCalWarningCancel = function() {
        document.getElementById('sensor-cal-warning-modal')?.close();
        document.querySelector('.settings-subnav-btn[data-category="calib_defaultload"]')?.click();
    };

    // Clearing the error re-opens initSensorCal's re-entry gate, so the
    // re-render below performs exactly one fresh attempt.
    window.sensorCalRetryLoad = function() {
        sensorCalLoadError = '';
        sensorCalRerender();
    };

    window.sensorCalInput = function(id, value) {
        const entry = sensorCalEntry(id);
        entry.measured = value;
        entry.error = '';
        sensorCalRerender();
    };

    window.sensorCalApply = async function(id) {
        const target = sensorCalTarget(id);
        const entry = sensorCalEntry(id);
        if (!target || entry.busy) return;
        const captured = entry.captured;
        const measured = parseSensorCalInput(entry.measured);
        if (captured === null || measured === null) return;
        const blocked = correctionBlocked(target.kind, captured, sensorCalToCelsius(id, measured));
        if (blocked) { entry.error = blocked; sensorCalRerender(); return; }
        // Captured BEFORE the write: this is what Restore puts back.
        const priorValue = entry.current;
        entry.busy = true; entry.error = ''; sensorCalRerender();
        try {
            await setSensorCalibration(id, captured, sensorCalToCelsius(id, measured));
            // The 202 is the BLE write ack, not a settled value — read it back
            // rather than paint the preview as fact.
            await sensorCalRead(id);
            await sensorCalRememberPrevious(id, priorValue);
            // One observation, spent. Leaving the pair on screen invites a
            // second Apply, which corrects a second time.
            entry.captured = null; entry.capturedAt = 0; entry.measured = '';
            ui.showToast(`${target.label} calibration updated`, 3000, 'success');
        } catch (error) {
            logger.error(`Sensor calibration (${id}) failed:`, error);
            entry.error = error.message;
            ui.showToast(`Calibration failed: ${error.message}`, 5000, 'error');
        } finally {
            entry.busy = false; sensorCalRerender();
        }
    };

    // Restore puts back the calibration as it was immediately before the last
    // Apply made from this page. It lands on that value absolutely -- a
    // correction away from wherever we are now -- because Decaid's PUT only
    // ever corrects, never sets. Doing it twice is a no-op (see
    // absoluteSetCorrection), and the stored value is dropped afterwards:
    // once you are back, there is nothing further to undo.
    window.sensorCalRestorePrevious = async function(id) {
        const target = sensorCalTarget(id);
        const entry = sensorCalEntry(id);
        if (!target || entry.busy || !Number.isFinite(entry.previous)) return;
        entry.busy = true; entry.error = ''; sensorCalRerender();
        try {
            const live = await getSensorCalibration(id, 'current');
            const current = live?.measuredValue;
            if (!Number.isFinite(current)) throw new Error('Could not read the current calibration');
            // A ratio correction divides by the current value, so a stored 0
            // cannot be corrected away from — refuse rather than send a
            // division by zero to the firmware.
            if (target.kind === 'ratio' && current === 0) {
                throw new Error('Stored multiplier is 0 — the machine cannot be corrected from it');
            }
            const { de1ReportedValue, measuredValue } = absoluteSetCorrection(current, entry.previous);
            await setSensorCalibration(id, de1ReportedValue, measuredValue);
            await sensorCalRead(id);
            await sensorCalRememberPrevious(id, null);
            entry.captured = null; entry.capturedAt = 0; entry.measured = '';
            ui.showToast(`${target.label} restored`, 3000, 'success');
        } catch (error) {
            logger.error(`Sensor calibration restore (${id}) failed:`, error);
            entry.error = error.message;
            ui.showToast(`Restore failed: ${error.message}`, 5000, 'error');
        } finally {
            entry.busy = false; sensorCalRerender();
        }
    };

    // --- Load-cell calibration wizard handlers ---
    window.calSetWeight = function(v) {
        const w = clampCalWeight(v);
        if (w !== null) calWeightG = w;
    };

    window.calAdjustWeight = function(delta) {
        calWeightG = clampCalWeight(calWeightG + delta);
        const el = document.getElementById('calibWeightInput');
        if (el) el.value = calWeightG;
    };

    window.calGoToStep = function(n) {
        if (calBusy) return;
        calError = '';
        calStep = n;
        calRerender();
    };

    window.calRunZero = async function() {
        if (calBusy) return;
        calBusy = true; calError = ''; calRerender();
        try {
            const r = await calibrateScale('zero');
            if (r && r.success) {
                calDone[1] = true;
                ui.showToast('Load cells zeroed', 3000, 'success');
            } else {
                calError = (r && r.message) ? r.message : 'Zero failed';
                ui.showToast(`Zero failed: ${calError}`, 5000, 'error');
            }
        } catch (error) {
            logger.error('Load-cell zero failed:', error);
            calError = error.message;
            ui.showToast(`Zero failed: ${error.message}`, 5000, 'error');
        } finally {
            calBusy = false; calRerender();
        }
    };

    // The firmware auto-detects which bare cell holds the reference mass, so the
    // two weight latches are an ORDERED pair, not left-vs-right: both send the
    // SAME 'latch' command, and the firmware reports 'incomplete' after the
    // first (one cell solved, awaiting the other) and 'ok' after the second
    // (both solved + persisted) — Decaid has no left/right commands. The leg
    // shown to the user (RIGHT first, then LEFT) is only which leg to load.
    window.calRunPoint = async function(order) { // order: 'first' | 'second'
        if (calBusy) return;
        const stepNo = order === 'first' ? 2 : 3;
        calBusy = true; calError = ''; calRerender();
        try {
            const r = await calibrateScale('latch', calWeightG);
            if (r && r.success) {
                calDone[stepNo] = true;
                ui.showToast('Cell calibrated', 3000, 'success');
            } else {
                calError = (r && r.message) ? r.message : 'Calibration failed';
                ui.showToast(`Calibration failed: ${calError}`, 5000, 'error');
            }
        } catch (error) {
            logger.error('Load-cell point cal failed:', error);
            calError = error.message;
            ui.showToast(`Calibration failed: ${error.message}`, 5000, 'error');
        } finally {
            calBusy = false; calRerender();
        }
    };

    // Cancel the in-flight zero/latch step: abort → 202 with the new state. The
    // polling cal call then returns success:false message:'aborted', which
    // the run handler surfaces in the status slot. Deliberately does not
    // toast on success — the aborted step's own failure path reports it.
    window.calAbort = async function() {
        if (!calBusy) return;
        try {
            await calibrateScale('abort');
        } catch (error) {
            logger.error('Load-cell cal abort failed:', error);
            ui.showToast(`Cancel failed: ${error.message}`, 4000, 'error');
        }
    };

    // Abort the cal and reset the wizard to a fresh Zero. Available on steps 1-3
    // so a completed Zero, or a failed/stuck weight point, can always be
    // restarted without leaving the page. The abort clears the firmware's
    // partial latch, so the re-zero starts from a clean slate. Works whether or
    // not a step is in flight (a not-busy abort is a harmless no-op firmware-side).
    window.calStartOver = async function() {
        try {
            await calibrateScale('abort');
        } catch (error) {
            logger.error('Load-cell cal start-over abort failed:', error);
        }
        calResetWizard();
        calRerender();
    };

    // Deliberately does not set calBusy — tare is an instant trigger, unlike
    // the ~15 s cal steps, and blocking the verify page for it is needless.
    window.calTare = async function() {
        try {
            await tareScale();
            ui.showToast('Scale tared', 2000, 'success');
        } catch (error) {
            logger.error('Tare failed:', error);
            ui.showToast(`Tare failed: ${error.message}`, 4000, 'error');
        }
    };

    window.calRetry = function() {
        calResetWizard();
        calRerender();
    };

    window.calFinish = function() {
        ui.showToast('Load-cell calibration complete', 3000, 'success');
        calResetWizard();
        calRerender();
    };

    // Real DE1 images are a fixed ~454 KB (reaprime's firmware manifest reports
    // byteLength: 463872 for every bundled build). The picker has no accept
    // filter by design (see the input below), so catch an obviously-wrong file
    // here instead of letting it round-trip to decaid's 16 MiB hard cap and come
    // back as a bare "(413)".
    const MAX_REASONABLE_FIRMWARE_BYTES = 2 * 1024 * 1024;

    function formatFileSize(bytes) {
        return bytes >= 1024 * 1024
            ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
            : `${Math.round(bytes / 1024)} KB`;
    }

    window.onFirmwareFileSelected = function(input) {
        const file = input.files[0];
        const label = document.getElementById('firmware-filename');
        const hint = document.getElementById('firmware-filename-hint');
        const uploadBtn = document.getElementById('firmware-upload-btn');
        if (file && file.size > MAX_REASONABLE_FIRMWARE_BYTES) {
            if (label) label.textContent = file.name;
            if (hint) {
                hint.textContent = `${formatFileSize(file.size)} — ${getTranslation('too large for a DE1 firmware image')}`;
                hint.className = 'text-[16px] font-bold text-[#da515e]';
            }
            if (uploadBtn) uploadBtn.disabled = true;
            ui.showToast(
                getTranslation('That file is too large to be a DE1 firmware image (real ones are about 450 KB). Check you selected the right file.'),
                6000, 'error'
            );
            input.value = '';
            return;
        }
        if (file) {
            if (label) label.textContent = file.name;
            if (hint) {
                hint.textContent = formatFileSize(file.size);
                hint.className = 'text-[16px] text-[var(--text-secondary)]';
            }
            if (uploadBtn) uploadBtn.disabled = false;
        } else {
            if (label) label.textContent = getTranslation('No file selected');
            if (hint) hint.textContent = '';
            if (uploadBtn) uploadBtn.disabled = true;
        }
    };

    // Shared by the manual file-upload button and the catalog "Download &
    // Install" button — both drive the same NDJSON progress bar and need the
    // same in-flight guard, wake-lock, and unload-block around the flash.
    //
    // Elements are looked up per tick, not cached: the settings router swaps
    // page HTML while the upload keeps streaming, so a cached node goes stale
    // (detached) the moment the user leaves and comes back.
    async function runFirmwareOperation(startOperation, { onBeforeStart, onDone, onError, source } = {}) {
        // One POST holds the NDJSON stream open for the whole update, so a second
        // click (e.g. after navigating away and back, which re-renders a button
        // enabled) would only earn a 409 from the endpoint.
        if (firmwareUploadInFlight) {
            ui.showToast(getTranslation('A firmware update is already in progress'), 4000, 'info');
            return;
        }
        onBeforeStart?.();
        firmwareOperationSource = source;
        // The manual card is the catalog flow's own Upload/Select File button's
        // page real-estate, not a second control surface for it — hide it while
        // the catalog is running. When the manual card started the operation, it
        // stays visible: it's showing that button's own in-progress state.
        const manualSection = document.getElementById('firmware-manual-upload-section');
        if (manualSection) manualSection.style.display = source === 'catalog' ? 'none' : '';

        // Erase and CRC verification emit no percentages, so the bar sits still at
        // both ends of the upload; the step tracker + label name the phase so a
        // stalled-looking bar reads as "step 1 of 4" rather than as a hang.
        // Paints from module state alone, so the 1 Hz tick can call it too: the
        // verify latch flips between stream events, not on one, and the tracker
        // and bar have to follow it without waiting for an event that isn't coming.
        const paint = () => {
            firmwareNoteVerifyStart();
            const panel = document.getElementById('firmware-progress');
            const steps = document.getElementById('firmware-steps');
            const label = document.getElementById('firmware-progress-label');
            const barWrap = document.getElementById('firmware-progress-bar-wrap');
            const bar = document.getElementById('firmware-progress-bar');
            if (panel) panel.style.display = 'flex';
            if (steps) steps.innerHTML = renderFirmwareSteps(lastFirmwareProgress);
            if (label) label.textContent = firmwareProgressLabel(lastFirmwareProgress);
            // Only Upload has a real byte-level percentage — see firmwareStepIndex.
            // Once verification is under way the percentage is frozen at 99, so the
            // bar would be a second thing sitting still next to the tracker.
            const uploading = lastFirmwareProgress?.phase === 'uploading' && !firmwareVerifyStartedAt;
            if (barWrap) barWrap.style.display = uploading ? 'block' : 'none';
            if (bar) bar.style.width = `${uploading ? lastFirmwareProgress.percent : 0}%`;
        };

        const showProgress = ({ phase, percent }) => {
            // A tick that actually advances means the upload was not finished after
            // all — a link that slowed down can expire the projection early. Give
            // the latch back rather than leaving the label stuck on "Check…".
            if (phase === 'uploading' && lastFirmwareProgress?.phase === 'uploading'
                && percent > lastFirmwareProgress.percent) {
                firmwareVerifyStartedAt = 0;
            }
            lastFirmwareProgress = { phase, percent };
            // First real upload tick starts the countdown's clock; every tick
            // re-anchors it.
            firmwareProgressAt = Date.now();
            if (phase === 'uploading' && !firmwareUploadStartedAt) {
                firmwareUploadStartedAt = firmwareProgressAt;
                firmwareUploadStartPercent = percent;
            }
            paint();
        };

        firmwareUploadInFlight = true;
        firmwareCancelRequested = false;
        firmwareStartedAt = Date.now();
        firmwareUploadStartedAt = 0;
        firmwareUploadStartPercent = 0;
        firmwareProgressAt = 0;
        firmwareVerifyStartedAt = 0;
        // A full repaint, not just the label: the hand-off from Upload to Verify
        // happens on this tick (nothing arrives on the wire to announce it), and
        // it moves the tracker node and hides the bar as well as the clock.
        // Elements are looked up per tick for the reason paint() does it: the
        // router swaps the page HTML out from under a running update.
        clearInterval(firmwareElapsedTimer);
        firmwareElapsedTimer = setInterval(() => {
            if (lastFirmwareProgress) paint();
        }, 1000);
        const cancelBtn = document.getElementById('firmware-cancel-btn');
        if (cancelBtn) { cancelBtn.style.display = 'inline-flex'; cancelBtn.disabled = false; cancelBtn.textContent = getTranslation('Cancel'); }
        // A reload or a nav away aborts the POST mid-flash, which bricks nothing
        // but leaves the machine on a half-written image until it is redone. The
        // browser shows its own generic confirm here; the string is for the hosts
        // that surface it.
        const blockUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', blockUnload);
        // Erase and verify are minutes of silence — long enough for the tablet to
        // sleep and background the webview if the user has the lock switched off.
        // Only touched when it was off, and put back the way it was found.
        const wakeLockWasOff = !isWakeLockEnabled();
        if (wakeLockWasOff) await enableWakeLock().catch(e => logger.warn('Wake-lock for firmware upload failed:', e));
        // The flash sleeps the DE1 for the whole update, so the snapshot reports
        // 'sleeping' and the screensaver + panel dim would bury the progress bar.
        // Cleared in the finally, so the overlay is a pure function of machine
        // state again the moment the update ends (fails and cancels included).
        setScreensaverSuppressed(true);
        // And keep our MMR-backed settings reads off the BLE radio the flash owns.
        setFirmwareFlashInFlight(true);

        try {
            ui.showToast(getTranslation('Please be patient. It can take several minutes for your DE1 to update.'), 10000, 'info');
            showProgress({ phase: 'erasing', percent: 0 });
            await startOperation(showProgress);
            showProgress({ phase: 'done', percent: 100 });
            ui.showToast(getTranslation('Your DE1 firmware has been upgraded'), 8000, 'success');
            onDone?.();
        } catch (error) {
            logger.error('Error updating firmware:', error);
            const stoppedAt = lastFirmwareProgress;
            lastFirmwareProgress = null;
            const steps = document.getElementById('firmware-steps');
            const label = document.getElementById('firmware-progress-label');
            const barWrap = document.getElementById('firmware-progress-bar-wrap');
            const bar = document.getElementById('firmware-progress-bar');
            // A cancel resolves through this same stream-error path (the DELETE
            // just requests it; the NDJSON stream's 'error' event is what
            // actually ends the in-flight promise) -- read as "cancelled", not "failed".
            const cancelled = firmwareCancelRequested || isFirmwareCancellationError(error);
            // Freeze the tracker on whichever node it was on — a red ✕ for a real
            // failure, a neutral grey one for a cancel, so it's obvious which of
            // the four steps didn't finish instead of the tracker just vanishing.
            if (steps) steps.innerHTML = renderFirmwareSteps(stoppedAt, { failed: !cancelled, cancelled });
            if (label) {
                label.textContent = cancelled ? getTranslation('Update cancelled') : `${getTranslation('Update failed')}: ${error.message}`;
                // Grey for a cancel (expected, user-requested), red only for an
                // actual failure — matching the tracker node's own colour above.
                label.classList.add(cancelled ? 'text-[var(--text-secondary)]' : 'text-[#da515e]');
            }
            if (barWrap) barWrap.style.display = 'none';
            if (bar) bar.style.width = '0%';
            ui.showToast(
                cancelled ? getTranslation('Firmware update cancelled') : `${getTranslation('Update failed')}: ${error.message}`,
                5000, cancelled ? 'info' : 'error'
            );
            onError?.(error);
        } finally {
            firmwareUploadInFlight = false;
            firmwareOperationSource = null;
            const manualSectionEl = document.getElementById('firmware-manual-upload-section');
            if (manualSectionEl) manualSectionEl.style.display = '';
            firmwareCancelRequested = false;
            // Stop the clock. The terminal lines ("upgraded", "cancelled",
            // "failed") are painted in the try/catch above and must not end up
            // with a counter still ticking beside them.
            clearInterval(firmwareElapsedTimer);
            firmwareElapsedTimer = null;
            firmwareStartedAt = 0;
            firmwareUploadStartedAt = 0;
            firmwareUploadStartPercent = 0;
            firmwareProgressAt = 0;
            firmwareVerifyStartedAt = 0;
            setScreensaverSuppressed(false);
            setFirmwareFlashInFlight(false);
            // The dim we suppressed was the idle->sleeping TRANSITION, and the
            // machine is normally still asleep here — no second transition is
            // coming, so nothing would ever re-dim. Catch up by hand. (The
            // overlay needs no such nudge: it is re-derived every snapshot.)
            if (isMachineAsleep(currentMachineState)) dimDisplay();
            window.removeEventListener('beforeunload', blockUnload);
            if (wakeLockWasOff) await disableWakeLock().catch(() => {});
            const cancelBtnEl = document.getElementById('firmware-cancel-btn');
            if (cancelBtnEl) cancelBtnEl.style.display = 'none';
        }
    }

    // Requests cancellation of whichever operation runFirmwareOperation has in
    // flight (upload or catalog apply — the endpoint is the same for both).
    // Idempotent server-side; a stray click after the update already finished
    // is a harmless no-op.
    window.cancelFirmwareUpdate = async function() {
        const btn = document.getElementById('firmware-cancel-btn');
        if (btn) { btn.disabled = true; btn.textContent = getTranslation('Cancelling...'); }
        firmwareCancelRequested = true;
        try {
            await cancelFirmwareUpdate();
        } catch (error) {
            firmwareCancelRequested = false;
            if (btn) { btn.disabled = false; btn.textContent = getTranslation('Cancel'); }
            logger.error('Failed to cancel firmware update:', error);
            ui.showToast(`${getTranslation('Failed to cancel')}: ${error.message}`, 4000, 'error');
        }
    };

    window.uploadFirmware = async function() {
        const input = document.getElementById('firmware-file-input');
        const file = input?.files[0];
        if (!file) return;

        await runFirmwareOperation((showProgress) => uploadFirmware(file, showProgress), {
            source: 'manual',
            onBeforeStart: () => {
                const uploadBtn = document.getElementById('firmware-upload-btn');
                if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.textContent = getTranslation('Uploading...'); }
            },
            onError: () => {
                const btn = document.getElementById('firmware-upload-btn');
                if (btn) { btn.disabled = false; btn.textContent = getTranslation('Upload'); }
            },
        });
    };

    // Flashes a bundled catalog artifact directly — no file picker, the
    // middleware already has it. Gated behind confirm() since (unlike the manual
    // path) picking a button is the whole action, with no file-selection step
    // to double as a deliberate gate.
    window.applyFirmwareUpdate = async function(artifactId) {
        if (!artifactId) return;
        if (!confirm(`${getTranslation(FIRMWARE_DURATION_NOTE)}\n\n${getTranslation('Install this firmware update? Restart the machine once the update is done.')}`)) return;

        await runFirmwareOperation((showProgress) => applyFirmware(artifactId, showProgress), {
            source: 'catalog',
            onBeforeStart: () => {
                const btn = document.getElementById('firmware-apply-btn');
                if (btn) { btn.disabled = true; btn.textContent = getTranslation('Installing...'); }
            },
            // The catalog's own verdict is now stale (installed build changed) —
            // re-check instead of leaving the old "update available" block up.
            // The machine is mid-restart, so this may briefly read "Could not
            // check" before it reconnects — that is correct, not a bug.
            onDone: () => { initFirmwareCheck(); },
            onError: () => {
                const btn = document.getElementById('firmware-apply-btn');
                if (btn) { btn.disabled = false; btn.textContent = getTranslation('Download & Install'); }
            },
        });
    };

    // Wait for the restarted WebUI server and report the port it came back on.
    // It probed window.location.origin before, which is exactly the port that just
    // died -- so this always timed out and the switch appeared to do nothing.
    async function waitForSkinServer(timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const status = await getWebuiServerStatus();
                if (status?.serving && status.port) return status.port;
            } catch (e) { /* server still down */ }
        }
        return null;
    }

    window.setActiveSkin = async function(skinId) {
        if (!skinId) return;
        try {
            ui.showToast('Switching skin...', 0, 'info');
            await setDefaultSkin(skinId);
            // Confirm the bridge really took the new default before restarting it.
            const active = await getDefaultSkin();
            if (active?.id && active.id !== skinId) throw new Error(`bridge kept "${active.id}" active`);
            await stopWebuiServer();
            await startWebuiServer();
            ui.showToast('Loading new skin...', 0, 'info');
            const port = await waitForSkinServer();
            if (!port) {
                ui.showToast('Skin set, but the web server did not come back. Restart Decaid.', 0, 'error');
                return;
            }
            // Go straight to the new skin instead of out to the dashboard.
            //
            // The dashboard exit cannot work here. Decaid's webview compares an
            // exit URL against skinExitDashboardUrlForPort(<port it is serving
            // right now>) and additionally requires the page's own top-level URL
            // to be on that port (classifySkinNavigation + SkinExitCoordinator in
            // skin_view.dart). The restart just moved that port, and this page is
            // still on the old one, so every exit URL we can produce loses: the
            // one skin-api.js baked in is the dead port ("Blocking navigation
            // to: .../__decent/exit-dashboard"), and the port the restart came
            // back on passes the URL check but fails the top-level check
            // ("Rejected skin dashboard request").
            //
            // Port 3000 is the way out. Decaid keeps it bound as a permanent 307
            // redirector to whatever port currently serves the skin
            // (_serveEntryPoint), and the webview allows port 3000 outright plus
            // the live serving port the redirect lands on. So one navigation puts
            // the new skin on screen with no dashboard round trip.
            ui.showToast('Skin set. Loading it now.', 6000, 'success');
            // The redirect lands on the port Decaid is serving *at that moment*,
            // and the webview only allows it once its own view has picked the new
            // port up. Give it a beat: too early and the navigation is treated as
            // an external link and opens in the system browser instead.
            await new Promise(r => setTimeout(r, 1200));
            const enterSkin = () => window.location.assign(
                `${window.location.protocol}//${window.location.hostname}:3000/?_=${Date.now()}`);
            enterSkin();
            // Still here means the navigation was refused. One retry, then say so
            // — the machine-side back gesture still reaches the dashboard.
            setTimeout(enterSkin, 3000);
            setTimeout(() => ui.showToast(
                'Skin set, but this screen did not switch. Use system back to reach the dashboard, then open the skin.',
                0, 'error'), 6000);
        } catch (error) {
            logger.error('Error setting active skin:', error);
            ui.showToast(`Failed to switch skin: ${error.message}`, 5000, 'error');
        }
    };

    window.updateSkin = async function() {
        try {
            ui.showToast(skinUpdateCheckText(), 3000, 'info');
            await updateSkins(); // bridge checks sources & downloads newer skin files server-side
            settingsCache.allSkins = await getAllSkins();
            const diskVersion = settingsCache.allSkins.find(s => s.id === SKIN_ID)?.version;
            if (diskVersion && diskVersion !== APP_VERSION) {
                ui.showToast(`New version v${diskVersion} downloaded. Reloading...`, 2000, 'success');
                setTimeout(() => window.location.reload(), 2000);
            } else {
                ui.showToast(`${getTranslation('Up to date')} (v${APP_VERSION}).`, 4000, 'info');
                if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
            }
        } catch (error) {
            logger.error('Error updating skin:', error);
            ui.showToast(`Failed to update skin: ${error.message}`, 5000, 'error');
        }
    };
    window.updateSteamSetting = updateSteamSetting;
    window.updateHotWaterSetting = updateHotWaterSetting;
    window.flashPlusMinusButton = ui.flashPlusMinusButton;
    window.retryLoadSettings = () => {
        // One failed GET /ledStrip must not brick the Lighting page for the
        // module's lifetime — clear the error so the re-render refetches.
        ledError = false;
        preloadSettings().then(() => {
            if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
        });
    };

    // Expose flush adjustment functions to global scope
    window.adjustFlushTemp = function(change) {
        const input = document.getElementById('flushTempInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            // Ensure value stays within bounds (5 to 95 °C, in the active display unit)
            newValue = Math.max(tempInputValue(5), Math.min(tempInputValue(95), newValue));
            input.value = newValue.toFixed(1);
            // Trigger the onchange event to update the setting
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustFlushFlow = function(change) {
        const input = document.getElementById('flushFlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            // Ensure value stays within bounds (1 to 8 ml/s)
            newValue = Math.max(1, Math.min(8, newValue));
            input.value = newValue.toFixed(1);
            // Trigger the onchange event to update the setting
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustWeightFlowMultiplier = function(change) {
        const input = document.getElementById('weightFlowMultiplierInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0, newValue);
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustVolumeFlowMultiplier = function(change) {
        const input = document.getElementById('volumeFlowMultiplierInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0, newValue);
            input.value = newValue.toFixed(2);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHotWaterFlowMultiplier = function(change) {
        const input = document.getElementById('hotWaterFlowMultiplierInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0, newValue);
            input.value = newValue.toFixed(2);
            input.dispatchEvent(new Event('change'));
        }
    };

    // Live-sync the Hot Water "Stop at Weight" toggle to scale connection state.
    // Called from app.js on scale connect/disconnect; no-ops if the toggle isn't
    // on screen. No scale → forced off + disabled; scale → enabled, stored pref.
    window.onScaleConnectionChange = function(connected) {
        const input = document.getElementById('stopHotWaterAtWeightToggle');
        if (!input) return;
        const label = input.closest('label');
        if (connected) {
            input.disabled = false;
            input.checked = settingsCache.rea?.stopHotWaterAtWeight ?? true;
            label?.classList.remove('opacity-40', 'cursor-not-allowed');
            label?.classList.add('cursor-pointer');
        } else {
            input.checked = false;
            input.disabled = true;
            label?.classList.remove('cursor-pointer');
            label?.classList.add('opacity-40', 'cursor-not-allowed');
        }
    };

    window.adjustHotWaterFlow = function(change) {
        const input = document.getElementById('hotWaterFlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0.1, Math.min(8, newValue));
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHotWaterTemp = function(change) {
        const input = document.getElementById('hotWaterTempInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(tempInputValue(50), Math.min(tempInputValue(95), newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHotWaterVolume = function(change) {
        const input = document.getElementById('hotWaterVolumeInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(10, Math.min(500, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHotWaterDuration = function(change) {
        const input = document.getElementById('hotWaterDurationInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(5, Math.min(120, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHeaterPh1Flow = function(change) {
        const input = document.getElementById('heaterPh1FlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0, Math.min(10, newValue));
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHeaterPh2Flow = function(change) {
        const input = document.getElementById('heaterPh2FlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0, Math.min(10, newValue));
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHeaterIdleTemp = function(change) {
        const input = document.getElementById('heaterIdleTempInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(tempInputValue(0), Math.min(tempInputValue(99), newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustHeaterPh2Timeout = function(change) {
        const input = document.getElementById('heaterPh2TimeoutInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(0, Math.min(60, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustTankTemp = function(change) {
        const input = document.getElementById('tankTempInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(tempInputValue(10), Math.min(tempInputValue(40), newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    let _waterAlertDebounce = null;
    window.commitWaterAlert = function(value) {
        const snapped = snapWaterAlertLevel(value);
        const input = document.getElementById('waterAlertInput');
        if (input && parseInt(input.value, 10) !== snapped) {
            input.value = snapped;
        }
        localStorage.setItem('waterRefillLevel', String(snapped));
        clearTimeout(_waterAlertDebounce);
        _waterAlertDebounce = setTimeout(async () => {
            try {
                await setWaterLevels(snapped);
                logger.info(`Water refill level set to ${snapped}mm`);
            } catch (err) {
                logger.error('Failed to set water refill level:', err);
                ui.showToast('Failed to update water alert level', 4000, 'error');
            }
        }, 400);
    };

    window.adjustWaterAlert = function(change) {
        const input = document.getElementById('waterAlertInput');
        if (input) {
            const current = parseInt(input.value, 10) || 0;
            const idx = WATER_ALERT_LEVELS.indexOf(snapWaterAlertLevel(current));
            const dir = change > 0 ? 1 : -1;
            const nextIdx = Math.max(0, Math.min(WATER_ALERT_LEVELS.length - 1, idx + dir));
            input.value = WATER_ALERT_LEVELS[nextIdx];
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustFanThreshold = function(change) {
        const input = document.getElementById('calibFanInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(0, Math.min(100, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.stepFanThreshold = function(change) {
        const input = document.getElementById('fanThresholdInput');
        const display = document.getElementById('fan-display');
        const fill = document.getElementById('fan-track-fill');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(0, Math.min(100, newValue));
            input.value = newValue;
            if (display) display.textContent = newValue;
            if (fill) fill.style.width = newValue + '%';
            window.updateDe1Setting('fan', newValue);
        }
    };

    window.adjustSteamCalibTemp = function(change) {
        const input = document.getElementById('steamCalibTempInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(tempInputValue(135), Math.min(tempInputValue(170), newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    // 0 is off, 135-165 is the enabled range (rest_v1.yml SteamSettings), and
    // nothing in between is a real setting -- Decaid reads anything under the
    // range as off. So the buttons step between off and the bottom of the range
    // instead of walking the user through 134 meaningless degrees. The floor
    // used to be 135 with a label promising that "below 130" turned the heater
    // off, which the buttons could not reach at all.
    window.adjustSteamTemp = function(change) {
        const input = document.getElementById('steamTempInput');
        if (!input) return;
        const off = tempInputValue(0);
        const min = tempInputValue(135);
        const current = parseInt(input.value, 10);
        let newValue;
        if (current <= off) {
            newValue = change > 0 ? min : off;              // off -> bottom of range
        } else {
            newValue = current + change;
            if (newValue < min) newValue = off;             // below the range -> off
            else newValue = Math.min(tempInputValue(165), newValue);
        }
        input.value = newValue;
        input.dispatchEvent(new Event('change'));
    };

    window.adjustSteamDuration = function(change) {
        const input = document.getElementById('steamDurationInput');
        if (input) {
            let newValue = parseInt(input.value, 10) + change;
            newValue = Math.max(10, Math.min(120, newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustSteamFlow = function(change) {
        const input = document.getElementById('steamFlowInput');
        if (input) {
            let newValue = parseFloat(input.value) + change;
            newValue = Math.max(0.4, Math.min(2.5, newValue));
            input.value = newValue.toFixed(1);
            input.dispatchEvent(new Event('change'));
        }
    };

    window.adjustMilkStopTemp = function(change) {
        const input = document.getElementById('steamMilkStopInput');
        if (input) {
            let newValue = Math.round(parseFloat(input.value)) + change;
            newValue = Math.max(tempInputValue(30), Math.min(tempInputValue(80), newValue));
            input.value = newValue;
            input.dispatchEvent(new Event('change'));
        }
    };

    // Steam-stop mode toggle (Off | Time | Milk Temp). Stages stopAtTemperature and
    // re-renders so the correct dependent field (Duration or Milk target) is revealed.
    window.setEcoSteam = setEcoSteamEnabled;

    window.setSteamStopMode = function(mode) {
        // Milk Temp is unofferable without the probe (button renders disabled —
        // this guard is belt-and-braces against a stale DOM).
        if (mode === 'temperature' && !getMilkProbe().present) return;
        // A hand-picked mode overrides any pending probe-loss restore, exactly
        // like a tap on the main-page tile — without this, an Off/Time stop
        // chosen here while the probe is away is auto-re-armed to Milk the
        // moment the probe returns.
        ui.clearMilkStopProbeRestore();
        try {
            localStorage.setItem('streamline.steamStopMode', mode);
            // Remember the last non-temperature choice: it's what the page
            // falls back to if the milk probe disappears.
            if (mode !== 'temperature') localStorage.setItem('streamline.steamStopModeFallback', mode);
        } catch (e) { /* non-fatal */ }
        if (mode === 'temperature') {
            const cur = settingsCache.workflow?.steamSettings?.stopAtTemperature ?? 0;
            if (!(cur > 0)) updateSteamSetting('stopAtTemperature', 60);
        } else if ((settingsCache.workflow?.steamSettings?.stopAtTemperature ?? 0) > 0) {
            updateSteamSetting('stopAtTemperature', 0); // 'time'/'off' → no milk auto-stop
        }
        if (activeSettingsCategory) updateSettingsContentArea(activeSettingsCategory);
    };
}

// Pages that ARE one plugin's settings UI, so that plugin's vocabulary belongs on
// them specifically as well as on the Plugins list.
const PLUGIN_BACKED_SUBCATEGORIES = {
    extention1: 'visualizer.reaplugin',
    shotupload: 'shot-upload.reaplugin',
    dye2: 'dye2.reaplugin',
};

let pluginKeywordsLoaded = false;

// Fold the installed plugins' names, descriptions and manifest setting names into
// the search index. Best-effort and one-shot: the nav is searchable without it,
// so an unreachable bridge just means plugin vocabulary is missing, not an error.
async function loadPluginSearchKeywords() {
    if (pluginKeywordsLoaded) return;
    const plugins = await getPlugins();
    if (!plugins) return;
    pluginKeywordsLoaded = true;

    const extensions = settingsTree.extensions?.subcategories || [];
    for (const subcat of extensions) {
        const pluginId = PLUGIN_BACKED_SUBCATEGORIES[subcat.id];
        if (pluginId) {
            subcat.keywords = pluginKeywords(plugins.find(p => p?.id === pluginId));
        } else if (subcat.settingsCategory === 'plugins') {
            // The Plugins page lists them all, so it answers for all of them.
            subcat.keywords = pluginListKeywords(plugins);
        }
    }
}

let pageTextIndexed = false;

// Index the words each settings page actually shows, so a search reaches the
// copy on the page and not just its title — "history" should find the "Upload
// existing shot history" toggle, which lives nowhere in the nav tree.
//
// The renderers are plain functions returning an HTML string, so the text is
// obtained by calling them and stripping the tags. Each is wrapped: one that
// throws (or needs a cache that is not loaded yet) costs that page its page-text
// keywords, nothing more — its name and plugin keywords still match. Runs once;
// re-rendering on every keystroke would be wasteful and pointless, as the copy
// does not change between searches.
function indexSettingsPageText() {
    if (pageTextIndexed) return;
    pageTextIndexed = true;
    for (const category of Object.values(settingsTree)) {
        for (const subcat of category.subcategories || []) {
            if (!subcat.settingsCategory) continue;
            try {
                subcat.pageText = textFromHtml(renderSettingsContent(subcat.settingsCategory));
            } catch (e) {
                logger.debug(`No page text indexed for ${subcat.id}:`, e?.message);
            }
        }
    }
}

// Set up search functionality for settings
function setupSettingsSearch(activateResult) {
    const searchInput = document.getElementById('settings-search');
    const subCategoriesPanel = document.getElementById('sub-categories-panel');
    if (!searchInput || !subCategoriesPanel) return;

    loadPluginSearchKeywords().catch(e => logger.warn('Plugin search keywords unavailable:', e));
    indexSettingsPageText();
    let timer = null;
    let savedScrollTop = 0;
    let searchActive = false;

    const restore = () => {
        clearTimeout(timer);
        timer = null;
        const results = subCategoriesPanel.querySelector('[data-settings-search-results]');
        if (!results || !searchActive) return;
        results.hidden = true;
        results.replaceChildren();
        Array.from(subCategoriesPanel.children).forEach(child => {
            if (child !== results) child.hidden = false;
        });
        subCategoriesPanel.scrollTop = savedScrollTop;
        searchActive = false;
    };

    const renderResults = searchTerm => {
        let results = subCategoriesPanel.querySelector('[data-settings-search-results]');
        if (!results) {
            results = document.createElement('div');
            results.dataset.settingsSearchResults = '';
            results.className = 'flex flex-col gap-[8px]';
            subCategoriesPanel.appendChild(results);
            results.addEventListener('click', event => {
                const button = event.target.closest('.settings-search-result');
                if (!button) return;
                searchInput.value = '';
                restore();
                activateResult(button.dataset.mainCategory, button.dataset.category);
            });
        }
        if (!searchActive) {
            savedScrollTop = subCategoriesPanel.scrollTop;
            Array.from(subCategoriesPanel.children).forEach(child => {
                if (child !== results) child.hidden = true;
            });
            searchActive = true;
        }

        const fragment = document.createDocumentFragment();
        Object.entries(settingsTree).forEach(([mainCategory, category]) => {
            const mainLabel = getTranslation(category.i18nKey || category.name);
            const mainMatches = mainLabel.toLowerCase().includes(searchTerm);
            category.subcategories
                .filter(subcategory => !subcategory.bengleOnly || isBengleMachine())
                .filter(subcategory => {
                    const label = getTranslation(subcategory.i18nKey || subcategory.name.replace(/^\d+\.\s*/, ''));
                    return mainMatches
                        || label.toLowerCase().includes(searchTerm)
                        || subcategoryMatches(subcategory, searchTerm);
                })
                .forEach(subcategory => {
                    const label = getTranslation(subcategory.i18nKey || subcategory.name.replace(/^\d+\.\s*/, ''));
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'settings-search-result w-full text-left px-4 py-3 rounded-lg text-[22px] text-[var(--text-primary)] hover:bg-[#2c4a7a] hover:text-white';
                    button.dataset.mainCategory = mainCategory;
                    button.dataset.category = subcategory.settingsCategory;
                    button.textContent = `${mainLabel} \u203a ${label}`;
                    fragment.appendChild(button);
                });
        });
        if (!fragment.childNodes.length) {
            const empty = document.createElement('p');
            empty.className = 'p-4 text-center text-[22px] text-[var(--text-primary)] opacity-60';
            empty.textContent = getTranslation('No settings match your search');
            fragment.appendChild(empty);
        }
        results.replaceChildren(fragment);
        results.hidden = false;
        subCategoriesPanel.scrollTop = 0;
    };

    searchInput.addEventListener('input', event => {
        const searchTerm = event.target.value.toLowerCase().trim();
        clearTimeout(timer);
        if (!searchTerm) {
            restore();
            return;
        }
        timer = setTimeout(() => renderResults(searchTerm), 125);
    });
    searchInput.addEventListener('search', () => {
        if (!searchInput.value.trim()) restore();
    });
    searchInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const searchTerm = searchInput.value.toLowerCase().trim();
        if (searchTerm) renderResults(searchTerm);
        subCategoriesPanel.querySelector('.settings-search-result')?.click();
        searchInput.blur();
    });
}

export function cleanupSettings() {
    stopCupWarmerPoll();
    clearTimeout(_settingsNumpadTimer);
    _settingsNumpadTimer = null;
    clearTimeout(ledPutTimer);
    ledPutTimer = null;
    ledClearPreview();
    ledSeqReleaseManual();
    if (calWsClaimed) calReleaseScaleWs();
}

/**
 * Initialize WebSocket connection for live device state updates
 * Should be called once when the settings page loads
 */
export function initDeviceWebSocket() {
    if (deviceStateCache.initialized) {
        logger.info('Device WebSocket already initialized');
        return;
    }

    connectDeviceWebSocket(
        // onData callback - update cache and re-render device lists in real-time
        (data) => {
            logger.debug('Device WebSocket data received:', data);
            deviceStateCache.devices = data.devices || [];
            deviceStateCache.scanning = data.scanning || false;
            deviceStateCache.initialized = true;

            // Always re-render device lists when new data arrives
            // This ensures live updates whenever device state changes
            renderDeviceListFromCache();
        },
        // onReconnect callback
        () => {
            logger.info('Device WebSocket reconnected');
            // Re-render to show updated connection states
            renderDeviceListFromCache();
        },
        // onDisconnect callback
        () => {
            logger.warn('Device WebSocket disconnected');
            // The Decaid link is down -- any run (manual OR trigger) has
            // nothing to talk to any more. Unconditional: a dead link is not
            // a routine exit, so there is no hand-back to attempt.
            ledRunForceStop();
            if (activeSettingsCategory === 'ledstrip') updateSettingsContentArea('ledstrip');
        }
    );

    deviceStateCache.initialized = true;
    logger.info('Device WebSocket initialized');
}

function handleDisplayState(data) {
    logger.debug('Display state received:', data);
    displayStateCache = data; // REA truth for render-time reads

    // Update brightness slider + number entry if they exist
    if (data.brightness !== undefined) {
        const brightnessSlider = document.getElementById('brightness-slider');
        const brightnessNumber = document.getElementById('brightness-number');
        if (brightnessSlider) {
            brightnessSlider.value = data.brightness;
            // Moving the thumb without repainting the fill is what leaves the
            // bar behind when REA pushes a level we did not set locally.
            syncBrightnessSliderFill(brightnessSlider, data.brightness);
        }
        if (brightnessNumber) brightnessNumber.value = data.brightness;
    }

    // Update wake-lock toggle if it exists. wakeLockOverride (not
    // wakeLockEnabled) is REA's record of whether THIS APP asked for the
    // lock -- wakeLockEnabled is just whether a lock is held right now,
    // which can read false for reasons unrelated to our request and was
    // fighting the user's own toggle taps.
    const wakeLockToggle = document.getElementById('wake-lock-toggle');
    if (wakeLockToggle && data.wakeLockOverride !== undefined) {
        wakeLockToggle.checked = data.wakeLockOverride;
        localStorage.setItem('wakeLockEnabled', data.wakeLockOverride.toString());
    }
}

/**
 * Initialize display WebSocket connection
 */
export function initDisplayWebSocket() {
    connectDisplayWebSocket(handleDisplayState);

    logger.info('Display WebSocket initialized');
}

/**
 * Render device lists from WebSocket cache
 */
window.renderDeviceListFromCache = function() { renderDeviceListFromCache(); };

function renderDeviceListFromCache() {
    const machines = deviceStateCache.devices.filter(device =>
        device.type === 'machine' ||
        (device.name && (device.name.toLowerCase().includes('de1') ||
                        device.name.toLowerCase().includes('espresso')))
    );

    const scales = deviceStateCache.devices.filter(device =>
        device.type === 'scale' ||
        (device.name && (device.name.toLowerCase().includes('scale') ||
                        device.name.toLowerCase().includes('weight')))
    );

    renderDeviceList('bluetooth-machine-devices-container', machines, 'Machine',
        settingsCache.rea?.preferredMachineId || '', 'preferredMachineId');
    renderDeviceList('bluetooth-scale-devices-container', scales, 'Scale',
        settingsCache.rea?.preferredScaleId || '', 'preferredScaleId');
}

// Bluetooth Functions

// Function to scan for available devices and populate the dropdowns
window.scanAndConnectEspresso = async function() {
    try {
        ui.showToast('Scanning for espresso machines...', 2000, 'info');

        // Use WebSocket to trigger scan
        sendDeviceCommand({ command: 'scan', connect: false });
        ui.showToast('Scanning started, results will appear shortly', 3000, 'info');

    } catch (error) {
        console.error('Error scanning for espresso machines:', error);
        ui.showToast(`Error scanning for devices: ${error.message}`, 5000, 'error');
    }
};

// Function to scan for scales and connect
window.scanAndConnectScale = async function() {
    try {
        ui.showToast('Scanning for weighing scales...', 2000, 'info');

        // Use WebSocket to trigger scan
        sendDeviceCommand({ command: 'scan', connect: false });
        ui.showToast('Scanning started, results will appear shortly', 3000, 'info');

    } catch (error) {
        console.error('Error scanning for scales:', error);
        ui.showToast(`Error scanning for devices: ${error.message}`, 5000, 'error');
    }
};

// --- Manual WiFi scale endpoints ---------------------------------------------

// Fetch the manual endpoints and render them with a remove control. Discovered
// (and connected) WiFi scales already appear in the device list above; this
// list is just the manually-entered hosts so they can be removed.
// (uses the module's existing `escapeHtml` helper defined near the top of this
// file — don't add a second definition)
async function renderManualWifiEndpoints() {
    const container = document.getElementById('wifi-manual-endpoints-container');
    if (!container) return;
    let hosts = [];
    try {
        hosts = await listWifiScales();
    } catch (error) {
        // Distinguish "couldn't load" from "no endpoints" — a blank list here
        // would look like the user's saved endpoints were lost.
        container.innerHTML = '<div class="text-[20px] text-amber-600 px-[16px] py-[12px]">Couldn\'t load saved endpoints — check the connection and reopen.</div>';
        return;
    }
    if (!hosts.length) {
        container.innerHTML = '';
        return;
    }
    // Build with escaped text + a data-host attribute (no host interpolated into
    // an inline JS handler — listeners are attached below from dataset).
    container.innerHTML = hosts.map((host) => {
        const safe = escapeHtml(host);
        return `
            <div class="flex items-center justify-between w-full bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] rounded-[10px] px-[16px] py-[12px]">
                <span class="text-[24px] text-[var(--text-primary)] break-all">${safe}</span>
                <button type="button" data-host="${safe}"
                    class="wifi-scale-remove-btn text-[var(--mimoja-blue)] text-[24px] px-[12px] hover:text-white hover:bg-[var(--mimoja-blue)] rounded-[8px] transition-colors duration-200" data-i18n-key="Remove">
                    Remove
                </button>
            </div>`;
    }).join('');
    container.querySelectorAll('.wifi-scale-remove-btn').forEach((btn) => {
        btn.addEventListener('click', () => window.removeWifiScaleEndpoint(btn.dataset.host));
    });
}
window.renderManualWifiEndpoints = renderManualWifiEndpoints;

// Open the rarely-used manual WiFi-scale dialog and (re)populate its list.
window.openWifiScaleModal = function() {
    const modal = document.getElementById('wifi-scale-modal');
    if (!modal) return;
    modal.showModal();
    renderManualWifiEndpoints();
};

window.addWifiScaleFromInput = async function() {
    const input = document.getElementById('wifi-scale-host-input');
    if (!input) return;
    const host = input.value.trim();
    if (!host) {
        ui.showToast('Enter an IP address or hostname', 4000, 'error');
        return;
    }
    try {
        await addWifiScale(host);
        input.value = '';
        ui.showToast(`Added WiFi scale ${host}`, 3000, 'success');
        await renderManualWifiEndpoints();
        // The new endpoint validates through the normal connect path — if the
        // address is wrong/unreachable it simply never reaches "connected".
    } catch (error) {
        ui.showToast(`Could not add WiFi scale: ${error.message}`, 5000, 'error');
    }
};

window.removeWifiScaleEndpoint = async function(host) {
    try {
        await removeWifiScale(host);
        ui.showToast(`Removed ${host}`, 3000, 'success');
        await renderManualWifiEndpoints();
    } catch (error) {
        ui.showToast(`Could not remove WiFi scale: ${error.message}`, 5000, 'error');
    }
};

window.handleBrightnessChange = async function(value) {
    try {
        const brightnessValue = Math.min(100, Math.max(0, parseInt(value) || 0));
        const slider = document.getElementById('brightness-slider');
        const number = document.getElementById('brightness-number');

        // Keep slider + number entry in sync
        if (slider) {
            slider.value = brightnessValue;
            syncBrightnessSliderFill(slider, brightnessValue);
        }
        if (number) number.value = brightnessValue;

        sendDisplayCommand({
            command: 'setBrightness',
            brightness: brightnessValue
        });
        // Deliberate user choice, so remember it: REA does not persist brightness
        // (ReaSettings has no such field), and app.js replays this on boot.
        rememberBrightness(brightnessValue);
    } catch (error) {
        console.error('Error adjusting brightness:', error);
    }
};

window.handleBrightnessAutoToggle = async function(isEnabled) {
    try {
        const slider = document.getElementById('brightness-slider');
        if (slider) {
            slider.disabled = isEnabled;
            slider.style.opacity = isEnabled ? '0.5' : '1';
            slider.style.cursor = isEnabled ? 'not-allowed' : 'pointer';
        }

        if (isEnabled) {
            logger.info('Auto brightness enabled');
            // You can add logic here to request auto brightness from the display WebSocket
        } else {
            logger.info('Auto brightness disabled');
        }
    } catch (error) {
        console.error('Error toggling auto brightness:', error);
    }
};

// Wake Lock handlers
window.handleWakeLockToggle = async function(enabled) {
    try {
        if (enabled) {
            await enableWakeLock();
            localStorage.setItem('wakeLockEnabled', 'true');
            ui.showToast(`${getTranslation('Wake Lock')} ${getTranslation('Enabled')}`, 3000, 'success');
        } else {
            await disableWakeLock();
            localStorage.setItem('wakeLockEnabled', 'false');
            ui.showToast(`${getTranslation('Wake Lock')} ${getTranslation('Disabled')}`, 3000, 'success');
        }
    } catch (error) {
        console.error('Error toggling wake lock:', error);
        ui.showToast('Failed to toggle wake lock', 5000, 'error');
    }
};

// Presence Detection handlers
window.handlePresenceToggle = async function(enabled) {
    try {
        await setPresenceSettings({ userPresenceEnabled: enabled });
        ui.showToast(`${getTranslation('Presence Detection')} ${enabled ? getTranslation('Enabled') : getTranslation('Disabled')}`, 3000, 'success');
    } catch (error) {
        console.error('Error toggling presence detection:', error);
        ui.showToast('Failed to update presence detection', 5000, 'error');
    }
};

window.handleSleepTimeoutChange = async function(minutes) {
    try {
        const value = parseInt(minutes, 10);
        if (value < 1 || value > 120) {
            ui.showToast('Sleep timeout must be between 1 and 120 minutes', 5000, 'error');
            return;
        }
        await setPresenceSettings({ sleepTimeoutMinutes: value });
        ui.showToast('Sleep timeout updated', 3000, 'success');
    } catch (error) {
        console.error('Error updating sleep timeout:', error);
        ui.showToast('Failed to update sleep timeout', 5000, 'error');
    }
};

window.handleAddSchedule = function() {
    document.getElementById('add-schedule-modal').showModal();
};

window.handleSaveSchedule = async function() {
    try {
        const timeInput = document.getElementById('schedule-time-input').value;
        if (!timeInput) {
            ui.showToast('Please select a time', 3000, 'error');
            return;
        }

        const checkboxes = document.querySelectorAll('#add-schedule-modal input[type="checkbox"]:checked');
        const daysOfWeek = Array.from(checkboxes).map(cb => parseInt(cb.value, 10));

        const hours = parseInt(document.getElementById('keep-awake-hours-input').value, 10) || 0;
        const mins = parseInt(document.getElementById('keep-awake-mins-input').value, 10) || 0;

        if (hours > 12) {
            ui.showToast('Keep awake duration cannot exceed 12 hours (720 minutes)', 5000, 'error');
            return;
        }

        const keepAwakeFor = (hours * 60) + mins;

        const schedule = {
            time: timeInput,
            daysOfWeek: daysOfWeek,
            enabled: true
        };

        if (keepAwakeFor >= 1 && keepAwakeFor <= 720) {
            schedule.keepAwakeFor = keepAwakeFor;
        }

        await createPresenceSchedule(schedule);
        ui.showToast('Schedule created', 3000, 'success');

        // Clear form inputs
        document.getElementById('schedule-time-input').value = '';
        document.getElementById('keep-awake-hours-input').value = '0';
        document.getElementById('keep-awake-mins-input').value = '0';
        document.querySelectorAll('#add-schedule-modal input[type="checkbox"]').forEach(cb => cb.checked = false);

        document.getElementById('add-schedule-modal').close();
        updateSettingsContentArea('presence');
    } catch (error) {
        console.error('Error creating schedule:', error);
        ui.showToast('Failed to create schedule', 5000, 'error');
    }
};

window.handleScheduleToggle = async function(scheduleId, enabled) {
    try {
        await updatePresenceSchedule(scheduleId, { enabled });
        ui.showToast(`Schedule ${enabled ? 'enabled' : 'disabled'}`, 3000, 'success');
        // No need to reload entire view - the toggle state is already updated in the DOM
    } catch (error) {
        console.error('Error toggling schedule:', error);
        ui.showToast('Failed to update schedule', 5000, 'error');
        // On error, revert the toggle in the UI
        const toggle = document.querySelector(`input[onchange*="${scheduleId}"]`);
        if (toggle) toggle.checked = !enabled;
    }
};

window.handleDeleteSchedule = async function(scheduleId) {
    if (!confirm('Are you sure you want to delete this schedule?')) return;

    try {
        await deletePresenceSchedule(scheduleId);
        ui.showToast('Schedule deleted', 3000, 'success');
        updateSettingsContentArea('presence');
    } catch (error) {
        console.error('Error deleting schedule:', error);
        ui.showToast('Failed to delete schedule', 5000, 'error');
    }
};

window.handleMachineStateChange = async function(newState) {
    try {
        if (newState === MachineState.SLEEPING) {
            dimDisplay();
        } else if (newState === MachineState.IDLE) {
            restoreDisplay();
        }
    } catch (error) {
        console.error('Error auto-adjusting display based on machine state:', error);
    }
};

// Render Bluetooth Machine settings
export function renderBluetoothMachineSettings() {
    setTimeout(() => { renderDeviceListFromCache(); }, 0);

    return `
        <div class="flex flex-col gap-[32px] items-start relative w-full max-w-full overflow-x-hidden">

            <!-- Header -->
            <div class="flex items-center w-full">
                <div class="w-[139px] shrink-0"></div>
                <p class="flex-1 text-center font-['Inter:Semi_Bold',sans-serif] font-semibold not-italic text-[var(--text-primary)] text-[36px] leading-[1.2]" data-i18n-key="Espresso Machine">Espresso Machine</p>
                <button id="scan-machine-btn"
                        class="w-[139px] shrink-0 border-[var(--mimoja-blue)] text-[var(--mimoja-blue)] h-[62px] rounded-[67.5px] border text-[24px] transition-colors duration-200 hover:bg-[var(--mimoja-blue)] hover:text-white"
                        onclick="window.scanForMachines()" data-i18n-key="Search">
                    Search
                </button>
            </div>

            <!-- Divider -->
            <div class="h-0 relative w-full">
                <hr class="border-t border-[#c9c9c9] w-full" />
            </div>

            <!-- Connected Device -->
            <div class="flex flex-col gap-[20px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]" data-i18n-key="Connected Device">Connected Device</p>
                </div>
                <div id="bluetooth-machine-devices-container" class="w-full">
                    <!-- Machine devices will be populated dynamically via WebSocket -->
                </div>
            </div>

        </div>
    `;
}

// Render Bluetooth Scale settings
export function renderBluetoothScaleSettings(settings) {
    // Render devices from WebSocket cache on initial render
    setTimeout(() => {
        renderDeviceListFromCache();
    }, 0);

    const scalePowerMode = settings?.scalePowerMode ?? 'disabled';
    const blockOnNoScale = settings?.blockOnNoScale ?? false;

    return `
        <div class="flex flex-col gap-[32px] items-start relative w-full max-w-full overflow-x-hidden">

            <!-- Header -->
            <div class="flex items-center w-full">
                <div class="w-[139px] shrink-0"></div>
                <p class="flex-1 text-center font-['Inter:Semi_Bold',sans-serif] font-semibold not-italic text-[var(--text-primary)] text-[36px] leading-[1.2]" data-i18n-key="Scale">Scale</p>
                <button id="scan-scale-btn"
                        class="w-[139px] shrink-0 border-[var(--mimoja-blue)] text-[var(--mimoja-blue)] h-[62px] rounded-[67.5px] border text-[24px] transition-colors duration-200 hover:bg-[var(--mimoja-blue)] hover:text-white"
                        onclick="window.scanForScales()" data-i18n-key="Search">
                    Search
                </button>
            </div>

            <hr class="border-t border-[#c9c9c9] w-full" />

            <!-- Connected Device -->
            <div class="flex flex-col gap-[16px] items-start relative w-full">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[30px]">
                    <p class="leading-[1.2]" data-i18n-key="Connected Device">Connected Device</p>
                </div>
                <div id="bluetooth-scale-devices-container" class="w-full">
                    <!-- Scale devices will be populated dynamically via WebSocket -->
                </div>
            </div>

            <hr class="border-t border-[#c9c9c9] w-full" />

            <!-- Scale Power Mode -->
            <div class="flex flex-col gap-[16px] items-start relative w-full">
                <div class="flex items-baseline gap-[14px] w-full">
                    <p id="scale-power-management-label" class="font-['Inter:Bold',sans-serif] font-bold not-italic text-[#385a92] text-[30px] leading-[1.2] shrink-0" data-i18n-key="Scale Power Mode">Scale Power Mode</p>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic text-[var(--text-primary)] text-[24px] break-words" data-i18n-key="Controls scale behaviour when machine sleeps.">
                        Controls scale behaviour when machine sleeps.
                    </p>
                </div>
                <div class="flex items-center gap-[8px]" role="group" aria-labelledby="scale-power-management-label">
                    <button class="h-[100px] w-[280px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[28px] flex items-center justify-center cursor-pointer transition-colors duration-200
                        ${scalePowerMode === 'disabled' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                        aria-pressed="${scalePowerMode === 'disabled'}"
                        onclick="window.updateReaSetting('scalePowerMode', 'disabled')" data-i18n-key="Nothing">
                        Nothing
                    </button>
                    <button class="h-[100px] w-[280px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[28px] flex items-center justify-center cursor-pointer transition-colors duration-200
                        ${scalePowerMode === 'displayOff' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                        aria-pressed="${scalePowerMode === 'displayOff'}"
                        onclick="window.updateReaSetting('scalePowerMode', 'displayOff')" data-i18n-key="Display Off">
                        Display Off
                    </button>
                    <button class="h-[100px] w-[280px] rounded-[10px] font-['Inter:Bold',sans-serif] font-bold text-[28px] flex items-center justify-center cursor-pointer transition-colors duration-200
                        ${scalePowerMode === 'disconnect' ? 'bg-[var(--mimoja-blue)] text-white' : 'bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[#b6c3d7]'}"
                        aria-pressed="${scalePowerMode === 'disconnect'}"
                        onclick="window.updateReaSetting('scalePowerMode', 'disconnect')" data-i18n-key="Disconnect">
                        Disconnect
                    </button>
                </div>
            </div>

            <hr class="border-t border-[#c9c9c9] w-full" />

            <!-- Block Shot on No Scale -->
            <div class="flex items-center justify-between w-full">
                <div class="flex items-baseline gap-[14px]">
                    <p class="font-['Inter:Bold',sans-serif] font-bold not-italic text-[#385a92] text-[30px] leading-[1.2] shrink-0">Scale Required</p>
                    <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic text-[var(--text-primary)] text-[24px]" data-i18n-key="Prevent shots from starting when no scale is connected.">
                        Prevent shots from starting when no scale is connected.
                    </p>
                </div>
                <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[100px] h-[50px]">
                    <input type="checkbox" id="block-on-no-scale-toggle" class="sr-only peer" ${blockOnNoScale ? 'checked' : ''} onchange="window.updateReaSetting('blockOnNoScale', this.checked, false)">
                    <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                    <div class="absolute top-1/2 left-[5px] -translate-y-1/2 peer-checked:translate-x-[46px] size-[40px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                </label>
            </div>

            <!-- Manual WiFi scale: rarely needed, so a small link at the bottom that
                 opens a dialog. Most WiFi scales are auto-discovered. -->
            <div class="w-full flex justify-center pt-[8px]">
                <button onclick="window.openWifiScaleModal()"
                        class="text-[#959595] hover:text-[var(--mimoja-blue)] text-[20px] underline underline-offset-4 transition-colors duration-200">
                    Add WiFi scale manually
                </button>
            </div>

            <dialog id="wifi-scale-modal" class="modal">
                <div class="modal-box bg-[var(--box-color)] max-w-2xl">
                    <h3 class="font-bold text-[28px] text-[var(--text-primary)] mb-2">Add WiFi Scale</h3>
                    <p class="text-[20px] text-[var(--text-primary)] opacity-80 mb-4 break-words">
                        Most WiFi scales are found automatically. Enter an IP address or hostname only if yours isn't discovered (e.g. on networks that block mDNS).
                    </p>
                    <div class="flex items-center gap-[8px] w-full">
                        <input id="wifi-scale-host-input" type="text" inputmode="url" autocomplete="off"
                            placeholder="192.168.1.42 or hds.local"
                            class="flex-1 h-[62px] rounded-[10px] px-[16px] text-[24px] bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] text-[var(--text-primary)]"
                            onkeydown="if(event.key==='Enter'){event.preventDefault();window.addWifiScaleFromInput();}" />
                        <button class="border-[var(--mimoja-blue)] text-[var(--mimoja-blue)] h-[62px] rounded-[67.5px] border px-[32px] text-[24px] transition-colors duration-200 hover:bg-[var(--mimoja-blue)] hover:text-white"
                            onclick="window.addWifiScaleFromInput()">
                            Add
                        </button>
                    </div>
                    <div id="wifi-manual-endpoints-container" class="w-full flex flex-col gap-[8px] mt-[16px]">
                        <!-- Manually-added WiFi endpoints populated by renderManualWifiEndpoints() -->
                    </div>
                    <div class="modal-action">
                        <button class="btn" onclick="document.getElementById('wifi-scale-modal').close()">Close</button>
                    </div>
                </div>
            </dialog>

        </div>
    `;
}

// Helper function to render a list of devices of a specific type
function renderDeviceList(containerId, devices, type, preferredId = '', settingKey = '') {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (devices.length > 0) {
        container.innerHTML = renderSingleDeviceList(devices, preferredId, settingKey, type);
    } else {
        container.innerHTML = `
            <div class="flex items-center gap-[16px] w-full bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] rounded-[18px] px-[28px] py-[24px] opacity-60">
                <div class="w-[14px] h-[14px] rounded-full bg-[var(--profile-button-outline-color)] flex-shrink-0"></div>
                <p class="text-[24px] text-[var(--text-primary)]">No ${type.toLowerCase()} found — tap Search to find nearby devices.</p>
            </div>`;
    }
    // The device list is injected via WebSocket updates, after the page's initial
    // translatePage() pass — so re-translate or its data-i18n-key text stays English.
    translatePage();
}

// Helper function to render a single list of devices with connection controls
function renderBatteryBadge(level) {
    const pct  = Math.round(level);
    const color = pct <= 20 ? '#ef4444' : pct <= 50 ? '#eab308' : '#22c55e';
    const fill  = Math.round((pct / 100) * 20);
    return `<div class="flex items-center gap-[6px] mt-[4px]">
        <svg width="26" height="14" viewBox="0 0 26 14" fill="none">
            <rect x="0.5" y="0.5" width="22" height="13" rx="2.5" stroke="${color}" stroke-width="1.2"/>
            <rect x="23" y="4" width="3" height="6" rx="1" fill="${color}"/>
            <rect x="2" y="2" width="${fill}" height="10" rx="1.5" fill="${color}"/>
        </svg>
        <span class="text-[18px] font-mono" style="color:${color}">${pct}%</span>
    </div>`;
}

function renderSingleDeviceList(devices, preferredId = '', settingKey = '', type = '') {
    // Null/empty check - return empty string if no devices
    if (!devices || !Array.isArray(devices) || devices.length === 0) {
        return '';
    }

    let deviceItems = '';

    devices.forEach(device => {
        if (!device || !device.name) return;

        // `available: false` = a remembered device that isn't currently present
        // (reaprime keeps it listed instead of dropping it). Older reaprime
        // builds omit the field → treat as available.
        const isUnavailable = device.available === false;
        const isConnected = !isUnavailable && device.state === 'connected';
        const isPreferred = preferredId && device.id === preferredId;
        const safeId = (device.id || '').replace(/'/g, "\\'");
        const safeName = (device.name || '').replace(/'/g, "\\'");
        const safeSettingKey = settingKey.replace(/'/g, "\\'");

        const dotClass = isConnected ? 'bg-green-500'
            : isUnavailable ? 'bg-amber-500/40'
            : 'bg-[var(--profile-button-outline-color)]';

        const badge = isConnected
            ? '<span class="text-[20px] font-bold px-[16px] py-[6px] rounded-full bg-green-500/15 text-green-600" data-i18n-key="Connected">Connected</span>'
            : isUnavailable
            ? '<span class="text-[20px] font-bold px-[16px] py-[6px] rounded-full bg-amber-500/15 text-amber-600">Unavailable</span>'
            : '<span class="text-[20px] font-bold px-[16px] py-[6px] rounded-full bg-[var(--profile-button-outline-color)]/30 text-[var(--text-primary)] opacity-50" data-i18n-key="Available">Available</span>';

        let actions;
        if (isUnavailable) {
            // Reconnect = rescan (the device reconnects when it reappears in
            // discovery — not a direct connect, which would fail with no
            // transport). Forget removes it from the remembered registry.
            actions = `
                <button class="border-2 border-[#385a92] text-[#385a92] hover:bg-[#385a92] hover:text-white h-[62px] px-[28px] rounded-[67.5px] text-[22px] font-bold transition-colors duration-200"
                        onclick="window.handleDeviceRescan()" data-i18n-key="Reconnect">Reconnect</button>
                <button class="border-2 border-red-500 text-red-500 hover:bg-red-500 hover:text-white h-[62px] px-[28px] rounded-[67.5px] text-[22px] font-bold transition-colors duration-200"
                        onclick="window.handleForgetDevice('${safeId}', '${safeName}')">Forget</button>`;
        } else {
            const buttonText = isConnected ? 'Disconnect' : 'Connect';
            const buttonAction = isConnected ? 'disconnect' : 'connect';
            actions = `
                <button class="${isConnected ? 'border-2 border-[#385a92] text-[#385a92] hover:bg-[#385a92] hover:text-white' : 'bg-[#385a92] text-white hover:bg-[#2c4a7a]'} h-[62px] px-[32px] rounded-[67.5px] text-[22px] font-bold transition-colors duration-200"
                        onclick="window.handleDeviceConnection('${safeId}', '${buttonAction}')" data-i18n-key="${buttonText}">${buttonText}</button>`;
        }

        deviceItems += `
            <div class="flex items-center justify-between w-full bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] rounded-[18px] px-[28px] py-[24px] mb-[16px] ${isUnavailable ? 'opacity-60' : ''}">
                <div class="flex items-center gap-[16px] flex-1 min-w-0">
                    <!-- Status dot -->
                    <div class="relative flex-shrink-0">
                        <div class="w-[14px] h-[14px] rounded-full ${dotClass}"></div>
                        ${isConnected ? '<div class="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-40"></div>' : ''}
                    </div>
                    <div class="flex flex-col gap-[4px] min-w-0">
                        <span class="text-[26px] font-bold text-[var(--text-primary)] truncate leading-tight">${device.name}</span>
                        <span class="text-[18px] text-[var(--text-primary)] opacity-40 font-mono truncate">${device.id || 'N/A'}</span>
                    </div>
                </div>
                <div class="flex items-center gap-[20px] flex-shrink-0 ml-[24px]">
                    ${(() => {
                        if (type === 'Scale' && isConnected) {
                            const batt = window.getLatestScaleBattery?.();
                            return batt !== null && batt !== undefined ? renderBatteryBadge(batt) : '';
                        }
                        return '';
                    })()}
                    ${settingKey ? `
                    <div class="flex flex-col items-center gap-[4px]">
                        <span class="text-[16px] text-[var(--text-primary)] opacity-50" data-i18n-key="Preferred">Preferred</span>
                        <label class="relative flex items-center cursor-pointer flex-shrink-0 w-[72px] h-[36px]">
                            <input type="checkbox" class="sr-only peer"
                                   ${isPreferred ? 'checked' : ''}
                                   onchange="window.setPreferredDevice('${safeSettingKey}', '${safeId}', this.checked)">
                            <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[#385a92] peer-checked:border-[#385a92]"></div>
                            <div class="absolute top-1/2 left-[4px] -translate-y-1/2 peer-checked:translate-x-[36px] size-[28px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
                        </label>
                    </div>
                    ` : ''}
                    ${badge}
                    ${actions}
                </div>
            </div>
        `;
    });

    return deviceItems;
}




// Function to handle connecting or disconnecting a device
window.handleDeviceConnection = async function(deviceId, action) {
    if (action === 'connect') {
        try {
            sendDeviceCommand({ command: 'connect', deviceId });
            // reaprime #591: connect no longer just completes -- it reports a
            // DeviceConnectResult with a real outcome, so wait for it instead
            // of assuming the command succeeded.
            const result = await awaitDeviceConnectResult(deviceId);
            if (!result) {
                ui.showToast(`${getTranslation('No response from device')} ${deviceId}`, 5000, 'error');
                return;
            }
            switch (result.outcome) {
                case 'connected':
                case 'alreadyConnected':
                    ui.showToast(`${getTranslation('Connected')} to device ${deviceId}`, 3000, 'success');
                    break;
                case 'conflict':
                    ui.showToast(getTranslation('Already connecting -- try again in a moment'), 4000, 'info');
                    break;
                case 'timedOut':
                    ui.showToast(`${getTranslation('Connection timed out')}: ${deviceId}`, 5000, 'error');
                    break;
                default:
                    ui.showToast(`${getTranslation('Failed to connect')}: ${result.error || result.connectionError?.message || deviceId}`, 5000, 'error');
                    break;
            }
            // Device list will update automatically via WebSocket onData callback
        } catch (error) {
            console.error('Error connecting to device:', error);
            ui.showToast(`Failed to connect: ${error.message}`, 5000, 'error');
        }
    } else if (action === 'disconnect') {
        try {
            sendDeviceCommand({ command: 'disconnect', deviceId });
            ui.showToast(`${getTranslation('Disconnected')} from device ${deviceId}`, 3000, 'info');
            // Device list will update automatically via WebSocket onData callback
        } catch (error) {
            console.error('Error disconnecting from device:', error);
            ui.showToast(`Failed to disconnect: ${error.message}`, 5000, 'error');
        }
    }
};


// Forget a remembered device — drop it from the persistent registry so an
// absent ("Unavailable") entry stops showing.
window.handleForgetDevice = async function(deviceId, name) {
    if (!window.confirm(`Forget "${name}"?\nIt will be removed from the list until it connects again.`)) return;
    try {
        await forgetDevice(deviceId);
        ui.showToast(`Forgot ${name}`, 3000, 'info');
        // Optimistic: drop it from the cache + re-render immediately; reaprime
        // also re-emits the device list on the WebSocket, which confirms.
        if (deviceStateCache && Array.isArray(deviceStateCache.devices)) {
            deviceStateCache.devices = deviceStateCache.devices.filter(d => d.id !== deviceId);
            renderDeviceListFromCache();
        }
    } catch (error) {
        console.error('Error forgetting device:', error);
        ui.showToast(`Failed to forget: ${error.message}`, 5000, 'error');
    }
};

// Rescan to reconnect an unavailable (remembered-absent) device — it reconnects
// when it reappears in discovery. A direct connect would fail (no transport).
window.handleDeviceRescan = function() {
    const ws = getDeviceWebSocket?.();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        ui.showToast("Not connected — can't rescan right now", 5000, 'error');
        return;
    }
    try {
        sendDeviceCommand({ command: 'scan', connect: true });
        ui.showToast('Scanning to reconnect…', 2500, 'info');
    } catch (error) {
        console.error('Error starting rescan:', error);
        ui.showToast(`Failed to scan: ${error.message}`, 5000, 'error');
    }
};

// Set or clear the preferred device for a given setting key
window.setPreferredDevice = async function(settingKey, deviceId, isOn) {
    const value = isOn ? deviceId : null;
    try {
        await window.updateReaSetting(settingKey, value);
        // Re-render device lists so only one row shows as preferred
        renderDeviceListFromCache();
    } catch (error) {
        console.error('Error setting preferred device:', error);
        ui.showToast(`Failed to update preferred device: ${error.message}`, 5000, 'error');
    }
};

// Function to scan for machines specifically
window.scanForMachines = async function() {
    try {
        ui.showToast('Scanning for machines...', 2500, 'info');

        // Use WebSocket to trigger scan - results will appear via deviceStateCache
        sendDeviceCommand({ command: 'scan' });
        ui.showToast('Scanning started, results will appear shortly', 3000, 'info');
    } catch (error) {
        console.error('Error scanning for machines:', error);
        ui.showToast(`Error scanning for machines: ${error.message}`, 5000, 'error');
    }
};

// Function to scan for scales specifically
window.scanForScales = async function() {
    try {
        ui.showToast('Scanning for scales...', 2000, 'info');

        // Use WebSocket to trigger scan - results will appear via deviceStateCache
        sendDeviceCommand({ command: 'scan' });
        ui.showToast('Scanning started, results will appear shortly', 3000, 'info');
    } catch (error) {
        console.error('Error scanning for scales:', error);
        ui.showToast(`Error scanning for scales: ${error.message}`, 5000, 'error');
    }
};

// Smart Charging handlers
window.handleSmartChargingModeChange = async function(mode) {
    await updateReaSetting('chargingMode', mode);
};

// ── Keyboard Shortcuts Settings ──────────────────────────────────────────────

const KEYBOARD_ACTIONS = [
    { label: 'Espresso',    state: 'espresso',  defaultKey: 'e' },
    { label: 'Hot Water',   state: 'hotWater',  defaultKey: 'w' },
    { label: 'Steam',       state: 'steam',     defaultKey: 's' },
    { label: 'Flush',       state: 'flush',     defaultKey: 'f' },
    { label: 'Stop',        state: 'idle',      defaultKey: ' ' },
    { label: 'Sleep',       state: 'sleeping',  defaultKey: 'p' },
];

function getKeyBindings() {
    try { return JSON.parse(localStorage.getItem('keyboardBindings') || '{}'); }
    catch { return {}; }
}

function keyDisplayName(key) {
    return key === ' ' ? 'Space' : key.toUpperCase();
}

export function renderKeyboardShortcutsSettings() {
    const saved = getKeyBindings();
    const rows = KEYBOARD_ACTIONS.map(({ label, state, defaultKey }) => {
        const currentKey = saved[state] ?? defaultKey;
        return `
            <div class="content-stretch flex items-center justify-between relative w-full py-[10px] border-b border-[var(--box-color)]">
                <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[#385a92] text-[28px]">
                    <p class="leading-[1.2]">${getTranslation(label)}</p>
                </div>
                <div class="flex items-center gap-[20px]">
                    <span id="kb-current-${state}" class="font-['Inter:Regular',sans-serif] font-normal text-[var(--text-primary)] text-[24px] w-[80px] text-center">${keyDisplayName(currentKey)}</span>
                    <button id="kb-btn-${state}" onclick="window.startKeyRebind('${state}')"
                        class="bg-[#385a92] rounded-[10px] px-[20px] h-[52px] text-white text-[22px] font-bold min-w-[140px]" data-i18n-key="Rebind">
                        Rebind
                    </button>
                </div>
            </div>`;
    }).join('');

    return `
        <div class="content-stretch flex flex-col gap-[40px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Keyboard Shortcuts">Keyboard Shortcuts</p>
            </div>
            <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic relative text-[var(--text-primary)] text-[22px] w-full">
                Click <strong data-i18n-key="Rebind">Rebind</strong> next to an action, then press any key to assign it.
            </p>
            <div class="content-stretch flex flex-col items-start relative w-full">
                ${rows}
            </div>
            <button onclick="window.resetKeyboardBindings()"
                class="border border-[#385a92] rounded-[10px] px-[30px] h-[52px] text-[#385a92] text-[22px] font-bold">
                ${getTranslation('Reset to default')}
            </button>
        </div>`;
}

window.startKeyRebind = function(stateValue) {
    const btn = document.getElementById(`kb-btn-${stateValue}`);
    if (!btn) return;

    btn.textContent = getTranslation('Press a key…');
    btn.disabled = true;

    function onKey(e) {
        e.preventDefault();
        e.stopPropagation();
        document.removeEventListener('keydown', onKey, true);

        btn.disabled = false;

        if (e.key === 'Escape') {
            btn.textContent = getTranslation('Rebind');
            return;
        }

        const newKey = e.key;
        const saved = getKeyBindings();

        // conflict check — is this key already used by another action?
        const conflict = KEYBOARD_ACTIONS.find(({ state, defaultKey }) => {
            if (state === stateValue) return false;
            const currentKey = saved[state] ?? defaultKey;
            return currentKey === newKey;
        });

        if (conflict) {
            btn.textContent = getTranslation('Rebind');
            ui.showToast(`Key "${keyDisplayName(newKey)}" already used by ${conflict.label}`, 4000, 'error');
            return;
        }

        saved[stateValue] = newKey;
        localStorage.setItem('keyboardBindings', JSON.stringify(saved));

        const display = document.getElementById(`kb-current-${stateValue}`);
        if (display) display.textContent = keyDisplayName(newKey);
        btn.textContent = getTranslation('Rebind');

        ui.showToast('Keyboard shortcut saved', 3000, 'success');
    }

    document.addEventListener('keydown', onKey, true);
};

window.resetKeyboardBindings = function() {
    localStorage.removeItem('keyboardBindings');
    updateSettingsContentArea('keyboard_shortcuts');
    ui.showToast(`${getTranslation('Keyboard Shortcuts')} ${getTranslation('Reset to default')}`, 3000, 'success');
};

// ── Home Assistant ─────────────────────────────────────────────────────────
// Decaid already exposes everything Home Assistant needs over plain REST, so
// this page is documentation, not an integration: it prints the YAML with the
// tablet's address already filled in, plus a copy button.

// The host the browser is talking to. When the skin is opened on the tablet
// itself this reads "localhost", which is useless inside Home Assistant, so the
// field stays editable.
function haDefaultHost() {
    try {
        const u = new URL(API_BASE_URL);
        const local = ['localhost', '127.0.0.1', '::1', ''].includes(u.hostname);
        return { host: local ? '' : u.hostname, port: u.port || '8080' };
    } catch {
        return { host: '', port: '8080' };
    }
}

function haBlockHtml(id, title, yaml) {
    return `
        <div class="w-full flex flex-col gap-[10px]">
            <div class="flex items-center justify-between w-full">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[26px] text-[var(--text-primary)]">${title}</span>
                <button onclick="window.haCopyYaml('${id}', this)"
                        class="text-[20px] font-semibold text-[#385a92] px-4 py-1 rounded-[8px] border border-[#385a92] hover:bg-[#385a92] hover:text-white transition-colors">
                    ${getTranslation('Copy')}
                </button>
            </div>
            <pre id="${id}" class="w-full overflow-x-auto rounded-[10px] border border-[#c9c9c9] bg-[var(--box-color)] p-4 text-[18px] leading-[1.4] text-[var(--text-primary)] whitespace-pre">${escapeHtml(yaml)}</pre>
        </div>`;
}

export function renderHomeAssistantSettings() {
    const { host, port } = haDefaultHost();
    const y = haYamlBlocks(host, port);

    return `
        <div class="content-stretch flex flex-col gap-[30px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Semi_Bold',sans-serif] font-semibold justify-center leading-[0] min-w-full not-italic relative text-[var(--text-primary)] text-[36px] text-center w-[min-content]">
                <p class="leading-[1.2]" data-i18n-key="Home Assistant">Home Assistant</p>
            </div>

            <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] text-[var(--text-primary)] text-[22px] w-full">
                ${getTranslation('Copy the blocks below into your Home Assistant configuration, restart Home Assistant, then add the DE1 Machine switch and sensors to a dashboard. No MQTT broker is needed.')}
            </p>

            <div class="flex items-center gap-[20px] w-full">
                <span class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[24px] text-[var(--text-primary)] whitespace-nowrap">
                    ${getTranslation('Tablet address')}
                </span>
                <input id="haHostInput" type="text" value="${escapeHtml(host)}" placeholder="192.168.1.50"
                       oninput="window.haSetHost(this.value)"
                       class="flex-1 rounded-[10px] border border-[#c9c9c9] bg-[var(--box-color)] px-4 h-[52px] text-[24px] text-[var(--text-primary)]" />
                <span class="font-['Inter:Regular',sans-serif] text-[24px] text-[var(--text-primary)]">:${port}</span>
            </div>
            <p class="font-['Inter:Regular',sans-serif] leading-[1.4] text-[var(--text-primary)] text-[20px] w-full opacity-70">
                ${getTranslation('Use the IP address or hostname Home Assistant can reach this tablet on. A static IP or DHCP reservation is recommended so the address does not change.')}
            </p>

            ${haBlockHtml('haYamlRest', getTranslation('Sensors'), y.rest)}
            ${haBlockHtml('haYamlCommand', getTranslation('Commands'), y.command)}
            ${haBlockHtml('haYamlTemplate', getTranslation('On/Off switch'), y.template)}
        </div>`;
}

window.haSetHost = function(value) {
    const { port } = haDefaultHost();
    const y = haYamlBlocks(value.trim(), port);
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('haYamlRest', y.rest);
    set('haYamlCommand', y.command);
    set('haYamlTemplate', y.template);
};

window.haCopyYaml = async function(id, btn) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = el.textContent;
    let ok = false;
    try {
        // navigator.clipboard needs a secure context; the tablet is served over
        // plain http from its own IP, so fall back to the legacy path there.
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            ok = true;
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand('copy');
            ta.remove();
        }
    } catch (e) {
        console.warn('haCopyYaml failed:', e);
    }
    if (btn) {
        btn.textContent = getTranslation(ok ? 'Copied!' : 'Could not copy');
        setTimeout(() => { btn.textContent = getTranslation('Copy'); }, 1500);
    }
};

window.handleNightModeToggle = async function(enabled) {
    await updateReaSetting('nightModeEnabled', enabled);
};

window.handleNightModeTimeChange = async function(type, timeStr) {
    const minutes = timeStringToMinutes(timeStr);
    if (type === 'sleep') {
        await updateReaSetting('nightModeSleepTime', minutes);
    } else {
        await updateReaSetting('nightModeMorningTime', minutes);
    }
};

// The Bluetooth pages paint from the devices-socket cache — renderDeviceListFromCache(),
// called by both page renderers and on every socket update. A second painter used to
// live here (renderAllDevices + a 100 ms bootstrap + window.refreshBluetoothDevices),
// driven by a blocking scan; it referenced a scanForDevices that was never imported
// into this module, so every call threw into its own catch and it painted nothing,
// ever. Deleted rather than repaired: it would have repainted the same containers
// without the preferred-device selection the cache painter passes in.
