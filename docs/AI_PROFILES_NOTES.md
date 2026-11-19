# AI Profiles And Favorites Notes

Read this when changing profile loading, selection, editing, metadata, visibility, favorites, active-profile resolution, or profile migrations.

## Ownership

- `src/modules/profileManager.js`: profile records, API/cache loading, favorites, active profile metadata, workflow updates, and migrations.
- `src/modules/active-profile.js`: pure title-to-record resolution.
- `src/modules/profile_selector.js`: selector UI and route lifecycle.
- `src/modules/profile_editor.js`: editor state, validation, preview, and save flow.
- `src/profiles/profile_selector.html` and `src/profiles/profile_editor.html`: injected page markup.
- `src/modules/api.js`: profile, workflow, metadata, and store transport.
- `src/modules/idb.js`: local fallback/cache primitives.
- `src/modules/profile-overrides.js`: per-profile tile edits (dose, yield, grind, brew temp) kept in the Decaid KV record `streamlineProfileOverrides`, keyed by profile ID.

Keep transport in `api.js`, data ownership in `profileManager.js` or editor state, and page-specific rendering in the page module.

## Profile Records

The current source loads profile records from Decaid and builds an in-memory map keyed by profile ID. Deleted and superseded/hidden records are excluded from the visible list. The map is cached in IndexedDB as an offline fallback.

Do not assume a title is unique or that a profile ID is permanent after an edit. Decaid's profile ID hashes execution content only, so a user record can carry a bundled profile's exact title - a de1app import is the common source, since de1app's own copy of a bundled profile differs in its frames and so cannot collide on the ID. Rows whose visible title is shared get a saved-time stamp (`profile-look-alike.js`), counted across the whole visible list: the look-alike pair usually straddles Built-In and Your Profiles, so keying the count by `isDefault` hid it from exactly the case it is for.

Per-profile tile values do not live in the profile's server-side metadata. Decaid rewrites that metadata whenever it re-seeds a bundled profile, which silently discarded the user's dose, yield, and grind. They are stored in the `streamlineProfileOverrides` KV record instead, and `loadAvailableProfiles()` folds them onto each record's `metadata` after loading, so existing `record.metadata.targetDoseWeight` reads keep working. Write a tile edit through `profile-overrides.js`, not back into profile metadata.

`resolveProfileKeyByTitle()` deliberately:

- compares normalized stored and translated titles;
- prefers a non-default record when multiple records share a title;
- returns no match rather than guessing.

This protects edits to a user fork that has the same title as a bundled/default profile.

Edits can produce a new content-derived ID. When that occurs, remap any favorite slot from the old ID to the new one. Inspect the current editor save/visibility/parent logic before changing it; these fields preserve revert and default-profile behavior.

Plain SAVE on a bundled default takes the same hide+replace route as a user profile: Decaid refuses content edits on a default (`ProfileController.update`), so the fork is the only edit path, and the bundled record is then retired to `hidden` so the edit can keep the title the user knows. Leaving it visible is the mistake to avoid — the edit lands as `… (2)` while the original keeps the name, the favorite slot, `wakeProfileId`, and every title lookup. Retiring it is reversible: `setVisibility` accepts `hidden` for a default (only `deleted` is refused), a hidden default survives Decaid's boot re-seed, `/lineage` ignores visibility so Revert still offers it, and the selector's hidden view can restore it.

`retiredSource` in `saveProfile` is the single gate for everything keyed by the old ID — favorites/`wakeProfileId` remap, and moving the `streamlineProfileOverrides` record. Save As New never sets it: its source stays visible with its own numbers, so the new profile starts from the profile's own defaults rather than inheriting a dial-in the user did not ask it to copy.

## Favorites

There are five favorite slots. Assignments are validated to integer indices in range and persisted to Decaid storage with an IndexedDB backup.

Important behavior:

- A missing assignment set is not the same as five intentional empty slots.
- Initialization state prevents history/fallback auto-population from undoing a user's choices.
- Validation writes back only when data changed.
- A profile-ID change must follow through to favorites.
- UI updates can occur while the main page is hidden; refit button text after it becomes visible.

Do not create a second favorites store or store titles in place of stable record IDs.

## Legacy Profile Migration

`profileManager.js` contains a one-time migration from the old private `streamline` KV namespace into the shared profiles API.

The migration is designed to be retry-safe:

- the completion flag is written only when every record is handled;
- a KV record is deleted only after its profile upload succeeds;
- metadata is copied separately;
- failed records remain for a later retry;
- invalid legacy parent IDs are not carried forward.

Do not reuse the `streamline` namespace for new settings or data. `src/modules/settingsSync.js` intentionally uses a separate namespace so profile migration cannot delete synchronized preferences.

Any migration change needs tests for partial success, retry, duplicate prevention, metadata failure, and data preservation.

## Selector And Editor Lifecycle

Both pages are injected by the SPA router.

- Initialization must be idempotent.
- Do not depend solely on `DOMContentLoaded`.
- Clean up editor instances, global handlers, timers, previews, and chart resources.
- Guard async profile loads/saves so a late result cannot update an abandoned route.
- Keep user-entered notes and names as text unless passed through an established Markdown/sanitization path.
- Preserve original/source records when the established save model creates an editable child/fork.
- Validate profile structure and numeric units before upload.
- Route back through `router.js` rather than forcing a full reload.

## Workflow Changes

Selecting a profile affects both UI state and the workflow sent to Decaid. Use the established workflow/profile wrappers and preserve ordering around:

- workflow fetch/update;
- selected record and metadata;
- favorite highlighting;
- main-page tile values;
- chart/profile preview;
- reconnect or offline fallback.

Do not write only the visible title and assume the machine has the intended record.

## Focused Checks

```sh
npm test
node --test test/active-profile.test.mjs
node --test test/assign-favorite.test.mjs
```

For editor or migration changes, add focused pure tests and manually test default profile, user fork with the same title, rename, edit that changes ID, favorite remap, delete/hide, offline cache, and a partially failed migration.
