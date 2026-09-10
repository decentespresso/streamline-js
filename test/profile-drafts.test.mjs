// Regression pins for the "copy now, edit later" draft feature
// (profileManager.js draft CRUD + profile_editor.js saveDraftEdit +
// profile_selector.js's delete button). profileManager.js/profile_editor.js/
// profile_selector.js touch the DOM at import time, so — same technique as
// test/profile-save-routing.test.mjs — these inspect the real source text
// rather than importing the modules.
// Run: node --test test/profile-drafts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pmSource = readFileSync(new URL('../src/modules/profileManager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const editorSource = readFileSync(new URL('../src/modules/profile_editor.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const selectorSource = readFileSync(new URL('../src/modules/profile_selector.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('loadAvailableProfiles merges drafts in before overrides are folded on, in both branches', () => {
    // A draft's saved tile overrides are keyed to its draft id — if
    // applyOverridesToRecords runs before the draft record exists in
    // availableProfiles, it has nothing to attach the override to and the
    // draft silently reverts to its unmodified numbers on every reload.
    const successBlock = pmSource.slice(
        pmSource.indexOf('export async function loadAvailableProfiles()'),
        pmSource.indexOf('} catch (apiError)'));
    const draftsIdx = successBlock.indexOf('await loadProfileDrafts()');
    const applyIdx = successBlock.indexOf('applyOverridesToRecords(availableProfiles)');
    assert.ok(draftsIdx >= 0 && applyIdx >= 0, 'both calls must exist in the API-success branch');
    assert.ok(draftsIdx < applyIdx, 'loadProfileDrafts() must run before applyOverridesToRecords() in the API-success branch');

    const fallbackBlock = pmSource.slice(
        pmSource.indexOf('} catch (apiError)'),
        pmSource.indexOf('export function isValidAssignments') === -1
            ? pmSource.indexOf('function isValidAssignments')
            : pmSource.indexOf('export function isValidAssignments'));
    const fbDraftsIdx = fallbackBlock.indexOf('await loadProfileDrafts()');
    const fbApplyIdx = fallbackBlock.indexOf('applyOverridesToRecords(availableProfiles)');
    assert.ok(fbDraftsIdx >= 0 && fbApplyIdx >= 0, 'both calls must exist in the IndexedDB-fallback branch');
    assert.ok(fbDraftsIdx < fbApplyIdx, 'loadProfileDrafts() must run before applyOverridesToRecords() in the IndexedDB-fallback branch too');
});

test('saveDraftEdit de-dupes the title before deciding stay-draft vs promote', () => {
    const fnSrc = editorSource.slice(
        editorSource.indexOf('async function saveDraftEdit(draftRecord) {'),
        editorSource.indexOf('\nasync function saveProfile()'));
    const uniqueTitleIdx = fnSrc.indexOf('uniqueProfileTitle(');
    const execChangedIdx = fnSrc.indexOf('executionChanged(sourceProfile, editorState.profile)');
    assert.ok(uniqueTitleIdx >= 0, 'saveDraftEdit must call uniqueProfileTitle to avoid minting/renaming onto a title already in use');
    assert.ok(uniqueTitleIdx < execChangedIdx,
        'the title must be de-duped before branching on execChanged, so both the stay-draft and promote paths get the deduped title');
});

test('promoting a draft carries its tile overrides (dose/yield/grind/steam) to the new id', () => {
    const fnSrc = editorSource.slice(
        editorSource.indexOf('async function saveDraftEdit(draftRecord) {'),
        editorSource.indexOf('\nasync function saveProfile()'));
    assert.match(fnSrc, /getProfileOverride\(draftRecord\.id\)/,
        'promotion must check for an override saved under the draft\'s own id');
    assert.match(fnSrc, /saveProfileOverride\(saved\.id,/,
        'a carried-over override must be re-saved under the new server-assigned id');
    assert.match(fnSrc, /clearProfileOverride\(draftRecord\.id\)/,
        'the old draft-keyed override must be cleared once it has been carried over, or it is orphaned in KV');
});

test('the profile-selector delete button routes a draft to deleteProfileDraft, not the REST delete/hide call', () => {
    const fnSrc = selectorSource.slice(
        selectorSource.indexOf('function initDeleteButton()'),
        selectorSource.indexOf('function initSearchButton'));
    assert.match(fnSrc, /profileRecord\.isDraft/,
        'the delete button must branch on isDraft — deleteOrHideProfile 404s on an id that was never POSTed to the server');
    assert.match(fnSrc, /deleteProfileDraft\(keyToActOn\)/,
        'a draft must be removed via deleteProfileDraft, the same local-only cleanup the long-press menu uses');
});

console.log('profile-drafts: all assertions passed');
