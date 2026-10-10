# Plugin settings UI

Streamline discovers installed plugins from Decaid's `GET /api/v1/plugins`
response. Each plugin gets an Extensions page with its name, description,
enable switch, version/update status and controls derived from its manifest
settings. An HTTP endpoint named `ui` adds an **Open** button.

## Hide fields managed by your plugin

Set `hidden` to the JSON boolean `true` on any setting that should be edited
through your plugin's own UI instead of Streamline's generated form:

```json
{
  "settings": {
    "flowReadings": {
      "type": "string",
      "label": "Measured flow calibrations",
      "default": "[]",
      "hidden": true
    }
  },
  "api": [{ "id": "ui", "type": "http", "data": {} }]
}
```

This fragment belongs in an otherwise complete plugin manifest. Mark all your
settings hidden if your own UI handles the entire configuration, or hide only
internal fields and leave ordinary settings visible. Hidden fields do not
contribute keywords to Streamline's settings search. The plugin's own name,
description and Extensions entry remain visible, as do **Open**, the enable
switch and version/update controls. Declaring a `ui` endpoint alone does not
hide anything.

Omitting `hidden`, or setting it to `false`, preserves the existing form.
Only the boolean `true` hides a setting; the string `"true"` does not.

Keep the hidden fields in the manifest with their existing types and defaults.
Decaid 0.8.8 passes each setting's metadata through to skins and uses the same
declarations to retain and validate stored values. Removing a declaration can
discard its saved value. This presentation hint neither deletes nor changes
settings, and does not conceal values from the REST API. Use Decaid's `secure`
setting mechanism for credentials.

This is a Streamline convention. It does not require a new Decaid build, but
Decaid's native settings screen and other skins need their own support to hide
the same fields. Older Streamline versions continue displaying them.

## Return to Streamline settings

The **Open** link includes a URL-encoded `returnTo` query parameter containing
the current skin address with `page=settings`. The host, actual skin port,
path and other query parameters are preserved. Streamline restores the selected
Extensions category through its existing settings-location state.

For example, a skin running at `http://localhost:24803/index.html?page=settings`
opens the plugin at:

```text
http://localhost:8080/api/v1/plugins/example.reaplugin/ui?returnTo=http%3A%2F%2Flocalhost%3A24803%2Findex.html%3Fpage%3Dsettings
```

Plugin UIs can read `returnTo` with `new URLSearchParams(location.search)` and
use it for their Back link after validating it. Accept only the intended
HTTP(S) skin host/origin, reject embedded credentials, and provide a fallback
for direct visits. Do not assume port 3000 is the skin's actual origin or rely
on `document.referrer` to retain the settings route.

Plugins that do not use `returnTo` can ignore the parameter. The plugin still
must declare an HTTP `ui` endpoint to receive an **Open** link.
