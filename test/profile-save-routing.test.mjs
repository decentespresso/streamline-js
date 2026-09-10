// Check of the no-op guard and save routing in saveProfile() /
// src/modules/profile_editor.js (mirrored here — the module touches the DOM at
// import time). Two bugs this pins down:
//   1. A brand-new profile arrives as a stub record with id null, so treating
//      the record itself as the source made an untouched new profile look
//      "unchanged" — Save silently dropped it without ever POSTing.
//   2. The guard compared the editor's normalised copy against the raw source,
//      so any profile still carrying legacy fields read as an execution change
//      the instant it opened and forked itself on a no-op Save.
// Run: node test/profile-save-routing.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const deepCopy = o => JSON.parse(JSON.stringify(o));

function normalizeLegacySteps(profile) {
    for (const step of profile.steps ?? []) {
        if (step.pump === 'flow') delete step.pressure;
        else if (step.pump === 'pressure') delete step.flow;
        if (step.limiter && step.limiter.value === 0) step.limiter = null;
        if (step.exit && step.exit.type !== 'pressure' && step.exit.type !== 'flow') step.exit = null;
    }
    return profile;
}

const PRESENTATION_FIELDS = ['title', 'author', 'notes'];
function executionChanged(orig, edited) {
    const strip = p => {
        const c = { ...p };
        PRESENTATION_FIELDS.forEach(k => delete c[k]);
        return JSON.stringify(c);
    };
    return strip(orig) !== strip(edited);
}

// Returns what saveProfile would do: 'noop' | 'post-new' | 'fork-default'
// | 'overwrite' (hide + POST) | 'put-metadata' | 'blocked-default-rename'.
// `baseline` is _baselineProfileJson — the editor's copy as it stood on load.
// `imported` is _hasImportedInSession — a file was uploaded into this session.
function route(record, edited, baseline = null, imported = false) {
    const src = record?.id ? record : null;
    const sourceProfile = src?.profile ? normalizeLegacySteps(deepCopy(src.profile)) : null;
    const sourceProfileJson = sourceProfile ? JSON.stringify(sourceProfile) : null;
    const editedJson = JSON.stringify(edited);
    const unchanged = sourceProfileJson
        ? sourceProfileJson === editedJson
        : (!imported && editedJson === baseline);
    if (unchanged) return 'noop';

    const sourceTitle = (src?.profile?.title || '').trim();
    const titleChanged = sourceTitle && edited.title.trim() !== sourceTitle;
    const execChanged = !src || executionChanged(sourceProfile, edited);

    if (titleChanged && !execChanged && src.isDefault) return 'blocked-default-rename';
    if (src?.isDefault && execChanged) return 'fork-default';
    if (!src || (titleChanged && execChanged)) return 'post-new';
    if (execChanged) return 'overwrite';
    return 'put-metadata';
}

// A step shaped like the editor emits it, plus the legacy off-pump key the
// source record still carries.
const flowStep = extra => ({
    name: 'Preinfusion', pump: 'flow', flow: 2, temperature: 93, seconds: 10,
    exit: { type: 'pressure', condition: 'over', value: 4 },
    limiter: { value: 4, range: 0.6 }, ...extra,
});
const mkProfile = (title, steps) => ({ title, version: '2', author: '', notes: '', steps });

// The editor's view of a profile: what initializeProfileEditor built from it.
const asEdited = record => normalizeLegacySteps(deepCopy(record.profile));

// ── 1. New profile, untouched: blocked, and blocked by the baseline ─────────
// Not by the stub-as-source path — that one silently navigated away and lost
// the profile. Here the user stays on the editor and gets told to rename.
const stub = { id: null, profile: mkProfile('New Profile', [flowStep()]) };
const stubBaseline = JSON.stringify(asEdited(stub));
assert.strictEqual(route(stub, asEdited(stub), stubBaseline), 'noop',
    'saving the untouched Add Profile template must prompt, not create a stock "New Profile"');

// ── 2. New profile, edited but never renamed: a plain POST ──────────────────
const stubEdited = asEdited(stub);
stubEdited.steps[0].temperature = 95;
assert.strictEqual(route(stub, stubEdited, stubBaseline), 'post-new',
    'a new profile keeping its default title must not take the hide-then-POST overwrite path');

// Renaming alone is enough to get a new profile saved.
const stubRenamed = asEdited(stub);
stubRenamed.title = 'Morning blend';
assert.strictEqual(route(stub, stubRenamed, stubBaseline), 'post-new',
    'renaming the template is the minimum change that makes Save work');

// ── 2b. Uploaded file, saved verbatim: must save ────────────────────────────
// Upload Local File resets the baseline and passes no source record, so the
// template check has to be skipped or saving an upload as-is would be blocked.
const uploaded = mkProfile('Londinium', [flowStep({ pressure: 9 })]);
const uploadedBaseline = JSON.stringify(uploaded);
assert.strictEqual(route(null, uploaded, uploadedBaseline, true), 'post-new',
    'an uploaded profile saved verbatim must be created — saving it as-is is the point');

// ── 3. Legacy profile opened and saved untouched: no-op, no fork ─────────────
// The source carries `pressure` on a flow step; the editor's copy drops it.
const legacy = { id: 'abc', profile: mkProfile('Londinium', [flowStep({ pressure: 9 })]) };
assert.strictEqual(route(legacy, asEdited(legacy)), 'noop',
    'a legacy field the editor strips on load must not read as an execution change');

const legacyDefault = { id: 'def', isDefault: true, profile: deepCopy(legacy.profile) };
assert.strictEqual(route(legacyDefault, asEdited(legacyDefault)), 'noop',
    'opening a stock default and saving it untouched must not fork it');

// ── 4. Real edits still route as before ─────────────────────────────────────
const edited = asEdited(legacy);
edited.steps[0].flow = 3;
assert.strictEqual(route(legacy, edited), 'overwrite',
    'a real execution change on a user profile hides the old record and POSTs');

// A record's id is the hash of its execution fields only, so a rename with no
// execution change cannot mint a second record: POST would hit the server's
// content dedup and come back as the untouched original, losing the new name.
const renamed = asEdited(legacy);
renamed.title = 'Londinium v2';
assert.strictEqual(route(legacy, renamed), 'put-metadata',
    'a rename with no execution change must PUT in place — POST dedups and drops the new name');

const renamedAndEdited = asEdited(legacy);
renamedAndEdited.title = 'Londinium v2';
renamedAndEdited.steps[0].flow = 3;
assert.strictEqual(route(legacy, renamedAndEdited), 'post-new',
    'renaming alongside an execution change is still the explicit save-as');

// Defaults reject PUT server-side and dedup on POST, so a rename-only save of a
// stock default has nowhere to go — it must say so, not report a phantom save.
assert.strictEqual(route(legacyDefault, { ...asEdited(legacyDefault), title: 'My Londinium' }),
    'blocked-default-rename',
    'renaming a default without changing it must be reported, not silently deduped away');

const renoted = asEdited(legacy);
renoted.notes = 'pulled 18g in';
assert.strictEqual(route(legacy, renoted), 'put-metadata',
    'a presentation-only change keeps the id');

const forked = asEdited(legacyDefault);
forked.steps[0].seconds = 12;
assert.strictEqual(route(legacyDefault, forked), 'fork-default',
    'editing a default forks it — PUT would be rejected');

const editorSource = readFileSync(new URL('../src/modules/profile_editor.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const overwriteStart = editorSource.indexOf('        } else if (execChanged) {');
const overwriteEnd = editorSource.indexOf('        } else {', overwriteStart + 1);
const overwriteBranch = editorSource.slice(overwriteStart, overwriteEnd);
const uploadIndex = overwriteBranch.indexOf('saved = await uploadProfileWithParent');
const hideIndex = overwriteBranch.indexOf("await updateProfileVisibility(src.id, 'hidden')");
assert.ok(uploadIndex >= 0 && hideIndex >= 0 && uploadIndex < hideIndex,
    'the replacement must exist before the visible predecessor is hidden');
const reactivateIndex = overwriteBranch.indexOf("saved = await updateProfileVisibility(saved.id, 'visible')");
assert.ok(reactivateIndex >= 0 && uploadIndex < reactivateIndex && reactivateIndex < hideIndex,
    'a deduplicated hidden replacement must be reactivated before the predecessor is hidden');

const reactivateBlock = overwriteBranch.match(/            if \(saved\.visibility !== 'visible'\) \{[\s\S]*?            \}/)?.[0];
assert.ok(reactivateBlock, 'the save path must handle a deduplicated hidden replacement');
const runReactivation = new Function('saved', 'updateProfileVisibility',
    `return (async () => { ${reactivateBlock} return saved; })();`);
const calls = [];
const deduplicated = { id: 'profile:a', visibility: 'hidden' };
const visibleReplacement = await runReactivation(deduplicated, async (id, visibility) => {
    calls.push([id, visibility]);
    return { ...deduplicated, visibility };
});
assert.strictEqual(visibleReplacement.visibility, 'visible',
    'a deduplicated hidden profile must be reactivated');
assert.deepStrictEqual(calls, [['profile:a', 'visible']],
    'reactivation must target the deduplicated replacement id');

// ── 5. POST dedup collision after a genuine execution change ────────────────
// POST /profiles is content-addressed (ProfileController.create): it can hand
// back an EXISTING record — same id we tried to fork away from, or a totally
// unrelated profile with a coincidentally matching hash — while still
// answering 201. saveProfile's forkDeduped() guard is the only thing standing
// between that and a false "Saved profile" toast, so pin its behaviour
// directly from the real source rather than a hand-written mirror.
const forkDedupedSrc = editorSource.match(/const forkDeduped = \(record, avoidId\) => \{[\s\S]*?\n {8}\};/)?.[0];
assert.ok(forkDedupedSrc, 'forkDeduped guard must exist in the save path');
const runForkDeduped = new Function('sentTitle', 'record', 'avoidId',
    `${forkDedupedSrc}\nreturn forkDeduped(record, avoidId);`);

assert.strictEqual(
    runForkDeduped('My Fork', { id: 'profile:new', profile: { title: 'My Fork' } }, 'profile:old'),
    false,
    'a genuinely new record (different id, our title) must not be flagged as deduped');
assert.strictEqual(
    runForkDeduped('My Fork', { id: 'profile:old', profile: { title: 'Original' } }, 'profile:old'),
    true,
    'the server handing back the record we forked away from must be flagged as deduped');
assert.strictEqual(
    runForkDeduped('My Fork', { id: 'profile:other', profile: { title: 'Some Other Profile' } }, 'profile:old'),
    true,
    'a hash collision with an unrelated profile (our title not echoed back) must be flagged as deduped');
assert.strictEqual(
    runForkDeduped('My Fork', null, 'profile:old'),
    true,
    'no record at all must be treated as a failed fork, not a silent success');

// Every uploadProfileWithParent call in the POST branches must be guarded by
// forkDeduped before the routine touches availableProfiles/editorState or
// reports success — a branch added later without the guard would reintroduce
// the false-success bug this fix closes.
const saveProfileStart = editorSource.indexOf('async function saveProfile()');
const saveProfileEnd = editorSource.indexOf('\nfunction promptConfirm(', saveProfileStart + 1);
assert.ok(saveProfileStart >= 0 && saveProfileEnd > saveProfileStart, 'saveProfile() must be found in the editor source');
const saveProfileSrc = editorSource.slice(saveProfileStart, saveProfileEnd);
const uploadCallRe = /saved = await uploadProfileWithParent\([^)]*\);/g;
const uploadCallMatches = [...saveProfileSrc.matchAll(uploadCallRe)];
assert.strictEqual(uploadCallMatches.length, 3, 'expected exactly three POST (uploadProfileWithParent) call sites in saveProfile');
uploadCallMatches.forEach((m, i) => {
    const sliceStart = m.index + m[0].length;
    const sliceEnd = uploadCallMatches[i + 1]?.index ?? saveProfileSrc.length;
    const afterCall = saveProfileSrc.slice(sliceStart, sliceEnd);
    assert.ok(/forkDeduped\(saved,/.test(afterCall),
        `uploadProfileWithParent call #${i + 1} must be followed by its own forkDeduped() guard before the next branch`);
});

// ── 6. Draft save routing (copy now, edit later) ────────────────────────────
// A draft (profileManager.js duplicateProfileAsDraft / createOrUpdateDraft)
// lives only in the streamline-app KV bucket until its content actually
// diverges from what it was copied with — see saveDraftEdit in
// profile_editor.js. Mirrors the same execChanged split saveProfile uses,
// so a rename-only edit of a draft never round-trips to the server.
function routeDraft(draftRecord, edited) {
    const sourceProfile = normalizeLegacySteps(deepCopy(draftRecord.profile));
    return executionChanged(sourceProfile, edited) ? 'promote' : 'stay-draft';
}

const draft = { id: 'draft:1', parentId: 'profile:parent', profile: mkProfile('Rao Allongé (2)', [flowStep()]) };
assert.strictEqual(routeDraft(draft, asEdited(draft)), 'stay-draft',
    'opening a draft and saving it untouched must not reach the server');

const draftRenamed = asEdited(draft);
draftRenamed.title = 'Rao Allongé (3)';
assert.strictEqual(routeDraft(draft, draftRenamed), 'stay-draft',
    'renaming a draft with no execution change must update the KV copy in place, not POST');

const draftEdited = asEdited(draft);
draftEdited.steps[0].flow = 3;
assert.strictEqual(routeDraft(draft, draftEdited), 'promote',
    'a real execution change on a draft must promote it to a server-backed profile');

// Pin saveDraftEdit's own dedup guard directly from the source (same
// technique as forkDeduped above) rather than a hand-written mirror.
const draftEditStart = editorSource.indexOf('async function saveDraftEdit(draftRecord) {');
assert.ok(draftEditStart >= 0, 'saveDraftEdit must exist in the editor source');
const draftDedupedSrc = editorSource.match(/const deduped = !saved\n[\s\S]*?;\n/)?.[0];
assert.ok(draftDedupedSrc, 'saveDraftEdit dedup guard must exist');
const runDraftDeduped = new Function('saved', 'draftRecord', 'sentTitle',
    `${draftDedupedSrc}\nreturn deduped;`);

assert.strictEqual(
    runDraftDeduped({ id: 'profile:new', profile: { title: 'My Draft' } }, { parentId: 'profile:parent' }, 'My Draft'),
    false, 'a genuinely new record must not be flagged as deduped');
assert.strictEqual(
    runDraftDeduped({ id: 'profile:parent', profile: { title: 'Original' } }, { parentId: 'profile:parent' }, 'My Draft'),
    true, 'the server handing back the draft\'s own parent must be flagged as deduped');
assert.strictEqual(
    runDraftDeduped({ id: 'profile:other', profile: { title: 'Some Other Profile' } }, { parentId: 'profile:parent' }, 'My Draft'),
    true, 'a hash collision with an unrelated profile must be flagged as deduped');
assert.strictEqual(
    runDraftDeduped(null, { parentId: 'profile:parent' }, 'My Draft'),
    true, 'no record at all must be treated as a failed promotion');

// Pin profileManager.js's uniqueProfileTitle directly from source.
const pmSource = readFileSync(new URL('../src/modules/profileManager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const uniqueTitleSrc = pmSource.match(/function uniqueProfileTitle\(baseTitle, excludeId\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(uniqueTitleSrc, 'uniqueProfileTitle must exist in profileManager.js');
const runUniqueTitle = new Function('availableProfiles', 'baseTitle', 'excludeId',
    `${uniqueTitleSrc}\nreturn uniqueProfileTitle(baseTitle, excludeId);`);

const existing = {
    a: { profile: { title: 'Rao Allongé' } },
    b: { profile: { title: 'Rao Allongé (2)' } },
};
assert.strictEqual(runUniqueTitle(existing, 'Londinium', null), 'Londinium',
    'a title with no collision is returned unchanged');
assert.strictEqual(runUniqueTitle(existing, 'Rao Allongé', null), 'Rao Allongé (3)',
    'a collision skips past every already-taken suffix');
assert.strictEqual(runUniqueTitle(existing, 'Rao Allongé', 'a'), 'Rao Allongé',
    'a record keeping its own title is excluded from its own collision check');

console.log('profile-save-routing: all assertions passed');
