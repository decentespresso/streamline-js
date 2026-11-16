import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const history = readFileSync(new URL('../src/modules/history.js', import.meta.url), 'utf8');
const idb = readFileSync(new URL('../src/modules/idb.js', import.meta.url), 'utf8');

test('history startup reads only one indexed summary page', () => {
    assert.match(history, /fetchSummaryPage: \(offset, limit\) => getLatestShotSummaries\(limit, offset\)/);
    assert.doesNotMatch(history, /getAllShots/);
    assert.match(idb, /index\('by_timestamp'\)[\s\S]*openCursor\(null, 'prev'\)/);
});

test('history pages use one bulk summary write', () => {
    assert.match(history, /await addShots\(data\.items \?\? \[\]\)/);
    assert.match(idb, /const \{ measurements, \.\.\.summary \} = shot;/);
    assert.match(idb, /SHOT_SUMMARIES_STORE_NAME = 'shot_summaries'/);
    assert.doesNotMatch(idb, /deleteObjectStore\(EMAILS_STORE_NAME\)/);
});

test('history record changes stay synchronized with the pager', () => {
    assert.match(history, /shots = historyPager\.update\(fastShot\)/);
    assert.match(history, /shots = historyPager\.update\(\{ \.\.\.shots\[idx\], \.\.\.updated \}\)/);
    assert.doesNotMatch(history, /shots\[0\] = fastShot/);
});

test('version 9 seeds and backfills summaries from version 8 shots', () => {
    assert.match(idb, /event\.oldVersion > 0 && event\.oldVersion < 9/);
    assert.match(idb, /seedShotSummaries\(shotsStore, shotSummariesStore\)/);
    assert.match(idb, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
    assert.match(idb, /SUMMARY_BACKFILL_SIZE = 100/);
    assert.match(idb, /repairMissingSummarySeed/);
    assert.match(idb, /needed = summaryCount < shotCount/);
});

// --- applyHistoryPage's selection, lifted out of history.js -----------------
// Same approach as history-nav-gate.test.mjs: extract the function and run it
// against stubs, so the behaviour is covered without jsdom.
function pageHarness(startShots, startIndex) {
    const match = history.match(/function applyHistoryPage\(page\)[\s\S]*?\n\}/);
    assert.ok(match, 'applyHistoryPage not found in history.js');
    const repainted = [];
    const factory = new Function(
        'startShots', 'startIndex', 'displayShot', 'logger',
        `let shots = startShots;
         let currentShotIndex = startIndex;
         let historyHasMore = false;
         ${match[0]}
         return {
             applyHistoryPage,
             index: () => currentShotIndex,
             selected: () => shots[currentShotIndex]?.id ?? null,
             reviewing: () => currentShotIndex > 0,
         };`
    );
    const api = factory(startShots, startIndex, async (i) => { repainted.push(i); }, { warn() {} });
    return { ...api, repainted };
}

const page = (ids) => ({ shots: ids.map(id => ({ id })), hasMore: false, errors: [] });

test('a shot landing while the panel is on NEWEST keeps it on NEWEST', () => {
    // The reported bug: following the selection by id shifted index 0 to 1, so
    // isReviewingHistory() stayed true and app.js held the live chart back for
    // the next shot until the user stepped through history and back.
    const h = pageHarness(page(['b', 'c']).shots, 0);
    h.applyHistoryPage(page(['a', 'b', 'c']));
    assert.equal(h.index(), 0);
    assert.equal(h.selected(), 'a', 'the new shot is the one on screen');
    assert.equal(h.reviewing(), false, 'the live chart must not be held back');
    assert.deepEqual(h.repainted, []);
});

test('a shot landing while a past shot is on screen keeps that shot', () => {
    const h = pageHarness(page(['b', 'c', 'd']).shots, 1);
    h.applyHistoryPage(page(['a', 'b', 'c', 'd']));
    assert.equal(h.selected(), 'c', 'the reader stays on the shot they were reading');
    assert.equal(h.index(), 2, 'its position just shifts along');
    assert.deepEqual(h.repainted, []);
});

test('a pruned selection lands on the neighbour and repaints it', () => {
    const h = pageHarness(page(['a', 'b', 'c']).shots, 2);
    h.applyHistoryPage(page(['a', 'b']));
    assert.equal(h.index(), 1);
    assert.deepEqual(h.repainted, [1], 'Delete and edit must act on the shot on screen');
});

test('an empty page with nothing selected leaves the index alone', () => {
    const empty = pageHarness([], -1);
    empty.applyHistoryPage(page(['a']));
    assert.equal(empty.index(), -1, 'initHistory() still owns the first paint');

    const cleared = pageHarness(page(['a', 'b']).shots, 1);
    cleared.applyHistoryPage(page([]));
    assert.equal(cleared.index(), -1);
});
