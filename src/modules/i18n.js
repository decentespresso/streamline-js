import { logger } from './logger.js';
import { openDB, getSetting, setSetting } from './idb.js';
import { SUPPORTED_LANGUAGES, parseTranslationColumn } from './i18n-parser.js';
import { APP_VERSION } from '../version.js';
import { largestFittingSize, predictFittingSize } from './text-fit.js';

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
    // NOT invalidateTextFits() here. New strings need no invalidation: a fit is
    // cached per element AND per text (state.sizes), so a changed string is a
    // cache miss already, while the element's box and font -- the expensive half
    // -- have not changed. Clearing the lot cost 21-49 ms of every settings page
    // switch on the tablet, measured with probes=0, i.e. re-measuring five
    // elements from scratch. What does invalidate a cached size is the face
    // behind the text changing, and that arrives through document.fonts.ready
    // below.
    fitAllText();
    fitTelemetry();
    // The header buttons are laid out with the custom Inter font; if it hasn't
    // finished loading yet the first fit measures against a fallback (or a
    // not-yet-sized box) and mis-shrinks. Re-fit once fonts are ready.
    if (document.fonts && document.fonts.status !== 'loaded') {
        document.fonts.ready.then(() => { invalidateTextFits(); fitAllText(); fitTelemetry(); });
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
    // Grandparent = the header band (full left-column width; shrinks when GHC shows).
    const band = row.parentElement && row.parentElement.parentElement;
    if (!band) return;
    // Observe before the hidden check below, not after the fit: booting straight
    // onto a subpage (?page=settings) would otherwise bail out here and never
    // start observing, leaving the row unfitted for the whole session.
    observeTelemetry(row, band);
    // Nothing to fit while the main page is hidden behind a subpage, and the
    // reads below would force another document-wide layout on every subpage
    // navigation. The row is never position:fixed, so a null offsetParent means
    // display:none -- and the observer above re-fits it when the main page comes
    // back and its box goes 0 -> full width.
    if (!row.offsetParent) return;
    row.style.transformOrigin = 'left center';
    row.style.transform = '';                    // reset so scrollWidth is the true 1-line width
    const LEFT = 40, RESERVE = 24;               // row's left offset + gap before GHC/edge
    const avail = band.clientWidth - LEFT - RESERVE;
    const natural = row.scrollWidth;
    if (avail > 0 && natural > avail) {
        row.style.transform = `scale(${(avail / natural).toFixed(3)})`;
    }
}

// Re-fit on any size change, delivered immediately once observing starts:
//  - band: GHC column toggling / window resize (available width changes)
//  - row:  content/font changes (Retry text appearing, first layout, Inter
//          loading) — catches the initial clip before it's visible.
// transform is visual-only, so it never changes either observed box -> no loop.
function observeTelemetry(row, band) {
    if (_telemetryObserved || typeof ResizeObserver === 'undefined') return;
    _telemetryObserved = true;
    const ro = new ResizeObserver(() => fitTelemetry());
    ro.observe(band);
    ro.observe(row);
}

// Shrink text to fit fixed-size elements (e.g. header buttons) so long
// translations stay on one line without changing the box. Opt in with
// data-fit-text; the element must be whitespace-nowrap and have a fixed width.
let _fitObserver;
function fitAllText() {
    const els = document.querySelectorAll('[data-fit-text]');
    // Three passes, because fitStateFor clears the inline size before reading
    // clientWidth: interleaved, each element's read flushed the layout the
    // previous element's write had dirtied, so N elements cost N document-wide
    // layouts. Measured on the tablet (2026-11-12), translatePage() was 30-45 ms
    // of a 37-53 ms settings page switch -- nearly all of it this. Clear every
    // size, then measure every box against one flush, then write the sizes
    // (which needs no read at all, text being measured on a canvas).
    els.forEach(el => { if (el.style.fontSize) el.style.fontSize = ''; });
    els.forEach(fitStateFor);
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
const FIT_MIN_PX = 8;

// What a fit depends on, per element: the space it has and the size its CSS
// gives it. Measured on a tablet (2026-11-11), fitting a shot-data cell cost
// 10 ms even after the probe count was cut from five to two -- because the
// probes were never the cost. Clearing the inline size, reading clientWidth and
// calling getComputedStyle force a style recalc and a document-wide layout
// before any measuring begins, and that is the 10 ms.
//
// So the element is measured once and a ResizeObserver says when that stops
// being true: a width change is exactly what invalidates both the space and the
// sizes already worked out for it. A font-scale change (Display Size) resizes
// these boxes too, so it arrives through the same observer.
let _fitState = new WeakMap(); // el -> { avail, start, font, sizes: Map<text, px> }
let _fitSizeObserver = null;

function fitStateFor(el) {
    const known = _fitState.get(el);
    if (known) return known;

    // Only when there is one to clear: a redundant write would re-dirty layout
    // between two reads, which is exactly what fitAllText() batches to avoid.
    if (el.style.fontSize) el.style.fontSize = '';
    const cs = getComputedStyle(el);
    // clientWidth excludes border; -8px inset so text clears the rounded corners.
    const state = {
        avail: el.clientWidth - 8,
        start: parseFloat(cs.fontSize),
        // Copied out, not held: reading a live CSSStyleDeclaration later would
        // recalc style, which is half of what this cache exists to avoid.
        font: {
            family: cs.fontFamily,
            weight: cs.fontWeight,
            style: cs.fontStyle,
            letterSpacing: cs.letterSpacing,
        },
        sizes: new Map(),
    };
    _fitState.set(el, state);

    if (!_fitSizeObserver && typeof ResizeObserver !== 'undefined') {
        _fitSizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) _fitState.delete(entry.target);
        });
    }
    _fitSizeObserver?.observe(el);
    return state;
}

/** Drop every cached fit: a font swap changes widths without resizing a box. */
export function invalidateTextFits() {
    _fitState = new WeakMap();
}

const _fitMeter = document.createElement('span');
_fitMeter.style.cssText =
    'position:absolute;left:-9999px;top:-9999px;white-space:nowrap;visibility:hidden;pointer-events:none';
if (document.body) document.body.appendChild(_fitMeter);
else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(_fitMeter));

// Measuring through the DOM means writing a style and reading offsetWidth, and a
// read forces the browser to flush layout for the WHOLE document -- which, on a
// live shot, has just been dirtied by the chart and the shot table. Measured on
// a tablet (2026-11-11): ~3.4 ms a probe, 6.7 ms a fit, against 0.2 ms in Chrome
// on a desktop where nothing else is pending.
//
// A canvas measures the same text with no layout at all. It is only trusted when
// the face is actually loaded -- an unloaded one silently measures as a fallback
// and over-shrinks, which is why the span below exists in the first place -- and
// when letter-spacing can be honoured. Otherwise the span still does the work.
// Verified against the span on NotoSansMono: within 0.5px at every size tried,
// and the fitter's 8px inset absorbs that.
let _fitCanvas = null;
// Only `true` is remembered: a face can finish loading between two calls, so a
// cached `false` would pin the element to the DOM span for the rest of the
// session. Once loaded it stays loaded, so a cached `true` cannot go stale.
const _faceLoaded = new Set();

function canvasWidth(text, px, font) {
    if (!_fitCanvas) _fitCanvas = document.createElement('canvas').getContext('2d');
    const ctx = _fitCanvas;
    if (!ctx) return null;
    const spaced = font.letterSpacing && font.letterSpacing !== 'normal';
    if (spaced && !('letterSpacing' in ctx)) return null;
    if ('letterSpacing' in ctx) ctx.letterSpacing = spaced ? font.letterSpacing : '0px';
    ctx.font = `${font.style} ${font.weight} ${px}px ${font.family}`;
    if (document.fonts && !_faceLoaded.has(ctx.font)) {
        if (!document.fonts.check(ctx.font)) return null;
        _faceLoaded.add(ctx.font);
    }
    // Round up: the span reports whole pixels, and under-measuring is what
    // overflows a cell.
    return Math.ceil(ctx.measureText(text).width);
}

/**
 * Shrinks an element's font-size until its text fits its width (no overflow).
 * Resets to the CSS-defined size first so switching to a shorter language grows
 * it back. Floors at 8px.
 *
 * Every probe writes a font size and then reads offsetWidth, which forces a
 * synchronous layout of the document -- about 2.3 ms each on a tablet, measured
 * 2026-11-11, where fitting a shot-data range cell cost 11.4 ms and was the
 * frame that spiked to 32 ms while the typical one cost 2.5 ms.
 *
 * So: a cache first, then arithmetic. Text width scales with font size, so the
 * width at the CSS size predicts the size that fits in one step; the prediction
 * is probed once in case hinting rounds it over the edge. Two probes, against
 * the ~5 a halving search needs and the up-to-18 of the 1px walk it replaced.
 *
 * The cache is keyed on the text, the space and the font, which is what the
 * answer depends on -- a shot-data cell re-fits whenever a value crosses ten,
 * and crosses back to a shape it has already paid for.
 *
 * Exported for callers that swap a data-fit-text label at RUNTIME: the
 * ResizeObserver above only fires on size changes, and a fixed box never
 * changes size — so a text swap must re-fit explicitly.
 */
/**
 * Height variant of fitTextToWidth, for labels that WRAP inside a fixed box
 * (the 225x90 favourite cells). Shrinks until the wrapped text stops overflowing.
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
    const start = parseFloat(getComputedStyle(el).fontSize);
    // Binary search instead of a 1px walk: each probe costs a forced synchronous
    // reflow (write font-size, read scrollHeight), so this is ~4 per element
    // rather than up to ~14 -- and profileManager fits five cells at once.
    // Floors at `min` exactly; the old walk could step below it from a
    // fractional start size.
    const size = largestFittingSize(min, start, candidate => {
        el.style.fontSize = candidate + 'px';
        return el.scrollHeight <= el.clientHeight;
    });
    // null = it fits at the CSS size; leave the inline size cleared.
    if (size === null) el.style.fontSize = '';
    else el.style.fontSize = size + 'px';
}

export function fitTextToWidth(el) {
    const state = fitStateFor(el);
    // Not laid out yet (hidden/zero-width): leave the CSS size alone, and never
    // shrink to the floor against no width.
    //
    // The zero stays cached rather than being dropped. Three of the main page's
    // fit elements are hidden the whole time a subpage is open, and dropping
    // their state made every translatePage re-run getComputedStyle and
    // clientWidth on all three only to throw the answer away again. Both
    // ResizeObservers above fire on the 0 -> full-width change when the main
    // page comes back, and deleting the state is exactly what they do.
    if (state.avail <= 0) return;

    const text = el.textContent;
    const cached = state.sizes.get(text);
    if (cached !== undefined) {
        el.style.fontSize = cached + 'px';
        return;
    }

    let meterPrepared = false;
    const widthAt = size => {
        const measured = canvasWidth(text, size, state.font);
        if (measured !== null) return measured;
        if (!meterPrepared) {
            _fitMeter.style.fontFamily = state.font.family;
            _fitMeter.style.fontWeight = state.font.weight;
            _fitMeter.style.fontStyle = state.font.style;
            _fitMeter.style.letterSpacing = state.font.letterSpacing;
            _fitMeter.textContent = text;
            meterPrepared = true;
        }
        _fitMeter.style.fontSize = size + 'px';
        return _fitMeter.offsetWidth;
    };

    const size = predictFittingSize(state.start, state.avail, FIT_MIN_PX, widthAt);
    state.sizes.set(text, size);
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
