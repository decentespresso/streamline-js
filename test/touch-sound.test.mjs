import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSoundTarget, TOUCH_SOUND_KEY } from '../src/modules/touch-sound.js';

// A fake ancestor walk: each element lists the selectors it (or an ancestor)
// matches, so the policy can be exercised without a DOM.
const el = (matches = [], extra = {}) => ({ matches, ...extra });
const closest = (node, selector) => {
    if (!node?.matches) return null;
    const wanted = selector.split(',').map(s => s.trim());
    return node.matches.some(m => wanted.includes(m)) ? node : null;
};
const check = (node) => isSoundTarget(node, closest);

test('isSoundTarget: controls click, scenery does not', () => {
    assert.equal(check(el(['button'])), true);
    assert.equal(check(el(['[role="button"]'])), true);
    assert.equal(check(el(['input[type="checkbox"]'])), true);
    assert.equal(check(el(['a[href]'])), true);
    assert.equal(check(el(['[data-tile]'])), true, 'a dashboard tile is a control');
    assert.equal(check(el(['[data-auto-pitcher]'])), true, 'and so is a preset');

    assert.equal(check(el([])), false, 'the page background stays silent');
    assert.equal(check(el(['div'])), false);
    assert.equal(check(null), false);
    assert.equal(check(undefined), false);
});

test('isSoundTarget: a disabled control and an opt-out stay silent', () => {
    assert.equal(check(el(['button'], { disabled: true })), false);
    assert.equal(check(el(['button', '[data-no-sound]'])), false);
});

test('isSoundTarget: a target with no closest at all is survivable', () => {
    // document, or a node from another tree: no closest method, no crash.
    assert.equal(isSoundTarget({}), false);
});

test('the key is the synchronized one', () => {
    assert.equal(TOUCH_SOUND_KEY, 'streamline.touchSound',
        'settingsSync.js carries this exact string; renaming one without the other silently stops syncing');
});
