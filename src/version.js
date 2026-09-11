// Version baked into the running bundle. Compared against the on-disk skin version
// (GET /webui/skins/{id}) to detect that Streamline-Bridge has downloaded a newer
// skin in the background — a mismatch means "reload to apply".
//
// BUMP THIS when cutting a release, in the same step as pushing the git tag.
export const APP_VERSION = '0.1.111';

// Our skin id as registered with Streamline-Bridge (matches manifest.json / reaMetadata.skinId).
export const SKIN_ID = 'streamline.js';
