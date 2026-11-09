import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { profileSwitchDial } from '../src/modules/profile-overrides.js';

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
            profileSwitchDial, applySavedSteamSettings,
            // Defaulted so the existing cases stay as they were: an idle machine
            // that never blocks. The brewing case overrides them.
            profileSendBlocked = () => false, setPendingProfileSend = () => {},
            currentMachineState = 'idle',
            // A profile change releases the recipe being dialled in (dye2#36).
            recipeIdPatch = () => ({ extras: { dye: { v: 1, recipeId: null } } })
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
        profileSwitchDial,
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
        profileSwitchDial,
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
        profileSwitchDial,
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
        profileSwitchDial,
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
// come down to the user's saved override for this profile -- and to nothing at
// all where there is none, which leaves the live dial-in standing (#189). Yield
// IS a profile field, so it comes from the recipe and is never carried across.
test('dose and grind come from the override or are left alone, yield from the recipe', async () => {
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
        profileSwitchDial,
        assignProfile: async () => 'unchanged',
        getTranslation: value => value,
        updateWorkflow: async (w) => { sent.push(w.context); return w; },
        setActiveProfile() {}, applyWorkflowToMainPageUI() {}, loadPage() {}
    });

    const blank = loadHarness(base({}));
    blank.select('a');
    await blank.handleConfirm();
    assert.ok(!('grinderSetting' in sent[0]), 'with no override the grind is not written at all');
    assert.ok(!('targetDoseWeight' in sent[0]), 'nor the dose, so the live one survives the switch');
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

test('Confirm holds the switch instead of writing frames into a running shot', async () => {
    const record = { profile: { title: 'A', target_weight: '36' } };
    const held = [], toasts = [];
    let sent = 0;
    const harness = loadHarness({
        availableProfiles: { a: record },
        logger: { info() {}, error() {}, warn() {} },
        alert() { throw new Error('must not alert'); },
        showToast: m => toasts.push(m),
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        assignProfile: async () => 'assigned',
        getTranslation: k => k,
        updateWorkflow: async () => { sent++; return { profile: { title: 'A' } }; },
        setActiveProfile() {}, applyWorkflowToMainPageUI() {}, loadPage() {},
        withSavedBrewTemp: p => p,
        lastGrinderSetting: () => null, lastTargetDoseWeight: () => null,
        applySavedSteamSettings: async () => {},
        profileSendBlocked: state => state === 'espresso',
        setPendingProfileSend: r => held.push(r),
        currentMachineState: 'espresso',
    });
    harness.select('a');
    await harness.handleConfirm();

    assert.equal(sent, 0, 'Decaid writes the frame table on any workflow profile change');
    assert.deepEqual(held, [record], 'the switch must be held, not dropped');
    assert.equal(toasts.length, 1);
});
