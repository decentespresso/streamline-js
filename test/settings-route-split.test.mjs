import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS_TREE } from '../src/settings/settings-tree.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('settings route swaps after the shell is initialized', () => {
    const router = read('src/modules/router.js');
    const shellInit = router.indexOf('await initializeSettingsShell()');
    const mainHide = router.indexOf("mainPage.style.display = 'none'", shellInit);

    assert.ok(shellInit > 0);
    assert.ok(mainHide > shellInit);
    assert.doesNotMatch(router, /import\('\.\.\/settings\/settings\.js'\)/);
});

test('settings shell keeps quick adjustments out of the legacy module', () => {
    const shell = read('src/settings/settings-shell.js');
    const quick = read('src/settings/categories/quick-adjustments.js');
    const maintenance = read('src/settings/categories/maintenance.js');
    const app = read('src/modules/app.js');

    assert.match(shell, /quickadjustments:\s*\(\) => import\('\.\/categories\/quick-adjustments\.js'\)/);
    assert.match(shell, /bluetooth:\s*\(\) => import\('\.\/categories\/connections\.js'\)/);
    assert.match(shell, /maintenance:\s*\(\) => import\('\.\/categories\/maintenance\.js'\)/);
    assert.match(shell, /getElementById\('settings-body'\)\?\.parentElement/);
    assert.doesNotMatch(quick, /settings\.js/);
    assert.doesNotMatch(maintenance, /settings\.js/);
    // Cleaning, descaling and transport mode share one templated view and one
    // state machine, so the three cannot drift. Transport mode used to run its
    // own bespoke flow with its own toasts: the literal state name is what that
    // looked like, and its absence is what keeps it folded in.
    assert.match(maintenance, /action === 'clean' \|\| action === 'descale' \|\| action === 'air-purge'/);
    assert.match(maintenance, /setMachineState\(procedure\.state\)/);
    assert.doesNotMatch(maintenance, /setMachineState\('airPurge'\)/);
    assert.match(app, /addEventListener\('pointerdown',[\s\S]*prefetchSettingsPage/);
});

test('the shell nav tree and the legacy nav tree share one source, so they cannot drift', () => {
    const shell = read('src/settings/settings-shell.js');
    const legacy = read('src/settings/settings.js');

    assert.match(shell, /import\s*\{\s*SETTINGS_TREE as CANONICAL_SETTINGS_TREE\s*\}\s*from\s*'\.\/settings-tree\.js'/);
    assert.match(legacy, /import\s*\{\s*SETTINGS_TREE as settingsTree\s*\}\s*from\s*'\.\/settings-tree\.js'/);
    // Guards against a hand-authored duplicate creeping back into the shell,
    // like the one that dropped calib_sensors and split Skin's two entries
    // into one before the tree was unified.
    assert.doesNotMatch(shell, /quickadjustments:\s*Object\.freeze\(\[/);
    assert.doesNotMatch(legacy, /'quickadjustments':\s*\{/);

    // Every main category in the canonical tree must have a loader or be the
    // one (quickadjustments) already covered by its own dedicated loader test.
    const mainCategories = Object.keys(SETTINGS_TREE);
    for (const category of mainCategories) {
        assert.match(shell, new RegExp(`${category}:\\s*\\(\\)\\s*=>\\s*import\\(`), `${category} has no CATEGORY_LOADERS entry in the shell`);
    }

    // calib_sensors and the split Skin entries (theme + appearance) are the
    // exact spots that had drifted; assert they still round-trip.
    assert.ok(SETTINGS_TREE.calibration.subcategories.some(sub => sub.settingsCategory === 'calib_sensors'));
    assert.deepEqual(SETTINGS_TREE.skin.subcategories.map(sub => sub.settingsCategory), ['theme', 'appearance']);
});

// The legacy module owns nav clicks once it mounts, and its category switch
// ends in `default: renderGeneralSettings()`. So a subcategory added to the
// tree without a case there does not fail loudly — it silently shows General
// Settings, which is exactly what maint_cleaning did.
test('every subcategory in the tree is routed by the legacy switch, not swallowed by its default', () => {
    const legacy = read('src/settings/settings.js');

    for (const [mainCategory, category] of Object.entries(SETTINGS_TREE)) {
        for (const sub of category.subcategories) {
            assert.ok(
                legacy.includes(`case '${sub.settingsCategory}':`),
                `${mainCategory}/${sub.settingsCategory} has no case in renderSettingsContent — it would fall through to renderGeneralSettings()`
            );
        }
    }
});

test('maintenance screens exist once, mounted from the extracted module by both paths', () => {
    const legacy = read('src/settings/settings.js');

    // The legacy switch hands these to categories/maintenance.js rather than
    // rendering a second copy that would drift from the extracted one.
    assert.match(legacy, /import\('\.\/categories\/maintenance\.js'\)/);
    assert.match(legacy, /MAINTENANCE_CATEGORIES\s*=\s*new Set\(\['maint_cleaning', 'maint_descaling', 'maint_airpurge'\]\)/);
    assert.doesNotMatch(legacy, /renderMainDescalingSettings|renderMainAirPurgeSettings/);
    assert.doesNotMatch(legacy, /window\.startAirPurge|window\.startDescaling/);
    // A mount left running after navigating away keeps polling the machine.
    assert.match(legacy, /maintenanceCleanup\?\.\(\)/);
});
