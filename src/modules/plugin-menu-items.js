// Plugin `menu-item` surfaces for the skin's long-press menus. The registry is
// filled by plugin-surfaces-ui.js on each skin read and read by the menus when
// they open, from memory, so a menu opens as fast as it does without plugins.
// Kept apart from plugin-surfaces-ui.js so a menu module can import it cheaply.

export const MENU_ITEM_CAP_TOTAL = 6; // per menu, across all plugins
const NAME_CAP = 14; // the plugin's name after the label, so an item cannot pose as a built-in

let entries = [];
let runner = null;

/** Called with every `menu-item` entry ({ plugin, surface }) of the latest read. */
export function setMenuEntries(list) {
    entries = Array.isArray(list) ? list : [];
}

export function setMenuRunner(fn) {
    runner = typeof fn === 'function' ? fn : null;
}

// Zero-width and bidi controls could hide a name or reorder a label.
const stripInvisible = value => String(value ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '').trim();

/** "Rate this shot · Derek"; the plugin's name keeps it from posing as a built-in. */
export function menuItemLabel(label, pluginName) {
    const name = stripInvisible(pluginName).slice(0, NAME_CAP);
    return name ? `${label} · ${name}` : label;
}

/**
 * The context-menu entries plugins add to `menu`, ready to append after the
 * built-in ones. `context` is the small fixed object the item acts on (the shot,
 * the favourite slot); the plugin receives it in the page URL or the call body.
 * Empty when no plugin takes part, so the menu is exactly as before.
 */
export function pluginMenuEntries(menu, context = {}) {
    if (!runner) return [];
    const picked = entries.filter(e => e?.surface?.menu === menu).slice(0, MENU_ITEM_CAP_TOTAL);
    if (picked.length === 0) return [];
    const run = runner;
    return [
        { divider: true },
        ...picked.map(entry => ({
            label: menuItemLabel(entry.surface.label, stripInvisible(entry.plugin?.name) || entry.plugin?.id),
            onSelect: () => run(entry, context),
        })),
    ];
}
