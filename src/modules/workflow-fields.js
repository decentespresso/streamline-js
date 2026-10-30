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
        'context.extras.rpm', 'context.extras.dye',
        'context.coffeeName', 'context.coffeeRoaster', 'context.beanBatchId',
        'context.baristaName', 'context.drinkerName', 'context.basket',
        'context.grinderId', 'context.grinderModel',
        'context.extras.basketId', 'context.extras.basketName',
        'context.roastDate', 'context.extras.note',
    ],
    'dye.applyRecipe': [
        'profile',
        'context.targetDoseWeight', 'context.targetYield', 'context.grinderSetting',
        'context.extras.rpm', 'context.extras.dye',
        'context.coffeeName', 'context.coffeeRoaster', 'context.beanBatchId',
        'context.baristaName', 'context.drinkerName', 'context.basket',
        'context.grinderId', 'context.grinderModel',
        'context.extras.basketId', 'context.extras.basketName',
        'steamSettings.targetTemperature', 'steamSettings.duration', 'steamSettings.flow',
        'hotWaterData.targetTemperature', 'hotWaterData.volume', 'hotWaterData.duration', 'hotWaterData.flow',
        'rinseData',
    ],
    'dye.clearOnDisable': [
        'context.beanBatchId', 'context.coffeeName', 'context.coffeeRoaster',
        'context.baristaName', 'context.drinkerName', 'context.basket',
        'context.extras.rpm', 'context.extras.dye',
    ],
};

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
