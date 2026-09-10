// LED 16-bit↔8-bit colour maps — the skin half of the shared channel
// convention (byte-replicate up, high byte down; malformed input → black).
// These lock spec invariant I1: the 8→16→8 round trip is lossless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { led8to16, ledRgbToColor16, ledColor16ToHex8, ledHexToRgb, ledPreviewComposite, ledLiveWriteState } from '../src/modules/led-color.js';

test('led8to16 byte-replicates the 8-bit value up', () => {
    assert.equal(led8to16(0x00), '0000');
    assert.equal(led8to16(0x05), '0505');
    assert.equal(led8to16(0xAB), 'ABAB');
    assert.equal(led8to16(0xFF), 'FFFF');
});

test('ledRgbToColor16 packs RRRRGGGGBBBB uppercase', () => {
    assert.equal(ledRgbToColor16({ r: 0xFF, g: 0xAA, b: 0x55 }), 'FFFFAAAA5555'); // = LED_DEFAULT_ON warm white
    assert.equal(ledRgbToColor16({ r: 0, g: 0, b: 0 }), '000000000000');
    assert.equal(ledRgbToColor16({ r: 0x38, g: 0x5A, b: 0x92 }), '38385A5A9292');
});

test('ledColor16ToHex8 takes the HIGH byte of each channel', () => {
    assert.equal(ledColor16ToHex8('FFFFAAAA5555'), '#FFAA55');
    assert.equal(ledColor16ToHex8('FFFE00010002'), '#FF0000'); // low bytes ignored
    assert.equal(ledColor16ToHex8('12ff34ff56ff'), '#123456'); // case-insensitive in, uppercase out
    assert.equal(ledColor16ToHex8('000000000000'), '#000000');
});

test('ledColor16ToHex8 maps malformed input to black', () => {
    for (const bad of [undefined, null, '', 'FFFF', 'GGGGGGGGGGGG', 'FFFFAAAA555', 'FFFFAAAA55550', ' FFFFAAAA5555']) {
        assert.equal(ledColor16ToHex8(bad), '#000000');
    }
});

test('ledHexToRgb parses #RRGGBB (hash optional); invalid → black', () => {
    assert.deepEqual(ledHexToRgb('#FFAA55'), { r: 255, g: 170, b: 85 });
    assert.deepEqual(ledHexToRgb('ffaa55'), { r: 255, g: 170, b: 85 });
    assert.deepEqual(ledHexToRgb('#FA5'), { r: 0, g: 0, b: 0 });
    assert.deepEqual(ledHexToRgb(''), { r: 0, g: 0, b: 0 });
    assert.deepEqual(ledHexToRgb(null), { r: 0, g: 0, b: 0 });
});

test('8 -> 16 -> 8 round trip is lossless for every channel value', () => {
    for (let v = 0; v <= 255; v++) {
        const rgb = { r: v, g: 255 - v, b: (v * 7) % 256 };
        const c16 = ledRgbToColor16(rgb);
        assert.deepEqual(ledHexToRgb(ledColor16ToHex8(c16)), rgb);
    }
});

test('preset hex -> 16-bit -> hex round trip preserves the swatch colour', () => {
    // The presets rendered on the Lighting page survive the wire format intact.
    const presets = ['#000000', '#FFAA55', '#FFD9A0', '#EAF2FF', '#385A92',
        '#FF7A00', '#FF2200', '#0CA581', '#00C2D1', '#7A3FF2'];
    for (const hex of presets) {
        assert.equal(ledColor16ToHex8(ledRgbToColor16(ledHexToRgb(hex))), hex.toUpperCase());
    }
});

// ── ledPreviewComposite ─────────────────────────────────────────────────────
// The live-preview payload: edited zones show the bank being edited, all
// other zones the bank the machine is rendering. This is what keeps a
// cross-state preview steady on the edited zone while the rest of the
// machine keeps its real colours.

const PALETTE = {
    frontStrip: { awake: 'AAAA00000000', sleeping: '000000001111' },
    backStrip:  { awake: '0000BBBB0000', sleeping: '000000002222' },
    frontSwitch: { awake: 'AAAA00000000', sleeping: '000000001111' },
};

test('composite: cross-state edit shows the edited bank on edited zones only', () => {
    // Editing front SLEEPING while the machine renders AWAKE: front previews
    // the sleep colour, rear keeps showing its real awake colour.
    assert.deepEqual(
        ledPreviewComposite(PALETTE, ['frontStrip'], 'sleeping', 'awake'),
        { front: '000000001111', back: '0000BBBB0000' });
    // …and the mirror case on a sleeping machine editing the awake bank.
    assert.deepEqual(
        ledPreviewComposite(PALETTE, ['backStrip'], 'awake', 'sleeping'),
        { front: '000000001111', back: '0000BBBB0000' });
});

test('composite: same-state edit degenerates to the machine bank everywhere', () => {
    assert.deepEqual(
        ledPreviewComposite(PALETTE, ['frontStrip'], 'awake', 'awake'),
        { front: 'AAAA00000000', back: '0000BBBB0000' });
});

test('composite: editing Both zones previews the edited bank on both strips', () => {
    assert.deepEqual(
        ledPreviewComposite(PALETTE, ['frontStrip', 'backStrip'], 'sleeping', 'awake'),
        { front: '000000001111', back: '000000002222' });
});

test('composite: the front-switch zone has no strip of its own', () => {
    // Editing the switch (mirrors the front strip in FW) previews nothing new:
    // both strips keep the machine bank.
    assert.deepEqual(
        ledPreviewComposite(PALETTE, ['frontSwitch'], 'sleeping', 'awake'),
        { front: 'AAAA00000000', back: '0000BBBB0000' });
});

test('composite: missing palette entries read as black', () => {
    assert.deepEqual(
        ledPreviewComposite({}, ['frontStrip'], 'sleeping', 'awake'),
        { front: '000000000000', back: '000000000000' });
    assert.deepEqual(
        ledPreviewComposite(null, [], 'awake', 'awake'),
        { front: '000000000000', back: '000000000000' });
});

// ── ledLiveWriteState ────────────────────────────────────────────────────
// The payload that actually reaches the machine. There is no preview endpoint:
// a live colour is a PUT into the bank the firmware is rendering, so these
// tests lock the two properties that keep that from destroying the palette --
// the other bank is carried through untouched, and the switch mirrors front.

test('live write: the colour lands in the bank the machine is rendering', () => {
    const out = ledLiveWriteState(PALETTE, 'FFFF00000000', '0000FFFF0000', 'awake');
    assert.equal(out.frontStrip.awake, 'FFFF00000000');
    assert.equal(out.backStrip.awake, '0000FFFF0000');
});

test('live write: the bank the machine is NOT rendering is preserved', () => {
    // This is what makes a live write survivable: the half of the palette the
    // user cannot see is never touched, so a restore only has to undo one bank.
    const out = ledLiveWriteState(PALETTE, 'FFFF00000000', '0000FFFF0000', 'awake');
    assert.equal(out.frontStrip.sleeping, '000000001111');
    assert.equal(out.backStrip.sleeping, '000000002222');
});

test('live write: painting while the machine sleeps targets the sleeping bank', () => {
    const out = ledLiveWriteState(PALETTE, 'FFFF00000000', '0000FFFF0000', 'sleeping');
    assert.equal(out.frontStrip.sleeping, 'FFFF00000000');
    assert.equal(out.backStrip.sleeping, '0000FFFF0000');
    assert.equal(out.frontStrip.awake, 'AAAA00000000'); // awake bank untouched
    assert.equal(out.backStrip.awake, '0000BBBB0000');
});

test('live write: frontSwitch mirrors the front strip, never an independent value', () => {
    // The firmware derives the HV switch colours from the front strip and the
    // server ignores frontSwitch on write; sending anything else is a lie.
    const out = ledLiveWriteState(PALETTE, 'FFFF00000000', '0000FFFF0000', 'awake');
    assert.deepEqual(out.frontSwitch, out.frontStrip);
});

test('live write: an unrecognised bank is treated as awake', () => {
    // ledMachinePaletteState() only ever yields 'awake' for a state it does not
    // recognise; make sure a stray value cannot write the sleeping bank.
    const out = ledLiveWriteState(PALETTE, 'FFFF00000000', '0000FFFF0000', undefined);
    assert.equal(out.frontStrip.awake, 'FFFF00000000');
    assert.equal(out.frontStrip.sleeping, '000000001111');
});

test('live write: missing palette/colours read as black rather than undefined', () => {
    const out = ledLiveWriteState(null, null, undefined, 'awake');
    assert.deepEqual(out, {
        frontStrip: { awake: '000000000000', sleeping: '000000000000' },
        backStrip: { awake: '000000000000', sleeping: '000000000000' },
        frontSwitch: { awake: '000000000000', sleeping: '000000000000' },
    });
});

test('live write: a composite feeds straight into the payload', () => {
    // The Lighting page's cross-state preview path end to end: compose what the
    // user should see, then write it into the bank the machine renders.
    const { front, back } = ledPreviewComposite(PALETTE, ['frontStrip'], 'sleeping', 'awake');
    const out = ledLiveWriteState(PALETTE, front, back, 'awake');
    assert.equal(out.frontStrip.awake, '000000001111');    // the sleep colour, shown now
    assert.equal(out.backStrip.awake, '0000BBBB0000');     // rear keeps its real colour
    assert.equal(out.frontStrip.sleeping, '000000001111'); // stored sleep colour intact
});
