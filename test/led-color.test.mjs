// LED 16-bit↔8-bit colour maps — the skin half of the shared channel
// convention (byte-replicate up, high byte down; malformed input → black).
// These lock spec invariant I1: the 8→16→8 round trip is lossless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { led8to16, ledRgbToColor16, ledColor16ToHex8, ledHexToRgb, ledPreviewComposite, ledLiveWriteState, ledPreviewPayload, ledValueOf, ledWithValue } from '../src/modules/led-color.js';

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

// --- preview payload ------------------------------------------------------
// Preview writes the firmware's live registers and leaves the four stored ones
// alone, so unlike ledLiveWriteState this never carries the untouched half of
// the palette -- it names only what is being edited.

const palette = {
    frontStrip: { awake: 'FFFF00000000', sleeping: '0000FFFF0000' },
    backStrip:  { awake: '00000000FFFF', sleeping: 'FFFFFFFFFFFF' },
    frontSwitch: { awake: 'FFFF00000000', sleeping: '0000FFFF0000' },
};

test('preview names only the zones being edited', () => {
    assert.deepEqual(ledPreviewPayload(palette, ['frontStrip'], 'awake'), { frontStrip: 'FFFF00000000' });
    assert.deepEqual(ledPreviewPayload(palette, ['backStrip'], 'awake'), { backStrip: '00000000FFFF' });
    assert.deepEqual(ledPreviewPayload(palette, ['frontStrip', 'backStrip'], 'awake'),
        { frontStrip: 'FFFF00000000', backStrip: '00000000FFFF' });
});

test('preview reads the bank being edited, not the one the machine renders', () => {
    // The whole point of the endpoint: show an asleep colour on an awake
    // machine. No machineBank argument exists here, by design.
    assert.deepEqual(ledPreviewPayload(palette, ['frontStrip'], 'sleeping'), { frontStrip: '0000FFFF0000' });
    assert.deepEqual(ledPreviewPayload(palette, ['backStrip'], 'sleeping'), { backStrip: 'FFFFFFFFFFFF' });
    // Anything that is not 'sleeping' is the awake bank.
    for (const bank of ['awake', undefined, null, 'nonsense']) {
        assert.deepEqual(ledPreviewPayload(palette, ['frontStrip'], bank), { frontStrip: 'FFFF00000000' });
    }
});

test('the switch zone previews on the front strip', () => {
    // frontSwitch is not a strip the endpoint knows -- the firmware derives the
    // HV switch colours from the front strip.
    assert.deepEqual(ledPreviewPayload(palette, ['frontSwitch'], 'awake'), { frontStrip: 'FFFF00000000' });
    assert.deepEqual(ledPreviewPayload(palette, ['frontSwitch'], 'sleeping'), { frontStrip: '0000FFFF0000' });
});

test('nothing to preview is null, because naming no strip is a 400', () => {
    for (const zones of [[], null, undefined, ['nonsense']]) {
        assert.equal(ledPreviewPayload(palette, zones, 'awake'), null, String(zones));
    }
});

test('a missing colour previews as off rather than as undefined', () => {
    // Every value must still be 12 hex characters or the POST is rejected.
    for (const [p, zones] of [[null, ['frontStrip']], [{}, ['frontStrip']], [{ frontStrip: {} }, ['frontStrip']]]) {
        const payload = ledPreviewPayload(p, zones, 'awake');
        assert.deepEqual(payload, { frontStrip: '000000000000' });
        assert.match(payload.frontStrip, /^[0-9a-fA-F]{12}$/);
    }
    for (const value of Object.values(ledPreviewPayload(palette, ['frontStrip', 'backStrip'], 'sleeping'))) {
        assert.match(value, /^[0-9a-fA-F]{12}$/);
    }
});

// --- the preview API wrappers --------------------------------------------
// api.js touches the DOM at module load, so the two wrappers are lifted out of
// the source the way the other api tests do. What matters is the status
// mapping: a capability answer must not reach the user as a failure.
const apiSource = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');

function ledPreviewApi(status) {
    const calls = [];
    const src = ['previewLedStrip', 'clearLedStripPreview']
        .map(name => apiSource.match(new RegExp('export async function ' + name + '\\([\\s\\S]*?\\n\\}'))[0].replace('export ', ''))
        .join('\n');
    return new Function('API_BASE_URL', 'fetch', `${src}\nreturn { previewLedStrip, clearLedStripPreview, calls: arguments[2] };`)(
        '/api/v1',
        async (url, opts) => { calls.push({ url, opts }); return { status, ok: status >= 200 && status < 300 }; },
        calls);
}

test('a non-Bengle answers "no preview here", not an error', async () => {
    // The category is already gated on model; 404 must not become a toast.
    const api = ledPreviewApi(404);
    assert.equal(await api.previewLedStrip({ frontStrip: 'FFFF00000000' }), false);
    assert.equal(await api.clearLedStripPreview(), false);
});

test('preview posts the colours and accepts 202', async () => {
    const api = ledPreviewApi(202);   // the endpoint returns Accepted, not OK
    assert.equal(await api.previewLedStrip({ frontStrip: 'FFFF00000000' }), true);
    const [call] = api.calls;
    assert.match(call.url, /\/machine\/ledStrip\/preview$/);
    assert.equal(call.opts.method, 'POST');
    assert.deepEqual(JSON.parse(call.opts.body), { frontStrip: 'FFFF00000000' });

    const clear = ledPreviewApi(202);
    assert.equal(await clear.clearLedStripPreview(), true);
    assert.match(clear.calls[0].url, /\/machine\/ledStrip\/preview\/clear$/);
    assert.equal(clear.calls[0].opts.method, 'POST');
});

test('clear treats 503 as "could not", not as a crash', async () => {
    // Decaid returns 503 when it cannot read the stored palette back. Nothing
    // to retry from here -- the next sleep/wake transition settles the strip.
    assert.equal(await ledPreviewApi(503).clearLedStripPreview(), false);
    // A preview that 503s is a real failure, though: it has no such mapping.
    await assert.rejects(() => ledPreviewApi(503).previewLedStrip({ frontStrip: 'FFFF00000000' }));
});

test('a rejected colour still throws, so a bad payload is not silently dropped', async () => {
    await assert.rejects(() => ledPreviewApi(400).previewLedStrip({ frontStrip: 'nope' }), /status 400/);
    await assert.rejects(() => ledPreviewApi(500).previewLedStrip({ frontStrip: 'FFFF00000000' }), /status 500/);
    await assert.rejects(() => ledPreviewApi(500).clearLedStripPreview(), /status 500/);
});

test('ledValueOf reads HSV value, ledWithValue rescales without shifting hue', () => {
    assert.equal(ledValueOf('#000000'), 0);
    assert.equal(ledValueOf('#FFFFFF'), 100);
    assert.equal(ledValueOf('#804000'), 50);

    // Half brightness halves every channel, so the ratios -- the hue -- hold.
    assert.equal(ledWithValue('#FF8000', 50), '#804000');
    assert.equal(ledWithValue('#FF8000', 100), '#FF8000');
    assert.equal(ledWithValue('#FF8000', 0), '#000000');
    // Round-trip: what you read back is what you asked for.
    for (const v of [10, 25, 60, 90]) assert.equal(ledValueOf(ledWithValue('#3FA0FF', v)), v);
    // Black has no hue to scale back up; the caller restores a base colour.
    assert.equal(ledWithValue('#000000', 80), '#000000');
    // Out-of-range input is clamped, not trusted.
    assert.equal(ledWithValue('#FF8000', 500), '#FF8000');
    assert.equal(ledWithValue('#FF8000', -5), '#000000');
});
