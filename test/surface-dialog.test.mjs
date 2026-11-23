import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class Element extends EventTarget {
    constructor(tag, document) {
        super();
        this.tag = tag;
        this.document = document;
        this.attributes = {};
        this.hidden = false;
        this.isConnected = false;
        this.nodes = {};
        this.dataset = {};
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    focus() { this.document.activeElement = this; }
    remove() { this.isConnected = false; this.removed = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent(new Event('close')); }
    querySelector(selector) { return this.nodes[selector]; }
    querySelectorAll(selector) { return this.nodes[`all:${selector}`] ?? []; }
    set innerHTML(html) {
        const node = tag => new Element(tag, this.document);
        const links = [node('a'), node('a')];
        this.nodes = {
            '.surface-dialog-frame': node('iframe'),
            '.surface-dialog-close': node('button'),
            '.surface-dialog-title': node('h2'),
            '.surface-dialog-error': node('div'),
            '.surface-dialog-hint': node('p'),
            '[data-label]': node('span'),
            '[data-message]': node('p'),
            '[data-hint]': node('span'),
            'all:[data-open]': links,
        };
        for (const child of Object.values(this.nodes).flat()) child.isConnected = true;
        this.nodes['.surface-dialog-error'].hidden = html.includes('surface-dialog-error" role="alert" hidden');
        this.html = html;
    }
}

function harness({ available = true, theme = 'dark' } = {}) {
    const timers = new Map();
    let nextTimer = 0;
    const probes = [];
    const document = {
        activeElement: null,
        documentElement: { getAttribute: name => (name === 'data-theme' ? theme : null) },
        body: {
            appendChild(child) {
                child.isConnected = true;
                const frame = child.querySelector('.surface-dialog-frame');
                if (frame && !frame.src) frame.dispatchEvent(new Event('load'));
            },
        },
        createElement(tag) { return new Element(tag, document); },
    };
    const opener = new Element('button', document);
    opener.isConnected = true;
    opener.focus();
    const deps = {
        document,
        setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
        clearTimeout: id => timers.delete(id),
        getTranslation: key => key,
        logger: { warn() {} },
        loadStyle: async () => {},
        isPageAvailable: (url, signal) => new Promise(resolve => probes.push({ url, signal, resolve: () => resolve(available) })),
    };
    const source = readFileSync(new URL('../src/modules/surface-dialog.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const api = new Function(...Object.keys(deps), `${source}\nreturn { openSurfaceDialog, closeSurfaceDialog, isSurfaceDialogOpen };`)(...Object.values(deps));
    return {
        ...api, document, opener, probes,
        timeout() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
        get pendingTimers() { return timers.size; },
    };
}

const HREF = 'http://tablet:8080/api/v1/plugins/grinder-plugin/diagnostics?ui=1&deviceId=grinder-1';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('opens the page in a modal dialog with focus on Close', async () => {
    const h = harness();
    const dialog = await h.openSurfaceDialog(HREF, 'Diagnostics');
    assert.equal(dialog.open, true);
    assert.equal(dialog.open, true, 'showModal: the native dialog is modal and labelled');
    assert.equal(dialog.attributes.role, undefined);
    assert.equal(dialog.attributes['aria-labelledby'], 'surface-dialog-title');
    assert.equal(dialog.querySelector('.surface-dialog-title').textContent, 'Diagnostics');
    assert.equal(dialog.querySelector('.surface-dialog-frame').src, `${HREF}&embed=1&theme=dark`, 'the page is told to embed and follow the theme');
    assert.equal(h.probes[0].url, HREF);
    assert.match(dialog.html, /sandbox="allow-scripts allow-same-origin allow-forms"/);
    assert.equal(h.document.activeElement, dialog.querySelector('.surface-dialog-close'));
    assert.equal(dialog.querySelector('[data-label]').textContent, 'Close');
    for (const link of dialog.querySelectorAll('[data-open]')) assert.equal(link.href, HREF);
    assert.equal(h.isSurfaceDialogOpen(), true);
    assert.equal(dialog.dataset.keyboardFit, '1');
    assert.equal(h.pendingTimers, 1, 'an about:blank load on insertion must not stop the load timeout');
});

test('Close removes the dialog, stops the probe and gives focus back', async () => {
    const h = harness();
    const dialog = await h.openSurfaceDialog(HREF, 'Diagnostics');
    dialog.querySelector('.surface-dialog-close').dispatchEvent(new Event('click'));
    assert.equal(dialog.removed, true);
    assert.equal(dialog.open, false);
    assert.equal(h.probes[0].signal.aborted, true);
    assert.equal(h.pendingTimers, 0);
    assert.equal(h.document.activeElement, h.opener);
    assert.equal(h.isSurfaceDialogOpen(), false);
});

test('Escape (the dialog\'s own close) and a backdrop tap close it; a tap inside does not', async () => {
    const h = harness();
    let dialog = await h.openSurfaceDialog(HREF, 'Settings');
    dialog.close();
    assert.equal(dialog.removed, true);
    assert.equal(h.document.activeElement, h.opener);

    dialog = await h.openSurfaceDialog(HREF, 'Settings');
    const inside = dialog.querySelector('.surface-dialog-title');
    dialog.dispatchEvent(Object.defineProperty(new Event('click'), 'target', { value: inside }));
    assert.equal(dialog.open, true);
    dialog.dispatchEvent(new Event('click'));
    assert.equal(dialog.removed, true);
});

test('a page that answers with an error shows the error, Close and Open anyway -- never a blank frame', async () => {
    const h = harness({ available: false });
    const dialog = await h.openSurfaceDialog(HREF, 'Diagnostics');
    h.probes[0].resolve();
    await settle();
    assert.equal(dialog.querySelector('.surface-dialog-frame').removed, true);
    assert.equal(dialog.querySelector('.surface-dialog-error').hidden, false);
    assert.equal(dialog.querySelector('[data-message]').textContent, 'Could not load this page.');
    assert.equal(dialog.querySelectorAll('[data-open]')[0].textContent, 'Open anyway');
    assert.equal(dialog.open, true);
});

test('a frame that never loads turns into the error; one that loads does not', async () => {
    let h = harness();
    let dialog = await h.openSurfaceDialog(HREF, 'Diagnostics');
    h.timeout();
    assert.equal(dialog.querySelector('.surface-dialog-error').hidden, false);
    assert.equal(dialog.querySelector('.surface-dialog-hint').hidden, true);

    h = harness();
    dialog = await h.openSurfaceDialog(HREF, 'Diagnostics');
    dialog.querySelector('.surface-dialog-frame').dispatchEvent(new Event('load'));
    assert.equal(h.pendingTimers, 0);
    assert.equal(dialog.querySelector('.surface-dialog-error').hidden, true);
});

test('a dialog closed while its stylesheet loads is never shown', async () => {
    const h = harness();
    const pending = h.openSurfaceDialog(HREF, 'Diagnostics');
    h.closeSurfaceDialog();
    const dialog = await pending;
    assert.equal(dialog.open, undefined);
    assert.equal(h.probes.length, 0);
    assert.equal(h.isSurfaceDialogOpen(), false);
});

test('the error never lands on a dialog that was already closed', async () => {
    const h = harness({ available: false });
    const dialog = await h.openSurfaceDialog(HREF, 'Diagnostics');
    h.closeSurfaceDialog();
    h.probes[0].resolve();
    await settle();
    assert.equal(dialog.querySelector('.surface-dialog-frame').removed, undefined);
});

test('opening a second page closes the first', async () => {
    const h = harness();
    const first = await h.openSurfaceDialog(HREF, 'Diagnostics');
    const second = await h.openSurfaceDialog(`${HREF}&x=1`, 'Settings');
    assert.equal(first.removed, true);
    assert.equal(second.open, true);
    assert.equal(h.isSurfaceDialogOpen(), true);
});

test('a probe that cannot reach the page (CORS, network) keeps the frame; the load timeout decides', async () => {
    const h = harness({ available: null });
    const dialog = await h.openSurfaceDialog(HREF, 'Diagnostics');
    h.probes[0].resolve();
    await settle();
    assert.equal(dialog.querySelector('.surface-dialog-error').hidden, true);
    assert.equal(dialog.querySelector('.surface-dialog-frame').removed, undefined);
    assert.equal(h.pendingTimers, 1);
});

test('the light theme reaches the page; Open anyway keeps the plain page URL', async () => {
    const h = harness({ theme: 'light' });
    const dialog = await h.openSurfaceDialog(HREF, 'Settings');
    assert.equal(dialog.querySelector('.surface-dialog-frame').src, `${HREF}&embed=1&theme=light`);
    for (const link of dialog.querySelectorAll('[data-open]')) assert.equal(link.href, HREF);
});

test('focus returns to the re-rendered opener when the original button is gone', async () => {
    const h = harness();
    const replacement = new Element('button', h.document);
    const dialog = await h.openSurfaceDialog(HREF, 'Settings', () => replacement);
    h.opener.isConnected = false;
    dialog.close();
    assert.equal(h.document.activeElement, replacement);
});
