// settings-search.js — what the settings search box is allowed to match.
//
// The nav tree only knows page names, so a plugin's own vocabulary ("upload",
// "visualizer", "threshold") was unreachable: a user searching for a setting had
// to already know which page it lives on. GET /plugins carries each plugin's
// name, description and its manifest settings declarations, which is exactly
// that vocabulary — folded in here as extra keywords on the pages that host it.

// Manifest setting names are PascalCase identifiers ("AutoUpload",
// "LengthThreshold"). Searching for "upload" should find them, so index the split
// words alongside the raw name.
function splitIdentifier(name) {
    return String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ');
}

// One lowercase blob per plugin: name, description, and every setting's name and
// description. Blob rather than a structure because the search is a substring
// test, and a structure would only be flattened at the point of use.
export function pluginKeywords(plugin) {
    if (!plugin) return '';
    const parts = [plugin.name, plugin.description, plugin.id];
    for (const [key, declaration] of Object.entries(plugin.settings || {})) {
        parts.push(key, splitIdentifier(key), declaration?.description);
    }
    return parts.filter(Boolean).join(' ').toLowerCase();
}

export function pluginListKeywords(plugins) {
    return (plugins || []).map(pluginKeywords).filter(Boolean).join(' ');
}

// A query is a set of words, all of which must appear somewhere. "shot upload"
// used to find nothing, because the whole string had to occur verbatim and no
// label contains it; the words are next to each other in the user's head, not in
// the text. Order does not matter and neither does where each word lands.
export function searchTokens(searchTerm) {
    return String(searchTerm || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// Everything a subcategory can be found by: its label, its id, the vocabulary
// of any plugin it hosts, and the words rendered on the page itself.
function haystack(subcat) {
    return [subcat.name, subcat.id, subcat.keywords, subcat.pageText]
        .filter(Boolean).join(' ').toLowerCase();
}

// The one predicate both the filter pass and the render pass use, so a term that
// surfaces a category always finds the same rows inside it.
export function subcategoryMatches(subcat, searchTerm) {
    const tokens = searchTokens(searchTerm);
    if (tokens.length === 0) return true;
    const text = haystack(subcat);
    return tokens.every(token => text.includes(token));
}

// Same rule for a main category, which has only its name to go on.
export function categoryMatches(name, searchTerm) {
    const tokens = searchTokens(searchTerm);
    if (tokens.length === 0) return true;
    const text = String(name || '').toLowerCase();
    return tokens.every(token => text.includes(token));
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One alternation over every search word, rather than a pass per word: a second
// pass would match inside the <mark> markup the first one inserted. Longest word
// first, so where "temp" and "temperature" both match, the longer one claims the
// text. null when there is nothing to look for.
export function tokenPattern(searchTerm) {
    const tokens = searchTokens(searchTerm);
    if (tokens.length === 0) return null;
    const alternation = [...new Set(tokens)]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
    return new RegExp(`(${alternation})`, 'gi');
}

/** The class the highlighter marks matches with, shared by both call sites. */
export const HIGHLIGHT_CLASS = 'bg-yellow-300 text-black';

// Wrap every occurrence of every search word, for text going into innerHTML.
export function highlightTokens(text, searchTerm) {
    const pattern = tokenPattern(searchTerm);
    if (!pattern) return text;
    return String(text).replace(pattern, `<mark class="${HIGHLIGHT_CLASS}">$1</mark>`);
}

// Strip a rendered settings page down to the words a person would read, so the
// search can reach the copy on the page and not just its title. Tags, and the
// script/style bodies that would otherwise contribute code, are dropped.
export function textFromHtml(html) {
    return String(html || '')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}
