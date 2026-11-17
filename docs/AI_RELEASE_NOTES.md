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

Everything else is excluded from the skin artifact by construction.

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

## Translations

`src/ui/de1 gui translation - Sheet1.csv` in this repository is the only source. The release ships exactly the file that is committed; nothing is fetched at build time, so what was reviewed and tested is what users get.

- Translations are written here, in the repo, and reviewed like code.
- Add a new key by appending a row; never rewrite or reorder existing rows (an append is N insertions and 0 deletions in the diff).
- Keep the file CRLF-terminated and the header's column order unchanged -- the language list is read from that header.
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
- the whitelist is complete and minimal;
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
