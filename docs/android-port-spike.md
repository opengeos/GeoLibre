# Android port spike (Tauri v2)

Status: **a debug APK now builds and installs.** `tauri android init` + `tauri
android build --debug --apk` produces
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
(~208 MB — see "Bundle config" about trimming the bundled Python backend). The
only source change required to compile for Android was cfg-gating the desktop-only
OAuth-popup window code (see §C below). CI builds the APK via
`.github/workflows/android.yml`.

This documents what it takes to ship GeoLibre as a native Android app, what is
already in place, and what still needs work for a *production-quality* app.
Companion effort: closing the PWA offline gaps (the lower-cost "Android via
installable web app" path).

GeoLibre is built on **Tauri v2, which targets Android and iOS**, so a native
build reuses the same React codebase. The crate is already structured for it —
`apps/geolibre-desktop/src-tauri/src/lib.rs:118` has
`#[cfg_attr(mobile, tauri::mobile_entry_point)]`, so it compiles for a mobile
target in principle. The work is in the toolchain and the desktop-only
assumptions, not in a rewrite.

## 1. Build toolchain

Verified working set: Tauri CLI 2.11.2, **JDK 21** (Android Studio's bundled JBR
— the system JDK 26 is too new for the Android Gradle Plugin, so point `JAVA_HOME`
at a 17/21 JDK), Android SDK **platform android-34**, **build-tools 34.0.0**,
**NDK 27.3.13750724 (r27 LTS)**, and the four Rust Android targets via rustup.

Local one-time setup (multi-GB download + license acceptance):

```bash
# 1. Android SDK components (sdkmanager ships with Android Studio cmdline-tools).
#    Install into a user-writable SDK root to avoid sudo:
export ANDROID_HOME="$HOME/Android/Sdk"
export JAVA_HOME=/opt/android-studio/jbr           # a JDK 17 or 21
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" \
  "platform-tools" "platforms;android-34" \
  "build-tools;34.0.0" "ndk;27.3.13750724"
export NDK_HOME="$ANDROID_HOME/ndk/27.3.13750724"  # tauri needs NDK_HOME

# 2. Rust + Android targets (this repo's machine had pacman rust w/o rustup):
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  i686-linux-android x86_64-linux-android

# 3. Scaffold + build (from apps/geolibre-desktop)
npx tauri android init                       # creates src-tauri/gen/android
npx tauri android build --debug --apk        # -> app-universal-debug.apk
npm run tauri android dev                     # run on emulator / device
```

CI does the same on `ubuntu-22.04` in `.github/workflows/android.yml`
(`android-actions/setup-android` for the SDK, `sdkmanager` for NDK/platform,
`dtolnay/rust-toolchain` with the four targets), uploads the APK as an artifact,
and runs on PRs touching `apps/**`/`packages/**`, on `main`, or on demand.

## 2. Code readiness — what breaks on Android

Investigated across `src-tauri/src` and `apps/geolibre-desktop/src`. The single
most important structural issue: **`isTauri()` (`src/lib/is-tauri.ts:7`) is the
only runtime gate, and it is `true` on Android.** Every desktop-only feature is
gated on `isTauri()`, so on Android they would all appear available and then fail
at runtime. The first real task is introducing a mobile-vs-desktop distinction
(add `@tauri-apps/plugin-os` and a `isDesktop()` / `isMobile()` helper) and
re-gating the items below.

### A. Python sidecar — biggest functional gap

There is no Python process on Android. The entire sidecar lifecycle is
desktop-only:

- `src-tauri/src/lib.rs:724-825` spawns `uv run … uvicorn … --port 8765` via
  `std::process::Command`.
- `lib.rs:1117-1178` downloads/runs the `uv` installer via `sh`/`powershell`.
- `lib.rs:827-1075` stops it via Unix `kill` / `/proc` scraping.
- Client base-URL resolves to `http://127.0.0.1:8765` for the Tauri runtime
  (`packages/processing/src/sidecar-client.ts:28-45`).

Impact: **Processing → Whitebox, Raster (rasterio), Conversion, AI Segmentation
(`/ml`), and the SedonaDB SQL path lose their backend.** Vector tools are fine —
they run client-side in Turf.js. SedonaDB SQL already degrades gracefully to the
client engine (`src/lib/sedona-workspace.ts:351-401`); the others need to be
hidden on mobile or pointed at a *remote* sidecar endpoint.

### B. Local files / MBTiles / raster — Android scoped storage

Android dialogs return content URIs, not absolute paths; the app assumes real
filesystem paths throughout:

- MBTiles: custom `geolibre-mbtiles://?path=<abs>` protocol → Rust
  `read_mbtiles_tile` opens SQLite by absolute path (`src-tauri/src/lib.rs:1585`,
  `src/lib/mbtiles.ts:28-53`).
- Local vector/raster/project reads via absolute paths throughout
  `src/lib/tauri-io.ts` (e.g. `loadTauriVectorFile`, `readShapefileSiblings`
  which derives sibling paths by string ops, `pickLocalPathWithFallback`,
  `openRecentProjectFile`).
- Drag-and-drop reads `event.payload.paths` (`src/components/layout/DesktopShell.tsx:626-730`)
  — no file drag-drop on Android; inert.

### C. Local binaries / multi-window / OAuth

- Martin tile server: downloads a platform binary (no Android asset) and spawns
  it (`src-tauri/src/lib.rs:637-712, 1293-1311`) → PostgreSQL/Martin tiles
  unavailable on mobile.
- Earth Engine OAuth binds a raw `TcpListener` on `127.0.0.1:5173` and opens
  multi-window popups (`src-tauri/src/earth_engine_oauth.rs:15-160`,
  `lib.rs:1734-1766`) — both blocked/absent on Android; needs a deep-link /
  custom-scheme redirect instead.

### D. Window / layout

- Fixed 1280×800 desktop window config (`tauri.conf.json` `app.windows`) is
  meaningless on a single full-screen Android activity.
- The dense toolbar + multi-pane `DesktopShell` layout needs a responsive/touch
  pass for phones. (Native menus/tray: none — dropdowns render in-DOM, fine.)

> **Applied compile fix:** the OAuth-popup window builder
> (`create_oauth_popup_window` / the `on_new_window` handler in
> `src-tauri/src/lib.rs`) calls `WebviewWindowBuilder::{on_new_window,
> window_features}`, which don't exist on Tauri's mobile runtime — this was the
> *only* thing that failed the Android compile. It's now behind `#[cfg(desktop)]`,
> so desktop behavior is unchanged and Android compiles. A real mobile OAuth flow
> (deep-link / custom-scheme redirect) is still future work.

### E. Bundle config

- `bundle.resources: ["../../../backend/geolibre_server"]` ships the Python
  project into the APK. It's unusable on Android and is the main reason the debug
  APK is ~208 MB — exclude it for Android (e.g. an android-specific config) to
  shrink the build.

## 3. Suggested phasing

1. ~~**Toolchain + boot:** set up SDK/NDK, `tauri android init`, build an APK.~~
   **Done** — debug APK builds (UI works offline; assets bundled in the APK).
   Next sub-step: run it on an emulator/device to confirm the webview boots.
2. **Mobile gating:** add `plugin-os`, introduce `isMobile()/isDesktop()`,
   hide/disable sidecar-backed tools, Martin, local-path MBTiles/raster, and
   drag-drop on mobile so nothing presents-then-fails. (`isTauri()` is `true` on
   Android — see §4 — so this is the highest-value next step.)
3. **Storage:** adopt content-URI-safe file open/save via the dialog+fs plugins
   for projects and vector/raster import.
4. **Maps offline:** bundle or download PMTiles/MBTiles + decide which engines
   (DuckDB spatial ext, PGlite/PostGIS, Pyodide) to pre-cache vs require network
   (today all are CDN-fetched — see `apps/geolibre-desktop/vite.config.ts`).
5. **OAuth:** replace the loopback/multi-window flow with a deep-link redirect
   (the desktop popup path is already cfg-gated off mobile).
6. **Bundle slimming + Responsive UI** + Play Store packaging (AAB, signing).

## 4. Recommendation

The fastest "GeoLibre on Android, offline" win remains the **PWA** (already
installable + offline shell via `vite-plugin-pwa`; tested in `e2e/pwa.spec.ts`).
The native build is worthwhile for Play Store distribution and deeper device
integration, but its value is gated on phases 2–4 above; phase 1 alone yields a
launchable-but-thin app. Recommend: land the toolchain/boot spike, then prioritize
mobile gating (phase 2) so the native app is honest about what it can do.
