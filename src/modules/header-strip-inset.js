// Where the header strips (favourites, DYE) end. DOM-free so it can be tested.

// The strips' CSS `right`, in the header's own layout pixels. The dashboard is scaled to the screen with a CSS
// transform: getBoundingClientRect() answers in screen pixels while style.right is laid out in the header's pixels,
// so the measured gap between the header's right edge and the controls is divided by the scale. Without that the
// strips run under the controls on any screen that isn't the design size.
export function stripRightInset({ headerRight, headerWidth, headerLayoutWidth, controlsLeft, gap }) {
    const scale = headerLayoutWidth > 0 ? headerWidth / headerLayoutWidth : 1;
    return Math.max(0, Math.round((headerRight - controlsLeft) / (scale || 1) + gap));
}
