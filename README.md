# Decaid and Streamline.js — User Manual

**Applies to:** Decaid (the app formerly called decent.app) and the Streamline.js skin, v0.1.109

---

## Table of Contents

**Part I — Getting started with Decaid**
1. [What Decaid is](#1-what-decaid-is)
2. [Installing Decaid and importing your de1app data](#2-installing-decaid-and-importing-your-de1app-data)
3. [Connecting your DE1 and scale](#3-connecting-your-de1-and-scale)
4. [Choosing a skin](#4-choosing-a-skin)
5. [Decaid settings](#5-decaid-settings)

**Part II — Using Streamline.js**
6. [How the interface works](#6-how-the-interface-works)
7. [The main screen](#7-the-main-screen)
8. [Pulling a shot](#8-pulling-a-shot)
9. [Steam, hot water, and flush](#9-steam-hot-water-and-flush)
10. [Profiles and the profile editor](#10-profiles-and-the-profile-editor)
11. [Derek, the smart assistant](#11-derek-the-smart-assistant)
12. [Shot history](#12-shot-history)
13. [Streamline settings](#13-streamline-settings)
14. [Troubleshooting](#14-troubleshooting)
15. [Appendix](#15-appendix)

**Building a skin or a plugin?** The REST and WebSocket API reference lives in
[docs/API.md](docs/API.md). Contributing to this skin? See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

# Part I — Getting started with Decaid

## 1. What Decaid is

Decaid is a ground-up rewrite of the software that drives your Decent Espresso machine. The rewrite
had two goals: easier development, and support for as many platforms as possible.

Decaid does not draw the coffee screen itself. It is the **bridge** between your machine and
whichever user interface — "skin" — you choose:

```
   DE1  ──►  tablet  ──►  Decaid  ──►  skin  ──►  your espresso
```

Decaid owns the hard parts. It handles the Bluetooth or USB connection, the scale, profile storage,
shot logging, and the API that skins build on. The skin owns what you look at and touch.

This manual covers Decaid in Part I and the **Streamline.js** skin in Part II.

### Supported platforms

| Platform | Notes |
|---|---|
| **Android** | Primary. Runs on the Decent tablets, and can run as a background service that holds the machine and scale connections |
| **iOS / iPadOS** | Via TestFlight while in testing |
| **macOS** | Full support |
| **Windows** | Full support |
| **Linux** | ARM64 and x86_64 |

Decaid connects over Bluetooth or USB, and supports the Bengle as well as the DE1.

### Downloads

| Platform | Where |
|---|---|
| Android, macOS, Windows, Linux | <https://github.com/decentespresso/decaid/releases> |
| iOS / iPadOS | <https://testflight.apple.com/join/R7YNeA67> |

> **iOS users:** Decaid is still in testing on iOS, so Apple's TestFlight distributes it. Install
> the **TestFlight** app from the App Store first. Then open the link above to install Decaid
> through it.

> **A note on the name.** Decaid has been renamed several times: **REA** ("Reasonable Espresso App")
> → **ReaPrime** → **Streamline Bridge** → **Decent.app** → **Decaid** in 2026, ten years after the
> first commit to the original `de1app` repository. The name commemorates that decade while
> describing what the app does: it **aids** you in making *decent* espresso.
>
> Only the display name changed. Decent deliberately left the internal identifiers alone, so
> existing integrations keep working. The old names still show up in the plumbing:
>
> | Identifier | Value |
> |---|---|
> | Dart package | `reaprime` |
> | Bundle ID | `net.tadel.reaprime` |
> | Database | `streamline_bridge` |
> | Plugin extension | `.reaplugin` (e.g. `dye2.reaplugin`) |
> | Streamline.js host key | `localStorage.reaHostname` |
>
> Use **Decaid** in prose; leave the identifiers alone.

---

## 2. Installing Decaid and importing your de1app data

Install Decaid from the download links above. Use the releases page on Android, macOS, Windows and
Linux. Use TestFlight on iOS and iPadOS.

The first time you run it on a tablet that already has `de1app`, Decaid offers to **import your
existing data**. Accept it. This is the easiest way to carry over what you already have.

Decaid reads `de1app`'s own files, including `settings.tdb` and the DYE plugin's `grinders.tdb`. It
brings across your settings, profiles, shot history, beans and grinders.

🎬 **Importing your de1app data.** The first-run import, start to finish.

https://github.com/user-attachments/assets/fe61e277-34b1-488b-b40f-d07536eead59

🎬 **Importing from inside the skin.** The same data brought in from the skin side.

https://github.com/user-attachments/assets/e9a01cce-31a1-4e6d-b858-4d970db71739

First-run setup walks through a short sequence:

- **Welcome** and **permissions**
- **Android warning**, where relevant
- **Data import** from `de1app`
- **Scan** for your machine
- **Sign-in** and **initialisation**

> If you skip the import at first run, you can still import later from Decaid's data management
> settings.

---

## 3. Connecting your DE1 and scale

On first use Decaid asks **which DE1 to connect to**. It lists the machines in range. Choose yours
and connect.

Decaid remembers your machine and auto-connects on later starts.

🎬 **Connecting your machine.** Scanning for a DE1 and pairing it.

https://github.com/user-attachments/assets/a12ff0f1-82b1-4b7e-88c3-4a432e220c90

Scales work the same way. Connect yours once, then enable auto-connect so it returns on its own.

See §13 for what the scale does when the machine sleeps.

---

## 4. Choosing a skin

A skin is the interface you actually touch. Decaid can install and serve several. Two are officially
supported:

| Skin | Notes |
|---|---|
| **Streamline** | Documented in Part II of this manual |
| **Insight** | The other officially supported skin |

Decaid's skin registry also carries community skins: Passione, OverDose, Beanie, NSX and WorkFlow.
They install the same way. This manual does not cover them.

🎬 **Switching skins.** Finding the skin list, installing one, and making it the default.

https://github.com/user-attachments/assets/d0dc9b10-8bd3-4928-8bcf-21526e6b9615

**To leave a skin and return to Decaid's dashboard: swipe right from the left edge of the screen or tap the blue house icon.**
Your device's back gesture works too.

Learn this before you open a skin. A skin fills the whole screen, with no visible way out.

### Viewing a skin in a browser

The skin also runs in an ordinary browser. Decaid serves it on **port 3000**:

```
http://localhost:3000
```

From another device on the same network, replace `localhost` with the tablet's own IP address —
the four numbers your router gave it, which you will find in the tablet's Wi‑Fi settings. If the
tablet is `192.168.1.42`, you type:

```
http://192.168.1.42:3000
```

Your tablet's numbers will differ. Type its address, not the one in the example.

**The in-app web view is the primary way to use a skin.** A browser is the secondary way. It is
handy for checking the machine from a laptop or phone, and for development. Everything works in
both.

| | In-app web view (primary) | Browser (secondary) |
|---|---|---|
| Fullscreen | The host OS owns the screen; the fullscreen button is hidden | Fullscreen button available |
| External links | The host opens them in the OS browser | Open normally |
| Leaving the skin | Swipe right from the left edge, or the floating **Exit to Decent dashboard** button | Not applicable |
| Browser engine | The tablet's Android System WebView | Whatever the browser ships |

> **Android WebView versions.** The in-app web view is only as good as the Android System WebView
> installed on the tablet. Some older versions — Teclast tablets are the known case — render skins
> incorrectly. Update Android System WebView and restart the device. Decaid detects an incompatible
> WebView and will point you at an external browser if the problem persists.

**Two ports, two jobs.** Port `3000` serves the skin — that is the one you type into a browser.
Port `8080` is Decaid's API, which the skin calls in the background. You never open `:8080` yourself.

---

## 5. Decaid settings

Decaid's dashboard handles the things that sit underneath any skin:

- **Data management** — import and export your data, the same machinery as the first-run de1app
  import (§2)
- **Device connections** and the machine it auto-connects to
- **Which skin** is served, and starting or stopping the web UI server

> **Most day-to-day settings live in the skin, not here.** Scale behaviour, language, the screen
> saver, brightness, themes and machine calibration are all reached from Streamline's own Settings
> screen — see §13. Decaid stores some of them, but the skin is where you change them.

---

# Part II — Using Streamline.js

## 6. How the interface works

Streamline.js reduces the main screen to **two gestures**:

| Gesture | What it does |
|---|---|
| **Single tap** | Runs the thing — applies a preset, starts an action, loads a profile |
| **Long press** | Opens a menu of options for that control |

That pattern is consistent, so when you want to *change* something rather than *use* it, press and
hold. A few examples:

| Long-press this | And you get |
|---|---|
| A favourite profile slot | Assign a different profile to the slot |
| The profile name at the top of the chart | Browse, edit, or revert the current profile |
| A preset (temperature, ratio, time…) | Edit it, save the current value into it, or reset it |
| The shot history panel | *Discuss with Derek* · *Copy Shot Summary* (§11) |
| The **?** button | Hide the button |

Values with **−** and **+** work as you would expect:

- **Tap** to step once
- **Tap the number itself** to type an exact value

The numpad also lists values from previous shots. Jump back to a known-good dose or temperature in
one tap.

### The built-in help

You do not have to remember any of this. **Tap the ? button in the bottom-right corner.** The screen
labels itself, captioning what tap and long-press do on every control.

Tap anywhere to dismiss it.

The help overlay exists on the main screen, the profile selector, the profile editor and the
settings screen. The screenshots throughout this manual are those overlays, so you can read them
here or on your own machine.

If the **?** button is in your way, long-press it to hide it.

---

## 7. The main screen

Everything lives on one page. It is laid out to put extraction information front and centre:

- **Left column** — the settings for the shot you are about to pull
- **Centre** — the chart, showing your most recent shot until a new one starts, then drawing live
- **Top** — five favourite profiles
- **Bottom** — the summary of the shot on screen, and arrows to step back through history

![The main screen with the help overlay showing](docs/media/main-screen-help.jpg)

### Top bar

**The top bar has two forms, depending on whether the DYE2 plugin is switched on.** DYE2 is **off by
default**, so unless you have turned it on you are looking at the first form.

#### Always present

| Element | What it does |
|---|---|
| Favourite slots | Five quick-access profile buttons. Tap to load; long-press to reassign |
| **Warmer** | Toggles the cup warmer (only if your machine reports the capability) |
| **Settings** | Opens the skin's settings (§13) |
| **Sleep** | Puts the DE1 to sleep |
| Fullscreen | Toggles browser fullscreen. Hidden in the in-app web view |

With DYE2 off, that is the whole top bar: profile favourites and nothing else. No P/F/R toggle, no
DYE button, no auto-favourite strip.

#### Only when DYE2 is switched on

| Element | What it does |
|---|---|
| **P / F / R** tabs | Switch the strip between **P**rofile favourites (default), **F** DYE2 auto-favourites, and **R** DYE2 recipes |
| Auto-fav / recipe strip | In **F** and **R** modes, shows DYE2's bean-and-recipe snapshots, ending with a **VIEW ALL** cell |
| **DYE** | Opens the DYE2 dashboard — bean, grinder and notes for the shot |

Turning DYE2 on shifts the favourite slots right to make room, so the bar visibly rearranges.

**Turning it on:** Settings → **Extensions** → **Describe Your Espresso** → the **DYE2** toggle. The
`dye2.reaplugin` plugin must be installed in Decaid, at or above its minimum version. Without it,
the toggle refuses to stay on and offers a download link.

Streamline.js only *reads* DYE2's data. A recipe hidden in DYE2 will not appear here.

In the in-app web view there is also a floating **Exit to Decent dashboard** button. Drag it to
move it; long-press to hide it.

### Left column — shot settings

| Row | What it sets |
|---|---|
| **Grind** | Your grinder setting. Recorded with the shot; it does not command the grinder |
| **Dose** | Dry coffee weight in grams |
| *(yield)* | Target beverage weight, shown with the ratio — `36g (1:2.0)`. Drives stop-at-weight when a scale is connected |
| **Brew** | Brew temperature |
| **Steam** | `Time \| Flow` |
| **Flush** | Duration or flow |
| **Hot Water** | `Temp \| Vol` |

Under most rows sits a strip of **presets**. Brew has four temperatures, Steam and Flush have times,
Hot Water has volumes.

Tap a preset to apply it. Long-press to edit it, overwrite it with the current value, or reset it.

Steam, Flush and Hot Water have a **mode switch** under the label — the small `Time | Flow` and
`Temp | Vol` control. Tap it to change which quantity you are editing. If a number looks wrong,
check the mode switch first.

### Centre — the chart

Between shots the chart shows your **most recent shot**, so you always have something to compare
against. During a shot it draws live:

- **Pressure** (bar) and **flow** (ml/s)
- **Group temperature** — actual solid, target dashed
- **Weight** and weight flow when a scale is connected
- Markers where the profile steps over

Tap the expand icon for full screen; the back arrow returns you.

### Right column — machine buttons (non-GHC machines)

If your DE1 has no Group Head Controller, a column of large buttons appears:

- **Coffee** — start espresso
- **Water** — dispense hot water
- **Steam** — start steam
- **Flush** — flush the group
- **Stop** — stop whatever is running

While the machine is busy, the action buttons dim and **Stop** turns red. GHC machines hide this
column. You use the physical controller instead.

---

## 8. Pulling a shot

1. **Choose a profile** — tap a favourite slot, or open the profile selector (§10).
2. **Set dose in** and **drink out** for your basket and ratio.
3. **Set brew temperature** if the profile default isn't what you want.
4. **Flush** the group.
5. Lock in the portafilter, cup on the scale.
6. **Tare** — tap the weight readout.
7. **Start** — the GHC, or the **Coffee** button.
8. Watch the chart. With a scale connected and *drink out* set, the machine stops at weight.
   Otherwise stop manually.
9. The summary fills in and the shot is written to history.

**No scale connected?** If your setup requires a scale for stop-at-weight, starting espresso is
blocked until one is connected — from the Coffee button and the keyboard shortcut alike.

---

## 9. Steam, hot water, and flush

**Steam.** Set the value in the left column (tap the *Steam* label to switch between temperature,
duration and flow). Start from the GHC or the **Steam** button. Steam stops on its duration limit,
or when you stop it.

**Hot water.** Tap the *Hot Water* label to choose volume, temperature, duration or flow, then set
the value. Start with the GHC or the **Water** button.

**Flush.** A pre-shot flush of a given duration and flow, for stabilising group temperature between
shots.

All three respect the machine's own limits; if a value refuses to go higher, the firmware is capping
it.

---

## 10. Profiles and the profile editor

### The profile library

Open the profile selector from the header. Every profile Decaid knows about runs down the left.
Tap one to preview its graph and notes on the right.

![The profile selector with the help overlay showing](docs/media/profile-selector-help.jpg)

**Tap** a profile to preview it. **Long-press** for more options: hide it, assign it to a favourite,
or edit it.

The toolbar above the list:

| Button | What it does |
|---|---|
| **+** Add profile | Start a new profile from scratch, upload a file, or import a share code |
| Eye — View all | Show hidden profiles as well |
| Magnifier — Search | Search your profiles |
| Sparkle — Decent Profile Generator | Design a new espresso profile in a few guided steps |
| Bin — Delete | Delete the selected profile. Built-in profiles are *hidden* rather than removed |

And the buttons around the preview:

| Button | What it does |
|---|---|
| **CONFIRM** | Use this profile for your next shot |
| **CANCEL** | Discard changes and return without switching profile |
| **EDIT** | Open the selected profile in the editor |
| **RESET** | Restore the selected profile to its original settings |
| **1**–**5** | Assign the selected profile to a favourite slot on the home screen |

### Adding a profile

Tap **+** to start a new profile. The editor opens with a ready-made template, so you can just build
from there — or, before you save, load something else into it instead. Both options live in the
editor's **SETTINGS** tab:

- **Upload Local File** — pick a profile file (`.json`) saved on your device. It loads into the
  editor to review; nothing reaches your library until you tap **SAVE**.
- **Import from Share Code** — enter the 4-character code from a profile shared on visualizer.coffee
  and tap **Import**. This needs a Decent Visualizer account already configured — if you haven't
  added one, a message tells you to set it up in Settings → **Extensions** → **Visualizer** (§13)
  first. A working code saves the profile straight to your library and opens it here so you can keep
  tweaking it.

Tapping **CANCEL** after loading either one asks you to confirm, since backing out can't be
undone — for a share-code import, confirming also removes it from your library again.

> An unreadable file, or a code that's wrong, expired, or tied to an account you're not logged into,
> shows an error instead of loading anything. If an import seems to succeed but nothing new shows up
> in the library, see [Troubleshooting](#14-troubleshooting) — profiles are matched by content, so an
> identical one may already be there under a different name.

### The editor

**EDIT** opens the profile editor. Three tabs: **STEP**, **SUMMARY** and **SETTINGS**.

![The profile editor with the help overlay showing](docs/media/profile-editor-help.jpg)

**STEP** is a grid. Each **column is one step**, and each row is one aspect of it. Tap any value to
edit it, or use the −/+ buttons; the card buttons under each column insert or delete steps.

| Row | What it means |
|---|---|
| **Temp** | Target temperature for the step, and which sensor it follows — Coffee or Water |
| **Pump** | The step's pressure or flow, and how fast it ramps there (**Quickly** or **Slowly**). **+ Limit** caps the opposite value |
| **Max** | The longest this step runs before moving on — by weight, time or volume |
| **Exit if** | End the step early when pressure or flow goes over or under a set value |

Two ways to view the same profile:

- **STEP (Grid view)** — the step cards above
- **SUMMARY (Text view)** — the profile as plain sentences, with a graph preview

**SETTINGS** holds the profile-wide values: dose, yield, temperature and so on.

Across the top:

| Control | What it does |
|---|---|
| Profile name | Tap the title to rename it |
| ↺ Version history | Restore an earlier version of this profile |
| **CANCEL** | Discard changes and exit the editor |
| **SAVE** | Save over this profile |

### How renaming protects the original

**Saving under a new name leaves the original untouched and keeps your version as a separate
profile.** Saving without renaming overwrites the profile you opened. So if you want to keep both,
rename first, then save.

Your edited copy is saved into Decaid's shared profile store — the same store every skin reads from
— so it is visible from other skins too, not just Streamline.

Built-in profiles never change. **RESET** in the selector removes your copy and restores the
original.

### Profile notes

The editor includes a full Markdown editor for per-profile notes — bold, italics, headings, lists,
links, live preview. Notes autosave per profile.


## 11. Derek, the smart assistant

Derek answers questions about your DE1 and your equipment, and can look at a specific shot with you.

**To ask Derek about a shot:**

1. **Long-press the shot history panel** on the main screen.
2. Choose **Discuss with Derek**.
3. The shot summary is copied to your clipboard and Derek opens.
4. Paste it into the chat and ask your question.

The same menu offers **Copy Shot Summary** if you only want the text.

🎬 **Asking Derek about a shot.** Copying a shot summary and asking a question.

https://github.com/user-attachments/assets/29869256-d63a-40ed-b8d3-2bf2876501ea

Derek is not limited to shots you paste in — you can ask it general DE1 and equipment questions too.

> Technically: the skin opens `derek.decentespresso.com` in the browser and copies the shot summary
> to your clipboard on the same tap. (Decaid also exposes a proxy at
> `POST /api/v1/derek/answers/stream` for skins and plugins that want to stream answers directly —
> see docs/API.md.)

---

## 12. Shot history

Streamline.js stores every shot twice: locally in the browser's IndexedDB, and in Decaid.

- **Step back** with the **←** / **→** arrows below the chart
- **Replay any shot** — selecting one redraws its full curve on the main chart, to compare against
  what you just pulled
- **Read the metrics** — each shot carries pre-infusion, extraction and total summaries
- **Keep scrolling** — history is paginated and loads more as you go back
- **Long-press the history panel** for Derek and copy options (§11).

---

## 13. Streamline settings

Reached from the **Settings** button. Eleven sections; numbering matches the on-screen menu.

Settings has a **search box**. Type a keyword to find any setting without knowing its category.

The category list runs down the left, with its sub-pages alongside. Drag the divider between the
panels to resize them. **SAVE** and **CANCEL** sit at the top right.

![The settings screen with the help overlay showing](docs/media/settings-help.jpg)

### 1. Quick Adjustments
Sub-pages for **Flow Multiplier**, **Steam**, **Hot Water**, **Water Tank**, **Flush** and **Machine
Advanced Settings**.

The two flow multipliers are worth understanding if your shots stop slightly early or late:

| Setting | Default | What it does |
|---|---|---|
| **Weight Flow Multiplier** | 1.0 | Applied to weight flow when projecting the final weight for stop-at-weight. Higher stops the shot earlier, lower stops it later |
| **Volume Flow Multiplier** | 0.3 s | Applied to machine flow when projecting volume for stop-at-volume. Accounts for the lag between the stop command and flow actually stopping |

### 2. Connection
Two sub-pages, **Machine** and **Scale**. This is the section to visit when devices stop responding.

Each known device shows its ID, a **Preferred** toggle, its availability, and **Reconnect** and
**Forget** buttons. To add a scale by hand, use **Add WiFi scale manually**.

![Scale settings, showing scale power mode and scale required](docs/media/scale-power-mode.jpg)

**Scale Power Mode** — what the scale does when the machine sleeps:

| Mode | Behaviour |
|---|---|
| **Nothing** | Stay connected and keep the scale's display on |
| **Display Off** | Stay connected but switch the scale's screen off; it comes back when the machine wakes |
| **Disconnect** | Drop the scale connection entirely |

**Scale Required** — prevents shots from starting when no scale is connected. This is the setting
behind the blocked-start behaviour described in §8.

### 3. Calibration
Sub-pages for **Default load settings**, **Refill Kit**, **Voltage**, **Fan**, **Steam** and — on
Bengle machines only — **Load Cells**, which walks through a load-cell calibration with a reference
weight. Some values here are read from the machine but not saveable, depending on what the firmware
API supports.

### 4. Machine
Sub-pages for **USB**, **Machine Information**, and — on Bengle machines only — **Cup Warmer** and
**Lighting** (LED strip).

### 5. Maintenance
**Machine Descaling** and **Transport Mode** (air purge).

### 6. Skin
**Theme & Updates** — light/dark theme, and the skin switcher. Applying a different skin reloads the
page.

### 7. Language
**Select Language → Display Language.** Choose the language for the interface. Switching takes
effect immediately — no reload needed.

![Language settings](docs/media/language.jpg)

### 8. Extensions
Three sub-pages:

**Visualizer** — toggle on and enter your Decent Visualizer credentials to upload shots
automatically.

**Plugins** — the plugins Decaid has installed.

**DYE2** — the *Describe Your Espresso* master switch, **default off**. Turning it on adds the P/F/R
toggle, the auto-favourite/recipe strip and the DYE button to the header (§7). Requires
`dye2.reaplugin` installed in Decaid.

### 9. Miscellaneous
A group of sub-pages: **Decaid Settings**, **Brightness**, **Wake Lock**, **Presence
Detection**, **Display Size**, **Temperature**, **Screen Saver**, **Keyboard Shortcuts** and
**Home Assistant**.

**Display size (zoom)** is persisted locally — useful on unusual tablet resolutions. **Temperature**
switches between °C and °F. **Smart charging** offers a night-mode schedule and live charging
status.

#### Screen Saver

The screen saver belongs to the skin, not to Decaid. Configure it here. It appears only while the
machine is **confirmed asleep**, and tapping it wakes the machine.

| Control | Notes |
|---|---|
| On / off | Enabled by default |
| Your own images | Upload one or more; thumbnails are shown, and you can clear them again |
| Image cycle | How long each image stays up, 2–600 seconds, default 10. Only meaningful with more than one image |
| Black screen | A plain black screen saver instead of images |

> The skin never raises the screen saver optimistically, and hiding it never wakes the machine —
> only your tap does. This is deliberate: an earlier version put the machine to sleep and woke it
> again 46 ms later because hiding the overlay also sent a wake command.

### 10. Updates
This page handles two separate updates: the machine's **DE1 firmware**, and **Decaid** itself.

**DE1 firmware**

- **Installed version** — the build now on the machine, shown at the top.
- **Automatic check** — opening the page checks for a newer build. There is no button to press.
- **Check result** — one of four states: *Firmware update available*, *Up to date*, *Newer than
  bundled* (a beta machine), or *Could not check* with the reason.
- **Download & Install** — appears only under *Firmware update available*, alongside the build
  number and release notes.
- **Manual upload** — pick a firmware file yourself, then press **Upload**. A progress bar and a
  **Cancel** button appear while it runs.

**Decaid**

- **Version and source** — version, build number, build time, branch, and commit.
- **Check for Updates** — also runs on its own when you open the page. The button is hidden once
  Decaid reports **Up to date**. It comes back if a check fails, so you can retry.
- **Update App** — replaces the check button when a new version is available. Builds that cannot
  update in place show a **View Release** link instead.

The machine serial number is on the **Machine Info** page (§4), not here.

> **Firmware uploads are not reversible from the UI.** Do not power off the machine or the tablet
> while one is in progress.

### 11. User Manual
Three sub-pages:

- **Quick Start Guide** — links to Decent Espresso support, the quickstart, and the skin developer
  docs
- **Talk to Decent** — read and reply to support conversations without leaving the app
- **Send Feedback** — file a bug, feature request or general report. Write it in Markdown, sign in
  with your Decent account to tag it, and attach system info. It arrives as a GitHub issue

The keyboard shortcut reference (§15) lives under **Miscellaneous** (§9), not here.

---

## 14. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Page won't load at all in a browser | Wrong port, or the web UI server is stopped | The skin is on `:3000`, not `:8080`. Check Settings → Skin, or `GET /api/v1/webui/server/status` |
| Page loads but everything is greyed out | Decaid not running or not reachable | Confirm Decaid's API is up on `:8080`; check `localStorage.reaHostname` |
| Skin renders wrong on the tablet only | Outdated Android System WebView | Update it and restart the device (§4) |
| Can't get out of a skin | — | Swipe right from the left edge of the screen |
| Machine shows disconnected after a network blip | WebSocket reconnected and reset connection state | Wait — reconnect uses exponential backoff. If it persists, reconnect from Settings → Connections |
| Scale weight jumps or flickers | Normal noise; readings are throttled | If it never settles, disconnect and reconnect the scale |
| Scale drops off every time the machine sleeps | Scale power mode is set to **Disconnect** | Change it in Settings → Connection → Scale (§13). The default is **Nothing** |
| Edited profile disappeared | Your edited profiles live in Decaid's memory | Check you are on the same Decaid instance you saved from |
| Uploading a profile appears to do nothing | Profiles are content-addressed — an identical one exists | Change the content, not just the title |
| Portrait "rotate device" prompt | The skin is landscape-only | Rotate, or lock the tablet to landscape |
| Chart stops updating mid-shot | Snapshot WebSocket dropped | It reconnects automatically; the machine keeps running regardless |

---

---

## 15. Appendix

### A. Keyboard shortcuts

Shortcuts fire only when a DE1 is connected, the machine is **non‑GHC**, and no text field has
focus. On GHC machines they are disabled — the physical controller is the input.

| Key | Action |
|---|---|
| `E` | Start espresso |
| `S` | Start steam |
| `W` | Dispense hot water |
| `F` | Flush |
| `Space` | Stop (idle) |
| `P` | Sleep |

Bindings are remappable and stored in `localStorage` under `keyboardBindings`.

### E. Glossary

| Term | Meaning |
|---|---|
| **DE1** | Decent Espresso machine |
| **GHC** | Group Head Controller — the physical control ring on the machine |
| **Decaid** | The middleware — <https://github.com/decentespresso/decaid>. Formerly Streamline‑Bridge, formerly Rea Prime (repo `reaprime`) |
| **Skin** | A web UI served by Decaid; Streamline.js and Insight are the two official ones |
| **de1app** | The original TCL application Decaid replaces. Decaid can import its data |
| **Derek** | Decent's assistant, reachable from the shot history long-press menu |
| **Bengle** | The other machine Decaid supports alongside the DE1 |
| **DYE2** | *Describe Your Espresso 2* — a separate Decaid plugin (`dye2.reaplugin`) for bean/grinder/notes, auto‑favourites and recipes. Off by default in Streamline.js |
| **Workflow** | A profile plus its shot settings, bean and grinder as one unit |
| **Content‑addressed** | Identified by a hash of the content, not by name |
| **Snapshot** | One frame of live machine data on the WebSocket feed |
