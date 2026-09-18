import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// The Plugins settings page links each plugin to its own web UI. Decaid routes
// /api/v1/plugins/<id>/<endpoint> from the manifest's api declarations, so a link
// is only real when the manifest declares an http endpoint named "ui" -- anything
// else 404s. settings.js can't be imported under node (browser globals), so the
// function is lifted out of the source, as in settings-sync.test.mjs.

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
// escapeHtml is defined once, in the DOM-free plugin-view.js, and imported by
// settings.js -- lift it from where it actually lives.
const viewSource = readFileSync(new URL('../src/settings/plugin-view.js', import.meta.url), 'utf8');
const match = source.match(/^function pluginUiUrl\(plugin\) \{[\s\S]*?\r?\n\}/m);
assert.ok(match, 'pluginUiUrl not found in settings.js');
const pluginUiUrl = new Function('API_BASE_URL', `${match[0]}\nreturn pluginUiUrl;`)('http://x:8080/api/v1');

test('a plugin declaring a ui endpoint gets a link to it', () => {
    assert.equal(
        pluginUiUrl({ id: 'settings.reaplugin', api: [{ id: 'ui', type: 'http', data: {} }] }),
        'http://x:8080/api/v1/plugins/settings.reaplugin/ui',
    );
});

test('the link is built off the configured bridge host, not a literal localhost', () => {
    const url = pluginUiUrl({ id: 'dye2.reaplugin', api: [{ id: 'ui', type: 'http' }] });
    assert.ok(url.startsWith('http://x:8080/api/v1/'));
});

test('a plugin with no ui endpoint gets no link', () => {
    // dye2 declares a dozen http endpoints, none of them "ui" -- linking to one
    // of those would open a fragment, and guessing /ui would 404.
    const dye2ish = { id: 'dye2.reaplugin', api: [{ id: 'dashboard', type: 'http' }, { id: 'grinders', type: 'http' }] };
    assert.equal(pluginUiUrl(dye2ish), null);
    assert.equal(pluginUiUrl({ id: 'bare.reaplugin' }), null);
    assert.equal(pluginUiUrl(null), null);
});

test('a websocket endpoint named ui is not a web page', () => {
    const wsOnly = { id: 'time-to-ready.reaplugin', api: [{ id: 'ui', type: 'websocket' }] };
    assert.equal(pluginUiUrl(wsOnly), null);
});

test('an id needing escaping stays intact in the path', () => {
    // Decaid's id rule permits characters that are not URL-safe; the path segment
    // is encoded so the link still points at the plugin it names.
    const url = pluginUiUrl({ id: "odd id.reaplugin", api: [{ id: 'ui', type: 'http' }] });
    assert.equal(url, 'http://x:8080/api/v1/plugins/odd%20id.reaplugin/ui');
});

// ── Shot Uploader controls are built from the plugin's manifest ──────────────
//
// The page used to hand-write its labels and its control list, so it could not
// follow a plugin that ships on its own schedule: shot-upload 0.2.0 declares
// DrainHistory and 0.2.1 removes it. Reading GET /api/v1/plugins' `settings`
// schema instead means the page shows exactly what the connected Decaid's plugin
// declares, whichever version that is. The schema below is 0.2.1's.

const shotUpload = (() => {
    const lift = (re, name, from = source) => {
        const m = from.match(re);
        assert.ok(m, `${name} not found in source`);
        return m[0].replace('export ', '');
    };
    const body = [
        lift(/export function escapeHtml\(str\) \{[\s\S]*?\r?\n\}/, 'escapeHtml', viewSource),
        lift(/export function pluginSettingLabel\(key\) \{[\s\S]*?\r?\n\}/, 'pluginSettingLabel'),
        lift(/export function pluginSettingDisplayLabel\(key, schema\) \{[\s\S]*?\r?\n\}/, 'pluginSettingDisplayLabel'),
        lift(/export function renderPluginSettingControl\(key, schema, idPrefix = 'shotupload'\) \{[\s\S]*?\r?\n\}/, 'renderPluginSettingControl'),
    ].join('\n');
    // getTranslation is identity here: untranslated strings fall back to the
    // source string, so the manifest text is what reaches the page.
    return new Function('getTranslation',
        `${body}\nreturn { renderPluginSettingControl, pluginSettingLabel };`)(k => k);
})();

// The manifest shot-upload 0.2.1 actually ships.
const shotUploadSchema = {
    AutoUpload: {
        type: 'boolean',
        description: 'Upload shots automatically when they finish (opt-in; off by default)',
        default: false,
    },
    LengthThreshold: {
        type: 'number',
        description: 'Only upload shots longer than this many seconds (skips flushes)',
        default: 5,
    },
};

test('every sentence on the page comes from the manifest, not from settings.js', () => {
    const html = Object.keys(shotUploadSchema)
        .map(k => shotUpload.renderPluginSettingControl(k, shotUploadSchema[k])).join('');
    for (const [key, schema] of Object.entries(shotUploadSchema)) {
        assert.ok(html.includes(schema.description), `manifest text for ${key} is not on the page`);
        assert.ok(html.includes(`data-setting-key="${key}"`), `${key} has no control`);
    }
});

test('a setting the manifest does not declare gets no control', () => {
    // Nothing is rendered for a key the schema is silent about -- which is how a
    // setting removed upstream (DrainHistory, gone in 0.2.1) leaves the page
    // without this file changing. Against a 0.2.0 manifest the same code draws
    // it, because there the schema still declares it.
    const html = Object.keys(shotUploadSchema)
        .map(k => shotUpload.renderPluginSettingControl(k, shotUploadSchema[k])).join('');
    assert.ok(!html.includes('DrainHistory'));

    const withIt = shotUpload.renderPluginSettingControl('DrainHistory', {
        type: 'boolean',
        description: 'Also upload shots already in your history, a few at a time while the machine is idle (opt-in; off by default)',
    });
    assert.ok(withIt.includes('data-setting-key="DrainHistory"'));
});

test('the label is derived from the key, never invented', () => {
    assert.equal(shotUpload.pluginSettingLabel('AutoUpload'), 'Auto Upload');
    assert.equal(shotUpload.pluginSettingLabel('LengthThreshold'), 'Length Threshold');
    assert.equal(shotUpload.pluginSettingLabel('drain_history'), 'drain history');
});

test('each declared type gets its own widget', () => {
    const bool = shotUpload.renderPluginSettingControl('AutoUpload', shotUploadSchema.AutoUpload);
    const num = shotUpload.renderPluginSettingControl('LengthThreshold', shotUploadSchema.LengthThreshold);
    assert.match(bool, /type="checkbox" id="shotupload-setting-AutoUpload"/);
    assert.match(num, /type="number" id="shotupload-setting-LengthThreshold"/);
});

test('an enum renders a closed list of the manifest values', () => {
    // The API rejects a value outside `values`, so free text would let the page
    // offer something the bridge refuses to store.
    const html = shotUpload.renderPluginSettingControl('Roast', { type: 'enum', values: ['Light', 'Dark'] });
    assert.match(html, /<select id="shotupload-setting-Roast"[^>]*data-setting-type="enum"/);
    assert.match(html, /<option value="Light">Light<\/option>/);
    assert.match(html, /<option value="Dark">Dark<\/option>/);
});

test('an enum missing its values list renders nothing rather than an empty menu', () => {
    assert.equal(shotUpload.renderPluginSettingControl('Roast', { type: 'enum' }), '');
});

test('a type with no widget renders nothing rather than a broken control', () => {
    // The caller logs this, which is the prompt to add the widget. A half-drawn
    // control that silently discards writes would be worse than an absent one.
    assert.equal(shotUpload.renderPluginSettingControl('Mystery', { type: 'colour' }), '');
    assert.equal(shotUpload.renderPluginSettingControl('Missing', undefined), '');
});

test("the manifest's own label wins over the name derived from the storage key", () => {
    // PluginSettingSchema.label exists so a form can read "Upload shots
    // automatically" instead of "AutoUpload".
    const labelled = shotUpload.renderPluginSettingControl('AutoUpload', {
        type: 'boolean', label: 'Upload shots automatically',
    });
    assert.match(labelled, /Upload shots automatically/);
    assert.doesNotMatch(labelled, />Auto Upload</);
});

test('an absent, empty or whitespace label falls back to the split key', () => {
    // The spec says clients fall back, so a manifest written before labels
    // existed renders exactly as it did before.
    for (const schema of [{ type: 'boolean' }, { type: 'boolean', label: '' }, { type: 'boolean', label: '   ' }]) {
        assert.match(shotUpload.renderPluginSettingControl('AutoUpload', schema), />Auto Upload</);
    }
});

test('a secure setting is typed apart from a plain string so its writes differ', () => {
    // A secure value comes back as { isSet } and must never be assigned into
    // the field or echoed back as the credential; the write path keys off this.
    const secret = shotUpload.renderPluginSettingControl('Password', { type: 'string', secure: true });
    const open = shotUpload.renderPluginSettingControl('ServerUrl', { type: 'string' });
    assert.match(secret, /data-setting-type="secure"/);
    assert.match(open, /data-setting-type="string"/);
});

test('a secure string is not rendered in the clear', () => {
    // `secure` is the manifest's own flag (visualizer's Password sets it). A
    // plain text input for it would put the value on a shared kitchen screen.
    const open = shotUpload.renderPluginSettingControl('ServerUrl', { type: 'string' });
    const secret = shotUpload.renderPluginSettingControl('Password', { type: 'string', secure: true });
    assert.match(open, /type="text" id="shotupload-setting-ServerUrl"/);
    assert.match(secret, /type="password" id="shotupload-setting-Password"/);
});

test('the id prefix keeps two pages rendering the same schema apart', () => {
    // Shot Uploader and Print The Shot both draw a plugin's schema; colliding
    // element ids would make each page read the other's control.
    const shot = shotUpload.renderPluginSettingControl('AutoUpload', shotUploadSchema.AutoUpload);
    const print = shotUpload.renderPluginSettingControl('AutoUpload', shotUploadSchema.AutoUpload, 'printtheshot');
    assert.match(shot, /id="shotupload-setting-AutoUpload"/);
    assert.match(print, /id="printtheshot-setting-AutoUpload"/);
});

test('manifest text is escaped, not injected', () => {
    // The manifest is a file on disk that a sideloaded plugin controls.
    const html = shotUpload.renderPluginSettingControl('X', {
        type: 'boolean',
        description: '<img src=x onerror=alert(1)>',
    });
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
});

// Plugin authors append their own ui URL to the description (decent-profile and
// settings both do). The list renders that endpoint as an Open button next to
// the plugin name, so printing the URL again in the body text is a duplicate of
// a link nobody can usefully read.
const descMatch = source.match(/^function pluginDescription\(plugin\) \{[\s\S]*?\r?\n\}/m);
assert.ok(descMatch, 'pluginDescription not found in settings.js');
const pluginDescription = new Function(`${descMatch[0]}\nreturn pluginDescription;`)();

test('a bridge ui URL is dropped from the end of a description', () => {
    assert.equal(
        pluginDescription({ description: 'Shows settings in a page. http://localhost:8080/api/v1/plugins/settings.reaplugin/ui' }),
        'Shows settings in a page.',
    );
});

test('a description with no URL is untouched', () => {
    const text = 'Bean and shot workflow for Decent Espresso.';
    assert.equal(pluginDescription({ description: text }), text);
});

test('a link to somewhere other than the bridge survives', () => {
    // Only the endpoint the Open button already covers is redundant; a plugin
    // pointing at its own docs is telling the reader something new.
    const text = 'See https://github.com/decentespresso/decaid for setup.';
    assert.equal(pluginDescription({ description: text }), text);
});

test('a missing description reads as empty, not "undefined"', () => {
    assert.equal(pluginDescription({}), '');
    assert.equal(pluginDescription(null), '');
});

test('plugin endpoint errors expose safe JSON messages and status metadata', () => {
    const apiSource = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
    const match = apiSource.match(/function pluginEndpointError\(pluginId, endpoint, status, errorBody\) \{[\s\S]*?\r?\n\}/);
    assert.ok(match, 'pluginEndpointError not found in api.js');
    const pluginEndpointError = new Function(`${match[0]}\nreturn pluginEndpointError;`)();
    const error = pluginEndpointError('calibrated-steam.reaplugin', 'calculate', 422,
        JSON.stringify({ code: 'invalid_milk_weight', message: 'Milk < 10 g · Medium pitcher' }));
    assert.equal(error.message, 'Milk < 10 g · Medium pitcher');
    assert.equal(error.status, 422);
    assert.equal(error.code, 'invalid_milk_weight');
});
