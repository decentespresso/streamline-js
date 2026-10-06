import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('long press uses pointer events without blocking touch start', () => {
    const ui = read('src/modules/ui.js');
    const helper = ui.slice(ui.indexOf('export function setupPressAndHold'), ui.indexOf('export function flashElement'));
    const startPress = helper.slice(helper.indexOf('const startPress'), helper.indexOf('const movePress'));
    assert.match(helper, /addEventListener\('pointerdown'/);
    assert.match(helper, /addEventListener\('pointermove'/);
    assert.match(helper, /addEventListener\('pointercancel'/);
    assert.match(helper, /Math\.hypot\([\s\S]*movementThreshold/);
    assert.doesNotMatch(helper, /touchstart|mousedown/);
    assert.doesNotMatch(startPress, /preventDefault/);
    assert.match(helper, /stopImmediatePropagation/);
});

test('tablet menus use larger rows, bottom sheets and focus restoration', () => {
    const menu = read('src/modules/context-menu.js');
    const layout = read('src/modules/context-menu-layout.js');
    const css = read('src/css/context-menu.css');
    // The sheet is now phone-only: it is pinned left:12px/right:12px with
    // max-width:none, which spanned the full width of the coarse-pointer,
    // ~1920px Decent tablet. The action threshold moved to the DOM-free policy
    // module and gained a viewport-width bound alongside it.
    assert.match(layout, /BOTTOM_SHEET_MIN_ACTIONS = 4/);
    assert.match(layout, /BOTTOM_SHEET_MAX_WIDTH = \d+/);
    assert.match(menu, /shouldUseBottomSheet\(/);
    assert.match(menu, /anchor\.focus\(\{ preventScroll: true \}\)/);
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height: 60px/);
    assert.match(css, /context-menu--bottom-sheet/);
    assert.match(css, /#sub-categories-separator::after[\s\S]*width: 48px/);
});

// The per-row overflow (⋮) button is gone: long press is the affordance, as it
// already is for the favourite buttons and the profile name on the main page.
// Right-click opens the same menu so a mouse still has a way in.
test('profile rows open their menu by long press and right-click, with no overflow button', () => {
    const profiles = read('src/modules/profile_selector.js');
    assert.doesNotMatch(profiles, /profile-context-trigger/);
    assert.match(profiles, /setupPressAndHold\(div, selectItem, openMenu, \{ touchAction: 'pan-y' \}\)/);
    assert.match(profiles, /addEventListener\('contextmenu'/);
    assert.match(profiles, /aria-haspopup/);
});

// Issue #88: a touch screen leaves a sticky :hover on whatever element the
// finger last crossed, so any `hover:` utility doubles as a false "selected"
// marker — the settings nav rows went white (hover:text-white) and the skin
// cards grew a blue outline (hover:border-[#385a92]) around a skin that was
// not active. The fix is Tailwind's hoverOnlyWhenSupported, which wraps the
// hover variants in @media (hover: hover). It only reaches the browser through
// the generated bundle, so assert on the bundle as well as the config: a
// rebuild with the flag dropped, or a committed app.css predating it, both
// bring the bug back and neither shows up in tailwind.config.js.
const mediaBlocks = (css, prelude) => {
    const ranges = [];
    const pattern = new RegExp(`@media \\(${prelude}\\)[^{]*\\{`, 'g');
    for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
        let depth = 0;
        let i = match.index + match[0].length - 1; // the block's opening brace
        for (; i < css.length; i += 1) {
            if (css[i] === '{') depth += 1;
            else if (css[i] === '}' && (depth -= 1) === 0) break;
        }
        ranges.push([match.index, i]);
    }
    return ranges;
};

test('touch devices get no hover styling: hover utilities are media-guarded', () => {
    const config = read('tailwind.config.js');
    assert.match(config, /hoverOnlyWhenSupported:\s*true/);

    const css = read('src/css/app.css');
    const guarded = mediaBlocks(css, 'hover:hover');
    assert.ok(guarded.length > 0, 'generated app.css has no @media (hover:hover) block');

    const utilities = [...css.matchAll(/\.hover\\:[^{,\s]*:hover/g)];
    assert.ok(utilities.length > 0, 'generated app.css has no hover: utilities to check');

    const unguarded = utilities
        .filter(match => !guarded.some(([start, end]) => start < match.index && match.index < end))
        .map(match => match[0]);
    assert.deepEqual(unguarded, [], `hover: utilities outside @media (hover: hover): ${unguarded.join(', ')}`);

    // The settings nav rows and the skin cards are the two surfaces the issue
    // named; fail loudly if a rename quietly drops them from the bundle.
    assert.match(css, /\.hover\\:text-white:hover/);
    assert.match(css, /\.hover\\:bg-\\\[\\#2c4a7a\\\]:hover/);
    assert.match(css, /\.hover\\:border-\\\[\\#385a92\\\]:hover/);
});

// The first attempt at #88 neutralised the nav rows' sticky hover by hand with
// `background-color: transparent; color: inherit` under @media (hover: none).
// `inherit` resolved to the body colour — #E8E8E8 in dark mode — so the dragged
// row's text came out as white as the open row's, which is what the reporter
// saw next. Guarding the utilities themselves means nothing has to restate the
// resting colour; keep it that way.
test('settings nav rows do not hand-neutralise sticky hover', () => {
    const css = read('src/css/main.css');
    const navRules = [...css.matchAll(/[^{}]*settings-(?:sub)?nav-btn[^{}]*:hover[^{}]*\{[^}]*\}/g)];
    assert.deepEqual(
        navRules.map(match => match[0]),
        [],
        'settings nav :hover override is back in main.css; let hoverOnlyWhenSupported handle it',
    );
});
