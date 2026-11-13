// Only text-entry contexts, where w/f/e are characters the user is typing rather than
// machine commands. Deliberately excludes button/a[href]/summary and bare [role]: those
// keep focus after a tap and none of them consume a letter key, so blocking on them would
// silently kill the shortcuts for the rest of the page's life. Bare [role] is the worst
// offender — index.html wraps everything in <main role="main">, so it matches always.
const TEXT_ENTRY_SELECTOR = 'dialog, input, select, textarea, [contenteditable], ' +
    '[role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';

export function shouldHandleMachineShortcut(event, onMainPage, dialogOpen) {
    return Boolean(
        onMainPage &&
        !dialogOpen &&
        !event.defaultPrevented &&
        !event.repeat &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.target?.closest?.(TEXT_ENTRY_SELECTOR)
    );
}
