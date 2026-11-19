export function lookAlikeKey(title) {
    return (title || '').replace(/\s*\(\d+\)\s*$/, '').trim();
}

export function countLookAlikeTitles(titles) {
    const counts = new Map();
    for (const title of titles) {
        const key = lookAlikeKey(title);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}

export function isLookAlike(counts, title) {
    return (counts.get(lookAlikeKey(title)) || 0) > 1;
}
