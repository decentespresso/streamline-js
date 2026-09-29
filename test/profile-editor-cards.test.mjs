// Pure logic behind the profile editor's CARDS view: the pump-mode and
// "move on if" cycling chips, the card-paging scroll math, which reorder
// chevron is disabled at the ends of the step list, and the SAVE / SAVE AS
// NEW put-vs-post-vs-blocked routing decision.
//
// profile_editor.js touches the DOM at import time, so — same pattern as
// profile-editor.test.mjs and grid_stepper_hint.test.mjs before it — each
// relevant block is lifted out of the real source with a slice/regex, not
// hand-copied, so this can't silently drift from what actually ships.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/profile_editor.js', import.meta.url), 'utf8');

const start = source.indexOf('// ─── Pure state-cycle + paging math');
const end = source.indexOf('// ─── Card collapse/expand state');
assert.ok(start !== -1 && end !== -1 && end > start, 'pure state-cycle block not found in profile_editor.js');
const body = source.slice(start, end);

// Minimal translation stub: identity for the terms these labels compose from,
// so a label reads as (say) "Flow Quickly" without pulling in the real CSV.
const TRANSLATIONS = {
    Pressure: 'Pressure', Flow: 'Flow',
    Quickly: 'Quickly', Slowly: 'Slowly',
    'is over': 'is over', 'is under': 'is under',
    Off: 'Off',
};
const getTranslation = (key) => TRANSLATIONS[key] ?? key;

const M = new Function('getTranslation', `${body}
    return { PUMP_CYCLE_STATES, pumpCycleIndex, pumpChipLabel, EXIT_CYCLE_STATES, exitCycleIndex, exitChipLabel, CARD_WIDTH, CARD_GAP, CARD_PITCH, isChevronDisabled };`)(getTranslation);

// ── Pump-mode cycle ─────────────────────────────────────────────────────────

test('pump cycle order is Flow Quickly, Flow Slowly, Pressure Quickly, Pressure Slowly', () => {
    assert.deepEqual(M.PUMP_CYCLE_STATES, [
        { pump: 'flow', transition: 'fast' },
        { pump: 'flow', transition: 'smooth' },
        { pump: 'pressure', transition: 'fast' },
        { pump: 'pressure', transition: 'smooth' },
    ]);
});

test('pumpCycleIndex maps every (pump, transition) pair to its slot', () => {
    assert.equal(M.pumpCycleIndex('flow', 'fast'), 0);
    assert.equal(M.pumpCycleIndex('flow', 'smooth'), 1);
    assert.equal(M.pumpCycleIndex('pressure', 'fast'), 2);
    assert.equal(M.pumpCycleIndex('pressure', 'smooth'), 3);
});

test('the index round-trips through PUMP_CYCLE_STATES back to the same state', () => {
    for (const state of M.PUMP_CYCLE_STATES) {
        const i = M.pumpCycleIndex(state.pump, state.transition);
        assert.deepEqual(M.PUMP_CYCLE_STATES[i], state);
    }
});

test('tapping the chip N times from any state cycles forward and wraps after 4', () => {
    let i = M.pumpCycleIndex('pressure', 'smooth'); // last state
    i = (i + 1) % M.PUMP_CYCLE_STATES.length;
    assert.deepEqual(M.PUMP_CYCLE_STATES[i], { pump: 'flow', transition: 'fast' });
});

test('pumpChipLabel composes from existing translation keys, not a combined CSV row', () => {
    assert.equal(M.pumpChipLabel({ pump: 'flow', transition: 'fast' }), 'Flow Quickly');
    assert.equal(M.pumpChipLabel({ pump: 'flow', transition: 'smooth' }), 'Flow Slowly');
    assert.equal(M.pumpChipLabel({ pump: 'pressure', transition: 'fast' }), 'Pressure Quickly');
    assert.equal(M.pumpChipLabel({ pump: 'pressure', transition: 'smooth' }), 'Pressure Slowly');
});

// ── "Move on if" cycle ──────────────────────────────────────────────────────

test('exit cycle order is Pressure over, Pressure under, Flow over, Flow under, Off', () => {
    assert.deepEqual(M.EXIT_CYCLE_STATES, [
        { type: 'pressure', condition: 'over' },
        { type: 'pressure', condition: 'under' },
        { type: 'flow', condition: 'over' },
        { type: 'flow', condition: 'under' },
        { type: 'off', condition: null },
    ]);
});

test('exitCycleIndex maps every (type, condition) pair to its slot, and off to the last one', () => {
    assert.equal(M.exitCycleIndex('pressure', 'over'), 0);
    assert.equal(M.exitCycleIndex('pressure', 'under'), 1);
    assert.equal(M.exitCycleIndex('flow', 'over'), 2);
    assert.equal(M.exitCycleIndex('flow', 'under'), 3);
    assert.equal(M.exitCycleIndex('off', 'over'), 4);
    // Anything readExitDef wouldn't recognize as pressure/flow reads as off too.
    assert.equal(M.exitCycleIndex(undefined, undefined), 4);
});

test('the index round-trips through EXIT_CYCLE_STATES for every non-off state', () => {
    for (const state of M.EXIT_CYCLE_STATES) {
        if (state.type === 'off') continue;
        const i = M.exitCycleIndex(state.type, state.condition);
        assert.deepEqual(M.EXIT_CYCLE_STATES[i], state);
    }
});

test('off is reachable and leavable in the 5-state cycle', () => {
    let i = M.exitCycleIndex('flow', 'under'); // just before off
    i = (i + 1) % M.EXIT_CYCLE_STATES.length;
    assert.deepEqual(M.EXIT_CYCLE_STATES[i], { type: 'off', condition: null });
    i = (i + 1) % M.EXIT_CYCLE_STATES.length; // off wraps back to the start
    assert.deepEqual(M.EXIT_CYCLE_STATES[i], { type: 'pressure', condition: 'over' });
});

test('exitChipLabel composes from existing translation keys, and Off is its own key', () => {
    assert.equal(M.exitChipLabel({ type: 'pressure', condition: 'over' }), 'Pressure is over');
    assert.equal(M.exitChipLabel({ type: 'pressure', condition: 'under' }), 'Pressure is under');
    assert.equal(M.exitChipLabel({ type: 'flow', condition: 'over' }), 'Flow is over');
    assert.equal(M.exitChipLabel({ type: 'flow', condition: 'under' }), 'Flow is under');
    assert.equal(M.exitChipLabel({ type: 'off' }), 'Off');
});

// ── Card paging ──────────────────────────────────────────────────────────────

test('the scroll pitch is exactly one card plus the gap between cards', () => {
    assert.equal(M.CARD_WIDTH, 450);
    assert.equal(M.CARD_GAP, 15);
    assert.equal(M.CARD_PITCH, 465);
});

// ── Header reorder chevrons ─────────────────────────────────────────────────

test('both chevrons are enabled in the middle of the run', () => {
    assert.equal(M.isChevronDisabled(2, -1, 5), false);
    assert.equal(M.isChevronDisabled(2, 1, 5), false);
});

test('the left chevron is disabled on the first card', () => {
    assert.equal(M.isChevronDisabled(0, -1, 5), true);
    assert.equal(M.isChevronDisabled(0, 1, 5), false);
});

test('the right chevron is disabled on the last card', () => {
    assert.equal(M.isChevronDisabled(4, 1, 5), true);
    assert.equal(M.isChevronDisabled(4, -1, 5), false);
});

test('a single-card profile disables both chevrons', () => {
    assert.equal(M.isChevronDisabled(0, -1, 1), true);
    assert.equal(M.isChevronDisabled(0, 1, 1), true);
});

// ── SAVE / SAVE AS NEW routing (resolveSaveTarget) ──────────────────────────
// Extracted separately (it lives well past the pure state-cycle block, next
// to saveProfile itself) and run for real rather than mirrored, so the full
// put/post/blocked matrix can't silently drift from what saveProfile() calls.
const resolveMatch = source.match(/function resolveSaveTarget\(\{[\s\S]*?\r?\n\}/);
assert.ok(resolveMatch, 'resolveSaveTarget not found in profile_editor.js');
const resolveSaveTarget = new Function(`${resolveMatch[0]}\nreturn resolveSaveTarget;`)();

test('no source record always posts, regardless of asNew', () => {
    for (const asNew of [false, true]) {
        assert.equal(resolveSaveTarget({ hasSource: false, isDefault: false, execChanged: true, titleChanged: true, asNew }), 'post');
        assert.equal(resolveSaveTarget({ hasSource: false, isDefault: false, execChanged: false, titleChanged: false, asNew }), 'post');
    }
});

test('a default with an execution change always forks, regardless of asNew', () => {
    for (const asNew of [false, true]) {
        assert.equal(resolveSaveTarget({ hasSource: true, isDefault: true, execChanged: true, titleChanged: false, asNew }), 'post');
        assert.equal(resolveSaveTarget({ hasSource: true, isDefault: true, execChanged: true, titleChanged: true, asNew }), 'post');
    }
});

test('a default with no execution change is always blocked, regardless of asNew', () => {
    // PUT is rejected server-side for a default, and POST would dedup by
    // content hash back to the same default — title isn't part of that hash.
    for (const asNew of [false, true]) {
        assert.equal(resolveSaveTarget({ hasSource: true, isDefault: true, execChanged: false, titleChanged: true, asNew }), 'blocked');
    }
});

test('SAVE (asNew=false) always PUTs a presentation-only change to a user profile, title changed or not', () => {
    assert.equal(resolveSaveTarget({ hasSource: true, isDefault: false, execChanged: false, titleChanged: false, asNew: false }), 'put');
    assert.equal(resolveSaveTarget({ hasSource: true, isDefault: false, execChanged: false, titleChanged: true, asNew: false }), 'put');
});

test('SAVE (asNew=false) with an execution change still posts — the hide+replace overwrite path, not a raw PUT', () => {
    assert.equal(resolveSaveTarget({ hasSource: true, isDefault: false, execChanged: true, titleChanged: false, asNew: false }), 'post');
    assert.equal(resolveSaveTarget({ hasSource: true, isDefault: false, execChanged: true, titleChanged: true, asNew: false }), 'post');
});

test('SAVE AS NEW (asNew=true) with an execution change always posts a genuinely new record', () => {
    assert.equal(resolveSaveTarget({ hasSource: true, isDefault: false, execChanged: true, titleChanged: true, asNew: true }), 'post');
});

test('SAVE AS NEW (asNew=true) with no execution change is blocked, not silently deduped', () => {
    // POST would hit the server's content-hash dedup and return the *source*
    // record untouched, dropping the new title with no error — block instead.
    assert.equal(resolveSaveTarget({ hasSource: true, isDefault: false, execChanged: false, titleChanged: true, asNew: true }), 'blocked');
});

// resolveSaveTarget only answers "PUT, POST, or blocked" — for a real
// execution change both SAVE and SAVE AS NEW land on 'post' at this level,
// since HTTP-verb-wise both go through uploadProfileWithParent. Which of the
// three POST call sites saveProfile then picks (hide+replace overwrite vs.
// plain save-as vs. forced default fork) is where SAVE and SAVE AS NEW
// actually diverge; that decision, and the "must differ once the title has
// changed" contrast, is covered end to end in test/profile-save-routing.test.mjs
// (route(), asNew=false vs asNew=true on the identical edit).

// ── Title collision on save (resolveFinalTitle) ─────────────────────────────
// A real fork (Save As New, or a default forced to fork on an execution
// change) mints a second record, so it must collide with its own still-
// visible source if the title was left unchanged — not just with every OTHER
// profile. A PUT, or SAVE's hide+replace overwrite, is the same profile kept
// under whatever title it now has, so neither ever gets suffixed.
const finalTitleMatch = source.match(/function resolveFinalTitle\(\{[\s\S]*?\r?\n\}/);
assert.ok(finalTitleMatch, 'resolveFinalTitle not found in profile_editor.js');
const resolveFinalTitle = new Function(`${finalTitleMatch[0]}\nreturn resolveFinalTitle;`)();

test('fork without a rename suffixes against its own parent', () => {
    // Save As New, title left unchanged: nothing else is named "Espresso",
    // but the source itself is — must still produce "Espresso (2)".
    assert.equal(resolveFinalTitle({
        title: 'Espresso', existingTitles: new Set(['Latte']),
        sourceId: 'p1', sourceTitle: 'Espresso', asNew: true, target: 'post', isDefault: false,
    }), 'Espresso (2)');
});

test('fork without a rename still suffixes past an existing (n)', () => {
    assert.equal(resolveFinalTitle({
        title: 'Espresso', existingTitles: new Set(['Espresso (2)']),
        sourceId: 'p1', sourceTitle: 'Espresso', asNew: true, target: 'post', isDefault: false,
    }), 'Espresso (3)');
});

test('fork WITH a rename to a genuinely free title needs no suffix', () => {
    assert.equal(resolveFinalTitle({
        title: 'Morning blend', existingTitles: new Set(['Latte']),
        sourceId: 'p1', sourceTitle: 'Espresso', asNew: true, target: 'post', isDefault: false,
    }), 'Morning blend');
});

test('a default forced to fork on an execution change also collides with itself', () => {
    assert.equal(resolveFinalTitle({
        title: 'Espresso', existingTitles: new Set(),
        sourceId: 'default:1', sourceTitle: 'Espresso', asNew: false, target: 'post', isDefault: true,
    }), 'Espresso (2)');
});

test('a brand-new profile with no source collides only with other profiles', () => {
    assert.equal(resolveFinalTitle({
        title: 'Espresso', existingTitles: new Set(['Espresso']),
        sourceId: null, sourceTitle: null, asNew: false, target: 'post', isDefault: false,
    }), 'Espresso (2)');
});

test('SAVE overwriting in place (hide+replace) keeps its title, renamed or not', () => {
    // asNew=false, execChanged, non-default → the 'overwrite' path. Title
    // changed here on purpose to prove titleChanged plays no part.
    assert.equal(resolveFinalTitle({
        title: 'Londinium v2', existingTitles: new Set(['Londinium v2']), // even a real collision is ignored
        sourceId: 'p1', sourceTitle: 'Londinium', asNew: false, target: 'post', isDefault: false,
    }), 'Londinium v2');
});

test('a plain PUT keeps its title unconditionally', () => {
    assert.equal(resolveFinalTitle({
        title: 'Londinium v2', existingTitles: new Set(['Londinium v2']),
        sourceId: 'p1', sourceTitle: 'Londinium', asNew: false, target: 'put', isDefault: false,
    }), 'Londinium v2');
});
