// plugin-view.js — pure metadata -> view-model mapping shared by every generic
// plugin settings card (see the Plugins category in settings.js). Everything
// here operates on the array GET /plugins already returns (api.js getPlugins())
// as plain data: no network, no DOM, no i18n import. That keeps it importable
// directly by node:test (AGENTS.md: "Node tests import DOM-free modules only")
// and lets any page that draws a plugin's settings -- the Plugins list, DYE2's
// master-switch card, a future plugin with no skin code at all -- read the same
// install/enable/update state instead of re-deriving it per page, which is how
// the old dye2/printtheshot pages drifted from each other despite doing the
// same thing.
//
// Manifest text (name, description, setting labels) is untrusted: a plugin
// installs from an arbitrary GitHub repo, so its author controls those strings.
// escapeHtml here is the one place that text is made safe for innerHTML; every
// renderer must route plugin-supplied text through it (or through textContent).

export function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function findPlugin(plugins, pluginId) {
    return Array.isArray(plugins) ? (plugins.find(p => p?.id === pluginId) || null) : null;
}

// The install/enable/update state machine a generic settings card renders
// differently for:
//  - 'unreachable'     GET /plugins failed outright; nothing else is known
//  - 'not-installed'   bridge reachable, plugin absent from the list
//  - 'disabled'        installed but not currently loaded
//  - 'update-pending'  loaded, and Decaid is holding an update back for
//                       permissions the installed copy does not have
//  - 'enabled'         loaded and current
//
// `plugins === null` is the getPlugins() failure sentinel (distinct from `[]`,
// which means the bridge is fine and genuinely has no plugins) -- collapsing
// the two would tell a user with a working plugin to go reinstall it.
export function pluginStatus(plugins, pluginId) {
    if (!plugins) return 'unreachable';
    const plugin = findPlugin(plugins, pluginId);
    if (!plugin) return 'not-installed';
    if (!plugin.loaded) return 'disabled';
    if (plugin.pendingUpdate) return 'update-pending';
    return 'enabled';
}

// Everything a generic plugin settings card needs to decide what to draw,
// derived only from what GET /plugins already returned. Name/description are
// raw manifest content -- untrusted -- and must be escaped (or set via
// textContent) by the caller before reaching innerHTML.
export function pluginViewModel(plugins, pluginId) {
    const status = pluginStatus(plugins, pluginId);
    const plugin = findPlugin(plugins, pluginId);
    const settingsSchema = plugin?.settings && typeof plugin.settings === 'object' ? plugin.settings : {};
    return {
        id: pluginId,
        plugin,
        status,
        reachable: status !== 'unreachable',
        name: plugin?.name || null,
        description: plugin?.description || null,
        version: plugin?.version || null,
        source: plugin?.source || null,
        pending: plugin?.pendingUpdate || null,
        loaded: !!plugin?.loaded,
        settingsSchema,
        settingsKeys: Object.keys(settingsSchema),
    };
}

// Translation-key labels for each status pill. The caller runs these through
// getTranslation (i18n import stays out of this module -- see file header).
export function pluginStatusLabel(status) {
    switch (status) {
        case 'unreachable': return 'Could not check';
        case 'not-installed': return 'Not installed';
        case 'disabled': return 'Not loaded';
        case 'update-pending': return 'Update needs approval';
        case 'enabled': return 'Up to date';
        default: return 'Unknown';
    }
}

// Category id for a single plugin's own settings page. The Extensions nav grows
// one subcategory per installed plugin instead of stacking every plugin onto one
// endless page, so each needs a routable category of its own -- derived from the
// plugin id rather than stored anywhere, since the set of plugins is whatever
// the connected Decaid happens to have.
export const PLUGIN_CATEGORY_PREFIX = 'plugin:';

export function pluginCategoryFor(pluginId) {
    return `${PLUGIN_CATEGORY_PREFIX}${pluginId}`;
}

export function pluginIdFromCategory(category) {
    return typeof category === 'string' && category.startsWith(PLUGIN_CATEGORY_PREFIX)
        ? category.slice(PLUGIN_CATEGORY_PREFIX.length)
        : null;
}

// The Extensions subcategory rows for the plugins Decaid reports, plus any
// plugin the skin can install itself (DYE2) that is not installed yet -- those
// have no entry in GET /plugins at all, so they would otherwise be unreachable.
// Sorted by display name: GET /plugins returns load order, which shuffles as
// plugins are installed and removed, and a nav list that reorders itself between
// visits is worse than one that ignores load order.
export function pluginNavEntries(plugins, selfInstallableIds = []) {
    const installed = Array.isArray(plugins) ? plugins.filter(p => p?.id) : [];
    const installedIds = new Set(installed.map(p => p.id));
    const entries = installed.map(p => ({ pluginId: p.id, name: p.name || p.id }));
    for (const id of selfInstallableIds) {
        if (!installedIds.has(id)) entries.push({ pluginId: id, name: id });
    }
    return entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(entry => ({
            id: pluginCategoryFor(entry.pluginId),
            pluginId: entry.pluginId,
            name: entry.name,
            settingsCategory: pluginCategoryFor(entry.pluginId),
        }));
}
