import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ASSISTED_DIALIN_PLUGIN_ID,
    findAssistedDialInPlugin,
    buildAssistedDialInUrl,
} from '../src/modules/assisted-dialin.js';

const uiApi = [{ type: 'http', id: 'ui' }];

test('requires the exact enabled plugin manifest and UI endpoint', () => {
    const plugin = { id: ASSISTED_DIALIN_PLUGIN_ID, loaded: true, api: uiApi };
    assert.equal(findAssistedDialInPlugin([plugin]), plugin);
    assert.equal(findAssistedDialInPlugin([{ ...plugin, id: 'other' }]), null);
    assert.equal(findAssistedDialInPlugin([{ ...plugin, loaded: false }]), null);
    assert.equal(findAssistedDialInPlugin([{ ...plugin, api: [] }]), null);
    assert.equal(findAssistedDialInPlugin(null), null);
});

test('builds a safe selected-shot URL with action and return navigation', () => {
    const plugin = { id: ASSISTED_DIALIN_PLUGIN_ID };
    const url = buildAssistedDialInUrl('http://de1.local:8080/api/v1/', plugin, {
        shotId: 'shot/42?x=1',
        action: 'feedback',
        returnUrl: 'http://de1.local:8080/?page=history&shot=42',
        beanCapture: { deviceId: 'plugin:scale/a', role: 'auxiliary', weight: 18.2, capturedAt: '2026-10-11T10:00:01Z', sampleTimestamp: '2026-10-11T10:00:00Z' },
    });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, `/api/v1/plugins/${ASSISTED_DIALIN_PLUGIN_ID}/ui`);
    assert.equal(parsed.searchParams.get('shotId'), 'shot/42?x=1');
    assert.equal(parsed.searchParams.get('action'), 'feedback');
    assert.equal(parsed.searchParams.get('return'), 'http://de1.local:8080/?page=history&shot=42');
    assert.equal(parsed.searchParams.get('beanScaleId'), 'plugin:scale/a');
    assert.equal(parsed.searchParams.get('beanScaleRole'), 'auxiliary');
    assert.equal(parsed.searchParams.get('beanWeight'), '18.2');
    assert.equal(buildAssistedDialInUrl('http://de1.local/api/v1', plugin, { shotId: '' }), null);
    assert.equal(buildAssistedDialInUrl('http://de1.local/api/v1', { id: 'other' }, { shotId: '42' }), null);
});
