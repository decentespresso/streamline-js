// Check of the fit math in src/modules/scaling.js (mirrored here — the module
// touches the DOM at import time). Run: node test/scaling-fit.test.mjs
import assert from 'node:assert';
import { KEYBOARD_GAP, SHRINK_ADOPT_MS, trackBaseline, keyboardLift, visibleBand } from '../src/modules/keyboard-fit.js';

const DESIGN_W = 1920, DESIGN_H = 1200, MAX_STRETCH = 1.0;
// Rigid part of the main page: 168 header + 150 profile/telemetry band +
// #chart-wrap's 450 min-height + the 242 footer band (main.css).
const MIN_CANVAS_H = 1010;

// The canvas is elastic at a uniform scale: it grows past 1200 design rows on
// screens taller than 16:10 and shrinks below it on shorter ones, down to the
// rigid height of the main page. Only flatter-than-1920:1010 screens fall back
// to the clamped x/y squash.
function fit(w, h) {
    let sx = w / DESIGN_W, sy = h / DESIGN_H, canvasH = DESIGN_H;
    if (h / sx >= MIN_CANVAS_H) {
        sy = sx;
        canvasH = h / sx;
    } else {
        const stretch = Math.max(sx, sy) / Math.min(sx, sy);
        if (stretch > MAX_STRETCH) {
            const k = MAX_STRETCH / stretch;
            if (sx > sy) sx *= k; else sy *= k;
        }
    }
    return { sx, sy, canvasH, gutterX: w - DESIGN_W * sx, gutterY: h - canvasH * sy };
}

// 16:10 panels are exact — no stretch, no gutters, no shrink.
for (const [w, h] of [[1920, 1200], [1280, 800], [2560, 1600]]) {
    const f = fit(w, h);
    assert.strictEqual(f.sx, f.sy, `${w}x${h} should be uniform`);
    assert.strictEqual(f.canvasH, DESIGN_H, `${w}x${h} canvas stays at design height`);
    assert.ok(Math.abs(f.gutterX) < 0.5 && Math.abs(f.gutterY) < 0.5, `${w}x${h} gutter-free`);
}

// Teclast / Samsung A7 Lite 8.7" panels: shorter than 16:10, so the canvas
// shrinks. Squashing the canvas stretched the text (issue #162's predecessor)
// and refusing to squash left 30px gutters each side -- neither is allowed.
for (const [w, h] of [[1340, 800], [1340, 736], [1920, 1080]]) {
    const f = fit(w, h);
    assert.strictEqual(f.sx, f.sy, `${w}x${h} must stay uniform (no text stretch)`);
    assert.ok(Math.abs(f.gutterX) < 0.5, `${w}x${h} must fill: gutter ${f.gutterX}`);
    assert.ok(Math.abs(f.gutterY) < 0.5, `${w}x${h} must fill vertically: gutter ${f.gutterY}`);
    assert.ok(f.canvasH < DESIGN_H && f.canvasH >= MIN_CANVAS_H, `${w}x${h} canvas ${f.canvasH} out of range`);
}

// Wildly wrong aspect (portrait phone) must still be sane — it takes the grow
// branch, which is uniform by construction, so nothing can explode.
const portrait = fit(800, 1340);
assert.strictEqual(portrait.sx, portrait.sy, 'portrait stays uniform');
assert.ok(portrait.canvasH > DESIGN_H, 'portrait grows the canvas');

// 4:3 iPads: the grow branch must remove the bars outright, with no stretch.
for (const [name, w, h] of [['iPad Pro 12.9', 1366, 1024], ['iPad Pro 11', 1194, 834], ['iPad 10.2', 1080, 810]]) {
    const f = fit(w, h);
    assert.strictEqual(f.sx, f.sy, `${name} must not stretch`);
    assert.ok(Math.abs(f.gutterX) < 0.5 && Math.abs(f.gutterY) < 0.5, `${name} must have no bars`);
    assert.ok(f.canvasH > DESIGN_H, `${name} canvas should grow past ${DESIGN_H}`);
}

// The main page's vertical budget: header + telemetry band + chart, with the
// absolutely-placed footer band bottom-anchored (main.css). The growing chart
// must stop exactly at the footer's top edge and never shrink below its design
// height -- that pairing is what #chart-wrap's min-height and <main>'s
// padding-bottom enforce in CSS.
// The band positions its name and telemetry absolutely, so it cannot give up
// rows without clipping them: on a shrinking canvas the chart is what gives,
// down to its 450px floor.
const HEADER = 168, TELEMETRY = 150, FOOTER = 242, CHART_MIN = 450;
for (const [name, w, h] of [
    ['design', 1920, 1200], ['Teclast', 1340, 800], ['A7 Lite + chrome', 1340, 736],
    ['16:9 panel', 1920, 1080], ['iPad Pro 12.9', 1366, 1024], ['iPad 10.2', 1080, 810],
]) {
    const { canvasH } = fit(w, h);
    const chart = Math.max(CHART_MIN, canvasH - HEADER - FOOTER - TELEMETRY);
    const chartBottom = HEADER + TELEMETRY + chart;
    const footerTop = canvasH - FOOTER;
    assert.ok(chart >= CHART_MIN, `${name}: chart shrank below its floor (${chart})`);
    assert.ok(Math.abs(chartBottom - footerTop) < 1, `${name}: chart overlaps footer by ${chartBottom - footerTop}`);
}

// Design size must stay bit-identical to the pre-change layout.
const design = fit(1920, 1200);
assert.ok(design.sx === 1 && design.sy === 1 && design.canvasH === DESIGN_H, 'design size regressed');

// Zoomed-in anchor (mirrors scaling.js's uiZoom>1 branch): normally left-anchored
// (offsetX 0) so the left sidebar stays visible, but right-anchored when the GHC
// column is shown so that 172px-wide machine-control column at the canvas's right
// edge (x:1748-1920) doesn't get pushed off-screen instead.
function zoomOffsetX(screenWidth, sx, ghcVisible) {
    return ghcVisible ? screenWidth - DESIGN_W * sx : 0;
}
{
    const screenWidth = 776, sx = 776 / DESIGN_W * 1.3; // "Extra Large" display size
    const noGhc = zoomOffsetX(screenWidth, sx, false);
    const withGhc = zoomOffsetX(screenWidth, sx, true);
    assert.strictEqual(noGhc, 0, 'left sidebar anchor must stay put without GHC');
    assert.ok(DESIGN_W * sx + withGhc <= screenWidth + 0.01, `GHC's right edge must not exceed the viewport: ${DESIGN_W * sx + withGhc} > ${screenWidth}`);
    assert.ok(Math.abs((DESIGN_W * sx + withGhc) - screenWidth) < 0.01, 'GHC column must sit flush against the viewport right edge');
}

// Soft-keyboard lift (mirrors the keyboardShift block in scaling.js). The canvas
// keeps its pre-keyboard height, so the focused field has to be lifted clear of
// the keyboard in the transform; scrollIntoView can't do it because the viewport
// is overflow:hidden and has its scrollTop reset on every pass.
const GAP = 12;
function lift(shift, rectTop, rectBottom, visibleHeight) {
    const overlap = rectBottom + GAP - visibleHeight;
    if (overlap <= 0) return shift;
    return shift + Math.min(overlap, Math.max(0, rectTop - GAP));
}
{
    // A field already above the keyboard is left alone.
    assert.strictEqual(lift(0, 100, 160, 600), 0, 'field clear of the keyboard must not move');

    // A covered field is lifted by exactly its overlap, gap included.
    assert.strictEqual(lift(0, 590, 650, 600), 650 + GAP - 600, 'lift must equal the overlap');

    // Converges in one pass: getBoundingClientRect on the next pass already
    // includes the shift, so re-running must not stack a second lift.
    const first = lift(0, 590, 650, 600);
    const second = lift(first, 590 - first, 650 - first, 600);
    assert.strictEqual(second, first, 'a settled lift must not grow on the next pass');

    // Never lift so far that the field's own top leaves the screen: a tall field
    // near the top can only rise until its top reaches the gap.
    assert.strictEqual(lift(0, 20, 900, 400), 20 - GAP, 'lift is capped by the field top');
    assert.ok(lift(0, 5, 900, 400) === 0, 'a field already at the top edge must not move');

    // Keyboard down resets the canvas rather than leaving it lifted.
    const down = 0; // scaling.js assigns keyboardShift = 0 on the !keyboardShrunk path
    assert.strictEqual(down, 0, 'keyboard down must clear the lift');
}

console.log('ok — scaling fit math');

// ── Soft keyboard ──────────────────────────────────────────────────────────
//
// Decaid's activity is adjustResize, so the WebView shrinks when the keyboard
// opens. #scaling-container is overflow:hidden and resets its scrollTop every
// pass, so a focused field cannot be scrolled into view -- the canvas is lifted
// under it instead. A full-screen overlay is a different problem: it is as tall
// as the design canvas, so lifting it pushes its header off the top and leaves
// the text under the keyboard, which is why it shrinks to visibleBand() instead.

// A keyboard taking the bottom 45% of an 800px-tall screen.
const KB_VISIBLE = 440;

// A field flush with the keyboard reads as covered, so the lift leaves a gap.
{
    const field = { top: 500, bottom: 540 };
    const lift = keyboardLift(field, KB_VISIBLE, 0);
    assert.equal(lift, 128, 'bottom 540 + 28 gap - 440 visible');
    assert.ok(field.bottom - lift + KEYBOARD_GAP <= KB_VISIBLE, 'the field clears the keyboard');
}

// Already clear of it: no lift, so a tap on a field near the top never moves the page.
for (const field of [{ top: 10, bottom: 50 }, { top: 300, bottom: 400 }, { top: 0, bottom: KB_VISIBLE - KEYBOARD_GAP }]) {
    assert.equal(keyboardLift(field, KB_VISIBLE, 0), 0);
}
assert.equal(keyboardLift(null, KB_VISIBLE, 0), 0);

// The lift never takes a field's own top off-screen: a field at the very bottom
// of a tall page rises as far as it can and no further.
{
    const field = { top: 60, bottom: 790 };
    assert.equal(keyboardLift(field, KB_VISIBLE, 0), 32, 'capped at top - gap, not the 378 overlap');
}

// The answer is absolute, not an increment: a rect measured with a lift already
// applied, passed back as `applied`, gives the same total. One pass settles it,
// which is what keeps a keyboard's resize storm from writing the transform and
// firing streamline:scaleupdate three or four times.
{
    const field = { top: 500, bottom: 540 };
    const once = keyboardLift(field, KB_VISIBLE, 0);
    assert.equal(once, 128);
    const again = keyboardLift({ top: field.top - once, bottom: field.bottom - once }, KB_VISIBLE, once);
    assert.equal(again, once, 'measuring the lifted field returns the same lift, not more');
    // And a field that moved further down the page while the keyboard stayed up
    // gets a bigger lift, not a second increment on top of the old one.
    const lower = keyboardLift({ top: 600 - once, bottom: 650 - once }, KB_VISIBLE, once);
    assert.equal(lower, 238);
}

// The canvas must never be re-scaled to fit a keyboard: the whole UI shrinking
// is worse than a covered field, and a covered field can be moved instead. A
// shrink that appeared while something was being typed into is a keyboard and
// stays one until the window grows back -- on Android the keyboard often stays
// up when focus moves to a button, and adopting then is the "the page shrank
// when I tapped the title" bug.
{
    const W = 1340;
    const start = { baselineHeight: 800, baselineWidth: W, shrunkSince: 0, keyboardLike: false, shrunk: false };
    const t0 = 10_000;
    const track = (state, over) => trackBaseline(state, { rawWidth: W, editing: false, now: t0, ...over });

    // The keyboard arrives while the title is focused: the baseline holds, so the
    // canvas keeps its size and only moves.
    const kb = track(start, { rawHeight: 440, visibleHeight: 440, editing: true });
    assert.equal(kb.baselineHeight, 800);
    assert.equal(kb.shrunk, true);
    assert.equal(kb.keyboardLike, true);

    // Still typing much later: still 800.
    assert.equal(track(kb, { rawHeight: 440, visibleHeight: 440, editing: true, now: t0 + 30_000 }).baselineHeight, 800);

    // Focus leaves the field but the keyboard stays up -- tapping the description
    // preview, or any button. This is what shrank the page on the tablet.
    const blurred = track(kb, { rawHeight: 440, visibleHeight: 440, now: t0 + 700 });
    assert.equal(blurred.baselineHeight, 800, 'a blur with the keyboard still up must not re-scale');
    const muchLater = track(blurred, { rawHeight: 440, visibleHeight: 440, now: t0 + 60_000 });
    assert.equal(muchLater.baselineHeight, 800, 'and it never becomes the window size by waiting');

    // Growing back is immediate and clears the keyboard mark.
    const back = track(muchLater, { rawHeight: 800, visibleHeight: 800, now: t0 + 61_000 });
    assert.equal(back.baselineHeight, 800);
    assert.equal(back.shrunk, false);
    assert.equal(back.keyboardLike, false);
    // A window larger than the baseline raises it.
    assert.equal(track(start, { rawHeight: 1000, visibleHeight: 1000 }).baselineHeight, 1000);

    // A shrink nobody ever typed into is a host resizing the WebView: adopted
    // once it has held, so the canvas fits the window it actually has.
    const idle = track(start, { rawHeight: 600, visibleHeight: 600 });
    assert.equal(idle.baselineHeight, 800, 'not at once');
    assert.equal(idle.keyboardLike, false);
    assert.equal(track(idle, { rawHeight: 600, visibleHeight: 600, now: t0 + SHRINK_ADOPT_MS }).baselineHeight, 600);

    // A change of width cannot be a keyboard: a rotation or a split-screen resize.
    const narrower = track(kb, { rawHeight: 440, visibleHeight: 440, rawWidth: 800, editing: true });
    assert.equal(narrower.baselineHeight, 440);
    assert.equal(narrower.keyboardLike, false);

    // An orientation change says so outright.
    const rotated = track(kb, { rawHeight: 600, visibleHeight: 600, editing: true, force: true });
    assert.equal(rotated.baselineHeight, 600);
    assert.equal(rotated.shrunk, false);

    // A WebView that shrinks only visualViewport still reads as a keyboard, and
    // its layout window is never adopted as something smaller.
    const vvOnly = track(start, { rawHeight: 800, visibleHeight: 440, editing: true });
    assert.equal(vvOnly.baselineHeight, 800);
    assert.equal(vvOnly.shrunk, true);

    // A keyboard smaller than 15% of the screen -- a floating or split one -- used
    // to fall through the old threshold and re-scale the canvas.
    const small = track(start, { rawHeight: 720, visibleHeight: 720, editing: true });
    assert.equal(small.baselineHeight, 800);
    assert.equal(small.shrunk, true);
}

// visibleBand converts the screen into the design-space coordinates a fixed
// child of the transformed #scaled-content is laid out in.
{
    const scale = 0.697917;
    const band = visibleBand(KB_VISIBLE, scale, 0);
    assert.equal(Math.round(band.top), 0);
    assert.equal(Math.round(band.height), Math.round(KB_VISIBLE / scale), 'design px, not screen px');

    // With the canvas lifted, the visible band starts further down the canvas.
    const lifted = visibleBand(KB_VISIBLE, scale, -53.2136);
    assert.equal(Math.round(lifted.top), 76);
    assert.equal(Math.round(lifted.height), Math.round(band.height));

    // The overlay covers exactly the screen: band top and bottom map back to 0
    // and the visible height.
    const screenTop = -53.2136 + lifted.top * scale;
    const screenBottom = -53.2136 + (lifted.top + lifted.height) * scale;
    assert.ok(Math.abs(screenTop) < 0.01);
    assert.ok(Math.abs(screenBottom - KB_VISIBLE) < 0.01);
}
assert.equal(visibleBand(0, 1, 0), null);
assert.equal(visibleBand(440, 0, 0), null);

console.log('keyboard fit: ok');
