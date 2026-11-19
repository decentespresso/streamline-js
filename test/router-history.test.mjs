import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync('src/modules/router.js', 'utf8');

test('popstate renders without writing another history entry', () => {
    assert.match(source, /loadPage\(event\.state\.pageUrl, \{ history: 'none' \}\)/);
    assert.match(source, /showMainPage\(\{ history: 'none' \}\)/);
});

test('direct routes replace while user navigation pushes by default', () => {
    assert.match(source, /loadPage\(pageUrl, \{ history: 'replace' \}\)/);
    assert.match(source, /loadPage\(pageUrl, \{ history = 'push' \} = \{\}\)/);
});


test('leaving a visible main page dispatches the hidden lifecycle event', () => {
    assert.match(source, /const mainPageWasVisible = mainPage && mainPage\.style\.display !== 'none';/);
    assert.match(source, /mainPage\.style\.display = 'none';\s*if \(mainPageWasVisible\) \{\s*hidMainPage = true;\s*document\.dispatchEvent\(new Event\('streamline:mainpagehidden'\)\);/);
    assert.match(source, /if \(hidMainPage\) document\.dispatchEvent\(new Event\('streamline:mainpagevisible'\)\);/);
});

test('the previous page is recorded before a page inits, so the editor can return to it', () => {
    // markCurrentPage has to run ahead of the per-page init block below it --
    // profile_editor.js reads getPreviousPageUrl() inside its init.
    const markIdx = source.indexOf('markCurrentPage(pageUrl);');
    const initIdx = source.indexOf("pageUrl.includes('profile_editor.html')");
    assert.ok(markIdx > 0 && initIdx > markIdx, 'markCurrentPage must precede the page init');
    assert.match(source, /markCurrentPage\(null\);/);
    // Re-entering the same page must not make it its own previous page.
    assert.match(source, /if \(pageUrl === currentPageUrl\) return;/);

    const editor = readFileSync('src/modules/profile_editor.js', 'utf8');
    assert.match(editor, /_returnUrl = getPreviousPageUrl\(\) \|\| 'index\.html';/);
    // Cancel goes back where the user came from; a save ends on the main page.
    assert.equal((editor.match(/loadPage\(_returnUrl\)/g) || []).length, 1);
    assert.match(editor, /function finishSaveSuccess[\s\S]*?loadPage\('index\.html'\)/);
});

test('a back into a spent editor entry replaces it with the return page, silently', () => {
    const editor = readFileSync('src/modules/profile_editor.js', 'utf8');
    assert.ok(editor.includes("loadPage(_returnUrl, { history: 'replace' })"));
    assert.ok(!editor.includes('No profile data found'));
});
