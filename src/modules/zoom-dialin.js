// The dial-in strip of the full-screen ("zoomed") chart layout.
//
// The TCL skin's zoomed page keeps the dial-in numbers on screen as one dense
// text line above the chart (skin.tcl:964-1001, `zoomed_btns`) while the chart
// itself takes the full width. Ours live in the 480px #shot-settings sidebar,
// which the zoomed layout hides to win that width, so they are mirrored into
// this strip instead of vanishing for as long as the chart is zoomed.
//
// Mirrored by observation, not by a push: grind, dose, yield and temperature are
// written from ui.js, profileManager.js, numpad-modal.js and plugin-tile-modes.js,
// so one MutationObserver is cheaper and harder to forget than a hook in each.
import { getTranslation } from './i18n.js';

// `ids` is a preference order, not a set: steam shows a duration in time mode and
// a flow in flow mode, and only one of the two nodes carries text at a time.
// Visibility cannot be used to choose, because by the time the strip is built the
// sidebar holding both is already display:none (offsetParent null for either).
// `parenIds` is the TCL line's one two-part value: hot water reads "75ml (80\u00B0c)",
// volume then temperature in brackets (skin.tcl:992-997).
const FIELDS = [
    { key: 'Grind', ids: ['grind-value'] },
    { key: 'Dose', ids: ['dose-in-value'] },
    { key: 'Drink', ids: ['drink-out-value'] },
    { key: 'Brew', ids: ['temp-value'] },
    { key: 'Steam', ids: ['steam-duration-value', 'steam-flow-value'] },
    { key: 'Flush', ids: ['flush-value'] },
    { key: 'Hot Water', ids: ['hot-water-vol-value'], parenIds: ['hot-water-temp-value'] }
];

let observers = [];
let pending = 0;

function sourceText(ids) {
    for (const id of ids) {
        const text = document.getElementById(id)?.textContent?.trim();
        if (text) return text;
    }
    return '';
}

function render() {
    const strip = document.getElementById('zoom-dialin');
    if (!strip) return;
    strip.replaceChildren(...FIELDS.flatMap(field => {
        const value = sourceText(field.ids);
        if (!value) return [];
        const paren = field.parenIds ? sourceText(field.parenIds) : '';
        const label = document.createElement('span');
        label.className = 'zoom-dialin-label';
        label.textContent = getTranslation(field.key);
        const data = document.createElement('span');
        data.className = 'zoom-dialin-value';
        data.textContent = paren ? `${value} (${paren})` : value;
        const pair = document.createElement('span');
        pair.className = 'zoom-dialin-pair';
        pair.append(label, data);
        return [pair];
    }));
}

// Several nodes can change in one tile write; coalesce to one repaint per frame.
function scheduleRender() {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; render(); });
}

/** Build the strip and keep it in step until stopZoomDialIn(). Idempotent. */
export function startZoomDialIn() {
    stopZoomDialIn();
    render();
    for (const id of FIELDS.flatMap(field => [...field.ids, ...(field.parenIds ?? [])])) {
        const element = document.getElementById(id);
        if (!element) continue;
        const observer = new MutationObserver(scheduleRender);
        observer.observe(element, { characterData: true, childList: true, subtree: true });
        observers.push(observer);
    }
}

/** Drop the observers and empty the strip. Safe to call when not started. */
export function stopZoomDialIn() {
    for (const observer of observers) observer.disconnect();
    observers = [];
    if (pending) { cancelAnimationFrame(pending); pending = 0; }
    document.getElementById('zoom-dialin')?.replaceChildren();
}
