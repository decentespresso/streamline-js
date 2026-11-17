import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { test } from 'node:test';
import { SUPPORTED_LANGUAGES, parseTranslationColumn, matchLanguage, resolveLanguage, preferredLanguage } from '../src/modules/i18n-parser.js';

test('the cheap language list matches the translation sheet header', () => {
    const csv = readFileSync(new URL('../src/ui/de1 gui translation - Sheet1.csv', import.meta.url), 'utf8');
    const header = csv.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].split(',').map(value => value.trim());
    assert.deepEqual(SUPPORTED_LANGUAGES, header);
});

test('the parser retains only the requested column and handles quoted CSV values', () => {
    const csv = '\uFEFFen,de,fr\nHello,Hallo,Bonjour\n"With, comma","Mit, Komma","Avec, virgule"\n"Quote ""here""","Zitat ""hier""","Citation"\nFallback,,Repli';
    const { table, keyIndex } = parseTranslationColumn(csv, 'de');
    assert.deepEqual(table, {
        Hello: 'Hallo',
        'With, comma': 'Mit, Komma',
        'Quote "here"': 'Zitat "hier"',
        Fallback: 'Fallback',
    });
    assert.equal(keyIndex['with, comma'], 'With, comma');
    assert.equal(JSON.stringify(table).includes('Bonjour'), false);
});

test('selecting English does not request the translation sheet', async () => {
    const fetchCalls = [];
    globalThis.fetch = (...args) => {
        fetchCalls.push(args);
        throw new Error('English must not fetch translations');
    };
    globalThis.localStorage = { setItem() {} };
    globalThis.CustomEvent ??= class CustomEvent {
        constructor(type, options) {
            this.type = type;
            this.detail = options?.detail;
        }
    };
    globalThis.document = {
        body: { appendChild() {} },
        fonts: { status: 'loaded' },
        createElement: () => ({ style: {} }),
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener() {},
        dispatchEvent() {},
    };

    const { setLanguage } = await import(`../src/modules/i18n.js?english-fast-path=${Date.now()}`);
    assert.equal(await setLanguage('en'), 'en');
    assert.equal(fetchCalls.length, 0);
});

// ── device language detection ───────────────────────────────────────────────
// initI18n starts in the device's language when the user has not chosen one.
// The sheet's columns are not language codes -- Korean is `kr`, Chinese is split
// by script, partial languages carry `-unfinished` -- so matching a BCP-47 tag
// is a translation step, and getting it wrong silently starts in English.

test('device tags reach the column that actually holds their language', () => {
    assert.equal(matchLanguage('ko-KR'), 'kr');       // the column is the region, not `ko`
    assert.equal(matchLanguage('nb-NO'), 'no');       // Bokmål and Nynorsk share one column
    assert.equal(matchLanguage('nn-NO'), 'no');
    assert.equal(matchLanguage('iw-IL'), 'he');       // legacy Hebrew code, still sent by Android
    assert.equal(matchLanguage('ja-JP'), 'jp-unfinished');
    assert.equal(matchLanguage('ca-ES'), 'ca-unfinished');
});

test('Chinese picks the script, which the primary subtag does not carry', () => {
    for (const tag of ['zh-CN', 'zh-SG', 'zh-Hans-CN', 'zh']) {
        assert.equal(matchLanguage(tag), 'zh-hans', tag);
    }
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-HK']) {
        assert.equal(matchLanguage(tag), 'zh-hant', tag);
    }
});

test('a regional tag takes its own column only when the sheet has one', () => {
    assert.equal(matchLanguage('de-CH'), 'de-ch');
    // de-AT falls through to full German rather than the 45%-filled Austrian column.
    assert.equal(matchLanguage('de-AT'), 'de');
    assert.equal(matchLanguage('fr-CA'), 'fr');
    assert.equal(matchLanguage('pt-BR'), 'pt');
});

test('an unknown or empty tag matches nothing, so the caller can fall back to English', () => {
    for (const tag of ['xx-YY', 'klingon', '', null, undefined, 42]) {
        assert.equal(matchLanguage(tag), null, String(tag));
    }
});

test('a stored column name round-trips through the matcher', () => {
    // initI18n reads the saved preference through this too; every column must
    // map to itself or a saved choice would be lost on the next boot.
    for (const lang of SUPPORTED_LANGUAGES) assert.equal(matchLanguage(lang), lang, lang);
});

test('the device list is tried in preference order, not just its first entry', () => {
    assert.equal(resolveLanguage(['xx-YY', 'ko-KR', 'fr-FR']), 'kr');
    assert.equal(resolveLanguage(['xx', 'yy']), null);
    assert.equal(resolveLanguage([]), null);
    assert.equal(resolveLanguage(undefined), null);
    assert.equal(resolveLanguage('de-CH'), 'de-ch');   // a bare string is a list of one
});

test('initI18n reads the whole preference list and lets a stored choice win', () => {
    const source = readFileSync(new URL('../src/modules/i18n.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export async function initI18n'));
    assert.match(body, /navigator\.languages\?\.length \? navigator\.languages : \[navigator\.language\]/);
    assert.match(body, /preferredLanguage\(\{ stored, device: deviceLanguage, chosen \}\)/);
    // logger.info is a no-op unless debug is on, so the one line that explains a
    // wrong language in a field log has to go through audit.
    assert.match(body, /logger\.audit\(`i18n: device=/);
});

// ── toast coverage ──────────────────────────────────────────────────────────
// showToast translates its message, so a toast with no CSV row shows English in
// every language. This is the guard: a new toast either reuses an existing key
// or brings its own row.
test('every fixed toast message is a translation key', () => {
    const files = globSync('src/**/*.js').filter(f => !f.includes('.min.') && !f.includes('vendor/'));
    const csv = readFileSync(new URL('../src/ui/de1 gui translation - Sheet1.csv', import.meta.url), 'utf8');
    const keys = new Set(csv.split(/\r?\n/).map(line => (line.startsWith('"')
        ? (line.match(/^"((?:[^"]|"")*)"/) || [])[1]?.replace(/""/g, '"')
        : line.split(',')[0])).filter(Boolean));

    const missing = [];
    for (const file of files) {
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(/showToast\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
            const text = m[2];
            // Interpolated messages carry a runtime value, so they cannot be keys.
            if (text.includes('${') || !text.trim()) continue;
            if (!keys.has(text)) missing.push(`${file}: ${text}`);
        }
    }
    assert.deepEqual(missing, [], `toast strings with no CSV row:\n${missing.join('\n')}`);
});

test('showToast is the single place that translates toast text', () => {
    const ui = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
    const body = ui.slice(ui.indexOf('export function showToast'));
    assert.match(body, /messageEl\.textContent = getTranslation\(message\)/);
});

// ── stale stored language ───────────────────────────────────────────────────
// Boot persists whatever it resolved, so every install that ran a build with
// the old matcher has `en` stored as if it were a choice. Without this, the
// alias table ships and nothing changes on the tablets that needed it.
test('a language the user picked always wins', () => {
    assert.equal(preferredLanguage({ stored: 'en', device: 'zh-hant', chosen: true }), 'en');
    assert.equal(preferredLanguage({ stored: 'de', device: 'zh-hant', chosen: true }), 'de');
});

test('a stored English that nobody chose is re-detected', () => {
    assert.equal(preferredLanguage({ stored: 'en', device: 'zh-hant', chosen: false }), 'zh-hant');
    // Still English when the device gives us nothing to switch to.
    assert.equal(preferredLanguage({ stored: 'en', device: null, chosen: false }), 'en');
});

test('a stored language that is not English is kept, chosen or not', () => {
    // It matched a device once, so re-detecting could only undo a good answer.
    assert.equal(preferredLanguage({ stored: 'kr', device: 'zh-hant', chosen: false }), 'kr');
});

test('with nothing stored the device decides, and English is the last resort', () => {
    assert.equal(preferredLanguage({ stored: null, device: 'zh-hant', chosen: false }), 'zh-hant');
    assert.equal(preferredLanguage({ stored: null, device: null, chosen: false }), 'en');
    assert.equal(preferredLanguage(), 'en');
});

test('boot does not mark the language as chosen, and the picker does', () => {
    const i18n = readFileSync(new URL('../src/modules/i18n.js', import.meta.url), 'utf8');
    const init = i18n.slice(i18n.indexOf('export async function initI18n'));
    assert.match(init, /setLanguage\([\s\S]*?\{ chosen: false \}\)/);
    // The default is a real choice, so every picker call site marks it without
    // having to say so.
    assert.match(i18n, /export async function setLanguage\(lang, \{ chosen = true \} = \{\}\)/);
    assert.match(i18n, /if \(chosen\) localStorage\.setItem\(LANGUAGE_SOURCE_KEY, 'user'\)/);

    // A language arriving from KV is a stored value, not a fresh pick: marking
    // it chosen would re-pin the `en` an older build wrote as a boot default.
    const sync = readFileSync(new URL('../src/modules/settingsSync.js', import.meta.url), 'utf8');
    assert.match(sync, /setLanguage\(applied\.language, \{ chosen: false \}\)/);
});
