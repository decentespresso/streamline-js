import * as chart from './chart.js';
import { logger } from './logger.js';
import { openDB, getLatestShotSummaries, getLatestCachedShotSummaries, getLatestCachedShot, getShot, addShot, addShots, deleteShot as idbDeleteShot, clearShots } from './idb.js';
import { API_BASE_URL } from './api.js';
import { createHistoryPager } from './history-pager.js';
import { renderPastShot, clearShotData } from './shotData.js';
import { getTranslation } from './i18n.js';
import { translateProfileTitle } from './profileManager.js';
import { generateShotSummary } from './shotSummary.js';
import { openContextMenu } from './context-menu.js';
import { showToast, setupPressAndHold } from './ui.js';
import { isVisualizerEnabled, uploadShotToVisualizer } from './visualizer.js';

const DEREK_URL = 'https://derek.decentespresso.com/';

const PAGE_SIZE = 20;
let shots = [];
let currentShotIndex = -1;
let historyHasMore = false;
// id of the shot currently drawn on the chart -- lets displayShot() skip a
// redundant redraw right after paintNewestShotFast() already drew this exact
// shot during boot. Not touched by refreshCurrentShot(), which must always
// force a redraw (it exists specifically to repaint over whatever the
// profile selector left on the shared chart element).
let paintedShotId = null;

// Paints whatever the newest shot in the local IDB cache is, instantly --
// an indexed cursor read, no network wait. May be stale (a shot pulled since
// this cache was last written won't be here yet); paintNewestShotFast()
// below confirms/corrects it against the network moments later.
async function paintFromCacheFast() {
    try {
        const cached = await getLatestCachedShot();
        if (cached?.measurements) {
            chart.plotHistoricalShot(cached.measurements, cached.workflow);
            paintedShotId = cached.id;
            return cached;
        }
    } catch (error) {
        logger.warn('Cache-first shot paint failed:', error);
    }
    return null;
}

// Confirms/corrects the newest shot against the network: /shots/latest
// (cheap, no measurements) tells us the real newest id. If it matches what
// paintFromCacheFast() already painted, cache was current -- no further
// fetch or redraw needed. Otherwise fetches /shots/{id} for the full record
// and draws it. Runs in parallel with loadShotHistory()'s slower 20-item
// list + IDB sync in initHistory(), so the chart isn't gated behind fetching
// shots it doesn't need yet just to confirm/show the first one.
async function paintNewestShotFast(alreadyPaintedId = null, alreadyPaintedShot = null) {
    try {
        const latestResponse = await fetch(`${API_BASE_URL}/shots/latest`);
        if (!latestResponse.ok) return null;
        const latestSummary = await latestResponse.json();
        if (!latestSummary?.id) return null;

        if (latestSummary.id === alreadyPaintedId) {
            return alreadyPaintedShot; // cache was already correct
        }

        const fullResponse = await fetch(`${API_BASE_URL}/shots/${latestSummary.id}`);
        if (!fullResponse.ok) return null;
        const fullShot = { ...latestSummary, ...(await fullResponse.json()) };

        if (fullShot.measurements) {
            chart.plotHistoricalShot(fullShot.measurements, fullShot.workflow);
            paintedShotId = fullShot.id;
        }
        addShot(fullShot); // fire-and-forget cache write, doesn't gate the paint
        return fullShot;
    } catch (error) {
        logger.warn('Fast newest-shot paint failed:', error);
        return null;
    }
}

const historyPager = createHistoryPager({
    pageSize: PAGE_SIZE,
    async fetchServerPage(offset, limit) {
        const response = await fetch(`${API_BASE_URL}/shots?limit=${limit}&offset=${offset}&order=desc`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        await addShots(data.items ?? []);
        return data;
    },
    fetchSummaryPage: (offset, limit) => getLatestShotSummaries(limit, offset),
    fetchCachedPage: (offset, limit) => getLatestCachedShotSummaries(limit, offset)
});

function applyHistoryPage(page) {
    const selectedId = shots[currentShotIndex]?.id;
    shots = page.shots;
    if (selectedId) currentShotIndex = shots.findIndex(shot => shot.id === selectedId);
    historyHasMore = page.hasMore;
    page.errors.forEach(error => logger.warn('Could not load shot history source:', error));
}

async function loadShotHistory() {
    applyHistoryPage(await historyPager.initial());
    if (shots.length === 0) {
        const cached = await getLatestCachedShot();
        if (cached) shots = historyPager.update(cached);
    }
    logger.info('Shot history loaded:', shots.length, 'shots');
}

async function loadMoreShots() {
    if (!historyHasMore) return;
    applyHistoryPage(await historyPager.more());
}

async function loadFullShot(shot) {
    try {
        const cached = await getShot(shot.id);
        if (cached?.measurements) return { ...cached, ...shot, measurements: cached.measurements };
        const response = await fetch(`${API_BASE_URL}/shots/${shot.id}`);
        if (!response.ok) return shot;
        const fullShot = { ...shot, ...(await response.json()) };
        await addShot(fullShot);
        return fullShot;
    } catch (error) {
        logger.warn('Could not load full shot data:', error);
        return shot;
    }
}

async function displayShot(index) {
    if (index < 0 || index >= shots.length) {
        logger.warn('Invalid shot index', index);
        return;
    }

    currentShotIndex = index;
    const shot = shots[currentShotIndex];

    // Update footer text
    const dateEl = document.getElementById('history-date');
    const profileNameEl = document.getElementById('history-profile-name');
    const historyLabelEl = document.getElementById('shot-history-label');

    if (dateEl) {
        const date = new Date(shot.timestamp);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        dateEl.textContent = `${year}/${month}/${day} ${hours}:${minutes}`;
    }
    if (profileNameEl && shot.workflow && shot.workflow.profile) {
        profileNameEl.textContent = translateProfileTitle(shot.workflow.profile.title);
    }
    if (historyLabelEl) {
        if (index === 0) {
            historyLabelEl.textContent = getTranslation('NEWEST');
        } else if (index === shots.length - 1 && !historyHasMore) {
            historyLabelEl.textContent = getTranslation('OLDEST');
        } else {
            historyLabelEl.textContent = getTranslation('HISTORY');
        }
    }

    const doseInEl = document.getElementById('history-dose-in');
    const grindSizeEl = document.getElementById('history-grind-size');

    if (doseInEl) {
        const doseIn = shot.annotations?.actualDoseWeight
            ?? shot.workflow?.context?.targetDoseWeight
            ?? shot.workflow?.doseData?.doseIn;
        if (typeof doseIn !== 'undefined' && doseIn !== null) {
            doseInEl.textContent = `In ${doseIn}g`;
        } else {
            doseInEl.textContent = `In: N/A`;
        }
    }

    if (grindSizeEl) {
        const grindSetting = shot.workflow?.context?.grinderSetting ?? shot.workflow?.grinderData?.setting;
        if (typeof grindSetting !== 'undefined' && grindSetting !== null) {
            const settingFloat = parseFloat(grindSetting);
            grindSizeEl.textContent = !isNaN(settingFloat) ? `Grind ${settingFloat}` : `Grind N/A`;
        } else {
            grindSizeEl.textContent = `Grind N/A`;
        }
    }

    // Lazy-load measurements if not present
    if (!shots[index].measurements) {
        const fullShot = await loadFullShot(shot);
        if (currentShotIndex !== index || shots[index]?.id !== shot.id) return;
        shots = historyPager.update(fullShot);
        currentShotIndex = shots.findIndex(item => item.id === shot.id);
    }

    if (shots[currentShotIndex].measurements) {
        // Skip the redraw if paintNewestShotFast() already drew this exact
        // shot moments ago during boot -- same data, avoid a pointless second
        // the chart renderer.
        if (paintedShotId !== shot.id) {
            chart.plotHistoricalShot(shots[currentShotIndex].measurements, shots[currentShotIndex].workflow);
            paintedShotId = shot.id;
        }
        renderPastShot(shots[currentShotIndex]);
    } else {
        // No measurements, and the fetch above could not get any -- the record
        // is a list entry the server no longer has (a reset or re-pointed
        // Decaid leaves the local cache holding shots whose /shots/{id} now
        // 404s). Draw the empty chart rather than leaving whatever was there,
        // or nothing at all: at boot nothing has drawn yet, so skipping this
        // left the dashboard with no chart whatsoever -- no axes, no grid.
        logger.warn(`Shot ${shot.id} has no measurements available; showing an empty chart.`);
        chart.clearChart();
        clearShotData();
        paintedShotId = null;
    }

    // Update button states
    const prevBtn = document.getElementById('history-prev-btn');
    const nextBtn = document.getElementById('history-next-btn');

    if (prevBtn) {
        prevBtn.classList.toggle('invisible', currentShotIndex >= shots.length - 1 && !historyHasMore);
    }
    if (nextBtn) {
        nextBtn.classList.toggle('invisible', currentShotIndex <= 0);
    }

    // Transparently prefetch next page when approaching the end
    if (currentShotIndex >= shots.length - 3 && historyHasMore) {
        loadMoreShots();
    }

}

// Re-plot the currently selected history shot. The main-page chart shares the
// `plotly-chart` id with the profile selector, so the selector's plotProfile()
// paints over it; call this when returning to the main page to restore history.
export function refreshCurrentShot() {
    if (currentShotIndex >= 0 && shots[currentShotIndex]?.measurements) {
        chart.plotHistoricalShot(shots[currentShotIndex].measurements, shots[currentShotIndex].workflow);
        renderPastShot(shots[currentShotIndex]);
    } else {
        chart.clearChart();
    }
}

// Ensure the current shot has its measurements loaded (the list endpoint
// strips them; the summary needs the full record).
async function ensureCurrentShotMeasurements() {
    const index = currentShotIndex;
    const shot = shots[index];
    if (!shot) return null;
    if (shot.measurements) return shot;
    const fullShot = await loadFullShot(shot);
    if (currentShotIndex !== index || shots[index]?.id !== shot.id) return null;
    shots = historyPager.update(fullShot);
    currentShotIndex = shots.findIndex(item => item.id === shot.id);
    return shots[currentShotIndex];
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Clipboard API blocked (insecure context / webview) — fall back.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    }
}

// Build the markdown summary of the displayed shot (loading measurements as
// needed). Returns null and toasts if there's nothing to summarize.
async function buildCurrentShotSummary() {
    if (currentShotIndex < 0) { showToast(getTranslation('No shot selected'), 2400, 'warning'); return null; }
    const shot = await ensureCurrentShotMeasurements();
    if (!shot?.measurements?.length) { showToast(getTranslation('No shot data to summarize'), 3000, 'warning'); return null; }
    return generateShotSummary(shot);
}

async function copyMd(md) {
    const ok = await copyText(md);
    showToast(getTranslation(ok ? 'Summary copied to clipboard' : 'Could not copy summary'), 2400, ok ? 'success' : 'error');
}

// Long-press the shot history panel -> options menu. Reuses the shared
// setupPressAndHold helper (same one profile cards use). The nav arrows stop
// their own press from bubbling so navigation taps still work.
//
// We build the summary up front so both actions act on a ready string: "Discuss
// with Derek" is a link item (anchor) — the user's tap opens the OS browser with
// the Derek URL (gh#384) and copies the summary on the same tap to paste.
function setupHistoryLongPress() {
    const panel = document.getElementById('shot-history-panel');
    if (!panel) return;

    // Stop BOTH press and release from reaching the panel. Release matters on
    // touch: the panel's press-and-hold endPress preventDefaults touchend,
    // which suppresses the button's synthetic click — arrows dead on tablets.
    ['history-prev-btn', 'history-next-btn'].forEach((id) => {
        const btn = document.getElementById(id);
        ['mousedown', 'touchstart', 'pointerdown', 'mouseup', 'touchend', 'pointerup'].forEach((ev) =>
            btn?.addEventListener(ev, (e) => e.stopPropagation()));
    });

    setupPressAndHold(panel, () => {}, async () => {
        const md = await buildCurrentShotSummary();
        if (md == null) return;
        const items = [
            { label: getTranslation('Discuss with Derek'), href: DEREK_URL, onSelect: () => copyMd(md) },
            { label: getTranslation('Copy Shot Summary'), onSelect: () => copyMd(md) },
        ];
        // Manual upload: the one on screen, whichever the user has paged to.
        // Offered whenever Visualizer is switched on — with auto-upload off this
        // is the only way up, and with it on it re-sends a shot that was missed.
        if (isVisualizerEnabled()) {
            items.push({
                label: getTranslation('Upload to Visualizer'),
                onSelect: () => uploadCurrentShotToVisualizer(),
            });
        }
        openContextMenu(panel, items);
    });
}

// Upload the shot on screen. The plugin fetches it from Decaid by id, so the
// measurements do not have to be loaded here.
async function uploadCurrentShotToVisualizer() {
    const shot = shots[currentShotIndex];
    if (!shot?.id) { showToast(getTranslation('No shot selected'), 2400, 'warning'); return; }
    showToast(getTranslation('Uploading to Visualizer…'), 2000, 'info');
    try {
        await uploadShotToVisualizer(shot.id);
        showToast(getTranslation('Shot uploaded to Visualizer'), 2400, 'success');
    } catch (error) {
        logger.warn('Manual Visualizer upload failed:', error);
        // The plugin's own reason is the useful part: too short, bad credentials,
        // offline. It arrives inside the api.js wrapper's message.
        showToast(`${getTranslation('Upload to Visualizer failed')}: ${error.message}`, 4000, 'error');
    }
}

export async function initHistory() {
    try {
        await openDB();
    } catch (error) {
        logger.error('Failed to open IndexedDB:', error);
        return;
    }

    setupHistoryLongPress();

    const prevBtn = document.getElementById('history-prev-btn');
    const nextBtn = document.getElementById('history-next-btn');

    prevBtn.onclick = async () => {
        if (currentShotIndex < shots.length - 1) {
            displayShot(currentShotIndex + 1);
        } else if (historyHasMore) {
            await loadMoreShots();
            if (currentShotIndex < shots.length - 1) {
                displayShot(currentShotIndex + 1);
            }
        }
    };

    nextBtn.onclick = () => {
        if (currentShotIndex > 0) {
            displayShot(currentShotIndex - 1);
        }
    };

    // Paint instantly from whatever's cached locally, then confirm/correct it
    // against the network in parallel with the slower list+IDB sync below --
    // the chart no longer waits on caching 20 shots it doesn't need yet just
    // to show shot #0.
    const cachedShot = await paintFromCacheFast();
    const fastPaintPromise = paintNewestShotFast(cachedShot?.id, cachedShot);

    await loadShotHistory();
    const fastShot = await fastPaintPromise;

    // Reuse the already-fetched full record so displayShot() below skips its
    // own network fetch (and the paintedShotId guard skips the redraw too).
    if (fastShot && shots.length > 0 && shots[0].id === fastShot.id) {
        shots = historyPager.update(fastShot);
    }

    if (shots.length > 0) {
        displayShot(0);
    } else {
        chart.clearChart();
        clearShotData();
    }
}

export function getNewestShotId() {
    return shots[0]?.id ?? null;
}

// After a shot finishes, REA can take several seconds to persist it to /shots.
// A single fixed-delay reload races that write and silently shows the previous
// shot. Poll the list until a shot newer than `knownNewestId` appears, then
// render it. ponytail: fixed retry budget, not a server-side watcher.
export async function refreshToNewestShot(knownNewestId, tries = 6, intervalMs = 2000, expectedId = null) {
    for (let i = 0; i < tries; i++) {
        await loadShotHistory();
        // Success = the expected shot id is on top (exact, from the shotState
        // feed) — or, without one, any id newer than what we knew before.
        if (shots.length > 0 && (expectedId ? shots[0].id === expectedId : shots[0].id !== knownNewestId)) {
            await displayShot(0); // labels itself NEWEST
            return;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    // Gave up waiting — show whatever is newest so the panel isn't left stale.
    if (shots.length > 0) displayShot(0);
}

export async function clearShotHistory() {
    try {
        await openDB();
        await clearShots();
        shots = [];
        historyHasMore = false;
        logger.info('Shot history cleared.');
        await loadShotHistory();
        if (shots.length > 0) {
            displayShot(0);
        } else {
            chart.clearChart();
            clearShotData();
            const dateEl = document.getElementById('history-date');
            const profileNameEl = document.getElementById('history-profile-name');
            if (dateEl) dateEl.textContent = '';
            if (profileNameEl) profileNameEl.textContent = '';
            document.getElementById('history-prev-btn')?.classList.add('invisible');
            document.getElementById('history-next-btn')?.classList.add('invisible');
        }
    } catch (error) {
        logger.error('Error clearing shot history:', error);
    }
}

export async function updateShot(id, updates) {
    const response = await fetch(`${API_BASE_URL}/shots/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const updated = await response.json();
    const idx = shots.findIndex(s => s.id === id);
    if (idx !== -1) {
        shots = historyPager.update({ ...shots[idx], ...updated });
        await addShots([shots.find(shot => shot.id === id)]);
    }
    return updated;
}

export async function deleteCurrentShot() {
    const shot = shots[currentShotIndex];
    const response = await fetch(`${API_BASE_URL}/shots/${shot.id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    await idbDeleteShot(shot.id);
    shots = historyPager.remove(shot.id);
    if (shots.length === 0) {
        chart.clearChart();
        clearShotData();
        document.getElementById('history-prev-btn')?.classList.add('invisible');
        document.getElementById('history-next-btn')?.classList.add('invisible');
    } else {
        displayShot(Math.min(currentShotIndex, shots.length - 1));
    }
}
