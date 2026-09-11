const pageCache = new Map();
let cleanupCurrentPage = null;

function getCleanUrl(pageUrl) {
    const filename = pageUrl.split('/').pop().replace('.html', '');
    return `?page=${filename}`;
}

function getPageUrlFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const page = params.get('page');

    if (!page || page === 'index') {
        return null;
    }

    const pageMap = {
        'settings': 'src/settings/settings.html',
        'profile_selector': 'src/profiles/profile_selector.html',
        'profile_editor': 'src/profiles/profile_editor.html',
    };
    return pageMap[page] || null;
}

export function isSubPage() {
    return getPageUrlFromQuery() !== null;
}

export async function initRouter() {
    const pageUrl = getPageUrlFromQuery();
    if (pageUrl) {
        await loadPage(pageUrl, { history: 'replace' });
    } else {
        updateHistory('replace', { pageUrl: null }, 'Streamline', '?page=index');
    }
}

window.addEventListener('popstate', async (event) => {
    if (event.state && event.state.pageUrl) {
        await loadPage(event.state.pageUrl, { history: 'none' });
    } else {
        await showMainPage({ history: 'none' });
    }
});

async function fetchPage(url) {
    if (pageCache.has(url)) {
        return pageCache.get(url);
    }
    const request = fetch(url).then(async response => {
        if (!response.ok) {
            throw new Error(`Failed to fetch page: ${response.statusText}`);
        }
        return response.text();
    }).catch(error => {
        pageCache.delete(url);
        throw error;
    });
    pageCache.set(url, request);
    return request;
}

export function prefetchSettingsPage() {
    return Promise.all([
        fetchPage('src/settings/settings.html'),
        import('../settings/settings-shell.js')
    ]);
}

function isIndexUrl(pageUrl) {
    if (!pageUrl) return true;
    const lc = pageUrl.toLowerCase();
    return lc === 'index.html' || lc === '/' || lc === '' || lc.endsWith('/index.html');
}

async function cleanupSubpage() {
    cleanupCurrentPage?.();
    cleanupCurrentPage = null;
    const root = document.getElementById('subpage-host');
    if (!root?.children.length) return;
    const { cleanupSubpageChart } = await import('./chart.js');
    cleanupSubpageChart(root);
}

function updateHistory(mode, state, title, url) {
    if (mode === 'push') window.history.pushState(state, title, url);
    if (mode === 'replace') window.history.replaceState(state, title, url);
}

async function showMainPage({ history = 'push' } = {}) {
    const mainPage = document.getElementById('main-page');
    const subpageHost = document.getElementById('subpage-host');

    if (subpageHost) {
        await cleanupSubpage();
        subpageHost.style.display = 'none';
        subpageHost.innerHTML = '';
    }
    if (mainPage) mainPage.style.display = '';

    const scaledContent = document.getElementById('scaled-content');
    if (scaledContent) scaledContent.classList.add('scaled');

    // Force rescale — keyboard use on the previous page may have left a stale transform
    window.dispatchEvent(new Event('resize'));

    updateHistory(history, { pageUrl: null }, 'Streamline', '?page=index');

    // The profile selector shares the `plotly-chart` id and leaves its last
    // plotted profile curve on the element — blank it immediately so that
    // curve doesn't sit on screen for the duration of the async history
    // repaint below. Skipped during a live shot; the websocket is already
    // driving the chart and a blank flash would just fight it.
    if (!window.app?.isShotActive?.()) {
        window.app?.clearChart?.();
    }
    document.dispatchEvent(new Event('streamline:mainpagevisible'));

    // Ensure main-page data init has run — booting on a sub-page URL skips it,
    // so without this the main page would render static HTML with no data.
    // Don't gate the chart repaint on this whole thing finishing though: it
    // also connects DE1/scale/visualizer and six-plus websockets, none of
    // which the chart needs, and blocking on all of it is what made the
    // repaint (and the stale profile curve before it) take 1-2s on first
    // return to the main page.
    if (window.app?.initMainPageOnce) {
        window.app.initMainPageOnce().catch(e => console.error('initMainPageOnce error:', e));
    }

    // Repaint the current history shot as soon as its data alone is ready
    // (unless a shot is live, in which case the websocket already drives the
    // chart) — independent of the rest of initMainPageOnce above.
    if (!window.app?.isShotActive?.()) {
        window.app?.historyReady?.()
            .then(() => import('./history.js').then(m => m.refreshCurrentShot?.()))
            .catch(e => console.error('history repaint error:', e));
    }

    // Re-render favorite buttons now that they're visible — avoids stale font-size
    // from any updateButtonUI calls that fired while #main-page was display:none.
    import('./profileManager.js').then(m => {
        if (m.updateButtonUI) m.updateButtonUI();
    }).catch(() => {});
}

export async function loadPage(pageUrl, { history = 'push' } = {}) {
    if (isIndexUrl(pageUrl)) {
        await showMainPage({ history });
        return;
    }

    const mainPage = document.getElementById('main-page');
    const subpageHost = document.getElementById('subpage-host');

    try {
        const pageHtml = await fetchPage(pageUrl);
        const parser = new DOMParser();
        const doc = parser.parseFromString(pageHtml, 'text/html');
        const newContent = doc.querySelector('#scaled-content');

        if (!newContent || !subpageHost) {
            console.error('Could not find content to load.');
            if (mainPage) mainPage.style.display = '';
            return;
        }

        await cleanupSubpage();
        subpageHost.innerHTML = newContent.innerHTML;

        if (pageUrl.includes('settings.html')) {
            const { cleanupSettingsShell, initializeSettingsShell } = await import('../settings/settings-shell.js');
            await initializeSettingsShell();
            cleanupCurrentPage = cleanupSettingsShell;
        }

        if (mainPage) mainPage.style.display = 'none';
        subpageHost.style.display = '';

        // Apply current language to freshly injected HTML before page init runs
        import('./i18n.js').then(m => m.translatePage()).catch(() => {});

        const cleanUrl = getCleanUrl(pageUrl);
        updateHistory(history, { pageUrl }, cleanUrl.split('/').pop() || 'Streamline', cleanUrl);

        await new Promise(resolve => requestAnimationFrame(resolve));

        const scaledContent = document.getElementById('scaled-content');
        if (scaledContent) scaledContent.classList.add('scaled');

        if (pageUrl.includes('profile_selector.html')) {
            try {
                const { initializeProfileSelector } = await import('./profile_selector.js');
                if (initializeProfileSelector) {
                    initializeProfileSelector().catch(e => console.error('Router: Profile selector init error:', e));
                }
            } catch (e) {
                console.error('Router: Error initializing profile selector:', e);
            }
        } else if (pageUrl.includes('profile_editor.html')) {
            try {
                const { initializeProfileEditor } = await import('./profile_editor.js');
                if (initializeProfileEditor) await initializeProfileEditor();
            } catch (e) {
                console.error('Router: Error initializing profile editor:', e);
            }
        }
    } catch (error) {
        console.error('Error loading page:', error);
        if (mainPage) mainPage.style.display = '';
        if (subpageHost) subpageHost.style.display = 'none';
    }
}
