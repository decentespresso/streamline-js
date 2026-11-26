const CELSIUS_SYMBOL = /[°º]C\b|℃/g;
const UNIT_ONLY_CELSIUS = /([(（])°c([)）])/g;
const UNIT_CHOICE = 'select, .custom-select-trigger, .custom-select-panel, [role="listbox"]';

export function lowercaseCelsius(text) {
    return text.replace(CELSIUS_SYMBOL, '°c');
}

export function celsiusLabelText(text, unit = 'C') {
    const lowered = lowercaseCelsius(text);
    return unit === 'F' ? lowered.replace(UNIT_ONLY_CELSIUS, '$1°F$2') : lowered;
}

function fixTextNode(node, unit) {
    const keepCelsius = node.parentElement?.closest(UNIT_CHOICE);
    const fixed = keepCelsius ? lowercaseCelsius(node.nodeValue) : celsiusLabelText(node.nodeValue, unit());
    if (fixed !== node.nodeValue) node.nodeValue = fixed;
}

function fixTree(root, unit) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) fixTextNode(walker.currentNode, unit);
}

export function observeCelsiusLabels(root, { unit = () => 'C' } = {}) {
    if (!root) return () => {};
    fixTree(root, unit);
    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'characterData') fixTextNode(record.target, unit);
            record.addedNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) fixTextNode(node, unit);
                else if (node.nodeType === Node.ELEMENT_NODE) fixTree(node, unit);
            });
        }
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
}
