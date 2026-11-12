import { timeNav } from './perf-probe.js';

const pageCache = new Map();
let cleanupCurrentPage = null;
// Where the user currently is and where they came from, so a subpage can send
// them back instead of to a fixed destination (the profile editor's save and
// cancel). null is the main page.
let currentPageUrl = null;
let previousPageUrl = null;

export function getPreviousPageUrl() {
    return previousPageUrl;
}

function markCurrentPage(pageUrl) {
    if (pageUrl === currentPageUrl) return;
    previousPageUrl = currentPageUrl;
    currentPageUrl = pageUrl;
}

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

// The three subpage entry modules, none of which prefetchSettingsPage reaches:
// settings.js is behind categories/legacy-category.js, and the profile pages are
// imported by the router only once a tap has already happened. Unminified they
// are 653K / 194K / 93K, so a cold tap pays the whole fetch+parse+compile.
//
// ponytail: modulepreload rather than import() -- the link downloads, parses and
// compiles the module graph WITHOUT evaluating any of it, so warming these
// cannot run a line of their top-level code early. A real import() here would.
const WARM_MODULES = [
    'src/settings/settings.js',
    'src/modules/profile_editor.js',
    'src/modules/profile_selector.js',
];

let warmed = false;
export function prefetchSubpages() {
    if (warmed) return;
    warmed = true;
    // requestIdleCallback is absent on iOS/older Safari WebViews (dual target),
    // so fall back to a plain timer well clear of boot.
    const idle = window.requestIdleCallback
        ? (fn) => window.requestIdleCallback(fn, { timeout: 5000 })
        : (fn) => setTimeout(fn, 3000);
    idle(() => {
        for (const href of WARM_MODULES) {
            const link = document.createElement('link');
            link.rel = 'modulepreload';
            link.href = href;
            document.head.append(link);
        }
        // Page HTML is a plain fetch into the router's own cache -- no execution.
        fetchPage('src/settings/settings.html').catch(() => {});
        fetchPage('src/profiles/profile_selector.html').catch(() => {});
        fetchPage('src/profiles/profile_editor.html').catch(() => {});
    });
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
    const nav = timeNav('main');
    const mainPage = document.getElementById('main-page');
    const subpageHost = document.getElementById('subpage-host');

    if (subpageHost) {
        await cleanupSubpage();
        subpageHost.style.display = 'none';
        subpageHost.innerHTML = '';
    }
    nav.mark('cleanup');
    if (mainPage) mainPage.style.display = '';

    const scaledContent = document.getElementById('scaled-content');
    if (scaledContent) scaledContent.classList.add('scaled');

    // Force rescale — keyboard use on the previous page may have left a stale transform
    window.dispatchEvent(new Event('resize'));

    markCurrentPage(null);
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
    // The work below is deliberately not awaited, so this is the point the user
    // sees the main page again -- which is what the line is measuring.
    nav.done();

    // Ensure main-page data init has run — booting on a sub-page URL skips it,
    // so without this the main page would render static HTML with no data.
    // Don't gate the chart repaint on this whole thing finishing though: it
    // also connects DE1/scale and six-plus websockets, none of
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

    const pageName = pageUrl.split('/').pop().replace('.html', '');
    const nav = timeNav(pageName);
    const mainPage = document.getElementById('main-page');
    const subpageHost = document.getElementById('subpage-host');
    let hidMainPage = false;

    try {
        const pageHtml = await fetchPage(pageUrl);
        nav.mark('fetch');
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
        nav.mark('inject');

        if (pageUrl.includes('settings.html')) {
            const { cleanupSettingsShell, initializeSettingsShell } = await import('../settings/settings-shell.js');
            await initializeSettingsShell();
            cleanupCurrentPage = cleanupSettingsShell;
            nav.mark('shell');
        }

        const mainPageWasVisible = mainPage && mainPage.style.display !== 'none';
        if (mainPage) mainPage.style.display = 'none';
        if (mainPageWasVisible) {
            hidMainPage = true;
            document.dispatchEvent(new Event('streamline:mainpagehidden'));
        }
        subpageHost.style.display = '';

        // Apply current language to freshly injected HTML before page init runs
        // Its own line, not a mark on the one above: the call is deliberately
        // fire-and-forget, and its microtask lands after the frame wait below.
        import('./i18n.js').then(m => {
            const translate = timeNav(`${pageName}:translate`);
            m.translatePage();
            translate.done();
        }).catch(() => {});

        const cleanUrl = getCleanUrl(pageUrl);
        // Before the page's own init runs below -- the profile editor reads
        // getPreviousPageUrl() there to decide where Save/Cancel return to.
        markCurrentPage(pageUrl);
        updateHistory(history, { pageUrl }, cleanUrl.split('/').pop() || 'Streamline', cleanUrl);

        await new Promise(resolve => requestAnimationFrame(resolve));
        nav.mark('paint');

        const scaledContent = document.getElementById('scaled-content');
        if (scaledContent) scaledContent.classList.add('scaled');

        if (pageUrl.includes('profile_selector.html')) {
            try {
                const { initializeProfileSelector } = await import('./profile_selector.js');
                if (initializeProfileSelector) {
                    // Its own line: the selector's init is deliberately not
                    // awaited here, so the page is already on screen while it
                    // fills -- two separate waits, not one.
                    const init = timeNav('profile_selector:init');
                    initializeProfileSelector()
                        .then(() => init.done())
                        .catch(e => console.error('Router: Profile selector init error:', e));
                }
            } catch (e) {
                console.error('Router: Error initializing profile selector:', e);
            }
        } else if (pageUrl.includes('profile_editor.html')) {
            try {
                const { initializeProfileEditor, cleanupProfileEditor } = await import('./profile_editor.js');
                if (initializeProfileEditor) await initializeProfileEditor();
                // The CARDS tab's outside-click collapse handler is bound to
                // `document`, so it outlives the innerHTML swap above and has
                // to be torn down explicitly before the next page loads.
                cleanupCurrentPage = cleanupProfileEditor;
            } catch (e) {
                console.error('Router: Error initializing profile editor:', e);
            }
        }
        nav.done();
    } catch (error) {
        console.error('Error loading page:', error);
        if (mainPage) mainPage.style.display = '';
        if (subpageHost) subpageHost.style.display = 'none';
        // Paint writers are gated on this event; without it they stay frozen
        // after a failed subpage load restores the main page.
        if (hidMainPage) document.dispatchEvent(new Event('streamline:mainpagevisible'));
    }
}
