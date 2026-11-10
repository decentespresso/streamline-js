# Workflow Ownership

The live workflow is **one JSON document with no revision and no ETag**, and
`PUT /api/v1/workflow` **deep-merges** whatever body it is given. Four writers
touch it:

- the skin's tiles and settings page,
- the skin's profile selector and wake path,
- DYE2's apply and record paths,
- the machine's own state, reflected back through Decaid.

Each used to send the fields it happened to be holding, including fields it did
not own and had not changed, so a stale value overwrote a newer one and nothing
detected it. That produced one bug with many faces: #143, #144, #147, #148,
#149, #153, #155, #156, #157, #158 here, and dye2 #18, #20, #24, #25, #28, #30,
#31, #33.

**This is a precedence problem, not a concurrency problem.** An `If-Match` or
revision check would *pass* every one of those writes: the writers are
sequential and each one believes it is authorised. Optimistic concurrency is
worth adding later for the genuinely concurrent two-client case; it does not
fix this.

## The contract

`src/modules/workflow-fields.js` is the source of truth. Every write goes
through `updateWorkflow(patch, writer)`, and `assertDeclaredFields` **throws**
when a writer sends a field it has not declared — in every build, because an
undeclared key is a programming error, not a runtime condition.

Declaring a group (`context`) owns everything under it; declaring a leaf
(`context.targetYield`) owns only that. The contested groups are declared leaf
by leaf on purpose.

Two rules that the table below cannot express on its own:

1. **Send only what changed.** A full sub-object send is the defect, not the
   fix — `{ steamSettings: { duration: 30 } }`, never the whole `steamSettings`
   you just read. The deep merge preserves the siblings for you.
2. **Never send a document you read more than one operation ago.** Build a
   patch; do not `GET` the workflow, mutate it and `PUT` it back.
3. **Clearing is an explicit `null`, not an omission.** The merge treats a
   missing key as "unchanged", so a writer that means to release something —
   `context.extras.dye.recipeId` above — has to say so.

`test/workflow-ownership.test.mjs` enforces all of this: it scans `src/` for
every call site, fails on an undeclared or unknown writer, and snapshots each
writer's field set so widening one is a visible diff rather than a silent
change.

## Precedence table

| Field group | May write | Notes |
|---|---|---|
| `context.extras.dye.recipeId` | DYE2 recipe apply / Save to recipes, and every writer that replaces the profile | Since dye2#36 the plugin **derives** its selection from this field — there is no `POST /selection` for it. A recipe apply sets it; a favourite or recent apply, and a profile change from any source, must write `null` **explicitly**, because the deep merge reads an absent key as "unchanged". A tile edit leaves it alone: that is the `*`. |
| `context.coffeeName`, `context.coffeeRoaster`, `context.beanBatchId` | DYE2 bean picker, skin bean picker | Persistent across shots; nothing clears them (#164). A recipe apply is the exception: a recipe naming no bean clears the trio (dye2#27). |
| `context.grinderId`, `context.grinderModel`, `context.baristaName`, `context.drinkerName`, `context.extras.basketId`, `context.extras.basketName` | DYE2 apply and pickers, skin recipe apply | The identities. A **recipe** apply clears each one the recipe does not name, as an explicit null (`clearInheritedFields`, #189) — an omission filed the shot under the previously applied item's grinder. A **favourite** carries a `copyMask`, so an unticked field is a deliberate "do not touch" and a favourite stays a pure overlay. |
| `context.grinderSetting`, `context.targetDoseWeight`, `context.targetYield`, `context.extras.rpm`, `context.extras.feedRate` — **on a recipe apply** | skin recipe apply, DYE2 recipe apply | The same clear, same function, for the numbers: a recipe is the whole shot, not an overlay on the last one, so a number it does not name — or names as `0` — is cleared rather than inherited. `targetYield` is cleared to **`0`, never `null`**: Decaid's `workflow_handler.dart` passes it to `rejectExplicitNulls`, so a null answers `400` and takes the whole apply down, and `0` is its own documented clear (stop-at-weight off). A cleared grind or dose falls back on the tile to the machine's own value, then to a dash. Tiles and profile switches are the row below and are unaffected. |
| `context.grinderSetting`, `context.targetDoseWeight`, `context.targetYield` | skin tiles, recipe apply | The contested group — #153 and #155 live here. A profile switch sends dose and grind **only** when that profile has a saved override, and otherwise omits them so the live dial-in survives (`profileSwitchDial`, #189); yield is a profile field, so a switch always sends it. Never fill a gap from a skin-local copy of a shared value — no other client updates it. |
| `profile.target_weight` | dose/yield tiles, profile switches | A non-autonomous machine stops on this, not on `context.targetYield`, so the tiles fold the yield into it — alone, never with the rest of the profile. |
| `steamSettings`, `hotWaterData`, `rinseData` | skin settings page, skin tiles, recipe apply | Full sub-object sends are the defect; send only the changed key (#157). |
| `profile` | any source | A profile change nulls `recipeId`: the recipe's identity *is* its profile. |
| `context.extras.note`, `context.baristaName`, `context.drinkerName` | any source | Per shot by design; the note is the only field still cleared after a shot. |

## Writers

Defined in `WORKFLOW_WRITERS`. The prefix says which surface owns the write:

| Prefix | Surface |
|---|---|
| `tiles.*` | main-page tiles (`ui.js`) |
| `settings.*` | the settings page (`settings/settings.js`) |
| `api.*` | `api.js`'s own narrow setters, which also keep the shared KV "last value" records in step |
| `profile.*` | profile switches — selector Confirm, favourites, wake, reset to defaults |
| `beans.*` | the bean picker |
| `shot.*` | per-shot fields |
| `dye.*` | DYE2 apply and the Settings off-switch |

## Known gaps

- **No optimistic concurrency.** Two clients writing at once still race. That is
  the third step, after this and after the field sets are made smaller.
- **`profile` is walked one level, not deeper.** `profile.target_weight` and
  `profile.steps` are separate declarations, so a tile that only moves the stop
  weight cannot send the profile document it read — that was #155. Below that
  level it stops: `steps` is one field, not one per step.
- **Decaid's own reflected writes are outside this contract.** The table governs
  the skin and DYE2; the machine state Decaid writes back is not something the
  skin declares.
