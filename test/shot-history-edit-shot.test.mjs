import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Tap the shot-history info block -> DYE2's edit-shot page for the shot on screen.
// history.js cannot be imported under node (chart/idb/DOM at module load), so the tap
// handler is lifted out and run with its dependencies injected -- the same trick as
// dye-strip-clear.test.mjs. The wiring around it (which element, which gate) is checked
// on the source.

const historySrc = readFileSync(new URL('../src/modules/history.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const uiSrc = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
const stripSrc = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');

// Comments name the identifiers asserted on below, so match against code only.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(line => (line.trim().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
        .join('\n');
}

function liftHandler() {
    const start = historySrc.indexOf('function openShotInDye2()');
    const end = historySrc.indexOf('\nfunction setupHistoryLongPress()', start);
    assert.ok(start > 0 && end > start, 'openShotInDye2 found');
    return historySrc.slice(start, end);
}

function runHandler({ enabled, shots, currentShotIndex }) {
    const calls = { opened: [], toasted: [], refreshed: [] };
    const fn = new Function(
        'isDye2Enabled', 'openPluginOverlay', 'showToast', 'getTranslation', 'logger',
        'shots', 'currentShotIndex', 'refreshShotAfterDye2Edit',
        `${liftHandler()}\nreturn openShotInDye2;`
    );
    const handler = fn(
        () => enabled,
        (...args) => calls.opened.push(args),
        (...args) => calls.toasted.push(args),
        key => key,
        { warn: () => {} },
        shots,
        currentShotIndex,
        id => { calls.refreshed.push(id); return Promise.resolve(); }
    );
    handler();
    return calls;
}

test('the info block is the tap target, not the arrows or the label', () => {
    const idAt = html.indexOf('id="shot-history-info"');
    assert.ok(idAt > 0, 'the info block has a stable hook');
    const tag = html.slice(html.lastIndexOf('<div', idAt), html.indexOf('>', idAt) + 1);
    assert.match(tag, /aria-live="polite"/, 'it is the live info block, not the panel');
    assert.ok(!tag.includes('history-prev-btn') && !tag.includes('history-next-btn'),
        'the nav arrows are outside it');
});

test('a tap opens edit-shot for the shot on screen, gated on DYE2', () => {
    const off = runHandler({ enabled: false, shots: [{ id: 'shot-a' }], currentShotIndex: 0 });
    assert.equal(off.opened.length, 0, 'DYE2 off: the info block is inert');

    const on = runHandler({ enabled: true, shots: [{ id: 'shot-a' }, { id: 'shot-b' }], currentShotIndex: 1 });
    assert.equal(on.opened.length, 1, 'DYE2 on: one overlay opens');
    const [page, params, onClose] = on.opened[0];
    assert.equal(page, 'edit-shot');
    assert.deepEqual(params, { shotId: 'shot-b' }, 'the displayed shot travels in the URL');
    assert.equal(typeof onClose, 'function', 'the caller can repaint when DYE2 returns');

    // Closing without a save must not refetch; coming back through the sentinel must.
    onClose(false);
    assert.deepEqual(on.refreshed, [], 'the Close button does not touch history');
    onClose(true);
    assert.deepEqual(on.refreshed, ['shot-b'], 'a save/delete refresh targets the opened shot');
    // DYE2 hands back the shot it was showing on the way out, which wins: the arrows may
    // have moved the user off the shot the overlay was opened for.
    onClose(true, 'shot-other');
    assert.deepEqual(on.refreshed.slice(-1), ['shot-other'], 'the live shot wins over the opened one');
});

test('no shot on screen says so instead of opening an empty page', () => {
    const calls = runHandler({ enabled: true, shots: [], currentShotIndex: -1 });
    assert.equal(calls.opened.length, 0);
    assert.equal(calls.toasted.length, 1);
    assert.equal(calls.toasted[0][0], 'No shot selected');
});

test('the panel routes only info-area taps to the handler', () => {
    const code = stripComments(historySrc);
    const start = code.indexOf('function setupHistoryLongPress()');
    const body = code.slice(start, code.indexOf('\n}\n', start));
    assert.ok(body.includes("closest?.('#shot-history-info')"),
        'an arrow tap bubbles to the panel and must be ignored');
    assert.ok(body.indexOf('closest?') < body.indexOf('openShotInDye2()'),
        'the guard runs before the overlay opens');
});

test('returning from edit-shot repaints the shot that was opened', () => {
    const code = stripComments(historySrc);
    const start = code.indexOf('export async function refreshShotAfterDye2Edit(');
    assert.ok(start > 0, 'refreshShotAfterDye2Edit found');
    const body = code.slice(start, code.indexOf('\n}\n', start));
    assert.ok(body.includes('response.status === 404'), 'a delete made in DYE2 is detected');
    assert.ok(body.includes('historyPager.remove(id)'), 'and the shot leaves the window');
    assert.ok(body.includes('historyPager.update('), 'an edit is merged in place');
    assert.ok(body.includes('displayShot('), 'so the panel repaints instead of resetting');
    // A full reload would walk the user back to the newest page after editing an old shot.
    assert.ok(!body.includes('loadShotHistory('), 'no window reload');
});

test('the press-and-hold helper hands the click event to its callback', () => {
    const code = stripComments(uiSrc);
    assert.ok(code.includes('return clickCallback(event);'),
        'a card that owns sub-regions needs the event to tell them apart');
});

test('the overlay hands the shot DYE2 was showing back to the caller', () => {
    const code = stripComments(stripSrc);
    assert.ok(code.includes('export function openPluginOverlay(page, params, onClose)'));
    const start = code.indexOf('function closePluginOverlay(');
    const body = code.slice(start, code.indexOf('\n}\n', start));
    assert.ok(body.includes('hook(!!refresh, editedShotId || null)'),
        'the caller gets both the save flag and the live shot id');
    assert.ok(code.includes("searchParams.get('dyeShot')"),
        'the live shot comes back on the sentinel URL');
    assert.ok(code.includes("close.addEventListener('click', () => closePluginOverlay(false))"),
        'the skin Close button must not look like a sentinel return');
});
