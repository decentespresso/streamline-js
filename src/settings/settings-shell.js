import * as ui from '../modules/ui.js';
import { getTranslation, translatePage } from '../modules/i18n.js';
import { loadPage } from '../modules/router.js';
import { isBengleMachine } from '../modules/machine.js';
import { readSettingsLocation, writeSettingsLocation } from './settings-location.js';
import {
    getSnapshot,
    resetSettingsSession,
    saveSettingsData,
    startSettingsData
} from './settings-data.js';
import { SETTINGS_TREE as CANONICAL_SETTINGS_TREE } from './settings-tree.js';

// [name, category, bengleOnly?] tuples for the pre-legacy-load nav and search,
// derived from the canonical tree (settings-tree.js) so the two can't drift —
// name matches what translatePage() will show: i18nKey when set, else the
// (prefix-stripped) name, since data-i18n-key is what actually drives the text.
const SETTINGS_TREE = Object.freeze(
    Object.fromEntries(Object.entries(CANONICAL_SETTINGS_TREE).map(([mainCategory, category]) => [
        mainCategory,
        Object.freeze(category.subcategories.map(sub => {
            const prefix = sub.name.match(/^(\d+\.\s*)/)?.[0] || '';
            const name = prefix + (sub.i18nKey || sub.name.slice(prefix.length));
            return Object.freeze(sub.bengleOnly ? [name, sub.settingsCategory, true] : [name, sub.settingsCategory]);
        }))
    ]))
);

const CATEGORY_LOADERS = Object.freeze({
    quickadjustments: () => import('./categories/quick-adjustments.js'),
    bluetooth: () => import('./categories/legacy-category.js'),
    calibration: () => import('./categories/legacy-category.js'),
    machine: () => import('./categories/legacy-category.js'),
    maintenance: () => import('./categories/maintenance.js'),
    skin: () => import('./categories/legacy-category.js'),
    language: () => import('./categories/legacy-category.js'),
    extensions: () => import('./categories/legacy-category.js'),
    miscellaneous: () => import('./categories/legacy-category.js'),
    updates: () => import('./categories/legacy-category.js'),
    usermanual: () => import('./categories/legacy-category.js')
});

let currentRoot = null;
let currentCleanup = null;
let activeMainCategory = 'quickadjustments';
let renderSequence = 0;
let legacyMounted = false;
let searchTimer = null;
let searchScrollTop = 0;
let searchActive = false;

// Warm the sensor calibration read the moment Settings is reached, not when
// the user opens Sensor Calibration -- so the table usually already has
// values instead of a loading flash. Mirrors prefetchSettingsPage() in
// router.js: a background, fire-and-forget dynamic import plus one narrow
// call, not a blocking part of the shell's own mount. warmSensorCalibration()
// owns its own re-entry gate (the same shouldStartSensorCalLoad the page's
// own read uses), so this is safe to call once per shell mount without any
// guard here.
function warmSensorCalibrationInBackground() {
    import('./settings.js')
        .then(module => module.warmSensorCalibration())
        .catch(() => {});
}

function setActive(buttons, activeButton) {
    buttons.forEach(button => {
        const active = button === activeButton;
        button.classList.toggle('text-white', active);
        button.classList.toggle('bg-[#2c4a7a]', active);
        button.classList.toggle('text-[#959595]', !active);
    });
}

function availableSubcategories(mainCategory) {
    return (SETTINGS_TREE[mainCategory] || []).filter(([, , bengleOnly]) => !bengleOnly || isBengleMachine());
}

function renderSubcategories(mainCategory) {
    const panel = document.getElementById('sub-categories-panel');
    if (!panel) return;
    const items = availableSubcategories(mainCategory);
    panel.innerHTML = `<ul class="space-y-1">${items.map(([name, category]) => {
        const prefix = name.match(/^(\d+\.\s*)/)?.[1] || '';
        const label = prefix ? name.slice(prefix.length) : name;
        return `<li><button class="settings-subnav-btn w-full text-left px-4 py-3 rounded-lg text-[24px] text-[#959595] hover:text-white hover:bg-[#2c4a7a] flex items-center" data-category="${category}">${prefix}<span data-i18n-key="${label}">${label}</span></button></li>`;
    }).join('')}</ul>`;
    translatePage();
}

function renderSkeleton() {
    const content = document.getElementById('settings-content-area');
    if (!content) return null;
    content.innerHTML = `
        <div class="flex flex-col gap-[28px] w-full" role="status" aria-busy="true">
            <div class="h-[44px] w-[42%] mx-auto rounded-[6px] bg-[var(--profile-button-background-color)]"></div>
            <div class="h-px w-full bg-[var(--border-color)]"></div>
            <div class="h-[190px] w-[590px] mx-auto rounded-[6px] bg-[var(--profile-button-background-color)]"></div>
            <div class="h-[190px] w-[590px] mx-auto rounded-[6px] bg-[var(--profile-button-background-color)]"></div>
            <span class="sr-only">Loading settings</span>
        </div>`;
    return content;
}

async function renderCategory(mainCategory, category) {
    activeMainCategory = mainCategory;
    currentCleanup?.();
    currentCleanup = null;
    const content = renderSkeleton();
    if (!content) return;
    const sequence = ++renderSequence;
    try {
        const module = await CATEGORY_LOADERS[mainCategory]();
        if (sequence !== renderSequence) return;
        currentCleanup = await module.mountSettingsCategory({
            container: content,
            mainCategory,
            category,
            activateLegacy: () => {
                legacyMounted = true;
            }
        });
    } catch (error) {
        if (sequence !== renderSequence) return;
        content.innerHTML = `<div class="flex flex-col items-center justify-center h-full gap-[24px]" role="alert"><p class="text-red-500 text-[24px]">Failed to load settings</p><button type="button" data-retry-category class="bg-[#385a92] h-[72px] px-[48px] rounded-[10px] text-white text-[24px] font-bold">Retry</button></div>`;
        content.querySelector('[data-retry-category]')?.addEventListener('click', () => renderCategory(mainCategory, category), { once: true });
    }
}

function selectMainCategory(button, requestedCategory = null) {
    const mainCategory = button.id.replace(/-btn$/, '').replaceAll('-', '');
    activeMainCategory = mainCategory;
    setActive(Array.from(document.querySelectorAll('.settings-nav-btn')), button);
    renderSubcategories(mainCategory);
    const subcategories = Array.from(document.querySelectorAll('#sub-categories-panel .settings-subnav-btn'));
    const target = subcategories.find(item => item.dataset.category === requestedCategory) || subcategories[0];
    if (target) {
        target.click();
    } else {
        const content = document.getElementById('settings-content-area');
        if (content) content.innerHTML = '<div class="flex items-center justify-center h-full text-[28px] text-[var(--text-primary)]">No matching settings</div>';
    }
}

function clearSearchResults() {
    clearTimeout(searchTimer);
    searchTimer = null;
    const panel = document.getElementById('sub-categories-panel');
    const results = panel?.querySelector('[data-settings-search-results]');
    if (!panel || !results || !searchActive) return;
    results.hidden = true;
    results.replaceChildren();
    Array.from(panel.children).forEach(child => {
        if (child !== results) child.hidden = false;
    });
    panel.scrollTop = searchScrollTop;
    searchActive = false;
}

function renderSearchResults(searchTerm) {
    const panel = document.getElementById('sub-categories-panel');
    if (!panel) return;
    let results = panel.querySelector('[data-settings-search-results]');
    if (!results) {
        results = document.createElement('div');
        results.dataset.settingsSearchResults = '';
        results.className = 'flex flex-col gap-[8px]';
        panel.appendChild(results);
    }
    if (!searchActive) {
        searchScrollTop = panel.scrollTop;
        Array.from(panel.children).forEach(child => {
            if (child !== results) child.hidden = true;
        });
        searchActive = true;
    }

    const term = searchTerm.toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    Object.keys(SETTINGS_TREE).forEach(mainCategory => {
        const mainButton = document.getElementById(`${mainCategory}-btn`);
        const mainLabel = mainButton?.querySelector('span')?.textContent?.trim() || mainCategory;
        const mainSourceLabel = mainButton?.querySelector('span')?.dataset.i18nKey || mainCategory;
        const mainMatches = mainLabel.toLocaleLowerCase().includes(term)
            || mainSourceLabel.toLocaleLowerCase().includes(term);
        availableSubcategories(mainCategory).forEach(([name, category]) => {
            const sourceLabel = name.replace(/^\d+\.\s*/, '');
            const label = getTranslation(sourceLabel);
            if (!mainMatches
                && !sourceLabel.toLocaleLowerCase().includes(term)
                && !label.toLocaleLowerCase().includes(term)) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'settings-search-result w-full text-left px-4 py-3 rounded-lg text-[22px] text-[var(--text-primary)] hover:bg-[#2c4a7a] hover:text-white flex items-center gap-[10px]';
            button.dataset.mainCategory = mainCategory;
            button.dataset.category = category;
            button.textContent = `${mainLabel} \u203a ${label}`;
            fragment.appendChild(button);
        });
    });
    if (!fragment.childNodes.length) {
        const empty = document.createElement('p');
        empty.className = 'p-4 text-center text-[22px] text-[var(--text-primary)] opacity-60';
        empty.textContent = getTranslation('No settings match your search');
        fragment.appendChild(empty);
    }
    results.replaceChildren(fragment);
    results.hidden = false;
    panel.scrollTop = 0;
}

function bindShell(root) {
    root.addEventListener('click', event => {
        if (legacyMounted) return;
        const searchResult = event.target.closest('.settings-search-result');
        if (searchResult) {
            const searchInput = document.getElementById('settings-search');
            if (searchInput) searchInput.value = '';
            clearSearchResults();
            const mainButton = document.getElementById(`${searchResult.dataset.mainCategory}-btn`);
            if (mainButton) selectMainCategory(mainButton, searchResult.dataset.category);
            return;
        }
        const mainButton = event.target.closest('.settings-nav-btn');
        if (mainButton) {
            selectMainCategory(mainButton);
            return;
        }
        const subButton = event.target.closest('.settings-subnav-btn');
        if (subButton) {
            setActive(Array.from(document.querySelectorAll('.settings-subnav-btn')), subButton);
            writeSettingsLocation(activeMainCategory, subButton.dataset.category);
            renderCategory(activeMainCategory, subButton.dataset.category);
        }
    });

    const searchInput = document.getElementById('settings-search');
    searchInput?.addEventListener('input', event => {
        if (legacyMounted) return;
        const term = event.target.value.trim().toLocaleLowerCase();
        clearTimeout(searchTimer);
        if (!term) {
            clearSearchResults();
            return;
        }
        searchTimer = setTimeout(() => renderSearchResults(term), 125);
    });
    searchInput?.addEventListener('keydown', event => {
        if (legacyMounted || event.key !== 'Enter') return;
        event.preventDefault();
        const term = event.currentTarget.value.trim();
        if (term) renderSearchResults(term);
        document.querySelector('[data-settings-search-results] .settings-search-result')?.click();
        event.currentTarget.blur();
    });

    document.getElementById('cancel-settings-btn')?.addEventListener('click', () => {
        if (legacyMounted) return;
        clearSearchResults();
        resetSettingsSession();
        loadPage('index.html');
    });

    document.getElementById('save-settings-btn')?.addEventListener('click', async () => {
        if (legacyMounted) return;
        try {
            await saveSettingsData();
            if (getSnapshot().dirty) return;
            ui.showToast('Settings updated', 3000, 'success');
            loadPage('index.html');
        } catch (error) {
            ui.showToast(`Failed to save settings: ${error.message}`, 5000, 'error');
        }
    });
}

// Drag-to-resize for a vertical separator: dragging moves `resizedPanel`'s
// right edge, clamped to [min, max]. Shared by the two page-shell dividers
// (main-nav/sub-nav, and left-panel/content) — shell-owned chrome, wired once
// per settings-page mount so it works no matter which category is active,
// unlike the old per-category legacy-only wiring it replaces.
function makeResizableSeparator(separator, resizedPanel, min, max) {
    if (!separator || !resizedPanel) return;
    let isDragging = false;

    function thicken() { separator.classList.remove('w-px'); separator.classList.add('w-2'); }
    function restore() { separator.classList.remove('w-2'); separator.classList.add('w-px'); }

    function beginDrag(clientX) {
        isDragging = true;
        thicken();
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const startX = clientX;
        const startWidth = resizedPanel.offsetWidth;
        const upperBound = typeof max === 'function' ? max() : max;

        function applyDelta(cx) {
            if (!isDragging) return;
            const newWidth = startWidth + (cx - startX);
            if (newWidth > min && newWidth < upperBound) resizedPanel.style.width = `${newWidth}px`;
        }

        function onMouseMove(e) { applyDelta(e.clientX); }
        function onTouchMove(e) {
            if (e.touches[0]) { applyDelta(e.touches[0].clientX); e.preventDefault(); }
        }
        function stopDrag() {
            isDragging = false;
            restore();
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', stopDrag);
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', stopDrag);
            document.removeEventListener('touchcancel', stopDrag);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('touchcancel', stopDrag);
    }

    separator.addEventListener('mousedown', e => beginDrag(e.clientX));
    separator.addEventListener('touchstart', e => { if (e.touches[0]) beginDrag(e.touches[0].clientX); }, { passive: true });
}

function initResizableSeparators() {
    const subSeparator = document.getElementById('sub-categories-separator');
    makeResizableSeparator(
        subSeparator,
        document.getElementById('main-categories-panel'),
        150,
        () => (subSeparator.parentElement.offsetWidth - 150)
    );
    makeResizableSeparator(
        document.getElementById('separator'),
        document.getElementById('left-panel'),
        200,
        1600
    );
}

export async function initializeSettingsShell() {
    const root = document.getElementById('settings-body')?.parentElement;
    if (!root || root === currentRoot) return;
    currentCleanup?.();
    currentRoot = root;
    currentCleanup = null;
    activeMainCategory = 'quickadjustments';
    legacyMounted = false;
    clearTimeout(searchTimer);
    searchTimer = null;
    searchScrollTop = 0;
    searchActive = false;
    resetSettingsSession();
    startSettingsData();
    warmSensorCalibrationInBackground();
    bindShell(root);
    initResizableSeparators();
    const saved = readSettingsLocation();
    const first = document.getElementById(`${saved?.mainCategory || 'quickadjustments'}-btn`)
        || document.querySelector('.settings-nav-btn');
    if (first) selectMainCategory(first, saved?.category);
    translatePage();
}

export function cleanupSettingsShell() {
    currentCleanup?.();
    currentCleanup = null;
    currentRoot = null;
    legacyMounted = false;
    renderSequence += 1;
    clearTimeout(searchTimer);
    searchTimer = null;
    resetSettingsSession();
}
