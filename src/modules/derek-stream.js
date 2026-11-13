// Pure helpers for the Derek chat: SSE framing and query building.

// Split a growing SSE buffer into complete events. Returns the parsed events
// and the unconsumed tail to prepend to the next chunk.
export function parseSse(buffer) {
    const events = [];
    const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
    const rest = blocks.pop();
    for (const block of blocks) {
        let event = 'message';
        const data = [];
        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        try { events.push({ event, data: JSON.parse(data.join('\n')) }); } catch { /* skip malformed frame */ }
    }
    return { events, rest };
}

const SHOT_PREFIX = 'Here is the summary of my latest espresso shot. Please review it and suggest what to adjust.\n\n';

export function buildShotQuery(summaryMd) {
    return SHOT_PREFIX + summaryMd;
}

// Derek's endpoint is stateless, so follow-ups re-send the shot as context.
export function buildFollowUpQuery(summaryMd, question) {
    return `Context: my espresso shot summary.\n\n${summaryMd}\n\nQuestion: ${question}`;
}

// "a **b** c" -> [{text:'a '},{text:'b',bold:true},{text:' c'}]. Text only —
// callers set textContent, so nothing here is ever treated as HTML.
export function splitBold(line) {
    return line.split(/\*\*(.+?)\*\*/g).map((text, i) => ({ text, bold: i % 2 === 1 })).filter((p) => p.text);
}

// Flatten the chat into markdown for the clipboard. Entries are
// { label, text }; empty ones (a status placeholder that never got an answer)
// are dropped so a copy mid-request is still clean.
export function buildTranscript(entries) {
    return entries
        .filter((e) => e && e.text && e.text.trim())
        .map((e) => `**${e.label}**\n\n${e.text.trim()}`)
        .join('\n\n---\n\n');
}

export const DEREK_WEB_ORIGIN = 'https://derek.decentespresso.com';

// A share_path comes back from a server, so treat it as untrusted: only
// "/share/<id>" becomes a URL, anything else (absolute URL, traversal, empty)
// returns '' and the caller stays on the plain Derek page.
export function buildShareUrl(sharePath) {
    if (typeof sharePath !== 'string') return '';
    return /^\/share\/[A-Za-z0-9_-]+$/.test(sharePath) ? DEREK_WEB_ORIGIN + sharePath : '';
}
