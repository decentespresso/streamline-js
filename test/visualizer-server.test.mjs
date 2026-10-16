import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_VISUALIZER_SERVER_URL,
    normalizeVisualizerServerUrl,
    visualizerServerUrlsEqual,
    isInsecureVisualizerServerUrl,
} from '../src/settings/visualizer-server.js';

test('the hosted Visualizer URL is the default', () => {
    assert.equal(normalizeVisualizerServerUrl(''), DEFAULT_VISUALIZER_SERVER_URL);
    assert.equal(normalizeVisualizerServerUrl(undefined), DEFAULT_VISUALIZER_SERVER_URL);
});

test('normalization trims whitespace and trailing slashes while retaining a proxy prefix', () => {
    assert.equal(
        normalizeVisualizerServerUrl('https://coffee.example/visualizer///'),
        'https://coffee.example/visualizer',
    );
    assert.equal(visualizerServerUrlsEqual('https://coffee.example/', 'https://coffee.example'), true);
});

test('HTTP is available for local or LAN servers and is detectable for warning UI', () => {
    assert.equal(normalizeVisualizerServerUrl('http://coffee.local:80/'), 'http://coffee.local');
    assert.equal(isInsecureVisualizerServerUrl('http://coffee.local'), true);
    assert.equal(isInsecureVisualizerServerUrl('https://coffee.local'), false);
});

test('server URLs reject whitespace, dot segments, backslashes, and request components', () => {
    for (const value of [
        'visualizer.example',
        'https://user:password@visualizer.example',
        'https://visualizer.example/?token=secret',
        'https://visualizer.example/#shot',
        'https://visualizer.example/a/../b',
        'https://visualizer.example/a/./b',
        'https://visualizer.example\\a',
        ' https://visualizer.example',
    ]) {
        assert.throws(() => normalizeVisualizerServerUrl(value), /Visualizer server URL/);
    }
});

test('invalid values never compare equal to a valid stored server', () => {
    assert.equal(visualizerServerUrlsEqual('not a URL', DEFAULT_VISUALIZER_SERVER_URL), false);
});
