export function shouldUseNumpad() {
    if (window._forceNumpadMobile !== undefined) return window._forceNumpadMobile;
    const isTouchDevice = 'ontouchstart' in window
        || navigator.maxTouchPoints > 0
        || window.matchMedia('(pointer: coarse)').matches;
    return !(window.innerWidth >= 1200 && window.innerHeight >= 900 && !isTouchDevice);
}
