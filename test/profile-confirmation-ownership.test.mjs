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
            applyWorkflowToMainPageUI, loadPage, withSavedBrewTemp
        } = dependencies;
        let selectedProfileKey = null;
        const FAV_COUNT = 5;
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
        a: Object.freeze({ profile: Object.freeze({ title: 'A', target_weight: '36', dose_weight: 18 }) }),
        b: Object.freeze({ profile: Object.freeze({ title: 'B', target_weight: '40', dose_weight: 20 }) })
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
