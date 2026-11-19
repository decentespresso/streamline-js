// Two records can share a title: Decaid's profile id is a hash of execution
// content only, so an imported de1app copy of a bundled profile keeps the
// bundled title and still lands as its own record. The selector marks such
// rows with their saved time, and the count must span both list sections --
// the bundled row is a default, its look-alike is not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookAlikeKey, countLookAlikeTitles, isLookAlike } from '../src/modules/profile-look-alike.js';

test('a title appearing once is not a look-alike', () => {
    const counts = countLookAlikeTitles(['Cleaning/Forward Flush x5', 'Cleaning/Forward flush']);
    assert.equal(isLookAlike(counts, 'Cleaning/Forward Flush x5'), false);
});

test('the same title twice is a look-alike, whichever section each row is in', () => {
    const counts = countLookAlikeTitles(['Cleaning/Forward Flush x5', 'Cleaning/Forward Flush x5']);
    assert.equal(isLookAlike(counts, 'Cleaning/Forward Flush x5'), true);
});

test('an auto-suffixed duplicate counts as the same title', () => {
    const counts = countLookAlikeTitles(['Adaptive v2', 'Adaptive v2 (2)']);
    assert.equal(isLookAlike(counts, 'Adaptive v2'), true);
    assert.equal(isLookAlike(counts, 'Adaptive v2 (2)'), true);
});

test('the suffix is only stripped at the end of the title', () => {
    assert.equal(lookAlikeKey('Adaptive (2) v2'), 'Adaptive (2) v2');
    assert.equal(lookAlikeKey('Adaptive v2 (2)'), 'Adaptive v2');
});

test('a missing title does not throw and never collides with a real one', () => {
    const counts = countLookAlikeTitles([undefined, 'Adaptive v2']);
    assert.equal(isLookAlike(counts, 'Adaptive v2'), false);
    assert.equal(lookAlikeKey(undefined), '');
});
