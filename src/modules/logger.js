const noop = () => {};

export const logger = {
    debug: noop, // Start with a no-op function for debug
    info: noop,
    // Always on, unlike info: the short trails a bug report has to carry on its
    // own, because the bug is an ORDER of events across clients and arrives as a
    // log rather than as a repro. Keep these to field names and ids -- they leave
    // the tablet in user-submitted logs.
    audit: console.log.bind(console, '[AUDIT]'),
    warn: console.warn.bind(console, '[WARN]'),
    error: console.error.bind(console, '[ERROR]'),
};

export function setDebug(enabled) {
    if (enabled) {
        // When debugging is on, point logger.debug to a bound console.log
        logger.debug = console.log.bind(console, '[DEBUG]');
    } else {
        // When it's off, point it back to the function that does nothing
        logger.debug = noop;
    }
}
