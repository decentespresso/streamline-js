import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('route-only vendors and pages are absent from the startup preload list', () => {
    const index = read('index.html');
    assert.doesNotMatch(index, /rel="preload"/);
    assert.doesNotMatch(index, /<script[^>]+(?:easymde|iro\.min)/);
    assert.doesNotMatch(index, /<link[^>]+easymde\.min\.css/);
    assert.doesNotMatch(index, /<link[^>]+easymde-icons\.css/);
    assert.doesNotMatch(index, /<script[^>]+plotly-basic/);
});

test('EasyMDE toolbar icon font is bundled for its first render', () => {
    const css = read('src/vendor/font-awesome/easymde-icons.css');
    assert.match(css, /font-family:FontAwesome/);
    for (const icon of ['bold', 'italic', 'header', 'list-ul', 'list-ol', 'link', 'quote-left', 'minus', 'eye', 'columns']) {
        assert.match(css, new RegExp(`\\.fa-${icon}:before\\{content:`));
    }
    assert.equal(existsSync(new URL('src/vendor/font-awesome/fonts/fontawesome-webfont.woff2', root)), true);
});

test('font faces use WOFF2 with swap and no browser TTF references', () => {
    const css = read('src/css/main.css');
    assert.doesNotMatch(css, /url\([^)]*\.ttf/);
    // Every declared face, however many there are, has to carry swap -- counting
    // against the faces themselves rather than a fixed number so that adding a
    // weight fails this only when it actually forgets swap.
    const faces = (css.match(/@font-face/g) || []).length;
    assert.ok(faces > 0);
    assert.equal((css.match(/font-display: swap/g) || []).length, faces);
    for (const name of ['Inter-Regular', 'Inter-SemiBold', 'Inter-Bold', 'NotoSansMono-SemiBold', 'NotoSansMono-Medium']) {
        assert.equal(existsSync(new URL(`src/ui/${name}.woff2`, root)), true);
    }
});

test('process-lifetime chart and profile listeners use stable identities', () => {
    const chart = read('src/modules/chart.js');
    const profiles = read('src/modules/profile_selector.js');
    const settings = read('src/settings/settings.js');
    assert.match(chart, /if \(!window\.ResizeObserver\) window\.addEventListener\('resize', handleChartWindowResize\)/);
    assert.match(chart, /document\.addEventListener\('streamline:languagechange', handleChartLanguageChange\)/);
    assert.match(profiles, /new WeakSet\(\)/);
    assert.match(profiles, /document\.addEventListener\('profiles-updated', handleProfilesUpdated\)/);
    assert.doesNotMatch(profiles, /document\.addEventListener\('profiles-updated', \(\) =>/);
    assert.match(settings, /if \(!settingsLanguageListenerInstalled\)/);
    assert.match(settings, /document\.addEventListener\('streamline:languagechange', handleSettingsLanguageChange\)/);
});

test('notes confirmation reads the plain textarea when EasyMDE is unavailable', () => {
    const notes = read('src/modules/notes-modal.js');
    assert.match(notes, /easyMDE\?\.value\(\) \?\?/);
    assert.match(notes, /loadEasyMDE\(\)/);
});

test('startup settings prefetch reuses the workflow loaded for the dashboard', () => {
    const app = read('src/modules/app.js');
    assert.match(app, /const workflow = await loadInitialData\(\);/);
    assert.match(app, /prefetchSettingsToIDB\(initialWorkflow\)/);
    assert.match(app, /workflow \? Promise\.resolve\(workflow\) : getWorkflow\(\)/);
});

test('noncritical styles and duplicate module entries do not block startup', () => {
    const index = read('index.html');
    for (const asset of ['numpad-modal.css', 'time-picker-modal.css', 'notes-modal.css', 'context-menu.css', 'help-overlay.css']) {
        assert.doesNotMatch(index, new RegExp(`<link[^>]+${asset.replace('.', '\\.')}[^>]*>`));
    }
    assert.doesNotMatch(index, /<script[^>]+router\.js/);
    assert.doesNotMatch(index, /<script[^>]+helpOverlay\.js/);
});

test('help implementation and route resources are deferred and cleaned up', () => {
    const app = read('src/modules/app.js');
    const ui = read('src/modules/ui.js');
    const launcher = read('src/modules/help-launcher.js');
    const router = read('src/modules/router.js');
    const chart = read('src/modules/chart.js');
    assert.match(app, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
    assert.doesNotMatch(app, /^import .*numpad-modal\.js/m);
    assert.doesNotMatch(app, /^import .*time-picker-modal\.js/m);
    assert.doesNotMatch(ui, /^import .*numpad-modal\.js/m);
    assert.match(app, /import\('\.\/numpad-modal\.js'\)/);
    assert.match(app, /import\('\.\/time-picker-modal\.js'\)/);
    assert.match(launcher, /import\('\.\/helpOverlay\.js'\)/);
    assert.match(router, /await cleanupSubpage\(\)/);
    assert.match(chart, /export async function cleanupSubpageChart/);
});

test('ECharts loads after first paint only on chart-bearing routes', () => {
    const app = read('src/modules/app.js');
    const chart = read('src/modules/chart.js');
    const loader = read('src/modules/echarts-loader.js');
    assert.match(app, /if \(!isSubPage\(\)\) requestAnimationFrame\(\(\) => loadECharts\(\)/);
    assert.match(chart, /const echarts = await loadECharts\(\)/);
    assert.match(loader, /requestAnimationFrame/);
    assert.match(loader, /import\('\.\/echarts-streamline\.min\.js'\)/);
    assert.match(loader, /catch\(error => \{\s*echartsPromise = null;/);
});

test('core startup does not wait for Visualizer verification', () => {
    const app = read('src/modules/app.js');
    assert.doesNotMatch(app, /await initVisualizer\(\)/);
    assert.match(app, /connectShotSettingsWebSocket\(handleShotSettingsData\);\s*void initVisualizer\(\)/);
    assert.match(app, /Promise\.all\(\[historyInit, profileManager\.init\(\)\]\)/);
});

test('expanded chart closes only from explicit controls', () => {
    const app = read('src/modules/app.js');
    assert.match(app, /backBtn\.addEventListener\('click', close\)/);
    assert.match(app, /e\.key === 'Escape'/);
    assert.doesNotMatch(app, /expanded-chart-overlay[\s\S]*?addEventListener\('(click|pointerdown)'/);
    assert.doesNotMatch(app, /closest\?\.\('\.legend'\)/);
});

test('production startup logging is disabled', () => {
    const app = read('src/modules/app.js');
    const chart = read('src/modules/chart.js');
    const logger = read('src/modules/logger.js');
    assert.doesNotMatch(app, /setDebug\(true\)/);
    assert.doesNotMatch(chart, /console\.log\('initChart/);
    assert.match(logger, /info: noop/);
});

test('startup scales and reveals before asynchronous preference reconciliation', () => {
    const app = read('src/modules/app.js');
    const scaling = read('src/modules/scaling.js');
    const css = read('src/css/main.css');
    assert.ok(app.indexOf('initScaling();') < app.indexOf('await Promise.all([i18nReady, unitsReady])'));
    assert.match(scaling, /updateScale\(\);[\s\S]*requestAnimationFrame\(\(\) => content\.classList\.add\('scaled'\)\)/);
    assert.match(scaling, /setTimeout\(updateScale, 250\)/);
    assert.doesNotMatch(scaling, /\}, 300\);\s*\}, 100\);/);
    assert.doesNotMatch(css.match(/#scaled-content \{[\s\S]*?\}/)?.[0] || '', /opacity|transition/);
});

test('startup preferences use local storage before IndexedDB and translations are version cached', () => {
    const i18n = read('src/modules/i18n.js');
    const units = read('src/modules/units.js');
    assert.ok(i18n.indexOf("localStorage.getItem('language')") < i18n.indexOf("getSetting('language')"));
    assert.ok(units.indexOf('localStorage.getItem(TEMP_UNIT_KEY)') < units.indexOf('getSetting(TEMP_UNIT_KEY)'));
    assert.match(i18n, /`translations:\$\{APP_VERSION\}:\$\{language\}`/);
    assert.match(i18n, /parsed = await getSetting\(cacheKey\)/);
    assert.match(i18n, /setSetting\(cacheKey, parsed\)/);
});
