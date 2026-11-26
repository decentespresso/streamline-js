import { HIGHLIGHT_CLASS, tokenPattern } from '../modules/settings-search.js';

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'MARK', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

function matchingTextNodes(area, pattern) {
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (SKIPPED_TAGS.has(node.parentElement?.tagName)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        pattern.lastIndex = 0;
        if (pattern.test(node.nodeValue)) nodes.push(node);
    }
    return nodes;
}

function markNode(node, pattern) {
    const fragment = document.createDocumentFragment();
    let first = null;
    let last = 0;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(node.nodeValue); match; match = pattern.exec(node.nodeValue)) {
        if (match.index > last) fragment.appendChild(document.createTextNode(node.nodeValue.slice(last, match.index)));
        const mark = document.createElement('mark');
        mark.className = HIGHLIGHT_CLASS;
        mark.textContent = match[0];
        fragment.appendChild(mark);
        first ??= mark;
        last = match.index + match[0].length;
    }
    if (last < node.nodeValue.length) fragment.appendChild(document.createTextNode(node.nodeValue.slice(last)));
    node.parentNode.replaceChild(fragment, node);
    return first;
}

export function highlightSearchMatches(area, searchTerm) {
    const pattern = tokenPattern(searchTerm);
    if (!area || !pattern) return null;
    let first = null;
    for (const node of matchingTextNodes(area, pattern)) {
        const mark = markNode(node, pattern);
        first ??= mark;
    }
    return first;
}

export function revealSearchMatches(area, searchTerm) {
    const first = highlightSearchMatches(area, searchTerm);
    first?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return first;
}
