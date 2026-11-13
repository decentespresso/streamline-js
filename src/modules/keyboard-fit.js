// Soft-keyboard geometry. DOM-free so the arithmetic can be tested under node.
//
// Decaid's Android activity is `adjustResize` and its Scaffold does not opt out,
// so the WebView really shrinks when the keyboard opens: innerHeight, or at
// least visualViewport.height, drops. Two things then have to happen, and they
// are not the same thing:
//
//  - An ordinary field inside the scaled canvas gets the canvas lifted under it
//    (scaling.js), because #scaling-container is overflow:hidden and resets its
//    scrollTop every pass, so scrolling cannot do it.
//  - A full-screen overlay cannot be lifted into view: it is as tall as the
//    design canvas, so lifting it only pushes its header off the top while its
//    lower half stays under the keyboard. It has to be told how tall the screen
//    is now and shrink to it -- visibleBand() -- which is what the notes modal
//    (the feedback description editor, shot notes, profile notes) does.

// Breathing room between the focused field and the keyboard's top edge. Enough
// that the field does not sit flush against it: a field you can see only
// because it is touching the keyboard reads as covered.
export const KEYBOARD_GAP = 28;

// How long a smaller window has to persist, with nothing ever having been typed
// into it, before it counts as the window really being smaller.
export const SHRINK_ADOPT_MS = 1500;

// The canvas must never be re-scaled to fit a soft keyboard: the whole UI
// shrinking -- text, buttons, chart -- is far worse than a field being covered,
// and a covered field can be dealt with by moving the canvas instead.
//
// So the baseline is the window as it is with no keyboard. It follows the window
// up at once. It follows the window down only when the smaller size cannot be a
// keyboard:
//
//  - `force`, an orientation change, where the window really changed shape;
//  - a change in width, which a keyboard never causes and a rotation or a
//    split-screen resize does;
//  - a shrink that was never typed into, held for SHRINK_ADOPT_MS -- a host
//    resizing the WebView while the user is reading.
//
// A shrink that appeared while an editable had focus is a keyboard and stays
// one until the window grows back, even after the field is blurred: on Android
// the keyboard often stays up when focus moves to a button, and adopting then
// is exactly the "the page shrank when I tapped the title" bug.
//
// Keyed off any shrink at all rather than a 15% one, so a floating or split
// keyboard cannot fall through and re-scale the canvas.
export function trackBaseline(state, { rawHeight, rawWidth, visibleHeight, editing, now, force = false }) {
    // The keyboard shows up as either of these, depending on the WebView, so the
    // shorter one decides whether the screen lost room. Only the layout window
    // (rawHeight) is ever adopted as the baseline: a visualViewport that shrank
    // on its own is a keyboard or a pinch, never a smaller window.
    const shortest = Math.min(rawHeight, visibleHeight ?? rawHeight);
    const baseline = state?.baselineHeight || rawHeight;
    const widthChanged = state?.baselineWidth !== undefined && rawWidth !== undefined
        && rawWidth !== state.baselineWidth;
    const adopt = () => ({
        baselineHeight: rawHeight, baselineWidth: rawWidth,
        shrunkSince: 0, keyboardLike: false, shrunk: shortest < rawHeight,
    });

    if (force || widthChanged) return adopt();
    if (shortest >= baseline) {
        return {
            baselineHeight: Math.max(rawHeight, baseline), baselineWidth: rawWidth,
            shrunkSince: 0, keyboardLike: false, shrunk: false,
        };
    }

    const keyboardLike = !!state?.keyboardLike || editing;
    const shrunkSince = state?.shrunkSince || now;
    if (!keyboardLike && now - shrunkSince >= SHRINK_ADOPT_MS) return adopt();
    return {
        baselineHeight: baseline, baselineWidth: state?.baselineWidth ?? rawWidth,
        shrunkSince, keyboardLike, shrunk: true,
    };
}

// The total lift the canvas needs so `rect` (the focused field, in screen
// coordinates) clears the keyboard. `applied` is the lift already in the
// transform, which rect therefore already includes, so the answer is absolute
// and one pass settles it: measuring against the last answer instead converged
// over three or four passes, and each pass wrote the transform and fired
// streamline:scaleupdate at every listener.
//
// Never lifts a field's own top off the screen: seeing the end of what you
// typed is worth less than seeing the field.
export function keyboardLift(rect, visibleHeight, applied = 0, gap = KEYBOARD_GAP) {
    if (!rect) return 0;
    const top = rect.top + applied;
    const bottom = rect.bottom + applied;
    const overlap = bottom + gap - visibleHeight;
    if (overlap <= 0) return 0;
    return Math.min(overlap, Math.max(0, top - gap));
}

// Where the visible screen is, in the design-space coordinates of a `position:
// fixed` child of #scaled-content. A transform makes that element the
// containing block, so its own `top: 0; height: 100%` is the canvas, not the
// screen -- which is why a full-screen overlay runs on under the keyboard.
//
// screen_y = offsetY + design_y * scale, so the visible band starts at
// -offsetY / scale and is visibleHeight / scale tall.
export function visibleBand(visibleHeight, scale, offsetY = 0) {
    if (!(scale > 0) || !(visibleHeight > 0)) return null;
    return { top: -offsetY / scale, height: visibleHeight / scale };
}
