// Grinder control policy: DOM-free so `node --test test/` can import it.
//
// The Bookoo MT80 reaches Decaid through the decaid-bookoo-mt80 plugin, which
// registers a **grinder** driver (device id `plugin:bookoo-mt80.reaplugin:mt80:<id>`,
// `type: "grinder"`). The snapshot arrives on the generic
// `ws/v1/grinder/snapshot` channel and carries only `{state, setting, rpm}`:
// `setting` is `bladeGap` as a string and `rpm` is `grindRpm`.
//
// `feedingRpm` has no slot in that contract, so the tile's Feed row is a
// placeholder: it renders `--` and cannot be stepped. Feed RPM remains visible
// on the plugin's own control page.
//
// The MT80 is adjusted by hand: writing `bladeGap` records the grind-size value
// on the device but does NOT move the burr. The UI therefore presents it as a
// recorded value, never as an actuator.

export const MT80_PLUGIN_ID = 'bookoo-mt80.reaplugin';
export const MT80_ID_PREFIX = `plugin:${MT80_PLUGIN_ID}:mt80:`;

// Tile rows, top to bottom: Gap | Feed | Spd. Feed is a placeholder: the
// grinder contract has no feed channel, so it always renders `--`.
export const MT80_MODES = ['gap', 'feed', 'spd'];

// Tile row -> the key this module exposes for it. Feeding is genuinely absent
// from the contract rather than merely unknown.
export const MT80_MODE_KEYS = { gap: 'bladeGap', feed: 'feedingRpm', spd: 'grindRpm' };

// Published geneSetting ranges; the device rejects anything outside them.
export const MT80_RANGES = {
    feedingRpm: { min: 10, max: 65, step: 1 },
    grindRpm: { min: 500, max: 1500, step: 10 },
    bladeGap: { min: 0, max: 999, step: 1 },
};

// `setting` arrives as a string on the grinder snapshot and is the only value
// that needs converting. `rpm` is already an integer.
const MT80_SETTING_KEY = 'setting';
const MT80_RPM_KEY = 'rpm';

function idOf(entry) {
    return typeof entry?.id === 'string' ? entry.id : '';
}

/**
 * Pick the connected MT80 grinder id out of the devices feed — either
 * `[{ id, type, state, available }]` or `{ devices: [...] }` from the
 * WebSocket. Returns null (never a guessed id) when nothing matches.
 * @returns {string|null}
 */
export function mt80GrinderFromList(payload) {
    const list = Array.isArray(payload) ? payload : payload?.devices;
    if (!Array.isArray(list)) return null;
    const match = list.find((entry) => {
        if (!idOf(entry).startsWith(MT80_ID_PREFIX)) return false;
        if (entry.type !== undefined && entry.type !== 'grinder') return false;
        if (entry.state !== undefined && entry.state !== 'connected') return false;
        if (entry.available === false) return false;
        return true;
    });
    return match ? match.id : null;
}

/**
 * Map a `ws/v1/grinder/snapshot` frame (`{timestamp, state, setting, rpm}`)
 * onto the tile's channel keys. `setting` is a string and is converted; a
 * missing, empty or non-numeric one leaves `bladeGap` out rather than guessing.
 * `feedingRpm` has no source here, so the Feed row stays empty. Unknown keys and
 * wrongly typed values are dropped, so a malformed frame never reaches the
 * display.
 * @returns {Record<string, number>}
 */
export function parseMt80Snapshot(frame) {
    const out = {};
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return out;
    const setting = frame[MT80_SETTING_KEY];
    if (typeof setting === 'string' && setting.trim() !== '') {
        const gap = Number(setting);
        if (Number.isSafeInteger(gap)) out.bladeGap = gap;
    }
    const rpm = frame[MT80_RPM_KEY];
    if (Number.isInteger(rpm)) out.grindRpm = rpm;
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
 * The grinder write for a stepped row: `{field, value}` naming the field of
 * `PUT /grinder/setting` (a string, as the contract requires) or
 * `PUT /grinder/rpm` (an integer). Returns null for a row the contract cannot
 * write — Feed has no field — or a value outside the published range, so
 * nothing is sent.
 */
export function mt80SettingsPatch(mode, value) {
    if (!Number.isInteger(value)) return null;
    if (mode === 'gap') {
        const { min, max } = MT80_RANGES.bladeGap;
        if (value < min || value > max) return null;
        return { field: 'setting', value: String(value) };
    }
    if (mode === 'spd') {
        const { min, max } = MT80_RANGES.grindRpm;
        if (value < min || value > max) return null;
        return { field: 'rpm', value };
    }
    return null;
}

const MT80_ADAPTER = {
    vendor: 'bookoo-mt80',
    idPrefix: MT80_ID_PREFIX,
    pluginId: MT80_PLUGIN_ID,
    modes: MT80_MODES,
    modeKeys: MT80_MODE_KEYS,
    ranges: MT80_RANGES,
    grinderFromList: mt80GrinderFromList,
    parseSnapshot: parseMt80Snapshot,
    nextValue: nextMt80Value,
    /** @returns {{field: 'setting'|'rpm', value: string|number}|null} */
    writeCommand(mode, value) {
        return mt80SettingsPatch(mode, value);
    },
};

const GRINDER_ADAPTERS = [MT80_ADAPTER];

/** Adapter owning a sensor id, or null for any other device. */
export function grinderAdapterForId(id) {
    if (typeof id !== 'string') return null;
    return GRINDER_ADAPTERS.find((adapter) => id.startsWith(adapter.idPrefix)) ?? null;
}

/** First connected grinder id across all adapters, or null. */
export function findGrinderId(payload) {
    for (const adapter of GRINDER_ADAPTERS) {
        const id = adapter.grinderFromList(payload);
        if (id) return id;
    }
    return null;
}

/** Whether a device-list entry is a grinder this module drives. */
export function isGrinderEntry(entry) {
    return entry?.type === 'grinder' && grinderAdapterForId(idOf(entry)) !== null;
}
