// Which profile record a tile edit (dose / yield / grind / brew temp) gets
// saved onto. The bug this pins: the id was resolved only against the five
// favourite slots, so a loaded profile that sat in no slot resolved to nothing
// and the edit was silently dropped instead of stored in profile metadata.
// Run: node --test test/active-profile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfileKeyByTitle } from '../src/modules/active-profile.js';

const profiles = {
    'profile:aaa': { profile: { title: 'Londonium' }, isDefault: true },
    'profile:bbb': { profile: { title: 'Blooming Espresso' }, isDefault: true },
    'profile:ccc': { profile: { title: 'Londonium' } },            // user fork
    'profile:ddd': { profile: { title: 'Café crème' }, isDefault: true },
};

test('resolves a profile that is on no favourite button', () => {
    assert.equal(resolveProfileKeyByTitle(profiles, 'Blooming Espresso'), 'profile:bbb');
});

test('prefers the user fork over the same-titled bundled default', () => {
    assert.equal(resolveProfileKeyByTitle(profiles, 'Londonium'), 'profile:ccc');
});

test('matches the translated title shown in #profile-name', () => {
    const translate = t => (t === 'Café crème' ? 'Milchkaffee' : t);
    assert.equal(resolveProfileKeyByTitle(profiles, 'Milchkaffee', translate), 'profile:ddd');
});

test('unknown / empty titles resolve to nothing rather than a wrong profile', () => {
    for (const bad of [null, undefined, '', '   ', 'Not A Profile']) {
        assert.equal(resolveProfileKeyByTitle(profiles, bad), null);
    }
});

// ── The profile selector must not preview the wrong profile ─────────────────
//
// findActiveProfileKey() only answers once the main page has bound the active
// profile, and that runs off loadInitialData, which waits on the DE1
// connecting. Tapping the profile name inside that window left the selector on
// its first row: the preview graph drew a profile the machine wasn't running,
// and CONFIRM would have sent it. The page now falls back to the workflow's own
// title. The source is checked rather than imported because profile_selector.js
// needs browser globals, as in plugin-list.test.mjs.

test('the selector re-resolves a fallback selection from the workflow', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/modules/profile_selector.js', import.meta.url), 'utf8');

    // The fallback (first row) is what marks the selection as untrustworthy.
    assert.match(source, /selectionIsFallback = !initialKey;/);

    const correction = source.match(/if \(selectionIsFallback\) \{[\s\S]*?\n    \}/);
    assert.ok(correction, 'no workflow correction after the profiles land');
    assert.match(correction[0], /await getWorkflow\(\)/);
    assert.match(correction[0], /resolveProfileKeyByTitle\(availableProfiles, workflow\?\.profile\?\.title/);
    // Re-selection goes through renderProfiles so the row highlight, the notes
    // and plotProfile() all move together.
    assert.match(correction[0], /selectedProfileKey = null;\s*\n\s*renderProfiles\(\);/);
});
