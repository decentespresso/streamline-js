// The tap click, off by default (Settings > Miscellaneous).
//
// The sound is de1app's own `button_in`: src/sounds/KeypressStandard_120.ogg,
// registered there in utils.tcl as `dui sound set button_in` and played through
// `say`. It is the AOSP keypress effect at reduced volume (Apache-2.0, see
// src/sounds/README.md), so a Streamline tap sounds like a de1app tap.
//
// Played through WebAudio rather than an <audio> element: a decoded buffer can
// overlap with itself, so a fast double tap gives two clicks instead of cutting
// the first one off, and there is no per-tap element construction on the touch
// path. Nothing here touches the DOM at module load, so node tests can import it.

import { logger } from './logger.js';

export const TOUCH_SOUND_KEY = 'streamline.touchSound';
const SOUND_URL = 'src/sounds/KeypressStandard_120.ogg';

export function isTouchSoundEnabled() {
    try { return localStorage.getItem(TOUCH_SOUND_KEY) === 'true'; } catch (e) { return false; }
}

/**
 * Does a tap on this element deserve a click?
 *
 * Controls only: a tap on a background, a label or a readout is not a press and
 * must stay silent. `[data-no-sound]` opts an individual control out.
 *
 * @param {*} target  the pointerdown target
 * @param {function} closest  how to walk ancestors; injected so this is testable
 */
export function isSoundTarget(target, closest = (el, sel) => el?.closest?.(sel)) {
    if (!target) return false;
    const control = closest(target, 'button, [role="button"], input[type="checkbox"], input[type="radio"], select, a[href], .preset-button, [data-tile], [data-steam-mode], [data-auto-pitcher]');
    if (!control) return false;
    if (closest(target, '[data-no-sound]')) return false;
    return !control.disabled;
}

let context = null;
let buffer = null;
let loading = null;

// Decoding is deferred to the first tap that will actually play: the setting is
// off by default, and an AudioContext created before a user gesture starts
// suspended and would have to be resumed anyway.
async function ensureBuffer() {
    if (buffer) return buffer;
    loading ||= (async () => {
        context ||= new (window.AudioContext || window.webkitAudioContext)();
        const response = await fetch(SOUND_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        buffer = await context.decodeAudioData(await response.arrayBuffer());
        return buffer;
    })();
    return loading;
}

export async function playTouchSound() {
    try {
        await ensureBuffer();
        // Never awaited: resume() only settles once the page has real user
        // activation, so awaiting it inside a tap handler that fired without one
        // leaves a promise pending for the life of the page -- one per tap.
        // Fire and forget, then play; a context that is still suspended drops
        // this click, which is the right way to lose.
        if (context.state === 'suspended') context.resume().catch(() => {});
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start();
    } catch (error) {
        loading = null; // a failed decode must not pin the module into silence
        logger.warn('Touch sound failed:', error);
    }
}

let started = false;

/** Idempotent. Safe to call on every main-page mount. */
export function initTouchSound() {
    if (started) return;
    started = true;
    // Capture phase on the document: every control is covered without each one
    // having to opt in, and a handler that stops propagation cannot mute it.
    // pointerdown rather than click, so the click lands with the finger.
    document.addEventListener('pointerdown', event => {
        if (!isTouchSoundEnabled() || !isSoundTarget(event.target)) return;
        playTouchSound();
    }, { capture: true, passive: true });
}
