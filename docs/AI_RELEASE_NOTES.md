# AI Release Notes

Read this when preparing or auditing a Streamline release, `dist` update, manifest/version change, translation sync, or GitHub Actions distribution change. This is a release checklist, not a changelog.

## Authorization Boundary

Do not create or push a tag, force-update a branch, dispatch a workflow, publish or edit a release, or change repository secrets/settings without explicit authorization.

Local preparation and an audit report do not imply authorization to publish.

## Distribution Model

`.github/workflows/release.yml` is the source of truth.

### Push To `main`

The workflow stages a whitelist and force-publishes it as an orphan `dist` branch. The staged manifest ID is changed to `streamline.js-dist` so it can coexist with the released skin.

The force update is intentional for this generated branch; it is not permission to force-push `main` or another source branch.

### Tag Matching `v*`

The workflow:

1. stages the release whitelist;
2. derives the staged manifest version from the tag by removing the leading `v`;
3. validates the manifest ID and version field;
4. rejects filenames containing Win32-reserved characters;
5. creates `streamline.js-<tag>.zip`;
6. publishes a GitHub Release with generated notes.

The release whitelist is:

- `index.html`
- `skin-manifest.json`
- `src/`

Everything else is excluded from the skin artifact by construction — but only
because staging clears `dist` before it copies. `mkdir -p dist` on its own keeps
whatever the checkout already has under `dist/`, so a committed `dist/` file
ships at the zip's root and on the `dist` branch without appearing in the
whitelist. A stale `dist/app.css` reached every release up to v0.2.8 that way.
Do not commit files under `dist/`, and keep the `rm -rf dist` ahead of the copy.

### GitHub Pages

`.github/workflows/static.yml` is separate and deploys the whole checked-out repository to GitHub Pages. Do not confuse this with the sanitized skin release. Repository files must still be safe for public Pages publication even when they are excluded from the release ZIP.

## Build Inputs Are Prebuilt

The release workflow stages committed files; it does not run the Tailwind or ECharts build and does not run the Node test suite.

Before tagging:

```sh
npm ci
npm test
npm run build
git diff --check
```

Commit required changes to:

- `src/css/app.css` after Tailwind input/classes change;
- `src/modules/echarts-streamline.min.js` after the ECharts entry/dependency changes.

A clean CI staging step cannot detect a stale generated bundle.

## Version Sources

Review together:

- `src/version.js`: runtime `APP_VERSION` used for update/reload detection.
- `skin-manifest.json`: committed manifest used by `main`/`dist`; tag builds rewrite only the staged copy.
- `package.json` and `package-lock.json`: package metadata.
- the intended `v*` tag.

The tag is the release artifact's manifest-version source, but it does not update the runtime `APP_VERSION` in source. Deliberately synchronize version-bearing files according to the release plan and run `test/version.test.mjs`.

Do not assume the existing test enforces equality between every version field; inspect it.

## Translation Sync

The release workflow can replace the committed translation CSV with a protected Google Sheets export when `TRANSLATIONS_SHEET_URL` is configured. When it is absent, the committed CSV is used.

- Never print, hardcode, or expose the secret URL.
- Audit translation changes before release.
- Ensure generated release content was tested with the same translation data where practical.
- Run `node scripts/i18n_audit.mjs`, but separate existing translation debt from release regressions.

## Establish The Release Range

Before a release audit:

```sh
git fetch origin main --tags
git status --short
git log --oneline <previous-tag>..HEAD
git diff --stat <previous-tag>..HEAD
git diff --name-status <previous-tag>..HEAD
```

Confirm:

- the intended commit is reachable from `origin/main`;
- the working tree contains no unintended change;
- the tag does not already point elsewhere;
- the range contains all intended work and no unrelated local commits;
- required generated files are committed;
- local logs, response dumps, credentials, or user data are absent.

## Documentation Audit

Use the release diff to review only affected guidance.

| Changed area | Review |
| --- | --- |
| Repository-wide rules or routing | `AGENTS.md`, `docs/AI_REPO_MAP.md` |
| Boot, state, navigation, WebView | `docs/AI_RUNTIME_NOTES.md` |
| REST, WebSockets, machine control | `docs/AI_API_NOTES.md` |
| HTML, CSS, i18n, units | `docs/AI_UI_NOTES.md` |
| Settings | `docs/AI_SETTINGS_NOTES.md` |
| Charts or ECharts bundle | `docs/AI_CHART_NOTES.md` |
| Profiles and favorites | `docs/AI_PROFILES_NOTES.md` |
| History or persistence | `docs/AI_STORAGE_NOTES.md` |
| Dependencies, generated files, tests | `docs/AI_BUILD_NOTES.md` |
| Legacy parity or migrations | `docs/AI_LEGACY_NOTES.md` |
| Workflow, version, manifest, distribution | this file |

Also update `README.md`, `docs/API.md`, or other user-facing docs when public behavior, setup, troubleshooting, endpoints, supported models, or release instructions changed.

Thin tool-specific instruction files should route to `AGENTS.md`, not duplicate its content.

## Pre-Tag Gate

At minimum verify:

```sh
npm ci
npm test
npm run build
node scripts/i18n_audit.mjs
node --test test/version.test.mjs
git diff --check
git status --short
```

Inspect `.github/workflows/release.yml` directly and confirm:

- triggers and permissions are still intended;
- the whitelist is complete and minimal, and `dist` is cleared before staging;
- manifest rewriting cannot corrupt JSON;
- the main/dist ID split is preserved;
- reserved-filename validation covers staged files;
- archive naming is correct;
- release publication happens only for tags;
- generated `dist` branch behavior remains intentional.

Inspect `.github/workflows/static.yml` separately for Pages exposure.

For relevant changes, complete browser/WebView, Decaid, machine, scale, firmware, and upgrade-path testing. Record unavailable hardware and untested configurations.

## Post-Publication Verification

Only after authorized publication:

1. Confirm the release and `dist` branch point to the intended commit/workflow run.
2. Download and inspect the ZIP.
3. Confirm it contains only the whitelist at the archive root.
4. Confirm the staged manifest ID and version are correct.
5. Confirm `src/version.js` reports the intended runtime version.
6. Install through the supported Decaid path and launch the skin.
7. Verify translations, generated CSS, ECharts loading, direct routes, settings, profiles, and machine connection.
8. Record any rollback or follow-up action.

## Completion Report

Report:

- intended version, tag, commit, previous tag, and audited range;
- version-bearing files reviewed;
- AI and user documentation changed;
- commands run and results;
- browser/WebView and hardware paths tested;
- generated artifacts reviewed;
- workflow/ZIP/manifest checks;
- skipped checks and untested configurations;
- publication actions actually performed;
- blockers and residual risks.

Separate verified facts from assumptions. A passing staging workflow alone is not evidence that generated assets, runtime versioning, hardware behavior, or documentation are ready.
