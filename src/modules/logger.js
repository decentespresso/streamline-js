const noop = () => {};

export const logger = {
    debug: noop, // Start with a no-op function for debug
    info: noop,
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
