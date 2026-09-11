// dyeStrip.js — Phase B of the DYE2 → Streamline dashboard bridge.
//
// Streamline's header carries a vertical P / F / R toggle (top-left):
//   P = Profile favourites  (the existing profile <nav>, untouched — DEFAULT)
//   F = DYE2 auto-favourites (bean + recipe snapshots)
//   R = DYE2 recipes
// F and R are driven by data DYE2 writes to the generic KV store; Streamline is a
// read-only consumer (see dye2-plugin/KV_CONTRACT.md). When the DYE2 keys are
// empty/missing the header behaves exactly as today: default P, F/R render empty.
//
// Apply semantics mirror dye2-plugin/src/pages/dashboard.ts (applyAutoFavourite /
// applyRecipe): PUT the item's ready-made `workflow` ({context, profile?}); for
// recipes ALSO live-merge steam / hot-water / flush onto the fetched workflow
// (those need targetTemperature/flow a recipe doesn't capture, so they can't live
// in the stored `workflow`). Legacy items without `workflow` fall back to
// snapshot+copyMask / dashboardVariables.

import { API_BASE_URL, getWorkflow, updateWorkflow, getDye2KvArray, getPlugins, installPluginFromRelease, enablePlugin, checkPluginUpdates, approvePluginUpdate } from './api.js';
import { applyWorkflowToMainPageUI } from './profileManager.js';
import { logger } from './logger.js';
import { fitTextToBox } from './i18n.js';

const AF_KEY = 'autoFavourites';
const RECIPES_KEY = 'recipes';
const MODE_KEY = 'streamline.dyeStripMode';
// Master on/off for the whole DYE2 header UI (set in Extensions settings).
// DEFAULT OFF: when this is not 'true' the header is byte-identical to stock
// Streamline (profile favourites only, no toggle / DYE button / strip).
const ENABLED_KEY = 'streamline.dye2Enabled';
const PLUGIN_BASE = `${API_BASE_URL}/plugins/dye2.reaplugin`; // …/api/v1/plugins/dye2.reaplugin
const MAX_FAV_CELLS = 4; // + a trailing "VIEW ALL AUTO FAV" cell

// Plugin install / update state (see getDye2VersionInfo below).
const PLUGIN_ID = 'dye2.reaplugin';
export const PLUGIN_REPO = 'decentespresso/dye2';
export const PLUGIN_RELEASES_PAGE = 'https://github.com/decentespresso/dye2/releases/latest';

// Cell classes mirror the existing profile favourite buttons (index.html) so the
// F/R strip is visually identical to the P strip.
const CELL_BASE =
    'flex justify-center items-center text-center text-balance px-3 leading-tight ' +
    'overflow-hidden [overflow-wrap:anywhere] w-[240px] h-[98px] text-[22px] rounded-[19px] ' +
    'border-2 font-semibold cursor-pointer';
const CELL_IDLE = ' border-[var(--profile-button-outline-color)] bg-[var(--profile-button-background-color)] text-[var(--profile-button-text-color)]';
const CELL_ACTIVE = ' border-[var(--mimoja-blue)] bg-[var(--mimoja-blue-v2)] text-white';
const CELL_ACCENT = ' border-[var(--mimoja-blue)] bg-[var(--box-color)] text-[var(--mimoja-blue)]'; // VIEW ALL
// Empty-state hint. Carries the cell height explicitly: in R mode it is the only
// child, so without it the strip collapses to one line of text and the hint sits
// at the top of the band instead of centred against where the cells would be.
const HINT_CLASS =
    'flex items-center h-[98px] text-[20px] text-[var(--low-contrast-white)] px-2';

let favCache = [];
let recipeCache = [];
let currentMode = 'P';
let activeItemId = null; // transient highlight of the last-applied F/R cell

// ─── Data ────────────────────────────────────────────────────────────────────

export async function loadDyeStripData() {
    const [favs, recipes] = await Promise.all([
        getDye2KvArray(AF_KEY),
        getDye2KvArray(RECIPES_KEY),
    ]);
    favCache = Array.isArray(favs) ? favs : [];
    recipeCache = Array.isArray(recipes) ? recipes : [];
    logger.info(`dyeStrip: loaded ${favCache.length} favs, ${recipeCache.length} recipes`);
}

function visibleFavs() {
    return favCache
        .filter(f => f && f.alwaysOnDashboard !== false)
        .sort((a, b) => {
            const sa = a.favSlot ?? Infinity, sb = b.favSlot ?? Infinity;
            if (sa !== sb) return sa - sb;
            return String(a.capturedAt || '').localeCompare(String(b.capturedAt || ''));
        })
        .slice(0, MAX_FAV_CELLS);
}

// Mirrors visibleFavs: DYE2's recipe editor has a "Show on Streamline Dashboard" toggle
// that writes showOnStreamlineDashboard, so honour it here the same way alwaysOnDashboard
// is honoured for favourites. Absent ⇒ shown (see dye2-plugin/KV_CONTRACT.md).
function visibleRecipes() {
    return recipeCache.filter(r => r && r.showOnStreamlineDashboard !== false);
}

function favLabel(fav) {
    const snp = fav.snapshot || {};
    // User-typed title wins: DYE2 always fills subtitle (roaster / coffee name), so a
    // subtitle-first order would never show the name the user actually entered.
    return fav.title || fav.subtitle || snp.coffeeName || 'Favourite';
}

function recipeLabel(recipe) {
    return recipe.title || recipe.name || 'Recipe';
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

function makeCell(label, extraClass, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = CELL_BASE + extraClass;
    btn.textContent = label;
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
}

export function renderStrip(mode) {
    const strip = document.getElementById('dye-strip');
    if (!strip) return;
    strip.innerHTML = '';

    if (mode === 'F') {
        const favs = visibleFavs();
        favs.forEach(fav => {
            const active = fav.id != null && fav.id === activeItemId;
            const cell = makeCell(favLabel(fav), active ? CELL_ACTIVE : CELL_IDLE, () => {
                activeItemId = fav.id;
                renderStrip('F');
                applyFavourite(fav).catch(e => logger.error('applyFavourite failed', e));
            });
            strip.appendChild(cell);
        });
        // Trailing "VIEW ALL AUTO FAV" cell (always present, opens the DYE2 page).
        strip.appendChild(makeCell('VIEW ALL AUTO FAV', CELL_ACCENT, () => openPluginOverlay('auto-favs')));
        if (favs.length === 0) {
            // Nothing captured yet — a soft hint before the VIEW ALL cell.
            const hint = document.createElement('span');
            hint.className = HINT_CLASS;
            hint.textContent = 'No auto-favourites yet';
            strip.insertBefore(hint, strip.firstChild);
        }
    } else if (mode === 'R') {
        const recipes = visibleRecipes().slice(0, 5);
        if (recipes.length === 0) {
            const hint = document.createElement('span');
            hint.className = HINT_CLASS;
            hint.textContent = 'No recipes yet';
            strip.appendChild(hint);
        }
        recipes.forEach(recipe => {
            const active = recipe.id != null && recipe.id === activeItemId;
            const cell = makeCell(recipeLabel(recipe), active ? CELL_ACTIVE : CELL_IDLE, () => {
                activeItemId = recipe.id;
                renderStrip('R');
                applyRecipe(recipe).catch(e => logger.error('applyRecipe failed', e));
            });
            strip.appendChild(cell);
        });
    }
    // Fit only once attached: wrapping depends on the real box width, which an
    // unattached node does not have.
    fitStripCells(strip);
}

// Shrink any label that wraps past its cell. Cells are a fixed 98px tall and the
// box only clips, so without this a long bean name loses its last line under the
// bottom border.
function fitStripCells(nav) {
    if (nav) nav.querySelectorAll('button').forEach(el => fitTextToBox(el));
}

// ─── Apply ─────────────────────────────────────────────────────────────────────

// Fetch the live workflow, merge the item onto it, PUT, then refresh the left
// controls — the same GET→mutate→PUT shape DYE2's dashboard.ts uses so no other
// workflow field is clobbered.
export async function applyFavourite(fav) {
    if (!fav) return;
    const live = (await getWorkflow()) || {};
    if (fav.workflow) {
        applyStoredWorkflow(live, fav.workflow);
    } else {
        applyFavLegacy(live, fav); // snapshot + copyMask
    }
    await updateWorkflow(live);
    await refreshAfterApply();
}

export async function applyRecipe(recipe) {
    if (!recipe) return;
    const live = (await getWorkflow()) || {};
    if (recipe.workflow) {
        applyStoredWorkflow(live, recipe.workflow);
    } else {
        applyRecipeLegacy(live, recipe); // dashboardVariables + top-level fields
    }
    // Steam / hot-water / flush are NOT in the stored workflow — live-merge them.
    mergeRecipeLiveSettings(live, recipe.dashboardVariables || {});
    await updateWorkflow(live);
    await refreshAfterApply();
}

// The stored `workflow` is a ready-to-PUT { context, profile? }. Merge its context
// over the live context (preserving fields it doesn't set) and its profile if any.
function applyStoredWorkflow(live, workflow) {
    live.context = { ...(live.context || {}), ...(workflow.context || {}) };
    if (workflow.profile) live.profile = workflow.profile;
}

// Legacy favourite (no `workflow`): copyMask-gated snapshot → context. Mirrors
// dashboard.ts applyAutoFavourite. Absent mask key ⇒ on.
function applyFavLegacy(live, fav) {
    const snp = fav.snapshot || {};
    const mask = fav.copyMask || {};
    const on = k => mask[k] !== false;
    const ctx = { ...(live.context || {}) };
    if (on('dose') && snp.dose != null) ctx.targetDoseWeight = snp.dose;
    if (on('drink') && snp.drink != null) ctx.targetYield = snp.drink;
    if (on('grindSetting')) {
        if (snp.grindSetting != null) ctx.grinderSetting = String(snp.grindSetting);
        if (snp.rpm != null) ctx.extras = { ...(ctx.extras || {}), rpm: snp.rpm };
    }
    if (on('grinder')) {
        if (snp.grinderId) ctx.grinderId = snp.grinderId;
        if (snp.grinderModel) ctx.grinderModel = snp.grinderModel;
    }
    if (on('beans')) {
        if (snp.beanBatchId) ctx.beanBatchId = snp.beanBatchId;
        if (snp.coffeeName) ctx.coffeeName = snp.coffeeName;
        if (snp.coffeeRoaster) ctx.coffeeRoaster = snp.coffeeRoaster;
    }
    if (on('roastDate') && snp.roastDate) ctx.roastDate = snp.roastDate;
    if (on('barista') && snp.barista) ctx.baristaName = snp.barista;
    if (on('drinker') && snp.drinker) ctx.drinkerName = snp.drinker;
    if (on('note') && snp.note) ctx.extras = { ...(ctx.extras || {}), note: snp.note };
    live.context = ctx;
    if (on('profile') && (snp.profileId || snp.profileTitle)) {
        live.profile = { id: snp.profileId, title: snp.profileTitle };
    }
}

// Legacy recipe (no `workflow`): dashboardVariables → context. Mirrors dashboard.ts
// applyRecipe (context portion; steam/hw/flush handled by mergeRecipeLiveSettings).
function applyRecipeLegacy(live, recipe) {
    const dv = recipe.dashboardVariables || {};
    const ctx = { ...(live.context || {}) };
    if (dv.dose != null) ctx.targetDoseWeight = dv.dose;
    if (dv.drink != null) ctx.targetYield = dv.drink;
    else if (dv.ratio != null && dv.dose != null) ctx.targetYield = Math.round(dv.dose * dv.ratio * 10) / 10;
    if (dv.grind != null) ctx.grinderSetting = String(dv.grind);
    if (dv.rpm != null) ctx.extras = { ...(ctx.extras || {}), rpm: dv.rpm };
    if (dv.grinderId) ctx.grinderId = dv.grinderId;
    if (recipe.barista) ctx.baristaName = recipe.barista;
    if (recipe.drinker) ctx.drinkerName = recipe.drinker;
    live.context = ctx;
    if (recipe.profileId || recipe.profileTitle) {
        live.profile = { id: recipe.profileId, title: recipe.profileTitle };
    }
}

// Override only the recipe's steam/hot-water/flush fields on the LIVE sub-objects
// (which already carry the required targetTemperature/flow). Guarded so we never
// send a partial. Identical to dashboard.ts applyRecipe.
function mergeRecipeLiveSettings(wf, dv) {
    if (wf.steamSettings && (dv.steamTimeS != null || dv.steamFlowMls != null)) {
        const ss = { ...wf.steamSettings };
        if (dv.steamMode === 'time' && dv.steamTimeS != null) ss.duration = dv.steamTimeS;
        if (dv.steamMode === 'flow' && dv.steamFlowMls != null) ss.flow = dv.steamFlowMls;
        wf.steamSettings = ss;
    }
    if (wf.hotWaterData && (dv.hotWaterMl != null || dv.hotWaterTempC != null)) {
        const hw = { ...wf.hotWaterData };
        if (dv.hotWaterMode === 'vol' && dv.hotWaterMl != null) hw.volume = dv.hotWaterMl;
        if (dv.hotWaterMode === 'temp' && dv.hotWaterTempC != null) hw.targetTemperature = dv.hotWaterTempC;
        wf.hotWaterData = hw;
    }
    if (wf.rinseData && dv.flushS != null) {
        wf.rinseData = { ...wf.rinseData, duration: dv.flushS };
    }
}

// Re-pull the workflow and update the left-rail controls — the same path used on
// initial load / after a profile change (window.loadInitialData is set by app.js).
async function refreshAfterApply() {
    try {
        if (typeof window.loadInitialData === 'function') {
            await window.loadInitialData();
            return;
        }
        const wf = await getWorkflow();
        applyWorkflowToMainPageUI(wf);
    } catch (e) {
        logger.error('dyeStrip refreshAfterApply failed', e);
    }
}

// ─── DYE2 page navigation (iframe overlay, same-origin) ────────────────────────
//
// In production reaprime serves the skin and the plugin from the same origin, so
// the DYE2 page can load in a same-origin <iframe> overlay and the parent can read
// iframe.contentWindow.location on `load` to detect the plugin returning. The DYE2
// pages honour a `?return=` param; we point it at a sentinel skin URL and close +
// refresh when the iframe navigates there.
//
// In dev the skin (:8000) and bridge (:8080) are cross-origin: X-Frame-Options
// SAMEORIGIN blocks the iframe and reading contentWindow.location throws, so we
// fall back to a full-page navigation with ?return set to this page.

function sentinelReturnUrl() {
    return `${window.location.origin}${window.location.pathname}?dyeReturn=1`;
}

function isSameOrigin(url) {
    try {
        return new URL(url, window.location.href).origin === window.location.origin;
    } catch (e) {
        return false;
    }
}

export function openPluginOverlay(page) {
    const pluginUrl = `${PLUGIN_BASE}/${page}`;
    const ret = sentinelReturnUrl();

    // Cross-origin (dev): iframe would be blocked → full-page navigation instead.
    if (!isSameOrigin(pluginUrl)) {
        window.location.href = `${pluginUrl}?return=${encodeURIComponent(window.location.href)}`;
        return;
    }

    let overlay = document.getElementById('dye-plugin-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dye-plugin-overlay';
        overlay.style.cssText =
            'position:fixed;inset:0;z-index:9999;background:var(--bgmain-color, #fff);display:flex;flex-direction:column;';
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;justify-content:flex-end;padding:8px 12px;background:var(--box-color,#f3f4f6);';
        const close = document.createElement('button');
        close.textContent = 'Close';
        close.style.cssText =
            'padding:8px 22px;border:2px solid var(--mimoja-blue);color:var(--mimoja-blue);border-radius:20px;font-weight:600;font-size:20px;cursor:pointer;';
        close.addEventListener('click', closePluginOverlay);
        bar.appendChild(close);
        const frame = document.createElement('iframe');
        frame.id = 'dye-plugin-frame';
        frame.style.cssText = 'flex:1;width:100%;border:0;';
        // Same-origin load handler: when the plugin navigates back to our sentinel
        // return URL, tear down the overlay and refresh the strip + controls.
        frame.addEventListener('load', () => {
            let href = '';
            try { href = frame.contentWindow.location.href; } catch (e) { return; } // cross-origin, ignore
            if (href.includes('dyeReturn=1')) closePluginOverlay(true);
        });
        overlay.appendChild(bar);
        overlay.appendChild(frame);
        document.body.appendChild(overlay);
    }
    const frame = document.getElementById('dye-plugin-frame');
    frame.src = `${pluginUrl}?return=${encodeURIComponent(ret)}`;
    overlay.style.display = 'flex';
}

function closePluginOverlay(refresh) {
    const overlay = document.getElementById('dye-plugin-overlay');
    if (overlay) overlay.style.display = 'none';
    if (refresh) {
        // DYE2 may have applied a fav/recipe or edited the collections while open.
        loadDyeStripData().then(() => { if (currentMode !== 'P') renderStrip(currentMode); }).catch(() => {});
        refreshAfterApply();
    }
}

// ─── Plugin install / version state ───────────────────────────────────────────
//
// Streamline is a read-only consumer of DYE2's KV contract, so an outdated plugin
// shows up here as missing keys / empty strips rather than an error. Decaid owns
// distribution now: it records where dye2.reaplugin came from and installs new
// releases itself, holding back only updates that ask for new permissions (those
// surface as pendingUpdate on GET /plugins). So there is nothing to nag about —
// Streamline just reads the bridge and never talks to GitHub.
//
// Dialogs here are inline-styled like openPluginOverlay's overlay, not Tailwind:
// any new utility class would need a CSS rebuild to exist in app.css (see CLAUDE.md).

// ponytail: numeric compare only — dye2 tags are plain vMAJOR.MINOR.PATCH. If it
// ever ships `-beta` tags, borrow settings.js's compareVersions, which orders them.
function isOlderVersion(a, b) {
    const nums = (v) => String(v || '').trim().replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const x = nums(a), y = nums(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d !== 0) return d < 0;
    }
    return false;
}

// ─── Enable-time plugin requirement gate ────────────────────────────────────
// Toggling DYE2 on in Settings requires the plugin actually installed, loaded,
// and at least MIN_PLUGIN_VERSION — otherwise the header lights up with no data
// behind it. This floor is about the KV contract, not about being current: Decaid
// keeps the plugin up to date on its own, so bump it only when the contract moves.
const MIN_PLUGIN_VERSION = '0.1.4';

export async function checkDye2PluginRequirement() {
    const plugins = await getPlugins();
    if (!plugins) return { ok: false, reason: 'unreachable' };
    const plugin = plugins.find(p => p?.id === PLUGIN_ID);
    if (!plugin) return { ok: false, reason: 'missing' };
    if (!plugin.loaded) return { ok: false, reason: 'not-loaded', installed: plugin.version };
    if (isOlderVersion(plugin.version, MIN_PLUGIN_VERSION)) return { ok: false, reason: 'outdated', installed: plugin.version };
    return { ok: true, installed: plugin.version };
}

// Resolves true once the plugin is installed, loaded and at the required floor —
// so the Settings toggle can go on — and false if the user backed out or the
// install failed. Decaid installs plugins itself now (POST
// /plugins/install/github-release), so "missing" and "outdated" are one button,
// not a download-and-sideload errand; the releases page stays as the fallback for
// when that call fails (offline, GitHub down, a release with no single zip).
function promptPluginRequired(reason, installed) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.id = 'dye2-required-dialog';
        dlg.style.cssText =
            'border:0;border-radius:24px;padding:0;background:transparent;color:var(--text-primary);';
        const body = {
            missing: `The DYE2 plugin isn't installed (need v${MIN_PLUGIN_VERSION}+). Install it from ${PLUGIN_REPO} and it will be enabled for you.`,
            'not-loaded': `The DYE2 plugin (v${installed || '?'}) is installed but not loaded. Open Decaid's Plugin settings and enable it, then come back and turn DYE2 on again.`,
            outdated: `Installed DYE2 plugin is v${installed}, older than the required v${MIN_PLUGIN_VERSION}. Install the current release to continue.`,
            unreachable: `Couldn't reach the plugin bridge to verify DYE2 is installed. Check the connection and try again.`,
        }[reason] || `DYE2 plugin v${MIN_PLUGIN_VERSION}+ is required to enable this.`;
        // Only missing/outdated are fixable from here. "not-loaded" needs a human in
        // Decaid's plugin settings and "unreachable" has no bridge to install through.
        const canInstall = reason === 'missing' || reason === 'outdated';
        dlg.innerHTML = `
            <div style="background:var(--bgmain-color,#fff);border-radius:24px;padding:36px 40px;max-width:640px;display:flex;flex-direction:column;gap:18px;">
                <div style="font-size:30px;font-weight:700;color:var(--mimoja-blue);">DYE2 plugin required</div>
                <div id="dye2-required-body" style="font-size:23px;line-height:1.4;">${body}</div>
                <div style="display:flex;justify-content:flex-end;gap:14px;padding-top:6px;">
                    <button id="dye2-required-cancel" style="padding:10px 26px;border:2px solid var(--mimoja-blue);background:transparent;color:var(--mimoja-blue);border-radius:20px;font-size:22px;font-weight:600;cursor:pointer;">${canInstall ? 'Cancel' : 'OK'}</button>
                    ${canInstall ? `<button id="dye2-required-install" style="padding:10px 26px;border:0;background:var(--mimoja-blue);color:#fff;border-radius:20px;font-size:22px;font-weight:600;cursor:pointer;">Install</button>` : ''}
                </div>
            </div>`;
        document.body.appendChild(dlg);

        const close = (ok) => { dlg.close(); dlg.remove(); resolve(ok); };
        dlg.querySelector('#dye2-required-cancel').addEventListener('click', () => close(false));

        const installBtn = dlg.querySelector('#dye2-required-install');
        installBtn?.addEventListener('click', async () => {
            const text = dlg.querySelector('#dye2-required-body');
            installBtn.disabled = true;
            installBtn.textContent = 'Installing…';
            try {
                await installDye2Plugin();
                const recheck = await checkDye2PluginRequirement();
                if (recheck.ok) { close(true); return; }
                text.textContent = `Installed v${recheck.installed || '?'}, but it still isn't usable (${recheck.reason}). Open Decaid's Plugin settings to finish enabling it.`;
                installBtn.remove();
                dlg.querySelector('#dye2-required-cancel').textContent = 'OK';
            } catch (e) {
                logger.error('dyeStrip: DYE2 install failed', e);
                // textContent, not innerHTML: the message is a server/network error string.
                text.textContent = `Install failed: ${e.message || e}. You can install the zip by hand from the releases page instead.`;
                installBtn.disabled = false;
                installBtn.textContent = 'Releases';
                installBtn.replaceWith(installBtn.cloneNode(true)); // drop this handler
                dlg.querySelector('#dye2-required-install').addEventListener('click', () => {
                    close(false);
                    // Same-frame nav, no _blank/window.open: in the tablet webview the
                    // host intercepts the external URL and hands it to the OS browser.
                    window.location.href = PLUGIN_RELEASES_PAGE;
                });
            }
        });
        dlg.showModal();
    });
}

// Called from the Settings toggle before flipping DYE2 on. Prompts and returns
// false if the plugin isn't ready; the caller should leave the toggle off.
export async function ensureDye2PluginReady() {
    const check = await checkDye2PluginRequirement();
    if (check.ok) return true;
    // The prompt can fix "missing"/"outdated" in place, so its result — not the
    // original check — decides whether the toggle may go on.
    return promptPluginRequired(check.reason, check.installed);
}

// Everything the Settings → DYE2 card needs, straight off the bridge:
// GET /plugins carries the installed version, the recorded `source` and, when an
// update was held back for asking new permissions, `pendingUpdate`. An
// unreachable bridge is reported as such rather than guessed at.
export async function getDye2VersionInfo() {
    const plugins = await getPlugins().catch(() => null);
    if (!plugins) return { reachable: false, installed: null, loaded: false, source: null, pending: null };
    const plugin = plugins.find(p => p?.id === PLUGIN_ID);
    return {
        reachable: true,
        installed: plugin?.version || null,
        loaded: !!plugin?.loaded,
        source: plugin?.source || null,
        pending: plugin?.pendingUpdate || null,
    };
}

// Install from the canonical repo's latest release and enable it. Decaid installs
// plugins with auto-load off, so the enable call is what actually starts it and
// makes it load on the next app start.
export async function installDye2Plugin() {
    const result = await installPluginFromRelease(PLUGIN_REPO);
    await enablePlugin(PLUGIN_ID);
    logger.info(`dyeStrip: installed ${PLUGIN_ID} v${result?.version || '?'} from ${PLUGIN_REPO}`);
    return result;
}

const CHECK_COOLDOWN_MS = 15 * 60 * 1000; // see checkDye2UpdatesIfDue

// Ask Decaid to compare the installed copy against the release its recorded
// source points at. An update that asks for no new permission is downloaded AND
// installed inside this call — Decaid restarts the plugin on it — so afterwards
// the bridge already reports the new version. One that asks for more becomes a
// pendingUpdate that only an explicit approval installs.
//
// Decaid queries api.github.com unauthenticated: 60 requests an hour for the
// whole tablet, shared with its own periodic check and with skin updates. Past
// that GitHub answers 403 and the check records a lastError instead of an answer.
// Opening a settings page or flipping a toggle is something a user can do
// repeatedly, so honour the recorded lastChecked and skip a check that would only
// re-ask a question Decaid asked minutes ago. Anything an earlier check already
// found is still on the bridge to read.
//
// Returns the state after the check. Never throws: a failed check (offline,
// GitHub down, rate-limited) leaves the installed plugin working and untouched.
export async function checkDye2UpdatesIfDue() {
    const before = await getDye2VersionInfo();
    // An untracked copy (local ZIP or folder) has no source to check against, and
    // updateAllPlugins skips it anyway.
    if (!before.reachable || !before.installed || !before.source) return before;

    const lastChecked = Date.parse(before.source.lastChecked || '');
    if (Number.isFinite(lastChecked) && Date.now() - lastChecked < CHECK_COOLDOWN_MS) return before;

    try {
        await checkPluginUpdates();
    } catch (e) {
        logger.info(`dyeStrip: update check failed (${e.message || e})`);
    }
    const after = await getDye2VersionInfo();
    if (after.installed && after.installed !== before.installed) {
        logger.info(`dyeStrip: DYE2 updated v${before.installed} -> v${after.installed}`);
    }
    return after;
}

// Called after the DYE2 toggle goes on. Same check, plus the prompt: an update
// held back for asking new permissions is the one thing that needs a decision,
// and the toggle is where the user is looking. Resolves true if the plugin ended
// up on a new version, either because Decaid installed it or because the user
// approved the escalating one.
//
// Never blocks the toggle: the requirement gate already established the plugin is
// usable, so nothing here can leave DYE2 off.
export async function offerDye2Update() {
    const before = await getDye2VersionInfo();
    const after = await checkDye2UpdatesIfDue();
    if (after.installed && after.installed !== before.installed) return true;
    if (after.pending) return promptPluginUpdate(after);
    return false;
}

// Resolves true if the update was installed. The added permissions are listed
// verbatim: approving is consent to those, not to "an update", so nothing here
// approves on the user's behalf.
function promptPluginUpdate(info) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.id = 'dye2-update-dialog';
        dlg.style.cssText =
            'border:0;border-radius:24px;padding:0;background:transparent;color:var(--text-primary);';
        const permissions = (info.pending.addedPermissions || []).join(', ') || 'none listed';
        dlg.innerHTML = `
            <div style="background:var(--bgmain-color,#fff);border-radius:24px;padding:36px 40px;max-width:640px;display:flex;flex-direction:column;gap:18px;">
                <div style="font-size:30px;font-weight:700;color:var(--mimoja-blue);">DYE2 update available</div>
                <div id="dye2-update-body" style="font-size:23px;line-height:1.4;">
                    Installed <b>v${info.installed}</b>, available <b>v${info.pending.version}</b>.
                    It asks for permissions the installed version does not have:
                    <b>${permissions}</b>. Update only if you trust this.
                </div>
                <div style="display:flex;justify-content:flex-end;gap:14px;padding-top:6px;">
                    <button id="dye2-update-later" style="padding:10px 26px;border:2px solid var(--mimoja-blue);background:transparent;color:var(--mimoja-blue);border-radius:20px;font-size:22px;font-weight:600;cursor:pointer;">Later</button>
                    <button id="dye2-update-now" style="padding:10px 26px;border:0;background:var(--mimoja-blue);color:#fff;border-radius:20px;font-size:22px;font-weight:600;cursor:pointer;">Update</button>
                </div>
            </div>`;
        document.body.appendChild(dlg);

        const close = (updated) => { dlg.close(); dlg.remove(); resolve(updated); };
        dlg.querySelector('#dye2-update-later').addEventListener('click', () => close(false));

        const updateBtn = dlg.querySelector('#dye2-update-now');
        updateBtn.addEventListener('click', async () => {
            const text = dlg.querySelector('#dye2-update-body');
            updateBtn.disabled = true;
            updateBtn.textContent = 'Updating…';
            try {
                const result = await approvePluginUpdate(PLUGIN_ID);
                logger.info(`dyeStrip: DYE2 approved and updated to v${result?.version || '?'}`);
                close(true);
            } catch (e) {
                // 409: the release moved after this permission delta was shown. Decaid
                // has recorded the new candidate, so the fresh delta has to be reviewed
                // — retrying this call would only 409 again.
                text.textContent = e.status === 409
                    ? 'The update changed since it was shown. Open Settings → Extensions to review the new one.'
                    : `Update failed: ${e.message || e}`;
                if (e.status !== 409) logger.error('dyeStrip: DYE2 update approval failed', e);
                updateBtn.remove();
                dlg.querySelector('#dye2-update-later').textContent = 'OK';
            }
        });
        dlg.showModal();
    });
}

// ─── Toggle + init ─────────────────────────────────────────────────────────────

export function setStripMode(mode) {
    currentMode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* private mode */ }

    // Active pill styling.
    ['P', 'F', 'R'].forEach(m => {
        const pill = document.getElementById(`dye-toggle-${m}`);
        if (!pill) return;
        const active = m === mode;
        pill.classList.toggle('bg-[var(--mimoja-blue-v2)]', active);
        pill.classList.toggle('text-white', active);
        pill.classList.toggle('text-[var(--mimoja-blue)]', !active);
        pill.classList.toggle('bg-[var(--box-color)]', !active);
    });

    // Visibility via inline display (a Tailwind `flex` utility overrides [hidden]).
    const profileNav = document.getElementById('profile-fav-nav');
    const dyeStrip = document.getElementById('dye-strip');
    if (mode === 'P') {
        if (profileNav) profileNav.style.display = '';
        if (dyeStrip) dyeStrip.style.display = 'none';
    } else {
        if (profileNav) profileNav.style.display = 'none';
        if (dyeStrip) dyeStrip.style.display = '';
        renderStrip(mode);
    }
}

// ─── Header collision guard ──────────────────────────────────────────────────
// The favourite strip and the right-hand controls are both absolutely positioned,
// so neither pushes the other out of the way. With DYE2 on the strip starts 50px
// further right and the DYE button widens the controls; add the Bengle cup warmer
// and the five 240px cells run underneath them. Bound the strips at the controls'
// measured edge and let the cells shrink into what is left — measured rather than
// hardcoded so it follows cup-warmer/fullscreen visibility and translated labels.
const STRIP_GAP = 20;
const STRIP_IDS = ['profile-fav-nav', 'dye-strip'];
let controlsObserver = null;

function syncStripBounds() {
    const controls = document.getElementById('header-right-controls');
    const header = controls?.closest('header');
    if (!controls || !header) return;
    const right = header.getBoundingClientRect().right
        - controls.getBoundingClientRect().left + STRIP_GAP;
    STRIP_IDS.forEach(id => {
        const nav = document.getElementById(id);
        if (!nav) return;
        nav.style.right = `${Math.max(0, Math.round(right))}px`;
        fitStripCells(nav); // narrower cells wrap more, so the fit has to be redone
    });
}

// The controls resize when the cup warmer or fullscreen button shows/hides and when
// data-fit-text refits a translated label. Width is anchored to the header's right
// edge, so a plain window resize needs no handling.
function observeControls() {
    if (controlsObserver || typeof ResizeObserver === 'undefined') return;
    const controls = document.getElementById('header-right-controls');
    if (!controls) return;
    controlsObserver = new ResizeObserver(() => syncStripBounds());
    controlsObserver.observe(controls);
}

function clearStripBounds() {
    controlsObserver?.disconnect();
    controlsObserver = null;
    STRIP_IDS.forEach(id => {
        const nav = document.getElementById(id);
        if (!nav) return;
        nav.style.right = '';
        fitStripCells(nav); // cells are back to full width — labels can grow again
    });
}

// ─── Master enable/disable (gates the whole DYE2 header UI) ─────────────────────

export function isDye2Enabled() {
    try { return localStorage.getItem(ENABLED_KEY) === 'true'; } catch (e) { return false; }
}

let wired = false; // one-time listener wiring, so re-enabling doesn't double-bind

function wireOnce() {
    if (wired) return;
    wired = true;
    ['P', 'F', 'R'].forEach(m => {
        const pill = document.getElementById(`dye-toggle-${m}`);
        if (pill) pill.addEventListener('click', () => setStripMode(m));
    });
    const dyeBtn = document.getElementById('dye-open-btn');
    if (dyeBtn) dyeBtn.addEventListener('click', () => openPluginOverlay('dashboard'));

    // No push channel for the KV store — re-poll on focus / tab visibility so edits
    // DYE2 made while Streamline was idle appear (KV_CONTRACT "Freshness").
    const repoll = () => {
        if (document.hidden || !isDye2Enabled()) return;
        loadDyeStripData().then(() => { if (currentMode !== 'P') renderStrip(currentMode); }).catch(() => {});
    };
    window.addEventListener('focus', repoll);
    document.addEventListener('visibilitychange', repoll);
    // The DYE button is a same-frame top-level nav away to the DYE2 plugin (see
    // openPluginOverlay); returning via the browser Back button restores this page
    // from bfcache — a frozen pre-edit snapshot that fires `pageshow` (persisted),
    // not focus/visibilitychange. Mirrors profile_selector.js's plugin-return guard.
    // getDye2KvArray coerces a fetch error to [] (its own bridge-quirk handling), so
    // a transient failure isn't visible as a rejection here — a fetch fired right as
    // the browser wakes the network stack back up from bfcache can intermittently
    // fail and get read as "no favourites". Retry once shortly after to cover that.
    window.addEventListener('pageshow', () => { repoll(); setTimeout(repoll, 500); });
}

// Reveal the DYE2 UI: shift the profile nav right to make room, show the toggle +
// DYE button, wire listeners, load KV data, restore the saved P/F/R mode.
export async function enableDye2Ui() {
    const profileNav = document.getElementById('profile-fav-nav');
    const toggle = document.getElementById('dye-strip-toggle');
    const dyeBtn = document.getElementById('dye-open-btn');
    if (profileNav) { profileNav.classList.remove('left-[30px]'); profileNav.classList.add('left-[80px]'); }
    if (toggle) toggle.style.display = '';   // revert to class-defined flex
    if (dyeBtn) dyeBtn.style.display = '';
    syncStripBounds();
    observeControls();
    wireOnce();
    try { await loadDyeStripData(); } catch (e) { logger.error('dyeStrip load failed', e); }
    let saved = 'P';
    try { saved = localStorage.getItem(MODE_KEY) || 'P'; } catch (e) { /* private mode */ }
    setStripMode(saved);
}

// Restore the stock header: hide the toggle + DYE button + strip and move the
// profile nav back to its original position (byte-identical to stock Streamline).
export function disableDye2Ui() {
    const profileNav = document.getElementById('profile-fav-nav');
    const toggle = document.getElementById('dye-strip-toggle');
    const dyeBtn = document.getElementById('dye-open-btn');
    const dyeStrip = document.getElementById('dye-strip');
    if (toggle) toggle.style.display = 'none';
    if (dyeBtn) dyeBtn.style.display = 'none';
    if (dyeStrip) { dyeStrip.style.display = 'none'; dyeStrip.innerHTML = ''; }
    if (profileNav) {
        profileNav.style.display = '';
        profileNav.classList.remove('left-[80px]');
        profileNav.classList.add('left-[30px]');
    }
    clearStripBounds();
}

export async function initDyeStrip() {
    // Bridge for the Extensions-settings toggle to flip the header live (the header
    // stays in the DOM behind the settings overlay); if it isn't present the flag
    // still applies on the next dashboard load.
    window.applyDye2Enabled = (on) => { on ? enableDye2Ui() : disableDye2Ui(); };

    if (isDye2Enabled()) await enableDye2Ui();
    else disableDye2Ui();
}
