import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/profileManager.js', import.meta.url), 'utf8');
const match = source.match(/export async function resolveImportedProfile\(profileId\) \{[\s\S]*?\r?\n\}/);
assert.ok(match);

function makeResolver({ getProfiles, updateProfileVisibility, availableProfiles }) {
    return new Function(
        'getProfiles', 'updateProfileVisibility', 'setSetting', 'availableProfiles', 'PROFILES_CACHE_KEY',
        `${match[0].replace('export ', '')}\nreturn resolveImportedProfile;`,
    )(getProfiles, updateProfileVisibility, async () => {}, availableProfiles, 'available-profiles-cache');
}

test('an already-visible profile already in the cache is returned as-is, no REST calls', async () => {
    const record = { id: 'p1', visibility: 'visible', profile: { title: 'Existing' } };
    const availableProfiles = { p1: record };
    const resolve = makeResolver({
        getProfiles: async () => { throw new Error('should not be called'); },
        updateProfileVisibility: async () => { throw new Error('should not be called'); },
        availableProfiles,
    });

    const result = await resolve('p1');
    assert.equal(result, record);
});

test('a dedup hit on a hidden profile is restored to visible', async () => {
    const hidden = { id: 'p1', visibility: 'hidden', profile: { title: 'Superseded' } };
    const restored = { ...hidden, visibility: 'visible' };
    const availableProfiles = {};
    let restoredId, restoredTo;
    const resolve = makeResolver({
        getProfiles: async () => [hidden],
        updateProfileVisibility: async (id, visibility) => { restoredId = id; restoredTo = visibility; return restored; },
        availableProfiles,
    });

    const result = await resolve('p1');
    assert.equal(restoredId, 'p1');
    assert.equal(restoredTo, 'visible');
    assert.equal(result, restored);
    assert.equal(availableProfiles.p1, restored);
});

test('a dedup hit on a soft-deleted profile is restored to visible', async () => {
    const deleted = { id: 'p1', visibility: 'deleted', profile: { title: 'Removed' } };
    const restored = { ...deleted, visibility: 'visible' };
    const availableProfiles = {};
    const resolve = makeResolver({
        getProfiles: async () => [deleted],
        updateProfileVisibility: async () => restored,
        availableProfiles,
    });

    const result = await resolve('p1');
    assert.equal(result, restored);
});

test('a profile id absent from the full record list resolves to null', async () => {
    const availableProfiles = {};
    const resolve = makeResolver({
        getProfiles: async () => [{ id: 'other', visibility: 'visible', profile: {} }],
        updateProfileVisibility: async () => { throw new Error('should not be called'); },
        availableProfiles,
    });

    const result = await resolve('missing');
    assert.equal(result, null);
});

test('a visible record missing only from the in-memory cache is adopted without a visibility write', async () => {
    const record = { id: 'p1', visibility: 'visible', profile: { title: 'Fine' } };
    const availableProfiles = {};
    const resolve = makeResolver({
        getProfiles: async () => [record],
        updateProfileVisibility: async () => { throw new Error('should not be called'); },
        availableProfiles,
    });

    const result = await resolve('p1');
    assert.equal(result, record);
    assert.equal(availableProfiles.p1, record);
});
