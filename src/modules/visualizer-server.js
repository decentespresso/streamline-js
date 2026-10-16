// Compatibility re-export. Keep one Visualizer URL policy for settings and
// runtime callers; this path remains for existing imports.
export {
    VISUALIZER_DEFAULT_SERVER,
    VISUALIZER_SERVER_SETTING,
    normalizeServerUrl,
    isDefaultServer,
    pluginSupportsCustomServer,
    planServerChange,
} from '../settings/visualizer-server.js';
