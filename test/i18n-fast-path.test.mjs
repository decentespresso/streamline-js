import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SUPPORTED_LANGUAGES, parseTranslationColumn, matchLanguage, resolveLanguage } from '../src/modules/i18n-parser.js';

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
    assert.match(body, /localLanguage \|\| resolveLanguage\(deviceLanguages\) \|\| 'en'/);
});
