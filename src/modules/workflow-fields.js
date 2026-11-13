// Who may write what in the live workflow. DOM-free so node:test can import it.
//
// The workflow is one JSON document with no revision and no ETag, and
// PUT /api/v1/workflow deep-merges whatever body it is given. Four writers
// touch it -- the skin's tiles and settings page, the skin's selector and wake
// path, DYE2, and the machine's own state reflected back through Decaid -- and
// each used to send the fields it happened to be holding, including ones it did
// not own and had not changed. A stale value then overwrote a newer one and
// nothing noticed.
//
// That is a precedence problem, not a concurrency one: an If-Match would pass
// every one of those writes, because the writers are sequential and each one
// believes it is authorised. So the fix is to make each writer say what it
// owns, and to fail loudly when it sends anything else.
//
// The precedence table this encodes lives in docs/AI_WORKFLOW_NOTES.md; the two
// must agree, and workflow-ownership.test.mjs checks that they do.

// `profile` IS walked into, one level down. A writer that only needs to move the
// stop weight should send `{ profile: { target_weight } }` and nothing else --
// sending the whole profile document is how the brew temperature a user set on
// the Brew tile got put back (#155). Arrays (notably `steps`) are leaves: the
// contract is about which profile field a writer owns, not which step.

/**
 * Flatten a workflow patch to the field paths it actually writes.
 * `{ context: { targetYield: 36 } }` -> `['context.targetYield']`.
 *
 * An empty object is a path in its own right: `{ context: {} }` writes nothing
 * but still declares intent to touch context, and a writer that sends it
 * should have to say so.
 */
export function workflowPatchKeys(patch, prefix = '') {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return prefix ? [prefix] : [];
    }
    const entries = Object.entries(patch);
    if (!entries.length) return prefix ? [prefix] : [];
    const keys = [];
    for (const [key, value] of entries) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            keys.push(path);
        } else {
            keys.push(...workflowPatchKeys(value, path));
        }
    }
    return keys;
}

/**
 * Does `declared` cover `path`? A writer that declares `context` owns
 * everything under it; one that declares `context.targetYield` owns only that.
 * Declaring coarsely is allowed where a writer genuinely owns the whole group;
 * the contested groups in the table are declared leaf by leaf on purpose.
 */
export function fieldIsDeclared(path, declared) {
    return declared.some(d => path === d || path.startsWith(`${d}.`));
}

/** Field paths a patch writes that its writer never declared. */
export function undeclaredFields(patch, declared) {
    return workflowPatchKeys(patch).filter(path => !fieldIsDeclared(path, declared || []));
}

// Every writer of the live workflow, and the fields it owns.
//
// Adding a key here is the visible diff the contract exists to produce: it
// means a writer has taken ownership of something it did not own before, and
// that is a decision, not a detail.
export const WORKFLOW_WRITERS = {
    // --- skin: the main-page tiles -----------------------------------------
    // The contested group (#153, #155). Each tile owns its own number and
    // nothing else; the dose/yield tiles also fold the yield into the profile's
    // target_weight, because a non-autonomous machine stops on that rather than
    // on context.targetYield.
    // targetWeightProfilePatch sends the stop weight alone, never the profile
    // document it came from -- that is the #155 fix, and this keeps it honest.
    'tiles.doseYield': ['context.targetDoseWeight', 'context.targetYield', 'profile.target_weight'],
    'tiles.grind': ['context.grinderSetting'],
    // brewTempProfilePatch sends { steps } and deliberately not target_weight.
    'tiles.brewTemp': ['profile.steps'],
    'tiles.steam': ['steamSettings.targetTemperature', 'steamSettings.duration', 'steamSettings.flow'],
    'tiles.flush': ['rinseData.duration'],
    'tiles.hotWater': ['hotWaterData.targetTemperature', 'hotWaterData.volume', 'hotWaterData.duration', 'hotWaterData.flow'],

    // --- skin: the settings page -------------------------------------------
    // #157: these used to send back the whole sub-object they had loaded. One
    // key per edit, so a concurrent write to a sibling key survives.
    'settings.steam': ['steamSettings.targetTemperature', 'steamSettings.duration', 'steamSettings.flow', 'steamSettings.stopAtTemperature'],
    'settings.hotWater': ['hotWaterData.targetTemperature', 'hotWaterData.volume', 'hotWaterData.duration', 'hotWaterData.flow'],
    'settings.rinse': ['rinseData'],

    // --- skin: api.js's own narrow setters ---------------------------------
    'api.steamTemp': ['steamSettings.targetTemperature'],
    'api.steamDuration': ['steamSettings.duration'],
    'api.steamFlow': ['steamSettings.flow'],
    'api.steamStopAt': ['steamSettings.stopAtTemperature'],
    'api.hotWater': ['hotWaterData.targetTemperature', 'hotWaterData.volume', 'hotWaterData.duration', 'hotWaterData.flow'],
    // clampAutoSteamSettings returns duration/flow plus the two temperatures
    // when they were supplied (auto-steam-safety.js).
    'api.autoSteam': ['steamSettings.duration', 'steamSettings.flow', 'steamSettings.targetTemperature', 'steamSettings.stopAtTemperature'],
    // steamHeaterFor returns { targetTemperature } or {} -- an empty object is
    // "nothing to change", which is why steamSettings itself is declared.
    'api.steamHeater': ['steamSettings'],
    'api.sendProfile': ['profile'],

    // --- skin: profile switches --------------------------------------------
    // A profile change nulls recipeId: the recipe's identity IS its profile.
    'profile.send': ['profile', 'context.targetDoseWeight', 'context.targetYield', 'context.grinderSetting', 'context.extras.dye'],
    // Waking sends the profile document, exactly as profile.send does -- omitting
    // `profile` here threw before the PUT and killed the feature outright (dye2 #39).
    'profile.wake': ['profile', 'context.targetDoseWeight', 'context.targetYield', 'context.grinderSetting', 'context.extras.dye'],
    'profile.resetDefaults': ['profile', 'context.targetDoseWeight', 'context.targetYield', 'context.grinderSetting', 'context.extras.dye'],

    // --- skin: bean identity -----------------------------------------------
    // Persistent across shots; nothing clears them (#164).
    'beans.select': ['context.coffeeName', 'context.coffeeRoaster', 'context.beanBatchId'],

    // --- skin: per-shot fields ---------------------------------------------
    // The note is the only field still cleared after a shot.
    'shot.clearNote': ['context.extras.note'],

    // --- DYE2 ---------------------------------------------------------------
    // extras.dye.recipeId is DYE2's alone: any other apply writes null.
    // applyStoredWorkflow copies the WHOLE stored context, so every key DYE2 puts in a
    // recipe's or favourite's `workflow.context` has to be declared here or
    // assertDeclaredFields throws before the PUT and the apply silently does nothing
    // (dye2 bug 5: a recipe carrying a grinder applied neither workflow nor variables).
    // The set below is what dev-api.ts buildRecipeWorkflow / buildFavouriteWorkflow write.
    // `context.basket` is kept for legacy rows; DYE2 itself writes extras.basketId/Name.
    'dye.applyFavourite': [
        'profile',
        'context.targetDoseWeight', 'context.targetYield', 'context.grinderSetting',
        'context.extras.rpm', 'context.extras.feedRate', 'context.extras.dye',
        'context.coffeeName', 'context.coffeeRoaster', 'context.beanBatchId',
        'context.baristaName', 'context.drinkerName', 'context.basket',
        'context.grinderId', 'context.grinderModel',
        'context.extras.basketId', 'context.extras.basketName',
        'context.roastDate', 'context.extras.note',
    ],
    'dye.applyRecipe': [
        'profile',
        'context.targetDoseWeight', 'context.targetYield', 'context.grinderSetting',
        // feedRate is written by DYE2's recipe bodies (dev-api buildRecipeWorkflow) and by its
        // own grinder tiles. Undeclared, assertDeclaredFields threw before the PUT, so any
        // recipe carrying a feed rate applied nothing at all.
        'context.extras.rpm', 'context.extras.feedRate', 'context.extras.dye',
        'context.coffeeName', 'context.coffeeRoaster', 'context.beanBatchId',
        'context.baristaName', 'context.drinkerName', 'context.basket',
        'context.grinderId', 'context.grinderModel',
        'context.extras.basketId', 'context.extras.basketName',
        'steamSettings.targetTemperature', 'steamSettings.duration', 'steamSettings.flow',
        // The recipe's own milk auto-stop (KV steamStopAtTempC, dye2 6aec7f3).
        'steamSettings.stopAtTemperature',
        'hotWaterData.targetTemperature', 'hotWaterData.volume', 'hotWaterData.duration', 'hotWaterData.flow',
        'rinseData',
    ],
    'dye.clearOnDisable': [
        'context.beanBatchId', 'context.coffeeName', 'context.coffeeRoaster',
        'context.baristaName', 'context.drinkerName', 'context.basket',
        'context.extras.rpm', 'context.extras.dye',
    ],
};

// --- what a recipe apply must not inherit (#189) ---------------------------
//
// PUT /workflow deep-merges and the apply paths send only the fields the stored
// item defines, so an absent key means "leave unchanged", not "this item has
// none". Tap a recipe that records a grinder, then one that does not, and the
// second shot is filed under the first one's grinder, basket and barista.
//
// A recipe apply clears these with an explicit null, which is the rule this
// file's own contract states: clearing is a null, never an omission.
//
// The numbers are cleared too, on the same rule: a recipe that names no grind,
// dose, yield, rpm or feed rate -- or names it as 0 -- clears the live one rather
// than inheriting the previously applied recipe's. A recipe is the whole shot,
// not an overlay on the last one, so an unnamed number is "this recipe has none",
// and leaving the earlier value standing read as if it belonged to this recipe.
//
// targetYield is the one exception to the null, and Decaid forces it: its
// workflow handler passes targetYield to rejectExplicitNulls (workflow_handler
// .dart), so {"context":{"targetYield":null}} answers 400 and takes the whole
// apply down with it. Decaid's own documented clear for that field is 0 --
// stop-at-weight off -- so that is what a recipe naming no yield writes.
//
// Recipes only, and not beans:
//   - a favourite carries a copyMask, so the user has already said which fields
//     it owns and an unticked one is a deliberate "do not touch". A favourite
//     stays a pure overlay.
//   - DYE2 has nulled the bean trio on every recipe body since dye2#27.
export const RECIPE_CLEARED_IDENTITY = ['grinderId', 'grinderModel', 'baristaName', 'drinkerName'];
export const RECIPE_CLEARED_IDENTITY_EXTRAS = ['basketId', 'basketName'];
export const RECIPE_CLEARED_NUMBERS = ['grinderSetting', 'targetDoseWeight'];
export const RECIPE_CLEARED_NUMBER_EXTRAS = ['rpm', 'feedRate'];
// Cleared to 0, not null: see the targetYield note above.
export const RECIPE_CLEARED_TO_ZERO = ['targetYield'];

/**
 * `context` with every field the recipe did not set present and cleared --
 * null, or 0 for the fields Decaid refuses a null on.
 *
 * Pure, and returns a new object. DYE2 writes these clears itself for recipes
 * saved since #189; this covers the rows it saved before that and the skin's own
 * legacy apply path, which never had the fields at all.
 */
export function clearInheritedFields(context) {
    const ctx = { ...(context || {}) };
    for (const field of [...RECIPE_CLEARED_IDENTITY, ...RECIPE_CLEARED_NUMBERS]) {
        ctx[field] = ctx[field] || null;
    }
    for (const field of RECIPE_CLEARED_TO_ZERO) ctx[field] = ctx[field] || 0;
    const extras = { ...(ctx.extras || {}) };
    for (const field of [...RECIPE_CLEARED_IDENTITY_EXTRAS, ...RECIPE_CLEARED_NUMBER_EXTRAS]) {
        extras[field] = extras[field] || null;
    }
    ctx.extras = extras;
    return ctx;
}

/**
 * Throw if `writer` sent a field it never declared.
 *
 * Always, in every build: an undeclared key is a programming error, not a
 * runtime condition, and the skin ships as unbundled ES modules with no
 * build-time dev flag to hang a "dev only" check on.
 */
export function assertDeclaredFields(writer, patch, registry = WORKFLOW_WRITERS) {
    const declared = registry[writer];
    if (!declared) {
        throw new Error(`updateWorkflow: unknown writer '${writer}' -- add it to WORKFLOW_WRITERS`);
    }
    const undeclared = undeclaredFields(patch, declared);
    if (undeclared.length) {
        throw new Error(
            `updateWorkflow: writer '${writer}' sent undeclared field(s) ${undeclared.join(', ')} -- ` +
            `either send only what it owns, or take ownership in WORKFLOW_WRITERS`);
    }
    return true;
}
