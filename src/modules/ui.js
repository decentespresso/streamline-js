import { getProfile, getWorkflow, updateWorkflow, setMachineState, setTargetHotWaterVolume, setTargetHotWaterTemp, setTargetHotWaterDuration, setDe1Settings, setTargetSteamFlow, setTargetSteamDuration, setStopAtTemperature, resyncSteamFromStore, MachineState, getPlugins, persistSharedValue, FLUSH_DURATION_LAST_VALUE_KEY, isBlackScreenSaver } from './api.js';
import { openDB, getSetting, setSetting } from './idb.js';
import { deriveSleepButtonAction, isWakePending } from './screensaver-policy.js';
import { isBengleMachine, isBengleModel } from './machine.js';
import { STEAM_FLOW_PRESETS_BY_MODEL, MILK_STOP_PRESETS, resolveSteamFlowPresetsForModel, resolveSteamTileMode, milkTelemetryValue, steamFlowHighlightIndex, STEAM_SYNC_SYNCED, steamSyncField, foldSteamSyncState, shouldRetrySteamSync } from './steam-mode.js';
import { shouldUseNumpad } from './numpad-policy.js';
import { openContextMenu } from './context-menu.js';
import { logger } from './logger.js';
import * as chart from './chart.js';

function openNumpadModal(...args) {
    import('./numpad-modal.js').then(module => {
        module.initNumpadModal();
        module.openModal(...args);
    });
}
import { getSupportedLanguages, getCurrentLanguage, setLanguage, getTranslation } from './i18n.js';
import { getTotalTime as getShotTotalTime } from './shotData.js';
import { formatTemp, fromDisplayTemp, displayStepToCelsius, boundToDisplay, getTempUnit } from './units.js';


function initLanguageSwitcher() {
    const switcher = document.getElementById('language-switcher');
    if (!switcher) return;

    const supportedLanguages = getSupportedLanguages();
    const currentLanguage = getCurrentLanguage();

    // Populate the dropdown
    switcher.innerHTML = ''; // Clear existing options
    supportedLanguages.forEach(lang => {
        const option = document.createElement('option');
        option.value = lang;
        option.textContent = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang;
        if (lang === currentLanguage) {
            option.selected = true;
        }
        switcher.appendChild(option);
    });

    // Add event listener
    switcher.addEventListener('change', async (event) => {
        event.target.disabled = true;
        try {
            await setLanguage(event.target.value);
            event.target.value = getCurrentLanguage();
        } finally {
            event.target.disabled = false;
        }
    });
}

export function formatStateForDisplay(state) {
    if (!state) return '';
    if (state === MachineState.FW_UPGRADE) return 'FW Upgrade';
    const withSpaces = state.replace(/([A-Z])/g, ' ');
    return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

export function formatTimeAbbreviated(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) {
        return '--s';
    }
    return `${Math.round(seconds)}s`;
}

let currentBrewTempC = 93; // brew temp tile, tracked so +/- steps survive a unit toggle
let brewTempApiDebounce = null;
let currentHotWaterVolume = 0;
let currentHotWaterTemp = 0;
let hotWaterMode = 'volume'; // 'volume' or 'temperature'
let hotWaterTempPresets = [75, 80, 85, 92];
let hotWaterVolPresets = [50, 100, 150, 200];
const DEFAULT_HOT_WATER_TEMP_PRESETS = [75, 80, 85, 92];
const DEFAULT_HOT_WATER_VOL_PRESETS = [50, 100, 150, 200];

let currentSteamDuration = 0;
let currentSteamFlow = 1.5;
let steamMode = 'time'; // 'time' | 'flow' | 'temperature' (temperature = milk auto-stop, Bengle only)
let currentMilkStop = 60; // milk auto-stop target °C (workflow.stopAtTemperature)
let milkProbePresent = false; // live probe presence, fed by app.js (setMilkProbePresent)
let milkStopArmed = false;    // workflow stopAtTemperature > 0, as last seen/written
let milkStopLostToProbe = false; // an armed Milk stop was un-armed by probe loss; restore it on probe return
let steamTimePresets = [15, 30, 45, 60];
let steamFlowPresets = [0.5, 1.0, 1.5, 2.0];
let milkStopPresets = [...MILK_STOP_PRESETS]; // Milk-mode stop-target presets (°C), see steam-mode.js
const DEFAULT_STEAM_TIME_PRESETS = [15, 30, 45, 60];
const STEAM_TIME_PRESETS_KEY = 'steam-time-presets-user';
const DEFAULT_MILK_STOP_PRESETS = [...MILK_STOP_PRESETS];
// Machine-model-specific steam-flow preset groups live in steam-mode.js
// (pure, node-tested). Resolved at boot via setSteamFlowPresetsFromMachineModel().
let DEFAULT_STEAM_FLOW_PRESETS = [...STEAM_FLOW_PRESETS_BY_MODEL.standard];
const STEAM_FLOW_PRESETS_KEY = 'steam-flow-presets-user';
const STEAM_FLOW_PRESET_INDEX_KEY = 'steam-flow-preset-selected-index';
const STEAM_FLOW_PRESETS_MODEL_KEY = 'steam-flow-presets-model';
let selectedSteamFlowPresetIndex = 1; // default = second leftmost
let steamApiDebounce = null;
let hotWaterApiDebounce = null;
const API_DEBOUNCE_MS = 1000;

// When a tile last scheduled a write. The workflow watch reads this: repainting a
// tile from the server between a debounced push and the next keypress would
// reassign the module variable the pending push is about to send, so the user's
// newest value is lost and the number jumps backwards.
let lastTileInteractionAt = 0;
function markTileInteraction() { lastTileInteractionAt = Date.now(); }
export function msSinceTileInteraction() { return Date.now() - lastTileInteractionAt; }

let grindStep = 0.1;

// How long the steam elapsed counter will pick up where it left off. Covers a
// dropped/odd status frame; a genuine second steam session is always further
// apart than this.
const STEAM_RESUME_GRACE_MS = 2000;

export function flashPlusMinusButton(button) {
    // Add the flash animation class
    button.classList.add('flash-animation');

    // Remove the class after the animation duration (280ms as defined in CSS)
    // This allows the button to revert to its original styling
    setTimeout(() => {
        button.classList.remove('flash-animation');
    }, 280);
}

function updateDoseValue(type, newValue) {
    const doseInEl = document.getElementById('dose-in-value');
    const drinkOutEl = document.getElementById('drink-out-value');
    const currentDoseIn = doseInEl ? parseFloat(doseInEl.textContent) : 0;
    const currentDoseOut = drinkOutEl ? parseFloat(drinkOutEl.textContent) : 0;

    const targetYield = type === 'out' ? parseFloat(newValue) : currentDoseOut;
    const payload = {
        context: {
            targetDoseWeight: type === 'in' ? parseFloat(newValue) : currentDoseIn,
            targetYield
        }
    };
    // Non-autonomous machines stop on profile.target_weight, not context.targetYield —
    // fold the yield into the sent profile so the stop matches the UI number.
    const activeProfile = window.app?.getActiveProfileRecord?.()?.profile;
    if (activeProfile && Number.isFinite(targetYield) && targetYield > 0) {
        payload.profile = { ...activeProfile, target_weight: targetYield };
    }

    updateWorkflow(payload).then(() => {
        logger.debug(`Dose ${type} value updated via workflow:`, newValue);
        if (type === 'in') {
            window.app?.saveContextToActiveProfile?.({ targetDoseWeight: parseFloat(newValue) });
        } else {
            window.app?.saveContextToActiveProfile?.({ targetYield: parseFloat(newValue) });
        }
    }).catch(error => {
        logger.error(`Failed to update dose ${type} value via workflow:`, error);
    });
}

export function updateDoseAndDrinkOutValue(newDoseIn, newDrinkOut) {
    const payload = {
        context: {
            targetDoseWeight: newDoseIn,
            targetYield: newDrinkOut
        }
    };
    // Keep the machine stop-at-weight (profile.target_weight) in sync with the yield.
    const activeProfile = window.app?.getActiveProfileRecord?.()?.profile;
    if (activeProfile && Number.isFinite(newDrinkOut) && newDrinkOut > 0) {
        payload.profile = { ...activeProfile, target_weight: newDrinkOut };
    }

    updateWorkflow(payload).then(() => {
        logger.debug(`Dose In and Drink Out values updated via workflow: ${newDoseIn}g : ${newDrinkOut}g`);
        // Same per-profile save the +/- buttons and the numpad do — without it a
        // ratio preset was the one way to set dose/yield that did not stick.
        window.app?.saveContextToActiveProfile?.({ targetDoseWeight: newDoseIn, targetYield: newDrinkOut });
    }).catch(error => {
        logger.error(`Failed to update dose in and drink out values via workflow:`, error);
    });
}

export function updateDrinkOutPresetsDisplay(doseIn, drinkOut) {
    const doseInEl = document.getElementById('dose-in-value');
    const drinkOutEl = document.getElementById('drink-out-value');
    const ratioEl = document.getElementById('drink-ratio-value');

    if (doseInEl) {
        doseInEl.textContent = `${doseIn}g`;
    }
    if (drinkOutEl) {
        drinkOutEl.textContent = `${drinkOut}g`;
    }

    if (doseInEl && drinkOutEl && ratioEl) {
        if (!isNaN(doseIn) && !isNaN(drinkOut) && doseIn > 0) {
            const ratio = drinkOut / doseIn;
            ratioEl.textContent = `(1:${ratio.toFixed(1)})`;
        } else {
            ratioEl.textContent = '(1:--)';
        }
    }

    const target = `${doseIn}:${drinkOut}`;
    syncPresetHighlight(document.getElementById('drink-out-presets'), t => t === target);
}

export function updateTemperatureValue(newValue) {
    getWorkflow().then(workflow => {
        if (workflow && workflow.profile && workflow.profile.steps) {
            // Update temperature on ALL steps as number (not string)
            workflow.profile.steps.forEach(step => {
                step.temperature = parseFloat(newValue);
            });
            
            // Partial update via workflow - only send profile field
            updateWorkflow({ profile: workflow.profile }).then(() => {
                logger.debug('Temperature updated via workflow:', newValue);
                // Save it as a per-profile override, same as dose/yield/grind.
                // The live workflow alone survives an app restart but NOT a
                // profile switch, which re-sends the cached record and would
                // silently restore the profile's baked-in temperature.
                window.app?.saveContextToActiveProfile?.({ brewTemperature: parseFloat(newValue) });
            }).catch(error => {
                logger.error('Failed to update temperature via workflow:', error);
            });
        }
    });
}

export function updateGrindValue(newValue) {
    const workflowUpdate = {
        context: {
            grinderSetting: parseFloat(newValue).toFixed(2)
        }
    };
    updateWorkflow(workflowUpdate).then(() => {
        logger.debug('Grind value updated successfully:', newValue);
    }).catch(error => {
        logger.error('Failed to update grind value:', error);
    });
    window.app?.saveGrindToActiveProfile?.(parseFloat(newValue).toFixed(2));
}

export function updateFlushValue(newValue) {
    // Conform to expected rinseData schema:
    // {
    //   rinseData: {
    //     targetTemperature: number,
    //     duration: number,
    //     flow: number
    //   }
    // }
    const duration = parseFloat(newValue);

    const workflowUpdate = {
        rinseData: {
            // For now, use sensible defaults for targetTemperature and flow.
            // These can be wired to UI controls later if needed.
            duration: isNaN(duration) ? 0 : duration,
        }
    };

    updateWorkflow(workflowUpdate).then(() => {
        logger.debug('Rinse value updated successfully:', workflowUpdate.rinseData);
        persistSharedValue(FLUSH_DURATION_LAST_VALUE_KEY, workflowUpdate.rinseData.duration);
    }).catch(error => {
        logger.error('Failed to update rinse value:', error);
    });
}

export function updateDrinkRatio() {
    const doseInEl = document.getElementById('dose-in-value');
    const drinkOutEl = document.getElementById('drink-out-value');
    const ratioEl = document.getElementById('drink-ratio-value');

    if (doseInEl && drinkOutEl && ratioEl) {
        const doseIn = parseFloat(doseInEl.textContent);
        const drinkOut = parseFloat(drinkOutEl.textContent);

        if (!isNaN(doseIn) && !isNaN(drinkOut) && doseIn > 0) {
            const ratio = drinkOut / doseIn;
            ratioEl.textContent = `(1:${ratio.toFixed(1)})`;
        } else {
            ratioEl.textContent = '(1:--)';
        }
    }
}

function makeEditable(element, onCommit) {
    // Skip on mobile/tablet - numpad modal handles input
    if (shouldUseNumpad()) return;
    
    element.addEventListener('click', () => {
        if (element.parentNode.querySelector('input')) return;

        let isProcessed = false;
        const currentValue = parseFloat(element.textContent);
        const input = document.createElement('input');
        input.type = 'number';
        input.value = currentValue;
        // Increased text size and made the input area bigger
        input.className = 'text-[19px] font-bold text-center w-18 bg-transparent absolute border-2 border-[var(--mimoja-blue)] rounded-lg';
        input.name = element.id; // Recommended for accessibility and autofill
        input.setAttribute('aria-label', element.getAttribute('data-i18n-key') || element.id);

        // Position the input field exactly where the original element is.
        // Use getBoundingClientRect so CSS transforms (translate-x/y on the span,
        // scale on the #scaled-content container) are accounted for.
        const elementRect = element.getBoundingClientRect();
        const parentRect = element.parentNode.getBoundingClientRect();

        // Derive the container scale so we can convert viewport px → design-space px.
        const scaledContent = document.getElementById('scaled-content');
        // scaling.js scales x and y independently, so read both factors.
        const contentRect = scaledContent ? scaledContent.getBoundingClientRect() : null;
        const scale = (scaledContent && scaledContent.offsetWidth > 0)
            ? contentRect.width / scaledContent.offsetWidth
            : 1;
        const scaleY = (scaledContent && scaledContent.offsetHeight > 0)
            ? contentRect.height / scaledContent.offsetHeight
            : scale;

        const relLeft = (elementRect.left - parentRect.left) / scale;
        const relTop  = (elementRect.top  - parentRect.top)  / scaleY;

        input.style.position = 'absolute';
        input.style.left   = (relLeft - 5) + 'px';
        input.style.top    = (relTop  - 5) + 'px';
        input.style.width  = (elementRect.width  / scale + 20) + 'px';
        input.style.height = (elementRect.height / scaleY + 20) + 'px';
        input.style.display = 'flex';
        input.style.alignItems = 'center';
        input.style.justifyContent = 'center';
        input.style.textAlign = 'center';
        input.style.zIndex = '10'; // Ensure input appears above other elements
       // Remove default outline

        // Hide the original element but keep its space reserved
        element.style.visibility = 'hidden';

        // Insert the input into the same parent container
        element.parentNode.appendChild(input);
        input.focus();
        input.select();

        const processChange = (shouldCommit) => {
            if (isProcessed) return;
            isProcessed = true;

            if (shouldCommit) {
                const newValue = parseFloat(input.value);
                if (!isNaN(newValue) && newValue >= 0) {
                    onCommit(newValue);
                }
            }

            // Restore the original element
            element.style.visibility = '';

            input.remove();
        };

        input.addEventListener('blur', () => processChange(true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') processChange(true);
            if (e.key === 'Escape') processChange(false);
        });
    });
}

export function updateHotWaterDisplay(data) {
    const volEl = document.getElementById('hot-water-vol-value');
    const tempEl = document.getElementById('hot-water-temp-value');
    const modeTempEl = document.getElementById('hot-water-mode-temp');
    const modeVolEl = document.getElementById('hot-water-mode-vol');
    if (!volEl || !tempEl || !modeTempEl || !modeVolEl) return;
    if (data.targetHotWaterVolume !== undefined) {
        currentHotWaterVolume = data.targetHotWaterVolume;
    }
    if (data.targetHotWaterTemp !== undefined) {
        currentHotWaterTemp = data.targetHotWaterTemp;
    }

    volEl.textContent = `${currentHotWaterVolume}ml`;
    tempEl.textContent = formatTemp(currentHotWaterTemp, 0);

    const hwTarget = hotWaterMode === 'volume'
        ? `${currentHotWaterVolume}ml`
        : formatTemp(currentHotWaterTemp, 0);
    syncPresetHighlight(document.getElementById('hotwater-presets'), t => t === hwTarget);

    if (hotWaterMode === 'volume') {
        volEl.classList.remove('text-[20px]');
        volEl.classList.add('text-[26px]', 'font-bold', 'text-[var(--text-primary)]');
        tempEl.classList.remove('text-[26px]', 'font-bold');
        tempEl.classList.add('text-[20px]');
        modeVolEl.className = 'text-[var(--mimoja-blue-v2)]';
        modeTempEl.className = 'text-[var(--low-contrast-white)]';
    } else { // temperature mode
        tempEl.classList.remove('text-[20px]');
        tempEl.classList.add('text-[26px]', 'font-bold', 'text-[var(--text-primary)]');
        volEl.classList.remove('text-[26px]', 'font-bold');
        volEl.classList.add('text-[20px]');
        modeTempEl.className = 'text-[var(--mimoja-blue-v2)]';
        modeVolEl.className = 'text-[var(--low-contrast-white)]';
    }
}

function scheduleHotWaterApi() {
    markTileInteraction();
    clearTimeout(hotWaterApiDebounce);
    hotWaterApiDebounce = setTimeout(() => {
        if (hotWaterMode === 'volume') {
            setTargetHotWaterVolume(currentHotWaterVolume).catch(e => logger.error(e));
        } else {
            setTargetHotWaterTemp(currentHotWaterTemp).catch(e => logger.error(e));
        }
    }, API_DEBOUNCE_MS);
}

function incrementHotWater() {
    const hotWaterPlusBtn = document.getElementById('hot-water-vol-plus');
    if (hotWaterPlusBtn) { flashPlusMinusButton(hotWaterPlusBtn); }
    if (hotWaterMode === 'volume') {
        if (currentHotWaterVolume < 255) {
            currentHotWaterVolume += 5;
            if (currentHotWaterVolume > 255) currentHotWaterVolume = 255;
        }
    } else {
        if (currentHotWaterTemp < 100) {
            currentHotWaterTemp = Math.min(100, currentHotWaterTemp + displayStepToCelsius(1));
        }
    }
    updateHotWaterDisplay({ targetHotWaterVolume: currentHotWaterVolume, targetHotWaterTemp: currentHotWaterTemp });
    scheduleHotWaterApi();
}

function decrementHotWater() {
    const hotWaterMinusBtn = document.getElementById('hot-water-vol-minus');
    if (hotWaterMinusBtn) { flashPlusMinusButton(hotWaterMinusBtn); }
    if (hotWaterMode === 'volume') {
        if (currentHotWaterVolume > 0) {
            currentHotWaterVolume -= 5;
            if (currentHotWaterVolume < 0) currentHotWaterVolume = 0;
        }
    } else {
        if (currentHotWaterTemp > 0) {
            currentHotWaterTemp = Math.max(0, currentHotWaterTemp - displayStepToCelsius(1));
        }
    }
    updateHotWaterDisplay({ targetHotWaterVolume: currentHotWaterVolume, targetHotWaterTemp: currentHotWaterTemp });
    scheduleHotWaterApi();
}

function updateHotWaterPresetDisplay() {
    const presetContainer = document.getElementById('hotwater-presets');
    if (!presetContainer) return;

    const presets = hotWaterMode === 'temperature' ? hotWaterTempPresets : hotWaterVolPresets;

    Array.from(presetContainer.children).forEach((button, index) => {
        if (presets[index] !== undefined) {
            button.textContent = hotWaterMode === 'temperature'
                ? formatTemp(presets[index], 0)
                : `${presets[index]}ml`;
        }
    });
}

function toggleHotWaterMode() {
    hotWaterMode = hotWaterMode === 'volume' ? 'temperature' : 'volume';
    logger.info(`Hot water mode switched to: ${hotWaterMode}`);
    updateHotWaterDisplay({ targetHotWaterVolume: currentHotWaterVolume, targetHotWaterTemp: currentHotWaterTemp });
    updateHotWaterPresetDisplay();
}

function setupValueAdjuster(minusBtnId, plusBtnId, valueElId, step, min, formatter, onUpdate, afterUpdate) {
    const minusBtn = document.getElementById(minusBtnId);
    const plusBtn = document.getElementById(plusBtnId);

    if (!minusBtn || !plusBtn || !document.getElementById(valueElId)) return;

    const getStep = () => typeof step === 'function' ? step() : step;
    const format = (v) => typeof formatter === 'function' ? formatter(v) : v;

    let debounceTimer = null;
    const scheduleUpdate = (value) => {
        clearTimeout(debounceTimer);
        markTileInteraction();
        debounceTimer = setTimeout(() => onUpdate(value), API_DEBOUNCE_MS);
    };

    minusBtn.addEventListener('click', (e) => {
        flashPlusMinusButton(e.currentTarget);
        const valueEl = document.getElementById(valueElId);
        if (!valueEl) return;
        let currentValue = parseFloat(valueEl.textContent);
        if (currentValue > min) {
            currentValue -= getStep();
            valueEl.textContent = format(currentValue);
            scheduleUpdate(currentValue);
            if (afterUpdate) afterUpdate(format(currentValue));
        }
    });

    plusBtn.addEventListener('click', (e) => {
        flashPlusMinusButton(e.currentTarget);
        const valueEl = document.getElementById(valueElId);
        if (!valueEl) return;
        let currentValue = parseFloat(valueEl.textContent);
        currentValue += getStep();
        valueEl.textContent = format(currentValue);
        scheduleUpdate(currentValue);
        if (afterUpdate) afterUpdate(format(currentValue));
    });
}

export const LONG_PRESS_MS = 500;

function makeNumpadMockInput(initialValue) {
    return {
        value: String(initialValue ?? ''),
        setAttribute: () => {},
        getAttribute: () => null,
        dispatchEvent: () => {},
    };
}

export function setupPressAndHold(element, clickCallback, longPressCallback, options = {}) {
    if (element.dataset.pressHoldInit) return;
    element.dataset.pressHoldInit = '1';

    const duration = options.duration ?? LONG_PRESS_MS;
    const movementThreshold = options.movementThreshold ?? 10;
    element.style.touchAction = options.touchAction ?? 'manipulation';

    let timer;
    let pointerId = null;
    let pointerType = '';
    let startX = 0;
    let startY = 0;
    let suppressClick = false;
    let suppressClickReset;

    const setActiveRing = (on) => {
        if (on) element.classList.add('long-press-active');
        else element.classList.remove('long-press-active');
    };

    const cancelPress = () => {
        clearTimeout(timer);
        pointerId = null;
        setActiveRing(false);
    };

    const startPress = (event) => {
        if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
        clearTimeout(timer);
        pointerId = event.pointerId;
        pointerType = event.pointerType;
        startX = event.clientX;
        startY = event.clientY;
        suppressClick = false;
        clearTimeout(suppressClickReset);
        setActiveRing(true);
        timer = setTimeout(() => {
            suppressClick = true;
            suppressClickReset = setTimeout(() => { suppressClick = false; }, 1000);
            setActiveRing(false);
            if (pointerType === 'touch' && typeof navigator.vibrate === 'function') {
                try { navigator.vibrate(10); } catch {}
            }
            longPressCallback(element);
        }, duration);
    };

    const movePress = (event) => {
        if (event.pointerId !== pointerId) return;
        if (Math.hypot(event.clientX - startX, event.clientY - startY) > movementThreshold) cancelPress();
    };

    const endPress = (event) => {
        if (event.pointerId === pointerId) cancelPress();
    };

    element.addEventListener('contextmenu', event => {
        event.preventDefault();
        cancelPress();
        longPressCallback(element);
    });

    element.addEventListener('pointerdown', startPress);
    element.addEventListener('pointermove', movePress);
    element.addEventListener('pointerup', endPress);
    element.addEventListener('pointercancel', endPress);
    element.addEventListener('pointerleave', endPress);

    element.addEventListener('click', (event) => {
        if (!suppressClick) return clickCallback();
        suppressClick = false;
        clearTimeout(suppressClickReset);
        event.preventDefault();
        event.stopImmediatePropagation();
    });
}

export function flashElement(element) {
    if (element) {
        element.classList.add('flash');
        setTimeout(() => {
            element.classList.remove('flash');
        }, 300); // 300ms flash duration
    }
}

// ── Milk-probe gating for the steam tile (Bengle) ───────────────────────────
// app.js feeds live probe presence here (same debounced tracker the settings
// steam page consumes). The tile's mode pair follows availability — Milk|Flow
// with the probe, Time|Flow without — and a probe loss un-arms an active milk
// stop and lands the tile on the user's recorded Time/Off fallback, exactly
// like the settings page. The shared skin-local keys keep both views agreeing.

// Last non-temperature stop mode the user chose ('time'|'off') — recorded by
// the settings page; what both views fall back to when the probe disappears.
function readSteamStopFallback() {
    try { return localStorage.getItem('streamline.steamStopModeFallback'); } catch (e) { return null; }
}

// Land the resolved stop mode on the fallback so the settings page (which
// derives its mode from stopAtTemperature + this key) agrees with the tile.
// A stop displaced by probe LOSS is restored by the tile itself on probe
// return (setMilkProbePresent), which re-records 'temperature' then too.
function recordSteamStopMode(mode) {
    try { localStorage.setItem('streamline.steamStopMode', mode); } catch (e) { /* non-fatal */ }
}

// A stop mode the user picks BY HAND overrides any pending probe-loss restore.
// The tile's toggle clears the marker inline (toggleSteamMode); the settings
// page's stop-mode buttons (setSteamStopMode) call this — otherwise an Off/Time
// stop chosen explicitly in Settings while the probe is away would be
// overridden by the auto-re-arm when the probe returns.
export function clearMilkStopProbeRestore() {
    milkStopLostToProbe = false;
}

// Show the tile's mode pair: "Milk | Flow" while the milk stop is offerable,
// else "Time | Flow" (non-Bengle, or Bengle with the probe absent/unplugged).
function updateSteamModeOptions(milkAvailable) {
    const timeEl = document.getElementById('steam-mode-time');
    const milkEl = document.getElementById('steam-mode-milk');
    if (timeEl) timeEl.style.display = milkAvailable ? 'none' : '';
    if (milkEl) milkEl.style.display = milkAvailable ? '' : 'none';
}

export function setMilkProbePresent(present) {
    if (present === milkProbePresent) return;
    milkProbePresent = present;
    if (!isBengleMachine()) return; // milk stop is Bengle-only; the tile pair is Time|Flow regardless
    const fallback = readSteamStopFallback();
    if (!present && (milkStopArmed || steamMode === 'temperature')) {
        // Probe gone → the temperature stop can never trigger: un-arm it on the
        // machine and record the fallback as the stop mode, so the settings
        // page lands there too. Remember the displacement — probe return
        // restores the stop the loss took away (below); a mode the user picks
        // by hand in the meantime clears the marker (toggleSteamMode on the
        // tile, setSteamStopMode in Settings via clearMilkStopProbeRestore).
        milkStopArmed = false;
        milkStopLostToProbe = true;
        setStopAtTemperature(0).catch(e => logger.error(e));
        recordSteamStopMode(fallback === 'off' ? 'off' : 'time');
    }
    if (present && milkStopLostToProbe) {
        // Probe back → restore the Milk stop its loss displaced, exactly as a
        // tap on the tile would: re-arm on the machine and re-record the mode.
        // The resolver then pins 'temperature' and the shared display update
        // below repaints the VALUE in the same breath — the tile must never
        // sit on Milk while still showing the fallback's seconds.
        milkStopLostToProbe = false;
        milkStopArmed = true;
        setStopAtTemperature(currentMilkStop).catch(e => logger.error(e));
        recordSteamStopMode('temperature');
    }
    steamMode = resolveSteamTileMode(steamMode, present, milkStopArmed, fallback);
    updateSteamModeOptions(present);
    updateSteamDisplay({ targetSteamDuration: currentSteamDuration, targetSteamFlow: currentSteamFlow });
    updateSteamPresetDisplay();
}

// 0s reads as "Off" -- duration 0 already sends the steam-off command
// (steamHeaterFor in api.js zeroes targetTemperature alongside it), so the
// tile should say so rather than show a number that looks like a very short
// steam time.
export function formatSteamDuration(v) {
    // Lowercase 'off' (not 'OFF') is the exact CSV key: the translation sheet
    // carries both, and case-insensitive lookup would resolve to whichever one
    // parses last (see i18n-parser.js keyIndex), which is not this one.
    return v === 0 ? getTranslation('off') : `${v}s`;
}

export function updateSteamDisplay(data) {
    const durationEl = document.getElementById('steam-duration-value');
    const flowEl = document.getElementById('steam-flow-value');
    const modeTimeEl = document.getElementById('steam-mode-time');
    const modeFlowEl = document.getElementById('steam-mode-flow');
    const modeMilkEl = document.getElementById('steam-mode-milk');

    if (!durationEl || !flowEl || !modeTimeEl || !modeFlowEl) return;

    if (data.targetSteamDuration !== undefined) {
        currentSteamDuration = data.targetSteamDuration;
    }
    if (data.targetSteamFlow !== undefined) {
        currentSteamFlow = data.targetSteamFlow;
    }
    // Milk auto-stop rides workflow.steamSettings.stopAtTemperature (0 = off).
    // A non-zero target means an armed milk stop — but the tile only shows
    // Milk mode while the stop is actually usable (Bengle + probe present);
    // an armed value arriving with no probe stays gated off the display.
    if (data.stopAtTemperature !== undefined) {
        milkStopArmed = data.stopAtTemperature > 0;
        if (milkStopArmed) currentMilkStop = Math.round(data.stopAtTemperature);
        steamMode = resolveSteamTileMode(
            steamMode, isBengleMachine() && milkProbePresent, milkStopArmed, readSteamStopFallback());
    }

    flowEl.textContent = `${currentSteamFlow.toFixed(1)}`;
    const ACTIVE = 'text-[var(--mimoja-blue-v2)]';
    const INACTIVE = 'text-[var(--low-contrast-white)]';
    if (modeMilkEl) modeMilkEl.className = INACTIVE;

    if (steamMode === 'temperature') {
        durationEl.textContent = formatTemp(currentMilkStop, 0);
        durationEl.classList.remove('text-[20px]');
        durationEl.classList.add('text-[26px]', 'font-bold', 'text-[var(--text-primary)]');
        flowEl.classList.remove('text-[26px]', 'font-bold');
        flowEl.classList.add('text-[20px]');
        if (modeMilkEl) modeMilkEl.className = ACTIVE;
        modeTimeEl.className = INACTIVE;
        modeFlowEl.className = INACTIVE;
    } else if (steamMode === 'time') {
        durationEl.textContent = formatSteamDuration(currentSteamDuration);
        durationEl.classList.remove('text-[20px]');
        durationEl.classList.add('text-[26px]', 'font-bold', 'text-[var(--text-primary)]');
        flowEl.classList.remove('text-[26px]', 'font-bold');
        flowEl.classList.add('text-[20px]');
        modeTimeEl.className = ACTIVE;
        modeFlowEl.className = INACTIVE;
    } else { // flow mode
        durationEl.textContent = formatSteamDuration(currentSteamDuration);
        flowEl.classList.remove('text-[20px]');
        flowEl.classList.add('text-[26px]', 'font-bold', 'text-[var(--text-primary)]');
        durationEl.classList.remove('text-[26px]', 'font-bold');
        durationEl.classList.add('text-[20px]');
        modeFlowEl.className = ACTIVE;
        modeTimeEl.className = INACTIVE;
    }

    paintSteamSyncMark(durationEl, flowEl);
}

// ── Unsynced steam values ────────────────────────────────────────────────────
// A steam write can 503 out of Rea's workflow queue 30s after it was sent
// (decaid#634) — long after the tile painted the new number, so the user is
// left reading a value the machine never got. Colour the number that didn't
// land, and replay it from the KV store, which api.setTargetSteam* now writes
// BEFORE the push precisely so the user's intent survives a failed one.
const STEAM_UNSYNCED_CLASS = 'text-[var(--status-red-color)]';
const STEAM_PRIMARY_CLASS = 'text-[var(--text-primary)]';
const STEAM_SYNC_RETRY_MS = 8000;
let steamSync = { ...STEAM_SYNC_SYNCED };
let steamSyncRetryTimer = null;

// Runs last in updateSteamDisplay: the per-mode branches above re-add
// STEAM_PRIMARY_CLASS on every render, and two colour classes on one element
// would be settled by stylesheet order rather than by us.
function paintSteamSyncMark(durationEl, flowEl) {
    [durationEl, flowEl].forEach(el => {
        el.classList.remove(STEAM_UNSYNCED_CLASS);
        el.classList.add(STEAM_PRIMARY_CLASS);
    });
    if (!steamSync.field) return;
    const target = steamSync.field === 'flow' ? flowEl : durationEl;
    target.classList.remove(STEAM_PRIMARY_CLASS);
    target.classList.add(STEAM_UNSYNCED_CLASS);
}

function applySteamSyncEvent(event) {
    const next = foldSteamSyncState(steamSync, event);
    if (next === steamSync) return;
    const changed = next.field !== steamSync.field;
    steamSync = next;
    if (changed) updateSteamDisplay({});
}

/**
 * Wrap a steam push so a failure is visible instead of silent. The tile has
 * already painted the value optimistically by the time this settles — on
 * failure the number goes red and a retry replays it from the store; on
 * success the same field's mark clears.
 * @param {'duration'|'flow'} field  which tile number this push backs
 * @param {Promise} promise  the in-flight api.setTargetSteam* call
 */
export function pushSteamSetting(field, promise) {
    return promise.then(() => {
        applySteamSyncEvent({ type: 'push-ok', field });
    }).catch(e => {
        logger.error(`Steam ${field} did not reach the machine:`, e);
        applySteamSyncEvent({ type: 'push-failed', field });
        showToast(getTranslation('Steam setting did not reach the machine. Retrying...'), 3000, 'error');
        clearTimeout(steamSyncRetryTimer);
        steamSyncRetryTimer = setTimeout(runSteamSyncRetry, STEAM_SYNC_RETRY_MS);
    });
}

async function runSteamSyncRetry() {
    try {
        await resyncSteamFromStore();
        applySteamSyncEvent({ type: 'retry-ok' });
    } catch (e) {
        logger.warn('Steam resync retry failed:', e);
        applySteamSyncEvent({ type: 'retry-failed' });
        if (shouldRetrySteamSync(steamSync)) {
            steamSyncRetryTimer = setTimeout(runSteamSyncRetry, STEAM_SYNC_RETRY_MS);
        } else {
            showToast(getTranslation('Steam setting still not applied — check the machine connection.'), 4000, 'error');
        }
    }
}

function scheduleSteamApi() {
    markTileInteraction();
    clearTimeout(steamApiDebounce);
    steamApiDebounce = setTimeout(() => {
        if (steamMode === 'time') {
            pushSteamSetting(steamSyncField(steamMode), setTargetSteamDuration(currentSteamDuration));
            // Per-profile save, same call the dose/yield/temp tiles make.
            window.app?.saveContextToActiveProfile?.({ targetSteamDuration: currentSteamDuration });
        } else if (steamMode === 'temperature') {
            // Milk stop now has a KV record of its own, so it takes the same
            // marked-and-retried path as duration and flow (steamSyncField maps
            // it onto 'duration' -- they share the tile element).
            pushSteamSetting(steamSyncField(steamMode), setStopAtTemperature(currentMilkStop));
        } else {
            pushSteamSetting(steamSyncField(steamMode), setTargetSteamFlow(currentSteamFlow));
            window.app?.saveContextToActiveProfile?.({ targetSteamFlow: currentSteamFlow });
        }
    }, API_DEBOUNCE_MS);
}

function syncSteamPresets() {
    if (steamMode === 'temperature') {
        syncPresetHighlight(document.getElementById('steam-milk-presets'), t => t === formatTemp(currentMilkStop, 0));
    } else if (steamMode === 'time') {
        syncPresetHighlight(document.getElementById('steam-presets'), t => t === `${currentSteamDuration}s`);
    } else {
        highlightSteamFlowPreset(steamFlowHighlightIndex(steamFlowPresets, currentSteamFlow));
    }
}

function incrementSteam() {
    const steamPlusBtn = document.getElementById('steam-plus');
    if (steamPlusBtn) { flashPlusMinusButton(steamPlusBtn); }
    if (steamMode === 'time') {
        currentSteamDuration += 1;
    } else if (steamMode === 'temperature') {
        if (currentMilkStop < 80) currentMilkStop = Math.min(80, currentMilkStop + displayStepToCelsius(1));
    } else {
        if (currentSteamFlow < 2.5) {
            currentSteamFlow += 0.1;
        }
    }
    updateSteamDisplay({ targetSteamDuration: currentSteamDuration, targetSteamFlow: currentSteamFlow });
    scheduleSteamApi();
    syncSteamPresets();
}

function decrementSteam() {
    const steamMinusBtn = document.getElementById('steam-minus');
    if (steamMinusBtn) { flashPlusMinusButton(steamMinusBtn); }
    if (steamMode === 'time') {
        if (currentSteamDuration > 0) {
            currentSteamDuration -= 1;
        }
    } else if (steamMode === 'temperature') {
        if (currentMilkStop > 30) currentMilkStop = Math.max(30, currentMilkStop - displayStepToCelsius(1));
    } else {
        // Steps down to 0. Rounding each step keeps repeated 0.1 subtractions off
        // float drift, which at a 0 floor lands on -0.0 (displayed "-0.0") rather
        // than 0.0.
        if (currentSteamFlow > 0) {
            currentSteamFlow = Math.max(0, Math.round((currentSteamFlow - 0.1) * 10) / 10);
        }
    }
    updateSteamDisplay({ targetSteamDuration: currentSteamDuration, targetSteamFlow: currentSteamFlow });
    scheduleSteamApi();
    syncSteamPresets();
}

function updateSteamPresetDisplay() {
    const timePresetContainer = document.getElementById('steam-presets');
    const flowPresetContainer = document.getElementById('steam-flow-presets');
    const milkPresetContainer = document.getElementById('steam-milk-presets');
    if (!timePresetContainer || !flowPresetContainer) return;

    if (steamMode === 'temperature') {
        // Milk stop-target presets — same presentation as the Time presets.
        // Only reachable with milk available (Bengle + probe present): the
        // tile-mode resolver never lands on 'temperature' otherwise.
        timePresetContainer.classList.add('hidden');
        flowPresetContainer.classList.add('hidden');
        if (!milkPresetContainer) return;
        milkPresetContainer.classList.remove('hidden');
        Array.from(milkPresetContainer.children).forEach((button, index) => {
            if (milkStopPresets[index] !== undefined) {
                button.textContent = formatTemp(milkStopPresets[index], 0);
            }
        });
        syncPresetHighlight(milkPresetContainer, t => t === formatTemp(currentMilkStop, 0));
        return;
    }

    milkPresetContainer?.classList.add('hidden');
    if (steamMode === 'flow') {
        timePresetContainer.classList.add('hidden');
        flowPresetContainer.classList.remove('hidden');
        const presets = steamFlowPresets;
        Array.from(flowPresetContainer.children).forEach((button, index) => {
            if (presets[index] !== undefined) {
                button.textContent = `${presets[index].toFixed(1)}`;
            }
        });
        // Highlight derives from the current flow VALUE (steam-mode.js, pure,
        // node-tested); a hand-dialed non-preset flow honestly shows none.
        highlightSteamFlowPreset(steamFlowHighlightIndex(presets, currentSteamFlow));
    } else { // time mode
        timePresetContainer.classList.remove('hidden');
        flowPresetContainer.classList.add('hidden');
        const presets = steamTimePresets;
        const unit = 's';
        Array.from(timePresetContainer.children).forEach((button, index) => {
            if (presets[index] !== undefined) {
                button.textContent = `${presets[index]}${unit}`;
            }
        });
        const timeTarget = `${currentSteamDuration}s`;
        syncPresetHighlight(timePresetContainer, t => t === timeTarget);
    }
}

async function persistSteamFlowPresets() {
    try {
        await setSetting(STEAM_FLOW_PRESETS_KEY, [...steamFlowPresets]);
    } catch (e) {
        logger.warn('Failed to persist steam flow presets:', e);
    }
}

async function persistSteamFlowSelectedIndex(index) {
    try {
        await setSetting(STEAM_FLOW_PRESET_INDEX_KEY, index);
    } catch (e) {
        logger.warn('Failed to persist steam flow preset index:', e);
    }
}

async function persistSteamTimePresets() {
    try {
        await setSetting(STEAM_TIME_PRESETS_KEY, [...steamTimePresets]);
    } catch (e) {
        logger.warn('Failed to persist steam time presets:', e);
    }
}

// Restore user-edited steam time presets at boot. No machine-model dependency,
// unlike steam flow, so this just loads once — no per-model reset logic needed.
async function loadSteamTimePresets() {
    try {
        await openDB();
        const stored = await getSetting(STEAM_TIME_PRESETS_KEY);
        if (Array.isArray(stored) && stored.length === 4) {
            steamTimePresets = stored.map(Number);
            updateSteamPresetDisplay();
        }
    } catch (e) {
        logger.warn('Failed to load steam time presets:', e);
    }
}

// Flush presets have no backing JS array — the value lives directly on each
// button's textContent — so persist/restore work off the DOM instead.
const FLUSH_PRESETS_KEY = 'flush-presets-user';

async function persistFlushPresets(flushPresetsEl) {
    try {
        const values = Array.from(flushPresetsEl.children).map(b => parseFloat(b.textContent));
        await setSetting(FLUSH_PRESETS_KEY, values);
    } catch (e) {
        logger.warn('Failed to persist flush presets:', e);
    }
}

async function loadFlushPresets(flushPresetsEl) {
    try {
        await openDB();
        const stored = await getSetting(FLUSH_PRESETS_KEY);
        const buttons = Array.from(flushPresetsEl.children);
        if (Array.isArray(stored) && stored.length === buttons.length) {
            buttons.forEach((btn, i) => {
                if (typeof stored[i] === 'number' && !isNaN(stored[i])) btn.textContent = `${stored[i]}s`;
            });
        }
    } catch (e) {
        logger.warn('Failed to load flush presets:', e);
    }
}

// Brew temperature presets — canonical Celsius array (mirrors hotWaterTempPresets),
// seeded from the static index.html markup below before any unit-aware rendering runs.
let brewTempPresets = [75, 80, 85, 92];
const DEFAULT_BREW_TEMP_PRESETS = [75, 80, 85, 92];
const TEMP_PRESETS_KEY = 'brew-temp-presets-user';

function updateTempPresetDisplay() {
    const presetContainer = document.getElementById('temp-presets');
    if (!presetContainer) return;
    Array.from(presetContainer.children).forEach((button, index) => {
        if (brewTempPresets[index] !== undefined) {
            button.textContent = formatTemp(brewTempPresets[index], 0);
        }
    });
}

async function persistTempPresets() {
    try {
        await setSetting(TEMP_PRESETS_KEY, [...brewTempPresets]);
    } catch (e) {
        logger.warn('Failed to persist brew temp presets:', e);
    }
}

async function loadTempPresets() {
    try {
        await openDB();
        const stored = await getSetting(TEMP_PRESETS_KEY);
        if (Array.isArray(stored) && stored.length === brewTempPresets.length) {
            brewTempPresets = stored.map(Number);
        }
        updateTempPresetDisplay();
    } catch (e) {
        logger.warn('Failed to load brew temp presets:', e);
    }
}

// Drink-out presets store a "dose:out" pair, not a single number — persist
// the raw label text rather than parsing it.
const DRINK_OUT_PRESETS_KEY = 'drink-out-presets-user';

async function persistDrinkOutPresets(drinkOutPresetsEl) {
    try {
        const values = Array.from(drinkOutPresetsEl.children).map(b => b.textContent.trim());
        await setSetting(DRINK_OUT_PRESETS_KEY, values);
    } catch (e) {
        logger.warn('Failed to persist drink-out presets:', e);
    }
}

async function loadDrinkOutPresets(drinkOutPresetsEl) {
    try {
        await openDB();
        const stored = await getSetting(DRINK_OUT_PRESETS_KEY);
        const buttons = Array.from(drinkOutPresetsEl.children);
        if (Array.isArray(stored) && stored.length === buttons.length) {
            buttons.forEach((btn, i) => {
                if (typeof stored[i] === 'string' && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(stored[i])) btn.textContent = stored[i];
            });
        }
    } catch (e) {
        logger.warn('Failed to load drink-out presets:', e);
    }
}

const HOT_WATER_TEMP_PRESETS_KEY = 'hot-water-temp-presets-user';
const HOT_WATER_VOL_PRESETS_KEY = 'hot-water-vol-presets-user';

async function persistHotWaterPresets() {
    try {
        await setSetting(HOT_WATER_TEMP_PRESETS_KEY, [...hotWaterTempPresets]);
        await setSetting(HOT_WATER_VOL_PRESETS_KEY, [...hotWaterVolPresets]);
    } catch (e) {
        logger.warn('Failed to persist hot water presets:', e);
    }
}

async function loadHotWaterPresets() {
    try {
        await openDB();
        const storedTemp = await getSetting(HOT_WATER_TEMP_PRESETS_KEY);
        const storedVol = await getSetting(HOT_WATER_VOL_PRESETS_KEY);
        if (Array.isArray(storedTemp) && storedTemp.length === 4) hotWaterTempPresets = storedTemp.map(Number);
        if (Array.isArray(storedVol) && storedVol.length === 4) hotWaterVolPresets = storedVol.map(Number);
        if (storedTemp || storedVol) updateHotWaterPresetDisplay();
    } catch (e) {
        logger.warn('Failed to load hot water presets:', e);
    }
}

function syncPresetHighlight(container, matchFn) {
    if (!container) return;
    for (const btn of container.children) {
        const active = matchFn(btn.textContent.trim());
        btn.classList.toggle('preset-active', active);
        btn.classList.remove('text-gray-400', 'text-black');
    }
}

function syncDrinkOutPresets() {
    const dose = parseFloat(document.getElementById('dose-in-value')?.textContent);
    const drink = parseFloat(document.getElementById('drink-out-value')?.textContent);
    if (isNaN(dose) || isNaN(drink)) return;
    syncPresetHighlight(document.getElementById('drink-out-presets'), t => t === `${dose}:${drink}`);
}

function highlightSteamFlowPreset(index) {
    const container = document.getElementById('steam-flow-presets');
    if (!container) return;
    Array.from(container.children).forEach((btn, i) => {
        btn.classList.toggle('preset-active', i === index);
        btn.classList.remove('text-gray-400', 'text-black');
    });
}

export async function setSteamFlowPresetsFromMachineModel(model) {
    // On a Bengle WITH the milk probe the main-screen steam-stop is by milk
    // temperature: replace the "Time" toggle label with "Milk". (Duration stays
    // settable in Settings.) Probe presence usually reports a beat after this
    // runs, so the labels/mode are re-resolved on the presence flip too
    // (setMilkProbePresent). The shared gate in machine.js was set from the
    // same machine info at boot, before the first updateSteamDisplay; this
    // uses the model arg directly so the label always matches the presets
    // resolved below.
    const bengle = isBengleModel(model);
    const milkAvailable = bengle && milkProbePresent;
    updateSteamModeOptions(milkAvailable);
    steamMode = resolveSteamTileMode(steamMode, milkAvailable, milkStopArmed, readSteamStopFallback());
    try {
        await openDB();
        const baseline = resolveSteamFlowPresetsForModel(model);
        DEFAULT_STEAM_FLOW_PRESETS = [...baseline];

        const storedModel = await getSetting(STEAM_FLOW_PRESETS_MODEL_KEY);
        const userPresets = await getSetting(STEAM_FLOW_PRESETS_KEY);
        const storedIndex = await getSetting(STEAM_FLOW_PRESET_INDEX_KEY);

        // If model changed since last save, drop the old user array — its values
        // are tuned for a different group head and would be misleading.
        const sameModel = storedModel && storedModel === String(model || '');
        if (Array.isArray(userPresets) && userPresets.length === 4 && sameModel) {
            steamFlowPresets = userPresets.map(Number);
        } else {
            steamFlowPresets = [...baseline];
            await setSetting(STEAM_FLOW_PRESETS_KEY, [...steamFlowPresets]);
        }
        await setSetting(STEAM_FLOW_PRESETS_MODEL_KEY, String(model || ''));

        selectedSteamFlowPresetIndex = (Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < 4)
            ? storedIndex
            : 1; // second leftmost

        // NO value-push on a routine boot. The persisted workflow flow is
        // the source of truth; restoring the last-tapped preset's VALUE here
        // (and PUTting it to the workflow) is exactly what silently reset a
        // hand-dialed flow on every app load. The tapped index is persisted
        // for preset UX only — it has no write authority over the flow, and
        // the highlight below derives from the flow value instead.
        //
        // The one exception is a genuine machine-model change — one KNOWN
        // model to a DIFFERENT known model: the stored flow was tuned for the
        // old group head, so re-baseline it to the selected preset of the new
        // group. At most once per switch, never on a routine boot, and never
        // from the offline fallback (model == null is "unknown", not a model
        // change — rebasing there would re-open the boot clobber whenever
        // machine info transiently fails).
        const modelChanged = Boolean(storedModel) && Boolean(model) && storedModel !== String(model);
        if (modelChanged) {
            const rebaseValue = steamFlowPresets[selectedSteamFlowPresetIndex];
            if (typeof rebaseValue === 'number' && !isNaN(rebaseValue)) {
                currentSteamFlow = rebaseValue;
                updateSteamDisplay({ targetSteamFlow: rebaseValue });
                try { await setTargetSteamFlow(rebaseValue); }
                catch (e) { logger.warn('Could not push model-change steam-flow re-baseline:', e); }
            }
        }

        // Highlight is derived from the current flow value (a flow matching
        // no preset shows no highlight) — never from the persisted tap index.
        updateSteamPresetDisplay();
        logger.info(`Steam flow presets initialized for model "${model}":`, steamFlowPresets, 'selected index:', selectedSteamFlowPresetIndex, modelChanged ? '(model changed — flow re-baselined)' : '');
    } catch (e) {
        logger.error('Failed to init steam flow presets from machine model:', e);
    }
}

function toggleSteamMode() {
    // Milk is only in the cycle while it's usable (Bengle + probe present);
    // without the probe the tile cycles Time|Flow like a non-Bengle.
    const modes = (isBengleMachine() && milkProbePresent) ? ['temperature', 'flow'] : ['time', 'flow'];
    steamMode = modes[(modes.indexOf(steamMode) + 1) % modes.length];
    milkStopLostToProbe = false; // a hand-picked mode overrides any probe-loss restore
    logger.info(`Steam mode switched to: ${steamMode}`);
    // Milk auto-stop is active iff we're in temperature mode (writes the target
    // or 0 to workflow.stopAtTemperature — same model as the Settings page).
    // The skin-local stop-mode record moves with it so the settings page shows
    // the same choice.
    if (steamMode === 'temperature') {
        milkStopArmed = true;
        setStopAtTemperature(currentMilkStop).catch(e => logger.error(e));
        recordSteamStopMode('temperature');
    } else {
        milkStopArmed = false;
        setStopAtTemperature(0).catch(e => logger.error(e));
        recordSteamStopMode(readSteamStopFallback() === 'off' ? 'off' : 'time');
    }
    updateSteamDisplay({ targetSteamDuration: currentSteamDuration, targetSteamFlow: currentSteamFlow });
    updateSteamPresetDisplay();
}

export function initThemeToggle() {
    const themeToggle = document.getElementById('theme-toggle');
    if (!themeToggle) return;

    const applyTheme = (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);

        // Dynamically import the chart module and apply theme if chart element exists
        if (document.getElementById('plotly-chart')) {
            import('./chart.js').then((chartModule) => {
                chartModule.setTheme(theme);
            }).catch(error => {
                console.error('Error importing chart module:', error);
            });
        }
    };

    const currentTheme = localStorage.getItem('theme') || 'light';
    themeToggle.checked = currentTheme === 'dark';
    applyTheme(currentTheme);

    themeToggle.addEventListener('change', function() {
        const theme = this.checked ? 'dark' : 'light';
        applyTheme(theme);
    });
}

export function initScaleClick(callback) {
    const weightEl = document.getElementById('data-weight');
    const weighttext = document.getElementById('weight-text');
    if (weightEl||weighttext) {
        weightEl.classList.add('cursor-pointer');
        weightEl.addEventListener('click', callback);
        weighttext.addEventListener('click', callback);
    }
}

export function showScaleInfo() {
    const scaleInfoContainer = document.getElementById('scale-info-container');
    if (scaleInfoContainer) {
        scaleInfoContainer.style.display = 'block';
    }
}

// Latest real machine state (source of truth for the sleep/wake button —
// never parse the displayed status text, it's translated/substate-laden).
let currentMachineState = null;

// Screensaver functionality
let screensaverActive = false;
let screensaverElement = null;
let screensaverDimOverlay = null;
let screensaverImages = [];
let screensaverCurrentIndex = 0;
let screensaverCycleInterval = null;

// When we last sent a wake ('idle') the machine has not yet confirmed. 0 = none.
//
// A wake is the one place the skin legitimately gets ahead of the machine: the
// user tapped, so we hide the overlay immediately rather than making them stare
// at it for a round-trip. But for the next frame or three the machine still
// honestly reports 'sleeping', and app.js would dutifully raise the overlay again
// — a ~100–300 ms flash straight back into the user's face. This timestamp lets
// app.js recognise those frames as stale-by-our-own-doing and leave the overlay
// down. It is time-bounded (WAKE_CONFIRM_GRACE_MS), so a wake that is lost or
// refused simply expires and the overlay returns: the suppression can never latch
// the screensaver off.
let wakeRequestedAt = 0;
const DEFAULT_SCREENSAVER_CYCLE_SECONDS = 10;
const MIN_SCREENSAVER_CYCLE_SECONDS = 2;
const MAX_SCREENSAVER_CYCLE_SECONDS = 600;
const DEFAULT_SCREENSAVER = 'url("src/ui/saver-1.jpg")';

function getScreensaverCycleMs() {
    const raw = parseInt(localStorage.getItem('screensaverCycleSeconds'), 10);
    const secs = Number.isFinite(raw) ? raw : DEFAULT_SCREENSAVER_CYCLE_SECONDS;
    const clamped = Math.min(MAX_SCREENSAVER_CYCLE_SECONDS, Math.max(MIN_SCREENSAVER_CYCLE_SECONDS, secs));
    return clamped * 1000;
}

// Detect in-app webview (mirrors logic in app.js initialization). In a native
// webview the host OS dims the actual hardware display, so we skip the CSS
// overlay. In a regular browser there's no hardware control — apply a gray
// overlay so the user sees a visible "dim" while the screensaver is up.
function isInWebView() {
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
    const isStandalone = window.navigator.standalone === true;
    const isAndroidWebView = /Android/.test(ua) && /wv/.test(ua);
    const isIOSWebView = isIOS && !isStandalone && !/Safari\//.test(ua);
    const isDecentWebView = ua.includes('Decent');
    return isAndroidWebView || isIOSWebView || isDecentWebView;
}

export async function initScreensaver() {
    // Idempotent. This used to be called twice — once from initUI() and again
    // straight from app.js's DOMContentLoaded — and each call built ANOTHER
    // <div id="screensaver">, appended it to <body>, and bound another
    // click -> wakeFromScreensaver listener. The module only remembers the last
    // one, so the earlier node was orphaned: a duplicate id, a live listener on an
    // element nothing can ever show, and a second IndexedDB read of the image list.
    //
    // It was harmless only by luck (the orphan stays display:none, so it cannot be
    // clicked). A duplicate id is still a landmine — the first
    // getElementById('screensaver') anyone writes gets the dead one.
    if (screensaverElement) return;

    screensaverElement = document.createElement('div');
    screensaverElement.id = 'screensaver';
    screensaverElement.style.position = 'fixed';
    screensaverElement.style.top = '0';
    screensaverElement.style.left = '0';
    screensaverElement.style.width = '100vw';
    screensaverElement.style.height = '100vh';
    screensaverElement.style.backgroundSize = 'cover';
    screensaverElement.style.backgroundPosition = 'center';
    screensaverElement.style.zIndex = '10000';
    screensaverElement.style.display = 'none';
    screensaverElement.style.justifyContent = 'center';
    screensaverElement.style.alignItems = 'center';

    // Dim overlay child — gray semi-transparent layer used in browser mode.
    screensaverDimOverlay = document.createElement('div');
    screensaverDimOverlay.id = 'screensaver-dim-overlay';
    screensaverDimOverlay.style.position = 'absolute';
    screensaverDimOverlay.style.inset = '0';
    screensaverDimOverlay.style.backgroundColor = 'rgba(40, 40, 40, 0.55)';
    screensaverDimOverlay.style.pointerEvents = 'none';
    screensaverDimOverlay.style.display = 'none';
    screensaverElement.appendChild(screensaverDimOverlay);

    // Tapping the overlay is the one place a screensaver interaction may wake the
    // machine. Bind ONCE: a WebView synthesises `click` from a tap, so binding
    // `touchstart` as well (as this did) sent 'idle' twice per tap. The
    // !screensaverActive guard inside wakeFromScreensaver() is the backstop.
    screensaverElement.addEventListener('click', wakeFromScreensaver);

    document.body.appendChild(screensaverElement);

    try {
        await openDB();
        const stored = await getSetting('screensaverImages');
        if (Array.isArray(stored) && stored.length > 0) {
            screensaverImages = stored;
        }
    } catch (e) {
        // fall through to default
    }
    _applyScreensaverImage();
}

function _applyScreensaverImage() {
    if (!screensaverElement) return;
    if (screensaverImages.length > 0) {
        screensaverElement.style.backgroundImage = `url("${screensaverImages[screensaverCurrentIndex]}")`;
    } else {
        screensaverElement.style.backgroundImage = DEFAULT_SCREENSAVER;
    }
}

export function setScreensaverImages(images) {
    screensaverImages = images;
    screensaverCurrentIndex = 0;
    _applyScreensaverImage();
}

// Called by settings UI when user changes cycle seconds — restart the
// interval so the new cadence takes effect immediately if active.
export function setScreensaverCycleSeconds(seconds) {
    const clamped = Math.min(MAX_SCREENSAVER_CYCLE_SECONDS, Math.max(MIN_SCREENSAVER_CYCLE_SECONDS, parseInt(seconds, 10) || DEFAULT_SCREENSAVER_CYCLE_SECONDS));
    localStorage.setItem('screensaverCycleSeconds', String(clamped));
    if (screensaverActive && screensaverCycleInterval) {
        clearInterval(screensaverCycleInterval);
        screensaverCycleInterval = setInterval(() => {
            screensaverCurrentIndex = (screensaverCurrentIndex + 1) % screensaverImages.length;
            _applyScreensaverImage();
        }, getScreensaverCycleMs());
    }
    return clamped;
}

export function activateScreensaver() {
    if (!screensaverElement) {
        console.error('Screensaver element not initialized');
        return;
    }

    // Black screen saver: a plain black cover, no image and no cycling. It reuses
    // this same element deliberately -- the click -> wakeFromScreensaver listener
    // bound in initScreensaver() is what makes tapping anywhere wake the machine,
    // exactly as it does for the image saver.
    if (isBlackScreenSaver()) {
        screensaverElement.style.backgroundImage = 'none';
        screensaverElement.style.backgroundColor = '#000';
        if (screensaverDimOverlay) screensaverDimOverlay.style.display = 'none';
        screensaverElement.style.display = 'flex';
        screensaverActive = true;
        return;
    }

    screensaverElement.style.backgroundColor = '';
    screensaverCurrentIndex = 0;
    _applyScreensaverImage();
    if (screensaverDimOverlay) {
        screensaverDimOverlay.style.display = isInWebView() ? 'none' : 'block';
    }
    screensaverElement.style.display = 'flex';
    screensaverActive = true;

    if (screensaverImages.length > 1) {
        screensaverCycleInterval = setInterval(() => {
            screensaverCurrentIndex = (screensaverCurrentIndex + 1) % screensaverImages.length;
            _applyScreensaverImage();
        }, getScreensaverCycleMs());
    }
}

/**
 * PURE UI: take the overlay down. Sends NOTHING. Idempotent.
 *
 * This was deactivateScreensaver(), which hid the overlay AND sent
 * setMachineState('idle') — so tearing the overlay down WOKE THE MACHINE. Three
 * of its four callers did not want a wake, and one of them (app.js's snapshot
 * handler, on a branch whose precondition is "the machine is awake") turned a
 * stale frame into the command that cancelled the user's sleep press.
 *
 * A UI teardown must never command the machine. Everything that merely hides the
 * overlay calls this; only wakeFromScreensaver() below may command.
 */
export function hideScreensaver() {
    if (!screensaverActive) return; // idempotent — also kills the click/touchstart double-fire
    if (screensaverCycleInterval) {
        clearInterval(screensaverCycleInterval);
        screensaverCycleInterval = null;
    }
    if (screensaverElement) {
        screensaverElement.style.display = 'none';
    }
    screensaverActive = false;
}

/**
 * The user tapped the screensaver to wake the machine.
 *
 * The ONLY screensaver path allowed to emit a machine command, and it is bound to
 * exactly one thing: a tap on the overlay itself. The hide is a paint; the wake is
 * this explicit, user-initiated command sitting next to it — never inside it.
 */
export function wakeFromScreensaver() {
    if (!screensaverActive) return; // a tap that lands twice only wakes once
    hideScreensaver();
    noteWakeRequested();
    // Until the machine confirms this, its snapshots still say 'sleeping'. If the
    // wake fails, drop the suppression at once rather than making the user wait out
    // the grace period for the overlay they are looking at to come back.
    setMachineState('idle').catch((err) => {
        logger.error('Screensaver tap: failed to wake the machine:', err);
        clearWakeRequest();
    });
}

/** We have asked the machine to wake and are waiting for it to confirm. */
export function noteWakeRequested() {
    wakeRequestedAt = Date.now();
}

/** The wake is settled (confirmed, superseded by a sleep, or failed). */
export function clearWakeRequest() {
    wakeRequestedAt = 0;
}

/** Is a wake we sent still unconfirmed (and still within its grace window)? */
export function isWakeRequestPending() {
    return isWakePending(wakeRequestedAt);
}

export function isScreensaverActive() {
    return screensaverActive;
}

export function initUI(callbacks) {
    initThemeToggle();
    initFullscreenHandler();
    initLanguageSwitcher();
    initScaleClick(callbacks.onWeightClick);
    initScreensaver(); // Initialize screensaver functionality
    const drinkOutValueEl = document.getElementById('drink-out-value');
    const tempValueEl = document.getElementById('temp-value');
    const doseInValueEl = document.getElementById('dose-in-value');
    const grindValueEl = document.getElementById('grind-value');
    const sleepButton = document.getElementById('sleep-button');
    const hotWaterMinusBtn = document.getElementById('hot-water-vol-minus');
    const hotWaterPlusBtn = document.getElementById('hot-water-vol-plus');
    const hotWaterModeToggle = document.getElementById('hot-water-mode-toggle');
    const hotWaterVolValueEl = document.getElementById('hot-water-vol-value');
    const hotWaterTempValueEl = document.getElementById('hot-water-temp-value');
    const tempPresets = document.getElementById('temp-presets');
    const drinkOutPresets = document.getElementById('drink-out-presets');
    const flushPresets = document.getElementById('flush-presets');
    const flushValueEl = document.getElementById('flush-value');
    const hotwaterPresets = document.getElementById('hotwater-presets');
    const steamMinusBtn = document.getElementById('steam-minus');
    const steamPlusBtn = document.getElementById('steam-plus');
    const steamModeToggle = document.getElementById('steam-mode-toggle');
    const steamPresets = document.getElementById('steam-presets');
    const steamFlowPresetsEl = document.getElementById('steam-flow-presets');
    const steamMilkPresetsEl = document.getElementById('steam-milk-presets');
    const machineStateEl = document.getElementById('machine-status');
    if (tempPresets) {
        updateTempPresetDisplay();
        loadTempPresets(); // async restore of user edits, re-renders once loaded

        Array.from(tempPresets.children).forEach((button, index) => {
            button.classList.add('no-select', 'has-context-menu');
            const clickCallback = () => {
                const newValue = brewTempPresets[index];
                if (newValue === undefined) return;

                updateTemperatureValue(newValue);
                updateTemperatureDisplay(newValue);

                syncPresetHighlight(tempPresets, t => t === button.textContent.trim());

                flashElement(document.getElementById('temp-value'));
            };

            const longPressCallback = () => {
                const tempValueEl = document.getElementById('temp-value');
                const currentValueC = fromDisplayTemp(parseFloat(tempValueEl.textContent));
                const presetValue = brewTempPresets[index];
                const defaultValue = DEFAULT_BREW_TEMP_PRESETS[index];
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', formatTemp(presetValue, 0)), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(boundToDisplay(presetValue)), {
                            fieldType: 'temperature',
                            onConfirm: (newVal) => {
                                const num = fromDisplayTemp(parseFloat(newVal));
                                if (isNaN(num)) return;
                                brewTempPresets[index] = num;
                                updateTempPresetDisplay();
                                flashElement(button);
                                showToast(`Preset saved as ${formatTemp(num, 0)}`, 2000, 'success');
                                persistTempPresets();
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', tempValueEl.textContent), disabled: isNaN(currentValueC), onSelect: () => {
                        brewTempPresets[index] = currentValueC;
                        updateTempPresetDisplay();
                        flashElement(button);
                        flashElement(tempValueEl);
                        persistTempPresets();
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', formatTemp(defaultValue, 0)), danger: true, onSelect: () => {
                        brewTempPresets[index] = defaultValue;
                        updateTempPresetDisplay();
                        flashElement(button);
                        showToast(`Preset reverted to ${formatTemp(defaultValue, 0)}`, 2000, 'info');
                        persistTempPresets();
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        });
    }

    if (drinkOutPresets) {
        loadDrinkOutPresets(drinkOutPresets); // async restore of user edits

        for (const button of drinkOutPresets.children) {
            button.classList.add('no-select', 'has-context-menu');
            button.dataset.defaultValue = button.textContent;
            const clickCallback = () => {
                const [doseInStr, drinkOutStr] = button.textContent.split(':');
                const newDoseIn = parseFloat(doseInStr);
                const newDrinkOut = parseFloat(drinkOutStr);

                if (!isNaN(newDoseIn) && !isNaN(newDrinkOut)) {
                    updateDoseAndDrinkOutValue(newDoseIn, newDrinkOut);
                    updateDrinkOutPresetsDisplay(newDoseIn, newDrinkOut);
                    flashElement(document.getElementById('dose-in-value'));
                    flashElement(document.getElementById('drink-out-value'));

                    syncPresetHighlight(drinkOutPresets, t => t === button.textContent.trim());
                }
            };

            const longPressCallback = () => {
                const doseInValue = parseFloat(document.getElementById('dose-in-value').textContent);
                const drinkOutValue = parseFloat(document.getElementById('drink-out-value').textContent);
                const currentLabel = `${doseInValue}:${drinkOutValue}`;
                const [presetDoseStr, presetOutStr] = button.textContent.split(':');
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', button.textContent), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(presetDoseStr), {
                            fieldType: 'dose-in',
                            onConfirm: (doseVal) => {
                                const dose = parseFloat(doseVal);
                                if (isNaN(dose)) return;
                                // Open second numpad for drink-out after dose is confirmed
                                setTimeout(() => {
                                    openNumpadModal(makeNumpadMockInput(presetOutStr), {
                                        fieldType: 'drink-out',
                                        onConfirm: (outVal) => {
                                            const out = parseFloat(outVal);
                                            if (isNaN(out)) return;
                                            button.textContent = `${dose}:${out}`;
                                            flashElement(button);
                                            showToast(`Preset saved as ${button.textContent}`, 2000, 'success');
                                            persistDrinkOutPresets(drinkOutPresets);
                                        },
                                    });
                                }, 150);
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', currentLabel), onSelect: () => {
                        button.textContent = currentLabel;
                        flashElement(button);
                        flashElement(document.getElementById('dose-in-value'));
                        flashElement(document.getElementById('drink-out-value'));
                        persistDrinkOutPresets(drinkOutPresets);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', button.dataset.defaultValue), danger: true, onSelect: () => {
                        button.textContent = button.dataset.defaultValue;
                        flashElement(button);
                        showToast(`Preset reverted to ${button.dataset.defaultValue}`, 2000, 'info');
                        persistDrinkOutPresets(drinkOutPresets);
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        }
    }

    if (flushPresets) {
        loadFlushPresets(flushPresets); // async restore of user edits

        for (const button of flushPresets.children) {
            button.classList.add('no-select', 'has-context-menu');
            button.dataset.defaultValue = button.textContent;
            const clickCallback = () => {
                const newValue = parseFloat(button.textContent);
                if (isNaN(newValue)) return;

                // Use workflow-based update for flush/rinse settings
                updateFlushValue(newValue);
                updateFlushDisplay(newValue);

                syncPresetHighlight(flushPresets, t => t === button.textContent.trim());
                flashElement(document.getElementById('flush-value'));
            };

            const longPressCallback = () => {
                const flushValueEl = document.getElementById('flush-value');
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', button.textContent), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        const current = parseFloat(button.textContent);
                        openNumpadModal(makeNumpadMockInput(isNaN(current) ? '' : current), {
                            fieldType: 'flush',
                            onConfirm: (newVal) => {
                                button.textContent = `${newVal}s`;
                                flashElement(button);
                                showToast(`Preset saved as ${button.textContent}`, 2000, 'success');
                                persistFlushPresets(flushPresets);
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', flushValueEl.textContent), onSelect: () => {
                        button.textContent = flushValueEl.textContent;
                        flashElement(button);
                        flashElement(flushValueEl);
                        persistFlushPresets(flushPresets);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', button.dataset.defaultValue), danger: true, onSelect: () => {
                        button.textContent = button.dataset.defaultValue;
                        flashElement(button);
                        showToast(`Preset reverted to ${button.dataset.defaultValue}`, 2000, 'info');
                        persistFlushPresets(flushPresets);
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        }
    }

    if (hotwaterPresets) {
        // Initial display update
        updateHotWaterPresetDisplay();
        loadHotWaterPresets(); // async restore of user edits, re-renders once loaded

        Array.from(hotwaterPresets.children).forEach((button, index) => {
            button.classList.add('no-select', 'has-context-menu');
            const clickCallback = () => {
                const isTempMode = hotWaterMode === 'temperature';
                const presets = isTempMode ? hotWaterTempPresets : hotWaterVolPresets;
                const newValue = presets[index];

                if (newValue === undefined) return;

                if (isTempMode) {
                    setTargetHotWaterTemp(newValue).catch(e => logger.error(e));
                    updateHotWaterDisplay({ targetHotWaterTemp: newValue });

                    flashElement(document.getElementById('hot-water-temp-value'));

                } else {
                    setTargetHotWaterVolume(newValue).catch(e => logger.error(e));
                    updateHotWaterDisplay({ targetHotWaterVolume: newValue });
                    flashElement(document.getElementById("hot-water-vol-value"));
                }

                syncPresetHighlight(hotwaterPresets, t => t === button.textContent.trim());
            };

            const longPressCallback = () => {
                const isTempMode = hotWaterMode === 'temperature';
                const valueEl = document.getElementById(isTempMode ? 'hot-water-temp-value' : 'hot-water-vol-value');
                const currentValue = isTempMode ? fromDisplayTemp(parseFloat(valueEl.textContent)) : parseFloat(valueEl.textContent);
                const presetValue = (isTempMode ? hotWaterTempPresets : hotWaterVolPresets)[index];
                const defaultValue = (isTempMode ? DEFAULT_HOT_WATER_TEMP_PRESETS : DEFAULT_HOT_WATER_VOL_PRESETS)[index];
                const unit = isTempMode ? '' : 'ml';
                const fieldType = isTempMode ? 'hot-water-temp' : 'hot-water-vol';
                const fmt = (v) => isTempMode ? formatTemp(v, 0) : `${v}${unit}`;
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', fmt(presetValue)), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(isTempMode ? boundToDisplay(presetValue) : presetValue), {
                            fieldType,
                            onConfirm: (newVal) => {
                                const raw = parseFloat(newVal);
                                if (isNaN(raw)) return;
                                const num = isTempMode ? fromDisplayTemp(raw) : raw;
                                if (isTempMode) hotWaterTempPresets[index] = num;
                                else hotWaterVolPresets[index] = num;
                                updateHotWaterPresetDisplay();
                                persistHotWaterPresets();
                                flashElement(button);
                                showToast(`Preset saved as ${fmt(num)}`, 2000, 'success');
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', valueEl.textContent), disabled: isNaN(currentValue), onSelect: () => {
                        if (isTempMode) hotWaterTempPresets[index] = currentValue;
                        else hotWaterVolPresets[index] = currentValue;
                        updateHotWaterPresetDisplay();
                        persistHotWaterPresets();
                        flashElement(button);
                        flashElement(valueEl);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', fmt(defaultValue)), danger: true, onSelect: () => {
                        if (isTempMode) hotWaterTempPresets[index] = defaultValue;
                        else hotWaterVolPresets[index] = defaultValue;
                        updateHotWaterPresetDisplay();
                        persistHotWaterPresets();
                        flashElement(button);
                        showToast(`Preset reverted to ${fmt(defaultValue)}`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        });
    }

    if (steamPresets) {
        updateSteamPresetDisplay();
        loadSteamTimePresets(); // async restore of user edits, re-renders once loaded

        Array.from(steamPresets.children).forEach((button, index) => {
            button.classList.add('no-select', 'has-context-menu');
            const clickCallback = () => {
                const newValue = steamTimePresets[index];
                if (newValue === undefined) return;

                pushSteamSetting('duration', setTargetSteamDuration(newValue));
                window.app?.saveContextToActiveProfile?.({ targetSteamDuration: newValue });
                updateSteamDisplay({ targetSteamDuration: newValue });

                syncPresetHighlight(steamPresets, t => t === button.textContent.trim());
                flashElement(document.getElementById('steam-duration-value'));
            };

            const longPressCallback = () => {
                const valueEl = document.getElementById('steam-duration-value');
                const currentValue = parseFloat(valueEl.textContent);
                const presetValue = steamTimePresets[index];
                const defaultValue = DEFAULT_STEAM_TIME_PRESETS[index];
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', `${presetValue}s`), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(presetValue), {
                            fieldType: 'steam-duration',
                            onConfirm: (newVal) => {
                                const num = parseFloat(newVal);
                                if (isNaN(num)) return;
                                steamTimePresets[index] = num;
                                updateSteamPresetDisplay();
                                persistSteamTimePresets();
                                flashElement(button);
                                showToast(`Preset saved as ${num}s`, 2000, 'success');
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', valueEl.textContent), disabled: isNaN(currentValue), onSelect: () => {
                        steamTimePresets[index] = currentValue;
                        updateSteamPresetDisplay();
                        persistSteamTimePresets();
                        flashElement(button);
                        flashElement(valueEl);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', `${defaultValue}s`), danger: true, onSelect: () => {
                        steamTimePresets[index] = defaultValue;
                        updateSteamPresetDisplay();
                        persistSteamTimePresets();
                        flashElement(button);
                        showToast(`Preset reverted to ${defaultValue}s`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        });
    }

    if (steamMilkPresetsEl) {
        updateSteamPresetDisplay();

        Array.from(steamMilkPresetsEl.children).forEach((button, index) => {
            button.classList.add('no-select', 'has-context-menu');
            const clickCallback = () => {
                const newValue = milkStopPresets[index];
                if (newValue === undefined) return;

                // Same write path as the tile's +/- and mode toggle: the milk
                // stop rides workflow.steamSettings.stopAtTemperature. Feeding
                // the value back through updateSteamDisplay keeps the armed
                // flag and displayed target in step, exactly as a workflow
                // echo would.
                setStopAtTemperature(newValue).catch(e => logger.error(e));
                updateSteamDisplay({ stopAtTemperature: newValue });

                syncPresetHighlight(steamMilkPresetsEl, t => t === button.textContent.trim());
                flashElement(document.getElementById('steam-duration-value'));
            };

            const longPressCallback = () => {
                const valueEl = document.getElementById('steam-duration-value');
                const currentValueC = fromDisplayTemp(parseFloat(valueEl.textContent));
                const presetValue = milkStopPresets[index];
                const defaultValue = DEFAULT_MILK_STOP_PRESETS[index];
                // Milk-stop writes are clamped to 30–80 °C everywhere (tile
                // +/- and the settings page) — preset edits follow the same rule.
                // 80 is the API ceiling: rest_v1.yml SteamSettings.stopAtTemperature
                // documents range 0..80.
                const clampMilkStop = (num) => Math.max(30, Math.min(80, Math.round(num)));
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', formatTemp(presetValue, 0)), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(boundToDisplay(presetValue)), {
                            fieldType: 'milk-stop',
                            config: { title: 'MILK STOP', unit: getTempUnit() === 'F' ? '°F' : '°c', defaultValue: '60', min: boundToDisplay(30), max: boundToDisplay(80) },
                            onConfirm: (newVal) => {
                                const num = fromDisplayTemp(parseFloat(newVal));
                                if (isNaN(num)) return;
                                milkStopPresets[index] = clampMilkStop(num);
                                updateSteamPresetDisplay();
                                flashElement(button);
                                showToast(`Preset saved as ${formatTemp(milkStopPresets[index], 0)}`, 2000, 'success');
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', valueEl.textContent), disabled: isNaN(currentValueC), onSelect: () => {
                        milkStopPresets[index] = clampMilkStop(currentValueC);
                        updateSteamPresetDisplay();
                        flashElement(button);
                        flashElement(valueEl);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', formatTemp(defaultValue, 0)), danger: true, onSelect: () => {
                        milkStopPresets[index] = defaultValue;
                        updateSteamPresetDisplay();
                        flashElement(button);
                        showToast(`Preset reverted to ${formatTemp(defaultValue, 0)}`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        });
    }

    if (steamFlowPresetsEl) {
        updateSteamPresetDisplay();

        Array.from(steamFlowPresetsEl.children).forEach((button, index) => {
            button.classList.add('no-select', 'has-context-menu');
            const clickCallback = () => {
                const newValue = steamFlowPresets[index];
                if (newValue === undefined) return;

                setTargetSteamFlow(newValue).catch(e => logger.error(e));
                window.app?.saveContextToActiveProfile?.({ targetSteamFlow: newValue });
                updateSteamDisplay({ targetSteamFlow: newValue });

                highlightSteamFlowPreset(index);
                selectedSteamFlowPresetIndex = index;
                persistSteamFlowSelectedIndex(index);
                flashElement(document.getElementById('steam-flow-value'));
            };

            const longPressCallback = () => {
                const valueEl = document.getElementById('steam-flow-value');
                const currentValue = parseFloat(valueEl.textContent);
                const presetValue = steamFlowPresets[index];
                const defaultValue = DEFAULT_STEAM_FLOW_PRESETS[index];
                openContextMenu(button, [
                    { label: getTranslation('Apply {value}').replace('{value}', `${presetValue.toFixed(1)}ml/s`), onSelect: clickCallback },
                    { label: getTranslation('Enter value'), onSelect: () => {
                        openNumpadModal(makeNumpadMockInput(presetValue.toFixed(1)), {
                            fieldType: 'steam-flow',
                            onConfirm: (newVal) => {
                                const num = parseFloat(newVal);
                                if (isNaN(num)) return;
                                steamFlowPresets[index] = num;
                                updateSteamPresetDisplay();
                                persistSteamFlowPresets();
                                flashElement(button);
                                showToast(`Preset saved as ${num.toFixed(1)}ml/s`, 2000, 'success');
                            },
                        });
                    } },
                    { label: getTranslation('Save current ({value}) here').replace('{value}', `${valueEl.textContent}ml/s`), disabled: isNaN(currentValue), onSelect: () => {
                        steamFlowPresets[index] = currentValue;
                        updateSteamPresetDisplay();
                        persistSteamFlowPresets();
                        flashElement(button);
                        flashElement(valueEl);
                    } },
                    { label: getTranslation('Revert to {value}').replace('{value}', `${defaultValue.toFixed(1)}ml/s`), danger: true, onSelect: () => {
                        steamFlowPresets[index] = defaultValue;
                        updateSteamPresetDisplay();
                        persistSteamFlowPresets();
                        flashElement(button);
                        showToast(`Preset reverted to ${defaultValue.toFixed(1)}ml/s`, 2000, 'info');
                    } },
                ]);
            };

            setupPressAndHold(button, clickCallback, longPressCallback);
        });
    }

    if (sleepButton) {
        // One tap used to send 'sleeping' and then 'idle' 46 ms later, so the
        // machine slept and instantly woke. Two defects, both closed here:
        //
        //  1. The button raised the screensaver OPTIMISTICALLY, before the machine
        //     had confirmed the sleep. The next snapshot still said 'idle', so
        //     app.js's "machine is awake, tidy the overlay away" branch tore the
        //     overlay down — and the teardown used to wake the machine. There is no
        //     optimistic activation any more: app.js raises the screensaver when the
        //     machine CONFIRMS 'sleeping', which is the only source of truth.
        //  2. A fast double-tap could read a stale currentMachineState (it lags the
        //     machine by a snapshot) and derive the OPPOSITE action, undoing the
        //     first press. The in-flight guard makes the second tap a no-op.
        let sleepRequestInFlight = false;

        sleepButton.addEventListener('click', async () => {
            if (sleepRequestInFlight) return;
            sleepRequestInFlight = true;

            const action = deriveSleepButtonAction({
                machineState: currentMachineState,
                screensaverActive: isScreensaverActive(),
            });

            try {
                // The hide is a paint. The command below is the only command — and
                // when the machine is already awake, `action.command` is 'sleeping',
                // so no path through here can wake a machine the user just slept.
                if (action.hideScreensaver) hideScreensaver();

                // Waking hides the overlay ahead of the machine's confirmation, so
                // tell app.js to ignore the 'sleeping' frames still in flight (they
                // are stale by our own doing) rather than flashing the overlay back
                // up. Sleeping must CLEAR any pending wake instead: a wake followed
                // within the grace window by a sleep would otherwise suppress the
                // screensaver the sleep is supposed to raise.
                if (action.command === 'idle') noteWakeRequested();
                else clearWakeRequest();

                await setMachineState(action.command);
                logger.info(`Sleep button: machine reported "${currentMachineState}" -> requested "${action.command}".`);
            } catch (err) {
                logger.error(`Sleep button: failed to set machine state to "${action.command}":`, err);
                clearWakeRequest(); // the wake never landed — let the overlay come back
            } finally {
                sleepRequestInFlight = false;
            }
        });
    }

    if (doseInValueEl) {
        makeEditable(doseInValueEl, (newValue) => {
            let value = newValue;
            if (value > 30) {
                alert('Dose weight is limited to 30g.');
                value = 30;
            }
            if (value < 0) {
                alert('Dose weight must be at least 0g.');
                value = 0;
            }
            doseInValueEl.textContent = `${value}g`;
            updateDoseValue('in', value);
            updateDrinkRatio();
        });
    }

    if (tempValueEl) {
        makeEditable(tempValueEl, (newValue) => {
            // newValue is whatever the inline editor was seeded with — the
            // currently DISPLAYED number, so it's in the active unit.
            let value = Math.round(newValue);
            const maxDisplay = boundToDisplay(105);
            const minDisplay = boundToDisplay(0);
            if (value > maxDisplay) {
                alert(`Brew temperature is limited to ${formatTemp(105, 0)}.`);
                value = maxDisplay;
            }
            if (value < minDisplay) {
                alert(`Brew temperature must be at least ${formatTemp(0, 0)}.`);
                value = minDisplay;
            }
            currentBrewTempC = fromDisplayTemp(value);
            tempValueEl.textContent = formatTemp(currentBrewTempC, 0);
            updateTemperatureValue(currentBrewTempC);
        });
    }

    if (drinkOutValueEl) {
        makeEditable(drinkOutValueEl, (newValue) => {
            let value = newValue;
            if (value > 2000) {
                alert('Drink weight is limited to 2000g.');
                value = 2000;
            }
            if (value < 0) {
                alert('Drink weight must be at least 0g.');
                value = 0;
            }
            drinkOutValueEl.textContent = `${value}g`;
            updateDoseValue('out', value);
            updateDrinkRatio();
        });
    }

    if (grindValueEl) {
        makeEditable(grindValueEl, (newValue) => {
            let value = newValue;
            if (value > 9999) {
                alert('Grind setting is limited to 9999.');
                value = 9999;
            }
            if (value < 0) {
                alert('Grind setting must be at least 0.');
                value = 0;
            }
            grindStep = Number.isInteger(value) ? 1 : 0.1;
            grindValueEl.textContent = Number.isInteger(value) ? String(value) : value.toFixed(1);
            updateGrindValue(value);
        });
    }

    if (hotWaterVolValueEl) {
        makeEditable(hotWaterVolValueEl, (newValue) => {
            let value = newValue;
            if (value > 255) {
                alert('Hot water volume is limited to 255 ml.');
                value = 255;
            }
            if (value < 0) {
                value = 0; // 0 = no volume limit (stop by time/manual)
            }
            currentHotWaterVolume = value;
            setTargetHotWaterVolume(currentHotWaterVolume).catch(e => logger.error(e));
            updateHotWaterDisplay({ targetHotWaterVolume: currentHotWaterVolume });
        });
    }

    if (hotWaterTempValueEl) {
        makeEditable(hotWaterTempValueEl, (newValue) => {
            // newValue is the displayed number, so it's in the active unit.
            let value = newValue;
            const maxDisplay = boundToDisplay(100);
            const minDisplay = boundToDisplay(0);
            if (value > maxDisplay) {
                alert(`Hot water temperature is limited to ${formatTemp(100, 0)}.`);
                value = maxDisplay;
            }
            if (value < minDisplay) {
                alert(`Hot water temperature must be at least ${formatTemp(0, 0)}.`);
                value = minDisplay;
            }
            currentHotWaterTemp = fromDisplayTemp(value);
            setTargetHotWaterTemp(currentHotWaterTemp).catch(e => logger.error(e));
            updateHotWaterDisplay({ targetHotWaterTemp: currentHotWaterTemp });
        });
    }

    if (flushValueEl) {
        makeEditable(flushValueEl, (newValue) => {

            if (newValue > 255) {
                alert('Flush time is limited to 255s.');
                newValue = 255;
            }
            if (newValue < 0) {
                newValue = 0; // 0 = no flush
            }
            flushValueEl.textContent = `${newValue}s`;
            updateFlushDisplay(newValue);
            updateFlushValue(newValue);
        });
    }

    const steamDurationValueEl = document.getElementById('steam-duration-value');
    if (steamDurationValueEl) {
        makeEditable(steamDurationValueEl, (newValue) => {
            let value = newValue;
            if (value > 255) {
                alert('Steam time is limited to 255s.');
                value = 255;
            }
            if (value < 0) {
                alert('Steam time must be at least 0s.');
                value = 0;
            }
            currentSteamDuration = value;
            pushSteamSetting('duration', setTargetSteamDuration(currentSteamDuration));
            window.app?.saveContextToActiveProfile?.({ targetSteamDuration: currentSteamDuration });
            updateSteamDisplay({ targetSteamDuration: currentSteamDuration });
        });
    }

    const steamFlowValueEl = document.getElementById('steam-flow-value');
    if (steamFlowValueEl) {
        makeEditable(steamFlowValueEl, (newValue) => {
            let value = newValue;
            if (value > 2.5) {
                alert('Steam flow is limited to 2.5 ml/s.');
                value = 2.5;
            }
            if (value < 0.4) {
                alert('Steam flow must be at least 0.4 ml/s.');
                value = 0.4;
            }
            currentSteamFlow = value;
            setTargetSteamFlow(currentSteamFlow).catch(e => logger.error(e));
            window.app?.saveContextToActiveProfile?.({ targetSteamFlow: currentSteamFlow });
            updateSteamDisplay({ targetSteamFlow: currentSteamFlow });
        });
    }

    setupValueAdjuster('drink-out-minus', 'drink-out-plus', 'drink-out-value', 1, 0, (val) => `${val}g`, (val) => { updateDoseValue('out', val); updateDrinkRatio(); }, syncDrinkOutPresets);
    {
        const tempMinusBtn = document.getElementById('temp-minus');
        const tempPlusBtn = document.getElementById('temp-plus');
        if (tempMinusBtn && tempPlusBtn) {
            tempMinusBtn.addEventListener('click', decrementBrewTemp);
            tempPlusBtn.addEventListener('click', incrementBrewTemp);
        }
    }
    setupValueAdjuster('dose-in-minus', 'dose-in-plus', 'dose-in-value', 1, 0, (val) => `${val}g`, (val) => { updateDoseValue('in', val); updateDrinkRatio(); }, syncDrinkOutPresets);
    setupValueAdjuster('grind-minus', 'grind-plus', 'grind-value', () => grindStep, 0, (val) => grindStep === 1 ? String(Math.round(val)) : val.toFixed(1), updateGrindValue);
    setupValueAdjuster('flush-minus', 'flush-plus', 'flush-value', 1, 0, (val) => `${val}s`, (val) => {
        updateFlushValue(val);
        updateFlushDisplay(val);
    }, (fmt) => syncPresetHighlight(document.getElementById('flush-presets'), t => t === fmt));

    if (hotWaterMinusBtn) {
        hotWaterMinusBtn.addEventListener('click', decrementHotWater);
    }

    if (hotWaterPlusBtn) {
        hotWaterPlusBtn.addEventListener('click', incrementHotWater);
    }

    if (hotWaterModeToggle) {
        hotWaterModeToggle.addEventListener('click', toggleHotWaterMode);
        hotWaterModeToggle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHotWaterMode(); } });
    }

    if (steamMinusBtn) {
        steamMinusBtn.addEventListener('click', decrementSteam);
    }

    if (steamPlusBtn) {
        steamPlusBtn.addEventListener('click', incrementSteam);
    }

    if (steamModeToggle) {
        steamModeToggle.addEventListener('click', toggleSteamMode);
        steamModeToggle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSteamMode(); } });
    }

    updateDrinkRatio(); // Initial calculation
}

export function updateSleepButton(state) {
    currentMachineState = state;
    const sleepButton = document.getElementById('sleep-button');
    if (sleepButton) {
        if (state === 'sleeping') {
            const awake = getTranslation('awake');
            sleepButton.textContent = awake.charAt(0).toUpperCase() + awake.slice(1);
            sleepButton.setAttribute('data-i18n-key', 'awake');
        } else {
            sleepButton.textContent = getTranslation('Sleep');
            sleepButton.setAttribute('data-i18n-key', 'Sleep');
        }
    }
}

// "Heating: 12s remaining" is composed in English upstream (app.js:490) because the
// state detection in updateMachineStatus pattern-matches on it, so it can only be
// translated at render time. Returns the two halves separately: they are painted in
// different colours, and the countdown must not be swallowed by the label.
// Sheet rows: 'Heating:' (fr "Chauffant :"), 'Heating', 'remaining' (fr "restant").
function heatingStatusParts(raw) {
    const seconds = /(\d+)\s*s\b/.exec(raw || '')?.[1];
    return seconds
        ? { label: getTranslation('Heating:'), remaining: ` ${seconds}s ${getTranslation('remaining')}` }
        : { label: getTranslation('Heating'), remaining: '' };
}

export function updateMachineStatus(data) {
    const { status, state, substate, stepName, timeValue, isClickable,  isHeating, isHeatingFromTimeToReady, steamTemperature } = data;
    // Steam boiler is considered ready at/above 130°C. Below that it still needs
    // warming, which is the only time we surface a steam "Heating" message.
    const STEAM_HEATER_READY_C = 130;
    const steamHeaterCold = typeof steamTemperature === 'number' && steamTemperature < STEAM_HEATER_READY_C;
    // logger.debug(`Updating machine status to: ${status}, substate: ${substate}, stepName: ${stepName}, time: ${timeValue}, clickable: ${isClickable}`);
    const machineStatusEl = document.getElementById('machine-status');
    const hotWaterVolValueEl = document.getElementById('hot-water-vol-value');
    const flushtimevalue = document.getElementById('flush-value');
    if (!machineStatusEl) {
        return;
    }

    // Define state checks early
    const isEspressoPreparingForShot = status?.toLowerCase().includes('espresso') &&
                                      (substate?.toLowerCase().includes('preparingforshot') ||
                                       substate?.toLowerCase().includes('preparing for shot'));


    const isPreinfusionState = status?.toLowerCase().includes('preinfusion') ||
                               substate?.toLowerCase().includes('preinfusion') ||

                               substate?.toLowerCase().includes('preinfusing') ||
                               (status?.toLowerCase().includes('idle') && substate?.toLowerCase().includes('preinfusion')) ;
                            //    (status?.toLowerCase().includes('espresso') && substate?.toLowerCase().includes('preparingforshot')); substate?.toLowerCase().includes('preparingforshot') ||
    const isPouringState = status?.toLowerCase().includes('pouring') ||
                           substate?.toLowerCase().includes('pouring') ||
                           substate?.toLowerCase().includes('pour') ;
                        //    (status?.toLowerCase().includes('idle') && substate?.toLowerCase().includes('pouring')) ||
                        //    (status?.toLowerCase().includes('espresso') && substate?.toLowerCase().includes('pouring') && !isPreinfusionState) ||
                        //    (status?.toLowerCase().includes('espresso') && substate?.toLowerCase().includes('espresso') && !isPreinfusionState && !substate?.toLowerCase().includes('preparingforshot') && !substate?.toLowerCase().includes('preinfusing'));
    const isFlushState = status?.toLowerCase().includes('flush') ||
                         substate?.toLowerCase().includes('flush') ||
                         status?.includes('Flush (Pouring)');
    const isreadystate = status?.toLowerCase().includes('preparing') ||
                         substate?.toLowerCase().includes('preparing for shot') ;
    // Steam uses its own display and should NOT reuse the shot preinfusion/pouring timer.
    // We care specifically about steam states regardless of substate (e.g. "Steam (Preparing for Shot)", "Steam (Pouring)").
    const isSteamState = (
        (status?.toLowerCase().includes('steam') || status?.toLowerCase().includes('steaming'))
    );

    // Hot water uses its own display and should NOT reuse the preinfusion/pouring timer.
    const isHotWaterState = status?.toLowerCase().includes('hotwater') ||
                            status?.toLowerCase().includes('hot water') ||
                            substate?.toLowerCase().includes('hotwater');
    // "Out of water" is the DE1's own needsWater state, nothing else. Gate on the
    // raw state from the snapshot: the old text match ran on the display string
    // and `includes('need')` caught anything with "need" in it, so the skin could
    // sit on "Out of water" while decaid reported another state entirely.
    const isNeedsWaterState = state === 'needsWater';
    // pouringDone is the post-action tail (e.g. steam auto-purge). DE1 keeps
    // state='steam' during this window but the user-visible action is over —
    // exit the steam counter immediately rather than counting through the purge.
    const isPouringDone = substate === 'pouringDone';

    // Flush should take priority over preinfusion/pouring when both match,
    // e.g. "Flush (Pouring)" should be treated as a flush state, not a shot pour.
    const isCurrentlyFlushState = isFlushState && !isPouringDone;
    const isCurrentlySteamState = isSteamState && !isPouringDone;
    const isCurrentlyHotWaterState = isHotWaterState && !isPouringDone;

    // When we're in a steam, hot water, or flush state, we must NOT treat it as
    // preinfusion/pouring, otherwise the shot timer interval will keep
    // running and overwrite those UIs.
    const isCurrentlyPreinfusionOrPouring =
        !isCurrentlyFlushState &&
        !isCurrentlySteamState &&
        !isCurrentlyHotWaterState &&
        (isPreinfusionState || isPouringState);

    // Log the evaluated state checks (retained as per user request)
    // logger.debug(`isPreinfusionState: ${isPreinfusionState}, status: ${status}, substate: ${substate}`);
    // logger.debug(`isPouringState: ${isPouringState}, status: ${status}, substate: ${substate}`);

    // Clear previous classes and intervals to prevent conflicts
    machineStatusEl.classList.remove('status-msg-green', 'status-msg-red', 'status-msg-clickable', 'text-red-500', 'text-[var(--status-ready-green)]', 'text-[var(--status-needs-water-red)]', 'text-[var(--status-water-blue)]');
    machineStatusEl.onclick = null; // Clear previous click handler

    // Manage preinfusion/pouring interval lifecycle
    if (!isCurrentlyPreinfusionOrPouring && machineStatusEl.preinfusionOrPouringIntervalId) {
        clearInterval(machineStatusEl.preinfusionOrPouringIntervalId);
        delete machineStatusEl.preinfusionOrPouringIntervalId;
    }

    // Manage steam interval lifecycle. The stop is stamped so a status blip --
    // one odd frame, a warning that briefly replaced the status text -- can
    // resume the count instead of restarting it at 0 (issue #60).
    if (!isCurrentlySteamState && machineStatusEl.steamIntervalId) {
        clearInterval(machineStatusEl.steamIntervalId);
        delete machineStatusEl.steamIntervalId;
        machineStatusEl.steamStoppedAt = Date.now();
    }

    // Manage flush interval lifecycle
    if (!isCurrentlyFlushState && machineStatusEl.flushIntervalId) {
        clearInterval(machineStatusEl.flushIntervalId);
        delete machineStatusEl.flushIntervalId;
    }

    // Steam/flush/hotwater pouringDone is the post-action tail (e.g. auto-purge).
    // Freeze the last counter value so the UI doesn't keep ticking through the
    // purge, and don't fall into the espresso pouring branch. Once state leaves
    // steam/flush/hotwater, the normal path renders Ready.
    if (isPouringDone && (isSteamState || isFlushState || isHotWaterState)) {
        if (isSteamState) {
            const steamText = getTranslation('Steaming');
            const frozenValue = typeof machineStatusEl.currentSteamValue === 'number'
                ? machineStatusEl.currentSteamValue
                : 0;
            machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${steamText}:</span> <span class="text-[var(--status-clickable-color)]">${frozenValue}s</span>`;
        } else if (isFlushState) {
            const flushText = getTranslation('Flush');
            const frozenValue = typeof machineStatusEl.currentFlushValue === 'number'
                ? machineStatusEl.currentFlushValue
                : 0;
            machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${flushText}:</span> <span class="text-[var(--status-clickable-color)]">${frozenValue}s</span>`;
        } else {
            const pouringText = getTranslation('Pouring');
            const mlText = (hotWaterVolValueEl && hotWaterVolValueEl.textContent)
                ? hotWaterVolValueEl.textContent.trim()
                : '';
            machineStatusEl.innerHTML = `<span class="text-[var(--status-green-color)]">${pouringText}:</span> <span class="text-[var(--status-clickable-color)]">${mlText}</span>`;
        }
        return;
    }

    // Check if this is a heating state with time remaining and apply special formatting
    const isHeatingWithTimeRemaining = isHeating && isHeatingFromTimeToReady && status && status.includes('Heating: ') && status.includes('s remaining');

    
    // Handle Needs Water state - takes priority
    if (isNeedsWaterState) {
        const outOfWaterText = getTranslation('Out of water') || 'Out of water';
        machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">${outOfWaterText}</span>`;
        logger.debug('DEBUG: Out of water state - Set machine status with red styling');
    } else if (isEspressoPreparingForShot) {
        logger.debug('Entering isEspressoPreparingForShot condition');
        const espressoHeatingWaitText = getTranslation('Heating');
        machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">${espressoHeatingWaitText}</span>`;
    } else if (isHeatingWithTimeRemaining) {
        // Apply different colors to the "Heating:" label and the "Xs remaining" countdown
        const { label: heatingPart, remaining: timeRemainingPart } = heatingStatusParts(status);

        // Apply --status-red-color to "Heating" and --heatingstatus to "Xs remaining" <span class="text-[var(--heatingstatus)]">${timeRemainingPart}</span>
        machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">${heatingPart}</span><span class="text-[var(--heatingstatus)]">${timeRemainingPart}</span>`;
        // logger.info(`DEBUG: Heating with time remaining - Set machine status to: ${machineStatusEl.innerHTML}`);
    } else {
        // Check if this is a preinfusion or pouring state and apply special formatting
        // More comprehensive matching to catch all possible espresso-related states
        // Check for preinfusion states first (more specific)


        if (isCurrentlyPreinfusionOrPouring) { // Use the new combined state check
            // Special handling for preinfusion/pouring state to show time counting up
            // NOTE: We want the label to be able to change from "Preinfusion" to "Pouring"
            // without resetting the timer when the state transitions.
            const stageText = isPreinfusionState ? getTranslation('Preinfusion') : getTranslation('Pouring');

            // Always store the latest stage text so the running interval can pick it up
            machineStatusEl.currentPreinfusionOrPouringStageText = stageText;

            // Only start a new interval if one is NOT already running.
            if (!machineStatusEl.preinfusionOrPouringIntervalId) {
                machineStatusEl.currentPreinfusionOrPouringValue = Math.floor(getShotTotalTime());

                machineStatusEl.preinfusionOrPouringIntervalId = setInterval(() => {
                    // Drive from the same source as shot-data-total-time so the two stay in sync.
                    // Math.floor: integer never reads ahead of the XX.X decimal shown in shot-data.
                    machineStatusEl.currentPreinfusionOrPouringValue = Math.floor(getShotTotalTime());

                    const currentStageText = machineStatusEl.currentPreinfusionOrPouringStageText || stageText;
                    machineStatusEl.innerHTML = `<span class="text-[var(--status-green-color)]">${currentStageText}</span> <span class="text-[var(--status-clickable-color)]">| ${machineStatusEl.currentPreinfusionOrPouringValue}s >></span>`;
                    logger.info(`DEBUG: Preinfusion/Pouring live counter update: ${machineStatusEl.innerHTML}`); // Keep log
                }, 1000);
            }

            // Whenever updateMachineStatus is called in a preinfusion/pouring state,
            // make sure the label and value reflect the *current* stage.
            const displayValue = Math.floor(getShotTotalTime());
            machineStatusEl.currentPreinfusionOrPouringValue = displayValue;
            machineStatusEl.innerHTML = `<span class="text-[var(--status-green-color)]">${stageText}</span> <span class="text-[var(--status-clickable-color)]">| ${displayValue}s <span id="skip-step-indicator" class="cursor-pointer">>></span></span>`;
            
            // Add click handler to the skip indicator
            const skipIndicator = document.getElementById('skip-step-indicator');
            if (skipIndicator) {
                skipIndicator.onclick = (e) => {
                    e.stopPropagation(); // Prevent event bubbling
                    logger.info('Skip step indicator clicked');
                    setMachineState('skipStep').catch(error => {
                        logger.error('Failed to skip step:', error);
                    });
                };
            }
        } else {
            // Check if this is a flush state and apply special formatting


            if (isCurrentlyFlushState) { // Use the new combined state check
                // Special handling for flush state to have different colors for "Flushing" and the value
                const flushText = getTranslation('Flush');
                logger.info(`DEBUG: Detected flush state: ${flushText}`); // Retained as per user request to inspect flush state updates
                // Only start a new interval if one is NOT already running for this state.
                if (!machineStatusEl.flushIntervalId) {
                    machineStatusEl.currentFlushValue = 0; // Start from 0

                    // Start the continuous count-up effect from 0
                    machineStatusEl.flushIntervalId = setInterval(() => {
                        machineStatusEl.currentFlushValue += 1;

                        machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${flushText}:</span> <span class="text-[var(--status-clickable-color)]">${machineStatusEl.currentFlushValue}s</span>`;
                        logger.info(`DEBUG: Flush live counter update: ${machineStatusEl.innerHTML}`);
                    }, 1000);
                    // Manually set the initial state immediately after starting the interval
                    machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${flushText}:</span> <span class="text-[var(--status-clickable-color)]">${machineStatusEl.currentFlushValue}s</span>`;
                }
            } else if (isCurrentlySteamState) {
                // Special handling for steam "pouring" state to show a live time counter.
                const steamText = getTranslation('Steaming');
                const steamwaitingText = getTranslation('Please Wait');
                const steamonlytext = getTranslation('Steam');
                const steamheatingtext = getTranslation('Heating');
                
                // Steam boiler warm-up. Flush/hot water never surface a heating
                // message, so steam shouldn't either unless the heater genuinely
                // needs warming: only show "Steam Heating" below 130°C, otherwise
                // drop straight into the steaming counter (Steaming: 0s).
                const isSteamHeatingPhase =
                    substate?.toLowerCase().includes('preparingforshot') ||
                    substate?.toLowerCase().includes('preparing for shot') ||
                    isreadystate;
                if (isSteamHeatingPhase && steamHeaterCold) {
                    machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">${steamonlytext}${steamheatingtext}:</span><span class="text-[var(--status-clickable-color)]">${steamwaitingText}</span>`;
                } else {
                    // Original steam counter logic for active steaming
                    if (!machineStatusEl.steamIntervalId) {
                        // Steam that reappears within the grace window is the same
                        // session seen through a gap in the status string, not a new
                        // one -- carry the count over. Anything longer starts at 0.
                        const sinceStop = Date.now() - (machineStatusEl.steamStoppedAt ?? 0);
                        const resuming = sinceStop < STEAM_RESUME_GRACE_MS
                            && typeof machineStatusEl.currentSteamValue === 'number';
                        machineStatusEl.currentSteamValue = resuming ? machineStatusEl.currentSteamValue : 0;

                        machineStatusEl.steamIntervalId = setInterval(() => {
                            machineStatusEl.currentSteamValue += 1;

                            machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${steamText}:</span> <span class="text-[var(--status-clickable-color)]">${machineStatusEl.currentSteamValue}s</span>`;
                            logger.info(`DEBUG: Steam live counter update: ${machineStatusEl.innerHTML}`);
                        }, 1000);

                        // Initial render at 0s
                        machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${steamText}:</span> <span class="text-[var(--status-clickable-color)]">${machineStatusEl.currentSteamValue}s</span>`;
                    } else {
                        // If already running, just ensure we render the latest value with correct label.
                        const currentValue = typeof machineStatusEl.currentSteamValue === 'number'
                            ? machineStatusEl.currentSteamValue
                            : 0;
                        machineStatusEl.innerHTML = `<span class="text-[var(--status-ready-green)]">${steamText}:</span> <span class="text-[var(--status-clickable-color)]">${currentValue}s</span>`;
                    }
                }
            } else {
                // Check if this is a hotwater state and apply special formatting
                if (isCurrentlyHotWaterState) {
                    // Special handling for hotwater state to have different colors for "Pouring" and the value.
                    // Use the original hotWaterVolValueEl text (e.g. "150ml") instead of flowAmount.
                    const pouringText = getTranslation('Pouring');
                    const mlText = (hotWaterVolValueEl && hotWaterVolValueEl.textContent)
                        ? hotWaterVolValueEl.textContent.trim()
                        : '';

                    machineStatusEl.innerHTML = `<span class="text-[var(--status-green-color)]">${pouringText}:</span> <span class="text-[var(--status-clickable-color)]">${mlText}</span>`;
                    logger.info(`DEBUG: Hot Water state - Set machine status to: ${machineStatusEl.innerHTML}`);
                } else {
                    // Determine message and class based on status and substate using a mapping approach
                    const statusConfig = getStatusConfiguration(status, substate, stepName, timeValue, isClickable);

                    // Handle plain "Heating" message (without time remaining)
                    if (isHeating && status === "Heating") {
                        machineStatusEl.innerHTML = `<span class="text-[var(--status-red-color)]">${getTranslation('Heating')}</span>`;
                        logger.info(`DEBUG: Generic Heating state - Set machine status to: ${machineStatusEl.innerHTML}`);
                    } else {
                        machineStatusEl.textContent = statusConfig.message;
                        // logger.info(`DEBUG: Generic state from getStatusConfiguration - Set machine status to: ${machineStatusEl.textContent}`);
                        
                    }
                    
                    if (statusConfig.messageClass) {
                        machineStatusEl.classList.add(statusConfig.messageClass);
                    }
                    if (statusConfig.clickHandler) {
                        machineStatusEl.onclick = statusConfig.clickHandler;
                    }
                }
            }
        }
    }
}

function getStatusConfiguration(status, substate, stepName, timeValue, isClickable) {
    // logger.info(`getStatusConfiguration called with: status=${status}, substate=${substate}, stepName=${stepName}, timeValue=${timeValue}, isClickable=${isClickable}`);
    const configMap = {
        'disconnected': {
            message: getTranslation('Disconnected') || 'Disconnected',
            messageClass: 'status-msg-red'
        },
        // Shown only when the screensaver is off (otherwise its overlay hides this).
        'sleeping': {
            message: getTranslation('Sleeping') || 'Sleeping',
            messageClass: 'status-msg-red'
        },
        'error': {
            message: getTranslation('Error') || 'Error',
            messageClass: 'status-msg-red'
        },
        'heating': (inputStatus) => {
            const { label, remaining } = heatingStatusParts(inputStatus);
            return { message: `${label}${remaining}`, additionalClass: 'text-red-500' };
        },
        'idle': {
            message: getTranslation('Ready'),
            messageClass: 'status-msg-green'
        },
        'preinfusion': {
            message: `${stepName} | ${formatTimeAbbreviated(timeValue)} >>`,
            messageClass: isClickable ? 'status-msg-clickable' : 'status-msg-green',
            clickHandler: isClickable ? createStepAdvanceHandler() : null
        },
        'pouring': {
            
            message: `${stepName} | ${formatTimeAbbreviated(timeValue)} >>`,
            messageClass: isClickable ? 'status-msg-clickable' : 'status-msg-green',
            clickHandler: isClickable ? createStepAdvanceHandler() : null
        },
        'flushing': {
            message: `${getTranslation('Flushing')}: ${formatTimeAbbreviated(timeValue)}`,
            messageClass: 'status-msg-red'
        },
        'steaming': {
            message: `${getTranslation('Steaming')}: ${formatTimeAbbreviated(timeValue)}`,
            messageClass: 'status-msg-red'
        },
        'hotwater': {
            message: `${getTranslation('Pouring')}: ${0}ml`,
            messageClass: 'status-msg-green'
        }
    };

    const lowerStatus = status?.toLowerCase() || '';
    const lowerSubstate = substate?.toLowerCase() || '';

    // Prioritized list of states to check against `status` and `substate`
    const statePriority = [
        'disconnected', 'sleeping', 'error', 'heating', 'idle',
        'flushing', 'steaming', 'hotwater',
        'preinfusion', 'pouring'
    ];

    let effectiveState = '';

    // Determine the effective state based on inclusion and priority
    for (const stateKey of statePriority) {
        if (lowerStatus.includes(stateKey)) {
            effectiveState = stateKey;
            break;
        }
        if (lowerSubstate.includes(stateKey)) {
            effectiveState = stateKey;
            break;
        }
    }

    if (effectiveState && configMap[effectiveState]) {
        const config = configMap[effectiveState];
        if (typeof config === 'function') {
            return config(status); // Pass original status for 'heating' as it expects it
        } else {
            // Apply custom formatting for specific states based on requirements
            if (effectiveState === 'hotwater') {
                // For hotwater, show "Pouring(green): x ml(blue)" with different colors for different parts
                return {
                    message: `${getTranslation('Pouring')}: ${hotWaterVolValueEl.textContent || 0}ml`,
                    messageClass: 'status-msg-green-blue'  // Custom class to handle green "Pouring" and blue value
                };
            } else if (effectiveState === 'steaming') {
                // For steaming, show "Steaming: x s" with seconds counting up
                return {
                    message: `${getTranslation('Steaming')}: ${formatTimeAbbreviated(timeValue)}`,
                    messageClass: config.messageClass
                };
            } else if (effectiveState === 'flushing') {
                // For flush, show "Flushing: x s"
                return {
                    message: `${getTranslation('Flushing')}: ${formatTimeAbbreviated(timeValue)}`,
                    messageClass: config.messageClass
                };
            } else {
                return config;
            }
        }
    }

    // Fallback if no specific match
    return {
        message: status || '',
        messageClass: 'status-msg-green'
    };
}

function createStepAdvanceHandler() {
    return () => {
        logger.info('Clickable status message clicked to advance step.');
        // Call the appropriate function to advance the step
        // This would need to be implemented based on the app's architecture
        // window.advanceStep ? window.advanceStep() : null;
    };
}
// Last-seen values, so a unit-preference toggle can re-render instantly
// instead of waiting for the next WebSocket frame.
let lastTemperatures = null;
let lastMilkTelemetry = null;

export function updateTemperatures({ mix, group, steam }) {
    lastTemperatures = { mix, group, steam };
    const mixTempEl = document.getElementById('data-mix-temp');
    const groupTempEl = document.getElementById('data-group-temp');
    const steamTempEl = document.getElementById('data-steam-temp');

    if (mixTempEl) {
        mixTempEl.textContent = formatTemp(mix, 1);
    }
    if (groupTempEl) {
        groupTempEl.textContent = formatTemp(group, 1);
    }
    if (steamTempEl) {
        steamTempEl.textContent = formatTemp(steam, 0);
    }
}

// Live milk-probe temperature in the top telemetry row (right after Weight).
// Fed per snapshot frame by app.js alongside the presence tracker. The field
// only exists while the probe is present — milkTelemetryValue returns null
// (hide entirely, no dashes) for absent probes and unusable readings.
export function updateMilkTelemetry(present, tempC) {
    lastMilkTelemetry = { present, tempC };
    const container = document.getElementById('milk-info-container');
    if (!container) return;
    const value = milkTelemetryValue(present, tempC);
    container.style.display = value === null ? 'none' : '';
    // On Bengle the live Milk reading replaces Mix in the telemetry row; when the
    // probe reading drops out -- or on a DE1, which never shows Milk -- Mix returns.
    const mixEl = document.getElementById('mix-info-container');
    if (mixEl) mixEl.style.display = value === null ? '' : 'none';
    if (value !== null) {
        const el = document.getElementById('data-milk-temp');
        if (el) el.textContent = formatTemp(value, 1);
    }
}

// Re-render every temperature-bearing control in the newly chosen unit,
// without waiting for the next WebSocket frame or user interaction. Each
// tracked value (currentBrewTempC, currentHotWaterTemp, currentMilkStop,
// the preset arrays) stays Celsius-canonical — only the re-render changes.
document.addEventListener('streamline:unitchange', () => {
    if (lastTemperatures) updateTemperatures(lastTemperatures);
    if (lastMilkTelemetry) updateMilkTelemetry(lastMilkTelemetry.present, lastMilkTelemetry.tempC);
    updateTemperatureDisplay(currentBrewTempC);
    updateTempPresetDisplay();
    updateHotWaterDisplay({});
    updateHotWaterPresetDisplay();
    updateSteamDisplay({});
    updateSteamPresetDisplay();
});

export function updateWeight(weight, classUpdates = {}) {
    const { dataWeight, weightText } = classUpdates;
    const weightEl = document.getElementById('data-weight');
    const weightTextEl = document.getElementById('weight-text');

    if (weightEl) {
        if (typeof weight === 'number' && !isNaN(weight)) {
            weightEl.textContent = `${weight.toFixed(1)}g`;
        } else {
            weightEl.textContent = weight;
        }

        if (dataWeight) {
            if (dataWeight.add) {
                weightEl.classList.add(...dataWeight.add);
            }
            if (dataWeight.remove) {
                weightEl.classList.remove(...dataWeight.remove);
            }
        }
    }

    if (weightTextEl) {
        if (weightText) {
            if (weightText.add) {
                weightTextEl.classList.add(...weightText.add);
            }
            if (weightText.remove) {
                weightTextEl.classList.remove(...weightText.remove);
            }
        }
    }
}

export function updateProfileName(name) {
    logger.debug(`Updating profile name to: ${name}`);
    const profileNameEl = document.getElementById('profile-name');
    if (profileNameEl) {
        profileNameEl.firstChild.textContent = getTranslation(name);
    }
}

export function updateDrinkOut(doseOut) {
    logger.debug(`Updating drink out to: ${doseOut}g`);
    const drinkOutValueEl = document.getElementById('drink-out-value');
    if (drinkOutValueEl) {
        drinkOutValueEl.textContent = `${doseOut}g`;
    }
}

export function updateTemperatureDisplay(temperature) {
    currentBrewTempC = parseFloat(temperature);
    const tempValueEl = document.getElementById('temp-value');
    const target = formatTemp(currentBrewTempC, 0);
    if (tempValueEl) {
        tempValueEl.textContent = target;
    }
    syncPresetHighlight(document.getElementById('temp-presets'), t => t === target);
}

// Brew temp +/- steppers. Hand-rolled rather than the generic
// setupValueAdjuster (used by dose/drink/grind/flush): those read the
// displayed number straight off the DOM and treat it as the model value,
// which breaks once the display can show °F — the model must stay Celsius
// while the button step feels like "1 degree" in whichever unit is showing.
function scheduleBrewTempApi() {
    markTileInteraction();
    clearTimeout(brewTempApiDebounce);
    brewTempApiDebounce = setTimeout(() => updateTemperatureValue(currentBrewTempC), API_DEBOUNCE_MS);
}

function incrementBrewTemp(e) {
    flashPlusMinusButton(e.currentTarget);
    currentBrewTempC = Math.min(105, currentBrewTempC + displayStepToCelsius(1));
    updateTemperatureDisplay(currentBrewTempC);
    scheduleBrewTempApi();
}

function decrementBrewTemp(e) {
    flashPlusMinusButton(e.currentTarget);
    currentBrewTempC = Math.max(0, currentBrewTempC - displayStepToCelsius(1));
    updateTemperatureDisplay(currentBrewTempC);
    scheduleBrewTempApi();
}

export function updateFlushDisplay(duration) {
    const flushValueEl = document.getElementById('flush-value');
    if (flushValueEl) {
        flushValueEl.textContent = `${parseFloat(duration).toFixed(0)}s`;
    }
    const target = `${parseFloat(duration).toFixed(0)}s`;
    syncPresetHighlight(document.getElementById('flush-presets'), t => t === target);
}

export function updateGrindDisplay(grinderData) {
    const grindValueEl = document.getElementById('grind-value');
    // Support both new context format (grinderData.grinderSetting) and legacy format (grinderData.setting)
    // Prefer grinderSetting over setting (context takes precedence)
    const grindValue = grinderData?.grinderSetting ?? grinderData?.setting;
    if (grindValueEl && grindValue !== undefined) {
        const parsed = parseFloat(grindValue);
        grindValueEl.textContent = Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1);
    }
}

export function updateDoseInDisplay(doseInValue) {
    const doseInValueEl = document.getElementById('dose-in-value');
    if (doseInValueEl && doseInValue) {
        doseInValueEl.textContent = `${doseInValue}g`;
    }
}

// --- Fullscreen Handling ---

function toggleFullScreen() {
    const doc = window.document;
    const docEl = doc.documentElement;

    const requestFullScreen = docEl.requestFullscreen || docEl.mozRequestFullScreen || docEl.webkitRequestFullScreen || docEl.msRequestFullscreen;
    const cancelFullScreen = doc.exitFullscreen || doc.mozCancelFullScreen || doc.webkitExitFullscreen || doc.msExitFullscreen;

    // Check if fullscreen is active using vendor-prefixed properties
    const isFullScreen = doc.fullscreenElement || doc.mozFullScreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;

    if (!isFullScreen) {
        if (requestFullScreen) {
            requestFullScreen.call(docEl)
                .then(() => {
                    if (screen.orientation?.lock) {
                        screen.orientation.lock('landscape').catch(err => {
                            logger.warn(`Orientation lock failed: ${err.message}`);
                        });
                    }
                })
                .catch(err => {
                    logger.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
                });
        }
    } else {
        if (cancelFullScreen) {
            if (screen.orientation?.unlock) {
                screen.orientation.unlock();
            }
            cancelFullScreen.call(doc).catch(err => {
                logger.error(`Error attempting to exit full-screen mode: ${err.message} (${err.name})`);
            });
        }
    }
}

export function updateFullscreenState() {
    const isFullScreen = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

    const enterIcon = document.querySelector('#fullscreen-toggle-btn .enter-fullscreen-icon');
    const exitIcon = document.querySelector('#fullscreen-toggle-btn .exit-fullscreen-icon');

    if (!enterIcon || !exitIcon) {
        return; // Exit if icons aren't found
    }

    if (isFullScreen) {
        document.body.setAttribute('fullscreen', '');
        enterIcon.style.display = 'none';
        exitIcon.style.display = 'block';
    } else {
        document.body.removeAttribute('fullscreen');
        enterIcon.style.display = 'block';
        exitIcon.style.display = 'none';
    }
}

export function initFullscreenHandler() {
    const fullscreenButton = document.getElementById('fullscreen-toggle-btn'); // Assuming a button with this ID exists

    if (fullscreenButton) {
        const fsEnabled = document.fullscreenEnabled || document.webkitFullscreenEnabled || document.mozFullScreenEnabled || document.msFullscreenEnabled;

        if (fsEnabled) {
            fullscreenButton.addEventListener('click', toggleFullScreen);

            document.addEventListener('fullscreenchange', updateFullscreenState);
            document.addEventListener('webkitfullscreenchange', updateFullscreenState);
            document.addEventListener('mozfullscreenchange', updateFullscreenState);
            document.addEventListener('MSFullscreenChange', updateFullscreenState);

            updateFullscreenState(); // Set initial state
        } else {
            fullscreenButton.style.display = 'none'; // Hide button if not supported
        }
    } else {
        logger.warn('Fullscreen toggle button with id "fullscreen-toggle-btn" not found.');
    }
}

// Single shared timer: without cancelling the previous one, a short toast's hide
// timer fires while a later, longer toast is on screen and cuts it off early --
// e.g. the 1.5s "Hold to assign profile." hint killing the assign error 1.1s in.
let toastHideTimer = null;

export function showToast(message, duration = 2400, type = 'info') {
    const toastEl = document.getElementById('app-toast');
    const messageEl = document.getElementById('app-toast-message');
    if (toastEl && messageEl) {
        clearTimeout(toastHideTimer);
        toastHideTimer = null;
        messageEl.textContent = message;

        const alertEl = toastEl.querySelector('.alert');
        if (alertEl) {
            alertEl.classList.remove('alert-info', 'alert-success', 'alert-error');
            alertEl.classList.add(`alert-${type}`);
        }

        // Set accessibility roles based on type
        if (type === 'error' || type === 'alert') {
            toastEl.setAttribute('role', 'alert');
            toastEl.setAttribute('aria-live', 'assertive');
        } else {
            toastEl.setAttribute('role', 'status');
            toastEl.setAttribute('aria-live', 'polite');
        }

        toastEl.style.display = 'grid';

        if (duration > 0) {
            toastHideTimer = setTimeout(() => {
                toastHideTimer = null;
                hideToast();
            }, duration);
        }
    } else {
        logger.warn('App toast element not found.');
    }
}

export function hideToast() {

    clearTimeout(toastHideTimer);
    toastHideTimer = null;

    const toastEl = document.getElementById('app-toast');

    if (toastEl) {

        toastEl.style.display = 'none';

    }

}



export function initResizablePanels(separatorId) {
    const separator = document.getElementById(separatorId);
    if (!separator) {
        logger.warn(`Separator with id #${separatorId} not found.`);
        return;
    }

    const container = separator.parentElement;
    if (!container) {
        logger.warn('Separator has no parent container.');
        return;
    }

    const leftPanel = separator.previousElementSibling;
    if (!leftPanel) {
        logger.warn('Left panel not found for separator.');
        return;
    }

    let isDragging = false;
    let initialX = 0;
    let initialLeftWidth = 0;

    const thicken = () => {
        separator.classList.remove('w-px');
        separator.classList.add('w-2');
    };
    const restore = () => {
        separator.classList.remove('w-2');
        separator.classList.add('w-px');
    };

    const startDrag = (e) => {
        isDragging = true;
        thicken();

        const clientX = e.clientX || e.touches[0].clientX;
        initialX = clientX;

        initialLeftWidth = leftPanel.offsetWidth;

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', stopDrag);

        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', stopDrag);
    };

    const drag = (e) => {
        if (!isDragging) return;

        if (e.type === 'touchmove') {
            e.preventDefault();
        }

        requestAnimationFrame(() => {
            const clientX = e.clientX || e.touches[0].clientX;
            const deltaX = clientX - initialX;
            let newLeftWidth = initialLeftWidth + deltaX;

            const containerRect = container.getBoundingClientRect();
            // Calculate minimum width to ensure right panel has enough space for buttons
            const minRightPanelWidth = 300; // Minimum width needed for buttons in right panel
            const minWidth = containerRect.width * 0.2;
            const maxWidth = containerRect.width - minRightPanelWidth;

            if (newLeftWidth < minWidth) newLeftWidth = minWidth;
            if (newLeftWidth > maxWidth) newLeftWidth = maxWidth;

            container.style.gridTemplateColumns = `${newLeftWidth}px auto minmax(${minRightPanelWidth}px, 1fr)`;
        });
    };

    const stopDrag = () => {
        isDragging = false;
        restore();

        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        document.removeEventListener('mousemove', drag);
        document.removeEventListener('mouseup', stopDrag);

        document.removeEventListener('touchmove', drag);
        document.removeEventListener('touchend', stopDrag);
    };

    separator.addEventListener('mousedown', startDrag);
    separator.addEventListener('touchstart', startDrag);
}

// Export functions needed by app.js
export { updateDoseValue };

export function showGhcControls() {
    const el = document.getElementById('ghc-controls');
    if (!el || el.style.display === 'flex') return; // already visible, skip
    el.style.display = 'flex';

    const panel = document.getElementById('shot-data-panel');
    // 885px = GHC left edge (1748) - panel left (863): panel's right edge meets the
    // GHC column so their borders form one continuous line (was 878 -> 7px gap).
    if (panel) panel.style.width = '885px';

    const status = document.getElementById('machine-status');
    if (status) {
        status.style.right = '100px'; // 172px GHC + 20px gap
        status.style.width = 'auto';  // size to content; right edge stays anchored, box grows leftward
    }

    // Shrink Pressure column so it doesn't overlap GHC
    document.querySelectorAll('.shot-data-cols').forEach(grid => {
        grid.style.gridTemplateColumns = '90px 90px 90px 100px 200px 110px';
    });

    const chartEl = document.getElementById('plotly-chart');
    if (chartEl) {
        chartEl.style.width = '';
        requestAnimationFrame(() => requestAnimationFrame(() => {
            chart.refreshLabelMargin();
        }));
    }
}

export function hideGhcControls() {
    const el = document.getElementById('ghc-controls');
    if (!el || el.style.display === 'none') return; // already hidden, skip
    el.style.display = 'none';

    const panel = document.getElementById('shot-data-panel');
    if (panel) panel.style.width = '';

    const status = document.getElementById('machine-status');
    if (status) {
        status.style.right = '';
        status.style.width = '';
    }

    // Restore Pressure column width
    document.querySelectorAll('.shot-data-cols').forEach(grid => {
        grid.style.gridTemplateColumns = '';
    });

    const chartEl = document.getElementById('plotly-chart');
    if (chartEl) {
        chartEl.style.width = '';
        requestAnimationFrame(() => requestAnimationFrame(() => {
            chart.refreshLabelMargin();
        }));
    }
}

const SIDEBAR_GROUPS = {
    grind:    ['grind-section'],
    dose:     ['dose-section'],
    drink:    ['drink-section', 'drink-out-presets'],
    brew:     ['brew-section', 'temp-presets'],
    steam:    ['steam-section', 'steam-presets', 'steam-flow-presets'],
    flush:    ['flush-section', 'flush-presets'],
    hotwater: ['hotwater-section', 'hotwater-presets'],
};

const ALL_GROUPS = Object.keys(SIDEBAR_GROUPS);

const STATE_DIM_MAP = {
    'espresso':   ALL_GROUPS,
    'steam':      ALL_GROUPS.filter(g => g !== 'steam'),
    'steamRinse': ALL_GROUPS.filter(g => g !== 'steam'),
    'hotWater':   ALL_GROUPS.filter(g => g !== 'hotwater'),
    'flush':      ALL_GROUPS.filter(g => g !== 'flush'),
};

export function updateSidebarOverlay(state) {
    const groupsToDim = STATE_DIM_MAP[state] || [];
    for (const groupName of ALL_GROUPS) {
        const shouldDim = groupsToDim.includes(groupName);
        for (const id of SIDEBAR_GROUPS[groupName]) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.style.opacity = shouldDim ? '0.25' : '';
            el.style.pointerEvents = shouldDim ? 'none' : '';
            el.style.transition = 'opacity 0.3s ease';
        }
    }
}

export function updateGhcStopButton(isActive) {
    const stopBtn = document.getElementById('ghc-stop-btn');
    const actionIds = ['ghc-coffee-btn', 'ghc-water-btn', 'ghc-steam-btn', 'ghc-flush-btn'];

    if (isActive) {
        // Machine running: stop button fully visible (red bg, white text already in HTML)
        stopBtn?.classList.remove('opacity-20');
        // Gray out the 4 action buttons
        for (const id of actionIds) {
            document.getElementById(id)?.classList.add('opacity-20');
        }
    } else {
        // Machine idle: stop button grayed out, action buttons normal
        stopBtn?.classList.add('opacity-20');
        for (const id of actionIds) {
            document.getElementById(id)?.classList.remove('opacity-20');
        }
    }
}
