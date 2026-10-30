// The workflow note is the one description field that belongs to a single shot;
// bean, roaster, batch, grinder, barista, drinker, basket and rpm persist until the
// user changes them. DOM-free so node:test can import it.

/** The context payload that drops the note once a shot is persisted, or null when none is set. */
export function noteClearContext(context) {
    return context?.extras?.note != null ? { extras: { note: null } } : null;
}
