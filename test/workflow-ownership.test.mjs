// The workflow-ownership contract (#165).
//
// The live workflow is one deep-merged JSON document with no revision. Writers
// are sequential and each believes it is authorised, so a revision check would
// pass every one of the writes that caused #143/#144/#147-#149/#153/#155-#158.
// The contract is therefore about ownership, not concurrency: each writer says
// what it owns, and sending anything else is an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
    WORKFLOW_WRITERS, workflowPatchKeys, fieldIsDeclared,
    undeclaredFields, assertDeclaredFields, clearInheritedFields,
    RECIPE_CLEARED_IDENTITY, RECIPE_CLEARED_IDENTITY_EXTRAS,
    RECIPE_CLEARED_NUMBERS, RECIPE_CLEARED_NUMBER_EXTRAS, RECIPE_CLEARED_TO_ZERO,
} from '../src/modules/workflow-fields.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir = SRC, out = []) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, out);
        else if (entry.endsWith('.js')) out.push(path);
    }
    return out;
}

// Pull out the argument list of every updateWorkflow(...) call, balancing
// parens so a nested call or object literal does not truncate it.
function updateWorkflowCalls(source) {
    const calls = [];
    const re = /(?<![\w.])updateWorkflow\(/g;
    let m;
    while ((m = re.exec(source))) {
        let depth = 1, i = re.lastIndex;
        for (; i < source.length && depth; i++) {
            const c = source[i];
            if (c === '(') depth++;
            else if (c === ')') depth--;
        }
        calls.push(source.slice(re.lastIndex, i - 1));
    }
    return calls;
}

// Split on top-level commas only.
function topLevelArgs(args) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < args.length; i++) {
        const c = args[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ',' && depth === 0) { parts.push(args.slice(start, i)); start = i + 1; }
    }
    parts.push(args.slice(start));
    return parts.map(p => p.trim()).filter(Boolean);
}

test('every workflow write names a writer that is in the registry', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
        const source = readFileSync(file, 'utf8');
        // api.js declares the function; its own body is not a call site.
        const body = source.replace(/export async function updateWorkflow\([\s\S]*?\n\}/, '');
        for (const args of updateWorkflowCalls(body)) {
            const parts = topLevelArgs(args);
            const writer = parts[1];
            const quoted = writer && /^'[^']+'$/.test(writer) && writer.slice(1, -1);
            if (!quoted || !(quoted in WORKFLOW_WRITERS)) {
                offenders.push(`${file.replace(SRC, 'src')}: updateWorkflow(${args.slice(0, 60)}...) -> ${writer ?? 'no writer'}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `every call site must declare a known writer:\n${offenders.join('\n')}`);
});

// Adding a key here is the visible diff the contract exists to produce: it means
// a writer took ownership of something it did not own, which is a decision.
const SNAPSHOT = {
    'api.autoSteam': 'steamSettings.duration steamSettings.flow steamSettings.stopAtTemperature steamSettings.targetTemperature',
    'api.hotWater': 'hotWaterData.duration hotWaterData.flow hotWaterData.targetTemperature hotWaterData.volume',
    'api.sendProfile': 'profile',
    'api.steamDuration': 'steamSettings.duration',
    'api.steamFlow': 'steamSettings.flow',
    'api.steamHeater': 'steamSettings',
    'api.steamStopAt': 'steamSettings.stopAtTemperature',
    'api.steamTemp': 'steamSettings.targetTemperature',
    'beans.select': 'context.beanBatchId context.coffeeName context.coffeeRoaster',
    'dye.applyFavourite': 'context.baristaName context.basket context.beanBatchId context.coffeeName context.coffeeRoaster context.drinkerName context.extras.basketId context.extras.basketName context.extras.dye context.extras.feedRate context.extras.note context.extras.rpm context.grinderId context.grinderModel context.grinderSetting context.roastDate context.targetDoseWeight context.targetYield profile',
    'dye.applyRecipe': 'context.baristaName context.basket context.beanBatchId context.coffeeName context.coffeeRoaster context.drinkerName context.extras.basketId context.extras.basketName context.extras.dye context.extras.feedRate context.extras.rpm context.grinderId context.grinderModel context.grinderSetting context.targetDoseWeight context.targetYield hotWaterData.duration hotWaterData.flow hotWaterData.targetTemperature hotWaterData.volume profile rinseData steamSettings.duration steamSettings.flow steamSettings.stopAtTemperature steamSettings.targetTemperature',
    'dye.clearOnDisable': 'context.baristaName context.basket context.beanBatchId context.coffeeName context.coffeeRoaster context.drinkerName context.extras.dye context.extras.rpm',
    'profile.resetDefaults': 'context.extras.dye context.grinderSetting context.targetDoseWeight context.targetYield profile',
    'profile.send': 'context.extras.dye context.grinderSetting context.targetDoseWeight context.targetYield profile',
    'profile.wake': 'context.extras.dye context.grinderSetting context.targetDoseWeight context.targetYield profile',
    'settings.hotWater': 'hotWaterData.duration hotWaterData.flow hotWaterData.targetTemperature hotWaterData.volume',
    'settings.rinse': 'rinseData',
    'settings.steam': 'steamSettings.duration steamSettings.flow steamSettings.stopAtTemperature steamSettings.targetTemperature',
    'shot.clearNote': 'context.extras.note',
    'tiles.brewTemp': 'profile.steps',
    'tiles.doseYield': 'context.targetDoseWeight context.targetYield profile.target_weight',
    'tiles.flush': 'rinseData.duration',
    'tiles.grind': 'context.grinderSetting',
    'tiles.hotWater': 'hotWaterData.duration hotWaterData.flow hotWaterData.targetTemperature hotWaterData.volume',
    'tiles.steam': 'steamSettings.duration steamSettings.flow steamSettings.targetTemperature',
};

test('the declared field set of every writer is snapshotted', () => {
    const actual = Object.fromEntries(
        Object.entries(WORKFLOW_WRITERS).map(([writer, fields]) => [writer, [...fields].sort().join(' ')]));
    assert.deepEqual(actual, SNAPSHOT);
});

test('a patch flattens to the field paths it writes', () => {
    assert.deepEqual(workflowPatchKeys({ context: { targetYield: 36 } }), ['context.targetYield']);
    assert.deepEqual(workflowPatchKeys({ context: { extras: { dye: { recipeId: 'r1' } } } }),
        ['context.extras.dye.recipeId']);
    // profile is walked one level: a writer that owns the stop weight must not
    // get to send a whole profile document under the same declaration (#155).
    assert.deepEqual(workflowPatchKeys({ profile: { title: 'x', steps: [1, 2] } }), ['profile.title', 'profile.steps']);
    assert.deepEqual(workflowPatchKeys({ profile: { target_weight: 36 } }), ['profile.target_weight']);
    // null is a write (it clears), not an absence.
    assert.deepEqual(workflowPatchKeys({ context: { grinderSetting: null } }), ['context.grinderSetting']);
    // An empty object still declares intent to touch that block.
    assert.deepEqual(workflowPatchKeys({ steamSettings: {} }), ['steamSettings']);
    assert.deepEqual(workflowPatchKeys({}), []);
});

test('declaring a group owns everything under it, a leaf owns only itself', () => {
    assert.equal(fieldIsDeclared('context.targetYield', ['context']), true);
    assert.equal(fieldIsDeclared('context.targetYield', ['context.targetYield']), true);
    assert.equal(fieldIsDeclared('context.targetYield', ['context.targetDoseWeight']), false);
    // A prefix that is not a path boundary must not match.
    assert.equal(fieldIsDeclared('contextual', ['context']), false);
    assert.equal(fieldIsDeclared('context', ['context.targetYield']), false);
});

test('an undeclared field is named, and the writer must be known', () => {
    assert.deepEqual(
        undeclaredFields({ context: { targetYield: 36, coffeeName: 'x' } }, ['context.targetYield']),
        ['context.coffeeName']);
    assert.deepEqual(undeclaredFields({ context: { targetYield: 36 } }, ['context.targetYield']), []);

    assert.throws(() => assertDeclaredFields('nope', {}), /unknown writer 'nope'/);
    assert.throws(
        () => assertDeclaredFields('tiles.grind', { context: { grinderSetting: 5, targetYield: 36 } }),
        /sent undeclared field\(s\) context\.targetYield/);
    assert.equal(assertDeclaredFields('tiles.grind', { context: { grinderSetting: 5 } }), true);
});

test('the duration-only steam patch (0 = no timer) is accepted by its writer', () => {
    assert.equal(assertDeclaredFields('api.steamDuration', { steamSettings: { duration: 0 } }), true);
    assert.throws(
        () => assertDeclaredFields('api.steamDuration', { steamSettings: { duration: 0, targetTemperature: 0 } }),
        /sent undeclared field\(s\) steamSettings\.targetTemperature/);
});

test('the whole-document write the contract exists to stop is rejected', () => {
    // This is what dyeStrip used to do: GET the workflow, mutate it, PUT it all
    // back -- carrying every field it did not own over a newer value.
    const live = {
        profile: { title: 'Londinium' },
        context: { targetYield: 36, coffeeName: 'Ethiopia', baristaName: 'Sam' },
        steamSettings: { duration: 30, flow: 1.2 },
        hotWaterData: { volume: 200 },
        rinseData: { duration: 5 },
    };
    assert.throws(() => assertDeclaredFields('tiles.grind', live), /sent undeclared field/);
    assert.throws(() => assertDeclaredFields('profile.send', live), /steamSettings\.duration/);

    // The #155 shape: the dose tile may move the stop weight, but sending the
    // profile it read -- brew temperature and all -- is the bug.
    assert.equal(assertDeclaredFields('tiles.doseYield', { profile: { target_weight: 36 } }), true);
    assert.throws(
        () => assertDeclaredFields('tiles.doseYield', { profile: { target_weight: 36, steps: [{ temperature: 93 }] } }),
        /profile\.steps/);
});

test('the docs precedence table names the same fields the code declares', () => {
    // Acceptance criterion 4: the table in docs/ has to match the registry, or
    // it becomes the usual stale prose that says the opposite of the code.
    const doc = readFileSync(new URL('../docs/AI_WORKFLOW_NOTES.md', import.meta.url), 'utf8');
    const declared = new Set(Object.values(WORKFLOW_WRITERS).flat());

    // Every contested field the table names must be a field some writer owns.
    const tabled = [...doc.matchAll(/`(context\.[a-zA-Z.]+|steamSettings|hotWaterData|rinseData|profile)`/g)]
        .map(m => m[1]);
    assert.ok(tabled.length > 5, 'the table should name the fields it governs');
    for (const field of new Set(tabled)) {
        assert.ok([...declared].some(d => d === field || d.startsWith(`${field}.`) || field.startsWith(`${d}.`)),
            `docs name ${field}, which no writer declares`);
    }

    // Every writer prefix must be documented, or a new surface slips in unnamed.
    for (const writer of Object.keys(WORKFLOW_WRITERS)) {
        const prefix = writer.split('.')[0];
        assert.ok(doc.includes(`\`${prefix}.*\``), `docs do not describe the '${prefix}.*' writers`);
    }
});

// --- the recipe claim on the apply paths (dye2#36) ------------------------
// mergeContext is what keeps the claim from flattening the extras the legacy
// paths already put in the patch (rpm, note). Lifted from dyeStrip.js, which
// touches the DOM at module load.
const dyeSource = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
const mergeContext = new Function(
    `${dyeSource.match(/function mergeContext\(patch, fragment\)[\s\S]*?\n\}/)[0]}\nreturn mergeContext;`)();

test('claiming a recipe does not flatten the extras already in the patch', () => {
    // The legacy favourite/recipe paths put rpm and note in extras before the
    // claim is folded in; replacing extras wholesale would drop them.
    const patch = { context: { targetYield: 36, extras: { rpm: 900, note: 'hi' } } };
    mergeContext(patch, { extras: { dye: { v: 1, recipeId: 'r1' } } });
    assert.deepEqual(patch.context, {
        targetYield: 36,
        extras: { rpm: 900, note: 'hi', dye: { v: 1, recipeId: 'r1' } },
    });

    // And it works on a patch that has no context at all yet.
    const empty = {};
    mergeContext(empty, { extras: { dye: { v: 1, recipeId: null } } });
    assert.deepEqual(empty.context, { extras: { dye: { v: 1, recipeId: null } } });
});

test('every apply path and every profile switch settles the recipe claim', () => {
    // A write that forgets this leaves a stale recipe highlighted and records
    // the next shot's dial-in onto it -- #153/#155 in a new field.
    for (const fn of ['applyFavourite', 'applyRecipe']) {
        const body = dyeSource.match(new RegExp('export async function ' + fn + '\\([\\s\\S]*?\\n\\}'))[0];
        assert.match(body, /mergeContext\(patch, recipeIdPatch\(/, `${fn} must settle the claim`);
    }
    // A favourite releases; a recipe claims itself.
    assert.match(dyeSource.match(/export async function applyFavourite\([\s\S]*?\n\}/)[0],
        /recipeIdPatch\(null\)/);
    assert.match(dyeSource.match(/export async function applyRecipe\([\s\S]*?\n\}/)[0],
        /recipeIdPatch\(recipe\.id\)/);

    // A profile change nulls it from any source: the recipe's identity is its
    // profile. Every writer that sends one must declare and send the release.
    for (const writer of ['profile.send', 'profile.wake', 'profile.resetDefaults']) {
        assert.ok(WORKFLOW_WRITERS[writer].includes('context.extras.dye'),
            `${writer} replaces the profile, so it must own the recipe claim`);
        // All three hand over a built profile document, so all three own `profile`.
        // profile.wake was the sibling that did not, and assertDeclaredFields threw
        // before every wake PUT -- the feature was dead, silently (dye2 #39).
        assert.ok(WORKFLOW_WRITERS[writer].includes('profile'),
            `${writer} sends a profile document, so it must own 'profile'`);
    }
    // The payload is sometimes a literal at the call and sometimes a variable
    // built above it. Resolve the variable rather than searching nearby text --
    // a neighbouring call's release must not vouch for this one.
    for (const file of ['../src/modules/profileManager.js', '../src/modules/profile_selector.js']) {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');
        const calls = updateWorkflowCalls(source)
            .filter(a => /'profile\.(send|wake|resetDefaults)'/.test(a));
        assert.ok(calls.length, `${file} should contain profile writes`);
        for (const args of calls) {
            const payload = topLevelArgs(args)[0].trim();
            let text = payload;
            if (/^[A-Za-z_$][\w$]*$/.test(payload)) {
                const decl = source.match(new RegExp('(?:const|let|var)\\s+' + payload + '\\s*=\\s*\\{'));
                assert.ok(decl, `cannot find where ${payload} is built in ${file}`);
                let i = decl.index + decl[0].length - 1, depth = 0;
                const from = i;
                for (; i < source.length; i++) {
                    if (source[i] === '{') depth++;
                    else if (source[i] === '}' && !--depth) { i++; break; }
                }
                text = source.slice(from, i);
            }
            assert.match(text, /recipeIdPatch\(null\)/,
                `a profile write in ${file} does not release the recipe: ${payload.slice(0, 60)}`);
        }
    }
});

// --- a recipe apply does not inherit the last item's identities (#189) -----
//
// The complaint: tap a recipe that records a grinder, then one that does not,
// and the second shot is filed under the first one's grinder, basket and
// barista. The deep merge reads an omitted key as "leave unchanged".

test('a recipe apply clears the identities it does not name, as explicit nulls', () => {
    const ctx = clearInheritedFields({ targetDoseWeight: 18, grinderSetting: '7.5' });
    for (const field of RECIPE_CLEARED_IDENTITY) {
        assert.ok(field in ctx, `${field} must be sent -- an absent key deep-merges away`);
        assert.equal(ctx[field], null);
    }
    for (const field of RECIPE_CLEARED_IDENTITY_EXTRAS) {
        assert.ok(field in ctx.extras, `extras.${field} must be sent as an explicit null`);
        assert.equal(ctx.extras[field], null);
    }
    // The numbers it does name are its own and stay.
    assert.equal(ctx.targetDoseWeight, 18);
    assert.equal(ctx.grinderSetting, '7.5');
});

test('a recipe apply clears the numbers it does not name too', () => {
    // A recipe is the whole shot, not an overlay on the last one: an unnamed number
    // is "this recipe has none", and the previous recipe's value must not stand in.
    const ctx = clearInheritedFields({ grinderSetting: '7.5' });
    for (const field of RECIPE_CLEARED_NUMBERS.filter(f => f !== 'grinderSetting')) {
        assert.ok(field in ctx, `${field} must be sent -- an absent key deep-merges away`);
        assert.equal(ctx[field], null);
    }
    for (const field of RECIPE_CLEARED_NUMBER_EXTRAS) {
        assert.ok(field in ctx.extras, `extras.${field} must be sent as an explicit null`);
        assert.equal(ctx.extras[field], null);
    }
    assert.equal(ctx.grinderSetting, '7.5', 'the one it does name is kept');
    // 0 is an absence, exactly as '' is: a recipe recording a dose of 0 records none.
    assert.equal(clearInheritedFields({ targetDoseWeight: 0 }).targetDoseWeight, null);
    assert.equal(clearInheritedFields({ extras: { rpm: 0 } }).extras.rpm, null);
});

test('targetYield is cleared to 0, never to null -- Decaid rejects the null', () => {
    // workflow_handler.dart passes targetYield to rejectExplicitNulls, which throws a
    // FormatException -> 400 for the WHOLE PUT. 0 is Decaid's own documented clear
    // for the field (stop-at-weight off), so a recipe naming no yield writes that.
    assert.deepEqual(RECIPE_CLEARED_TO_ZERO, ['targetYield']);
    assert.equal(clearInheritedFields({}).targetYield, 0);
    assert.equal(clearInheritedFields({ targetYield: 0 }).targetYield, 0);
    assert.equal(clearInheritedFields({ targetYield: 40 }).targetYield, 40, 'a named yield stays');
    assert.ok(!RECIPE_CLEARED_NUMBERS.includes('targetYield'),
        'targetYield must not also be in the null list');
});

test('a recipe apply keeps the identities it does name', () => {
    const ctx = clearInheritedFields({
        grinderId: 'g-1', grinderModel: 'Niche', baristaName: 'Vid',
        extras: { basketId: 'bk-1', basketName: 'VST 18', rpm: 1400 },
    });
    assert.equal(ctx.grinderId, 'g-1');
    assert.equal(ctx.grinderModel, 'Niche');
    assert.equal(ctx.baristaName, 'Vid');
    assert.equal(ctx.extras.basketId, 'bk-1');
    assert.equal(ctx.extras.basketName, 'VST 18');
    assert.equal(ctx.extras.rpm, 1400);
    assert.equal(ctx.drinkerName, null, 'and the one it does not name is still cleared');
});

test('clearInheritedFields is pure and survives an empty patch', () => {
    const source = { grinderId: 'g-1' };
    const out = clearInheritedFields(source);
    assert.notEqual(out, source);
    assert.deepEqual(source, { grinderId: 'g-1' }, 'the input context is not mutated');
    // applyRecipe hands it patch.context, which is undefined when the item wrote
    // nothing: the clears are then the whole patch, which is the point.
    assert.equal(clearInheritedFields(undefined).grinderModel, null);
    assert.equal(clearInheritedFields(undefined).extras.basketName, null);
    assert.equal(clearInheritedFields(undefined).targetDoseWeight, null);
    // '' is an absence, as it is for DYE2's own builder (dev-api buildRecipeWorkflow).
    assert.equal(clearInheritedFields({ baristaName: '' }).baristaName, null);
});

test('every field the recipe clear writes is declared by dye.applyRecipe', () => {
    // Otherwise assertDeclaredFields throws before the PUT and the apply does nothing.
    assertDeclaredFields('dye.applyRecipe', { context: clearInheritedFields({}) });
});

test('the recipe clear is wired into applyRecipe and not into applyFavourite', () => {
    // A favourite carries a copyMask: the user ticked which fields it owns, so an
    // unticked one is a deliberate "do not touch" and it stays a pure overlay.
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const body = fn => source.slice(source.indexOf(`export async function ${fn}(`));
    const recipe = body('applyRecipe').slice(0, body('applyRecipe').indexOf('\n}\n'));
    const favourite = body('applyFavourite').slice(0, body('applyFavourite').indexOf('\n}\n'));
    assert.match(recipe, /clearInheritedFields\(patch\.context\)/);
    assert.ok(!/clearInheritedFields/.test(favourite), 'a favourite is an overlay, not a reset');
});
