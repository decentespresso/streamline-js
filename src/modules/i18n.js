import { logger } from './logger.js';
import { openDB, getSetting, setSetting } from './idb.js';
import { SUPPORTED_LANGUAGES, parseTranslationColumn } from './i18n-parser.js';
import { APP_VERSION } from '../version.js';

let translations = {};
let keyIndex = {};
let loadedLanguage = 'en';
let translationCsvPromise = null;
export const supportedLanguages = SUPPORTED_LANGUAGES;
export let currentLanguage = 'en';

function clearTranslations() {
    translations = {};
    keyIndex = {};
    loadedLanguage = 'en';
}

function getTranslationCsv() {
    if (!translationCsvPromise) {
        translationCsvPromise = fetch('src/ui/de1 gui translation - Sheet1.csv', { cache: 'no-cache' }).then(async response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.text();
        }).catch(error => {
            translationCsvPromise = null;
            throw error;
        });
    }
    return translationCsvPromise;
}

async function loadTranslations(language) {
    if (language === 'en') {
        clearTranslations();
        return;
    }
    if (loadedLanguage === language) return;
    const cacheKey = `translations:${APP_VERSION}:${language}`;
    let parsed;
    try {
        await openDB();
        parsed = await getSetting(cacheKey);
    } catch (_) {}
    if (!parsed?.table || !parsed?.keyIndex) {
        parsed = parseTranslationColumn(await getTranslationCsv(), language);
        setSetting(cacheKey, parsed).catch(() => {});
    }
    translations = parsed.table;
    keyIndex = parsed.keyIndex;
    loadedLanguage = language;
    logger.info(`Translations loaded for language: ${language}`);
}

function findSupportedLanguage(language) {
    const normalized = String(language || '').toLowerCase();
    if (supportedLanguages.includes(normalized)) return normalized;
    const base = normalized.split('-')[0];
    return supportedLanguages.includes(base) ? base : null;
}

/**
 * Translates all elements on the page with a `data-i18n-key` attribute.
 */
export function translatePage() {
    document.querySelectorAll('[data-i18n-key]').forEach(element => {
        const key = element.getAttribute('data-i18n-key');
        element.textContent = getTranslation(key);
    });
    fitAllText();
    fitTelemetry();
    // The header buttons are laid out with the custom Inter font; if it hasn't
    // finished loading yet the first fit measures against a fallback (or a
    // not-yet-sized box) and mis-shrinks. Re-fit once fonts are ready.
    if (document.fonts && document.fonts.status !== 'loaded') {
        document.fonts.ready.then(() => { fitAllText(); fitTelemetry(); });
    }
}

// Scale the machine-telemetry row down so long-language rows (e.g. German:
// "Mischwasser … Gewicht 65.0g") stay on ONE line instead of wrapping. The row
// is nowrap; we measure its natural one-line width and, if it exceeds the space
// available (which shrinks when the GHC column is shown), apply transform:scale.
let _telemetryObserved = false;
export function fitTelemetry() {
    const row = document.getElementById('telemetry-row');
    if (!row) return;
    row.style.transformOrigin = 'left center';
    row.style.transform = '';                    // reset so scrollWidth is the true 1-line width
    // Grandparent = the header band (full left-column width; shrinks when GHC shows).
    const band = row.parentElement && row.parentElement.parentElement;
    if (!band) return;
    const LEFT = 40, RESERVE = 24;               // row's left offset + gap before GHC/edge
    const avail = band.clientWidth - LEFT - RESERVE;
    const natural = row.scrollWidth;
    if (avail > 0 && natural > avail) {
        row.style.transform = `scale(${(avail / natural).toFixed(3)})`;
    }
    // Re-fit on any size change, delivered immediately once observing starts:
    //  - band: GHC column toggling / window resize (available width changes)
    //  - row:  content/font changes (Retry text appearing, first layout, Inter
    //          loading) — catches the initial clip before it's visible.
    // transform is visual-only, so it never changes either observed box -> no loop.
    if (!_telemetryObserved && typeof ResizeObserver !== 'undefined') {
        _telemetryObserved = true;
        const ro = new ResizeObserver(() => fitTelemetry());
        ro.observe(band);
        ro.observe(row);
    }
}

// Shrink text to fit fixed-size elements (e.g. header buttons) so long
// translations stay on one line without changing the box. Opt in with
// data-fit-text; the element must be whitespace-nowrap and have a fixed width.
let _fitObserver;
function fitAllText() {
    const els = document.querySelectorAll('[data-fit-text]');
    els.forEach(fitTextToWidth);
    // Re-fit when an element's size changes — crucially the 0 -> 165px jump when
    // #main-page returns from display:none (language was changed on the Settings
    // sub-page, so the header buttons were hidden and skipped the first fit).
    // Width is fixed, so setting font-size doesn't resize it -> no feedback loop.
    if (!_fitObserver && typeof ResizeObserver !== 'undefined') {
        _fitObserver = new ResizeObserver(entries => {
            for (const e of entries) fitTextToWidth(e.target);
        });
    }
    if (_fitObserver) els.forEach(el => _fitObserver.observe(el));
}

// Off-screen span that measures text using the page's REAL rendered fonts.
// A <canvas> 2D context silently falls back to a wider default when the custom
// font (Inter) isn't honored, which over-shrinks; a DOM span never does.
const _fitMeter = document.createElement('span');
_fitMeter.style.cssText =
    'position:absolute;left:-9999px;top:-9999px;white-space:nowrap;visibility:hidden;pointer-events:none';
if (document.body) document.body.appendChild(_fitMeter);
else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(_fitMeter));

/**
 * Shrinks an element's font-size until its text fits its width (no overflow).
 * Resets to the CSS-defined size first so switching to a shorter language grows
 * it back. ponytail: 1px steps, min 8px — plenty precise for button labels.
 *
 * Exported for callers that swap a data-fit-text label at RUNTIME: the
 * ResizeObserver above only fires on size changes, and a fixed box never
 * changes size — so a text swap must re-fit explicitly.
 */
/**
 * Height variant of fitTextToWidth, for labels that WRAP inside a fixed box
 * (the 240x98 favourite cells). Shrinks until the wrapped text stops overflowing.
 *
 * Measures the element itself rather than the off-screen meter: wrapping depends
 * on the real box width, which the meter (white-space:nowrap) cannot reproduce.
 * The box has overflow:hidden, so scrollHeight is the honest unclipped height.
 *
 * Floors at 14px — below that a bean name is unreadable at arm's length on a
 * tablet, so the remainder is left to clip rather than shrink into illegibility.
 */
let _boxObserver;
export function fitTextToBox(el, min = 14) {
    // Re-fit when the box gains or changes size: 0 -> 98px when the header returns
    // from display:none, and 240 -> ~209px when the cup warmer widens the header
    // controls. The box is fixed-size, so setting font-size never resizes it and
    // this cannot feed back on itself.
    if (!_boxObserver && typeof ResizeObserver !== 'undefined') {
        _boxObserver = new ResizeObserver(entries => {
            for (const e of entries) fitTextToBox(e.target, min);
        });
    }
    if (_boxObserver) _boxObserver.observe(el);

    el.style.fontSize = '';
    // Not laid out yet (hidden / zero-height): leave the CSS size; the observer
    // above re-fits as soon as it has a real box.
    if (!el.clientHeight) return;
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (size > min && el.scrollHeight > el.clientHeight) {
        size -= 1;
        el.style.fontSize = size + 'px';
    }
}

export function fitTextToWidth(el) {
    el.style.fontSize = '';
    // clientWidth excludes border; -8px inset so text clears the rounded corners.
    const avail = el.clientWidth - 8;
    // Not laid out yet (hidden/zero-width): leave the CSS size, a later fit
    // (fonts.ready / next translatePage) handles it. Never shrink to the floor here.
    if (avail <= 0) return;
    const cs = getComputedStyle(el);
    _fitMeter.style.fontFamily = cs.fontFamily;
    _fitMeter.style.fontWeight = cs.fontWeight;
    _fitMeter.style.fontStyle = cs.fontStyle;
    _fitMeter.style.letterSpacing = cs.letterSpacing;
    _fitMeter.textContent = el.textContent;
    let size = parseFloat(cs.fontSize);
    const measure = s => { _fitMeter.style.fontSize = s + 'px'; return _fitMeter.offsetWidth; };
    while (measure(size) > avail && size > 8) {
        size -= 1;
    }
    el.style.fontSize = size + 'px';
}

/**
 * Gets the translation for a given key in the current language.
 * @param {string} key The translation key.
 * @returns {string} The translated string, or the key if not found.
 */
export function getTranslation(key) {
    const table = translations;
    if (table && table[key] !== undefined && table[key] !== '') return table[key];
    // Case-insensitive fallback: tolerate UI/CSV casing differences. For the
    // English/source column the value equals the key, so return the caller's
    // original casing; for other languages return the actual translation.
    const canon = keyIndex[key?.toLowerCase?.()];
    if (canon && table) {
        const val = table[canon];
        if (val) return val.toLowerCase() === key.toLowerCase() ? key : val;
    }
    return key;
}

/**
 * Gets the list of supported languages.
 * @returns {string[]}
 */
export function getSupportedLanguages() {
    return supportedLanguages;
}

/**
 * Gets the current language.
 * @returns {string}
 */
export function getCurrentLanguage() {
    return currentLanguage;
}


/**
 * Sets the current language and translates the page.
 * @param {string} lang The language code (e.g., 'en', 'fr').
 */
export async function setLanguage(lang) {
    const requestedLanguage = findSupportedLanguage(lang);
    if (!requestedLanguage) {
        console.warn(`Language '${lang}' not supported. Defaulting to 'en'.`);
    }
    let nextLanguage = requestedLanguage || 'en';
    try {
        await loadTranslations(nextLanguage);
    } catch (error) {
        console.error("Could not load or parse translation file:", error);
        clearTranslations();
        nextLanguage = 'en';
    }
    currentLanguage = nextLanguage;
    if (nextLanguage === (requestedLanguage || 'en')) {
        localStorage.setItem('language', nextLanguage);
        setSetting('language', nextLanguage).catch(() => {});
    }
    logger.info(`Language set to: ${currentLanguage}`);
    const switcher = document.getElementById('language-switcher');
    if (switcher) switcher.value = currentLanguage;
    translatePage();
    document.dispatchEvent(new CustomEvent('streamline:languagechange', { detail: { language: currentLanguage } }));
    return currentLanguage;
}

/**
 * Initializes the internationalization module.
 */
export async function initI18n() {
    const localLanguage = findSupportedLanguage(localStorage.getItem('language'));
    const initialLanguage = localLanguage || findSupportedLanguage(navigator.language) || 'en';
    currentLanguage = initialLanguage;
    localStorage.setItem('language', initialLanguage);
    translatePage();
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    let savedLanguage = null;
    try {
        await openDB();
        savedLanguage = findSupportedLanguage(await getSetting('language'));
    } catch (_) {}
    await setLanguage(savedLanguage || initialLanguage);
}
