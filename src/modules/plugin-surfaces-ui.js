// plugin-surfaces-ui.js -- renders the surfaces plugins declare through their
// `skin` endpoint (see docs/plugin-surfaces.md). The answer is parsed and
// validated by plugin-surfaces.js; this module only reads it, draws it with
// textContent, and navigates. No plugin code runs here.
//
// A failed or slow read hides that plugin's surfaces and never blocks the
// dashboard. With no plugin answering `skin` nothing is drawn.

import { getScaleReading, getEspressoEndedAt, getPlugins, callPluginEndpoint, connectPluginPush, closePluginPush, API_BASE_URL, currentMachineState, restoreDisplay, dimDisplay } from './api.js';
import { isMachineAsleep } from './screensaver-policy.js';
import { logger } from './logger.js';
import { parseSkinAnswer, skinPlugins, callableEndpoint, liveEndpoint, pushWants,
    nextStepSize, resolveStepSize, formatStepSize, STEPSIZE_MAX, parseNumpadInput, fitNumpadValue, SURFACE_SIZES, SYNC_TILES, scaleDoseFor, fitOverlaySize } from './plugin-surfaces.js';
import { setShotStrip } from './plugin-shot-strip.js';
import { setMenuEntries, setMenuRunner } from './plugin-menu-items.js';
import { planTileModes, createCallQueue, tileHasBuiltinOption } from './plugin-modes.js';
import { getTempUnit } from './units.js';
import { pluginUiUrl } from '../settings/plugin-view.js';
import { applyPluginSetAsync, applyPluginStepAsync, isAutoSteamMode, getScreensaverButtonSlot, isScreensaverActive,
    getStoredStepSize, storeStepSize, setDrawnStepSizes, setupPressAndHold, setDrawnKeepRatio, showToast } from './ui.js';

const READ_TIMEOUT_MS = 2000;
const REFRESH_MS = 60000;
const CALL_TIMEOUT_MS = 5000; // a hung plugin must not hold a tile's call lane
const MIN_GAP_MS = 2000; // focus + visibilitychange can both fire
const MAX_PLUGIN_HEADER_BUTTONS = 1; // across all plugins
const MAX_PLUGIN_SAVER_BUTTONS = 1; // across all plugins

// Same look as the DYE and Settings buttons; width is content-driven so a
// plugin label is not cut to the 135px a system label gets.
const BUTTON_CLASS = 'settings-button flex justify-center items-center min-h-0 h-[53.7px] whitespace-nowrap border-[1.5px] border-solid border-[var(--mimoja-blue-v2)] text-[var(--mimoja-blue-v2)] rounded-[22.5px] text-[21px] font-semibold';

// Where each tile's surfaces go. Both are placed without moving anything: the
// 72px control row has ~17px of empty space under the label and ~17px of gap
// under the buttons, so a line sits under the label and a hint under the value.
const TILES = {
    grind: { section: 'grind-section', label: 'grind-label', control: 'grind-minus' },
    dose: { section: 'dose-section', label: 'dose-label', control: 'dose-in-minus' },
    drink: { section: 'drink-section', label: 'drink-label', control: 'drink-out-minus' },
    temperature: { section: 'brew-section', label: 'brew-label', control: 'temp-minus' },
    flush: { section: 'flush-section', label: 'flush-label', control: 'flush-minus' },
    // Only a tile-mode goes on steam (the parser takes no hint or line for it). Its
    // label block already holds the Time | Flow toggle, so the mode toggle goes in
    // the free line under that, and `label` is the toggle itself.
    steam: { section: 'steam-section', label: 'steam-mode-toggle', control: 'steam-minus' },
    // Like steam: the built-in Temp | Vol toggle is the label the mode toggle goes under.
    hotwater: { section: 'hotwater-section', label: 'hot-water-mode-toggle', control: 'hot-water-vol-minus' },
};
const MUTED = 'var(--low-contrast-white)';

// Text steps a plugin may ask for with `size`. `large` is the built-in Time | Flow
// toggle's 21px on a 24px line. font/line: a line or toggle; pillFont/pill: a hint's
// pill; hit: the touch height of a line or toggle (grows upward over the label, which is
// not interactive); hitHint: a hint's, kept shorter so it stays off the value and the ratio
// label; hitDown: the same on tiles whose label is a control, where it grows downward and
// stops short of the first preset.
// `small` is the original look and must not change.
const SIZE_SPEC = {
    small: { font: 14, line: 17, pillFont: 13, pill: 17, hit: 24, hitHint: 24, hitDown: 17 },
    medium: { font: 17, line: 20, pillFont: 15, pill: 20, hit: 32, hitHint: 28, hitDown: 24 },
    large: { font: 21, line: 24, pillFont: 19, pill: 24, hit: 40, hitHint: 32, hitDown: 28 },
};
const DOWN_TILES = ['steam', 'hotwater', 'flush']; // the label (or toggle) above is a control
const sizeAbove = size => SURFACE_SIZES[Math.max(0, SURFACE_SIZES.indexOf(size) - 1)];
const largestSize = sizes => sizes.reduce((a, b) => (SURFACE_SIZES.indexOf(b) > SURFACE_SIZES.indexOf(a) ? b : a), 'small');

let started = false;
let touchedSections = [];
let running = false;
let refreshAgain = false;
let drawnModes = {}; // tile -> [{ key, plugin, surface }] as last drawn
const selectedMode = {}; // tile -> `${plugin.id}:${surface.id}`; absent = the built-in mode
let lastRun = 0;
let lastKey = '';
let lastEntries = null; // the answer as last drawn, to re-evaluate without a read

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readSurfaces(plugin) {
    try {
        const answer = await withTimeout(callPluginEndpoint(plugin.id, 'skin', null, 'GET'), READ_TIMEOUT_MS);
        return parseSkinAnswer(answer);
    } catch (error) {
        // callPluginEndpoint logs an HTTP failure at error level; a timeout is
        // only logged here, at debug. Either way the plugin is just hidden, so
        // one broken plugin cannot affect the others.
        logger.debug(`Plugin surfaces: ${plugin.id} skin not read:`, error?.message);
        return { surfaces: [], live: null };
    }
}

// A menu item's context rides on the plugin page's URL as plain query parameters
// (shotId, slot, profileId); only scalar values, so a page reads them with URLSearchParams.
function withContext(url, context) {
    if (!url || !context || typeof context !== 'object') return url;
    const out = new URL(url, window.location.href);
    for (const [key, value] of Object.entries(context)) {
        if (value == null || typeof value === 'object') continue;
        out.searchParams.set(key, String(value));
    }
    return out.toString();
}

// What a long-press menu item does: `open` shows the plugin's page (overlay or page)
// with the menu's context in the URL; `call` posts the context to an endpoint the
// plugin declares. Nothing else can run from a menu.
function runMenuItem({ plugin, surface }, context) {
    const { action } = surface;
    if (action?.type === 'open') {
        const url = withContext(pluginUiUrl(plugin, API_BASE_URL, window.location.href, { view: action.view, returnPage: null }), context);
        if (!url) return;
        if (action.presentation === 'overlay') openOverlay(plugin, action, url, null, context);
        else window.location.assign(url);
    } else if (action?.type === 'call' && callableEndpoint(plugin, action.endpoint)) {
        callPluginEndpoint(plugin.id, action.endpoint, context)
            .then(() => refreshPluginSurfaces())
            .catch(error => {
                logger.warn(`Plugin menu call failed (${plugin.id}/${action.endpoint}):`, error?.message);
                showToast('The plugin could not do that', 2400, 'error');
            });
    }
}
setMenuRunner(runMenuItem);

function buildButton(plugin, surface, { bind = true } = {}) {
    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    button.dataset.pluginSurface = `${plugin.id}:${surface.id}`;
    button.dataset.agentId = `plugin:${plugin.id}:${surface.id}`;
    button.style.cssText = 'padding:0 22px;min-width:135px;max-width:260px;gap:10px;';
    if (surface.image) {
        const img = document.createElement('img');
        img.src = surface.image;
        img.alt = '';
        img.style.cssText = 'width:32px;height:32px;border-radius:6px;object-fit:cover;flex:none;';
        button.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = surface.label;
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
    button.appendChild(label);
    if (surface.text) button.title = surface.text;
    button.setAttribute('aria-label', surface.text ? `${surface.label}: ${surface.text}` : surface.label);

    if (bind) bindAction(button, plugin, surface.action, surface);
    return button;
}

// The button on the screensaver. It never commands the machine: the click stops
// here so the saver's wake handler does not see it. Before the plugin's page opens
// the panel is brought back (display only, through the display queue); an overlay
// that closes while the machine is still asleep dims it again. A `page` leaves the
// skin, and the first snapshot on return raises the saver and dims.
function buildSaverButton(plugin, surface) {
    const button = buildButton(plugin, surface, { bind: false });
    button.dataset.agentId = `plugin-saver:${plugin.id}:${surface.id}`;
    button.style.pointerEvents = 'auto';
    const { action } = surface;
    const url = action?.type === 'open'
        ? pluginUiUrl(plugin, API_BASE_URL, window.location.href, { view: action.view, returnPage: null })
        : null;
    button.addEventListener('click', event => {
        event.stopPropagation();
        if (!url) return;
        try {
            restoreDisplay();
        } catch (error) {
            logger.warn('Screensaver button: display not restored:', error);
        }
        if (action.presentation === 'overlay') {
            openOverlay(plugin, action, url, () => {
                if (isMachineAsleep(currentMachineState) && isScreensaverActive()) {
                    try { dimDisplay(); } catch (error) { logger.warn('Screensaver button: display not dimmed:', error); }
                }
            });
        } else {
            window.location.assign(url);
        }
    });
    return button;
}

// The plugin's `ui` page in a dialog over the dashboard. The page must send
// `{type:'streamline:ready'}` once it has loaded (a CSP `frame-ancestors` block
// gives no event the skin could catch) and `{type:'streamline:close'}` to close.
// No ready message in time: drop the dialog and go to the page, as `page` does.
// The skin draws its own close button and closes on a backdrop tap, because key
// events go to the frame once it is touched and a tablet has no Escape key.
const OVERLAY_READY_MS = 3000;
const OVERLAY_FIT_GRACE_MS = 300; // a `fit` page that is ready but sends no size gets the default window after this
const NUMPAD_COOLDOWN_MS = 3000; // after a cancel, long enough to tap the overlay's close button
let overlayOpen = false;

function openOverlay(plugin, action, pageUrl, onClose, context) {
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
        // The page may have changed the workflow; the tiles read it again.
        refreshPluginSurfaces();
        document.dispatchEvent(new Event('streamline:workflow-refresh'));
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
            if (!input || !navigator.userActivation?.isActive || Date.now() - lastNumpadCancelAt < NUMPAD_COOLDOWN_MS) {
                reply(null);
                return;
            }
            openPluginNumpad(plugin, 'overlay', input).then(value => {
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

// The skin's stock full-screen numpad, for a plugin: resolves to the number the user
// confirmed (clamped and rounded to `input`), or null on cancel. One at a time.
// `key` names the previous-values list, so a plugin's numbers never mix with the
// skin's own fields.
let pluginNumpadOpen = false;
async function openPluginNumpad(plugin, key, input) {
    if (pluginNumpadOpen) return null;
    pluginNumpadOpen = true;
    try {
        const module = await import('./numpad-modal.js');
        module.initNumpadModal();
        return await new Promise(resolve => {
            let settled = false;
            const done = value => { if (!settled) { settled = true; resolve(value); } };
            const mock = { value: String(input.value), setAttribute() {}, getAttribute() { return null; }, dispatchEvent() {} };
            Promise.resolve(module.openModal(mock, {
                fieldType: `plugin-input-${String(plugin.id)}:${key}`.replace(/[^A-Za-z0-9_.:-]/g, '_'),
                config: {
                    title: input.title || plugin.name || 'Enter value',
                    unit: input.unit || '',
                    defaultValue: String(input.value),
                    min: input.min,
                    max: input.max,
                    signed: input.min < 0 && input.decimals === 0,
                },
                onConfirm: raw => {
                    const n = parseFloat(raw);
                    done(Number.isFinite(n) ? fitNumpadValue(input, n) : null);
                },
            })).catch(e => { logger.warn('Plugin numpad did not open:', e); done(null); });
            // Cancel and Escape close the dialog without a confirm.
            const dialog = document.getElementById('numpad-modal-overlay');
            if (dialog) dialog.addEventListener('close', () => setTimeout(() => done(null), 0), { once: true });
        });
    } catch (e) {
        logger.warn('Plugin numpad failed:', e);
        return null;
    } finally {
        pluginNumpadOpen = false;
    }
}

// The dose a "use the scale" tap would set; the rules are scaleDoseFor's. null refuses the tap.
function scaleDoseForTap() {
    const { weight, at } = getScaleReading();
    return scaleDoseFor({ weight, readAt: at, now: Date.now(), state: currentMachineState, espressoEndedAt: getEspressoEndedAt() });
}

function bindAction(el, plugin, action, surface) {
    if (action?.type === 'call' && action.input) {
        // The user types the number: the skin's own numpad, then the same call.
        el.addEventListener('click', async () => {
            const number = await openPluginNumpad(plugin, surface.id, action.input);
            if (number === null) return;
            callMode(plugin, surface, number, { immediate: true }).then(sent => {
                if (!sent) logger.warn('Plugin call not delivered:', surface.id);
            });
        });
    } else if (action?.type === 'call') {
        // A fixed number to the plugin's own endpoint; `skin` is read again after,
        // so the plugin's answer decides what the pill says next.
        el.addEventListener('click', () => {
            callMode(plugin, surface, action.value, { immediate: true }).then(sent => {
                if (!sent) logger.warn('Plugin call not delivered:', surface.id);
            });
        });
    } else if (action?.type === 'open') {
        const url = pluginUiUrl(plugin, API_BASE_URL, window.location.href, { view: action.view, returnPage: null });
        if (url && action.presentation === 'overlay') {
            el.addEventListener('click', () => openOverlay(plugin, action, url));
        } else if (url) {
            el.addEventListener('click', () => window.location.assign(url));
        }
    } else if (action?.type === 'step') {
        el.addEventListener('click', () => {
            applyPluginStepAsync(action.field, action.by).then(applied => {
                if (!applied) logger.warn('Plugin step not applied:', action.field);
                else refreshPluginSurfaces();
            });
        });
    } else if (action?.type === 'stepsize') {
        const current = () => resolveStepSize(action.sizes, getStoredStepSize(action.field), action.custom);
        const use = size => {
            storeStepSize(action.field, size);
            document.querySelectorAll('[data-stepsize-field]').forEach(node => {
                if (node.dataset.stepsizeField !== action.field) return;
                node.textContent = formatStepSize(size, action.field);
                if (node.parentElement && node.parentElement !== document.body && node.parentElement.tagName === 'BUTTON') {
                    node.parentElement.title = node.parentElement.dataset.customTitle || node.textContent;
                }
            });
        };
        const cycle = () => use(nextStepSize(action.sizes, current()));
        // The skin's own numpad, so a stepless grinder's user types the step they want.
        const typeIt = async () => {
            const size = await openPluginNumpad(plugin, `stepsize-${action.field}`, {
                title: 'Step size', unit: action.field === 'grinderSetting' ? '' : 'g',
                min: 0.01, max: STEPSIZE_MAX, decimals: 2, value: current(),
            });
            if (size !== null) use(size);
        };
        if (!action.custom) el.addEventListener('click', cycle);
        // Tap cycles the offered sizes (or types, when there are none); a long press types.
        else setupPressAndHold(el, action.sizes.length ? cycle : typeIt, typeIt);
    } else if (action?.type === 'set') {
        el.addEventListener('click', () => {
            const value = action.from === 'scale' ? scaleDoseForTap() : action.value;
            if (value === null) {
                logger.warn('Plugin set from the scale refused:', surface.id);
                showToast('The scale weight cannot be used as the dose right now', 2400, 'info');
                return;
            }
            applyPluginSetAsync(action.field, value).then(applied => {
                if (!applied) logger.warn('Plugin set not applied:', action.field);
                else refreshPluginSurfaces();
            });
        });
    }
}

// The visible pill or line. With an action it sits inside a larger transparent
// button, because the 17px gap it lives in is too small to tap reliably.
function buildTileSurface(plugin, surface) {
    const el = document.createElement('span');
    el.textContent = surface.text;
    if (surface.action?.type === 'stepsize') {
        // Drawn from this device's stored size, so a redraw keeps it correct.
        el.dataset.stepsizeField = surface.action.field;
        el.textContent = formatStepSize(resolveStepSize(surface.action.sizes, getStoredStepSize(surface.action.field), surface.action.custom), surface.action.field);
    }
    el.style.cssText = 'display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    const title = surface.title || el.textContent;
    // Switched on: the skin's blue and bold, so a lock or a chosen option reads at a glance.
    if (surface.active) el.dataset.active = '1';

    const root = surface.action ? document.createElement('button') : el;
    if (surface.action) {
        root.appendChild(el);
        root.style.cssText = 'display:flex;align-items:flex-end;justify-content:center;background:none;border:0;padding:0;cursor:pointer;';
        bindAction(root, plugin, surface.action, surface);
        if (surface.action.type === 'call') root.setAttribute('aria-pressed', String(surface.active === true));
    } else {
        root.style.pointerEvents = 'none';
    }
    root.dataset.pluginSurface = surface.id;
    root.dataset.agentId = `plugin-tile:${surface.tile}:${surface.kind}`;
    root.title = title;
    if (surface.title) root.dataset.customTitle = surface.title;
    return { root, el };
}

function placeTileSurface(plugin, surface, size = surface.size || 'small') {
    const tile = TILES[surface.tile];
    const spec = SIZE_SPEC[size];
    const { root, el } = buildTileSurface(plugin, surface);
    // A hint is a pill, a line plain text; the visible part is `visible` px high.
    const visible = surface.kind === 'tile-hint' ? spec.pill : spec.line;
    const hit = surface.action ? (surface.kind === 'tile-hint' ? spec.hitHint : spec.hit) : visible;
    // Text that does not fit at this step is drawn one step smaller.
    const fits = () => size === 'small' || el.scrollWidth <= el.clientWidth + 1;
    root.style.position = 'absolute';
    root.style.overflow = surface.action ? 'visible' : 'hidden';

    if (surface.kind === 'tile-hint') {
        const parent = document.getElementById(tile.control)?.parentElement;
        if (!parent) return null;
        // Pill is 17px at the bottom of the gap, ending 1px short of the next
        // row. The hit area grows upward only and is 100px wide so it stays
        // between the minus and plus buttons.
        root.style.left = '50%';
        root.style.transform = 'translateX(-50%)';
        root.style.top = `${72 + 17 - hit}px`; // the pill's bottom stays 17px under the row; a bigger pill grows upward
        root.style.width = surface.action ? '100px' : 'auto';
        root.style.maxWidth = '246px';
        root.style.height = `${hit}px`;
        root.style.zIndex = '1';
        // A bigger pill may be wider than the 100px touch box; it is still part of the button.
        el.style.cssText += `max-width:${size === 'small' ? '100%' : '246px'};height:${visible}px;line-height:${visible}px;padding:0 ${size === 'small' ? 10 : 12}px;border-radius:${Math.ceil(visible / 2)}px;`
            + `font-size:${spec.pillFont}px;font-weight:600;background:var(--button-grey);color:${MUTED};`
            + (size === 'small' ? '' : 'flex-shrink:0;');
        if (surface.active) el.style.cssText += 'color:var(--mimoja-blue-v2);font-weight:700;box-shadow:inset 0 0 0 1.5px var(--mimoja-blue-v2);';
        parent.appendChild(root);
        if (!fits()) { root.remove(); return placeTileSurface(plugin, surface, sizeAbove(size)); }
        return root;
    }
    const section = document.getElementById(tile.section);
    const label = document.getElementById(tile.label);
    if (!section || !label) return null;
    if (!section.style.position) {
        section.style.position = 'relative';
        touchedSections.push(section);
    }
    const top = label.offsetTop + label.offsetHeight + 1;
    root.style.left = '0';
    root.style.top = `${top + spec.line - hit}px`;
    root.style.width = `${label.offsetWidth}px`;
    root.style.height = `${hit}px`;
    root.style.zIndex = '1';
    if (surface.action) root.style.justifyContent = 'flex-start';
    el.style.cssText += `${root === el ? '' : 'width:100%;'}font-size:${spec.font}px;line-height:${spec.line}px;color:${MUTED};`;
    if (surface.active) el.style.cssText += 'color:var(--mimoja-blue-v2);font-weight:700;';
    section.appendChild(root);
    if (!fits()) { root.remove(); return placeTileSurface(plugin, surface, sizeAbove(size)); }
    return root;
}

// What the built-in option of each tile's toggle says.
function builtinLabel(tile) {
    if (tile === 'temperature') return getTempUnit() === 'F' ? '°F' : '°C';
    if (tile === 'dose' || tile === 'drink') return 'g';
    if (tile === 'flush' || tile === 'steam') return 's';
    return document.getElementById(TILES[tile].label)?.textContent.trim() || '';
}

function modeKey(plugin, surface) {
    return `${plugin.id}:${surface.id}`;
}

// The tile reacts to this (value, steppers, presets). Sent when the selection
// changes and again when the plugin's answer for the selected mode changed.
function announceMode(tile) {
    const entry = (drawnModes[tile] || []).find(m => m.key === selectedMode[tile]) || null;
    document.dispatchEvent(new CustomEvent('streamline:tilemodechange', {
        detail: { tile, plugin: entry?.plugin || null, surface: entry?.surface || null },
    }));
}

function setSelectedMode(tile, key) {
    if ((selectedMode[tile] || null) === key) return;
    if (key) selectedMode[tile] = key; else delete selectedMode[tile];
    paintToggle(tile);
    announceMode(tile);
    // A mode that asked for it applies its own value as soon as it is chosen, as if
    // the user had tapped a preset (a flow and time pair set by one tap).
    const chosen = key && (drawnModes[tile] || []).find(m => m.key === key);
    if (chosen?.surface.applyOnSelect) {
        const { second } = chosen.surface;
        callMode(chosen.plugin, chosen.surface, chosen.surface.value,
            { immediate: true, extra: second ? { [second.field]: second.value } : undefined });
    }
}

function paintToggle(tile) {
    const root = document.querySelector(`[data-plugin-surface="mode:${tile}"]`);
    if (!root) return;
    if (tile === 'flush') {
        // The way back to the built-in flush is the label: say so while a mode is on.
        const label = document.getElementById(TILES.flush.label);
        if (label) {
            label.style.cursor = selectedMode.flush ? 'pointer' : '';
            label.title = selectedMode.flush ? 'Tap to go back to the normal flush' : '';
        }
    }
    root.querySelectorAll('button').forEach(b => {
        const on = (b.dataset.modeKey || '') === (selectedMode[tile] || '');
        b.setAttribute('aria-pressed', String(on));
        b.style.color = on ? 'var(--mimoja-blue-v2)' : MUTED;
        b.style.fontWeight = on ? '700' : '600';
    });
}

// The `Auto | F | T` style toggle in the label slot. The visible text is 17px
// high like a tile-line; the 24px root (and the buttons filling it) grows upward
// over the label, which is not interactive, to give a touch target. The root is
// wider than the label by the free gap before the -/+ control so three options fit;
// it ignores pointer events itself so that gap never steals a tap.
function placeModeToggle(tile, modes, size = largestSize(modes.map(m => m.surface.size || 'small'))) {
    const spec = SIZE_SPEC[size];
    const down = DOWN_TILES.includes(tile);
    const { section, label: labelId } = TILES[tile];
    const label = document.getElementById(labelId);
    // Steam's toggle sits in its own block, which is what the line is placed in.
    const sectionEl = tile === 'steam' || tile === 'hotwater' ? label?.parentElement : document.getElementById(section);
    if (!sectionEl || !label) return false;
    if (!sectionEl.style.position) {
        sectionEl.style.position = 'relative';
        touchedSections.push(sectionEl);
    }
    // Over the label there is room to grow upward; over steam's toggle there is not.
    // A bigger step on the tiles whose label is a control grows downward instead.
    const hit = size === 'small' ? (tile === 'steam' || tile === 'hotwater' ? 17 : 24) : (down ? spec.hitDown : spec.hit);
    const extra = tile === 'steam' || tile === 'hotwater' ? 14 : 30;
    // Never run under the -/+ control: the row is cut at the free space before it
    // (measured, because the page may be scaled), less a few px of air.
    let width = label.offsetWidth + extra;
    const control = document.getElementById(TILES[tile].control);
    const labelBox = label.getBoundingClientRect();
    if (control && labelBox.width > 0) {
        const scale = labelBox.width / label.offsetWidth;
        const room = (control.getBoundingClientRect().left - labelBox.left) / scale - 6;
        if (room > label.offsetWidth) width = Math.min(width, Math.floor(room));
    }
    const top = label.offsetTop + label.offsetHeight + 1;
    const root = document.createElement('div');
    root.dataset.pluginSurface = `mode:${tile}`;
    root.dataset.agentId = `plugin-tile:${tile}:tile-mode`;
    root.setAttribute('role', 'group');
    // Text sits at the bottom of a root that grows upward, and at the top of one that grows downward.
    const growsDown = size !== 'small' && down;
    root.style.cssText = `position:absolute;left:0;top:${growsDown ? top : top + spec.line - hit}px;width:${width}px;height:${hit}px;`
        + `z-index:1;display:flex;align-items:${growsDown ? 'flex-start' : 'flex-end'};gap:${tile === 'steam' || tile === 'hotwater' || tile === 'flush' ? 2 : 6}px;white-space:nowrap;overflow:hidden;pointer-events:none;`
        + `font-size:${spec.font}px;line-height:${spec.line}px;color:${MUTED};`;

    const options = [...(tileHasBuiltinOption(tile) ? [{ key: '', label: builtinLabel(tile), title: '' }] : []),
        ...modes.map(m => ({ key: m.key, label: m.surface.label, title: m.surface.label }))];
    options.forEach((opt, i) => {
        if (i > 0) {
            const bar = document.createElement('span');
            bar.textContent = '|';
            bar.style.pointerEvents = 'none';
            root.appendChild(bar);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = opt.label;
        button.dataset.modeKey = opt.key;
        // Fills the root's height; the text sits at the bottom like a tile-line.
        button.style.cssText = `background:none;border:0;padding:${growsDown ? 0 : hit - spec.line}px 0 0;box-sizing:border-box;cursor:pointer;font:inherit;`
            + `height:100%;min-width:32px;line-height:${spec.line}px;text-align:center;overflow:hidden;text-overflow:ellipsis;pointer-events:auto;`;
        if (opt.title) button.title = opt.title;
        button.addEventListener('click', () => setSelectedMode(tile, opt.key || null));
        root.appendChild(button);
    });
    sectionEl.appendChild(root);
    // An option cut short at this step: draw the whole toggle one step smaller.
    if (size !== 'small' && (root.scrollWidth > root.clientWidth + 1
        || [...root.querySelectorAll('button')].some(b => b.scrollWidth > b.clientWidth + 1))) {
        root.remove();
        return placeModeToggle(tile, modes, sizeAbove(size));
    }
    if ((tile === 'steam' || tile === 'hotwater' || tile === 'flush') && !label.dataset.pluginModeWired) {
        // Choosing a built-in steam mode ends a plugin one; on flush, which has no
        // built-in option in the row, a tap on the label does.
        label.dataset.pluginModeWired = '1';
        label.addEventListener('click', () => setSelectedMode(tile, null));
        // The built-in toggle also switches on Enter and Space.
        label.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') setSelectedMode(tile, null);
        });
    }
    return true;
}

// Sends `{ [field]: number }` to the mode's own http endpoint; the answer is
// ignored and `skin` is read again, so what the plugin says is what is shown.
// Steppers pass `immediate: false` to be debounced; presets and the numpad do not.
const callQueue = createCallQueue({
    // A timeout rejects, which the queue counts as a failed send.
    send: (key, { plugin, endpoint, body }) => withTimeout(
        callPluginEndpoint(encodeURIComponent(plugin.id), endpoint, body, 'POST'), CALL_TIMEOUT_MS),
});

// A mode shares one lane per tile (newest value wins). A fixed-value hint or line
// is its own lane, so tapping it never supersedes a mode's pending value.
const callKey = (plugin, surface) => (surface.kind === 'tile-hint' || surface.kind === 'tile-line' || surface.kind === 'ratio-action'
    ? `${plugin.id}:${surface.id}`
    : `${plugin.id}:${surface.tile}`);

// True while a call for this mode is being sent or the user is still stepping, so a
// redraw must keep the value the user is moving rather than the plugin's older one.
export function isModeCallBusy(plugin, surface) {
    return callQueue.busy(callKey(plugin, surface));
}

// `extra` are more `{ field: number }` pairs sent in the same body (a mode's second value).
export function callMode(plugin, surface, number, { immediate = true, extra } = {}) {
    const action = surface?.action;
    if (action?.type !== 'call' || !callableEndpoint(plugin, action.endpoint) || !Number.isFinite(number)) {
        return Promise.resolve(false);
    }
    const payload = { plugin, endpoint: action.endpoint, body: { [action.field]: number, ...extra } };
    return callQueue.request(callKey(plugin, surface), payload, { immediate }).then(sent => {
        // null: a newer call replaced or overtook this one, which will refresh.
        // Otherwise read skin again and redraw even if the answer is unchanged, so
        // a number the plugin refused snaps back.
        if (sent !== null) { lastKey = ''; refreshPluginSurfaces(); }
        // The plugin answers after its own PUT /workflow, so the tiles can be re-read.
        if (sent === true) document.dispatchEvent(new Event('streamline:workflow-refresh'));
        return sent === true;
    }).catch(() => false);
}

// -> true when everything was drawn. Tile placement measures the label
// (offsetTop/Height/Width), which is 0 while the main page is display:none, so
// tiles are skipped then and the caller must not remember the answer as drawn.
// The built-in "(1:x)" label under Drink is not ours to remove, so a plugin's
// ratio-action only attaches a click handler and a look to it, and render() takes
// both off again before every redraw.
let ratioUndo = null;
function clearRatioAction() {
    if (ratioUndo) ratioUndo();
    ratioUndo = null;
}

function placeRatioAction(plugin, surface) {
    const label = document.getElementById('drink-ratio-value');
    if (!label || !surface.action) return false;
    // bindAction wires the click onto a throwaway node; the label forwards to it,
    // so the call / open code is shared with every other surface.
    const proxy = document.createElement('span');
    bindAction(proxy, plugin, surface.action, surface);
    const onClick = event => { event.stopPropagation(); proxy.click(); };
    const saved = { cursor: label.style.cursor, padding: label.style.padding, margin: label.style.margin,
        decoration: label.style.textDecoration, title: label.title, role: label.getAttribute('role'), tab: label.getAttribute('tabindex') };
    label.addEventListener('click', onClick);
    label.style.cursor = 'pointer';
    // A 19px line is too small to tap: padding grows the target, the negative margin cancels it.
    label.style.padding = '8px 0';
    label.style.margin = '-8px 0';
    label.style.textDecoration = 'underline dotted';
    label.title = surface.title || label.title;
    label.setAttribute('role', 'button');
    label.setAttribute('tabindex', '0');
    ratioUndo = () => {
        label.removeEventListener('click', onClick);
        Object.assign(label.style, { cursor: saved.cursor, padding: saved.padding, margin: saved.margin, textDecoration: saved.decoration });
        label.title = saved.title;
        if (saved.role === null) label.removeAttribute('role'); else label.setAttribute('role', saved.role);
        if (saved.tab === null) label.removeAttribute('tabindex'); else label.setAttribute('tabindex', saved.tab);
    };
    return true;
}

function render(rawEntries) {
    // A hint or line whose call endpoint the plugin does not declare is drawn
    // inert, like a surface with no action, so it does not look tappable.
    const entries = rawEntries.map(e => (e.surface.action?.type === 'call' && e.surface.kind !== 'tile-mode'
        && !callableEndpoint(e.plugin, e.surface.action.endpoint)
        ? { ...e, surface: { ...e.surface, action: null } } : e));
    lastEntries = entries;
    const mainHidden = document.getElementById('main-page')?.style.display === 'none';
    document.querySelectorAll('[data-plugin-surface]').forEach(el => {
        // The tile's value and presets overlays belong to the tile-modes module,
        // which clears them when the mode is left.
        const owner = el.dataset.pluginSurface;
        if (owner.startsWith('mode-value:') || owner.startsWith('mode-presets:')) return;
        el.remove();
    });
    touchedSections.forEach(el => { el.style.position = ''; });
    touchedSections = [];
    clearRatioAction();

    const container = document.getElementById('header-right-controls');
    const anchor = container?.firstChild;
    const drawnSizes = {};
    const drawnCustom = {};
    let drawnKeepRatio = null; // from the first drawn Drink surface that asks
    let drawnKeepMoves = 'both';
    const usedSlots = new Set(); // two plugins asking for the same tile slot: first wins
    let headerButtons = 0;
    let saverButtons = 0;
    let saverSlotMissing = false;

    // A mode takes the label slot, so a tile-line on that tile is not drawn.
    // A mode whose endpoint cannot be called is never drawn, and neither is a steam
    // mode while the built-in Auto mode owns the steam -/+.
    const steamAuto = isAutoSteamMode();
    const plan = planTileModes(entries.filter(({ plugin, surface }) => surface.kind !== 'tile-mode'
        || (callableEndpoint(plugin, surface.action?.endpoint) && !(surface.tile === 'steam' && steamAuto))));
    const modeTiles = new Set(Object.keys(plan).filter(tile => TILES[tile]));
    drawnModes = {};

    for (const { plugin, surface } of entries) {
        if (surface.kind === 'header-button') {
            // One plugin button in total, the first plugin in Decaid's list whose
            // read succeeded wins: the header has no room for more when the DYE2
            // button is off.
            if (container && headerButtons < MAX_PLUGIN_HEADER_BUTTONS) {
                container.insertBefore(buildButton(plugin, surface), anchor);
                headerButtons += 1;
            }
            continue;
        }
        if (surface.kind === 'screensaver-button') {
            // One in total, like the header button. The slot is made with the
            // screensaver; until it exists the render is retried (see below).
            const slot = getScreensaverButtonSlot();
            if (!slot) { saverSlotMissing = true; continue; }
            if (saverButtons < MAX_PLUGIN_SAVER_BUTTONS) {
                slot.appendChild(buildSaverButton(plugin, surface));
                saverButtons += 1;
            }
            continue;
        }
        if (mainHidden) continue;
        if (surface.kind === 'tile-mode') continue; // drawn per tile below
        if (surface.kind === 'menu-item') continue; // listed in plugin-menu-items.js, drawn by the menus
        if (surface.kind === 'tile-sync') continue; // nothing drawn; applied by syncTiles()
        if (surface.kind === 'ratio-action') {
            if (!ratioUndo) placeRatioAction(plugin, surface); // first plugin wins
            continue;
        }
        if (surface.kind === 'tile-line' && modeTiles.has(surface.tile)) continue;
        const slot = `${surface.kind}:${surface.tile}`;
        if (usedSlots.has(slot) || !TILES[surface.tile]) continue;
        if (placeTileSurface(plugin, surface)) {
            usedSlots.add(slot);
            const a = surface.action;
            if (a?.type === 'stepsize' && !drawnSizes[a.field]) { drawnSizes[a.field] = a.sizes; drawnCustom[a.field] = a.custom === true; }
            // A plugin mode on Drink owns the yield, so the ratio is not held for it.
            if (surface.keepRatio && !drawnKeepRatio && !modeTiles.has('drink')) { drawnKeepRatio = surface.keepRatio; drawnKeepMoves = surface.keepRatioMoves || 'both'; }
        }
    }
    setShotStrip(mainHidden ? null : entries.find(e => e.surface.kind === 'shot-strip')?.surface || null);
    setDrawnStepSizes(drawnSizes, drawnCustom);
    setDrawnKeepRatio(drawnKeepRatio, drawnKeepMoves);

    if (!mainHidden) {
        for (const tile of modeTiles) {
            const modes = plan[tile].map(({ plugin, surface }) => ({ key: modeKey(plugin, surface), plugin, surface }));
            if (placeModeToggle(tile, modes)) drawnModes[tile] = modes;
        }
        // A selected mode that is gone (plugin off, answer changed) falls back to the built-in one.
        for (const tile of Object.keys(selectedMode)) {
            if (!(drawnModes[tile] || []).some(m => m.key === selectedMode[tile])) setSelectedMode(tile, null);
        }
        Object.keys(drawnModes).forEach(paintToggle);
        // The answer may have changed the selected mode's value or presets.
        Object.keys(selectedMode).forEach(announceMode);
    }
    return !mainHidden && !saverSlotMissing;
}

// `tile-sync`: a device's reading becomes the tile's value (device wins), as a tile edit
// would: workflow plus the profile's override. Applied when the reading CHANGES, so the
// user's own edit of the tile stands until the device moves again. First plugin wins.
const syncedValue = new Map(); // tile -> "pluginId:value" last written
function syncTiles(entries) {
    const taken = new Set();
    for (const { plugin, surface } of entries) {
        if (surface.kind !== 'tile-sync' || taken.has(surface.tile)) continue;
        taken.add(surface.tile);
        const mark = `${plugin.id}:${surface.value}`;
        if (syncedValue.get(surface.tile) === mark) continue;
        syncedValue.set(surface.tile, mark);
        applyPluginSetAsync(SYNC_TILES[surface.tile], surface.value).then(applied => {
            if (!applied) syncedValue.delete(surface.tile); // try again on the next read
        });
    }
}

export async function refreshPluginSurfaces() {
    if (running) { refreshAgain = true; return; } // e.g. a mode call finished mid-read
    running = true;
    lastRun = Date.now();
    try {
        const plugins = skinPlugins(await getPlugins());
        const entries = [];
        const live = new Map(); // plugin id -> websocket endpoint it pushes "changed" on
        for (const plugin of plugins) {
            const answer = await readSurfaces(plugin);
            for (const surface of answer.surfaces) entries.push({ plugin, surface });
            const endpoint = liveEndpoint(plugin, answer.live);
            if (endpoint) live.set(plugin.id, endpoint);
        }
        syncLive(live);
        syncTiles(entries);
        // Only entries that can run: a call needs an endpoint the plugin declares, an open
        // needs its `ui` page. An entry that does nothing when tapped is worse than none.
        setMenuEntries(entries.filter(e => e.surface.kind === 'menu-item' && (e.surface.action?.type === 'call'
            ? callableEndpoint(e.plugin, e.surface.action.endpoint)
            : !!pluginUiUrl(e.plugin, API_BASE_URL, null, { view: e.surface.action?.view }))));
        // Skip the DOM work when nothing changed: a rebuild resizes the header
        // controls, which re-runs the strip fit.
        const key = JSON.stringify(entries.map(e => [e.plugin.id, e.surface]));
        if (key === lastKey) return;
        // Only remember the answer once it was fully drawn; a render skipped
        // while the main page is hidden is retried by the next refresh.
        lastKey = render(entries) ? key : '';
    } catch (error) {
        logger.warn('Plugin surfaces refresh failed:', error);
    } finally {
        running = false;
        if (refreshAgain) { refreshAgain = false; refreshPluginSurfaces(); }
    }
}

// Sockets a plugin asked for with `live`: one per plugin, only while the page is
// visible. A message re-reads `skin` and asks the tiles to re-read the workflow
// (the plugin may have changed it). A burst is one read: the wait starts at the
// first message and is not pushed back by later ones, so a fast stream still
// refreshes every PUSH_DEBOUNCE_MS.
const PUSH_DEBOUNCE_MS = 300;
const liveSockets = new Map(); // plugin id -> endpoint
let pushTimer = null;

let pushWantsWorkflow = false;

function onPush(data) {
    if (pushWants(data).workflow) pushWantsWorkflow = true;
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
        pushTimer = null;
        const workflow = pushWantsWorkflow;
        pushWantsWorkflow = false;
        refreshPluginSurfaces();
        if (workflow) document.dispatchEvent(new Event('streamline:workflow-refresh'));
    }, PUSH_DEBOUNCE_MS);
}

function closeLive() {
    for (const id of liveSockets.keys()) closePluginPush(id);
    liveSockets.clear();
}

function syncLive(wanted) {
    if (document.hidden) { closeLive(); return; }
    for (const id of [...liveSockets.keys()]) {
        if (wanted.get(id) !== liveSockets.get(id)) { closePluginPush(id); liveSockets.delete(id); }
    }
    for (const [id, endpoint] of wanted) {
        if (liveSockets.get(id) === endpoint) continue;
        connectPluginPush(id, endpoint, onPush);
        liveSockets.set(id, endpoint);
    }
}

function refreshIfDue() {
    if (Date.now() - lastRun >= MIN_GAP_MS) refreshPluginSurfaces();
}

// Idempotent: the main page can be mounted more than once per session.
export function initPluginSurfaces() {
    if (started) return;
    started = true;
    import('./plugin-tile-modes.js').then(m => m.initTileModes());
    refreshPluginSurfaces();
    setInterval(refreshPluginSurfaces, REFRESH_MS);
    window.addEventListener('focus', refreshIfDue);
    document.addEventListener('visibilitychange', () => {
        // Visible again: read now (also reopens the live sockets closed when hidden).
        if (document.visibilityState === 'visible') refreshPluginSurfaces();
        else closeLive();
    });
    // Entering or leaving the built-in Auto steam mode: draw again from the last
    // answer, which hides or restores the steam toggle.
    document.addEventListener('streamline:steamautochange', () => {
        if (lastEntries && !render(lastEntries)) lastKey = '';
    });
    // The screensaver element is built after the first read on a slow boot.
    document.addEventListener('streamline:screensaverready', () => {
        lastKey = '';
        refreshPluginSurfaces();
    });
    // Returning from a sub-page: a surface rendered while the page was hidden
    // must be placed again, so forget the last drawn answer.
    document.addEventListener('streamline:mainpagevisible', () => {
        // Not refreshIfDue: a hidden refresh just before returning would put this
        // one inside the 2 s gap and leave the tiles undrawn until the next minute.
        // `running` already stops overlapping reads.
        lastKey = '';
        refreshPluginSurfaces();
    });
}
