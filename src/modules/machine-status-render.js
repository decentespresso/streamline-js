// Compare rendered content, not raw machine state: translations, colours and
// counters can change independently. Keep literal text distinct from HTML.
export function shouldWriteStatus(previous, next) {
    return !previous || previous.type !== next.type || previous.content !== next.content;
}
