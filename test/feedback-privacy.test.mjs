import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { FEEDBACK_AREAS, FEEDBACK_DEFAULT_AREA, areaTitleTag, areaDescribed, isFeedbackArea,
    buildFeedbackDescription } from '../src/settings/feedback-report.js';

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

test('feedback discloses public submission and sends no contact identifiers', () => {
    const renderStart = source.indexOf('export function renderFeedbackSettings');
    const renderEnd = source.indexOf('// Render Screen Saver settings', renderStart);
    const renderSource = source.slice(renderStart, renderEnd).replace('export ', '');
    const render = new Function('FEEDBACK_AREAS', 'FEEDBACK_DEFAULT_AREA',
        `${renderSource}\nreturn renderFeedbackSettings;`)(FEEDBACK_AREAS, FEEDBACK_DEFAULT_AREA);
    const html = render();

    assert.match(html, /public GitHub issue/);
    assert.match(html, /secret \(unlisted\) Gist/);
    assert.match(html, /Gist URL is added to the public GitHub issue/);
    assert.match(html, /anyone who can view the issue can access the logs/);
    assert.doesNotMatch(html, /feedback-email|Contact Email|Decent Account/);

    const submitStart = source.indexOf('window.submitFeedback = async function');
    const submitEnd = source.indexOf('window.startDescaling', submitStart);
    const submitSource = source.slice(submitStart, submitEnd);

    assert.doesNotMatch(source, /xorEncode|itisadecentcupofcoffee/);
    assert.doesNotMatch(submitSource, /feedback-email|account\/proxy\/support\/api\/sn|\*\*Serial:|\*\*Contact:/);
});

// ── Where the report says the problem is ───────────────────────────────────
//
// Every report Decaid files lands on its own repository, whatever part of the
// system the user meant, and POST /api/v1/feedback carries nothing that names a
// component. The skin owns the description and Decaid's issue title is its
// first line, so the answer rides in both.

test('the form asks which part of the system the report is about', () => {
    const renderStart = source.indexOf('export function renderFeedbackSettings');
    const renderEnd = source.indexOf('// Render Screen Saver settings', renderStart);
    const renderSource = source.slice(renderStart, renderEnd).replace('export ', '');
    const render = new Function('FEEDBACK_AREAS', 'FEEDBACK_DEFAULT_AREA',
        `${renderSource}\nreturn renderFeedbackSettings;`)(FEEDBACK_AREAS, FEEDBACK_DEFAULT_AREA);
    const html = render();

    for (const area of FEEDBACK_AREAS) {
        assert.ok(html.includes(`data-feedback-area="${area.value}"`), `no card for ${area.value}`);
        assert.ok(html.includes(area.label), `no label for ${area.value}`);
    }
    assert.match(html, /id="feedback-area" value="skin"/);
    // The plugin picker starts hidden and is only filled when it is needed.
    assert.match(html, /id="feedback-plugin-row" class="hidden/);
    assert.match(html, /id="feedback-plugin"/);
    // The category cards still work, from the same card builder.
    assert.ok(html.includes('data-feedback-card="bug"'));
    assert.ok(html.includes('data-feedback-card="feature"'));
});

test('the area tags the title and is spelled out in the body', () => {
    const skin = buildFeedbackDescription({
        area: 'skin', title: 'Profile change is not applied', description: 'Loaded it twice.',
        plugin: { skinVersion: '0.2.19' },
    });
    assert.equal(skin.split('\n')[0], '[Skin] Profile change is not applied',
        'the first line is what Decaid turns into the issue title');
    assert.match(skin, /\*\*Area:\*\* Streamline skin 0\.2\.19/);
    assert.match(skin, /Loaded it twice\./);

    assert.match(buildFeedbackDescription({ area: 'decaid', title: 'Scale drops out' }),
        /^\[Decaid\] Scale drops out\n\n\*\*Area:\*\* Decaid app$/);
});

test('a plugin report names the plugin, or says it does not', () => {
    const named = buildFeedbackDescription({
        area: 'plugin', title: 'Recipe not applied',
        plugin: { id: 'dye2.reaplugin', version: '1.3.0' },
    });
    assert.equal(named.split('\n')[0], '[Plugin] Recipe not applied');
    assert.match(named, /\*\*Area:\*\* Plugin dye2\.reaplugin 1\.3\.0/);
    // A plugin whose version the list did not carry, and a report that named none.
    assert.match(areaDescribed('plugin', { id: 'x.reaplugin' }), /^Plugin x\.reaplugin$/);
    assert.equal(areaDescribed('plugin', null), 'A plugin (not named)');
    assert.equal(areaDescribed('plugin', { id: '' }), 'A plugin (not named)');
});

test('an unknown area tags nothing rather than inventing a component', () => {
    for (const area of ['', null, undefined, 'hardware', 'skin ']) {
        assert.equal(areaTitleTag(area), '');
        assert.equal(areaDescribed(area), '');
        assert.equal(isFeedbackArea(area), false);
    }
    assert.equal(buildFeedbackDescription({ area: 'nonsense', title: 'A thing' }), 'A thing');
    for (const area of FEEDBACK_AREAS) assert.equal(isFeedbackArea(area.value), true);
    assert.equal(isFeedbackArea(FEEDBACK_DEFAULT_AREA), true);
});

test('a report with no description, or no title, still composes', () => {
    assert.equal(buildFeedbackDescription({ area: 'skin', title: 'Just a title' }),
        '[Skin] Just a title\n\n**Area:** Streamline skin');
    // The page refuses an empty title before it gets here; it must not throw if it ever does.
    assert.equal(buildFeedbackDescription({ area: 'skin' }), '[Skin]\n\n**Area:** Streamline skin');
    assert.equal(buildFeedbackDescription(), '');
});

test('the submit sends the composed description and the plugin it names', () => {
    const submitStart = source.indexOf('window.submitFeedback = async function');
    const submitEnd = source.indexOf('window.startDescaling', submitStart);
    const submitSource = source.slice(submitStart, submitEnd);
    assert.match(submitSource, /buildFeedbackDescription\(\{/);
    assert.match(submitSource, /area,/);
    // The version comes from the option the user picked, not from a second read.
    assert.match(submitSource, /selectedOptions\?\.\[0\]/);
    assert.match(submitSource, /skinVersion: APP_VERSION/);
    assert.doesNotMatch(submitSource, /\*\*\$\{title\}\*\*/, 'the old bold-title first line is gone');
});
