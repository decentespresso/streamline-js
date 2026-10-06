import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

// The release workflow's whole safety model is the whitelist: it copies
// index.html, skin-manifest.json and src/ into dist/ and zips dist/, so
// everything else is meant to be "excluded by construction, not by ignore
// rules". `mkdir -p dist` broke that quietly — it keeps whatever the checkout
// already has under dist/, so a committed dist/app.css (stale, unreferenced by
// index.html, 155KB) rode into the zip at its root and onto the dist branch in
// every release up to v0.2.8. The file is gone, but the hole stays shut only
// while staging starts from an empty dist.
const stagingStep = () => {
    const workflow = read('.github/workflows/release.yml');
    const start = workflow.indexOf('Stage whitelist into ./dist');
    assert.notEqual(start, -1, 'release.yml no longer has a "Stage whitelist into ./dist" step');
    const next = workflow.indexOf('\n      - name:', start);
    return workflow.slice(start, next === -1 ? undefined : next);
};

test('release staging clears dist before copying the whitelist', () => {
    const step = stagingStep();
    const cleared = step.search(/^\s*rm -rf dist\s*$/m);
    const created = step.search(/^\s*mkdir -p dist\s*$/m);
    assert.notEqual(cleared, -1, 'staging step does not clear dist; committed dist/ files will ship in the zip');
    assert.notEqual(created, -1, 'staging step no longer creates dist');
    assert.ok(cleared < created, 'dist must be cleared before it is recreated');
});

test('release whitelist is exactly index.html, skin-manifest.json and src', () => {
    const step = stagingStep();
    const loop = step.match(/for path in ([^;]+); do/);
    assert.ok(loop, 'staging step no longer copies a literal whitelist');
    assert.deepEqual(loop[1].trim().split(/\s+/), ['index.html', 'skin-manifest.json', 'src']);
});

// index.html is the only entry point the bridge loads, and it links
// src/css/app.css. A second copy of a generated bundle anywhere else in the
// artifact is dead weight that silently goes stale, which is exactly what
// dist/app.css did.
test('index.html links the generated bundle from src/css only', () => {
    const html = read('index.html');
    const sheets = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/g)]
        .map(link => link[0].match(/href="([^"]+)"/)?.[1])
        .filter(Boolean);
    const bundles = sheets.filter(href => href.endsWith('app.css'));
    assert.deepEqual(bundles, ['src/css/app.css']);
});
