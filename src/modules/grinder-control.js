// Grinder control policy: DOM-free so `node --test test/` can import it.
//
// The Bookoo MT80 reaches Decaid through the decaid-bookoo-mt80 plugin, which
// registers it as a *sensor* (device id `plugin:bookoo-mt80.reaplugin:mt80:<id>`),
// not through the generic /grinder API. Everything vendor-specific lives in the
// adapter below, keyed on that id prefix, so the UI can later be pointed at a
// generic grinder API by adding another adapter instead of editing callers.
//
// The MT80 is adjusted by hand: writing `bladeGap` records the grind-size value
// on the device but does NOT move the burr. The UI therefore presents it as a
// recorded value, never as an actuator.

export const MT80_PLUGIN_ID = 'bookoo-mt80.reaplugin';
export const MT80_ID_PREFIX = `plugin:${MT80_PLUGIN_ID}:mt80:`;

// Tile rows, top to bottom: Gap | Feed | Spd.
export const MT80_MODES = ['gap', 'feed', 'spd'];

// Tile row -> sensor channel.
export const MT80_MODE_KEYS = { gap: 'bladeGap', feed: 'feedingRpm', spd: 'grindRpm' };

// Published geneSetting ranges; the device rejects anything outside them.
export const MT80_RANGES = {
    feedingRpm: { min: 10, max: 65, step: 1 },
    grindRpm: { min: 500, max: 1500, step: 10 },
    bladeGap: { min: 0, max: 999, step: 1 },
};

// The 13 sensor channels and their wire types.
const MT80_CHANNEL_TYPES = {
    feedingRpm: 'integer',
    bladeGap: 'integer',
    grindRpm: 'integer',
    humidity: 'integer',
    devState: 'string',
    netState: 'string',
    totalGrinds: 'integer',
    cupDetect: 'boolean',
    autoStop: 'boolean',
    fastClean: 'boolean',
    brightness: 'integer',
    standbySec: 'integer',
    selectPreset: 'integer',
};

function idOf(entry) {
    return typeof entry?.id === 'string' ? entry.id : '';
}

/**
 * Pick the connected MT80 sensor id out of either payload shape:
 *   - the devices feed / GET /devices (`[{ id, type, state, available }]`, or
 *     `{ devices: [...] }` from the WebSocket), or
 *   - GET /sensors (`[{ id, info }]`; presence in the registry means connected).
 * Returns null (never a guessed id) when nothing matches.
 * @returns {string|null}
 */
export function mt80SensorFromList(payload) {
    const list = Array.isArray(payload) ? payload : payload?.devices;
    if (!Array.isArray(list)) return null;
    const match = list.find((entry) => {
        if (!idOf(entry).startsWith(MT80_ID_PREFIX)) return false;
        if (entry.type !== undefined && entry.type !== 'sensor') return false;
        if (entry.state !== undefined && entry.state !== 'connected') return false;
        if (entry.available === false) return false;
        return true;
    });
    return match ? match.id : null;
}

/**
 * Keep only the 13 known channels carrying their declared type. Unknown keys
 * and wrongly typed values (including non-integer numbers on integer channels)
 * are dropped, so a malformed frame can never reach the display.
 * @returns {Record<string, number|string|boolean>}
 */
export function parseMt80Snapshot(frame) {
    const out = {};
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return out;
    for (const [key, type] of Object.entries(MT80_CHANNEL_TYPES)) {
        if (!Object.prototype.hasOwnProperty.call(frame, key)) continue;
        const value = frame[key];
        if (type === 'integer' ? Number.isInteger(value) : typeof value === type) {
            out[key] = value;
        }
    }
    return out;
}

/**
 * The value one +/- tap away from `current`, snapped to the channel's step grid
 * and clamped to its published range. Returns null for an unknown mode, a
 * non-numeric `current`, or a zero direction.
 * @param {'gap'|'feed'|'spd'} mode
 * @param {number} current
 * @param {number} dir  positive = plus, negative = minus
 */
export function nextMt80Value(mode, current, dir) {
    const range = MT80_RANGES[MT80_MODE_KEYS[mode]];
    if (!range || typeof current !== 'number' || !Number.isFinite(current)) return null;
    if (typeof dir !== 'number' || !dir) return null;
    const cells = (Math.round(current) - range.min) / range.step;
    const index = dir > 0 ? Math.floor(cells) + 1 : Math.ceil(cells) - 1;
    const next = range.min + index * range.step;
    return Math.min(range.max, Math.max(range.min, next));
}

/**
 * Body for the sensor `setSettings` command: `{ feedingRpm | grindRpm | bladeGap }`
 * with an integer inside the published range, else null (nothing is sent).
 */
export function mt80SettingsPatch(mode, value) {
    const key = MT80_MODE_KEYS[mode];
    const range = MT80_RANGES[key];
    if (!range || !Number.isInteger(value)) return null;
    if (value < range.min || value > range.max) return null;
    return { [key]: value };
}

const MT80_ADAPTER = {
    vendor: 'bookoo-mt80',
    idPrefix: MT80_ID_PREFIX,
    pluginId: MT80_PLUGIN_ID,
    modes: MT80_MODES,
    modeKeys: MT80_MODE_KEYS,
    ranges: MT80_RANGES,
    sensorFromList: mt80SensorFromList,
    parseSnapshot: parseMt80Snapshot,
    nextValue: nextMt80Value,
    /** @returns {{commandId: string, params: object}|null} */
    writeCommand(mode, value) {
        const params = mt80SettingsPatch(mode, value);
        return params ? { commandId: 'setSettings', params } : null;
    },
};

const GRINDER_ADAPTERS = [MT80_ADAPTER];

/** Adapter owning a sensor id, or null for any other device. */
export function grinderAdapterForId(id) {
    if (typeof id !== 'string') return null;
    return GRINDER_ADAPTERS.find((adapter) => id.startsWith(adapter.idPrefix)) ?? null;
}

/** First connected grinder sensor id across all adapters, or null. */
export function findGrinderSensorId(payload) {
    for (const adapter of GRINDER_ADAPTERS) {
        const id = adapter.sensorFromList(payload);
        if (id) return id;
    }
    return null;
}

/** Whether a device-list entry is a grinder sensor (for the settings page). */
export function isGrinderSensorEntry(entry) {
    return entry?.type === 'sensor' && grinderAdapterForId(idOf(entry)) !== null;
}
