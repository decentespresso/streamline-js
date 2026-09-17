# Contributing to Streamline.js

Thanks for contributing. Streamline.js is the browser-native skin for
[Decaid](https://github.com/decentespresso/decaid). This guide tells you what is
required to land a PR — items marked **(required)** are hard gates, not
suggestions.

> **Naming note:** The Decent gateway application is called **Decaid**. Use that
> name in new prose. Compatibility identifiers such as `reaHostname`, REA-named
> functions, `streamline.js`, and legacy storage namespaces stay as they are
> unless a migration is explicitly designed.

## Quick Reference

| What | Where |
|------|-------|
| Repository map (start here) | [`docs/AI_REPO_MAP.md`](docs/AI_REPO_MAP.md) |
| Architecture rules & conventions | [`AGENTS.md`](AGENTS.md) |
| Build and test details | [`docs/AI_BUILD_NOTES.md`](docs/AI_BUILD_NOTES.md) |
| Decaid REST/WebSocket usage | [`docs/AI_API_NOTES.md`](docs/AI_API_NOTES.md) |
| Settings architecture | [`docs/AI_SETTINGS_NOTES.md`](docs/AI_SETTINGS_NOTES.md) |
| Release process | [`RELEASE.md`](RELEASE.md) |
| Plugin development (Decaid side) | [`Plugins.md`](Plugins.md) |

## Before You Start

- **Open an issue before implementation.** External contributors must do this for
  every proposed PR, including small fixes. This lets maintainers consider scope,
  alternatives, compatibility with Decaid, and whether the change belongs in the
  official skin before implementation work starts.
- **Wait for acceptance.** Start implementation only after a maintainer says in
  the issue that the approach is accepted.
- Large or exploratory proposals may be moved to a Discussion first. A PR still
  needs an accepted implementation issue.
- Maintainers and automated maintenance PRs may skip the issue-first step when an
  issue would add no planning context.
- **Read [`AGENTS.md`](AGENTS.md)** — it covers the hard architectural rules.
  Humans and agents both need it.

## Local Setup

Requirements: Node.js (current LTS) and a static file server. A Decent machine is
not required; Decaid can run with simulated hardware.

```bash
npm ci
npm test
python3 -m http.server 8000
```

The application is **not bundled**. Serve the repository root so `index.html`,
`src/`, and routed HTML keep their relative URLs. Decaid normally supplies the
API on port `8080`.

## Branching & PRs

- Branch from `main`. Push to your fork, open a PR against
  `decentespresso/streamline-js:main`.
- One feature or fix per PR. No bundling unrelated changes, no drive-by
  reformatting or style modernization in a functional fix.
- Reference the accepted issue with `Fixes #123`, `Closes #123`, or `Related #123`.
- Prefer several small PRs over one large one. A feature that touches a shared
  control (steam, chart, settings navigation) should land its generic
  infrastructure first and its feature UI second.
- A maintainer will review. Expect a few rounds of feedback.
- Do not push directly to `main`.

## Guardrails (required)

### 1. Accepted Issue

External contributions must reference an open issue that a maintainer has
accepted.

### 2. Architecture Boundaries (required)

These come from [`AGENTS.md`](AGENTS.md). PRs that break them will be returned.

- **Vanilla, browser-native.** App code is loaded as native ES modules. Do not
  introduce a framework, a runtime dependency, or an app-code bundler.
- **One connection stack.** Decaid REST and WebSocket behavior goes behind
  `src/modules/api.js` and its existing socket helpers. Never open a second
  connection stack in a page, component, or plugin integration.
- **Boot order.** `src/modules/settingsSync.js` starts before
  `src/modules/app.js`; code reading synchronized preferences during boot must
  await `settingsReady`.
- **Idempotent mounts.** SPA page mounts can run repeatedly. Pair every listener,
  observer, timer, socket, chart instance, and injected DOM node with explicit
  cleanup.
- **One settings tree.** `src/settings/settings-tree.js` is the only
  settings-navigation source of truth. Never copy its category list elsewhere,
  and keep `src/settings/settings.js` off the main-page boot path.
- **Charts.** Preserve the live-update path, series ordering, and equal-length
  `x`/`y` arrays. A full redraw per frame is a regression.
- **Storage.** Make related IndexedDB writes in one transaction. Keep
  summary-first history paging.
- **Generated files.** Do not hand-edit `src/css/app.css` or
  `src/modules/echarts-streamline.min.js`. Change their inputs and rebuild.
  Commit source and generated output in the same PR.
- **Translations.** `src/ui/de1 gui translation - Sheet1.csv` is synced from
  Google Sheets by the release workflow. Hand edits there are overwritten — add
  translation keys and raise the wording in your issue instead.

### 3. Safety & Privacy (required)

- **Machine control is a review gate.** Anything that writes machine state,
  applies a profile or workflow change, updates firmware, or starts an operation
  must be explicitly described in the PR body. Validate and clamp values at the
  skin boundary — never forward an unvalidated number from a plugin, a scale, or
  user input into a machine write.
- **Fail safe.** A missing, slow, or erroring dependency must fall back to the
  existing manual behavior with visible state, never to a silent wrong value.
- Treat credentials, firmware payloads, profile notes, feedback text, and
  browser-stored data as sensitive. Do not log secrets, do not inject untrusted
  text as HTML, and never broaden credential persistence or copy secrets into the
  synchronized Decaid KV namespace.

### 4. Tests (required)

New behavior needs a test. Bug fixes need a regression test.

- Node's built-in runner, strict assertions. No test framework, no jsdom.
- Files are `test/<topic>.test.mjs`. Fold new checks into the existing file for
  that subject rather than adding a file per concern.
- Tested modules must be DOM-free at import time. If logic lives in a
  DOM-coupled module, extract a pure helper and import it from both the browser
  module and the test — do not contort production startup to make a page module
  importable.
- Cover pure policy, parsing, state transitions, queueing, migration, and
  rendering decisions.

```bash
npm test                          # full suite, must pass
node --test test/<topic>.test.mjs # while iterating
```

### 5. Manual Validation (required for browser-facing changes)

Node tests give no layout, canvas, IndexedDB upgrade, network timing, touch
input, or hardware behavior. For UI changes, serve the app and exercise: first
boot and reload, direct subpage URLs, navigation loops, slow or unavailable
Decaid, machine/scale connect and reconnect, light and dark themes, a long-label
language, and target tablet/WebView sizing. State in the PR what you tested and
what hardware you could not test.

### 6. Do Not Touch in a Contribution (required)

- **No version bumps.** The version appears in several files and is bumped by
  maintainers as part of release. See [`RELEASE.md`](RELEASE.md).
- **No tags, releases, workflow dispatches, or repository setting changes.**
- **No skin identity changes** (`skin-manifest.json` name/id). A fork that renames
  the skin to coexist with official Streamline must drop that change before
  upstreaming.
- **No generated `dist/` edits.**

## Plugin Integrations

Decaid plugins are the supported way to add optional features that need their own
logic, storage, or settings. For a skin-side integration:

- Feature logic, calibration, and persistent plugin settings belong in the
  Decaid plugin, not in the skin.
- The skin should discover plugins generically. Do not add a hardcoded
  per-plugin entry to `src/settings/settings-tree.js`.
- Extending a shared control (steam, chart, profile UI) must be capability-driven
  and a no-op when the plugin is absent: with the plugin uninstalled or disabled,
  behavior must be identical to today.
- Plugin traffic goes through `src/modules/api.js` like everything else.
- Document the plugin-side contract in the plugin's own repository and link it
  from the PR.

## Code Style

- Follow the existing patterns in the file you are editing.
- Prefer small pure helpers and existing modules over new globals. Add to
  `window.app` only when injected HTML or an established cross-page bridge
  requires it.
- Use the existing logger for production diagnostics. No noisy per-frame logging.
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:`). Subject ≤72 chars. Explain the *why* in the body.

```
fix(steam): restore manual settings when leaving auto mode

Auto mode overwrote the stored flow/time when the plugin returned a
calculation, so switching back to F or T kept the calculated values.
Snapshot manual settings on mode entry and restore on exit.
```

## Completion Checks

Run before pushing:

```bash
npm ci
npm test
npm run build      # only if you changed a Tailwind or ECharts input
git diff --check
git status --short
```

## AI-Assisted Contributions

AI-assisted development is allowed. Contributors may use Claude, Codex, ChatGPT,
GitHub Copilot, or other coding agents.

AI assistance does not transfer responsibility. By submitting a PR you
acknowledge that:

- you have reviewed and understand the changes you are submitting, including
  AI-assisted or AI-generated ones;
- you take responsibility for their correctness, safety, licensing, and
  provenance; and
- you can explain and maintain them through review.

Do not submit generated changes you have not personally reviewed and validated.

## Third-Party Code & Attribution

If your contribution derives from another project — code, algorithms, heuristics,
or assets — say so in the PR, name the source, and confirm its license permits
redistribution under this repository's license. Credit the original author in the
source file and the PR body.

## License & Sign-Off

Streamline.js is licensed under the GNU General Public License v3.0 or later, the
same terms as Decaid. See [`LICENSE.txt`](LICENSE.txt).

By submitting a PR you agree your contribution is licensed under the same terms
as the repository and that you have the right to contribute it. No CLA required.

## Questions

Open an issue or start a discussion. For agent-specific guidance, see
[`AGENTS.md`](AGENTS.md).
