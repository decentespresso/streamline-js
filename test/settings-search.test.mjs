import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
    pluginKeywords,
    pluginListKeywords,
    subcategoryMatches,
    categoryMatches,
    searchTokens,
    highlightTokens,
    textFromHtml,
} from '../src/modules/settings-search.js';

const MARK = (t) => `<mark class="bg-yellow-300 text-black">${t}</mark>`;

test('settings search highlights punctuation literally', () => {
    const cases = [
        ['Group (temperature)', '('],
        ['Value [raw]', '['],
        ['Path C:\\data', '\\'],
        ['Version 1.2', '.'],
    ];

    for (const [text, term] of cases) {
        assert.equal(highlightTokens(text, term), text.replace(term, MARK(term)));
    }
});

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');

test('settings search keeps navigation stable and waits for explicit activation', () => {
    assert.doesNotMatch(source, /cloneNode\(/);
    assert.doesNotMatch(source, /restoreOriginalNavigation|updateNavigationWithResults/);
    assert.match(source, /dataset\.settingsSearchResults/);
    assert.match(source, /setTimeout\(\(\) => renderResults\(searchTerm\), 125\)/);
    assert.match(source, /event\.key !== 'Enter'/);
});

// The settings nav only knows page names, so searching for a setting used to
// require knowing which page holds it. Plugin name, description and manifest
// setting declarations (GET /plugins) are folded in as keywords -- the case that
// motivated this is typing "upload" and reaching the Visualizer plugin's
// AutoUpload setting.

const visualizer = {
    id: 'visualizer.reaplugin',
    name: 'Visualizer upload',
    description: 'Uploads the latest shot to Visualizer',
    settings: {
        Username: { type: 'string', description: 'Visualiser username' },
        Password: { type: 'string', secure: true, description: 'Visualiser password' },
        AutoUpload: { type: 'boolean', description: 'Upload shots automatically' },
        LengthThreshold: { type: 'number', description: 'Only upload shots longer than the threshold' },
    },
};

test('a plugin indexes its name, description and id', () => {
    const kw = pluginKeywords(visualizer);
    assert.ok(kw.includes('visualizer upload'));
    assert.ok(kw.includes('uploads the latest shot'));
    assert.ok(kw.includes('visualizer.reaplugin'));
});

test('setting names and their descriptions are indexed', () => {
    const kw = pluginKeywords(visualizer);
    assert.ok(kw.includes('autoupload'));
    assert.ok(kw.includes('threshold'));
    assert.ok(kw.includes('visualiser password'));
});

test('hidden fields do not send search users to controls that are not on the page', () => {
    const kw = pluginKeywords({
        id: 'custom.reaplugin', name: 'Custom settings', description: 'Open the configuration page',
        settings: {
            internalReadings: { hidden: true, description: 'Serialized measurement shadow' },
            AutoUpload: { hidden: false, description: 'Upload automatically' },
        },
    });
    assert.ok(kw.includes('custom settings'));
    assert.ok(kw.includes('open the configuration page'));
    assert.ok(kw.includes('auto upload'));
    assert.doesNotMatch(kw, /internal|readings|serialized|measurement|shadow/);
});

test('a PascalCase setting name is also indexed word by word', () => {
    // Without the split, searching "upload" would miss "AutoUpload".
    assert.ok(pluginKeywords(visualizer).includes('auto upload'));
    assert.ok(pluginKeywords({ settings: { Wake_lock: {} } }).includes('wake lock'));
});

test('everything indexed is lowercase, since the search term is lowercased', () => {
    const kw = pluginKeywords(visualizer);
    assert.equal(kw, kw.toLowerCase());
});

test('a plugin with no settings or no fields at all is harmless', () => {
    assert.equal(pluginKeywords(null), '');
    assert.equal(pluginKeywords({}), '');
    assert.equal(pluginKeywords({ name: 'Bare' }), 'bare');
});

test('the Plugins page answers for every installed plugin', () => {
    const kw = pluginListKeywords([visualizer, { id: 'dye2.reaplugin', name: 'DYE2' }]);
    assert.ok(kw.includes('autoupload'));
    assert.ok(kw.includes('dye2'));
    assert.deepEqual(pluginListKeywords(null), '');
});

test('a subcategory still matches on its own name and id', () => {
    const subcat = { id: 'extention2', name: 'Plugins', settingsCategory: 'plugins' };
    assert.equal(subcategoryMatches(subcat, 'plug'), true);
    assert.equal(subcategoryMatches(subcat, 'extention'), true);
    assert.equal(subcategoryMatches(subcat, 'upload'), false);
});

test('keywords make a plugin setting reachable from the page that hosts it', () => {
    const subcat = { id: 'extention1', name: 'Visualizer', keywords: pluginKeywords(visualizer) };
    assert.equal(subcategoryMatches(subcat, 'upload'), true);
    assert.equal(subcategoryMatches(subcat, 'threshold'), true);
    assert.equal(subcategoryMatches(subcat, 'grinder'), false);
});

test('matching is case-insensitive and an empty term matches everything', () => {
    const subcat = { id: 'extention1', name: 'Visualizer', keywords: pluginKeywords(visualizer) };
    assert.equal(subcategoryMatches(subcat, 'UPLOAD'), true);
    assert.equal(subcategoryMatches(subcat, ''), true);
});

// ── Every search word matches, and every one gets highlighted ───────────────

test('a query is a set of words, all of which must appear', () => {
    // "shot upload" used to find nothing: no label contains that exact string.
    const subcat = { name: 'Shot Uploader', pageText: 'upload existing shot history' };
    assert.equal(subcategoryMatches(subcat, 'shot upload'), true);
    assert.equal(subcategoryMatches(subcat, 'upload shot'), true);      // order is irrelevant
    assert.equal(subcategoryMatches(subcat, 'existing history'), true); // both from page text
    assert.equal(subcategoryMatches(subcat, 'shot steam'), false);      // one word missing
});

test('an empty query matches everything', () => {
    assert.equal(subcategoryMatches({ name: 'Steam' }, ''), true);
    assert.equal(subcategoryMatches({ name: 'Steam' }, '   '), true);
    assert.equal(categoryMatches('Machine', ''), true);
    assert.deepEqual(searchTokens('  '), []);
});

test('main categories match on words too', () => {
    assert.equal(categoryMatches('Quick Adjustments', 'quick adjust'), true);
    assert.equal(categoryMatches('Quick Adjustments', 'adjustments quick'), true);
    assert.equal(categoryMatches('Quick Adjustments', 'quick steam'), false);
});

test('every search word is highlighted, wherever it lands', () => {
    assert.equal(
        highlightTokens('Upload existing shot history', 'shot upload'),
        `${MARK('Upload')} existing ${MARK('shot')} history`,
    );
});

test('highlighting never marks up the markup it just inserted', () => {
    // "mark", "black" and "bg" all occur in the <mark> tag this emits. A pass
    // per word would highlight inside the previous pass's tag and produce
    // nested garbage; one alternation over the original text cannot.
    const out = highlightTokens('Mark the black background', 'mark black bg');
    assert.equal(out, `${MARK('Mark')} the ${MARK('black')} background`);
    assert.equal((out.match(/<mark/g) || []).length, 2);
});

test('the longest word wins where two overlap', () => {
    // "temp" also occurs inside "temperature"; the longer word claims it.
    assert.equal(highlightTokens('temperature', 'temp temperature'), MARK('temperature'));
});

test('page text is read out of the rendered HTML, minus tags and scripts', () => {
    const html = `<div class="flex"><p data-i18n-key="Upload existing shot history">Upload existing shot history</p>
        <script>const secret = 1;</script><style>.a{color:red}</style>
        <span>Sends&nbsp;shots &amp; more</span></div>`;
    const text = textFromHtml(html);
    assert.equal(text, 'upload existing shot history sends shots & more');
    assert.ok(!text.includes('secret'));   // script bodies are not searchable words
    assert.ok(!text.includes('color'));    // nor are stylesheets
    assert.ok(!text.includes('div'));      // nor tag names
});

test('page text makes on-screen copy findable', () => {
    // The motivating case: "history" appears only in the toggle's subtitle.
    const subcat = {
        name: 'Shot Uploader',
        settingsCategory: 'shotupload',
        pageText: textFromHtml('<p>Upload existing shot history, a few at a time while the machine is idle.</p>'),
    };
    assert.equal(subcategoryMatches(subcat, 'history'), true);
    assert.equal(subcategoryMatches(subcat, 'idle machine'), true);
    assert.equal(subcategoryMatches({ name: 'Shot Uploader' }, 'history'), false);
});
