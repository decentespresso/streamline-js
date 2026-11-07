import { getScaleDevices, connectAddressedScaleWebSocket, closeAddressedScaleWebSocket } from './api.js';
import { getTranslation } from './i18n.js';
import { buildBeanScaleCapture, selectableBeanScales } from './bean-scale.js';

/**
 * Show a small native capture surface. Device identity, role, and bean purpose
 * are explicit user choices; this surface never connects or tares a device.
 */
export async function openBeanScaleCaptureModal({ onCapture } = {}) {
    let devices = [];
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'bean-scale-heading');
    dialog.className = 'rounded-2xl bg-[var(--bgmain-color)] p-6 text-[var(--text-primary)]';
    dialog.innerHTML = `
      <form method="dialog" class="flex min-w-[420px] flex-col gap-5">
        <h2 id="bean-scale-heading" class="text-[26px]">${getTranslation('Capture bean weight')}</h2>
        <label class="flex flex-col gap-2"><span>${getTranslation('Scale')}</span>
          <select name="device" class="rounded-lg p-3 text-black" required></select>
        </label>
        <p class="rounded-lg bg-black/10 p-3">${getTranslation('Dedicated bean scale: auxiliary connection')}</p>
        <output class="rounded-lg bg-black/10 p-4 text-[28px]" aria-live="polite">${getTranslation('Loading scales…')}</output>
        <div class="flex justify-end gap-3"><button value="cancel" formnovalidate class="rounded-lg p-3">${getTranslation('Cancel')}</button><button type="button" data-capture class="rounded-lg p-3" disabled>${getTranslation('Capture')}</button></div>
      </form>`;
    document.body.appendChild(dialog);
    const form = dialog.querySelector('form');
    const deviceSelect = form.elements.device;
    const output = dialog.querySelector('output');
    const capture = dialog.querySelector('[data-capture]');
    let latestSample = null;
    let lastReceivedAt = null;
    let socketDeviceId = null;
    let generation = 0;
    let active = true;
    const currentCapture = () => buildBeanScaleCapture({ deviceId: deviceSelect.value, connectionRole: 'auxiliary', sample: latestSample, receivedAt: lastReceivedAt, capturedAt: new Date().toISOString() });
    const freshnessTimer = setInterval(() => {
        if (!capture.disabled && !currentCapture()) {
            capture.disabled = true;
            output.textContent = getTranslation('No fresh reading available');
        }
    }, 1000);
    const cleanup = () => {
        if (!active) return;
        active = false;
        clearInterval(freshnessTimer);
        window.removeEventListener('pagehide', cleanup);
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
        if (!device) {
            output.textContent = getTranslation('Select a connected scale');
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
                capture.disabled = !currentCapture();
            } else {
                output.textContent = getTranslation('Waiting for a valid positive reading…');
                capture.disabled = true;
            }
        }, null, () => { if (!active || token !== generation) return; latestSample = null; lastReceivedAt = null; output.textContent = getTranslation('Scale disconnected'); capture.disabled = true; });
    };
    deviceSelect.addEventListener('change', refresh);
    window.addEventListener('pagehide', cleanup, { once: true });
    capture.addEventListener('click', () => {
        const value = currentCapture();
        if (!active || !value) { capture.disabled = true; output.textContent = getTranslation('No fresh reading available'); return; }
        onCapture?.(value);
        dialog.close();
    });
    dialog.showModal();
    try {
        devices = selectableBeanScales(await getScaleDevices());
        if (!active) return dialog;
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.id;
            option.textContent = device.name || device.id;
            deviceSelect.append(option);
        });
        refresh();
        if (!devices.length) output.textContent = getTranslation('No connected auxiliary scale found');
    } catch (_) {
        if (!active) return dialog;
        output.textContent = getTranslation('Could not load scales');
    }
    return dialog;
}
