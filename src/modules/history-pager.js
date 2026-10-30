function mergeShots(existing, pages) {
    const byId = new Map(existing.map(shot => [shot.id, shot]));
    for (const shot of pages.flat()) {
        const current = byId.get(shot.id);
        byId.set(shot.id, current
            ? { ...current, ...shot, ...(current.measurements && !shot.measurements ? { measurements: current.measurements } : {}) }
            : shot);
    }
    // Parse each timestamp once instead of twice per comparison. `|| 0` keeps
    // the comparator's NaN behaviour (an unparseable timestamp compares equal).
    return [...byId.values()]
        .map(shot => [timeOf(shot), shot])
        .sort((a, b) => (b[0] - a[0]) || 0)
        .map(pair => pair[1]);
}

const timeOf = shot => new Date(shot?.timestamp).getTime();

// Decaid answers DELETE /shots/{id} with 404 when the shot is already gone;
// that is the outcome the caller wanted, so the local copy must still go.
export function isShotAlreadyDeleted(status) {
    return status === 404;
}

// A successful GET /shots?order=desc page is a contiguous slice of the server's
// timestamp-sorted list. Everything strictly between its newest and oldest
// timestamps therefore either came back in the page or no longer exists on the
// server. Bounds are exclusive because rows sharing a boundary timestamp can
// straddle the neighbouring page. The newest edge is open only on the first
// page, the oldest edge only when the page reaches the server's total. Returns
// null (prune nothing) for an empty page or an unparseable timestamp.
export function getAuthoritativeRange(page, offset) {
    const items = page?.items;
    if (!Array.isArray(items) || items.length === 0) return null;
    const times = items.map(timeOf);
    if (times.some(time => Number.isNaN(time))) return null;
    const newest = items[times.indexOf(Math.max(...times))].timestamp;
    const oldest = items[times.indexOf(Math.min(...times))].timestamp;
    const reachesEnd = Number.isFinite(page.total) && offset + items.length >= page.total;
    return {
        newer: offset === 0 ? null : newest,
        older: reachesEnd ? null : oldest,
        keepIds: items.map(item => item.id)
    };
}

export function isInPruneRange(shot, range) {
    if (!range || range.keepIds.includes(shot.id)) return false;
    const time = timeOf(shot);
    if (Number.isNaN(time)) return false;
    if (range.newer !== null && !(time < new Date(range.newer).getTime())) return false;
    if (range.older !== null && !(time > new Date(range.older).getTime())) return false;
    return true;
}

export function createHistoryPager({ pageSize, fetchServerPage, fetchSummaryPage, fetchCachedPage, pruneShots }) {
    let shots = [];
    let server = { offset: 0, exhausted: false, failed: false };
    let summaries = { offset: 0, exhausted: false };
    let cached = { offset: 0, exhausted: false };
    let updatedShots = new Map();
    let oldest = { summaries: null, cached: null };
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

        // Later pages override earlier ones, so local updates win over every source.
        shots = mergeShots(shots, [summaryPage, cachedPage, serverPage?.items ?? [], [...updatedShots.values()]]);
        if (summaryPage.length) oldest.summaries = timeOf(summaryPage[summaryPage.length - 1]);
        if (cachedPage.length) oldest.cached = timeOf(cachedPage[cachedPage.length - 1]);

        // Only a successful server page is authoritative; a failed one prunes nothing.
        const range = serverPage ? getAuthoritativeRange(serverPage, serverStart.offset) : null;
        if (range) {
            shots = shots.filter(shot => !isInPruneRange(shot, range));
            updatedShots = new Map([...updatedShots].filter(([, shot]) => !isInPruneRange(shot, range)));
            if (pruneShots) {
                try {
                    const removed = await pruneShots(range);
                    if (loadGeneration !== generation) return pageResult(errors);
                    // Removed rows inside the already-consumed part of a store shift its later pages.
                    const consumed = (times, floor) => floor === null ? 0 : (times ?? []).filter(time => time >= floor).length;
                    summaries = { ...summaries, offset: Math.max(0, summaries.offset - consumed(removed?.summaries, oldest.summaries)) };
                    cached = { ...cached, offset: Math.max(0, cached.offset - consumed(removed?.cached, oldest.cached)) };
                } catch (error) {
                    errors.push(error);
                }
            }
        }
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
            oldest = { summaries: null, cached: null };
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

// Decides whether a /shots/latest probe means shots landed while this client
// was away. Only reload when history is already loaded (knownId), the server
// reports a different newest id, and no shot is live (a live shot's own
// espresso->idle path owns the refresh).
export function shouldReloadForLatestShot(latestId, knownId, shotLive) {
    if (shotLive) return false;
    if (typeof latestId !== 'string' || latestId === '') return false;
    if (typeof knownId !== 'string' || knownId === '') return false;
    return latestId !== knownId;
}
