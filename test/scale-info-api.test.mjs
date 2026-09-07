import assert from 'node:assert/strict';
import test from 'node:test';

test('scale info requests the connected-scale endpoint', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
        readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8'));
    assert.match(source, /fetch\(`\$\{API_BASE_URL\}\/scale\/info`\)/);
});
