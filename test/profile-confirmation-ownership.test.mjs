import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function loadHarness(dependencies) {
    const source = readFileSync(new URL('../src/modules/profile_selector.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('let isConfirmingProfile = false;');
    const end = source.indexOf('function handleCancel', start);
    assert.ok(start >= 0 && end > start);

    return new Function('dependencies', `
        const {
            availableProfiles, logger, alert, showToast, sessionStorage,
            assignProfile, getTranslation, updateWorkflow, setActiveProfile,
            applyWorkflowToMainPageUI, loadPage, withSavedBrewTemp,
            lastGrinderSetting, lastTargetDoseWeight, applySavedSteamSettings
        } = dependencies;
        let selectedProfileKey = null;
        const FAV_COUNT = 5;
        const DEFAULT_DOSE_WEIGHT = 18; // profileManager's, not an injected dependency
        ${source.slice(start, end)}
        return {
            handleConfirm,
            applyConfirmButtonLabel,
            select(profileKey) { selectedProfileKey = profileKey; }
        };
    `)(dependencies);
}

test('profile confirmation pins its selection and rejects overlap', async () => {
    let resolveFirst;
    const firstWorkflow = new Promise(resolve => { resolveFirst = resolve; });
    let updateTitles = [];
    let activeKeys = [];
    let appliedTitles = [];
    let navigationCount = 0;
    let alertCount = 0;

    const availableProfiles = Object.freeze({
        a: Object.freeze({ profile: Object.freeze({ title: 'A', target_weight: '36' }) }),
        b: Object.freeze({ profile: Object.freeze({ title: 'B', target_weight: '40' }) })
    });
    const harness = loadHarness({
        availableProfiles,
        logger: { info() {}, error() {} },
        alert() { alertCount += 1; },
        showToast() {},
        sessionStorage: { getItem: () => null, removeItem() {} },
        // Saved brew-temp folding has its own coverage in
        // brew-temp-override.test.mjs; here it just has to be callable.
        withSavedBrewTemp: (profile) => profile,
        applySavedSteamSettings: async () => {},
        lastGrinderSetting: () => null,
        lastTargetDoseWeight: () => null,
        assignProfile: async () => 'unchanged',
        getTranslation: value => value,
        updateWorkflow(workflow) {
            updateTitles = [...updateTitles, workflow.profile.title];
            return updateTitles.length === 1 ? firstWorkflow : Promise.resolve(workflow);
        },
        setActiveProfile(profileKey) {
            activeKeys = [...activeKeys, profileKey];
        },
        applyWorkflowToMainPageUI(workflow) { appliedTitles = [...appliedTitles, workflow.profile.title]; },
        loadPage() { navigationCount += 1; }
    });

    harness.select('a');
    const firstConfirmation = harness.handleConfirm();
    harness.select('b');
    await harness.handleConfirm();

    assert.deepEqual(updateTitles, ['A']);

    resolveFirst({ profile: { title: 'A' } });
    await firstConfirmation;

    assert.deepEqual(activeKeys, ['a']);
    assert.deepEqual(appliedTitles, ['A']);
    assert.equal(navigationCount, 1);

    await harness.handleConfirm();

    assert.deepEqual(updateTitles, ['A', 'B']);
    assert.deepEqual(activeKeys, ['a', 'b']);
    assert.deepEqual(appliedTitles, ['A', 'B']);
    assert.equal(navigationCount, 2);
    assert.equal(alertCount, 0);
});

// A long press on an unassigned/replaceable favorite button on the main page
// stashes pendingAssignmentIndex and routes here (profileManager.js
// handleProfileClick / openFavoriteContextMenu) -- that is now the only way to
// assign a favorite, so the header button must say so instead of a generic
// CONFIRM.
test('confirm button label reflects a pending favorite assignment', () => {
    const harness = loadHarness({
        availableProfiles: {},
        logger: { info() {}, error() {} },
        alert() {},
        showToast() {},
        sessionStorage: { getItem: () => null, removeItem() {} },
        withSavedBrewTemp: (profile) => profile,
        applySavedSteamSettings: async () => {},
        lastGrinderSetting: () => null,
        lastTargetDoseWeight: () => null,
        assignProfile: async () => 'unchanged',
        getTranslation: value => value,
        updateWorkflow: async (w) => w,
        setActiveProfile() {},
        applyWorkflowToMainPageUI() {},
        loadPage() {}
    });

    const button = { textContent: '' };

    harness.applyConfirmButtonLabel(button);
    assert.equal(button.textContent, 'CONFIRM', 'no pending assignment falls back to CONFIRM');

    const pendingHarness = loadHarness({
        availableProfiles: {},
        logger: { info() {}, error() {} },
        alert() {},
        showToast() {},
        sessionStorage: { getItem: () => '2', removeItem() {} },
        withSavedBrewTemp: (profile) => profile,
        applySavedSteamSettings: async () => {},
        lastGrinderSetting: () => null,
        lastTargetDoseWeight: () => null,
        assignProfile: async () => 'unchanged',
        getTranslation: value => value,
        updateWorkflow: async (w) => w,
        setActiveProfile() {},
        applyWorkflowToMainPageUI() {},
        loadPage() {}
    });
    pendingHarness.applyConfirmButtonLabel(button);
    assert.equal(button.textContent, 'ASSIGN TO #3', 'pending index 2 labels the button as favorite slot 3');

    const outOfRangeHarness = loadHarness({
        availableProfiles: {},
        logger: { info() {}, error() {} },
        alert() {},
        showToast() {},
        sessionStorage: { getItem: () => '9', removeItem() {} },
        withSavedBrewTemp: (profile) => profile,
        applySavedSteamSettings: async () => {},
        lastGrinderSetting: () => null,
        lastTargetDoseWeight: () => null,
        assignProfile: async () => 'unchanged',
        getTranslation: value => value,
        updateWorkflow: async (w) => w,
        setActiveProfile() {},
        applyWorkflowToMainPageUI() {},
        loadPage() {}
    });
    outOfRangeHarness.applyConfirmButtonLabel(button);
    assert.equal(button.textContent, 'CONFIRM', 'an out-of-range pending index must not be shown as a slot');
});

// Decaid's profile schema has no dose (profile.dart toJson), so dose and grind
// both come down to the user's saved override for this profile, then the last
// number they set anywhere, then the stock basket. Yield IS a profile field, so
// it comes from the recipe and is never carried across a switch.
test('dose and grind fall back to the last ones set, yield to the recipe', async () => {
    const sent = [];
    const steamApplied = [];
    const base = (meta, profile = { title: 'A', target_weight: '36' }) => ({
        availableProfiles: {
            a: { profile, metadata: meta }
        },
        logger: { info() {}, error() {} },
        alert() {}, showToast() {},
        sessionStorage: { getItem: () => null, removeItem() {} },
        withSavedBrewTemp: (profile) => profile,
        applySavedSteamSettings: async (meta) => { steamApplied.push(meta); },
        lastGrinderSetting: () => '3.5',
        lastTargetDoseWeight: () => 20,
        assignProfile: async () => 'unchanged',
        getTranslation: value => value,
        updateWorkflow: async (w) => { sent.push(w.context); return w; },
        setActiveProfile() {}, applyWorkflowToMainPageUI() {}, loadPage() {}
    });

    const blank = loadHarness(base({}));
    blank.select('a');
    await blank.handleConfirm();
    assert.equal(sent[0].grinderSetting, '3.5', 'grind carries over rather than clearing');
    assert.equal(sent[0].targetDoseWeight, 20, 'with no override, the last dose set is used');
    assert.equal(sent[0].targetYield, 36, 'yield still comes from the profile');

    const saved = loadHarness(base({ grinderSetting: '1.2', targetDoseWeight: 15 }));
    saved.select('a');
    await saved.handleConfirm();
    assert.equal(sent[1].grinderSetting, '1.2', "this profile's own grind still wins");
    assert.equal(sent[1].targetDoseWeight, 15, "the user's saved dose outranks the carried one");

    // Zero is a value, not an absence: a saved dose of 0 must reach the machine as
    // 0, and a recipe with no target weight must send 0 rather than a stale yield.
    const zero = loadHarness(base({ targetDoseWeight: 0 }, { title: 'A', target_weight: '0' }));
    zero.select('a');
    await zero.handleConfirm();
    assert.equal(sent[2].targetDoseWeight, 0, 'a saved dose of 0 is sent as 0');
    assert.equal(sent[2].targetYield, 0, 'a target weight of 0 is sent as 0');

    // Steam rides its own setters rather than the workflow context, so confirming
    // here has to hand this profile's metadata to the same applier the favourite
    // buttons use -- otherwise a saved steam setting only survives one of the two
    // ways into a profile switch.
    assert.deepEqual(steamApplied,
        [{}, { grinderSetting: '1.2', targetDoseWeight: 15 }, { targetDoseWeight: 0 }],
        'every confirm offers the profile metadata to the steam applier');
});
