# Visualizer settings browser verification

The fixture loaded the real `src/settings/settings.js`, `src/modules/api.js`, and
`src/modules/visualizer.js` modules in Chromium with a mocked Decaid bridge.

Covered flows:

- default hosted URL and masked credential state;
- HTTP local server warning;
- custom reverse-proxy path and trailing-slash normalization;
- immediate credential clearing when the server changes;
- a server-only first write with no credentials;
- credential verification and save against the selected server;
- equivalent trailing-slash edits preserving entered credentials;
- zero browser page errors.

The captured request/result evidence is in `result.json`.
