// Visualizer server URL policy: normalization and capability checks.
// DOM-free so node:test can import it. The plugin owns the real validation and
// persistence (Decaid #975); this only decides what the skin offers and sends.

export const VISUALIZER_DEFAULT_SERVER = 'https://visualizer.coffee';

// The plugin setting that carries the server. Absent from an older Decaid's
// manifest, in which case a custom server must not be offered or saved.
export const VISUALIZER_SERVER_SETTING = 'ServerUrl';

/**
 * Normalize a typed server URL to a stable origin + optional path prefix.
 * Empty input means the hosted default. Returns { ok, url } or { ok:false, error }.
 * Equivalent spellings (case, trailing slashes, default port) collapse to one
 * string, so comparing results answers "same server?".
 */
export function normalizeServerUrl(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return { ok: true, url: VISUALIZER_DEFAULT_SERVER };
    let u;
    try {
        u = new URL(raw);
    } catch {
        return { ok: false, error: 'Enter a full address, e.g. https://visualizer.example.com' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return { ok: false, error: 'Server address must start with http:// or https://' };
    }
    if (u.username || u.password) {
        return { ok: false, error: 'Do not put a username or password in the server address' };
    }
    if (u.search || u.hash) {
        return { ok: false, error: 'Server address cannot have a query or fragment' };
    }
    const path = u.pathname.replace(/\/+$/, '');
    return { ok: true, url: `${u.origin}${path}` };
}

export function isDefaultServer(url) {
    return url === VISUALIZER_DEFAULT_SERVER;
}

/** Does the installed plugin (from GET /plugins) expose a server setting? */
export function pluginSupportsCustomServer(plugin) {
    const schema = plugin?.settings;
    return !!schema && typeof schema === 'object' && VISUALIZER_SERVER_SETTING in schema;
}

/**
 * What the form may do for the typed server.
 * - invalid: show the error, block save
 * - unsupported: backend can't honor a non-default server, block save
 * - changed: differs from the active server; credentials must be re-entered
 */
export function planServerChange({ input, activeUrl, supported }) {
    const n = normalizeServerUrl(input);
    if (!n.ok) return { state: 'invalid', error: n.error };
    if (!supported && !isDefaultServer(n.url)) {
        return { state: 'unsupported', url: n.url, error: 'This Decaid version only supports visualizer.coffee. Update Decaid to use another server.' };
    }
    return { state: n.url === activeUrl ? 'same' : 'changed', url: n.url };
}
