// A device plugin's own page (settings, diagnostics) in a dialog over the settings page,
// so the WebView never navigates away from the skin. The host must allow framing the
// page (CSP frame-ancestors); a refusal is invisible to the skin, so the fallback link
// to open the page itself stays on screen. Key events go to the frame once it is
// touched and a tablet has no Escape key: the dialog closes on its own button and on a
// backdrop tap too.

import { isPageAvailable } from './api.js';
import { getTranslation } from './i18n.js';
import { logger } from './logger.js';
import { loadStyle } from './vendor-loader.js';

const LOAD_TIMEOUT_MS = 10000;
let closeCurrent = null;

const styleReady = loadStyle('src/css/surface-dialog.css').catch(() => {});

export function isSurfaceDialogOpen() {
    return closeCurrent !== null;
}

export function closeSurfaceDialog() {
    closeCurrent?.();
}

const themed = href => {
    const url = new URL(href);
    url.searchParams.set('embed', '1');
    url.searchParams.set('theme', document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    return url.href;
};

export async function openSurfaceDialog(href, title, findOpener = null) {
    closeSurfaceDialog();
    const opener = document.activeElement;
    const probe = new AbortController();
    let timer = null;

    const dialog = document.createElement('dialog');
    dialog.className = 'surface-dialog';
    dialog.dataset.keyboardFit = '1';
    dialog.setAttribute('aria-labelledby', 'surface-dialog-title');
    dialog.innerHTML = `
        <div class="surface-dialog-header">
            <h2 id="surface-dialog-title" class="surface-dialog-title"></h2>
            <button type="button" class="surface-dialog-close"><span aria-hidden="true">×</span><span data-label></span></button>
        </div>
        <div class="surface-dialog-body">
            <iframe class="surface-dialog-frame" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
            <div class="surface-dialog-error" role="alert" hidden>
                <p data-message></p>
                <a class="surface-dialog-open" data-open></a>
            </div>
        </div>
        <p class="surface-dialog-hint"><span data-hint></span> <a data-open></a></p>`;
    const q = selector => dialog.querySelector(selector);
    const frame = q('.surface-dialog-frame');
    const closeButton = q('.surface-dialog-close');
    q('.surface-dialog-title').textContent = title;
    q('[data-label]').textContent = getTranslation('Close');
    q('[data-message]').textContent = getTranslation('Could not load this page.');
    q('[data-hint]').textContent = getTranslation('Page not showing?');
    for (const link of dialog.querySelectorAll('[data-open]')) {
        link.href = href;
        link.textContent = getTranslation('Open anyway');
    }
    frame.title = title;

    const showError = () => {
        if (closeCurrent !== close) return;
        clearTimeout(timer);
        frame.remove();
        q('.surface-dialog-error').hidden = false;
        q('.surface-dialog-hint').hidden = true;
    };

    function close() {
        if (closeCurrent !== close) return;
        closeCurrent = null;
        clearTimeout(timer);
        probe.abort();
        dialog.removeEventListener('close', close);
        if (dialog.open) dialog.close();
        dialog.remove();
        (opener?.isConnected ? opener : findOpener?.())?.focus?.();
    }
    closeCurrent = close;

    dialog.addEventListener('close', close);
    closeButton.addEventListener('click', close);
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    frame.addEventListener('load', () => clearTimeout(timer), { once: true });

    await styleReady;
    if (closeCurrent !== close) return dialog;
    frame.src = themed(href);
    document.body.appendChild(dialog);
    try {
        dialog.showModal();
    } catch (error) {
        logger.warn('Plugin page dialog could not open:', error);
        close();
        return dialog;
    }
    closeButton.focus();
    timer = setTimeout(showError, LOAD_TIMEOUT_MS);
    isPageAvailable(href, probe.signal).then(ok => { if (ok === false) showError(); });
    return dialog;
}
