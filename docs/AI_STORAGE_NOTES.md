# AI Storage, History, And Preference Notes

Read this when changing IndexedDB schema, shot history, paging, local caches, settings persistence, browser storage, email cache, or Decaid KV mirroring.

## IndexedDB Shape

`src/modules/idb.js` owns the browser database and schema upgrades. The current database contains separate stores for:

- full shots;
- shot summaries;
- settings/cache values;
- cached Decent email records.

Timestamp indexes support newest-first reads. The database-open promise is coalesced so callers do not start competing upgrades.

Do not duplicate schema constants in feature modules. Read them from `idb.js` and use exported operations.

## Schema Changes

A schema change requires:

1. Incrementing the database version.
2. A safe, forward-only `onupgradeneeded` path from every supported older version.
3. Creation or migration of all required stores and indexes within the upgrade transaction.
4. A plan for large existing histories that does not block first paint for an unbounded time.
5. Handling blocked upgrades and version changes from another tab/WebView.
6. Tests or a controlled migration fixture.
7. Manual verification with both an empty database and a populated older database.

Do not perform arbitrary async network work inside an IndexedDB upgrade transaction.

## Atomic Writes And Paging

Related records belong in one transaction. `addShot()` writes the full shot and its summary together. Bulk summary writes use one transaction rather than one commit per record.

History lists should load summaries first and fetch a full shot only when it is displayed. Use timestamp indexes and the history pager; do not call a full-store read to find the latest record or render a page.

Preserve:

- newest-first ordering;
- stable offset/page behavior while more data arrives;
- summary backfill/repair;
- delete/clear consistency across stores;
- cached-first paint followed by network refresh;
- cancellation or staleness checks when the visible history item changes.

The main-page history arrows are locked while the machine state is `espresso`:
`src/modules/history-nav-gate.js` owns the state list, `history.updateHistoryNavLock()`
paints it, and `app.js` calls that on each machine-state change. Locking also returns
the panel to the newest shot, because `app.js` holds the live chart and data panel back
for as long as `isReviewingHistory()` is true.

## Durable Preferences

`src/modules/settingsSync.js` keeps localStorage as the synchronous working copy and mirrors selected keys into Decaid KV so preferences survive WebView storage replacement.

Startup order matters:

- the module is loaded before `app.js`;
- it installs the Storage mirror once;
- it hydrates from KV;
- KV wins a conflict, except keys the user changed while the write gate was shut (a late hydrate keeps and pushes those; the retry ladder then continues every 60 s);
- local values seed missing remote values;
- `settingsReady` resolves even when Decaid is unavailable;
- `app.js` waits before reading synchronized preferences.

Do not move this behind normal app initialization or echo hydration writes back through the wrapped setter.

The synchronized-key list is intentionally selective. Before adding a key, ask whether it is:

- a user preference worth restoring;
- safe to expose through the LAN-accessible KV API;
- independent of the Decaid host identity;
- not already machine-owned;
- not a transient draft.

Credentials, auth material, temporary editor drafts, and `reaHostname` do not belong in the synchronized namespace.

## Namespace Boundaries

| Namespace/store | Purpose | Constraint |
| --- | --- | --- |
| Decaid KV `streamlineSettings` | Durable mirror of selected UI preferences | Do not place secrets or profiles here |
| Decaid app store `streamline-app` | Favorites and related app settings | Preserve existing keys and initialization semantics |
| Decaid KV `streamlineProfileOverrides` | Per-profile dose, yield, grind, and brew temp | Keyed by profile ID; remap the key when an edit changes the ID |
| Legacy KV `streamline` | Old user-profile migration source | Do not reuse; migration may delete handled records |
| IndexedDB settings store | Local caches, flags, and fallback data | Names must not collide accidentally |
| IndexedDB shots + summaries | Full history and list projections | Keep cross-store writes consistent |

Document a new namespace before using it, including owner, lifetime, sensitivity, migration, and backup behavior.

## Privacy And Safety

Browser and KV storage can contain profile names, notes, machine information, feedback drafts, emails, and integration settings.

- Do not log entire records in normal operation.
- Do not persist passwords or tokens in a broader store for convenience.
- Clear only the scope the user requested.
- Export/backup changes require explicit review of sensitive fields.
- Use text-safe rendering when stored data returns to the DOM.
- Treat fallback caches as potentially stale and label decisions accordingly.

## Troubleshooting

| Symptom | First place to inspect |
| --- | --- |
| Old preference returns after `localStorage.clear()` | Wrapped clear/remove behavior and remote KV mirror |
| Preference is read before restore | Script order and missing `await settingsReady` |
| History page is slow with many shots | Full-shot reads instead of summary/index paging |
| Latest cached shot requires scanning all records | Missing timestamp-index cursor path |
| Shot appears in list but cannot open | Full shot and summary were not written atomically |
| Upgrade hangs | Another tab holds an old DB connection or upgrade work is too large |
| User profiles disappear during settings work | Reuse of the legacy `streamline` namespace |
| Save loses a newer edit | Pending-change race in the owning data module |

## Focused Checks

```sh
npm test
node --test test/history-pager.test.mjs
node --test test/history-nav-gate.test.mjs
node --test test/settings-persistence.test.mjs
node --test test/settings-data-race.test.mjs
```

For schema work, also test a real browser upgrade using a populated copy of the previous database.
