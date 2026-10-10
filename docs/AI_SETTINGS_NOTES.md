# AI Settings Notes

Read this when changing settings navigation, search, category rendering, settings data, save/cancel behavior, Bengle gating, or the migration away from the large legacy settings module.

## Architecture

The settings page has a lightweight shell and two category paths.

### Canonical Navigation

`src/settings/settings-tree.js` is the single source of truth for:

- main categories;
- subcategory IDs and labels;
- `settingsCategory` routing values;
- translation-key overrides;
- `bengleOnly` visibility.

Both the shell and legacy implementation must derive from this file. Add, rename, reorder, or gate a category here first. Never paste the tree into another consumer.

### Lightweight Shell

`src/settings/settings-shell.js` mounts as soon as Settings is routed. It renders navigation and search without waiting for the large legacy module.

It owns:

- current main/subcategory;
- search and translated labels;
- async category loading;
- route-location persistence;
- save/cancel shell behavior;
- resizable panel chrome;
- category cleanup and stale-render sequence guards.

`CATEGORY_LOADERS` chooses a category module. Extracted categories load independently; all others use `src/settings/categories/legacy-category.js`.

### Legacy Bridge

`src/settings/categories/legacy-category.js` lazy-imports `src/settings/settings.js` and delegates to its initializer.

`settings.js` remains authoritative for non-extracted categories, but it must not be imported by `index.html`, `app.js`, or the main-page boot graph. Search for the target category or symbol instead of reading or reformatting the entire file.

Current partial-extraction modules are:

- `src/settings/categories/quick-adjustments.js`
- `src/settings/categories/maintenance.js`

They can render supported subcategories and delegate the rest to the legacy bridge. Use their mount/cleanup/delegation shape as the model for further extraction.

## Category Mount Contract

A category module is loaded asynchronously and mounts into the provided content container. It should:

- render only its requested category;
- bind events within its root where practical;
- translate freshly rendered markup;
- subscribe through shared data modules rather than creating duplicate fetches;
- guard or cancel late async results;
- return cleanup for listeners/subscriptions/timers;
- leave shell navigation, save, cancel, and route history to the shell.

Do not let a late response from category A replace category B. Preserve the shell's render-sequence check and add a category-local generation/abort guard when the category starts its own asynchronous work.

## Settings Data

`src/settings/settings-data.js` provides shared Decaid settings state for extracted categories.

It separates:

- committed network/cache data;
- pending local changes;
- published immutable snapshots;
- hydration from IndexedDB;
- network refresh;
- serialized save behavior;
- dirty state.

The save loop deliberately handles a mutation that occurs while an earlier batch is in flight. Do not replace it with “copy pending, send once, clear everything”; that can lose the newer change.

Use the shared data API for fields it owns. Legacy categories can still have their own established save paths; do not create a second owner for the same field.

## Common Changes

### Plugin-Owned Settings UI

Plugin authors can mark individual manifest settings with `"hidden": true` to
omit their controls and search keywords in Streamline. Keep the settings in the
manifest: Decaid needs those declarations to retain and validate saved values.
`plugin-view.js` owns this visibility policy; it is a presentation hint, not a
security boundary. Decaid's native settings screen and other skins may ignore it.

The generic **Open** link passes `returnTo` with the current skin's full address
and `page=settings`. Preserve the actual host, port and path: skin origins are
assigned by Decaid, and the browser referrer can omit the route. Plugin UIs must
validate the return URL before using it. See [Plugin settings UI](plugin-settings-ui.md).

### Add A Navigation Item

1. Add it to `settings-tree.js`.
2. Choose the owning main category and stable `settingsCategory`.
3. Add `i18nKey` only when the source display label differs.
4. Add `bengleOnly` only for a real capability restriction.
5. Ensure the category loader can render it.
6. Test search, saved location, direct reopen, and non-Bengle visibility.

### Extract A Legacy Category

1. Understand the target section in `settings.js` and its API/storage dependencies.
2. Move pure formatting/policy into DOM-free helpers when useful.
3. Implement a focused category module with mount and cleanup.
4. Reuse `settings-data.js` or another existing owner; do not duplicate fetching.
5. Point only that main category at the new loader when all its routed subcategories are supported, or introduce an explicit per-subcategory split.
6. Preserve save/cancel semantics and dirty state.
7. Add tests before deleting legacy behavior.

### Modify A Legacy Category

Keep the patch narrow. Do not use a one-field change as a reason to reformat or split the whole large legacy file. Verify shell-to-legacy handoff, cleanup, and navigation after the change.

## Troubleshooting

| Symptom | First place to inspect |
| --- | --- |
| A category appears twice or differs between shell and content | Duplicated navigation instead of `settings-tree.js` |
| Settings loads slowly from every route | Accidental eager import of `settings.js` |
| Fast category switching shows the previous category | Sequence/generation guard |
| Save closes despite a newer unsaved edit | Pending-change save loop and dirty state |
| Search label is untranslated | `i18nKey`, `translatePage()`, or source-key mismatch |
| Bengle-only setting appears everywhere | `bengleOnly` and current machine-model initialization |
| Listeners fire after leaving Settings | Category or legacy cleanup |
| Reopening Settings jumps to the wrong place | `settings-location.js` and synchronized preference hydration |

## Focused Checks

```sh
npm test
node --test test/settings-data-race.test.mjs
```

Also test Settings in a browser with slow/offline Decaid responses, rapid category changes, save during an in-flight mutation, cancel, reopen, search, and both Bengle/non-Bengle model states when relevant.
