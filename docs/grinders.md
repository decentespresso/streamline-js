# Grinders

Streamline.js can show and set your grinder's setting, but the skin never talks to a grinder itself. **Decaid connects to a grinder through a grinder plugin.** No plugin for your grinder, no connection: the Grinder page (Settings > Connections > 3. Grinder) will say "No grinder found yet".

## 1. Install the plugin for your grinder

1. Find your grinder's plugin. Decaid keeps its list of device plugins under ["External device plugins"](https://github.com/decentespresso/decaid/blob/main/doc/Plugins.md#external-device-plugins); the table below adds the ones we know of.
2. Install it in Decaid: Settings > Extensions > Plugins, or from the plugin's own instructions.
3. Turn the plugin on. Turn the grinder on and bring it close to the tablet.
4. Open Settings > Connections > 3. Grinder, press **Search**, then **Connect** next to your grinder. **Auto-connect** makes Decaid connect to it by itself next time.

Known grinder plugins:

| Grinder | Plugin |
|---|---|
| Bookoo MT80 | [decaid-bookoo-mt80](https://github.com/Sofronio/decaid-bookoo-mt80) |
| xBloom Studio | [decaid-xbloom-grinder](https://github.com/tadelv/decaid-xbloom-grinder) |
| E64 (read-only, over WebSocket) | [decaid-e64ws-plugin](https://github.com/MaxRink/decaid-e64ws-plugin) |

Writing a plugin for another grinder: see "Grinder Registration" in Decaid's [`doc/Plugins.md`](https://github.com/decentespresso/decaid/blob/main/doc/Plugins.md#grinder-registration). A grinder plugin publishes a state and, optionally, a setting and rpm; it can declare the setting read-only (an observation) or settable.

## 2. Keep the Grind tile and the grinder in step

The Grind tile is a recipe value (remembered per profile). The grinder has its own reading. They are separate numbers until you connect them. Two switches on the Grinder page, both off by default and kept on this tablet:

- **Follow the grinder:** when the grinder's setting changes, the Grind tile takes it, as if you had typed it (the profile remembers it too). Use this for a hand-set grinder. It acts when the grinder's reading *changes*, so a value you type afterwards stays until the grinder moves again. Only plain numbers are followed; a grinder that reports text such as "espresso/A" is ignored.
- **Send the grind to the grinder:** changing the Grind tile sets the grinder. Only offered when the connected grinder can be set to a number (its plugin declares the setting command with a numeric range). The value is held to that range. A hand-set grinder cannot move its burrs, so leave this off for it.

With both on, a value one side just wrote is not sent back, so they do not fight.

The Grinder page also opens the plugin's own settings and diagnostics pages when the plugin offers them, in a dialog over the page with a **Close** button (a tap outside it or Escape closes it too). The host must allow the skin to frame those pages (`Content-Security-Policy: frame-ancestors` naming the skin's origin); the page gets `embed=1` and `theme=light|dark` like a plugin overlay. A page Decaid answers with an error, or one that does not load within 10 s, shows an error instead, and **Open anyway** under the dialog opens the page in place of the skin for a host that refuses to be framed (the kiosk then leaves the skin).

## For plugin authors

A plugin that wants the skin to follow a reading without the user flipping the switch can use the `tile-sync` surface instead; see [plugin-surfaces.md](plugin-surfaces.md#tile-sync).
