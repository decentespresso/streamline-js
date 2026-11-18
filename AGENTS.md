# Agent Instructions

Start with [`docs/AI_REPO_MAP.md`](docs/AI_REPO_MAP.md). Open only the topic note that matches the task. Do not preload every AI note, the user manual, both API schemas, the generated bundles, `src/settings/settings.js`, or the legacy Tcl sources.

## Always

- Preserve existing work. Keep changes focused and do not rewrite unrelated code or documentation.
- Verify behavior in current source, local API schemas, and tests. Older prose, plans, and agent files can lag the implementation.
- Treat machine control, firmware updates, credentials, profile notes, feedback text, and browser-stored data as sensitive. Do not log secrets or inject untrusted text as HTML.
- Ask before destructive or externally visible repository actions. Do not tag, force-push, publish a release, dispatch a workflow, or change repository settings without explicit authorization.
- Use **Decaid** in new prose. Keep compatibility identifiers such as `reaHostname`, REA-named functions, `streamline.js`, and legacy storage namespaces unless a migration is explicitly designed.
- Update an AI note only when a reusable, non-obvious constraint changes. Remove stale guidance instead of accumulating history.

## Hard Rules

- This is a browser-native vanilla JavaScript application. App code is loaded as native ES modules; do not introduce a framework or an app-code bundler for a local change.
- `src/modules/settingsSync.js` must start before `src/modules/app.js`, and code that reads synchronized preferences during boot must await `settingsReady`.
- Put Decaid REST and WebSocket behavior behind `src/modules/api.js` and its existing socket helpers. Do not create a second connection stack in a page or component.
- SPA page mounts must be idempotent. Pair listeners, observers, timers, sockets, chart instances, and temporary DOM with explicit cleanup.
- `src/settings/settings-tree.js` is the only settings-navigation source of truth. Never copy its category list into another module.
- Keep `src/settings/settings.js` off the main-page boot path. Non-extracted settings categories reach it through `src/settings/categories/legacy-category.js`.
- Do not hand-edit `src/css/app.css` or `src/modules/echarts-streamline.min.js`. Change their inputs and rebuild them.
- Preserve the chart live-update path, series ordering, and equal-length `x`/`y` arrays. A full chart redraw on every frame is a regression.
- Make related IndexedDB writes in one transaction. Keep summary-first history paging; do not read every full shot for list views.
- Node tests import DOM-free modules only. Extract pure logic rather than adding jsdom or importing modules that touch `window`, `document`, `localStorage`, or IndexedDB at module load.
- Never broaden credential persistence or copy secrets into the synchronized Decaid KV namespace.

## Change Discipline

- Avoid writing code comments. Make code self-explanatory through clear names and structure. When you touch code with an outdated comment, remove it on the spot.
- Prefer small pure helpers and existing modules over new globals. Add to `window.app` only when injected HTML or an established cross-page bridge requires it.
- Use the existing logger for production diagnostics and avoid noisy per-frame logging.
- Follow existing naming and module boundaries. Do not perform broad style modernization during a functional fix.
- When HTML is injected by the router, translate it and initialize it through its page or category mount function; do not rely on a fresh `DOMContentLoaded`.
- For new UI text, reuse an existing key from `src/ui/de1 gui translation - Sheet1.csv` before adding a row. Add a new key only when no existing one fits.
- Source files and generated files belong in the same change when a build input changes.
- Add or update focused `node:test` coverage for pure policy, parsing, state-transition, queueing, migration, and rendering decisions.

## Deep References

- [Repository map](docs/AI_REPO_MAP.md)
- [Runtime and routing](docs/AI_RUNTIME_NOTES.md)
- [Decaid API and WebSockets](docs/AI_API_NOTES.md)
- [Workflow ownership](docs/AI_WORKFLOW_NOTES.md)
- [UI, styling, i18n, and WebView behavior](docs/AI_UI_NOTES.md)
- [Settings architecture](docs/AI_SETTINGS_NOTES.md)
- [Charts](docs/AI_CHART_NOTES.md)
- [Profiles and favorites](docs/AI_PROFILES_NOTES.md)
- [History, IndexedDB, and preference persistence](docs/AI_STORAGE_NOTES.md)
- [Build and tests](docs/AI_BUILD_NOTES.md)
- [Legacy Tcl and experimental references](docs/AI_LEGACY_NOTES.md)
- [Release audit](docs/AI_RELEASE_NOTES.md)
