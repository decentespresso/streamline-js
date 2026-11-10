# Debug personas

Six scripted users that drive the real skin in a real Chromium against a real
Decaid. This is a **debugging harness, not a test suite**: nothing asserts, every
step is soft, and the output is the evidence — console errors, page errors,
failed requests, a screenshot per step and a Playwright trace per persona.

`node --test` does not pick these up (no `*.test.mjs` names), so `npm test`
stays the DOM-free unit suite.

## Run

```
npx playwright install chromium        # once
node test/personas/run.mjs             # all six
node test/personas/run.mjs quinn dana  # pick some
node test/personas/run.mjs --headed    # watch it
node test/personas/run.mjs --base=http://localhost:8044 --decaid=http://localhost:8080
node test/personas/run.mjs --shot-seconds=20
```

Needs the dev server (`:8044`) and Decaid (`:8080`) already up. The runner exits
immediately if either is unreachable.

Artifacts land in `test/personas/out/<persona>/`:
`report.json`, numbered step screenshots, `trace.zip`.

```
npx playwright show-trace test/personas/out/fiona/trace.zip
```

## The personas

| id | who | what it exercises |
| --- | --- | --- |
| `quinn` | Quick Shot Quinn | boot → wake → favourite → one shot → history → sleep. The path that must never break. |
| `dana` | Dial-in Dana | DYE2 opt-in: shot, dose/yield/grind edits, P/F/R strip modes, DYE overlay open and return. |
| `theo` | Profile Tinkerer Theo | profile selector, profile editor, chart expand, history paging. Router cleanup and re-mount. |
| `sam` | Settings Spelunker Sam | every top-level settings category, settings search, cancel, reload. |
| `fiona` | Flaky Network Fiona | network dropped mid-shot and mid-subpage, then a direct `?page=settings` launch. Reconnect and double-mount bugs. |
| `tam` | Tiny Tablet Tam | 1024×600 viewport, 4× CPU throttle. Overflow, scaling, frame drops. |

## Machine commands

MockBengle reports `GHC: true`, so the skin hides its on-screen GHC column — a
persona starts and stops a shot the way a real user does, by pressing the
machine, which from here is `PUT /api/v1/machine/state/<state>` on Decaid.
Decaid's `blockOnNoScale` can refuse `espresso` with no scale connected; the
refusal body is recorded in the step note rather than swallowed.

Personas never save settings (they leave via Cancel), but a shot run **does**
write real history and shot state to Decaid. Run them against a mock machine.

## Known noise in the output

- **WebSocket 429 / 503 on boot.** Decaid's admission gate is per client IP and
  localhost makes every client the same IP: 32 concurrent sockets, 32 new
  sockets a second. The skin opens ~15 long-lived sockets per tab, so a persona
  run while your own skin tab is open sits right on the ceiling and the handshakes
  start coming back `429 client_admission_limit`. Close the other tab for a clean
  read of the console counts.
- Back out of the profile editor and the selector shows a red
  `No profile data found. Returning to selector.` toast. Seen on every Theo run;
  not yet investigated.

## Adding a persona

Add an entry to `personas.json` — `viewport`, optional `cpuThrottle`,
`storage` (localStorage seeded before any app script runs), and a `steps` list.
Steps resolve from the `STEPS` registry in `run.mjs`; add a new one there only
when no existing step covers it.

Settings categories are read off the live nav, never copied from
`settings-tree.js`.
