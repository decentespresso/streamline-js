// Reset's version picker: summarizeProfileDiff (the label shown next to each
// row's date) and the strictly-older filter (no offering a later fork as
// something to "revert" to). Both pinned directly from source -- the module
// itself touches document/window at import time, so it can't be imported here.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/profile_selector.js', import.meta.url), 'utf8');

const start = source.indexOf('const DIFF_FIELD_LABELS');
const end = source.indexOf('\nfunction promptVersionRestore');
assert.ok(start >= 0 && end > start, 'summarizeProfileDiff not found in profile_selector.js');
const summarizeProfileDiff = new Function(`${source.slice(start, end)}\nreturn summarizeProfileDiff;`)();

const step = (extra) => ({ name: 'Step', pump: 'flow', flow: 2, temperature: 93, seconds: 10, ...extra });
const profile = (extra) => ({ title: 'X', target_weight: 36, target_volume: 0, beverage_type: 'espresso', tank_temperature: 0, steps: [step()], ...extra });

test('identical profiles report no changes', () => {
    assert.equal(summarizeProfileDiff(profile(), profile()), 'No changes');
});

test('a different step count is reported by the other version\'s count', () => {
    const other = profile({ steps: [step(), step()] });
    assert.equal(summarizeProfileDiff(profile(), other), '2 steps');
});

test('same step count but different content reports how many steps changed', () => {
    const other = profile({ steps: [step({ flow: 3 })] });
    assert.equal(summarizeProfileDiff(profile(), other), '1 step changed');
});

test('an execution field difference is named', () => {
    const other = profile({ target_weight: 30 });
    assert.equal(summarizeProfileDiff(profile(), other), 'target weight');
});

test('multiple differences are joined in one line', () => {
    const other = profile({ target_weight: 30, beverage_type: 'pourover', steps: [step({ flow: 3 })] });
    assert.equal(summarizeProfileDiff(profile(), other), '1 step changed, target weight, beverage type');
});

test('a title-only rename is not reported -- execution fields only', () => {
    const other = profile({ title: 'Renamed' });
    assert.equal(summarizeProfileDiff(profile(), other), 'No changes');
});

test('missing either side returns an empty string rather than throwing', () => {
    assert.equal(summarizeProfileDiff(null, profile()), '');
    assert.equal(summarizeProfileDiff(profile(), null), '');
});

// ── Strictly-older filter ────────────────────────────────────────────────────
// /lineage returns the whole chain -- parents AND children -- so the Reset
// handler must exclude anything not strictly older than the current record,
// or a later fork could be offered as something to "revert" to.
const handlerStart = source.indexOf('// /lineage returns the whole chain');
const handlerEnd = source.indexOf('if (!versions.length)', handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'the strictly-older version filter not found in profile_selector.js');
const filterSrc = source.slice(handlerStart, handlerEnd);
assert.ok(/new Date\(r\.createdAt\) < currentCreatedAt/.test(filterSrc),
    'lineage entries must be filtered to strictly older than the current record');

const rec = (id, createdAt) => ({ id, createdAt, profile: { title: id } });
const filterVersions = (lineage, selectedProfileKey, profileRecord) => {
    const currentCreatedAt = new Date(profileRecord.createdAt);
    return lineage
        .filter(r => r.id !== selectedProfileKey && r.profile && new Date(r.createdAt) < currentCreatedAt)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

test('a later fork is excluded, not offered as a revert target', () => {
    const current = rec('cur', '2026-06-01T00:00:00Z');
    const older = rec('old', '2026-01-01T00:00:00Z');
    const newer = rec('new', '2026-09-01T00:00:00Z');
    const versions = filterVersions([current, older, newer], 'cur', current);
    assert.deepEqual(versions.map(v => v.id), ['old']);
});

test('with only older entries, the newest-first order is kept', () => {
    const current = rec('cur', '2026-06-01T00:00:00Z');
    const a = rec('a', '2026-01-01T00:00:00Z');
    const b = rec('b', '2026-03-01T00:00:00Z');
    const versions = filterVersions([current, a, b], 'cur', current);
    assert.deepEqual(versions.map(v => v.id), ['b', 'a']);
});

console.log('profile-selector-reset: all assertions passed');
