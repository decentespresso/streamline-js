import { loadStyle } from './vendor-loader.js';
import { shouldUseBottomSheet } from './context-menu-layout.js';

const MENU_ID = 'app-context-menu';
const BACKDROP_ID = 'app-context-menu-backdrop';
const MARGIN = 8;
const VIEWPORT_PADDING = 12;

let activeMenu = null;

// The menu owns its stylesheet. It used to ride along on a list in app.js's
// DOMContentLoaded handler, behind a double rAF and a `.catch(() => {})` — so on
// any boot that did not reach that line the menu rendered with NO css, and an
// unstyled block appended to <body> is exactly as wide as the screen. Same
// symptom as the bottom sheet, different cause. Module-relative so it resolves
// whatever path the document was served from.
const STYLESHEET_URL = new URL('../css/context-menu.css', import.meta.url).href;
let stylesReady = null;

function ensureStyles() {
    if (!stylesReady) stylesReady = loadStyle(STYLESHEET_URL).catch(() => {});
    return stylesReady;
}

// Start the fetch as soon as anything imports this module, so the first menu
// open is not waiting on the network.
ensureStyles();

function ensureRoot() {
    let backdrop = document.getElementById(BACKDROP_ID);
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = BACKDROP_ID;
        backdrop.className = 'context-menu-backdrop';
        document.body.appendChild(backdrop);
    }
    let menu = document.getElementById(MENU_ID);
    if (!menu) {
        menu = document.createElement('div');
        menu.id = MENU_ID;
        menu.className = 'context-menu';
        menu.setAttribute('role', 'menu');
        document.body.appendChild(menu);
    }
    return { backdrop, menu };
}

function position(menu, anchorEl) {
    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const spaceBelow = vh - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    const placeAbove = spaceBelow < menuRect.height + MARGIN && spaceAbove > spaceBelow;

    let top = placeAbove
        ? anchorRect.top - menuRect.height - MARGIN
        : anchorRect.bottom + MARGIN;

    let left = anchorRect.left + (anchorRect.width / 2) - (menuRect.width / 2);

    left = Math.max(VIEWPORT_PADDING, Math.min(left, vw - menuRect.width - VIEWPORT_PADDING));
    top = Math.max(VIEWPORT_PADDING, Math.min(top, vh - menuRect.height - VIEWPORT_PADDING));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.classList.toggle('context-menu--above', placeAbove);
    menu.classList.toggle('context-menu--below', !placeAbove);

    const arrowOffset = (anchorRect.left + anchorRect.width / 2) - left;
    menu.style.setProperty('--arrow-offset', `${arrowOffset}px`);
}

function buildItems(menu, items, close) {
    menu.innerHTML = '';
    items.forEach((item, idx) => {
        if (item.divider) {
            const div = document.createElement('div');
            div.className = 'context-menu__divider';
            menu.appendChild(div);
            return;
        }
        // Link item: render as an anchor so the user's tap navigates same-frame.
        // The host opens the OS browser with this URL and cancels the in-webview
        // load (gh#384). No target=_blank — that hits the unhandled onCreateWindow.
        // onSelect runs as a side effect (e.g. copy) without cancelling the nav.
        if (item.href) {
            const a = document.createElement('a');
            a.className = 'context-menu__item';
            a.setAttribute('role', 'menuitem');
            a.href = item.href;
            a.rel = 'noopener';
            if (item.icon) {
                const icon = document.createElement('span');
                icon.className = 'context-menu__icon';
                icon.innerHTML = item.icon;
                a.appendChild(icon);
            }
            const label = document.createElement('span');
            label.className = 'context-menu__label';
            label.textContent = item.label;
            a.appendChild(label);
            a.addEventListener('click', () => {
                try { item.onSelect && item.onSelect(); }
                catch (err) { console.error('[context-menu] onSelect error', err); }
                setTimeout(close, 50); // let the nav initiate before removing the anchor
            });
            menu.appendChild(a);
            return;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'context-menu__item';
        if (item.danger) btn.classList.add('context-menu__item--danger');
        if (item.disabled) {
            btn.classList.add('context-menu__item--disabled');
            btn.disabled = true;
        }
        btn.setAttribute('role', 'menuitem');
        btn.dataset.index = String(idx);
        if (item.icon) {
            const icon = document.createElement('span');
            icon.className = 'context-menu__icon';
            icon.innerHTML = item.icon;
            btn.appendChild(icon);
        }
        const label = document.createElement('span');
        label.className = 'context-menu__label';
        label.textContent = item.label;
        btn.appendChild(label);
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (item.disabled) return;
            close();
            try { item.onSelect && item.onSelect(); }
            catch (err) { console.error('[context-menu] onSelect error', err); }
        });
        menu.appendChild(btn);
    });
}

function focusableItems(menu) {
    return Array.from(menu.querySelectorAll('.context-menu__item:not(.context-menu__item--disabled)'));
}

function attachKeyboard(menu, close) {
    const handler = (e) => {
        const items = focusableItems(menu);
        if (!items.length) return;
        const activeIdx = items.indexOf(document.activeElement);
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = items[(activeIdx + 1 + items.length) % items.length] || items[0];
            next.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = items[(activeIdx - 1 + items.length) % items.length] || items[items.length - 1];
            prev.focus();
        } else if (e.key === 'Home') {
            e.preventDefault();
            items[0].focus();
        } else if (e.key === 'End') {
            e.preventDefault();
            items[items.length - 1].focus();
        }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
}

export function closeContextMenu() {
    if (!activeMenu) return;
    const { menu, backdrop, detachKeyboard, anchor, onClose } = activeMenu;
    detachKeyboard && detachKeyboard();
    menu.classList.remove('context-menu--open');
    backdrop.classList.remove('context-menu-backdrop--open');
    anchor && anchor.classList.remove('long-press-active');
    activeMenu = null;
    if (anchor?.isConnected && typeof anchor.focus === 'function') anchor.focus({ preventScroll: true });
    if (typeof onClose === 'function') {
        try { onClose(); } catch (err) { console.error('[context-menu] onClose error', err); }
    }
}

export function openContextMenu(anchorEl, items, options = {}) {
    if (!anchorEl || !Array.isArray(items) || items.length === 0) return;
    if (activeMenu) closeContextMenu();

    const { backdrop, menu } = ensureRoot();
    const close = () => closeContextMenu();
    buildItems(menu, items, close);
    const actionCount = items.filter(item => !item.divider).length;
    const bottomSheet = shouldUseBottomSheet(
        actionCount,
        !!window.matchMedia?.('(pointer: coarse)').matches,
        window.innerWidth
    );
    menu.classList.toggle('context-menu--bottom-sheet', bottomSheet);

    menu.style.visibility = 'hidden';
    menu.classList.add('context-menu--open');
    backdrop.classList.add('context-menu-backdrop--open');

    ensureStyles().then(() => requestAnimationFrame(() => {
        if (bottomSheet) {
            menu.style.removeProperty('left');
            menu.style.removeProperty('top');
            menu.style.removeProperty('--arrow-offset');
            menu.classList.remove('context-menu--above', 'context-menu--below');
        } else {
            position(menu, anchorEl);
        }
        menu.style.visibility = '';
        const first = focusableItems(menu)[0];
        if (first) first.focus();
    }));

    // Dismiss on click (fires after the full touch sequence ends). Listening on
    // touchstart with preventDefault left the in-progress touch bound to the
    // now-hidden backdrop and broke the next pan on the profile list.
    const onBackdropClick = (e) => {
        if (e.target === backdrop) close();
    };
    backdrop.addEventListener('click', onBackdropClick);

    const detachKeyboard = attachKeyboard(menu, close);

    anchorEl.classList.add('long-press-active');

    activeMenu = {
        menu,
        backdrop,
        anchor: anchorEl,
        detachKeyboard: () => {
            detachKeyboard();
            backdrop.removeEventListener('click', onBackdropClick);
        },
        onClose: options.onClose,
    };
}

window.addEventListener('resize', () => closeContextMenu());
window.addEventListener('scroll', () => closeContextMenu(), true);
