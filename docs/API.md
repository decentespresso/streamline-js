# Decaid API Reference

REST and WebSocket reference for [Decaid](https://github.com/decentespresso/decaid), for people
building skins, plugins or integrations. For using the app, see the
[user manual](../README.md).

---

## Contents

1. [What the API covers](#1-what-the-api-covers)
2. [Devices: scan, connect, forget](#2-devices-scan-connect-forget)
3. [Machine control over REST](#3-machine-control-over-rest)
4. [Live data over WebSocket](#4-live-data-over-websocket)
5. [Profiles and the workflow API](#5-profiles-and-the-workflow-api)
6. [Shots, beans, grinders](#6-shots-beans-grinders)
7. [The key–value store](#7-the-keyvalue-store)
8. [Plugins](#8-plugins)
9. [Skins and the web UI server](#9-skins-and-the-web-ui-server)
10. [Reference](#10-reference)

---

## 1. What the API covers

[Decaid](https://github.com/decentespresso/decaid) is a local server that owns everything
Streamline.js cannot do from a browser:

- **Bluetooth LE connections** to the DE1 and to scales
- **Machine state**, settings and firmware
- **Profile storage**, import/export and lineage
- **Shot and steam logging**, plus bean and grinder records
- **A key–value store**, so skins can persist their own data
- **A plugin system**
- **Skin hosting** — it serves the web UI itself

Anything a skin can do, you can do — Streamline.js is an ordinary API client with no privileged
access. Platforms and installation are covered in §1.

### Ports

| Port | Serves |
|---|---|
| `3000` | The skin — this is what you open in a browser |
| `8080` | REST API and WebSocket streams |
| `4001` | Browsable API documentation, while Decaid is running |

For the full API reference, start Decaid and open <http://localhost:4001>. You can also serve it
yourself from the checkout: `cd assets/api/ && npx httpserver -p 4001`.

> **Building a skin or a plugin?** This part is an orientation, not the specification. Decaid's own
> [Documentation](https://github.com/decentespresso/decaid/blob/main/README.md#documentation) goes
> deeper — [Skins.md](https://github.com/decentespresso/decaid/blob/main/doc/Skins.md) for the skin
> development workflow and release process,
> [Plugins.md](https://github.com/decentespresso/decaid/blob/main/doc/Plugins.md) for the plugin
> host API and manifest format,
> [Profiles.md](https://github.com/decentespresso/decaid/blob/main/doc/Profiles.md) for profile
> storage and hashing, and
> [DeviceManagement.md](https://github.com/decentespresso/decaid/blob/main/doc/DeviceManagement.md)
> for adding new device types. Full list in §11.

It exposes two API interfaces, both on port `8080`:

- **REST** — `http://<host>:8080/api/v1/...` (OpenAPI spec: `rest_v1.yml`)
- **WebSocket** — `ws://<host>:8080/ws/v1/...` (AsyncAPI spec: `websocket_v1.yml`)

Rule of thumb: **REST for commands and configuration. WebSocket for anything that changes many
times a second.**

All examples below use `localhost`. Substitute the tablet's IP when calling from another machine.

---

## 2. Devices: scan, connect, forget

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/devices` | List known devices |
| `POST` | `/api/v1/devices/scan` | Start a Bluetooth scan |
| `POST` | `/api/v1/devices/connect` | Connect a device |
| `POST` | `/api/v1/devices/disconnect` | Disconnect a device |
| `POST` | `/api/v1/devices/forget` | Forget a paired device |
| `*` | `/api/v1/devices/wifi` | Wi‑Fi configuration |

```bash
curl -X POST http://localhost:8080/api/v1/devices/scan
curl http://localhost:8080/api/v1/devices
```

There is also a **bidirectional** WebSocket channel, `ws/v1/devices`, which both accepts commands and
emits device state. That is what the app uses so the Connections screen updates live during a scan.

---

## 3. Machine control over REST

### State

```bash
# read current state
curl http://localhost:8080/api/v1/machine/state

# command a new state
curl -X PUT http://localhost:8080/api/v1/machine/state/espresso
curl -X PUT http://localhost:8080/api/v1/machine/state/steam
curl -X PUT http://localhost:8080/api/v1/machine/state/hotWater
curl -X PUT http://localhost:8080/api/v1/machine/state/flush
curl -X PUT http://localhost:8080/api/v1/machine/state/idle
curl -X PUT http://localhost:8080/api/v1/machine/state/sleeping
```

`idle` is the stop command. This is exactly what the Coffee/Water/Steam/Flush/Stop buttons do.

The full state set is: `booting`, `busy`, `idle`, `sleeping`, `heating`, `preheating`, `espresso`,
`hotWater`, `flush`, `steam`, `steamRinse`, `skipStep`, `cleaning`, `descaling`, `calibration`.

### Everything else

| Path | Purpose |
|---|---|
| `/api/v1/machine/info` | Model, serial, firmware version |
| `/api/v1/machine/capabilities` | What this machine supports (GHC? cup warmer? LED strip?) |
| `/api/v1/machine/profile` | Get/set the active profile |
| `/api/v1/machine/shotSettings` | Dose, temperature, steam, hot water, flush settings |
| `/api/v1/machine/settings` | Machine settings |
| `/api/v1/machine/settings/advanced` | Advanced settings (heater phase flow, etc.) |
| `/api/v1/machine/settings/reset` | Reset settings to defaults |
| `/api/v1/machine/calibration` | Calibration values |
| `/api/v1/machine/waterLevels` | Tank level |
| `/api/v1/machine/cupWarmer` | Cup warmer on/off |
| `/api/v1/machine/ledStrip`, `/ledStrip/commit`, `/ledStrip/reset` | LED strip colour control |
| `/api/v1/machine/firmware`, `/firmware/apply` | Upload and apply firmware |
| `/api/v1/machine/heartbeat` | Keep‑alive |

Call `capabilities` before showing hardware‑specific UI. That is how Streamline.js decides whether to
render the Warmer button and the non‑GHC control column.

### Scale

`GET /api/v1/scale/info` describes the currently connected scale. Its optional
`firmwareVersion` is an opaque string; `batteryLevel` is an optional integer
percentage or `null`. Missing or null metadata stays unknown. A host without
this endpoint may return 404, 405 or 501; 503 means no connected scale.

The inline Preferred control remains available for every scale. Skale devices
add a Settings popup only when the host exposes `skalePoweredByUsbByDevice`.
That key requires a Decaid release containing [decentespresso/decaid#745](https://github.com/decentespresso/decaid/pull/745),
which is still open. There is no legacy USB-setting fallback. The switch is a
manual USB-power declaration; the UI hides the battery level while enabled.

```bash
curl -X POST http://localhost:8080/api/v1/scale/tare
curl -X POST http://localhost:8080/api/v1/scale/timer/start
curl -X POST http://localhost:8080/api/v1/scale/timer/stop
curl -X POST http://localhost:8080/api/v1/scale/timer/reset
```

### Display and presence

| Path | Purpose |
|---|---|
| `/api/v1/display` | Display state |
| `/api/v1/display/brightness` | Screen brightness |
| `/api/v1/presence/settings` | Presence‑detection settings |
| `/api/v1/presence/schedules`, `/schedules/{id}` | Auto‑sleep schedules |

---

## 4. Live data over WebSocket

Connect to `ws://<host>:8080/<channel>`. Every channel emits JSON frames.

| Channel | Contents |
|---|---|
| `ws/v1/machine/snapshot` | **The main feed.** Pressure, flow, temperatures, state, timestamp |
| `ws/v1/machine/shotState` | Shot phase and decision frames, timestamped to match `snapshot` |
| `ws/v1/machine/shotSettings` | Shot settings whenever they change |
| `ws/v1/machine/waterLevels` | Tank level |
| `ws/v1/machine/raw` | Raw machine frames — debugging |
| `ws/v1/scale/snapshot` | Smoothed weight + weight flow, plus scale connection status frames |
| `ws/v1/devices` | Device state; also accepts commands |
| `ws/v1/display` | Display state |
| `ws/v1/sensors/{id}/snapshot` | A specific sensor's readings |
| `ws/v1/plugins/{id}/{endpoint}` | Plugin-provided streams |
| `ws/v1/logs`, `ws/v1/webview/logs` | Middleware and web view logs |
| `ws/v1/update` | App update progress |

Minimal client:

```js
const ws = new WebSocket('ws://localhost:8080/ws/v1/machine/snapshot');
ws.onmessage = (e) => {
  const s = JSON.parse(e.data);
  console.log(s.timestamp, s.pressure, s.flow, s.groupTemperature);
};
```

**Two practical notes:**

1. **Reconnect.** These sockets drop — tablets sleep, Wi‑Fi hiccups. Streamline.js wraps every socket
   in a reconnecting wrapper with exponential backoff. Do the same. Remember that a reconnect resets
   your view of connection status. Re-query state after reconnecting rather than trusting your last
   cached value.
2. **`shotState` and `snapshot` share a timebase.** Their timestamps line up, so you can correlate a
   phase transition with the exact pressure/flow sample that triggered it.

---

## 5. Profiles and the workflow API

### Profile endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` / `POST` | `/api/v1/profiles` | List / upload profiles |
| `GET` / `DELETE` | `/api/v1/profiles/{id}` | Fetch / delete one |
| `PUT` | `/api/v1/profiles/{id}/visibility` | Hide or show a profile |
| `GET` | `/api/v1/profiles/{id}/lineage` | Where this profile came from |
| `POST` | `/api/v1/profiles/{id}/purge` | Hard delete |
| `POST` | `/api/v1/profiles/import` | Import a bundle |
| `GET` | `/api/v1/profiles/export` | Export a bundle |
| `POST` | `/api/v1/profiles/restore/{filename}` | Restore from a backup |
| `GET` | `/api/v1/profiles/defaults` | The bundled default set |

> **Profiles are content‑addressed.** `POST /api/v1/profiles` deduplicates by a hash of the profile
> content. The title is *not* part of that identity. Uploading a profile whose content already exists
> is a silent no‑op, and renaming a profile alone will not create a new one. If you want a distinct
> profile, change its content.

### The workflow API

`/api/v1/workflow` is the wrapper endpoint. It ties a profile to its shot settings, bean and grinder
as a single unit.

**Use the workflow API to change the active profile — not `POST /api/v1/machine/profile` directly.**
Setting the machine profile on its own skips Decaid's bookkeeping. The shot that follows gets logged
with stale or missing associations.

Streamline.js routes all profile changes through the workflow wrapper for exactly this reason.

---

## 6. Shots, beans, grinders

### Shots and steams

| Path | Purpose |
|---|---|
| `GET /api/v1/shots` | List shots |
| `GET /api/v1/shots/ids` | Just the IDs — cheap for syncing |
| `GET /api/v1/shots/latest` | Most recent shot |
| `GET /api/v1/shots/{id}` | One shot with full sample data |
| `GET /api/v1/steams`, `/steams/ids`, `/steams/latest`, `/steams/{id}` | Same shape, for steaming sessions |

Typical sync pattern: pull `/shots/ids`, diff against what you already hold locally, fetch only the
new ones. That is how Streamline.js keeps IndexedDB in step without refetching everything.

### Beans and grinders

| Path | Purpose |
|---|---|
| `/api/v1/beans`, `/api/v1/beans/{id}` | Bean records |
| `/api/v1/beans/{beanId}/batches` | Batches (roast dates) for a bean |
| `/api/v1/bean-batches/{id}` | One batch |
| `/api/v1/grinders`, `/api/v1/grinders/{id}` | Grinder records |

These back the DYE2 (*Describe Your Espresso*) screen. Attaching a bean batch and grinder setting to
a shot makes your history searchable later.

---

## 7. The key–value store

A general-purpose namespaced store any skin can use.

```bash
# list a namespace
curl http://localhost:8080/api/v1/store/streamline

# read one key
curl http://localhost:8080/api/v1/store/streamline/<uuid>

# write one key
curl -X PUT http://localhost:8080/api/v1/store/streamline/<uuid> \
     -H 'Content-Type: application/json' \
     -d '{"...":"..."}'
```

Streamline.js uses the `streamline` namespace to hold user-edited profile copies (the profile editor in the manual). Pick your own
namespace for your own skin; do not write into someone else's.

---

## 8. Plugins

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/plugins` | List installed plugins |
| `GET`/`PUT` | `/api/v1/plugins/{id}/settings` | Plugin settings |
| `POST` | `/api/v1/plugins/{id}/enable` | Enable |
| `POST` | `/api/v1/plugins/{id}/disable` | Disable |
| `DELETE` | `/api/v1/plugins/{id}` | Remove |
| `POST` | `/api/v1/plugins/install` | Install |

Plugins can also publish live streams at `ws/v1/plugins/{id}/{endpoint}`. Two the app consumes:

- `time-to-ready.reaplugin` → `timeToReady` — countdown until the machine is at temperature.
- `decent-profile.reaplugin` → `profileGenerated` — generated-profile notifications.

### Derek

Derek (see the manual) is not a plugin — Decaid proxies it directly:

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/api/v1/derek/answers/stream` | Forwards the request body to `https://derek.decentespresso.com/api/answers/stream` and streams the response back as `text/event-stream` |

Proxying it through Decaid means a skin never needs the upstream address or its own network path to
it.

---

## 9. Skins and the web UI server

The middleware hosts the web UI itself, which is how a tablet gets Streamline.js without any separate
web server. **Decaid serves the skin on port `3000`** — `http://localhost:3000`, or
`http://<tablet-ip>:3000` from another device. The REST and WebSocket APIs stay on `8080`.

The `/webui/server/*` endpoints below control that port‑3000 server.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/webui/skins` | List installed skins |
| `GET`/`DELETE` | `/api/v1/webui/skins/{id}` | One skin |
| `PUT` | `/api/v1/webui/skins/default` | Set the active skin |
| `POST` | `/api/v1/webui/skins/install/github-release` | Install from a GitHub release |
| `POST` | `/api/v1/webui/skins/install/github-branch` | Install from a GitHub branch |
| `POST` | `/api/v1/webui/skins/install/url` | Install from a URL |
| `POST` | `/api/v1/webui/skins/update` | Update installed skins |
| `GET` | `/api/v1/webui/server/status` | Is the UI server running |
| `POST` | `/api/v1/webui/server/start` / `/stop` | Start / stop it |
| `GET` | `/api/v1/webui/skin-assets/{id}/{filepath}` | Serve a skin asset |

A skin is identified by its `skin-manifest.json`:

```json
{
  "id": "streamline.js",
  "name": "Streamline.js",
  "description": "Modern, feature-complete WebUI skin for Streamline-Bridge",
  "version": "0.1.95"
}
```

The normal upgrade path has two steps. Install a new version from a GitHub release, then set it as
default. This is what Settings → Skin drives.

---
---

## 10. Reference

### B. Local browser storage keys

| Key | Purpose |
|---|---|
| `reaHostname` | Middleware host (port is always `8080`) |
| Theme key | Light/dark selection |
| Display size key | UI zoom level |

Shot history lives in IndexedDB, not `localStorage`.

### C. Spec files in the repository

| File | Contents |
|---|---|
| `rest_v1.yml` | Full OpenAPI 3.0 REST specification |
| `websocket_v1.yml` | Full AsyncAPI 3.0 WebSocket specification |
| `DESIGN_SYSTEM.md` | Design tokens and component patterns |
| `CLAUDE.md` | Build and contribution conventions |

### D. Decaid's own documentation

Decaid keeps its in-depth guides in
[`doc/`](https://github.com/decentespresso/decaid/tree/main/doc), indexed from the
[Documentation section](https://github.com/decentespresso/decaid/blob/main/README.md#documentation)
of its README. Go there for anything this manual only summarises:

| Document | Covers |
|---|---|
| [Skins.md](https://github.com/decentespresso/decaid/blob/main/doc/Skins.md) | Skin development — REST and WebSocket reference, development workflow, deployment via GitHub Releases |
| [Plugins.md](https://github.com/decentespresso/decaid/blob/main/doc/Plugins.md) | JavaScript plugin development — host API, event system, manifest structure, examples |
| [Profiles.md](https://github.com/decentespresso/decaid/blob/main/doc/Profiles.md) | Profiles API — content-based hash IDs, version tracking, import/export, storage architecture |
| [DeviceManagement.md](https://github.com/decentespresso/decaid/blob/main/doc/DeviceManagement.md) | Device discovery and connection management — transport abstraction, auto-connect, adding device types |
| [RELEASE.md](https://github.com/decentespresso/decaid/blob/main/doc/RELEASE.md) | Release process — Git tag workflow, GitHub Actions CI, versioning |

Also in that repository:

| Location | Contents |
|---|---|
| [`assets/api/`](https://github.com/decentespresso/decaid/tree/main/assets/api) | The browsable API documentation served on port `4001` |
| [`README.md`](https://github.com/decentespresso/decaid/blob/main/README.md) | Features, platforms, skins, plugins, naming history |
