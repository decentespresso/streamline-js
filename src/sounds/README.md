# Sounds

`KeypressStandard_120.ogg` — the tap click, played by `src/modules/touch-sound.js`
when Settings > Miscellaneous > Enable sounds is on.

Taken unchanged from de1app, where it is registered as `button_in`
(`de1plus/utils.tcl`: `dui sound set button_in ".../sounds/KeypressStandard_120.ogg"`)
and played on a button press through `say`. Using the same file is deliberate:
a tap in Streamline should sound like a tap in de1app on the same machine.

de1app records its origin in a comment in the same file: the Android platform
sound effects, `android.googlesource.com/platform/frameworks/base/+/android-5.0.0_r2/data/sounds/effects/ogg`,
i.e. `KeypressStandard.ogg` from AOSP, at reduced volume (the `_120` suffix).
AOSP is licensed under Apache-2.0, which is compatible with this project's GPL.
