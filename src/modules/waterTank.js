import { connectWaterLevelsWebSocket } from './api.js';
import { logger } from './logger.js';

// mm → mL lookup. Index = tank level in mm (0..69). Out-of-range falls back
// to tank max. Ported from the TCL skin so volumes match across apps.
const MM_TO_ML = [
    0, 16, 43, 70, 97, 124, 151, 179, 206, 233,
    261, 288, 316, 343, 371, 398, 426, 453, 481, 509,
    537, 564, 592, 620, 648, 676, 704, 732, 760, 788,
    816, 844, 872, 900, 929, 957, 985, 1013, 1042, 1070,
    1104, 1138, 1172, 1207, 1242, 1277, 1312, 1347, 1382, 1417,
    1453, 1488, 1523, 1559, 1594, 1630, 1665, 1701, 1736, 1772,
    1808, 1843, 1879, 1915, 1951, 1986, 2022, 2058
];
const TANK_MAX_ML = 2058;

function mmToMl(mm) {
    const idx = Math.max(0, Math.floor(mm));
    if (idx >= MM_TO_ML.length) return TANK_MAX_ML;
    return MM_TO_ML[idx];
}

function getWaterTankUnit() {
    return localStorage.getItem('waterTankUnit') === 'ml' ? 'ml' : 'mm';
}

let lastLevelMm = null;
let lastRefillLevelMm = null;
let tankVolElementRef = null;

function renderLevel() {
    if (!tankVolElementRef || lastLevelMm === null) return;
    if (getWaterTankUnit() === 'ml') {
        tankVolElementRef.textContent = `${mmToMl(lastLevelMm)}ml`;
    } else {
        tankVolElementRef.textContent = `${lastLevelMm}mm`;
    }
}

export function refreshWaterTankUnit() {
    renderLevel();
}

if (typeof window !== 'undefined') {
    window.refreshWaterTankUnit = refreshWaterTankUnit;
}

// setWaterLevelWarning lived here: it POSTed to /de1/waterLevels, a path that has
// not existed since the machine namespace rename, carrying a
// warningThresholdPercentage field the WaterLevels schema has no room for. It had
// no callers, so nothing noticed. Use api.js setWaterLevels(refillLevel) — the
// spec's only supported write to this endpoint.

export function initWaterTankSocket() {
    const tankVolElement = document.getElementById('data-tank-vol');
    if (!tankVolElement) {
        logger.error('Element with id "data-tank-vol" not found.');
        return;
    }
    tankVolElementRef = tankVolElement;

    // Socket ownership (close-before-open on re-init / machine resync) lives in
    // api.js; this module only consumes parsed frames.
    connectWaterLevelsWebSocket((data) => {
        if (data.currentLevel !== undefined) {
            lastLevelMm = Math.round(data.currentLevel);
            renderLevel();
        }
        // REA is the source of truth for the refill (alert) level. Mirror it into
        // the localStorage key the settings page reads, so the displayed alert
        // level reflects REA when available instead of drifting from a stale local copy.
        if (data.refillLevel !== undefined) {
            lastRefillLevelMm = Math.round(data.refillLevel);
            localStorage.setItem('waterRefillLevel', String(lastRefillLevelMm));
        }
    });
}
