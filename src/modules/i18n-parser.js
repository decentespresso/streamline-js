export const SUPPORTED_LANGUAGES = Object.freeze([
    'en', 'fr', 'es', 'de', 'de-ch', 'zh-hans', 'zh-hant', 'kr', 'pt', 'ar', 'arb', 'he', 'heb', 'da', 'sv', 'no',
    'it', 'nl', 'jp-unfinished', 'th-unfinished', 'hu-unfinished', 'pl-unfinished', 'sk-unfinished', 'el-unfinished',
    'cs-unfinished', 'ro-unfinished', 'hi-unfinished', 'tr-unfinished', 'ru-unfinished', 'de-oe unfinished',
    'ca-unfinished', 'fi-unfinished',
]);

function selectedValues(line, targetColumn) {
    let column = 0;
    let quoted = false;
    let value = '';
    let key = '';
    let translation = '';

    const commit = () => {
        const normalized = value.trim();
        if (column === 0) key = normalized;
        if (column === targetColumn) translation = normalized;
        column += 1;
        value = '';
    };

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"' && quoted && line[index + 1] === '"') {
            value += '"';
            index += 1;
        } else if (character === '"') {
            quoted = !quoted;
        } else if (character === ',' && !quoted) {
            commit();
            if (column > targetColumn) break;
        } else {
            value += character;
        }
    }
    if (column <= targetColumn) commit();
    return [key, translation];
}

export function parseTranslationColumn(csvText, language) {
    const normalizedText = csvText.charCodeAt(0) === 0xFEFF ? csvText.slice(1) : csvText;
    const lines = normalizedText.split(/\r?\n/);
    const headers = lines[0].split(',').map(header => header.trim());
    const targetColumn = headers.indexOf(language);
    if (targetColumn < 0) throw new Error(`Translation column not found: ${language}`);

    const table = {};
    const keyIndex = {};
    for (let index = 1; index < lines.length; index += 1) {
        if (!lines[index]) continue;
        const [key, translation] = selectedValues(lines[index], targetColumn);
        if (!key) continue;
        table[key] = translation || key;
        keyIndex[key.toLowerCase()] = key;
    }
    return { table, keyIndex };
}
