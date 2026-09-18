function mergeShots(existing, pages) {
    const byId = new Map(existing.map(shot => [shot.id, shot]));
    for (const shot of pages.flat()) {
        const current = byId.get(shot.id);
        byId.set(shot.id, current
            ? { ...current, ...shot, ...(current.measurements && !shot.measurements ? { measurements: current.measurements } : {}) }
            : shot);
    }
    return [...byId.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export function createHistoryPager({ pageSize, fetchServerPage, fetchSummaryPage, fetchCachedPage }) {
    let shots = [];
    let server = { offset: 0, exhausted: false, failed: false };
    let summaries = { offset: 0, exhausted: false };
    let cached = { offset: 0, exhausted: false };
    let updatedShots = new Map();
    let loadPromise = null;
    let generation = 0;

    const canLoadMore = () => !server.exhausted || !summaries.exhausted || !cached.exhausted;
    const pageResult = (errors = []) => ({ shots: [...shots], hasMore: canLoadMore(), errors });

    async function loadPage(loadGeneration) {
        const serverStart = server;
        const summariesStart = summaries;
        const cachedStart = cached;
        const results = await Promise.allSettled([
            serverStart.exhausted ? [] : fetchServerPage(serverStart.offset, pageSize),
            summariesStart.exhausted ? [] : fetchSummaryPage(summariesStart.offset, pageSize),
            cachedStart.exhausted ? [] : fetchCachedPage(cachedStart.offset, pageSize)
        ]);
        if (loadGeneration !== generation) return pageResult();
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        const serverPage = results[0].status === 'fulfilled' ? results[0].value : null;
        const summaryPage = results[1].status === 'fulfilled' ? results[1].value : [];
        const cachedPage = results[2].status === 'fulfilled' ? results[2].value : [];

        if (serverPage) {
            const items = serverPage.items ?? [];
            const offset = serverStart.offset + items.length;
            server = {
                offset,
                exhausted: Number.isFinite(serverPage.total) ? offset >= serverPage.total : items.length < pageSize,
                failed: false
            };
        } else if (results[0].status === 'rejected') {
            server = { ...server, failed: true };
        }
        if (results[1].status === 'fulfilled') {
            summaries = { offset: summariesStart.offset + summaryPage.length, exhausted: summaryPage.length < pageSize };
        } else {
            summaries = { ...summaries, exhausted: true };
        }
        if (results[2].status === 'fulfilled') {
            cached = { offset: cachedStart.offset + cachedPage.length, exhausted: cachedPage.length < pageSize };
        } else {
            cached = { ...cached, exhausted: true };
        }

        shots = mergeShots(shots, [summaryPage, cachedPage, serverPage?.items ?? []]);
        shots = mergeShots(shots, [[...updatedShots.values()]]);
        return pageResult(errors);
    }

    function load() {
        if (loadPromise?.generation === generation) return loadPromise.promise;
        const loadGeneration = generation;
        const promise = loadPage(loadGeneration).finally(() => {
            if (loadPromise?.promise === promise) loadPromise = null;
        });
        loadPromise = { generation: loadGeneration, promise };
        return promise;
    }

    return {
        initial() {
            generation += 1;
            shots = [];
            server = { offset: 0, exhausted: false, failed: false };
            summaries = { offset: 0, exhausted: false };
            cached = { offset: 0, exhausted: false };
            updatedShots = new Map();
            return load();
        },
        more: load,
        hasMore: canLoadMore,
        update(shot) {
            shots = mergeShots(shots, [[shot]]);
            updatedShots = new Map([...updatedShots, [shot.id, shots.find(item => item.id === shot.id)]]);
            return [...shots];
        },
        remove(id) {
            if (shots.some(shot => shot.id === id)) {
                server = { ...server, offset: Math.max(0, server.offset - 1) };
                summaries = { ...summaries, offset: Math.max(0, summaries.offset - 1) };
                cached = { ...cached, offset: Math.max(0, cached.offset - 1) };
            }
            updatedShots = new Map([...updatedShots].filter(([shotId]) => shotId !== id));
            shots = shots.filter(shot => shot.id !== id);
            return [...shots];
        }
    };
}
