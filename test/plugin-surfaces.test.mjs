import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRIP_BAR_MAX, stripLayout, STRIP_COLUMNS, stripReading, stripDotLevel, stripBarFraction, STRIP_MAX_CELLS, scaleDoseWeight, scaleDoseFor, fitOverlaySize, parseNumpadInput, fitNumpadValue, yieldForRatio, doseForRatio, parseSkinAnswer, skinPlugins, callableEndpoint, liveEndpoint, pushWants, createPushCoalescer, RESERVED_ENDPOINTS, MAX_SURFACES,
    nextStepSize, resolveStepSize, formatStepSize } from '../src/modules/plugin-surfaces.js';

const ok = surfaces => parseSkinAnswer({ version: 1, surfaces }).surfaces;

test('the example answer from the proposal parses as written', () => {
    const s = ok([
        { id: 'main', kind: 'header-button', label: 'Plugin', text: 'Something chosen',
          image: 'https://example.com/photo.jpg', action: { type: 'open', view: 'main' } },
        { id: 'grind', kind: 'tile-hint', tile: 'grind', text: 'Last 6.4', title: 'The grind of the last shot',
          action: { type: 'set', field: 'grinderSetting', value: '6.4' } },
        { id: 'gear', kind: 'tile-line', tile: 'grind', text: 'EG-1 · 1200 rpm', action: { type: 'open', view: 'next' } },
    ]);
    assert.equal(s.length, 3);
    assert.deepEqual(s[0].action, { type: 'open', view: 'main', presentation: 'page' });
    assert.deepEqual(s[1].action, { type: 'set', field: 'grinderSetting', value: 6.4 });
});

test('wrong shape, wrong version or no answer give no surfaces and never throw', () => {
    for (const raw of [null, undefined, 'x', 3, [], {}, { version: 2, surfaces: [] }, { version: 1 }, { version: 1, surfaces: 'x' }]) {
        assert.deepEqual(parseSkinAnswer(raw), { surfaces: [], live: null });
    }
});

test('unknown kinds, bad ids and duplicate ids are dropped; the rest survive', () => {
    const s = ok([
        { id: 'a', kind: 'banner', text: 'x' },
        { id: 'bad id', kind: 'tile-line', tile: 'dose', text: 'x' },
        { id: 'a', kind: 'tile-line', tile: 'dose', text: 'one' },
        { id: 'a', kind: 'tile-line', tile: 'drink', text: 'two' },
    ]);
    assert.deepEqual(s.map(x => x.text), ['one']);
});

test('a non-string id (an array that stringifies to a valid id) is dropped', () => {
    const s = ok([
        { id: ['b'], kind: 'tile-line', tile: 'dose', text: 'array' },
        { id: 'b', kind: 'tile-line', tile: 'drink', text: 'string' },
        { id: ['b'], kind: 'tile-line', tile: 'grind', text: 'array duplicate' },
        { id: 7, kind: 'tile-line', tile: 'grind', text: 'number' },
    ]);
    assert.deepEqual(s.map(x => x.text), ['string']);
});

test('limits: one header button, one hint and one line per tile, up to three modes, sixteen surfaces', () => {
    const btn = id => ({ id, kind: 'header-button', label: 'B' });
    assert.equal(ok([btn('a'), btn('b')]).length, 1);
    const hint = (id, tile) => ({ id, kind: 'tile-hint', tile, text: id });
    assert.deepEqual(ok([hint('a', 'dose'), hint('b', 'dose'), hint('c', 'grind')]).map(s => s.id), ['a', 'c']);
    assert.equal(ok([hint('a', 'dose'), { id: 'b', kind: 'tile-line', tile: 'dose', text: 'b' }]).length, 2);
    const tiles = ['dose', 'drink', 'grind', 'temperature'];
    const lines = tiles.map(tile => ({ id: tile, kind: 'tile-line', tile, text: tile }));
    assert.equal(ok(lines).length, 4);
    assert.equal(MAX_SURFACES, 16);
    const modeOn = (tile, ids) => ids.map(id => ({ id: tile + id, kind: 'tile-mode', tile, label: id, value: 1, min: 0, max: 9, step: 1,
        action: { type: 'call', endpoint: 'e', field: 'f' } }));
    const hintsAndLines = [btn('b'), ...tiles.flatMap(t => [hint(`h${t}`, t), { id: `l${t}`, kind: 'tile-line', tile: t, text: t }])];
    // 1 button + 4 hints + 4 lines + 3 steam modes (the fourth is over the per-tile limit) = 12
    const twelve = [...hintsAndLines, ...modeOn('steam', ['x', 'y', 'z', 'w'])];
    assert.equal(ok(twelve).length, 12);
    assert.deepEqual(ok(twelve).filter(s => s.kind === 'tile-mode').map(s => s.id), ['steamx', 'steamy', 'steamz']);
    // 3 flush modes and 3 more on dose make 18 slots, capped at MAX_SURFACES
    assert.equal(ok([...twelve, ...modeOn('flush', ['a', 'b', 'c']), ...modeOn('dose', ['a', 'b', 'c'])]).length, 16);
});

const stepsize = (over = {}, kind = 'tile-hint') => ({ id: 'ss', kind, tile: 'dose', text: 'x',
    action: { type: 'stepsize', field: 'targetDoseWeight', sizes: [1, 0.5, 0.1], ...over } });

test('stepsize: valid action parses, sizes rounded to hundredths', () => {
    assert.deepEqual(ok([stepsize()])[0].action, { type: 'stepsize', field: 'targetDoseWeight', sizes: [1, 0.5, 0.1] });
    assert.deepEqual(ok([stepsize({ field: 'targetYield', sizes: ['2', 0.254, 10] }, 'tile-line')])[0].action.sizes, [2, 0.25, 10]);
});

test('stepsize: invalid actions are dropped and the surface stays inert', () => {
    const bad = [{ sizes: [1, 2, 3, 4, 5] }, { sizes: [] }, { sizes: [0] }, { sizes: [-1] }, { sizes: [10.01] },
        { sizes: [0.004] }, { sizes: ['x'] }, { sizes: 1 }, { field: 'brewTemperature' }];
    for (const over of bad) {
        const [s] = ok([stepsize(over)]);
        assert.ok(s, JSON.stringify(over));
        assert.equal(s.action, undefined, JSON.stringify(over));
    }
});

test('stepsize: invalid sizes with no text keep the surface inert with a placeholder', () => {
    const [s] = ok([{ id: 'ss', kind: 'tile-hint', tile: 'dose', action: { type: 'stepsize', field: 'targetDoseWeight', sizes: [] } }]);
    assert.ok(s);
    assert.equal(s.action, undefined);
    assert.equal(s.text, '±1 g');
});

test('stepValue clamps to min', async () => {
    const { stepValue } = await import('../src/modules/value-format.js');
    assert.equal(stepValue(5, 10, -1, 0), 0);
    assert.equal(stepValue(5, 0.5, -1, 0), 4.5);
    assert.equal(stepValue(5, 1, 1), 6);
});

test('stepsize: only on tile-hint and tile-line', () => {
    const action = { type: 'stepsize', field: 'targetDoseWeight', sizes: [1] };
    assert.equal(ok([{ id: 'a', kind: 'header-button', label: 'B', action }])[0].action, undefined);
    assert.equal(ok([{ id: 'a', kind: 'tile-mode', tile: 'dose', label: 'M', value: 1, min: 0, max: 5, action }]).length, 0);
});

test('stepsize helpers: next wraps, unknown current goes to the first, text format', () => {
    assert.equal(nextStepSize([1, 0.5, 0.1], 1), 0.5);
    assert.equal(nextStepSize([1, 0.5, 0.1], 0.1), 1);
    assert.equal(nextStepSize([1, 0.5, 0.1], 7), 1);
    assert.equal(nextStepSize([1, 0.5], null), 1);
    assert.equal(resolveStepSize([1, 0.5], 0.5), 0.5);
    assert.equal(resolveStepSize([1, 0.5], 3), 1);
    assert.equal(formatStepSize(0.5), '±0.5 g');
    assert.equal(formatStepSize(1), '±1 g');
    assert.equal(formatStepSize(0.5, 'grinderSetting'), '±0.5');
});

test('stepsize: grind takes it too, with a unit-less default pill text', () => {
    const [s] = ok([{ id: 'g', kind: 'tile-line', tile: 'grind', action: { type: 'stepsize', field: 'grinderSetting', sizes: [1, 0.5] } }]);
    assert.deepEqual(s.action, { type: 'stepsize', field: 'grinderSetting', sizes: [1, 0.5] });
    assert.equal(s.text, '±1');
});

test('text is capped, stripped of control characters, and never needed as HTML', () => {
    const [s] = ok([{ id: 'a', kind: 'tile-line', tile: 'dose', text: `<b>hi</b>\n${'x'.repeat(200)}` }]);
    assert.ok(s.text.length <= 40);
    assert.ok(!/[\n\r]/.test(s.text));
    assert.ok(s.text.startsWith('<b>hi</b>')); // kept verbatim: the renderer uses textContent
});

test('a surface with no required text, label or a known tile is dropped', () => {
    assert.equal(ok([{ id: 'a', kind: 'header-button', label: '  ' }]).length, 0);
    assert.equal(ok([{ id: 'a', kind: 'tile-hint', tile: 'dose', text: '' }]).length, 0);
    assert.equal(ok([{ id: 'a', kind: 'tile-line', tile: 'steam', text: 'x' }]).length, 0);
});

test('images must be https without credentials, otherwise only the image is dropped', () => {
    const img = image => ok([{ id: 'a', kind: 'header-button', label: 'B', image }])[0];
    assert.equal(img('https://example.com/a.png').image, 'https://example.com/a.png');
    for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'https://u:p@example.com/a.png', 'data:image/png;base64,AAAA', 42]) {
        const s = img(bad);
        assert.equal(s.label, 'B');
        assert.equal(s.image, undefined);
    }
});

test('open: presentation is a hint, unknown values fall back to page', () => {
    const open = a => ok([{ id: 'a', kind: 'header-button', label: 'B', action: { type: 'open', ...a } }])[0].action;
    assert.equal(open({ view: 'main' }).presentation, 'page');
    assert.equal(open({ view: 'main', presentation: 'overlay' }).presentation, 'overlay');
    assert.equal(open({ view: 'main', presentation: 'fullscreen' }).presentation, 'page');
    assert.equal(open({ view: '../../etc' }).view, '');
    // fit: only an overlay can hold its dialog back, and only for exactly true
    assert.equal(open({ view: 'main', presentation: 'overlay', fit: true }).fit, true);
    assert.equal(open({ view: 'main', presentation: 'overlay', fit: 'yes' }).fit, undefined);
    assert.equal(open({ view: 'main', presentation: 'overlay' }).fit, undefined);
    assert.equal(open({ view: 'main', presentation: 'page', fit: true }).fit, undefined);
    // closeOnShot: same rule, exactly true on an overlay
    assert.equal(open({ view: 'main', presentation: 'overlay', closeOnShot: true }).closeOnShot, true);
    assert.equal(open({ view: 'main', presentation: 'overlay', closeOnShot: 1 }).closeOnShot, undefined);
    assert.equal(open({ view: 'main', presentation: 'page', closeOnShot: true }).closeOnShot, undefined);
    // size: full is an overlay-only exact string, and it replaces fit
    assert.equal(open({ view: 'main', presentation: 'overlay', size: 'full' }).size, 'full');
    assert.equal(open({ view: 'main', presentation: 'overlay', size: 'huge' }).size, undefined);
    assert.equal(open({ view: 'main', presentation: 'page', size: 'full' }).size, undefined);
    assert.equal(open({ view: 'main', presentation: 'overlay', size: 'full', fit: true }).fit, undefined);
});

test('step moves a steppable tile field by a bounded non-zero amount', () => {
    const step = (field, by, kind = 'tile-hint') => ok([{ id: 'a', kind, tile: 'dose', text: 'x', action: { type: 'step', field, by } }])[0]?.action;
    assert.deepEqual(step('targetDoseWeight', '-0.5'), { type: 'step', field: 'targetDoseWeight', by: -0.5 });
    assert.deepEqual(step('grinderSetting', 1, 'tile-line'), { type: 'step', field: 'grinderSetting', by: 1 });
    for (const bad of [0, 101, 'x', null]) assert.ok(!step('targetYield', bad));
    assert.ok(!step('brewTemperature', 1));
    assert.ok(!step('targetDoseWeight', 1, 'header-button'));
});

test('set: only dose, yield, grind and brew temperature, as numbers clamped to the tile maximums', () => {
    const set = (field, value) => ok([{ id: 'a', kind: 'tile-hint', tile: 'dose', text: 'x', action: { type: 'set', field, value } }])[0].action;
    assert.deepEqual(set('targetDoseWeight', 18.5), { type: 'set', field: 'targetDoseWeight', value: 18.5 });
    assert.equal(set('targetYield', '36').value, 36);
    assert.equal(set('targetYield', 9999).value, 2000);
    assert.equal(set('targetDoseWeight', 500).value, 30);
    assert.equal(set('grinderSetting', 99999).value, 9999);
    assert.equal(set('targetDoseWeight', 0).value, 1);
    assert.equal(set('grinderSetting', 6.456).value, 6.46);
    assert.deepEqual(set('brewTemperature', 93), { type: 'set', field: 'brewTemperature', value: 93 });
    assert.equal(set('brewTemperature', 20).value, 70);
    assert.equal(set('brewTemperature', 500).value, 105);
    for (const [field, value] of [['brewTemperature', 'hot'], ['profile', 'x'], ['constructor', 1], ['__proto__', 1], ['toString', 1], ['machineState', 'sleeping'], ['targetYield', NaN],
        ['targetYield', Infinity], ['grinderSetting', ''], ['grinderSetting', 'C40'], ['grinderSetting', { a: 1 }]]) {
        assert.equal(set(field, value), undefined);
    }
});

test('an invalid action leaves the surface, inert; header buttons cannot set', () => {
    const [s] = ok([{ id: 'a', kind: 'tile-line', tile: 'dose', text: 'x', action: { type: 'shell', cmd: 'rm -rf' } }]);
    assert.equal(s.text, 'x');
    assert.equal(s.action, undefined);
    const [h] = ok([{ id: 'b', kind: 'header-button', label: 'B', action: { type: 'set', field: 'targetYield', value: 36 } }]);
    assert.equal(h.action, undefined);
});

test('only loaded plugins with an http skin endpoint are asked', () => {
    const skin = { id: 'skin', type: 'http' };
    const plugins = [
        { id: 'a', loaded: true, api: [skin] },
        { id: 'b', loaded: false, api: [skin] },
        { id: 'c', loaded: true, api: [{ id: 'ui', type: 'http' }] },
        { id: 'd', loaded: true, api: [{ id: 'skin', type: 'websocket' }] },
        { id: 'e', loaded: true },
        null,
    ];
    assert.deepEqual(skinPlugins(plugins).map(p => p.id), ['a']);
    assert.deepEqual(skinPlugins(null), []);
});

const mode = over => ({ id: 'pct', kind: 'tile-mode', tile: 'temperature', label: '%', unit: '%', value: 5,
    min: -20, max: 20, step: 1, decimals: 0, presets: [-5, -2, 2, 5],
    action: { type: 'call', endpoint: 'apply', field: 'percent' }, ...over });

test('tile-mode: the documented example parses as written', () => {
    assert.deepEqual(ok([mode()])[0], {
        id: 'pct', kind: 'tile-mode', tile: 'temperature', label: '%', unit: '%', value: 5,
        min: -20, max: 20, step: 1, decimals: 0, presets: [-5, -2, 2, 5],
        action: { type: 'call', endpoint: 'apply', field: 'percent' },
    });
});

test('tile-mode: any left-column tile, defaults, numeric strings, and numbers clamped to min..max', () => {
    for (const tile of ['dose', 'drink', 'grind', 'temperature', 'steam', 'hotwater', 'flush']) assert.equal(ok([mode({ tile })]).length, 1);
    assert.equal(ok([mode({ tile: 'hot-water' })]).length, 0);
    const m = ok([mode({ step: undefined, decimals: undefined, unit: undefined, value: '99', presets: [-50, '3', 'x', null, 1, 2, 4] })])[0];
    assert.equal(m.step, 1);
    assert.equal(m.decimals, 0);
    assert.equal('unit' in m, false);
    assert.equal(m.value, 20);
    assert.deepEqual(m.presets, [-20, 3, 1, 2]); // junk skipped, four at most
});

test('tile-mode: a mode that cannot be stepped, shown or called is dropped', () => {
    for (const bad of [
        { label: '' }, { label: 5 }, { value: 'x' }, { value: undefined },
        { min: 5, max: 5 }, { min: 10, max: -10 }, { min: -10000 }, { max: 10000 }, { min: 'a' },
        { step: 0 }, { step: -1 }, { step: 41 }, { decimals: 3 }, { decimals: 1.5 },
        { action: undefined }, { action: { type: 'open', view: 'main' } },
        { action: { type: 'set', field: 'targetYield', value: 36 } },
        { action: { type: 'call', endpoint: 'skin', field: 'percent' } },
        { action: { type: 'call', endpoint: 'bad id', field: 'percent' } },
        { action: { type: 'call', endpoint: 'apply', field: '1x' } },
        { action: { type: 'call', endpoint: 'apply', field: 'a b' } },
    ]) assert.equal(ok([mode(bad)]).length, 0, JSON.stringify(bad));
});

test('tile-mode: label and unit are capped, up to three modes per tile', () => {
    const m = ok([mode({ label: 'abcdefghij', unit: 'abcdef' })])[0];
    assert.equal(m.label, 'abcdef');
    assert.equal(m.unit, 'abc');
    const many = ok([mode(), mode({ id: 'other' }), mode({ id: 'third' }), mode({ id: 'fourth' }), mode({ id: 'dose-m', tile: 'dose' })]);
    assert.deepEqual(many.map(x => x.id), ['pct', 'other', 'third', 'dose-m']);
});

test('tile-mode: a second value is a bounded number on steam and drink; applyOnSelect needs a real true', () => {
    const second = { field: 'flow', value: 1.26, min: 0.4, max: 2, decimals: 1, unit: 'ml/s' };
    const m = ok([mode({ tile: 'steam', second, applyOnSelect: true })])[0];
    assert.deepEqual(m.second, { field: 'flow', unit: 'ml/s', decimals: 1, min: 0.4, max: 2, value: 1.3 });
    assert.equal(m.applyOnSelect, true);
    // other tiles have no second line; a bad second leaves the mode without one
    assert.equal('second' in ok([mode({ tile: 'dose', second })])[0], false);
    assert.deepEqual(ok([mode({ tile: 'hotwater', second })])[0].second.field, 'flow');
    for (const bad of [{ ...second, field: 'percent' }, { ...second, field: '9x' }, { ...second, min: 3 },
        { ...second, decimals: 5 }, { ...second, value: 'x' }, 'text', null]) {
        assert.equal('second' in ok([mode({ tile: 'steam', second: bad })])[0], false);
    }
    assert.equal(ok([mode({ tile: 'steam', second: { ...second, unit: 'abcdefghij' } })])[0].second.unit, 'abcdef');
    assert.equal('applyOnSelect' in ok([mode({ applyOnSelect: 'yes' })])[0], false);
});

test('call is only valid on a tile-mode; the mode may share a tile with a hint and a line', () => {
    const call = { type: 'call', endpoint: 'apply', field: 'percent' };
    const s = ok([
        { id: 'h', kind: 'tile-hint', tile: 'temperature', text: 'x', action: call },
        { id: 'b', kind: 'header-button', label: 'x', action: call },
        mode(),
    ]);
    assert.deepEqual(s.map(x => [x.id, 'action' in x]), [['h', false], ['b', false], ['pct', true]]);
    const same = ok([
        { id: 'h', kind: 'tile-hint', tile: 'temperature', text: 'x' },
        { id: 'l', kind: 'tile-line', tile: 'temperature', text: 'x' },
        mode(),
    ]);
    assert.equal(same.length, 3);
});

test('callableEndpoint: only an http endpoint the plugin declares, never skin', () => {
    const plugin = { api: [{ id: 'skin', type: 'http' }, { id: 'apply', type: 'http' }, { id: 'stream', type: 'websocket' }] };
    assert.equal(callableEndpoint(plugin, 'apply'), true);
    assert.equal(callableEndpoint(plugin, 'skin'), false);
    assert.equal(callableEndpoint(plugin, 'stream'), false);
    assert.equal(callableEndpoint(plugin, 'other'), false);
    assert.equal(callableEndpoint({}, 'apply'), false);
    assert.equal(callableEndpoint(plugin, 5), false);
});

test('tile-mode: step finer than decimals is dropped; a valid step is rounded to decimals', () => {
    for (const bad of [{ step: 0.4, decimals: 0 }, { step: 0.004, decimals: 2 }, { step: 0.04, decimals: 1 }, { step: 0.2, decimals: 0 }]) {
        assert.equal(ok([mode(bad)]).length, 0, JSON.stringify(bad));
    }
    assert.equal(ok([mode({ step: 0.01, decimals: 2 })])[0].step, 0.01);
    assert.equal(ok([mode({ step: 0.5, decimals: 1 })])[0].step, 0.5);
    assert.equal(ok([mode({ step: 1.4, decimals: 0 })])[0].step, 1);
    assert.equal(ok([mode({ step: 0.5, decimals: 0 })])[0].step, 1); // rounds up to the finest step shown
    assert.equal(ok([mode({ step: 41, decimals: 0 })]).length, 0);
});

test('tile-mode: min and max must fit decimals', () => {
    assert.equal(ok([mode({ min: 0.4, max: 10, decimals: 0 })]).length, 0);
    assert.equal(ok([mode({ min: 0, max: 9.5, decimals: 0 })]).length, 0);
    assert.equal(ok([mode({ min: 0.5, max: 9.5, decimals: 1, step: 0.5 })]).length, 1);
    assert.equal(ok([mode({ min: 0.125, max: 9, decimals: 2 })]).length, 0);
});

test('tile-mode: value and presets are clamped and rounded to decimals', () => {
    const m = ok([mode({ min: 0, max: 10, decimals: 1, step: 0.1, value: 3.14159, presets: [0.26, 99, -3, '1.04'] })])[0];
    assert.equal(m.value, 3.1);
    assert.deepEqual(m.presets, [0.3, 10, 0, 1]);
    assert.equal(ok([mode({ value: 4.6 })])[0].value, 5);
    assert.deepEqual(ok([mode({ presets: [1.4, 2.5] })])[0].presets, [1, 3]);
});

test('reserved endpoint ids are neither parsed nor callable', () => {
    for (const id of ['skin', 'settings', 'enable', 'disable', 'source', 'update', 'install']) {
        assert.ok(RESERVED_ENDPOINTS.includes(id), id);
        const action = { type: 'call', endpoint: id, field: 'percent' };
        assert.equal(ok([mode({ action })]).length, 0, id);
        assert.equal(callableEndpoint({ api: [{ id, type: 'http' }] }, id), false, id);
    }
});

test('tile-mode: menu items are label and number, capped, clamped; presetsEditable only when false', () => {
    const m = ok([mode({ menu: [
        { label: 'Reset to 0%', value: 0 }, { label: 'Hot', value: 99 }, { label: '', value: 1 },
        { label: 'x', value: 'n' }, null, 'str', { label: 'Four', value: '3' }, { label: 'Five', value: 4 }, { label: 'Six', value: 5 },
    ] })])[0];
    assert.deepEqual(m.menu, [{ label: 'Reset to 0%', value: 0 }, { label: 'Hot', value: 20 }, { label: 'Four', value: 3 }, { label: 'Five', value: 4 }]);
    assert.equal('presetsEditable' in m, false);
    assert.equal(ok([mode({ presetsEditable: false })])[0].presetsEditable, false);
    assert.equal('presetsEditable' in ok([mode({ presetsEditable: true })])[0], false);
    assert.equal('menu' in ok([mode({ menu: 'x' })])[0], false);
});

const hintCall = over => ({ id: 'lock', kind: 'tile-hint', tile: 'drink', text: 'Ratio', active: true,
    action: { type: 'call', endpoint: 'ratio', field: 'lock', value: 1 }, ...over });

test('call on a hint or line carries one fixed number; active marks it on', () => {
    const [h] = ok([hintCall()]);
    assert.deepEqual(h.action, { type: 'call', endpoint: 'ratio', field: 'lock', value: 1 });
    assert.equal(h.active, true);
    const [l] = ok([{ id: 'l', kind: 'tile-line', tile: 'dose', text: 'x',
        action: { type: 'call', endpoint: 'ratio', field: 'lock', value: '0.456' } }]);
    assert.equal(l.action.value, 0.46);
    assert.equal('active' in l, false);
    assert.equal('active' in ok([hintCall({ active: 'yes' })])[0], false);
    assert.equal('active' in ok([hintCall({ active: false })])[0], false);
});

test('a hint or line call without a usable value, or to a reserved endpoint, is inert; header buttons cannot call', () => {
    for (const action of [
        { type: 'call', endpoint: 'ratio', field: 'lock' },
        { type: 'call', endpoint: 'ratio', field: 'lock', value: 'x' },
        { type: 'call', endpoint: 'ratio', field: 'lock', value: 1e9 },
        { type: 'call', endpoint: 'ratio', field: 'lock', value: Infinity },
        { type: 'call', endpoint: 'settings', field: 'lock', value: 1 },
        { type: 'call', endpoint: 'ratio', field: '1x', value: 1 },
    ]) {
        const [h] = ok([hintCall({ action })]);
        assert.equal(h.text, 'Ratio', JSON.stringify(action));       // the surface still shows
        assert.equal('action' in h, false, JSON.stringify(action));  // inert
    }
    const [b] = ok([{ id: 'b', kind: 'header-button', label: 'x',
        action: { type: 'call', endpoint: 'ratio', field: 'lock', value: 1 } }]);
    assert.equal('action' in b, false);
});

test('a tile-mode call still takes no value', () => {
    const m = ok([mode({ action: { type: 'call', endpoint: 'apply', field: 'percent', value: 5 } })])[0];
    assert.deepEqual(m.action, { type: 'call', endpoint: 'apply', field: 'percent' });
});

test('screensaver-button: label and an open action only; anything else is dropped', () => {
    const btn = extra => ok([{ id: 's', kind: 'screensaver-button', label: 'Dial in', ...extra }]);
    const open = { type: 'open', view: 'main', presentation: 'overlay' };
    assert.deepEqual(btn({ action: open })[0], { id: 's', kind: 'screensaver-button', label: 'Dial in', action: open });
    assert.equal(btn({}).length, 0); // no action: dead button
    assert.equal(btn({ action: { type: 'set', field: 'targetYield', value: 36 } }).length, 0);
    assert.equal(btn({ action: { type: 'call', endpoint: 'x', field: 'y', value: 1 } }).length, 0);
    assert.equal(ok([{ id: 's', kind: 'screensaver-button', label: ' ', action: open }]).length, 0);
    assert.equal(btn({ label: 'x'.repeat(60), action: open })[0].label.length, 24);
});

test('screensaver-button: one per answer, independent of the header button', () => {
    const open = { type: 'open', view: 'main' };
    const s = id => ({ id, kind: 'screensaver-button', label: 'S', action: open });
    assert.deepEqual(ok([s('a'), s('b')]).map(x => x.id), ['a']);
    const h = { id: 'h', kind: 'header-button', label: 'H' };
    assert.equal(ok([h, s('a')]).length, 2);
});

test('numpad input: a call asks for the number with the stock numpad; limits are strict', () => {
    const call = input => ({ type: 'call', endpoint: 'ratio', field: 'ratio', input });
    const good = { title: 'Ratio', unit: 'x', min: 1, max: 5, decimals: 1, value: 2.5 };
    for (const [kind, extra] of [['tile-hint', { tile: 'drink', text: 'Set' }], ['tile-line', { tile: 'dose', text: 'Set' }], ['ratio-action', {}]]) {
        const [s] = ok([{ id: 'n', kind, ...extra, action: call(good) }]);
        assert.deepEqual(s.action, call(good), kind);
    }
    // value is optional (starts at min), clamped and rounded; title and unit are optional and capped
    assert.deepEqual(parseNumpadInput({ min: 0, max: 10 }), { min: 0, max: 10, decimals: 0, value: 0 });
    assert.equal(parseNumpadInput({ min: 0, max: 10, decimals: 1, value: 99 }).value, 10);
    assert.equal(parseNumpadInput({ min: 0, max: 10, decimals: 1, value: 2.26 }).value, 2.3);
    assert.equal(parseNumpadInput({ min: 0, max: 10, title: 'x'.repeat(60), unit: 'y'.repeat(60) }).title.length, 24);
    assert.equal(parseNumpadInput({ min: 0, max: 10, unit: 'y'.repeat(60) }).unit.length, 6);
    for (const bad of [null, 'x', {}, { min: 5, max: 5 }, { min: 6, max: 5 }, { min: 0, max: 100000 }, { min: -100000, max: 1 },
        { min: 0, max: 1, decimals: 3 }, { min: 0, max: 1, decimals: 0.5 }, { min: 'a', max: 1 }]) {
        assert.equal(parseNumpadInput(bad), null, JSON.stringify(bad));
    }
    // rounding never leaves the range: 1.25 max with one decimal allows 1.2, and a range no grid number fits is dropped
    assert.equal(fitNumpadValue({ min: 0, max: 1.25, decimals: 1 }, 9), 1.2);
    assert.equal(parseNumpadInput({ min: 0, max: 1.25, decimals: 1, value: 1.25 }).value, 1.2);
    assert.equal(parseNumpadInput({ min: 0.05, max: 1 }).value, 1);
    assert.equal(parseNumpadInput({ min: 0.4, max: 0.6 }), null);
    // the numpad's sign key needs whole numbers, so a negative range with decimals is dropped
    assert.equal(parseNumpadInput({ min: -5, max: 5, decimals: 1 }), null);
    assert.equal(parseNumpadInput({ min: -5, max: 5 }).value, -5);
    // a bad input drops the action, and the fixed-value form still works
    const [bad] = ok([{ id: 'n', kind: 'tile-hint', tile: 'dose', text: 'Set', action: call({ min: 3, max: 1 }) }]);
    assert.equal(bad.action, undefined);
    const [fixed] = ok([{ id: 'n', kind: 'tile-hint', tile: 'dose', text: 'Set', action: { type: 'call', endpoint: 'ratio', field: 'ratio', value: 2 } }]);
    assert.equal(fixed.action.value, 2);
    // a tile-mode never takes it: it already sends what the user chose
    const [mode] = ok([{ id: 'm', kind: 'tile-mode', tile: 'steam', label: 'A', value: 10, min: 1, max: 60, step: 1, decimals: 0,
        presets: [], action: call(good) }]);
    assert.equal(mode?.action?.input, undefined);
});

test('size: medium and large are kept on hints, lines and modes; anything else is the default', () => {
    const hint = size => ok([{ id: 'h', kind: 'tile-hint', tile: 'dose', text: 'x', size }])[0];
    assert.equal(hint('large').size, 'large');
    assert.equal(hint('medium').size, 'medium');
    for (const v of ['small', 'huge', 'LARGE', 3, null, undefined, {}]) assert.equal('size' in hint(v), false, String(v));
    assert.equal(ok([{ id: 'l', kind: 'tile-line', tile: 'grind', text: 'x', size: 'large' }])[0].size, 'large');
    const mode = size => ok([{ id: 'm', kind: 'tile-mode', tile: 'steam', label: 'A', value: 10, min: 1, max: 60, step: 1, decimals: 0,
        presets: [], size, action: { type: 'call', endpoint: 'e', field: 'f' } }])[0];
    assert.equal(mode('large').size, 'large');
    assert.equal('size' in mode('x'), false);
    // buttons take no size
    assert.equal('size' in ok([{ id: 'b', kind: 'header-button', label: 'B', size: 'large' }])[0], false);
});

test('keepRatio: only on a Drink hint or line, a sane ratio; yieldForRatio stays in range', () => {
    const on = (tile, keepRatio, kind = 'tile-line') => ok([{ id: 'k', kind, tile, text: 'Lock', keepRatio }])[0];
    assert.equal(on('drink', 2.5).keepRatio, 2.5);
    assert.equal(on('drink', '2.456', 'tile-hint').keepRatio, 2.46);
    assert.equal('keepRatio' in on('dose', 2.5), false);
    assert.equal('keepRatio' in on('grind', 2.5, 'tile-hint'), false);
    for (const bad of [0, -2, 0.09, 50.1, 'x', null, undefined, NaN, {}]) assert.equal('keepRatio' in on('drink', bad), false, String(bad));
    assert.equal(yieldForRatio(18, 2.5), 45);
    assert.equal(yieldForRatio(18.3, 2.5), 45.8); // a tenth of a gram
    assert.equal(yieldForRatio(0, 2.5), null);
    assert.equal(yieldForRatio(30, 50), 1500);
    assert.equal(yieldForRatio(41, 50), null); // 2050 is above the largest yield
    assert.equal(yieldForRatio(NaN, 2), null);
});

test('keepRatioMoves: yield or dose are kept with keepRatio; both is the default; doseForRatio stays in range', () => {
    const k = moves => ok([{ id: 'k', kind: 'tile-line', tile: 'drink', text: 'L', keepRatio: 2, keepRatioMoves: moves }])[0];
    assert.equal(k('dose').keepRatioMoves, 'dose');
    assert.equal(k('yield').keepRatioMoves, 'yield');
    for (const v of ['both', 'x', 3, null, undefined]) assert.equal('keepRatioMoves' in k(v), false, String(v));
    // no keepRatio, no moves
    assert.equal('keepRatioMoves' in ok([{ id: 'k', kind: 'tile-line', tile: 'drink', text: 'L', keepRatioMoves: 'dose' }])[0], false);
    assert.equal(doseForRatio(45, 2.5), 18);
    assert.equal(doseForRatio(46, 2.5), 18.4);
    assert.equal(doseForRatio(90, 2), null); // 45 g is above the largest dose
    assert.equal(doseForRatio(1, 5), null);  // 0.2 g is below the smallest
    assert.equal(doseForRatio(NaN, 2), null);
});

test('set from the scale: dose only, no value; the reading must be a real dose', () => {
    const set = extra => ok([{ id: 's', kind: 'tile-hint', tile: 'dose', text: 'Use scale', action: { type: 'set', ...extra } }])[0];
    assert.deepEqual(set({ field: 'targetDoseWeight', from: 'scale' }).action, { type: 'set', field: 'targetDoseWeight', from: 'scale' });
    // a value alongside is not kept; other fields and sources drop the action
    assert.equal('value' in set({ field: 'targetDoseWeight', from: 'scale', value: 99 }).action, false);
    for (const bad of [{ field: 'targetYield', from: 'scale' }, { field: 'grinderSetting', from: 'scale' },
        { field: 'targetDoseWeight', from: 'plugin' }, { field: 'targetDoseWeight', from: null }, { field: 'targetDoseWeight', from: 5 }]) {
        assert.equal(set(bad).action, undefined, JSON.stringify(bad));
    }
    assert.equal(scaleDoseWeight(18.34), 18.3);
    assert.equal(scaleDoseWeight(30), 30);
    assert.equal(scaleDoseWeight(0.96), 1); // rounds into range
    for (const bad of [0, 0.9, 30.1, 200, -3, NaN, Infinity, null, undefined, '18']) assert.equal(scaleDoseWeight(bad), null, String(bad));
});

test('scale dose: fresh, idle, not straight after a shot, and a real dose', () => {
    const base = { weight: 18.34, readAt: 100_000, now: 101_000, state: 'idle', espressoEndedAt: null };
    assert.equal(scaleDoseFor(base), 18.3);
    assert.equal(scaleDoseFor({ ...base, state: null }), 18.3); // no machine socket yet: the tap is not blocked
    // age: 3 s is still fresh, one ms more is not
    assert.equal(scaleDoseFor({ ...base, now: 103_000 }), 18.3);
    assert.equal(scaleDoseFor({ ...base, now: 103_001 }), null);
    assert.equal(scaleDoseFor({ ...base, readAt: 0 }), null);
    assert.equal(scaleDoseFor({ ...base, readAt: NaN }), null);
    // a weightless frame (undefined/null) and junk never become a dose
    for (const weight of [undefined, null, NaN, '18', 0, 31, 250]) assert.equal(scaleDoseFor({ ...base, weight }), null, String(weight));
    // machine busy
    for (const state of ['espresso', 'skipStep', 'steam', 'steamRinse', 'hotWater', 'flush', 'cleaning', 'descaling', 'airPurge']) {
        assert.equal(scaleDoseFor({ ...base, state }), null, state);
    }
    for (const state of ['idle', 'sleeping', 'heating', 'preheating']) assert.equal(scaleDoseFor({ ...base, state }), 18.3, state);
    // the cup is still on the scale for 10 s after a shot
    assert.equal(scaleDoseFor({ ...base, espressoEndedAt: 95_000 }), null);
    assert.equal(scaleDoseFor({ ...base, espressoEndedAt: 91_000 }), 18.3);
});

test('overlay size: held to the default dialog and the screen, junk ignored', () => {
    assert.deepEqual(fitOverlaySize(420, 300, 1920, 1200), { width: 420, height: 300 });
    assert.deepEqual(fitOverlaySize(5000, 5000, 1920, 1200), { width: 1100, height: 760 });
    assert.deepEqual(fitOverlaySize(5000, 5000, 800, 600), { width: 752, height: 540 }); // 94% x 90% of the screen
    assert.deepEqual(fitOverlaySize(10, 10, 1920, 1200), { width: 280, height: 160 });
    assert.deepEqual(fitOverlaySize(419.6, 300.4, 1920, 1200), { width: 420, height: 300 });
    assert.deepEqual(fitOverlaySize(400, 300, 200, 100), { width: 280, height: 160 }); // a tiny screen keeps the minimum
    for (const bad of [[NaN, 100], [100, Infinity], ['300', 200], [null, 200], [undefined, undefined]]) {
        assert.equal(fitOverlaySize(bad[0], bad[1], 1920, 1200), null, JSON.stringify(bad));
    }
});

test('ratio-action: open or call only, one per answer, drawn by the skin', () => {
    const r = (extra, id = 'r') => ok([{ id, kind: 'ratio-action', ...extra }]);
    const open = { type: 'open', view: 'ratio', presentation: 'overlay' };
    const call = { type: 'call', endpoint: 'ratio', field: 'tap', value: 1 };
    assert.deepEqual(r({ action: open })[0], { id: 'r', kind: 'ratio-action', action: open });
    assert.deepEqual(r({ action: call, title: 'Set ratio' })[0], { id: 'r', kind: 'ratio-action', title: 'Set ratio', action: call });
    assert.equal(r({}).length, 0); // no action: dead label
    assert.equal(r({ action: { type: 'set', field: 'targetYield', value: 36 } }).length, 0);
    assert.equal(r({ action: { type: 'step', field: 'targetYield', by: 1 } }).length, 0);
    assert.equal(r({ action: { type: 'call', endpoint: 'ratio', field: 'tap' } }).length, 0); // call needs its fixed value
    assert.deepEqual(ok([{ id: 'a', kind: 'ratio-action', action: open }, { id: 'b', kind: 'ratio-action', action: call }]).map(x => x.id), ['a']);
});

test('live names a websocket endpoint; it is only used when the plugin declares it', () => {
    const answer = (live) => parseSkinAnswer({ version: 1, surfaces: [], live });
    assert.deepEqual(answer({ endpoint: 'changed' }).live, { endpoint: 'changed' });
    for (const bad of [null, undefined, 'changed', {}, { endpoint: 5 }, { endpoint: 'bad id' }, { endpoint: 'skin' }, { endpoint: 'settings' }]) {
        assert.equal(answer(bad).live, null, JSON.stringify(bad));
    }
    const plugin = { api: [{ id: 'changed', type: 'websocket' }, { id: 'apply', type: 'http' }] };
    assert.equal(liveEndpoint(plugin, { endpoint: 'changed' }), 'changed');
    assert.equal(liveEndpoint(plugin, { endpoint: 'apply' }), null);      // http, not a socket
    assert.equal(liveEndpoint(plugin, { endpoint: 'other' }), null);
    assert.equal(liveEndpoint({}, { endpoint: 'changed' }), null);
    assert.equal(liveEndpoint(plugin, null), null);
});

test('pushWants: only {"what":"skin"} skips the workflow re-read', () => {
    const both = { skin: true, workflow: true };
    assert.deepEqual(pushWants('{"what":"skin"}'), { skin: true, workflow: false });
    assert.deepEqual(pushWants({ what: 'skin' }), { skin: true, workflow: false });
    assert.deepEqual(pushWants('{"what":"workflow"}'), both);
    assert.deepEqual(pushWants('{}'), both);
    assert.deepEqual(pushWants('not json'), both);
    assert.deepEqual(pushWants(undefined), both);
    assert.deepEqual(pushWants('null'), both);
    assert.deepEqual(pushWants('"skin"'), both);
});

// A plugin's push used to wait out the whole window before anything was read,
// so a dose Decent Sync shared cost that window on top of everything else
// (issue #174). The first push of a burst now runs at once and the window only
// coalesces what lands behind it.
function fakeTimers() {
    let seq = 0;
    const pending = new Map();
    return {
        setTimer: (fn) => { const id = ++seq; pending.set(id, fn); return id; },
        clearTimer: (id) => pending.delete(id),
        fire() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); },
        pending: () => pending.size,
    };
}

function coalescer() {
    const timers = fakeTimers();
    const runs = [];
    const { push, reset } = createPushCoalescer({
        run: (workflow) => runs.push(workflow),
        windowMs: 300,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
    });
    return { push, reset, runs, timers };
}

test('createPushCoalescer: the first push runs at once, the rest wait out the window', () => {
    const c = coalescer();
    c.push(true);
    assert.deepEqual(c.runs, [true], 'read on the first message, not after the window');
    c.push(true);
    c.push(true);
    assert.deepEqual(c.runs, [true], 'a burst behind it costs no extra read inside the window');
    c.timers.fire();
    assert.deepEqual(c.runs, [true, true], 'one trailing read for everything the window swallowed');
    c.timers.fire();
    assert.deepEqual(c.runs, [true, true], 'a window that swallowed nothing does not run again');
    assert.equal(c.timers.pending(), 0, 'and does not leave a timer behind');
});

test('createPushCoalescer: a swallowed workflow push is not lost behind a skin-only one', () => {
    const c = coalescer();
    c.push(false);
    assert.deepEqual(c.runs, [false]);
    c.push(false);
    c.push(true);  // a real workflow change, inside the window
    c.timers.fire();
    assert.deepEqual(c.runs, [false, true], 'the window ORs what it swallowed');

    const skinOnly = coalescer();
    skinOnly.push(true);
    skinOnly.push(false);
    skinOnly.timers.fire();
    assert.deepEqual(skinOnly.runs, [true, false], 'and does not invent a workflow read');
});

test('createPushCoalescer: reset drops the open window and its queue', () => {
    const c = coalescer();
    c.push(true);
    c.push(true);
    c.reset();
    assert.equal(c.timers.pending(), 0);
    c.push(true);
    assert.deepEqual(c.runs, [true, true], 'the next push after a reset is a first push again');
    c.timers.fire();
    assert.deepEqual(c.runs, [true, true], 'nothing was carried across the reset');
});

test('an empty surfaces list with live is a valid answer', () => {
    assert.deepEqual(parseSkinAnswer({ version: 1, surfaces: [], live: { endpoint: 'changed' } }),
        { surfaces: [], live: { endpoint: 'changed' } });
});

const strip = body => parseSkinAnswer({ version: 1, surfaces: [{ id: 's', kind: 'shot-strip', ...body }] }).surfaces[0];

test('shot-strip: built-in and own cells parse, bad ones drop, nine at most, show defaults to shot', () => {
    const s = strip({ cells: [
        { cell: 'weight', color: 'weight', bar: true, dot: { greenWithin: 0.05, amberWithin: 0.15 } },
        { cell: 'step', bar: true, dot: { greenWithin: 0.05, amberWithin: 0.15 }, color: 'nope' },
        { cell: 'nope' }, { label: 'Pre', text: '12 s', color: 'accent' }, { label: 'x' }, null,
        ...Array(8).fill({ cell: 'flow' })] });
    assert.equal(s.show, 'shot');
    assert.equal(s.cells.length, STRIP_MAX_CELLS);
    assert.deepEqual(s.cells[0].dot.colors, { good: 'ongoing', warn: 'amber', bad: 'red' });
    assert.equal(s.cells[0].bar, true);
    assert.equal(strip({ cells: [{ cell: 'flow', goalSize: 'medium' }, { cell: 'step', goalSize: 'large' }, { cell: 'weight', goalSize: 'huge' }] }).cells
        .map(c => c.goalSize).join(), 'medium,,');
    assert.equal(strip({ cells: [{ cell: 'flow', goalSize: 'small' }] }).cells[0].goalSize, 'small');
    assert.deepEqual(s.cells[1], { cell: 'step', col: 2, span: 1 }); // no goal: dot, bar and the unknown colour are dropped
    assert.deepEqual(s.cells[2], { label: 'Pre', text: '12 s', color: 'accent', col: 3, span: 1 });
    assert.equal(strip({ show: 'always', cells: [{ cell: 'flow' }] }).show, 'always');
    assert.equal(strip({ show: 'x', cells: [{ cell: 'flow' }] }).show, 'shot');
    assert.equal(strip({ cells: [] }), undefined);
    assert.equal(strip({}), undefined);
});

test('shot-strip: dot thresholds must be ordered and colours come from the token list', () => {
    const dot = d => strip({ cells: [{ cell: 'flow', dot: d }] }).cells[0].dot;
    assert.equal(dot({ greenWithin: 0.2, amberWithin: 0.1 }), undefined);
    assert.equal(dot({ greenWithin: 0, amberWithin: 0.1 }), undefined);
    assert.equal(dot({ greenWithin: 0.1 }), undefined);
    assert.deepEqual(dot({ greenWithin: 0.1, amberWithin: 0.3, colors: { good: 'flow', bad: '#f00', warn: 7 } }).colors,
        { good: 'flow', warn: 'amber', bad: 'red' });
});

test('shot-strip: one per plugin, the second is dropped', () => {
    const cells = [{ cell: 'flow' }];
    const out = parseSkinAnswer({ version: 1, surfaces: [
        { id: 'a', kind: 'shot-strip', cells }, { id: 'b', kind: 'shot-strip', cells }] });
    assert.deepEqual(out.surfaces.map(x => x.id), ['a']);
});

test('stripReading: goals follow the step\'s control mode', () => {
    const sample = { pressure: 8.5, flow: 2, targetPressure: 9, targetFlow: 2.2, groupTemperature: 92, mixTemperature: 93, targetMixTemperature: 93, targetGroupTemperature: 90 };
    assert.deepEqual(stripReading('pressure', { sample, step: { pump: 'pressure' } }), { value: 8.5, goal: 9 });
    assert.equal(stripReading('pressure', { sample, step: { pump: 'flow' } }).goal, null);
    assert.equal(stripReading('flow', { sample, step: { pump: 'pressure' } }).goal, null);
    assert.equal(stripReading('flow', { sample }).goal, 2.2);
    assert.deepEqual(stripReading('weight', { weight: 20.5, yieldGoal: 36 }), { value: 20.5, goal: 36 });
    assert.deepEqual(stripReading('weight', {}), { value: null, goal: null });
    assert.equal(stripReading('waterTemp', { sample: { mixTemperature: 90, targetMixTemperature: 0 } }).goal, null);
    assert.deepEqual(stripReading('puckTemp', { sample }), { value: 92, goal: 90 });
    assert.deepEqual(stripReading('weightFlow', { weightFlow: 1.8 }), { value: 1.8, goal: null });
    assert.deepEqual(stripReading('weightFlow', { weightFlow: 0 }), { value: 0, goal: null });
    assert.deepEqual(stripReading('weightFlow', {}), { value: null, goal: null });
    assert.equal(stripReading('waterTemp', { sample }).goal, 93);
});

test('stripDotLevel and stripBarFraction judge a reading against its goal', () => {
    const dot = { greenWithin: 0.05, amberWithin: 0.15 };
    assert.equal(stripDotLevel(dot, 9.4, 9), 'good');
    assert.equal(stripDotLevel(dot, 8.0, 9), 'warn');
    assert.equal(stripDotLevel(dot, 6, 9), 'bad');
    assert.equal(stripDotLevel(dot, 12, 9), 'bad'); // over counts as much as under
    assert.equal(stripDotLevel(dot, null, 9), null);
    assert.equal(stripDotLevel(dot, 9, 0), null);
    assert.equal(stripDotLevel(null, 9, 9), null);
    assert.equal(stripBarFraction(18, 36), 0.5);
    assert.equal(stripBarFraction(50, 36), 1);
    assert.equal(stripBarFraction(-1, 36), 0);
    assert.equal(stripBarFraction(5, 0), null);
    assert.equal(stripBarFraction(2, null, 8), 0.25); // no goal: the scale
    assert.equal(stripBarFraction(2, 4, 8), 0.5); // a goal wins
    assert.equal(stripBarFraction(2, null, null), null);
    assert.equal(strip({ cells: [{ cell: 'flow', bar: true, barMax: 1001 }, { cell: 'flow', bar: true, barMax: '6' }] }).cells
        .map(c => c.barMax).join(), ',6');
    assert.deepEqual(STRIP_BAR_MAX, { pressure: 12, flow: 8, puckTemp: 100, waterTemp: 100 });
    assert.equal(strip({ cells: [{ cell: 'flow', bar: true, barMax: 6 }, { cell: 'flow', bar: true, barMax: -1 }, { cell: 'flow', barMax: 6 }] }).cells
        .map(c => c.barMax).join(), '6,,');
});

test('stripLayout: nine columns; explicit columns kept, overlaps dropped, the rest fill left to right', () => {
    assert.equal(STRIP_COLUMNS, 9);
    const at = cells => stripLayout(cells).map(c => `${c.id}:${c.col}+${c.span}`).join(' ');
    assert.equal(at([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), 'a:1+2 b:3+2 c:5+2');
    assert.equal(at(Array.from({ length: 9 }, (_, i) => ({ id: i }))), '0:1+1 1:2+1 2:3+1 3:4+1 4:5+1 5:6+1 6:7+1 7:8+1 8:9+1');
    assert.equal(at([{ id: 'a' }, { id: 'b', col: 1, span: 3 }]), 'b:1+3 a:4+2'); // explicit cells are placed first
    assert.equal(at([{ id: 'a', col: 3, span: 2 }, { id: 'b', col: 4 }]), 'a:3+2'); // b overlaps a: dropped
    assert.equal(at([{ id: 'a', col: 8, span: 5 }]), 'a:8+2'); // cut at the grid's edge
    assert.equal(at([{ id: 'a', col: 1, span: 9 }, { id: 'b' }]), 'a:1+9'); // no room left
    assert.equal(at([{ id: 'a', col: 1 }, { id: 'b', col: 2 }, { id: 'c', col: 3 }]), 'a:1+1 b:2+1 c:3+1'); // col alone is one column
    assert.equal(at([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]), '1:1+2 2:3+2 3:5+2 4:7+2 5:9+1'); // 2 columns while room allows
    assert.equal(at([{ id: 'w', col: 1, span: 3 }, ...[1, 2, 3, 4, 5].map(id => ({ id }))]), 'w:1+3 1:4+2 2:6+1 3:7+1 4:8+1 5:9+1');
});

test('shot-strip: col and span parse as grid integers and place the cells', () => {
    const s = strip({ cells: [{ cell: 'weight', col: 1, span: 4, bar: true }, { cell: 'flow', col: 12 }, { cell: 'pressure', col: 6, span: 0 },
        { cell: 'step', col: 9, span: 1.5 }] });
    assert.deepEqual(s.cells.map(c => `${c.cell}:${c.col}+${c.span}`), ['weight:1+4', 'pressure:6+1', 'flow:7+2', 'step:9+1']); // flow's col 12 is off the grid: it fills free columns
});

// ── menu-item: entries in the skin's long-press menus ───────────────────────
{
    const { pluginMenuEntries, setMenuEntries, setMenuRunner, menuItemLabel } = await import('../src/modules/plugin-menu-items.js');
    const answer = surfaces => parseSkinAnswer({ version: 1, surfaces }).surfaces;
    const open = { type: 'open', view: 'rate', presentation: 'overlay' };

    test('menu-item: needs a known menu, a label and an open or call action', () => {
        const [ok] = answer([{ id: 'a', kind: 'menu-item', menu: 'shot-history', label: 'Rate this shot', action: open }]);
        assert.deepEqual(ok, { id: 'a', kind: 'menu-item', menu: 'shot-history', label: 'Rate this shot',
            action: { type: 'open', view: 'rate', presentation: 'overlay' } });
        assert.equal(answer([{ id: 'a', kind: 'menu-item', menu: 'profile', label: 'x', action: open }]).length, 1);
        assert.equal(answer([{ id: 'a', kind: 'menu-item', menu: 'nope', label: 'x', action: open }]).length, 0);
        assert.equal(answer([{ id: 'a', kind: 'menu-item', menu: 'favourite', label: '', action: open }]).length, 0);
        assert.equal(answer([{ id: 'a', kind: 'menu-item', menu: 'favourite', label: 'x' }]).length, 0);
        // set / step are for tiles, not menus
        assert.equal(answer([{ id: 'a', kind: 'menu-item', menu: 'favourite', label: 'x',
            action: { type: 'set', field: 'targetDoseWeight', value: 18 } }]).length, 0);
    });

    test('menu-item call: an endpoint only, and not one Decaid serves itself', () => {
        const call = endpoint => answer([{ id: 'a', kind: 'menu-item', menu: 'favourite', label: 'Note', action: { type: 'call', endpoint } }]);
        assert.deepEqual(call('note')[0].action, { type: 'call', endpoint: 'note' });
        assert.equal(call('settings').length, 0);
        assert.equal(call('skin').length, 0);
        assert.equal(call('../x').length, 0);
    });

    test('menu-item: at most three per plugin per menu, other menus unaffected', () => {
        const item = (id, menu) => ({ id, kind: 'menu-item', menu, label: id, action: open });
        const out = answer([item('a', 'favourite'), item('b', 'favourite'), item('c', 'favourite'), item('d', 'favourite'), item('e', 'shot-history')]);
        assert.deepEqual(out.map(s => s.id), ['a', 'b', 'c', 'e']);
    });

    test('menu entries: divider, plugin name on each label, per-menu cap, empty without plugins', () => {
        const ran = [];
        setMenuRunner((entry, context) => ran.push([entry.surface.id, context]));
        setMenuEntries([]);
        assert.deepEqual(pluginMenuEntries('shot-history', { shotId: '1' }), []);
        const entry = (id, menu, name = 'Derek') => ({ plugin: { id: 'p', name }, surface: { id, kind: 'menu-item', menu, label: `L${id}`, action: open } });
        setMenuEntries([entry('a', 'shot-history'), entry('b', 'favourite'), ...Array.from({ length: 8 }, (_, i) => entry(`x${i}`, 'shot-history', 'A very long plugin name'))]);
        const items = pluginMenuEntries('shot-history', { shotId: '9' });
        assert.equal(items[0].divider, true);
        assert.equal(items.length, 1 + 6, 'six entries at most');
        assert.equal(items[1].label, 'La · Derek');
        assert.equal(items[2].label, 'Lx0 · A very long pl');
        items[1].onSelect();
        assert.deepEqual(ran, [['a', { shotId: '9' }]]);
        assert.deepEqual(pluginMenuEntries('favourite', { slot: 2 }).map(i => i.label).slice(1), ['Lb · Derek']);
        assert.equal(menuItemLabel('Rate', ''), 'Rate');
        // a blank or invisible name falls back to the id, never to a bare label
        setMenuRunner(() => {});
        setMenuEntries([{ plugin: { id: 'derek', name: '  \u200B ' }, surface: { id: 'z', kind: 'menu-item', menu: 'favourite', label: 'Delete shot', action: open } }]);
        assert.equal(pluginMenuEntries('favourite', {})[1].label, 'Delete shot · derek');
        setMenuRunner(null);
        assert.deepEqual(pluginMenuEntries('shot-history', {}), []);
    });
}

test('telemetry-label: puck only, short text, first one wins', () => {
    const lab = (o = {}) => ok([{ id: 'l', kind: 'telemetry-label', target: 'puck', text: 'Coffee', ...o }]);
    assert.deepEqual(lab(), [{ id: 'l', kind: 'telemetry-label', target: 'puck', text: 'Coffee' }]);
    assert.equal(lab({ target: 'water' }).length, 0);
    assert.equal(lab({ text: '' }).length, 0);
    assert.equal(lab({ text: 'x'.repeat(40) })[0].text.length, 24);
});

test('tile-sync: only the grind tile, a number clamped to the field, first one wins', () => {
    const sync = (o = {}) => ok([{ id: 'g', kind: 'tile-sync', tile: 'grind', value: 200, ...o }]);
    assert.deepEqual(sync(), [{ id: 'g', kind: 'tile-sync', tile: 'grind', value: 200 }]);
    assert.equal(sync({ value: '56.4' })[0].value, 56.4);
    assert.equal(sync({ value: 99999 })[0].value, 9999);
    assert.equal(sync({ label: 'MT80' })[0].label, 'MT80');
    assert.deepEqual(sync({ value: 'x' }), []);
    assert.deepEqual(sync({ value: null }), []);
    assert.deepEqual(sync({ tile: 'dose' }), []);
    assert.equal(ok([{ id: 'a', kind: 'tile-sync', tile: 'grind', value: 1 },
        { id: 'b', kind: 'tile-sync', tile: 'grind', value: 2 }]).length, 1);
});

test('stepsize custom: a typed step is kept, sizes may be empty only with custom', () => {
    assert.deepEqual(ok([stepsize({ custom: true })])[0].action,
        { type: 'stepsize', field: 'targetDoseWeight', sizes: [1, 0.5, 0.1], custom: true });
    assert.equal(ok([stepsize({ custom: 'yes' })])[0].action.custom, undefined);
    assert.deepEqual(ok([stepsize({ field: 'grinderSetting', sizes: [], custom: true })])[0].action,
        { type: 'stepsize', field: 'grinderSetting', sizes: [], custom: true });
    assert.equal(ok([stepsize({ sizes: [] })])[0].action, undefined); // without custom an empty list is dropped
    // resolve: a typed step wins only on a custom surface, within (0, 10] and hundredths
    assert.equal(resolveStepSize([1, 5], 2.5, true), 2.5);
    assert.equal(resolveStepSize([1, 5], 2.5, false), 1);
    assert.equal(resolveStepSize([1, 5], 12, true), 1);
    assert.equal(resolveStepSize([1, 5], 0, true), 1);
    assert.equal(resolveStepSize([1, 5], 0.123, true), 1);
    assert.equal(resolveStepSize([], null, true), 1);
    assert.equal(resolveStepSize([], 0.25, true), 0.25);
    // a tap from a typed step goes back to the first offered size
    assert.equal(nextStepSize([1, 5], 2.5), 1);
});
