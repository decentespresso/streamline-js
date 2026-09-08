import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');

test('api.js parses as an ES module', () => {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
        input: source,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
});

function loadGetScaleInfo(fetch) {
    const match = source.match(/export async function getScaleInfo\(\) \{[\s\S]*?\n\}/);
    assert.ok(match);
    return new Function(
        'fetch',
        'API_BASE_URL',
        `${match[0].replace('export ', '')}\nreturn getScaleInfo;`,
    )(fetch, 'http://localhost:8080/api/v1');
}

test('scale info requests the connected-scale endpoint', async () => {
    let request;
    const getScaleInfo = loadGetScaleInfo(async (url) => {
        request = url;
        return { ok: true, json: async () => ({ firmwareVersion: 'R029' }) };
    });

    assert.deepEqual(await getScaleInfo(), { firmwareVersion: 'R029' });
    assert.equal(request, 'http://localhost:8080/api/v1/scale/info');
});

test('scale info exposes endpoint status for unavailable older hosts', async () => {
    const getScaleInfo = loadGetScaleInfo(async () => ({ ok: false, status: 404 }));

    await assert.rejects(getScaleInfo(), error => error.status === 404);
});
