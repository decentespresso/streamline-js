# Streamline.js

A modern web UI skin for the Decent Espresso DE1, built on top of [Decaid](https://github.com/decentespresso/decaid). This is a full rewrite of the original TCL-based Streamline skin into a browser-native web application — no framework, no bundler, just HTML/CSS/JS served as static files.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Vanilla JavaScript (ES6 modules) |
| Styling | Tailwind CSS + daisyUI (CDN) |
| Charting | Plotly.js |
| Local storage | IndexedDB |
| Communication | WebSocket + REST (via Decaid) |
| Fonts | Inter, NotoSansMono |

---

## Implemented Features

### Real-Time Shot Visualization
- Live pressure, flow, and group temperature charting via Plotly.js
- Target vs. actual overlay lines (dashed = target)
- Phase step markers and annotations
- Scale weight display during extraction

### Shot Settings Control
- Dose in/out, grind size, brew temperature
- Steam temperature, duration, and flow
- Hot water volume, temperature, duration, and flow
- Pre-shot flush duration and flow
- Mobile-friendly numpad modal with value history from previous shots

### Profile Management
- Browse, search, and select from all available profiles
- 5 quick-access favorite profile slots in the header
- Upload, rename, hide, and delete profiles
- Profile metadata display (author, notes, parameters)

### Profile Editor
- Full in-browser profile editor accessible via EDIT button in the profile selector
- Inline step card editing — 4 steps visible at a time, horizontally scrollable
- Per-step controls: name, temperature (−/+), pump type (Flow/Pressure), rate, transition (fast/smooth), exit condition, and message
- Settings tab: target weight, volume, tank temperature, volume count start, beverage type
- Review tab: plain-English step summaries, profile settings overview, and Plotly graph preview (pressure, flow, temperature scaled to shared y-axis with step boundary markers)
- Auto-suffixes duplicate profile names on save (e.g. "My Profile (2)")
- Saves user-edited copies to Decaid's KV store (`/api/v1/store/streamline/{uuid}`) — original default profiles are never modified
- KV-saved profiles are loaded and merged into the profile list on every selector load
- RESET button in the selector right panel: deletes a KV copy and restores selection to the original parent profile, with confirmation dialog

### Shot History
- Paginated shot history backed by IndexedDB
- Tap any past shot to replay its data on the chart
- Per-shot metrics: pre-infusion, extraction, and total phase summaries

### Machine Control
- Start/stop espresso, steam mode, hot water dispensing
- Machine sleep button
- Real-time water tank level display
- DE1 and scale device scan/connect/disconnect
- Auto-reconnection with exponential backoff on WebSocket drop
- **Non-GHC machine controls** — when connected to a machine without a Group Head Controller, a dedicated right-side column appears with Coffee, Water, Steam, Flush, and Stop buttons; active state visually disables action buttons and highlights Stop in red

### Settings
- **Bluetooth** — scan and connect DE1 and scale; scale auto-connect
- **Calibration** — fan threshold, advanced heater phase flow (DE1 settings)
- **Skin** — light/dark theme toggle; skin switcher (reloads to apply); presence-based auto-sleep with configurable schedule; wake-lock toggle
- **Display** — brightness control and auto-brightness toggle; display size (zoom) selector with localStorage persistence
- **Language** — multi-language support via CSV-based i18n; runtime language switching
- **Extensions** — Shot Uploader page and one generic settings card per installed plugin (including Visualizer), rendered from each plugin's manifest
- **REA Settings** — weight/volume flow multipliers; gateway mode selection
- **Updates** — Decaid app version, build info, machine firmware version and serial; DE1 firmware file upload
- **User Manual** — links to Decent Espresso support, quickstart, and skin dev docs
- **Talk to Decent** — in-app email support via Decent's API; conversation history; compose new support messages
- **Send Feedback** — bug/feature/general category selector; markdown description editor (EasyMDE); optional Decent account sign-in to tag reports; system info attachment toggle; submits as GitHub issue via Decaid
- **Keyboard Shortcuts** — reference page for available keyboard shortcuts

### Profile Notes
- Markdown editor (EasyMDE) accessible from the profile editor; full toolbar with bold/italic/headings/lists/links/preview; autosaved per-profile

### UI & UX
- Light/dark theme (persisted in `localStorage`)
- Responsive scaling for landscape tablets and mobile
- Rotation prompt for portrait devices
- Long-press support on +/− buttons for rapid value adjustment

---

## Coming Soon

### Settings — Unimplemented / UI-only
- [ ] Quick Adjustments: Steam, Water, Limit save buttons (UI exists, not wired)
- [ ] Calibration: Reset defaults, Refill Kit calibrate, Voltage / Stop-at-Weight / Steam save, Slow Start (disabled — not supported by firmware API)
- [x] Calibration: Fan threshold save
- [ ] Maintenance: Transport Mode (not supported by firmware API)
- [x] Maintenance: Descaling Start, Air Purge
- [x] Skin: Theme toggle, Skin Apply (set active skin)
- [ ] Miscellaneous: Screen Saver toggle, Units selector, Resolution selector (UI exists, not wired to backend)
- [x] Miscellaneous: Display Size (zoom) — saves to localStorage
- [x] Miscellaneous: Smart Charging — mode selector, night mode schedule, live charging status
- [ ] Updates: Firmware Check, App Update Check buttons (UI exists, not wired)
- [x] Updates: Firmware file upload to DE1
- [ ] Bluetooth: Machine auto-connect (scale auto-connect works)

### Features
- [x] Advanced in-browser profile editor (create and edit profiles, not just upload/delete)
- [x] Profile notes with full markdown editor (EasyMDE) in the profile editor
- [x] Send Feedback form — markdown editor, Decent account tagging, system info, GitHub issue submission
- [x] Talk to Decent — in-app email support thread viewer and composer

---

## Getting Started

**Prerequisites:** [Decaid](https://github.com/decentespresso/decaid) must be running and accessible on `localhost:8080`. It serves the skin itself on `localhost:3000`.

```bash
# Clone the repo
git clone <repo-url>
cd streamline_js

# Serve from the repo root — no build step required
python3 -m http.server
```

Open `http://localhost:8000` in your browser.

**Custom hostname:** If Decaid runs on a different host, set it before loading the app:

```js
localStorage.setItem('reaHostname', '192.168.1.x:8080')
```

---

## Project Structure

```
src/
├── modules/
│   ├── api.js              # All REST + WebSocket I/O; MachineState enum
│   ├── app.js              # Bootstrap, global state, WebSocket wiring
│   ├── ui.js               # DOM update functions
│   ├── chart.js            # Plotly real-time shot graph
│   ├── profileManager.js   # Profile CRUD
│   ├── profile_selector.js # Profile browser UI
│   ├── profile_editor.js   # In-browser profile editor (steps, settings, review)
│   ├── history.js          # Shot history (IndexedDB + API)
│   ├── shotData.js         # Shot metric display
│   ├── waterTank.js        # Water level WebSocket
│   ├── router.js           # SPA sub-page loader
│   ├── numpad-modal.js     # Mobile numeric input
│   ├── scaling.js          # Responsive scaling / orientation
│   ├── i18n.js             # CSV-based translations
│   └── idb.js              # IndexedDB wrapper
├── settings/               # Settings page HTML + JS
├── profiles/               # Bundled example profiles (JSON)
├── css/                    # main.css, dark-mode.css, numpad-modal.css
└── ui/                     # Fonts, icons, images
```

---

## Profiling a live shot on the device

The open performance findings in #161 are all device-dependent, and a desktop
browser answers none of them. `src/modules/perf-probe.js` times the live-shot
path in place, on whatever tablet is actually running the skin.

**Every shot leaves one line behind, in every build:**

```
[AUDIT] perf: ua=... cores=8 dpr=2 screen=1920x1200
[AUDIT] perf: shot 24.1s n=240 chart=0.70/9.9 shotData=0.19/2.5 status=0.09/0.3 (mean/max ms)
```

Nothing has to be switched on. The skin runs in Decaid's WebView, which has no
address bar, so anything a user cannot reach would only ever measure developers'
machines — the hardware the question is not about. Decaid attaches the console
log to in-app feedback, so the numbers arrive with any bug report, from whatever
tablet the person owns. The device line is emitted once per session, before the
first summary.

Runs shorter than `MIN_REPORTED_SHOT_S` are dropped: a two-second flush measures
the machine stopping, not the skin.

**Verbose mode**, where an address bar exists (dev server, desktop browser, a
tablet with remote debugging): open the skin with `?perf=1` and the full table is
reported every 10 s, shot or no shot. `?perf=0` clears it; the flag persists in
between, so Decaid re-serving the skin on another port keeps it on.

Segments measured: `status`, `sleepButton`, `strip`, `temps`, `chart`,
`shotData`, `chartFlush`.

Read the numbers against the device line: the target is an older Android 12
tablet, not a current Samsung.

---

## Contributing

See `CLAUDE.md` for coding conventions, [`docs/API.md`](API.md) for the REST and WebSocket reference, and `DESIGN_SYSTEM.md` for the design system.

Key rules:
- Tailwind + daisyUI only — no custom CSS unless unavoidable
- Use `Plotly.update()`, not `Plotly.react()`, for chart updates
- Profile changes must go through the workflow API wrapper in `api.js`
- IndexedDB writes must be atomic
