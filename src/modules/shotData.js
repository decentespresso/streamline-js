import { logger } from './logger.js';
import { getTempUnit, celsiusToFahrenheit } from './units.js';

// Holds the raw data for the current shot
let currentShot = {};

// Function to get DOM element references fresh each time
function getElements() {
    return {
        pi: {
            time: document.getElementById('shot-data-pi-time'),
            weight: document.getElementById('shot-data-pi-weight'),
            volume: document.getElementById('shot-data-pi-volume'),
            temp: document.getElementById('shot-data-pi-temp'),
            flow: document.getElementById('shot-data-pi-flow'),
            pressure: document.getElementById('shot-data-pi-pressure'),
        },
        ex: {
            time: document.getElementById('shot-data-ex-time'),
            weight: document.getElementById('shot-data-ex-weight'),
            volume: document.getElementById('shot-data-ex-volume'),
            temp: document.getElementById('shot-data-ex-temp'),
            flow: document.getElementById('shot-data-ex-flow'),
            pressure: document.getElementById('shot-data-ex-pressure'),
        },
        total: {
            time: document.getElementById('shot-data-total-time'),
            weight: document.getElementById('shot-data-total-weight'),
            volume: document.getElementById('shot-data-total-volume'),
        }
    };
}

// --- UTILITY FUNCTIONS ---
function updateText(element, value) {
    if (element) element.textContent = value;
}

function formatRange(values, precision) {
    if (!values || values.length === 0) return '-';
    const min = Math.min(...values).toFixed(precision);
    const max = Math.max(...values).toFixed(precision);
    if (min === max) return min;
    return `${min}➔${max}`;
}

function formatStartPeakEnd(values, precision) {
    if (!values || values.length === 0) return '-';
    const start = values[0].toFixed(precision);
    const end = values[values.length - 1].toFixed(precision);
    const peak = Math.max(...values).toFixed(precision);
    if (start === end) return start;
    if (peak === start || peak === end) return `${start}➔${end}`;
    return `${start}➔${peak}➔${end}`;
}

function getPhaseData(dataArray, startIndex, endIndex) {
    return dataArray.slice(startIndex, endIndex + 1);
}

// Raw Celsius sample arrays are always what's stored (see push sites below);
// convert to the display unit only right before formatting.
function toDisplayTemps(celsiusValues) {
    if (getTempUnit() !== 'F') return celsiusValues;
    return celsiusValues.map(celsiusToFahrenheit);
}

function updateTempHeader() {
    const header = document.getElementById('shot-data-temp-header');
    if (header) header.textContent = getTempUnit() === 'F' ? '°F' : '°C';
}

// --- CORE LOGIC ---

export function clearShotData() {
    logger.info('Clearing shot data table.');
    currentShot = {
        timestamps: [],
        pressures: [],
        flows: [],
        weights: [],
        temperatures: [],
        substates: [],
        volumes: [],
        preinfusionEndIndex: -1,
        finalWeight: null,
    };

    const elements = getElements();
    for (const phase of Object.values(elements)) {
        for (const element of Object.values(phase)) {
            updateText(element, '-');
        }
    }
    updateTempHeader();
}

// Re-render the shot-data table's temperature column in the newly chosen
// unit, without waiting for the next sample.
document.addEventListener('streamline:unitchange', () => {
    if (currentShot.timestamps && currentShot.timestamps.length > 0) {
        calculateAndRender(currentShot);
    } else {
        updateTempHeader();
    }
});

function calculateAndRender(shotData) {
    try {
        if (!shotData || !shotData.timestamps || shotData.timestamps.length === 0) {
            logger.warn('calculateAndRender called with invalid or empty shotData. Aborting render.');
            return;
        }

        updateTempHeader();

        // Get fresh element references each time to avoid stale references
        const elements = getElements();

        // --- Calculations ---
        const lastIndex = shotData.timestamps.length - 1;
        const piEndIndex = shotData.preinfusionEndIndex !== -1 ? shotData.preinfusionEndIndex : lastIndex;
        const exStartIndex = shotData.preinfusionEndIndex !== -1 ? shotData.preinfusionEndIndex + 1 : -1;

        const totalTime = (shotData.timestamps[lastIndex] - shotData.timestamps[0]) / 1000;
        const piTime = (shotData.timestamps[piEndIndex] - shotData.timestamps[0]) / 1000;
        const exTime = exStartIndex !== -1 ? (shotData.timestamps[lastIndex] - shotData.timestamps[exStartIndex]) / 1000 : 0;

        const piPressures = getPhaseData(shotData.pressures, 0, piEndIndex);
        const piFlows = getPhaseData(shotData.flows, 0, piEndIndex);
        const piTemps = getPhaseData(shotData.temperatures, 0, piEndIndex);

        const exPressures = exStartIndex !== -1 ? getPhaseData(shotData.pressures, exStartIndex, lastIndex) : [];
        const exFlows = exStartIndex !== -1 ? getPhaseData(shotData.flows, exStartIndex, lastIndex) : [];
        const exTemps = exStartIndex !== -1 ? getPhaseData(shotData.temperatures, exStartIndex, lastIndex) : [];

        const totalWeight = shotData.weights[lastIndex];
        const totalVolume = shotData.volumes[lastIndex] || 0;
        const piWeight = shotData.weights[piEndIndex];
        const piVolume = shotData.volumes[piEndIndex] || 0;
        // Use settled finalWeight so pi + ex == total. Drip-down after pump stop
        // belongs to extraction (water already in puck at cutoff), not preinfusion.
        const displayTotal = shotData.finalWeight ?? totalWeight;
        const exWeight = (displayTotal !== null && displayTotal !== undefined && piWeight !== null) ? displayTotal - piWeight : null;
        const exVolume = totalVolume - piVolume;

        // --- Rendering ---
        updateText(elements.pi.time, `${Math.round(piTime)}`);
        updateText(elements.pi.weight, piWeight !== null ? `${piWeight.toFixed(1)}g` : '0.0');
        updateText(elements.pi.volume, `${piVolume.toFixed(0)}`);
        updateText(elements.pi.temp, `${formatRange(toDisplayTemps(piTemps), 0)}`);
        updateText(elements.pi.flow, `${formatStartPeakEnd(piFlows, 1)} `);
        updateText(elements.pi.pressure, `${formatStartPeakEnd(piPressures, 1)}`);

        if (exTime > 0) {
            updateText(elements.ex.time, `${Math.round(exTime)}`);
            updateText(elements.ex.weight, exWeight !== null ? `${exWeight.toFixed(1)}g` : '0.0');
            updateText(elements.ex.volume, `${exVolume.toFixed(0)}`);
            updateText(elements.ex.temp, `${formatRange(toDisplayTemps(exTemps), 0)}`);
            updateText(elements.ex.flow, `${formatStartPeakEnd(exFlows, 1)} `);
            updateText(elements.ex.pressure, `${formatStartPeakEnd(exPressures, 1)}`);
        }

        updateText(elements.total.time, `${Math.round(totalTime)}`);
        updateText(elements.total.weight, displayTotal !== null && displayTotal !== undefined ? `${displayTotal.toFixed(1)}g` : '0.0');
        updateText(elements.total.volume, `${totalVolume.toFixed(0)}`);
    } catch (error) {
        logger.error('Error in calculateAndRender:', error);
    }
}

export function renderPastShot(shotRecord) {
    if (!shotRecord || !shotRecord.measurements) {
        logger.error('Invalid shot record provided to renderPastShot.');
        return;
    }
    clearShotData();
    logger.info('Rendering past shot:', shotRecord.id);

    const pastShotData = {
        timestamps: [],
        pressures: [],
        flows: [],
        weights: [],
        temperatures: [],
        substates: [],
        volumes: [],
        preinfusionEndIndex: -1,
        finalWeight: shotRecord.annotations?.actualYield ?? null,
    };

    // Fallback: scan unfiltered measurements for the last non-null scale weight —
    // captures drip-down after pouringDone that the substate filter below would skip.
    if (pastShotData.finalWeight === null) {
        for (let i = shotRecord.measurements.length - 1; i >= 0; i--) {
            const w = shotRecord.measurements[i].scale?.weight;
            if (w !== null && w !== undefined) {
                pastShotData.finalWeight = w;
                break;
            }
        }
    }

    let accumulatedVolume = 0;
    for (let i = 0; i < shotRecord.measurements.length; i++) {
        const m = shotRecord.measurements[i];
        if (!m.machine) continue; // Only require machine data to proceed

        const espressoStates = ['preinfusion', 'pouring'];
        if (!espressoStates.includes(m.machine.state.substate)) continue;

        const timestamp = new Date(m.machine.timestamp).getTime();
        pastShotData.timestamps.push(timestamp);
        pastShotData.pressures.push(m.machine.pressure);
        pastShotData.flows.push(m.machine.flow);
        pastShotData.weights.push(m.scale?.weight ?? null); // Safely access weight, default to null
        // Use groupTemperature to match the chart line; mixTemperature is the
        // pre-group mid-mix sensor and reads 2–5°C off the brew temp at puck.
        pastShotData.temperatures.push(m.machine.groupTemperature);
        pastShotData.substates.push(m.machine.state.substate);

        const idx = pastShotData.timestamps.length - 1;
        if (idx > 0) {
            const timeDelta = (timestamp - pastShotData.timestamps[idx - 1]) / 1000;
            const lastFlow = pastShotData.flows[idx - 1];
            accumulatedVolume += lastFlow * timeDelta;
        }
        pastShotData.volumes.push(accumulatedVolume);

        if (m.machine.state.substate === 'pouring' && pastShotData.preinfusionEndIndex === -1) {
            if (idx >= 1) pastShotData.preinfusionEndIndex = idx - 1;
        }
    }

    if (pastShotData.timestamps.length === 0 && shotRecord.measurements.length > 0) {
        logger.warn(`Shot record ${shotRecord.id} contains measurements, but none had valid machine data to process.`);
    }

    calculateAndRender(pastShotData);
}

export function updateShotData(de1Data, scaleWeight) {
    if (!currentShot.timestamps) return; // Don't run if not initialized

    // Only process data during espresso-related states (preinfusion and pouring)
    const espressoStates = ['preinfusion', 'pouring'];
    if (!espressoStates.includes(de1Data.state.substate)) {
        return;
    }

    const now = new Date(de1Data.timestamp).getTime();
    currentShot.timestamps.push(now);
    currentShot.pressures.push(de1Data.pressure);
    currentShot.flows.push(de1Data.flow);
    currentShot.weights.push(scaleWeight ?? null); // Use null if scaleWeight is undefined
    currentShot.temperatures.push(de1Data.groupTemperature);
    currentShot.substates.push(de1Data.state.substate);

    if (currentShot.timestamps.length > 1) {
        const timeDelta = (now - currentShot.timestamps[currentShot.timestamps.length - 2]) / 1000;
        const lastFlow = currentShot.flows[currentShot.flows.length - 2];
        const volumeDelta = lastFlow * timeDelta;
        const previousVolume = currentShot.volumes[currentShot.volumes.length - 1] || 0;
        currentShot.volumes.push(previousVolume + volumeDelta);
    } else {
        currentShot.volumes.push(0);
    }

    if (de1Data.state.substate === 'pouring' && currentShot.preinfusionEndIndex === -1) {
        // Point at the previous sample (last preinfusion) so PI metrics don't
        // include the first pouring tick. Skip if pouring is the very first sample.
        if (currentShot.timestamps.length >= 2) {
            currentShot.preinfusionEndIndex = currentShot.timestamps.length - 2;
        }
    }

    calculateAndRender(currentShot);
}

export function getCurrentShot() {
    return currentShot;
}

// Updated from every scale frame regardless of machine substate — captures the
// settled weight after pouringDone that the substate filter in updateShotData drops.
export function setFinalWeight(weight) {
    if (!currentShot.timestamps) return;
    if (weight === null || weight === undefined) return;
    currentShot.finalWeight = weight;
    // Only re-render once the shot has at least one sample, otherwise calculateAndRender bails.
    if (currentShot.timestamps.length > 0) calculateAndRender(currentShot);
}

export function getTotalTime() {
    if (!currentShot.timestamps || currentShot.timestamps.length < 2) return 0;
    return (currentShot.timestamps[currentShot.timestamps.length - 1] - currentShot.timestamps[0]) / 1000;
}
