// Visualizer upload: the two switches and the one manual action.
//
// The plugin owns a single AutoUpload flag. The skin shows two switches on top
// of it — "Visualizer" (the integration as a whole) and "Auto-upload shots" —
// because a user who wants to pick their shots by hand still wants the plugin
// configured and the manual upload available. The effective plugin flag is the
// AND of the two, so turning Visualizer off can never leave shots uploading.
//
// Manual upload goes to the plugin's own `upload` endpoint, which fetches the
// shot from Decaid by id and pushes it to visualizer.coffee.

import { logger } from './logger.js';

export const VISUALIZER_PLUGIN_ID = 'visualizer.reaplugin';

const ENABLED_KEY = 'visualizerEnabled';
const AUTO_UPLOAD_KEY = 'visualizerAutoUpload';

let api = null; // injected in tests; otherwise api.js, imported lazily

// api.js pulls in the DOM-touching modules — keep this file importable on its own.
async function client() {
    return api ||= await import('./api.js');
}

export function setVisualizerApi(injected) {
    api = injected;
    return () => { api = null; };
}

/** Is the Visualizer integration switched on at all? */
export function isVisualizerEnabled() {
    return localStorage.getItem(ENABLED_KEY) === 'true';
}

/** Should a finished shot upload by itself? Only when both switches allow it. */
export function isAutoUploadEnabled() {
    // The plugin's own AutoUpload default is true, so an unset key means "on".
    return isVisualizerEnabled() && localStorage.getItem(AUTO_UPLOAD_KEY) !== 'false';
}

// The plugin's AutoUpload flag is the AND of both switches.
async function pushAutoUpload() {
    const { setPluginSettings } = await client();
    await setPluginSettings(VISUALIZER_PLUGIN_ID, { AutoUpload: isAutoUploadEnabled() });
}

export async function setVisualizerEnabled(on) {
    localStorage.setItem(ENABLED_KEY, String(!!on));
    await pushAutoUpload();
}

export async function setAutoUpload(on) {
    localStorage.setItem(AUTO_UPLOAD_KEY, String(!!on));
    await pushAutoUpload();
}

/**
 * Upload one shot by id, now, regardless of the auto-upload switch.
 * Resolves with the visualizer.coffee id (or null if the plugin returned none);
 * rejects with the plugin's own message — "too short", bad credentials, offline.
 */
export async function uploadShotToVisualizer(shotId) {
    if (!shotId) throw new Error('No shot to upload');
    const { callPluginEndpoint } = await client();
    const result = await callPluginEndpoint(VISUALIZER_PLUGIN_ID, 'upload', { shotId });
    const visualizerId = result?.visualizer_id ?? null;
    logger.info(`Uploaded shot ${shotId} to Visualizer${visualizerId ? ` → ${visualizerId}` : ''}`);
    return visualizerId;
}
