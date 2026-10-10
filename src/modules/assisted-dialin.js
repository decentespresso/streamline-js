/**
 * Boundary for launching the optional assisted dial-in plugin.
 *
 * This module deliberately contains no dial-in algorithm. Streamline passes
 * the selected shot to the plugin UI; the plugin owns lookup, comparison,
 * feedback, and recommendation state.
 */
export const ASSISTED_DIALIN_PLUGIN_ID = 'assisted-dialin.reaplugin';

export function findAssistedDialInPlugin(plugins) {
    if (!Array.isArray(plugins)) return null;
    return plugins.find(plugin => (
        plugin?.id === ASSISTED_DIALIN_PLUGIN_ID
        && plugin.loaded === true
        && Array.isArray(plugin.api)
        && plugin.api.some(endpoint => endpoint?.type === 'http' && endpoint?.id === 'ui')
    )) || null;
}

export function buildAssistedDialInUrl(apiBaseUrl, plugin, {
    shotId,
    action = 'analyze',
    returnUrl,
    beanCapture,
} = {}) {
    if (!apiBaseUrl || plugin?.id !== ASSISTED_DIALIN_PLUGIN_ID) return null;
    if (!String(shotId || '').trim()) return null;
    const url = new URL(`${String(apiBaseUrl).replace(/\/$/, '')}/plugins/${encodeURIComponent(plugin.id)}/ui`);
    url.searchParams.set('shotId', String(shotId));
    url.searchParams.set('action', action === 'feedback' ? 'feedback' : 'analyze');
    if (returnUrl) url.searchParams.set('return', String(returnUrl));
    if (beanCapture?.deviceId && beanCapture.role === 'primary' || beanCapture?.deviceId && beanCapture.role === 'auxiliary') {
        url.searchParams.set('beanScaleId', String(beanCapture.deviceId));
        url.searchParams.set('beanScaleRole', String(beanCapture.role));
        url.searchParams.set('beanWeight', String(beanCapture.weight));
        url.searchParams.set('beanCapturedAt', String(beanCapture.capturedAt));
        if (beanCapture.sampleTimestamp) url.searchParams.set('beanSampleTimestamp', String(beanCapture.sampleTimestamp));
    }
    return url.toString();
}
