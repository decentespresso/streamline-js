// LED strip colour maps — the skin half of the 16-bit↔8-bit channel convention
// shared with reaprime and the Bengle firmware: 8-bit UI colours map UP by
// byte-replication (0xAB → 0xABAB) and 16-bit wire colours map DOWN by taking
// the HIGH byte of each channel, so an 8→16→8 round trip is lossless. The wire
// format is a 12-char hex string 'RRRRGGGGBBBB' (16 bit/channel); anything
// malformed reads as black.
//
// DOM-free on purpose so the node:test suite can import it directly
// (test/led-color.test.mjs); the Lighting settings page is the consumer.

/** 8-bit channel value (0–255) → 4-char 16-bit hex, byte-replicated up. */
export const led8to16 = (v) => ((v << 8) | v).toString(16).padStart(4, '0').toUpperCase();

/** iro-style {r,g,b} (0–255 each) → 12-char 'RRRRGGGGBBBB'. */
export const ledRgbToColor16 = ({ r, g, b }) => led8to16(r) + led8to16(g) + led8to16(b);

/** 12-char 'RRRRGGGGBBBB' → '#RRGGBB' (high byte per channel); invalid → black. */
export const ledColor16ToHex8 = (s) => {
    if (!/^[0-9A-Fa-f]{12}$/.test(s || '')) return '#000000';
    const hi = (h) => parseInt(h.slice(0, 2), 16);
    return '#' + [hi(s.slice(0, 4)), hi(s.slice(4, 8)), hi(s.slice(8, 12))]
        .map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
};

/** '#RRGGBB' (leading # optional) → {r,g,b}; invalid → black. */
export const ledHexToRgb = (hex) => {
    const m = /^#?([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex || '');
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 };
};

/**
 * Compose the `{front, back}` payload for a live strip preview: zones being
 * edited show the palette bank being edited, every other zone shows the bank
 * the machine is actually rendering — so a cross-state edit (e.g. the asleep
 * colour while the machine is awake) previews on the edited zone only and
 * the rest of the machine keeps looking normal. When the edited bank IS the
 * machine's bank this degenerates to "everything shows the machine bank",
 * i.e. the pre-existing same-state preview payload.
 * @param {object} palette  LedStripState-shaped map: zoneKey → {awake, sleeping}
 * @param {string[]} editedZoneKeys  zone keys being edited (e.g. ['frontStrip'])
 * @param {'awake'|'sleeping'} editedBank  palette bank being edited
 * @param {'awake'|'sleeping'} machineBank  bank the machine is rendering now
 * @returns {{front:string, back:string}}  12-char colours to drive onto the strip
 */
export const ledPreviewComposite = (palette, editedZoneKeys, editedBank, machineBank) => {
    const pick = (zoneKey) => {
        const bank = editedZoneKeys.includes(zoneKey) ? editedBank : machineBank;
        return palette?.[zoneKey]?.[bank] || '000000000000';
    };
    return { front: pick('frontStrip'), back: pick('backStrip') };
};

/**
 * Compose the full LedStripState to PUT in order to show `front`/`back` on the
 * strip RIGHT NOW.
 *
 * There is no live/preview register on this hardware. The firmware stores one
 * palette — four MMR colour registers, front/rear × awake/sleeping — and
 * renders `zone[bank]`, where `bank` is 'sleeping' only while the machine
 * sleeps and 'awake' in every other state. `PUT /machine/ledStrip` writes those
 * registers straight through, so the ONLY way to drive a colour onto the strip
 * is to write it into the bank the machine is currently rendering. There is no
 * staging step to roll back: whoever writes a live colour is responsible for
 * writing the real palette back afterwards.
 *
 * The bank the machine is NOT rendering is carried through from `basePalette`
 * untouched, so a live write only ever disturbs the half of the palette that is
 * actually visible. `frontSwitch` mirrors the front strip — it is not an
 * independent control (the firmware derives the HV switch colours from the
 * front strip, and the server ignores `frontSwitch` on write).
 *
 * @param {object} basePalette  LedStripState-shaped map to carry the other bank from
 * @param {string} front  12-char colour for the front strip
 * @param {string} back   12-char colour for the rear strip
 * @param {'awake'|'sleeping'} machineBank  bank the machine is rendering now
 * @returns {{frontStrip:object, backStrip:object, frontSwitch:object}} LedStripState to PUT
 */
export const ledLiveWriteState = (basePalette, front, back, machineBank) => {
    const bank = machineBank === 'sleeping' ? 'sleeping' : 'awake';
    const other = bank === 'sleeping' ? 'awake' : 'sleeping';
    const zone = (zoneKey, live) => ({
        [bank]: live || '000000000000',
        [other]: basePalette?.[zoneKey]?.[other] || '000000000000',
    });
    const frontStrip = zone('frontStrip', front);
    return {
        frontStrip,
        backStrip: zone('backStrip', back),
        frontSwitch: { awake: frontStrip.awake, sleeping: frontStrip.sleeping },
    };
};
