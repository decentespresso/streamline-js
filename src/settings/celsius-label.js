const CELSIUS_SYMBOL = /[°º]C\b|℃/g;

export function lowercaseCelsius(text) {
    return text.replace(CELSIUS_SYMBOL, '°c');
}

function fixTextNode(node) {
    const fixed = lowercaseCelsius(node.nodeValue);
    if (fixed !== node.nodeValue) node.nodeValue = fixed;
}

function fixTree(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) fixTextNode(walker.currentNode);
}

export function observeCelsiusLabels(root) {
    if (!root) return () => {};
    fixTree(root);
    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'characterData') fixTextNode(record.target);
            record.addedNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) fixTextNode(node);
                else if (node.nodeType === Node.ELEMENT_NODE) fixTree(node);
            });
        }
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
}
