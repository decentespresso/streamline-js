// Help overlay: a "?" button that dims the screen and draws labelled coach-marks
// over the interactive controls of the current page, surfacing hidden gestures
// (tap / long-press / drag). Tap the button, backdrop, or Esc to dismiss.
// Long-press the button to hide it for this session. Self-contained — no other
// module depends on it.
//
// In a native app webview the button mirrors the fullscreen toggle (bordered box,
// top-right); in a browser it's a round floating button, bottom-right.
//
// ponytail: anchored by element id with getBoundingClientRect (viewport space),
// so it needs zero awareness of the app's CSS-transform scaling. New tip strings
// are English-only; wire into i18n.js if/when the app needs translated help.

import { setupPressAndHold } from './ui.js';
import { isInWebView, syncHelpButton } from './help-launcher.js';

const RING_PAD = 6;        // px of breathing room around the highlighted element
const GAP = 12;            // gap between ring and its label

// Per-page coach-marks. One entry per *concept*, not per button — repeated rows
// (grind/dose/drink…) share a gesture, so a single mark keeps labels from
// colliding on dense screens. Entries whose element is missing/hidden are skipped.
const PAGES = {
    home: [
        { sel: '#fav-profile-btn-0', title: 'Favourite profiles', tip: 'Tap to switch profile. Long-press to assign a different one.' },
        { sel: '#profile-name', title: 'Current profile', tip: 'Tap to browse profiles. Long-press to browse, edit or revert the current profile.' },
        { sel: '#dose-label', title: 'Adjust a value', tip: 'Tap +/- to step. Tap the number to type an exact value.' },
        { sel: '#temp-presets', title: 'Presets', tip: 'Tap to apply. Long-press to edit, save the current value, or reset.' },
        { sel: '#steam-mode-toggle', title: 'Mode switch', tip: 'Tap to switch between Time and Flow, Hot water Temperature and Volume.' },
        { sel: '#hot-water-mode-toggle', ringOnly: true },
        { sel: '#data-weight', title: 'Scale', tip: 'Tap the weight to tare the connected scale.' },
        { sel: '#ghc-controls', title: 'Machine controls', tip: 'Coffee, Water, Steam, Flush — and Stop.' },
        { sel: '#shot-history-panel', title: 'Shot history', tip: 'Use the arrows to browse past shots.' },
        { sel: '#sleep-button', title: 'Sleep', tip: 'Put the machine to sleep.' },
        { sel: '#settings-btn', title: 'Settings', tip: 'Open the settings page.' },
        { sel: '#fullscreen-toggle-btn', title: 'Fullscreen', tip: 'Toggle fullscreen mode.' },
    ],
    settings: [
        { sel: '#settings-search', title: 'Search', tip: 'Find any setting by keyword.' },
        { sel: '#main-categories-panel', title: 'Categories', tip: 'Pick a category; its subcategories appear alongside.' },
        { sel: '#separator', title: 'Resize', tip: 'Drag to resize the panels.' },
        { sel: '#save-settings-btn', title: 'Save', tip: 'Save your changes.' },
        { sel: '#cancel-settings-btn', title: 'Cancel', tip: 'Discard changes and go back.' },
    ],
    profile_selector: [
        { sel: '#add_profile', title: 'Add profile', tip: 'Start a new profile from scratch, upload a file, or import a share code.', below: true },
        { sel: '#view_profile', title: 'View all', tip: 'Show all hidden profiles.' },
        { sel: '#search_profile', title: 'Search', tip: 'Search your profiles.' },
        { sel: '#ai_generate_profile', title: 'Decent Profile Generator', tip: 'Design your next espresso profile in a few simple steps.', below: true },
        { sel: '#delete_profile', title: 'Delete', tip: 'Delete the selected profile. Built-in profiles are hidden instead of removed.' },
        { sel: '#assign-fav-btn-0', title: 'Assign favourite', tip: 'Assign the selected profile to a favourite slot (1–5) shown on the home screen.' },
        { sel: '#profile-list', title: 'Profiles', tip: 'Tap a profile to preview its graph and notes. Long-press for more options: hide, assign to a favourite, or edit.' },
        { sel: '#edit_profile', title: 'Edit', tip: 'Open the selected profile in the editor.' },
        { sel: '#reset_btn', title: 'Reset', tip: 'Restore the selected profile to its original settings.' },
        { sel: '#cancel-profile-btn', title: 'Cancel', tip: 'Discard changes and return without switching profile.' },
        { sel: '#confirm-profile-btn', title: 'Confirm', tip: 'Use this profile for your next shot.' },
    ],
    profile_editor: [
        { sel: '#editor-title-display', title: 'Profile name', tip: 'Tap the title to rename. Saving under a new name leaves the original untouched and keeps this as a separate profile.', right: true },
        { sel: '.editor-tab-btn[data-tab="0"]', title: 'Grid view', tip: 'Edit the profile as step cards.' },
        { sel: '.editor-tab-btn[data-tab="2"]', title: 'Text view', tip: 'Edit the profile as plain sentences, with a graph preview.' },
        { sel: '.editor-tab-btn[data-tab="1"]', title: 'Settings view', tip: 'Profile-wide settings (dose, yield, temperature…).' },
        { sel: '#editor-steps-container', title: 'Steps', tip: 'Each column is a step. Tap any value to edit it, or use +/-. The card buttons insert or delete steps.' },
        { sel: '#editor-row-temp', title: 'Temp', tip: 'Target temperature for the step, and which sensor it follows (Coffee or Water).' },
        { sel: '#editor-row-pump', title: 'Pump', tip: 'Sets the step’s pressure or flow and how fast it ramps there. “Limit to” caps the opposite value.' },
        { sel: '#editor-row-max', title: 'Max', tip: 'The longest this step runs before moving to the next one.' },
        { sel: '#editor-row-exit', title: 'Exit if', tip: 'End the step early when pressure or flow goes over or under a set value.' },
        { sel: '#editor-settings-container', title: 'Profile settings', tip: 'Set profile-wide options. Tap a value to change it.' },
        { sel: '#review-steps-list', title: 'Text review', tip: 'Each step in plain words. Tap any blue value to edit it.' },
        { sel: '#review-graph', title: 'Graph preview', tip: 'Live preview of the profile’s pressure / flow curve.' },
        { sel: '#review-settings-list', title: 'Profile settings', tip: 'Profile-wide settings. Tap any blue value to edit it.' },
        // Hidden (Tailwind `hidden`) on a default or an unsaved profile, so
        // visibleRect skips this mark on its own — no extra condition needed.
        { sel: '#editor-history-btn', title: 'Version history', tip: 'Restore an earlier version of this profile.' },
        { sel: '#editor-cancel-btn', title: 'Cancel', tip: 'Discard changes and exit the editor.' },
        { sel: '#editor-save-btn', title: 'Save', tip: 'Saves over this profile. To keep the original too, rename it first.' },
    ],
};

function currentPage() {
    const host = document.getElementById('subpage-host');
    const onSubpage = host && host.style.display !== 'none' && host.children.length > 0;
    if (onSubpage) {
        if (document.getElementById('editor-steps-container')) return 'profile_editor';
        if (document.getElementById('profile-list')) return 'profile_selector';
        if (document.getElementById('settings-content-area')) return 'settings';
    }
    return 'home';
}

function visibleRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;            // display:none / not laid out
    if (r.bottom < 0 || r.top > window.innerHeight) return null;  // scrolled off-screen
    if (getComputedStyle(el).visibility === 'hidden') return null;
    return r;
}

// Place a label near a ring without overlapping anything already in `placed`
// (other labels + the close hint). Prefers directly below the element; falls
// back to above/sides, then a downward nudge. Every position is clamped inside
// the viewport, so a label never runs off-screen. Returns the chosen {left, top}.
function placeLabel(label, ring, placed, prefer = null) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const lw = label.offsetWidth, lh = label.offsetHeight;
    const clampX = x => Math.max(8, Math.min(x, vw - lw - 8));
    const clampY = y => Math.max(8, Math.min(y, vh - lh - 8));
    const centerX = ring.left + ring.width / 2 - lw / 2;
    const midY = ring.top + ring.height / 2 - lh / 2;

    // Pinned to a fixed side of the element (below a toolbar icon, or right of a
    // title). May overlap the highlight boxes, but must not overlap other labels:
    // nudge down past them (ring entries are tagged and ignored here).
    if (prefer === 'below' || prefer === 'right') {
        const left = prefer === 'right' ? clampX(ring.right + GAP) : clampX(centerX);
        let top = clampY(prefer === 'right' ? midY : ring.bottom + GAP);
        const hitsLabel = t => placed.some(p => !p.ring && left < p.r && left + lw > p.l && t < p.b && t + lh > p.t);
        for (let i = 0; i < 200 && hitsLabel(top) && top < vh - lh - 8; i++) top += 8;
        top = clampY(top);
        placed.push({ l: left, t: top, r: left + lw, b: top + lh });
        return { left, top };
    }

    const candidates = [
        { left: centerX, top: ring.bottom + GAP },              // below (preferred)
        { left: ring.left, top: ring.bottom + GAP },            // below, left-aligned
        { left: ring.right + GAP, top: ring.bottom + GAP },     // below-right
        { left: ring.left - GAP - lw, top: ring.bottom + GAP }, // below-left
        { left: centerX, top: ring.top - GAP - lh },            // above
        { left: ring.right + GAP, top: midY },                  // right
        { left: ring.left - GAP - lw, top: midY },              // left
    ].map(c => ({ left: clampX(c.left), top: clampY(c.top) }));

    const hits = (l, t) => placed.some(p => l < p.r && l + lw > p.l && t < p.b && t + lh > p.t);

    let chosen = candidates.find(c => !hits(c.left, c.top));
    if (!chosen) {
        // Every anchored spot is taken (dense screen / a large highlight box).
        // Scan the viewport on a grid for the nearest collision-free slot to the
        // element, so the label never lands inside a box or on another label.
        const cx = ring.left + ring.width / 2;
        const cy = ring.bottom + GAP;                          // bias toward just below
        const step = 16;
        let best = null, bestDist = Infinity;
        for (let t = 8; t <= vh - lh - 8; t += step) {
            for (let l = 8; l <= vw - lw - 8; l += step) {
                if (hits(l, t)) continue;
                const dx = (l + lw / 2) - cx, dy = t - cy;
                const d = dx * dx + dy * dy;
                if (d < bestDist) { bestDist = d; best = { left: l, top: t }; }
            }
        }
        chosen = best || { left: candidates[0].left, top: candidates[0].top };
    }

    placed.push({ l: chosen.left, t: chosen.top, r: chosen.left + lw, b: chosen.top + lh });
    return chosen;
}

const HIDE_KEY = 'streamlineHelpHidden';
const LAUNCH_KEY = 'streamlineHelpLaunches';

// Effective hidden state. An explicit user choice wins ('1' hidden via long-press
// or the settings toggle, '0' shown via the toggle). With no choice recorded, the
// button auto-hides from the 3rd startup on — it exists for first-run discovery,
// after that it just covers useful controls.
function helpHidden() {
    const pref = localStorage.getItem(HIDE_KEY);
    if (pref !== null) return pref === '1';
    return (parseInt(localStorage.getItem(LAUNCH_KEY), 10) || 0) > 2;
}

let overlay = null;

function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    window.removeEventListener('resize', close);
    document.removeEventListener('keydown', onKey);
    const btn = document.getElementById('help-overlay-btn');
    if (btn) btn.setAttribute('aria-pressed', 'false');
}

function onKey(e) { if (e.key === 'Escape') close(); }

function open() {
    const vw = window.innerWidth, vh = window.innerHeight;
    overlay = document.createElement('div');
    overlay.id = 'help-overlay';
    overlay.addEventListener('click', close);
    document.body.appendChild(overlay);   // in DOM first, so children can be measured

    // Page marks plus a mark for the help button itself (shown on every page).
    const marks = [
        ...(PAGES[currentPage()] || []),
        { sel: '#help-overlay-btn', title: 'Help', tip: 'Tap to show these hints. Long-press to hide this button.' },
    ];
    const placed = [];

    // Seed the close hint first so labels treat it as an obstacle. Measure with
    // the longer of the two possible strings so the reserved box isn't undersized.
    const hint = document.createElement('div');
    hint.className = 'help-hint';
    hint.textContent = 'No tips for this screen yet — tap to close';
    overlay.appendChild(hint);
    const hr = hint.getBoundingClientRect();
    placed.push({ l: hr.left, t: hr.top, r: hr.right, b: hr.bottom });

    // Pass 1: draw every highlight box and create its label. Seed all ring rects
    // as obstacles up front so a label never lands inside any highlight box.
    const pending = [];
    for (const m of marks) {
        const el = document.querySelector(m.sel);
        if (!el) continue;
        const r = visibleRect(el);
        if (!r) continue;

        const ringRect = { left: r.left - RING_PAD, top: r.top - RING_PAD,
                           right: r.right + RING_PAD, bottom: r.bottom + RING_PAD,
                           width: r.width + RING_PAD * 2, height: r.height + RING_PAD * 2 };

        const ring = document.createElement('div');
        ring.className = 'help-ring';
        ring.style.left = `${ringRect.left}px`;
        ring.style.top = `${ringRect.top}px`;
        ring.style.width = `${ringRect.width}px`;
        ring.style.height = `${ringRect.height}px`;
        overlay.appendChild(ring);

        // Full-panel regions (e.g. the editor's steps area) fill most of the
        // screen — there's no room to put a label outside them, so don't treat
        // them as obstacles. A label sitting inside such a region is unavoidable
        // and fine; the no-overlap rule is for discrete element boxes.
        const isLarge = ringRect.width * ringRect.height > 0.35 * vw * vh;
        if (!isLarge) {
            placed.push({ l: ringRect.left, t: ringRect.top, r: ringRect.right, b: ringRect.bottom, ring: true });
        }

        // Ring-only marks (e.g. the hot-water toggle, covered by the steam tip)
        // get a highlight box but no label of their own.
        if (m.ringOnly) continue;

        const label = document.createElement('div');
        label.className = 'help-label';
        label.innerHTML = `<strong></strong><span></span>`;
        label.querySelector('strong').textContent = m.title;
        label.querySelector('span').textContent = m.tip;
        overlay.appendChild(label);

        pending.push({ label, ringRect, prefer: m.below ? 'below' : m.right ? 'right' : null });
    }

    // Pass 2: position labels, now avoiding the hint, every ring, and each other.
    // Side-pinned marks are placed first so the free-floating ones avoid them.
    pending.sort((a, b) => (b.prefer ? 1 : 0) - (a.prefer ? 1 : 0));
    for (const { label, ringRect, prefer } of pending) {
        const pos = placeLabel(label, ringRect, placed, prefer);
        label.style.left = `${pos.left}px`;
        label.style.top = `${pos.top}px`;
    }

    const shown = pending.length;

    hint.textContent = shown
        ? 'Tap anywhere to close'
        : 'No tips for this screen yet — tap to close';

    window.addEventListener('resize', close);   // layout shifted — simplest is to dismiss
    document.addEventListener('keydown', onKey);
    const btn = document.getElementById('help-overlay-btn');
    if (btn) btn.setAttribute('aria-pressed', 'true');
}

// Webview placement. On the home page the help button takes over the (host-owned,
// hidden) fullscreen-toggle slot — same space, size, location. On every other page
// it falls back to the browser-style round button in the bottom-right corner.
export function initializeHelpOverlay(button = null) {
    const existing = document.getElementById('help-overlay-btn');
    const btn = button || existing || document.createElement('button');
    if (btn.dataset.helpOverlayInitialized) return;
    btn.dataset.helpOverlayInitialized = 'true';
    btn.id = 'help-overlay-btn';
    btn.type = 'button';
    if (isInWebView()) btn.classList.add('help-btn--webview');
    btn.setAttribute('aria-label', 'Show help for this screen');
    btn.setAttribute('aria-pressed', 'false');
    btn.title = 'Help (long-press to hide)';
    btn.textContent = '?';
    if (helpHidden()) btn.style.display = 'none';
    // Tap = toggle help. Long-press = hide the button and remember it.
    setupPressAndHold(
        btn,
        () => (overlay ? close() : open()),
        () => setHidden(true),
    );
    if (!btn.isConnected) document.body.appendChild(btn);

    // Show/hide, keeping the webview state consistent: the .help-webview class
    // holds the home fullscreen slot open for the button — drop it when hidden so
    // the header reflows (Settings/Sleep reclaim the space), re-add when shown.
    const setHidden = (hidden) => {
        if (hidden) {
            close();
            btn.style.display = 'none';
            localStorage.setItem(HIDE_KEY, '1');
            document.documentElement.classList.remove('help-webview');
        } else {
            localStorage.setItem(HIDE_KEY, '0'); // explicit "show" survives the startup auto-hide
            btn.style.display = '';
            if (isInWebView()) document.documentElement.classList.add('help-webview');
            syncHelpButton();
        }
    };
    window.showHelpButton = () => setHidden(false);
    window.hideHelpButton = () => setHidden(true);
    window.isHelpButtonHidden = () => helpHidden();

    // Webview only: keep the button parked over the fullscreen-toggle slot,
    // re-syncing on resize and whenever the router swaps the page.
    if (isInWebView()) {
        if (!helpHidden()) document.documentElement.classList.add('help-webview');
        syncHelpButton();
    }
}

export function toggleHelpOverlay() {
    if (overlay) close();
    else open();
}
