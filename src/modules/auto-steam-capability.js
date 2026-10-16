export const AUTO_STEAM_PLUGIN_ID = 'calibrated-steam.reaplugin';

const REQUIRED_HTTP_ENDPOINTS = ['status', 'calculate'];

export function queryAutoSteamCapability(plugins) {
    if (!Array.isArray(plugins)) return { available: false, plugin: null };
    const plugin = plugins.find(candidate => candidate?.id === AUTO_STEAM_PLUGIN_ID) ?? null;
    const endpoints = new Set(Array.isArray(plugin?.api)
        ? plugin.api.filter(endpoint => endpoint?.type === 'http').map(endpoint => endpoint.id)
        : []);
    return {
        available: plugin?.loaded === true && REQUIRED_HTTP_ENDPOINTS.every(endpoint => endpoints.has(endpoint)),
        plugin,
    };
}

export function manualSteamMode({ milkAvailable = false } = {}) {
    return milkAvailable ? 'temperature' : 'time';
}

export function steamModeCycle({ autoAvailable = false, milkAvailable = false } = {}) {
    const manual = manualSteamMode({ milkAvailable });
    return autoAvailable ? [manual, 'auto', 'flow'] : [manual, 'flow'];
}
