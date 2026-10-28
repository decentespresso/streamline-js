// plugin-overlay.js -- a plugin's `ui` page in a dialog over whatever page the
// user is on: the dashboard's own `open` actions, and the Open button in
// Settings > Extensions (see docs/plugin-surfaces.md).
//
// The page must send `{type:'streamline:ready'}` once it has loaded (a CSP
// `frame-ancestors` block gives no event the skin could catch) and
// `{type:'streamline:close'}` to close. No ready message in time: drop the
// dialog and go to the page, as `page` does. The skin draws its own close
// button and closes on a backdrop tap, because key events go to the frame once
// it is touched and a tablet has no Escape key.
//
// One overlay at a time, across every caller: the guard below is module state,
// and the settings page and the dashboard are never both mounted anyway.
//
// What differs per caller arrives as hooks rather than being wired in here --
// the dashboard re-reads its surfaces and the workflow when the overlay closes
// and offers the skin's numpad to the page; the settings page does neither.

import { API_BASE_URL } from './api.js';
import { logger } from './logger.js';
import { parseNumpadInput, fitOverlaySize } from './plugin-surfaces.js';
import { pluginUiUrl } from '../settings/plugin-view.js';

// A page's context rides on its URL as plain query parameters (shotId, slot,
// profileId); only scalar values, so a page reads them with URLSearchParams.
export function withContext(url, context) {
    if (!url || !context || typeof context !== 'object') return url;
    const out = new URL(url, window.location.href);
    for (const [key, value] of Object.entries(context)) {
        if (value == null || typeof value === 'object') continue;
        out.searchParams.set(key, String(value));
    }
    return out.toString();
}

const OVERLAY_READY_MS = 3000;
const OVERLAY_FIT_GRACE_MS = 300; // a `fit` page that is ready but sends no size gets the default window after this
const NUMPAD_COOLDOWN_MS = 3000; // after a cancel, long enough to tap the overlay's close button
let overlayOpen = false;

export function openPluginOverlay(plugin, action, pageUrl, {
    context = null,
    onClose = null,
    afterClose = null,
    openNumpad = null,
} = {}) {
    if (overlayOpen) return;
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const src = withContext(pluginUiUrl(plugin, API_BASE_URL, null, { view: action.view, embedTheme: theme }), context);
    if (!src) return;
    overlayOpen = true;

    const dialog = document.createElement('dialog');
    dialog.dataset.agentId = `plugin-overlay:${plugin.id}`;
    const full = action.size === 'full';
    dialog.style.cssText = `width:${full ? '100vw' : 'min(1100px,94vw)'};height:${full ? '100vh' : 'min(760px,90vh)'};max-width:none;max-height:none;padding:0;border:0;border-radius:${full ? 0 : 16}px;overflow:hidden;background:var(--bg,#fff);`;
    const frame = document.createElement('iframe');
    // Scripts and forms run in the plugin's own origin; the frame cannot navigate the skin.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    frame.src = src;
    frame.title = plugin.name || plugin.id;
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;';
    dialog.appendChild(frame);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.style.cssText = 'position:absolute;top:8px;right:8px;width:44px;height:44px;border-radius:22px;border:0;font-size:28px;line-height:1;cursor:pointer;background:rgba(0,0,0,.55);color:#fff;z-index:1;';
    dialog.appendChild(closeButton);

    // `fit`: the dialog is transparent, with the frame and close button hidden, until the
    // page reports its size; a page that is ready but sends none gets the default window.
    let revealed = !action.fit;
    let graceTimer = null;
    if (action.fit) {
        dialog.style.background = 'transparent';
        frame.style.visibility = 'hidden';
        closeButton.style.visibility = 'hidden';
    }
    const reveal = () => {
        revealed = true;
        clearTimeout(graceTimer);
        frame.style.visibility = '';
        closeButton.style.visibility = '';
    };

    let timer = null;
    const frameOrigin = new URL(src, window.location.href).origin;
    let lastNumpadCancelAt = 0;
    // `fallback`: the overlay never became ready and the page is opened instead.
    // onClose (re-dim) must not run then, or the page opens at saver brightness.
    let finished = false;
    const finish = (event, fallback = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        window.removeEventListener('message', onMessage);
        document.removeEventListener('streamline:espresso-start', onShotStart);
        dialog.removeEventListener('close', finish);
        if (dialog.open) dialog.close();
        dialog.remove();
        overlayOpen = false;
        if (onClose && !fallback) onClose();
        // The page may have changed the workflow; on the dashboard the tiles
        // read it again. A caller with nothing to repaint passes no hook.
        afterClose?.();
    };
    // `closeOnShot`: tell the page, then close, so a plugin page never covers a shot.
    const onShotStart = () => {
        document.removeEventListener('streamline:espresso-start', onShotStart);
        try { frame.contentWindow?.postMessage({ type: 'streamline:espresso-start' }, frameOrigin); } catch { /* frame gone */ }
        // The message is a queued task: tearing the frame down in this one would discard
        // the page before it ran.
        setTimeout(() => finish(), 80);
    };
    if (action.closeOnShot) document.addEventListener('streamline:espresso-start', onShotStart);
    const onMessage = event => {
        if (event.source !== frame.contentWindow) return;
        const type = event.data?.type;
        if (type === 'streamline:ready') {
            clearTimeout(timer);
            if (!revealed && !graceTimer) {
                graceTimer = setTimeout(() => {
                    dialog.style.background = 'var(--bg,#fff)'; // no size came: today's default window
                    reveal();
                }, OVERLAY_FIT_GRACE_MS);
            }
        }
        else if (type === 'streamline:close') finish();
        else if (type === 'streamline:size') {
            // The page says how big its content is: the dialog fits it, so a small form is
            // a small dialog over the dashboard. The page draws its own card; the dialog is
            // transparent from here on. Sizes are held to the default dialog's limits.
            if (event.origin !== frameOrigin || full) return;
            const fitted = fitOverlaySize(event.data?.width, event.data?.height, window.innerWidth, window.innerHeight);
            if (!fitted) return;
            dialog.style.width = `${fitted.width}px`;
            dialog.style.height = `${fitted.height}px`;
            dialog.style.background = 'transparent';
            // An iframe whose colour scheme differs from the page around it is painted opaque.
            frame.style.colorScheme = 'normal';
            frame.style.background = 'transparent';
            reveal();
        }
        else if (type === 'streamline:numpad') {
            // Only the page the overlay opened (not one the frame navigated to), only
            // right after a tap, and not again straight after a cancel: a page must not
            // be able to hold the numpad over the close button.
            if (event.origin !== frameOrigin) return;
            const reply = value => frame.contentWindow?.postMessage(
                { type: 'streamline:numpad-result', id: ['string', 'number'].includes(typeof event.data?.id) ? event.data.id : null, value }, frameOrigin);
            const input = parseNumpadInput(event.data);
            if (!openNumpad || !input || !navigator.userActivation?.isActive || Date.now() - lastNumpadCancelAt < NUMPAD_COOLDOWN_MS) {
                reply(null);
                return;
            }
            openNumpad(plugin, 'overlay', input).then(value => {
                if (value === null) lastNumpadCancelAt = Date.now();
                reply(value);
            });
        }
    };
    window.addEventListener('message', onMessage);
    dialog.addEventListener('close', finish);
    closeButton.addEventListener('click', finish);
    // A tap on the backdrop lands on the dialog itself, never on the frame.
    dialog.addEventListener('click', event => { if (event.target === dialog) finish(); });
    document.body.appendChild(dialog);
    try {
        dialog.showModal();
    } catch (e) {
        logger.warn('Plugin overlay could not open:', e);
        finish();
        return;
    }
    timer = setTimeout(() => {
        logger.warn('Plugin overlay did not report ready, opening as a page:', plugin.id);
        finish(null, true);
        window.location.assign(pageUrl);
    }, OVERLAY_READY_MS);
}

