import { getScaleDevices, connectAddressedScaleWebSocket, closeAddressedScaleWebSocket } from './api.js';
import { getTranslation } from './i18n.js';
import { buildBeanScaleCapture, selectableBeanScales } from './bean-scale.js';

function isConnected(device) {
    return device?.connected === true || device?.state === 'connected' || device?.connectionState === 'connected';
}

/**
 * Show a small native capture surface. Device identity, role, and bean purpose
 * are explicit user choices; this surface never connects or tares a device.
 */
export async function openBeanScaleCaptureModal({ onCapture } = {}) {
    const devices = selectableBeanScales(await getScaleDevices());
    const dialog = document.createElement('dialog');
    dialog.className = 'rounded-2xl bg-[var(--background-color)] p-6 text-[var(--text-primary)]';
    dialog.innerHTML = `
      <form method="dialog" class="flex min-w-[420px] flex-col gap-5">
        <h2 class="text-[26px]">${getTranslation('Capture bean weight')}</h2>
        <label class="flex flex-col gap-2"><span>${getTranslation('Scale')}</span>
          <select name="device" class="rounded-lg p-3 text-black" required></select>
        </label>
        <p class="rounded-lg bg-black/10 p-3">${getTranslation('Dedicated bean scale: auxiliary connection')}</p>
        <output class="rounded-lg bg-black/10 p-4 text-[28px]" aria-live="polite">${getTranslation('Select a connected scale')}</output>
        <div class="flex justify-end gap-3"><button value="cancel" class="rounded-lg p-3">${getTranslation('Cancel')}</button><button type="button" data-capture class="rounded-lg p-3" disabled>${getTranslation('Capture')}</button></div>
      </form>`;
    document.body.appendChild(dialog);
    const form = dialog.querySelector('form');
    const deviceSelect = form.elements.device;
    const role = 'auxiliary';
    const output = dialog.querySelector('output');
    const capture = dialog.querySelector('[data-capture]');
    let latestSample = null;
    let lastReceivedAt = null;
    let socketDeviceId = null;
    let generation = 0;
    let active = true;
    devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = device.name || device.id;
        option.disabled = !isConnected(device);
        deviceSelect.append(option);
    });
    const cleanup = () => {
        active = false;
        generation += 1;
        closeAddressedScaleWebSocket();
        dialog.remove();
    };
    dialog.addEventListener('close', cleanup, { once: true });
    const refresh = () => {
        latestSample = null;
        lastReceivedAt = null;
        capture.disabled = true;
        const device = devices.find(item => item.id === deviceSelect.value);
        if (!device || !isConnected(device) || role !== 'auxiliary') {
            output.textContent = getTranslation('Select a connected scale and confirm its role');
            if (socketDeviceId) closeAddressedScaleWebSocket();
            socketDeviceId = null;
            return;
        }
        if (socketDeviceId === device.id) return;
        const token = ++generation;
        closeAddressedScaleWebSocket();
        socketDeviceId = device.id;
        output.textContent = getTranslation('Waiting for a scale reading…');
        connectAddressedScaleWebSocket(device.id, sample => {
            if (!active || token !== generation) return;
            latestSample = sample;
            lastReceivedAt = new Date().toISOString();
            if (typeof sample?.weight === 'number' && Number.isFinite(sample.weight) && sample.weight > 0) {
                output.textContent = `${Number(sample.weight).toFixed(1)} g`;
                capture.disabled = (Date.now() - Date.parse(lastReceivedAt)) > 10000;
            } else {
                output.textContent = getTranslation('Waiting for a valid positive reading…');
                capture.disabled = true;
            }
        }, null, () => { if (!active || token !== generation) return; latestSample = null; lastReceivedAt = null; output.textContent = getTranslation('Scale disconnected'); capture.disabled = true; });
    };
    deviceSelect.addEventListener('change', refresh);
    window.addEventListener('pagehide', cleanup, { once: true });
    capture.addEventListener('click', () => {
        const value = buildBeanScaleCapture({ deviceId: deviceSelect.value, connectionRole: role, sample: latestSample, receivedAt: lastReceivedAt });
        if (!value) { output.textContent = getTranslation('No valid reading available'); return; }
        onCapture?.(value);
        dialog.close();
    });
    if (!devices.length) output.textContent = getTranslation('No connected auxiliary scale found');
    dialog.showModal();
    return dialog;
}
