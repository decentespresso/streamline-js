# Switching skins from inside the webview

Ask Decaid to do it. One synchronous call:

```js
if (switchSkinNatively(window.decentApp, skinId)) return; // Decaid navigates
```

`window.decentApp.switchSkin(skinId)` (decaid#1108) returns `true` when the
host accepted the request and is driving the navigation itself, persisting the
new default in-process. It is **not** a Promise, and `true` is the only
acceptance — see `switchSkinNatively` in `src/modules/skin-version.js`, which
is also the feature probe: no host, no native nonce, not the trusted main-frame
SkinView, or an unknown skin all answer `false`.

Pass the installed skin's **ID**, never its name, URL or repo slug.

No token is involved. Do not reach for the management REST endpoints instead:
`PUT /api/v1/webui/skins/default` and `POST /api/v1/webui/server/{stop,start}`
are gated on an `extensions:manage` bearer token (decaid#1142), the skin holds
only an `account:proxy` one, and the refusal reaches the user as a bare 401.
Never expose an `extensions:manage` token to the skin to get around that.

## The legacy path, and why it is still there

`window.setActiveSkin` (`src/settings/settings.js`) falls back to
`setDefaultSkin() → stop → start → waitForSkinServer() → settle → :3000` when
the hook refuses. That branch exists **only for hosts older than the hook**,
where nothing else can switch a skin at all. It is not a retry of a failed
native switch and must not become one.

decaid#1191 restores pre-#1031 management-API compatibility by default, so on a
default-mode host those calls stop 401-ing — but the branch stays wrong on a
current host regardless, because of the race described below and because it
cannot work in protected café mode. Everything in this section is background
for maintaining that branch, not a pattern to copy.

Decaid serves the active skin folder on a **fresh ephemeral port every time**
(`webui_service.dart` `_serveFresh` binds port 0 and never reuses a port). So
restarting the server leaves the page that asked for the switch on an origin
that no longer exists.

### Why the dashboard exit cannot end a skin switch

`window.decentApp.exitToDashboard()` navigates to
`http://localhost:<port>/__decent/exit-dashboard`, where `<port>` is baked in
by `buildSkinApiJavaScript()` when the page was served. Decaid's webview gates
that navigation twice (`skin_view.dart`):

1. `classifySkinNavigation()` accepts the URL only if it is string-equal to
   `skinExitDashboardUrlForPort(<port Decaid is serving right now>)`, and
2. `SkinExitCoordinator.tryStart()` additionally requires the page's own
   top-level URL to be on that same port.

The restart moves that port while the page stays where it was, so after a
switch every exit URL available to us loses one check or the other:

| exit URL | outcome |
| --- | --- |
| the port skin-api.js baked in (dead) | fails check 1 — `Blocking navigation to: http://localhost:<old>/__decent/exit-dashboard` |
| the port `/webui/server/status` just reported | passes check 1, fails check 2 — `Rejected skin dashboard request` |
| port 3000 | fails check 1 — the served port is never 3000 |

A field log of six consecutive switch attempts shows exactly this: 46
`Blocking navigation` lines and 4 `Rejected skin dashboard request` lines, with
the only successful `Skin requested dashboard` in the whole log being an exit
that had no server restart before it.

### Port 3000 and the settle delay

Decaid keeps port 3000 bound as a permanent 307 redirector to whatever port
currently serves the skin (`_serveEntryPoint`), and `classifySkinNavigation()`
allows port 3000 outright as well as the live port the redirect lands on:

```js
window.location.assign(`http://${hostname}:3000/?_=${Date.now()}`)
```

Two things stay true of that branch:

- **Wait for the restart before navigating.** `waitForSkinServer()` polls
  `GET /api/v1/webui/server/status` until it reports `serving`.
- **Then wait a beat longer.** The webview compares against the port its own
  view currently holds; a navigation sent before it picks the new port up is
  classified as an external link and opens in the **system browser** instead of
  the webview (#186). The 5-second settle and the single retry after it exist
  for that window, and cannot close it — only the native hook does.

The plain "Go" exit button elsewhere in Settings is unaffected: it exits a skin
whose server has not been restarted, which is the case the host gate was
written for.
