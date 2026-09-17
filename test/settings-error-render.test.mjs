import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function loadRenderer() {
    const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    // escapeHtml moved to the DOM-free plugin-view.js so one implementation
    // serves settings.js and the plugin cards; settings.js imports it.
    const viewSource = readFileSync(new URL('../src/settings/plugin-view.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const helpers = viewSource.match(/export function escapeHtml\(str\) \{[\s\S]*?\n\}/)?.[0].replace('export ', '');
    const rendererStart = source.indexOf('function renderErrorState');
    const rendererEnd = source.indexOf('function updateSettingsContentArea', rendererStart);
    assert.ok(helpers && rendererStart >= 0 && rendererEnd > rendererStart);

    return new Function(`
        ${helpers}
        ${source.slice(rendererStart, rendererEnd)}
        return renderErrorState;
    `)();
}

test('settings error values render literally', () => {
    const render = loadRenderer();
    const title = 'Profile <draft>';
    const message = 'DE1 returned <offline>';
    const html = render(title, message);

    assert.doesNotMatch(html, /<(?:draft|offline)>/i);
    assert.match(html, /Profile &lt;draft&gt;/);
    assert.match(html, /DE1 returned &lt;offline&gt;/);
});
