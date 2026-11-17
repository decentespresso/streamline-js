export const SUPPORTED_LANGUAGES = Object.freeze([
    'en', 'fr', 'es', 'de', 'de-ch', 'zh-hans', 'zh-hant', 'kr', 'pt', 'ar', 'arb', 'he', 'heb', 'da', 'sv', 'no',
    'it', 'nl', 'jp-unfinished', 'th-unfinished', 'hu-unfinished', 'pl-unfinished', 'sk-unfinished', 'el-unfinished',
    'cs-unfinished', 'ro-unfinished', 'hi-unfinished', 'tr-unfinished', 'ru-unfinished', 'de-oe unfinished',
    'ca-unfinished', 'fi-unfinished',
]);

// Device locale (BCP-47) -> the sheet's column name, where the two disagree.
//
// The columns are named after the sheet's own history, not after language
// codes: Korean is `kr` (the region, not the language `ko`), Chinese is split
// by script, and the partly-translated languages carry an `-unfinished`
// suffix. Without this table a Korean, Chinese or Norwegian tablet matched
// nothing and silently started in English.
//
// `nb`/`nn` are Bokmål and Nynorsk, which both read the `no` column; `iw` is
// the legacy code for Hebrew that older Android still reports.
//
// de-AT is deliberately absent: it falls through to the complete `de` column
// rather than the 45%-translated `de-oe unfinished` one.
const LANGUAGE_ALIASES = Object.freeze({
    ko: 'kr',
    iw: 'he',
    nb: 'no',
    nn: 'no',
    ja: 'jp-unfinished',
    th: 'th-unfinished',
    hu: 'hu-unfinished',
    pl: 'pl-unfinished',
    sk: 'sk-unfinished',
    el: 'el-unfinished',
    cs: 'cs-unfinished',
    ro: 'ro-unfinished',
    hi: 'hi-unfinished',
    tr: 'tr-unfinished',
    ru: 'ru-unfinished',
    ca: 'ca-unfinished',
    fi: 'fi-unfinished',
});

// Chinese needs the script, which the primary subtag does not carry: a bare
// `zh-CN` is Simplified and `zh-TW` is Traditional, and only Taiwan, Hong Kong
// and Macau default to Traditional.
const TRADITIONAL_REGIONS = new Set(['tw', 'hk', 'mo']);

function matchChinese(parts) {
    if (parts.includes('hant')) return 'zh-hant';
    if (parts.includes('hans')) return 'zh-hans';
    return parts.some((part) => TRADITIONAL_REGIONS.has(part)) ? 'zh-hant' : 'zh-hans';
}

/**
 * The column a single language tag should read, or null when none fits.
 * Accepts a column name as well, so a stored preference round-trips.
 */
export function matchLanguage(tag) {
    const normalized = String(tag || '').trim().toLowerCase();
    if (!normalized) return null;
    if (SUPPORTED_LANGUAGES.includes(normalized)) return normalized;

    const parts = normalized.split(/[-_]/);
    const primary = parts[0];
    if (primary === 'zh') return matchChinese(parts);

    // `de-CH` style: a region-specific column when the sheet has one.
    const regional = `${primary}-${parts[1]}`;
    if (parts.length > 1 && SUPPORTED_LANGUAGES.includes(regional)) return regional;

    const alias = LANGUAGE_ALIASES[primary];
    if (alias && SUPPORTED_LANGUAGES.includes(alias)) return alias;
    return SUPPORTED_LANGUAGES.includes(primary) ? primary : null;
}

/**
 * The first of the device's preferred languages we can actually show.
 * `navigator.languages` is ordered by preference, so a user whose first choice
 * we do not carry still gets their second rather than English.
 */
export function resolveLanguage(tags) {
    for (const tag of [].concat(tags ?? [])) {
        const match = matchLanguage(tag);
        if (match) return match;
    }
    return null;
}

/**
 * Which language to start in: the stored one, or the device's.
 *
 * `stored` is only evidence of a preference when the user actually picked it
 * (`chosen`). Boot persists whatever it resolved, so an install that ran a
 * build whose matcher could not read its locale -- every zh-TW, ko-KR, nb-NO
 * and iw-IL tablet before the alias table -- has `en` written in as if it were
 * a choice, and would keep starting in English forever. A stored `en` that
 * nobody chose is therefore re-asked; any other stored language is kept, since
 * that one did match a device once.
 */
export function preferredLanguage({ stored = null, device = null, chosen = false } = {}) {
    if (chosen && stored) return stored;
    if (!chosen && stored && stored !== 'en') return stored;
    return device || stored || 'en';
}

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
