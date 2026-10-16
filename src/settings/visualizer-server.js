export const DEFAULT_VISUALIZER_SERVER_URL = 'https://visualizer.coffee';

/**
 * Return the canonical base URL used by the Visualizer plugin.
 *
 * A path prefix is intentional: installations behind a reverse proxy can use
 * e.g. https://coffee.example/visualizer. Query strings, fragments, embedded
 * credentials, dot segments and backslashes are rejected so the same value can
 * safely be used for every Visualizer request. HTTP is allowed for local/LAN
 * self-hosting; the settings page explains that it sends credentials and shot
 * data without transport encryption.
 */
export function normalizeVisualizerServerUrl(value) {
    const raw = String(value ?? '');
    if (!raw) return DEFAULT_VISUALIZER_SERVER_URL;
    if (/\s|\\/.test(raw)) throw new Error('Visualizer server URL cannot contain whitespace or backslashes');

    const authorityEnd = raw.search(/[/?#]/);
    const pathAndQuery = authorityEnd < 0 ? '' : raw.slice(authorityEnd);
    if (/(^|\/)\.{1,2}(?=\/|$)/.test(pathAndQuery) || /%2e/i.test(pathAndQuery)) {
        throw new Error('Visualizer server URL cannot contain dot path segments');
    }

    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('Enter a complete HTTP or HTTPS Visualizer server URL');
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
        throw new Error('Visualizer server URL must use HTTP or HTTPS without credentials, queries, or fragments');
    }

    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
}

export function isInsecureVisualizerServerUrl(value) {
    try {
        return normalizeVisualizerServerUrl(value).startsWith('http://');
    } catch {
        return false;
    }
}

export function visualizerServerUrlsEqual(left, right) {
    try {
        return normalizeVisualizerServerUrl(left) === normalizeVisualizerServerUrl(right);
    } catch {
        return false;
    }
}

// Compatibility API for visualizer.js and older callers. The URL policy above
// remains the single implementation; these adapters preserve the original
// result shape while the settings page uses the stricter normalizer directly.
export const VISUALIZER_DEFAULT_SERVER = DEFAULT_VISUALIZER_SERVER_URL;
export const VISUALIZER_SERVER_SETTING = 'ServerUrl';

export function normalizeServerUrl(input) {
    try {
        return { ok: true, url: normalizeVisualizerServerUrl(String(input ?? '').trim()) };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

export function isDefaultServer(url) {
    return url === VISUALIZER_DEFAULT_SERVER;
}

export function pluginSupportsCustomServer(plugin) {
    const schema = plugin?.settings;
    return !!schema && typeof schema === 'object' && VISUALIZER_SERVER_SETTING in schema;
}

export function planServerChange({ input, activeUrl, supported }) {
    const n = normalizeServerUrl(input);
    if (!n.ok) return { state: 'invalid', error: n.error };
    if (!supported && !isDefaultServer(n.url)) {
        return { state: 'unsupported', url: n.url, error: 'This Decaid version only supports visualizer.coffee. Update Decaid to use another server.' };
    }
    return { state: n.url === activeUrl ? 'same' : 'changed', url: n.url };
}
