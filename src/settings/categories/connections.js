// Settings > Connections. Machine and Scale still render from the legacy module; the
// Grinder page lives here and is laid out like the Scale page (settings.js
// renderBluetoothScaleSettings / renderSingleDeviceList): same header, device cards,
// preferred switch and setting rows.

import {
    getGrinderDevices, getGrinderInfo, getReaSettings, setReaSettings, scanForDevices,
    reconnectDevice, disconnectDevice, forgetDevice, API_BASE_URL,
} from '../../modules/api.js';
import { getTranslation, translatePage } from '../../modules/i18n.js';
import { logger } from '../../modules/logger.js';
import { canSendGrind } from '../../modules/grinder-sync.js';
import { getGrinderSync, setGrinderSync } from '../../modules/grinder-runtime.js';
import * as ui from '../../modules/ui.js';

// Decaid's own list of device plugins; a link to a file that is not on GitHub yet would 404.
const DOCS_URL = 'https://github.com/decentespresso/decaid/blob/main/doc/Plugins.md#external-device-plugins';
const POLL_MS = 3000;

const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OUTLINE_BTN = 'border-[var(--mimoja-blue-v2)] text-[var(--mimoja-blue-v2)] h-[62px] rounded-[67.5px] border text-[24px] transition-colors duration-200 hover:bg-[var(--button-primary-bg)] hover:text-white';
const HEADING = "font-['Inter:Bold',sans-serif] font-bold not-italic text-[var(--mimoja-blue-v2)] text-[30px] leading-[1.2]";
const BODY = "font-['Inter:Regular',sans-serif] font-normal leading-[1.4] not-italic text-[var(--text-primary)] text-[24px]";
const HR = '<hr class="border-t border-[var(--border-primary)] w-full" />';

// The Scale page's switch, at its two sizes.
function switchControl(attr, checked, { big = false, enabled = true } = {}) {
    const [w, h, knob, left, shift] = big ? [100, 50, 40, 5, 46] : [72, 36, 28, 4, 36];
    return `<label class="relative flex items-center ${enabled ? 'cursor-pointer' : 'opacity-40'} flex-shrink-0 w-[${w}px] h-[${h}px]">
        <input type="checkbox" class="sr-only peer" ${attr} ${checked ? 'checked' : ''} ${enabled ? '' : 'disabled'}>
        <div class="absolute inset-0 rounded-full border-2 transition-colors duration-200 bg-[var(--toggle-off-bg)] border-[var(--toggle-off-border)] peer-checked:bg-[var(--button-primary-bg)] peer-checked:border-[var(--button-primary-bg)]"></div>
        <div class="absolute top-1/2 left-[${left}px] -translate-y-1/2 peer-checked:translate-x-[${shift}px] size-[${knob}px] rounded-full transition-[transform,background-color] duration-200 bg-[var(--toggle-off-knob)] peer-checked:bg-white"></div>
    </label>`;
}

function settingRow(name, title, text, on, enabled) {
    return `<div class="flex items-center justify-between w-full">
        <div class="flex items-baseline gap-[14px]">
            <p class="${HEADING} shrink-0" data-i18n-key="${title}">${title}</p>
            <p class="${BODY}" data-i18n-key="${text}">${text}</p>
        </div>
        ${switchControl(`data-sync="${name}"`, on, { big: true, enabled })}
    </div>`;
}

function deviceCard(device, preferred, info) {
    const unavailable = device.available === false;
    const connected = !unavailable && device.state === 'connected';
    const dot = connected ? 'bg-green-500' : unavailable ? 'bg-amber-500/40' : 'bg-[var(--profile-button-outline-color)]';
    const badge = connected
        ? '<span class="text-[20px] font-bold px-[16px] py-[6px] rounded-full bg-green-500/15 text-green-600" data-i18n-key="Connected">Connected</span>'
        : unavailable
            ? '<span class="text-[20px] font-bold px-[16px] py-[6px] rounded-full bg-amber-500/15 text-amber-600" data-i18n-key="Unavailable">Unavailable</span>'
            : '<span class="text-[20px] font-bold px-[16px] py-[6px] rounded-full bg-[var(--muted-pill-bg)] text-[var(--text-primary)] opacity-50" data-i18n-key="Available">Available</span>';
    const id = esc(device.id);
    const actions = unavailable
        ? `<button type="button" data-rescan class="border-2 border-[var(--mimoja-blue-v2)] text-[var(--mimoja-blue-v2)] hover:bg-[var(--button-primary-bg)] hover:text-white h-[62px] px-[28px] rounded-[67.5px] text-[22px] font-bold transition-colors duration-200" data-i18n-key="Reconnect">Reconnect</button>
           <button type="button" data-forget="${id}" data-name="${esc(device.name)}" class="border-2 border-red-500 text-red-500 hover:bg-red-500 hover:text-white h-[62px] px-[28px] rounded-[67.5px] text-[22px] font-bold transition-colors duration-200" data-i18n-key="Forget">Forget</button>`
        : `<button type="button" data-${connected ? 'disconnect' : 'connect'}="${id}" class="${connected ? 'border-2 border-[var(--mimoja-blue-v2)] text-[var(--mimoja-blue-v2)] hover:bg-[var(--button-primary-bg)] hover:text-white' : 'bg-[var(--button-primary-bg)] text-white hover:bg-[#2c4a7a]'} h-[62px] px-[32px] rounded-[67.5px] text-[22px] font-bold transition-colors duration-200" data-i18n-key="${connected ? 'Disconnect' : 'Connect'}">${connected ? 'Disconnect' : 'Connect'}</button>`;
    return `<div class="flex items-center justify-between w-full bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] rounded-[18px] px-[28px] py-[24px] mb-[16px] ${unavailable ? 'opacity-60' : ''}">
        <div class="flex items-center gap-[16px] flex-1 min-w-0">
            <div class="relative flex-shrink-0">
                <div class="w-[14px] h-[14px] rounded-full ${dot}"></div>
                ${connected ? '<div class="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-40"></div>' : ''}
            </div>
            <div class="flex flex-col gap-[4px] min-w-0">
                <span class="text-[26px] font-bold text-[var(--text-primary)] truncate leading-tight">${esc(device.name || device.id)}</span>
                <span class="text-[18px] text-[var(--text-primary)] opacity-40 font-mono truncate">${id}</span>
            </div>
        </div>
        <div class="flex items-center gap-[20px] flex-shrink-0 ml-[24px]">
            ${connected && info?.deviceId === device.id ? surfaceLinks(info) : ''}
            <div class="flex flex-col items-center gap-[4px]">
                <span class="text-[16px] text-[var(--text-primary)] opacity-50" data-i18n-key="Preferred">Preferred</span>
                ${switchControl(`data-prefer="${id}"`, preferred === device.id)}
            </div>
            ${badge}
            ${actions}
        </div>
    </div>`;
}

// The plugin's own pages (settings, diagnostics), built by Decaid for this device.
function surfaceLinks(info) {
    const origin = new URL(API_BASE_URL, window.location.href).origin;
    return (info?.surfaces ?? []).map(surface => {
        let href;
        try { href = new URL(surface.href, origin).href; } catch { return ''; }
        return `<a href="${esc(href)}" class="border-2 border-[var(--mimoja-blue-v2)] text-[var(--mimoja-blue-v2)] hover:bg-[var(--button-primary-bg)] hover:text-white h-[62px] px-[28px] rounded-[67.5px] text-[22px] font-bold transition-colors duration-200 inline-flex items-center">${esc(surface.label || surface.role)}</a>`;
    }).join('');
}

function view({ devices, info, preferred }) {
    const connected = devices.some(d => d.state === 'connected' && d.available !== false);
    const canSend = connected && canSendGrind(info);
    const list = devices.length
        ? devices.map(d => deviceCard(d, preferred, info)).join('')
        : `<div class="flex items-center gap-[16px] w-full bg-[var(--box-color)] border border-[var(--profile-button-outline-color)] rounded-[18px] px-[28px] py-[24px] opacity-60">
            <div class="w-[14px] h-[14px] rounded-full bg-[var(--profile-button-outline-color)] flex-shrink-0"></div>
            <p class="text-[24px] text-[var(--text-primary)]" data-i18n-key="No grinder found. Install its Decaid plugin, then tap Search.">No grinder found. Install its Decaid plugin, then tap Search.</p>
        </div>`;
    return `<div class="flex flex-col gap-[32px] items-start relative w-full max-w-full overflow-x-hidden">
        <div class="flex items-center w-full">
            <div class="w-[139px] shrink-0"></div>
            <p class="flex-1 text-center font-['Inter:Semi_Bold',sans-serif] font-semibold not-italic text-[var(--text-primary)] text-[36px] leading-[1.2]" data-i18n-key="Grinder">Grinder</p>
            <button type="button" data-search class="w-[139px] shrink-0 ${OUTLINE_BTN}" data-i18n-key="Search">Search</button>
        </div>
        ${HR}
        <div class="flex flex-col gap-[16px] items-start relative w-full">
            <div class="flex flex-col font-['Inter:Bold',sans-serif] font-bold justify-center leading-[0] not-italic relative text-[var(--mimoja-blue-v2)] text-[30px]">
                <p class="leading-[1.2]" data-i18n-key="Connected Device">Connected Device</p>
            </div>
            <div class="w-full">${list}</div>
        </div>
        ${HR}
        ${settingRow('follow', 'Follow Grinder', 'Grind tile follows the grinder.', getGrinderSync('follow'), true)}
        ${settingRow('send', 'Send Grind', canSend ? 'Grind tile sets the grinder.' : 'Needs a settable grinder.', getGrinderSync('send'), canSend || getGrinderSync('send'))}
        <div class="w-full flex justify-center pt-[8px]">
            <a href="${DOCS_URL}" class="text-[#959595] hover:text-[var(--mimoja-blue-v2)] text-[20px] underline underline-offset-4 transition-colors duration-200" data-i18n-key="Learn more about Grinder Plugins">Learn more about Grinder Plugins</a>
        </div>
    </div>`;
}

async function mountGrinder(container) {
    let active = true;
    let timer = 0;
    let pressed = false;
    const press = () => { pressed = true; };
    const release = () => { pressed = false; };

    const load = async () => {
        const [devices, settings] = await Promise.all([
            getGrinderDevices().catch(() => []),
            getReaSettings().catch(() => null),
        ]);
        const info = devices.some(d => d.state === 'connected') ? await getGrinderInfo() : null;
        return { devices, info, preferred: settings?.preferredGrinderDeviceId ?? null };
    };

    const render = async () => {
        const data = await load();
        if (!active) return;
        if (pressed) return; // mid-tap: never replace what the finger is on
        container.innerHTML = view(data);
        translatePage();
    };

    const toast = (text, ms, kind) => ui.showToast(getTranslation(text), ms, kind);

    const onChange = async event => {
        const input = event.target;
        if (input.dataset.sync) {
            setGrinderSync(input.dataset.sync, input.checked);
            return render();
        }
        if (input.dataset.prefer !== undefined) {
            try { await setReaSettings({ preferredGrinderDeviceId: input.checked ? input.dataset.prefer : null }); }
            catch (error) { logger.warn('Could not save the preferred grinder:', error); toast('Could not save', 3000, 'error'); }
            return render();
        }
    };

    const onClick = async event => {
        const button = event.target.closest('button');
        if (!button) return;
        const { dataset } = button;
        if (dataset.search !== undefined || dataset.rescan !== undefined) {
            // REST, not the device socket: this page never opens it. Bounded by scanForDevices.
            toast('Searching for grinders...', 3000, 'info');
            scanForDevices().catch(error => logger.warn('Grinder search failed:', error)).finally(() => { if (active) render(); });
        } else if (dataset.connect) {
            await reconnectDevice(dataset.connect); // PUT /devices/connect; logs its own failure
            const ok = (await getGrinderDevices().catch(() => [])).some(d => d.id === dataset.connect && d.state === 'connected');
            toast(ok ? 'Connected' : 'Could not connect', 3000, ok ? 'success' : 'error');
            render();
        } else if (dataset.disconnect) {
            try { await disconnectDevice(dataset.disconnect); } catch (error) { logger.warn('Grinder disconnect failed:', error); toast('Could not disconnect', 3000, 'error'); }
            render();
        } else if (dataset.forget) {
            if (!window.confirm(`Forget "${dataset.name}"?\nIt will be removed from the list until it connects again.`)) return;
            try { await forgetDevice(dataset.forget); } catch (error) { logger.warn('Grinder forget failed:', error); toast('Could not forget', 3000, 'error'); }
            render();
        }
    };

    container.addEventListener('click', onClick);
    container.addEventListener('change', onChange);
    container.addEventListener('pointerdown', press);
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    await render();
    timer = setInterval(render, POLL_MS);
    return () => {
        active = false;
        clearInterval(timer);
        container.removeEventListener('click', onClick);
        container.removeEventListener('change', onChange);
        container.removeEventListener('pointerdown', press);
        document.removeEventListener('pointerup', release);
        document.removeEventListener('pointercancel', release);
    };
}

export async function mountSettingsCategory(context) {
    if (context.category === 'ble_grinder') return mountGrinder(context.container);
    const legacy = await import('./legacy-category.js');
    return legacy.mountSettingsCategory(context);
}
