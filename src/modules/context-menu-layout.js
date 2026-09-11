// Context-menu layout policy — bottom sheet vs anchored popover.
//
// `.context-menu--bottom-sheet` pins the menu to left:12px/right:12px with
// max-width:none. That is right on a phone and wrong on the Decent tablet,
// which is a coarse-pointer screen ~1920px wide: the menu stretched the full
// width and read as a banner. Only the profile selector ever hit it, because
// its menu (Hide + 5 favourite slots + Edit) is the one long enough to cross
// the action threshold — every menu on the main page has three.
//
// DOM-free on purpose so `node --test test/` can import it (see test/README.md);
// context-menu.js itself touches document at load.

/**
 * Widest screen that still gets the full-bleed sheet. A coarse pointer alone is
 * not enough to justify one — tablets are coarse and wide.
 */
export const BOTTOM_SHEET_MAX_WIDTH = 700;

/** Below this, a menu fits as a popover anywhere and never needed a sheet. */
export const BOTTOM_SHEET_MIN_ACTIONS = 4;

/**
 * @param {number} actionCount non-divider items
 * @param {boolean} coarsePointer matchMedia('(pointer: coarse)').matches
 * @param {number} viewportWidth window.innerWidth
 * @returns {boolean} true to render as a bottom sheet
 */
export function shouldUseBottomSheet(actionCount, coarsePointer, viewportWidth) {
    return coarsePointer
        && actionCount >= BOTTOM_SHEET_MIN_ACTIONS
        && viewportWidth <= BOTTOM_SHEET_MAX_WIDTH;
}
