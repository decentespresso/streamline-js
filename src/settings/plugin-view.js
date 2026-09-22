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

// Only these two kinds are checkable: updateAllPlugins skips everything else
// (plugin_source_service.dart, `!source.kind.isManaged` -> continue), so a
// local ZIP or folder install is a snapshot that can never report an update.
const MANAGED_SOURCE_KINDS = ['github_release', 'github_branch'];

export function isManagedPluginSource(source) {
    return MANAGED_SOURCE_KINDS.includes(source?.kind);
}

// The install/enable/update state machine a generic settings card renders
// differently for:
//  - 'unreachable'     GET /plugins failed outright; nothing else is known
//  - 'not-installed'   bridge reachable, plugin absent from the list
//  - 'disabled'        installed but not currently loaded
//  - 'update-pending'  loaded, and Decaid is holding an update back for
//                       permissions the installed copy does not have
//  - 'bundled'         loaded, no source at all: it came with Decaid and moves
//                       when Decaid does (Decaid seeds real sources for the
//                       three bundled plugins that do ship separately --
//                       dye2, shot-upload, dcamp -- so those land elsewhere)
//  - 'untracked'       loaded, but installed from a local ZIP/folder: a
//                       snapshot nothing can check
//  - 'check-failed'    loaded and checkable, but the last check errored
//  - 'never-checked'   loaded and checkable, but no check has ever run
//  - 'enabled'         loaded, checkable, and a check has actually confirmed it
//
// The last four used to be one 'enabled' -> "Up to date". That was a claim the
// data never supported: `pendingUpdate` only holds an update Decaid refused to
// auto-install because it wants NEW PERMISSIONS, so "no pending update" means
// "nothing is being held back", not "nothing newer exists". A folder install is
// never even looked at, and a rate-limited check (GitHub allows 60/h
// unauthenticated for the whole tablet) records an error while the pill still
// read "Up to date". Say what is known instead.
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
    if (!plugin.source) return 'bundled';
    if (!isManagedPluginSource(plugin.source)) return 'untracked';
    if (plugin.source.lastError) return 'check-failed';
    if (!Number.isFinite(Date.parse(plugin.source.lastChecked || ''))) return 'never-checked';
    return 'enabled';
}

/** Whole minutes since `iso`, or null when it is absent or unparseable. */
export function minutesSince(iso, now = Date.now()) {
    const at = Date.parse(iso || '');
    if (!Number.isFinite(at)) return null;
    return Math.max(0, Math.floor((now - at) / 60000));
}

// Decaid re-checks every managed plugin on one 12-hourly timer, so a release
// can be up to half a day old before a card would notice it. Opening the
// Extensions page asks for a fresh answer instead -- but the check costs an
// unauthenticated api.github.com request per managed plugin, against a 60/h
// budget shared with Decaid's own timer and skin updates, and re-entering a
// settings page is something a user does freely. So: only when something is
// actually checkable, and not if every checkable plugin was already checked
// inside the cooldown (or we asked this recently ourselves).
export const PLUGIN_UPDATE_COOLDOWN_MS = 15 * 60 * 1000;

export function shouldCheckPluginUpdates(plugins, { now = Date.now(), lastRunAt = null } = {}) {
    if (!Array.isArray(plugins)) return false;
    if (Number.isFinite(lastRunAt) && now - lastRunAt < PLUGIN_UPDATE_COOLDOWN_MS) return false;
    const managed = plugins.filter(plugin => isManagedPluginSource(plugin?.source));
    if (managed.length === 0) return false;
    return managed.some(plugin => {
        const checkedAt = Date.parse(plugin.source.lastChecked || '');
        return !Number.isFinite(checkedAt) || now - checkedAt >= PLUGIN_UPDATE_COOLDOWN_MS;
    });
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
        case 'bundled': return 'Ships with Decaid';
        case 'untracked': return 'Cannot check for updates';
        case 'check-failed': return 'Update check failed';
        case 'never-checked': return 'Not checked yet';
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
