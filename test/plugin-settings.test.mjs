import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    escapeHtml,
    findPlugin,
    pluginStatus,
    pluginViewModel,
    pluginStatusLabel,
    pluginNavEntries,
    pluginCategoryFor,
    pluginIdFromCategory,
} from '../src/settings/plugin-view.js';

// plugin-view.js is the pure metadata -> view-model layer the generic plugin
// settings card (settings.js renderPluginCard/setupPluginCard) is built on.
// It is DOM-free and import-free (no api.js, no i18n), so it can be imported
// directly here instead of lifted via regex -- see test/dye2-plugin-source.test.mjs
// and test/plugin-list.test.mjs for the lift-based pattern this module avoids.

// ── findPlugin ────────────────────────────────────────────────────────────

test('findPlugin locates a plugin by id, tolerating a missing or malformed list', () => {
    const plugins = [{ id: 'a.reaplugin' }, { id: 'b.reaplugin' }];
    assert.equal(findPlugin(plugins, 'b.reaplugin'), plugins[1]);
    assert.equal(findPlugin(plugins, 'missing.reaplugin'), null);
    assert.equal(findPlugin(null, 'a.reaplugin'), null);
    assert.equal(findPlugin(undefined, 'a.reaplugin'), null);
});

// ── pluginStatus: the install/enable/update state machine ──────────────────

test('a failed GET /plugins (null) reads as unreachable, never "not installed"', () => {
    // null is getPlugins()'s failure sentinel, distinct from an empty array --
    // collapsing the two would tell a user with a working plugin to reinstall
    // it. See docs/AI_API_NOTES.md and getPlugins() in api.js.
    assert.equal(pluginStatus(null, 'dye2.reaplugin'), 'unreachable');
});

test('a reachable bridge with no matching plugin is not-installed', () => {
    assert.equal(pluginStatus([], 'dye2.reaplugin'), 'not-installed');
    assert.equal(pluginStatus([{ id: 'other.reaplugin', loaded: true }], 'dye2.reaplugin'), 'not-installed');
});

test('installed but not loaded is disabled', () => {
    assert.equal(pluginStatus([{ id: 'dye2.reaplugin', loaded: false }], 'dye2.reaplugin'), 'disabled');
});

test('loaded with a pendingUpdate is update-pending', () => {
    const plugins = [{ id: 'dye2.reaplugin', loaded: true, pendingUpdate: { version: '0.2.0', addedPermissions: ['api'] } }];
    assert.equal(pluginStatus(plugins, 'dye2.reaplugin'), 'update-pending');
});

// "No pending update" is not "up to date": pendingUpdate only holds an update
// Decaid refused to auto-install because it asks for new permissions. A plugin
// is only current once a check has actually said so — see the update-status
// tests in plugin-list.test.mjs for the full set.
test('loaded with no pending update is only enabled once a check confirms it', () => {
    const checked = { kind: 'github_release', repo: 'decentespresso/dye2', lastChecked: new Date().toISOString() };
    assert.equal(pluginStatus([{ id: 'dye2.reaplugin', loaded: true, source: checked }], 'dye2.reaplugin'), 'enabled');
    assert.equal(pluginStatus([{ id: 'dye2.reaplugin', loaded: true }], 'dye2.reaplugin'), 'bundled',
        'no source at all ships with the app, so it cannot be called current either');
});

test('pluginStatusLabel names every state the card can render', () => {
    assert.equal(pluginStatusLabel('unreachable'), 'Could not check');
    assert.equal(pluginStatusLabel('not-installed'), 'Not installed');
    assert.equal(pluginStatusLabel('disabled'), 'Not loaded');
    assert.equal(pluginStatusLabel('update-pending'), 'Update needs approval');
    assert.equal(pluginStatusLabel('bundled'), 'Ships with Decaid');
    assert.equal(pluginStatusLabel('untracked'), 'Cannot check for updates');
    assert.equal(pluginStatusLabel('check-failed'), 'Update check failed');
    assert.equal(pluginStatusLabel('never-checked'), 'Not checked yet');
    assert.equal(pluginStatusLabel('enabled'), 'Up to date');
});

// ── pluginViewModel: metadata -> view-model mapping ─────────────────────────

test('pluginViewModel maps an installed plugin\'s fields verbatim', () => {
    const plugin = {
        id: 'print-the-shot.reaplugin',
        name: 'Print The Shot',
        description: 'Sends a finished shot to a local print server.',
        version: '1.2.0',
        loaded: true,
        source: { kind: 'github_release', repo: 'decentespresso/print-the-shot', releaseTag: 'v1.2.0',
                  lastChecked: new Date().toISOString(), lastError: null },
        pendingUpdate: null,
        settings: { AutoPrint: { type: 'boolean', default: false } },
    };
    const vm = pluginViewModel([plugin], 'print-the-shot.reaplugin');
    assert.equal(vm.status, 'enabled');
    assert.equal(vm.reachable, true);
    assert.equal(vm.name, 'Print The Shot');
    assert.equal(vm.description, plugin.description);
    assert.equal(vm.version, '1.2.0');
    assert.equal(vm.loaded, true);
    assert.deepEqual(vm.source, plugin.source);
    assert.equal(vm.pending, null);
    assert.deepEqual(vm.settingsKeys, ['AutoPrint']);
    assert.deepEqual(vm.settingsSchema, plugin.settings);
});

test('pluginViewModel degrades an unreachable bridge to nulls, not a throw', () => {
    const vm = pluginViewModel(null, 'dye2.reaplugin');
    assert.equal(vm.status, 'unreachable');
    assert.equal(vm.reachable, false);
    assert.equal(vm.plugin, null);
    assert.equal(vm.name, null);
    assert.equal(vm.description, null);
    assert.equal(vm.version, null);
    assert.equal(vm.loaded, false);
    assert.deepEqual(vm.settingsKeys, []);
    assert.deepEqual(vm.settingsSchema, {});
});

test('pluginViewModel tolerates a malformed settings schema (not an object)', () => {
    const vm = pluginViewModel([{ id: 'x.reaplugin', loaded: true, settings: 'nonsense' }], 'x.reaplugin');
    assert.deepEqual(vm.settingsSchema, {});
    assert.deepEqual(vm.settingsKeys, []);
});

// ── escapeHtml: untrusted manifest text must never reach innerHTML raw ─────

test('escapeHtml neutralizes an attacker-controlled plugin name/description', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const escaped = escapeHtml(evil);
    assert.ok(!escaped.includes('<img'));
    assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt;');
});

test('escapeHtml also covers quotes, so a manifest string cannot break out of an attribute', () => {
    const evil = `"><script>alert(1)</script>`;
    const escaped = escapeHtml(evil);
    assert.ok(!escaped.includes('"'));
    assert.ok(!escaped.includes('<script>'));
});

test('escapeHtml is a no-op on plain text', () => {
    assert.equal(escapeHtml('Print The Shot'), 'Print The Shot');
});

test('a plugin view-model built from an attacker-supplied manifest is safe once escaped', () => {
    // pluginViewModel itself does not escape (callers route text through
    // textContent or escapeHtml at render time -- see renderPluginCard in
    // settings.js) but it must not choke on or silently drop hostile input.
    const plugin = {
        id: 'evil.reaplugin',
        name: '<img src=x onerror=alert(1)>',
        description: '<script>document.cookie</script>',
        loaded: true,
    };
    const vm = pluginViewModel([plugin], 'evil.reaplugin');
    assert.equal(vm.name, plugin.name);
    assert.ok(!escapeHtml(vm.name).includes('<img'));
    assert.ok(!escapeHtml(vm.description).includes('<script>'));
});

// ── Extensions nav rows: one per plugin, not one endless page ──────────────
//
// Each installed plugin gets its own subcategory row and its own routable
// category, derived from the plugin id -- nothing about a plugin is written
// into settings-tree.js, so installing one from the Decaid dashboard is all it
// takes for the skin to show its page.

test('a plugin category round-trips to the plugin id', () => {
    assert.equal(pluginIdFromCategory(pluginCategoryFor('dye2.reaplugin')), 'dye2.reaplugin');
});

test('a non-plugin category is not mistaken for one', () => {
    for (const category of ['plugins', 'shotupload', 'extensions', '', null, undefined]) {
        assert.equal(pluginIdFromCategory(category), null);
    }
});

test('nav rows are sorted by display name, not by the load order GET /plugins returns', () => {
    const rows = pluginNavEntries([
        { id: 'z.reaplugin', name: 'Time To Ready' },
        { id: 'a.reaplugin', name: 'dcamp' },
        { id: 'm.reaplugin', name: 'Print The Shot' },
    ]);
    assert.deepEqual(rows.map(r => r.name), ['dcamp', 'Print The Shot', 'Time To Ready']);
});

test('a plugin with no manifest name falls back to its id rather than an empty row', () => {
    const [row] = pluginNavEntries([{ id: 'nameless.reaplugin' }]);
    assert.equal(row.name, 'nameless.reaplugin');
    assert.equal(row.settingsCategory, 'plugin:nameless.reaplugin');
});

test('a self-installable plugin gets a row even though it is not installed yet', () => {
    const rows = pluginNavEntries([{ id: 'other.reaplugin', name: 'Other' }], ['dye2.reaplugin']);
    assert.deepEqual(rows.map(r => r.pluginId).sort(), ['dye2.reaplugin', 'other.reaplugin']);
});

test('a self-installable plugin that IS installed is listed once, under its manifest name', () => {
    const rows = pluginNavEntries([{ id: 'dye2.reaplugin', name: 'Streamline/DYE2' }], ['dye2.reaplugin']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Streamline/DYE2');
});

test('an unreachable bridge yields no rows instead of throwing', () => {
    assert.deepEqual(pluginNavEntries(null), []);
    assert.deepEqual(pluginNavEntries(undefined), []);
    assert.deepEqual(pluginNavEntries([]), []);
});

test('a malformed entry in the list does not take the whole nav down', () => {
    const rows = pluginNavEntries([null, { name: 'no id' }, { id: 'ok.reaplugin', name: 'Ok' }]);
    assert.deepEqual(rows.map(r => r.pluginId), ['ok.reaplugin']);
});
