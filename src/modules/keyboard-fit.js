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

// How much shrink counts as "the keyboard is up" rather than a window resize or
// a browser toolbar sliding away.
export const KEYBOARD_SHRINK = 0.85;

export function keyboardIsUp(rawHeight, visibleHeight, baselineHeight) {
    return Math.min(rawHeight, visibleHeight) < baselineHeight * KEYBOARD_SHRINK;
}

// The extra lift the canvas needs so `rect` (the focused field, in screen
// coordinates, already including whatever lift is applied) clears the keyboard.
// Never lifts a field's own top off the screen: seeing the end of what you typed
// is worth less than seeing the field.
export function keyboardLift(rect, visibleHeight, gap = KEYBOARD_GAP) {
    if (!rect) return 0;
    const overlap = rect.bottom + gap - visibleHeight;
    if (overlap <= 0) return 0;
    return Math.min(overlap, Math.max(0, rect.top - gap));
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
