# AI Build And Test Notes

Read this when installing dependencies, changing Tailwind or ECharts inputs, adding dependencies, writing tests, serving the app locally, or touching build/release-generated files.

## Common Commands

Run from the repository root:

```sh
npm ci
npm test
npm run build:css
npm run build:echarts
npm run build
python3 -m http.server 8000
```

The browser application itself is not bundled. Serve the repository root so `index.html`, `src/`, and routed HTML remain at their expected relative URLs. Decaid normally supplies the API on port `8080`; the legacy `reaHostname` preference can point the client at another host.

## Generated Artifacts

### Tailwind

```text
src/input.css + index.html + src/**/*.{js,html} + tailwind.config.js
  -> npm run build:css
  -> src/css/app.css
```

A newly written utility class is not available until the generated CSS is rebuilt. Do not edit `src/css/app.css` directly.

### ECharts

```text
scripts/echarts-streamline-entry.js
  -> npm run build:echarts
  -> src/modules/echarts-streamline.min.js
```

Register any needed ECharts component in the entry file and rebuild. Do not edit the minified output.

Commit source and generated output together. Review generated diffs for unexpected size or dependency changes.

The release workflow currently stages the committed `src/` tree; it does not rebuild these assets. A local build that is not committed does not fix the release artifact.

## Dependency Changes

- Keep `package.json` and `package-lock.json` synchronized.
- Use `npm ci` to verify the lockfile from a clean install.
- Avoid adding a runtime dependency for logic that can remain a small native module.
- Do not introduce a framework, DOM test environment, or app bundler as part of an unrelated feature.
- Rebuild ECharts after changing its dependency or registered component set.
- Rebuild Tailwind after changing its version, plugin configuration, scan paths, or classes.
- Record any changed browser/WebView support assumption.

## Test Model

Tests use Node's built-in runner and strict assertions:

- files are named `test/<topic>.test.mjs`, and `npm test` globs exactly that. Node's own discovery treats *every* file under `test/` as a suite, which swept in `test/personas/run.mjs` -- a manual Playwright harness that needs a dev server -- and failed CI. A new suite must match the glob or it will not run;
- source modules under `src/` are ES modules;
- testable modules must be DOM-free at import time;
- no jsdom and no separate test framework;
- browser-coupled behavior is often tested by extracting pure policy or by inspecting a narrow source invariant.

When code inside a DOM-coupled module deserves unit coverage, extract a pure helper and import it from both the browser module and the test. Do not contort production startup merely to make a large page module importable in Node.

Run one file while iterating:

```sh
node --test test/<topic>.test.mjs
```

Run the full suite before completion:

```sh
npm test
```

## Focused Test Routing

| Changed area | Useful starting tests |
| --- | --- |
| Profile resolution/favorites | `test/active-profile.test.mjs`, `test/assign-favorite.test.mjs` |
| Chart policy/renderer | `test/chart-*.test.mjs`, `test/echarts-renderer.test.mjs`, `test/expanded-chart-interaction.test.mjs` |
| History paging | `test/history-pager.test.mjs` |
| Settings persistence/races | `test/settings-persistence.test.mjs`, `test/settings-data-race.test.mjs` |
| Device/display commands | `test/device-command.test.mjs`, `test/display-command-queue.test.mjs` |
| Firmware UI state | `test/firmware-cancel.test.mjs` |
| Version/manifest | `test/version.test.mjs` |
| DYE2 source contracts | `test/dye2-plugin-source.test.mjs` |
| Plugin surface parser, or the in-repo example plugin | `test/plugin-surfaces.test.mjs`, `test/shot-companion-plugin.test.mjs` (runs `plugins/shot-companion.reaplugin` through `parseSkinAnswer`) |
| Feedback privacy | `test/feedback-privacy.test.mjs` |

Use repository discovery to find additional matching tests; this table is routing, not an exhaustive inventory.

## Manual Validation

Node tests do not provide DOM layout, canvas rendering, IndexedDB upgrade behavior, network timing, touch input, or Decaid hardware integration.

For browser-facing changes, serve the app and exercise:

- first boot and reload;
- direct subpage URLs;
- main/subpage navigation loops;
- slow or unavailable Decaid;
- machine/scale connect and reconnect;
- light/dark and a long-label language;
- target tablet/WebView sizing;
- any hardware/model gate touched.

Record unavailable hardware or untested paths.

## Completion Checks

```sh
npm ci
npm test
npm run build
git diff --check
git status --short
```

Inspect `git diff` to confirm:

- only intended source and generated files changed;
- generated output corresponds to its input;
- no loose logs, screenshots, responses, credentials, or local data were added;
- documentation commands and paths still exist.

`docs/DEVELOPMENT.md`, old plans, and old agent instructions can contain outdated build claims. `package.json`, scripts, current source, and tests are authoritative.
