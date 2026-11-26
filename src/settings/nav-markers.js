import { isSteamOff } from '../modules/steam-mode.js';
import { isTouchSoundEnabled } from '../modules/touch-sound.js';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

const capitalize = (text) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

export function subcategorySummary(category, { de1, workflow, toggles = {} } = {}, { formatTemp, translate = (text) => text, tempUnit = 'C' } = {}) {
    const temperature = (value) => (finite(value) ? formatTemp(value, 0) : null);
    const toggle = toggles[category];
    if (typeof toggle === 'boolean') return toggle ? capitalize(translate('on')) : translate('Off');
    switch (category) {
        case 'steam': {
            const target = workflow?.steamSettings?.targetTemperature;
            if (target === undefined) return null;
            return isSteamOff(target) ? translate('Off') : temperature(target);
        }
        case 'hotwater':
            return temperature(workflow?.hotWaterData?.targetTemperature);
        case 'flush':
            return temperature(de1?.flushTemp);
        case 'watertank':
            return temperature(de1?.tankTemp);
        case 'tempunit':
            return tempUnit === 'F' ? '°F' : '°c';
        default:
            return null;
    }
}

export function localToggles(wakeLockEnabled) {
    let screensaverEnabled = true;
    try { screensaverEnabled = localStorage.getItem('screensaverEnabled') !== 'false'; } catch { screensaverEnabled = true; }
    return {
        sounds: isTouchSoundEnabled(),
        wakelock: wakeLockEnabled,
        screensaver: screensaverEnabled
    };
}

export const SUBNAV_MARKERS_HTML = '<span data-nav-summary class="pl-[12px] text-[20px] opacity-60 whitespace-nowrap tabular-nums"></span><span data-nav-staged hidden class="ml-[10px] w-[10px] h-[10px] shrink-0 rounded-full bg-current"></span>';

export function applyNavMarkers(panel, { summaryFor = () => null, isStaged = () => false } = {}) {
    panel?.querySelectorAll('.settings-subnav-btn[data-category]').forEach(button => {
        const category = button.dataset.category;
        const summary = button.querySelector('[data-nav-summary]');
        if (summary) summary.textContent = summaryFor(category) ?? '';
        const staged = button.querySelector('[data-nav-staged]');
        if (staged) staged.hidden = !isStaged(category);
    });
}
