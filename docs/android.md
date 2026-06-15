# Android

GeoLibre runs as a native Android app built from the same React codebase via
**Tauri v2 mobile** — no separate app. The webview UI is bundled in the APK, so
the app shell works offline; map tiles and the heavier engines are fetched on
demand (same as the desktop build).

## What works on Android vs desktop

The Android build ships the full map workspace, Add Data, the Vector tools
(Turf.js / in-browser GeoPandas via Pyodide), the SQL Workspace (DuckDB-WASM and
the in-browser PGlite/PostGIS engine), the Python Console (Pyodide), geocoding,
statistics, the AI assistant, story maps, and plugins.

Tools that depend on a **local desktop process** are hidden on mobile, because
Android has no Python sidecar or local helper binaries:

- Processing → **Whitebox**, **Raster**, **Conversion**, **AI Segmentation**
  (all need the Python sidecar)
- Add Data → **PostgreSQL** (served by the local Martin tile server)

These are gated by a user-agent `isMobile()` check so they never appear and then
fail. Everything else runs client-side.

## Toolchain setup (one time)

You need the Android SDK + NDK, a JDK (17 or 21 — newer JDKs can break the
Android Gradle Plugin), and the Rust Android targets. The cleanest, sudo-free
layout keeps everything under a user-writable SDK at `~/Android/Sdk`.

```bash
# 1. JDK 17/21 (or reuse Android Studio's bundled JBR at /opt/android-studio/jbr)
export JAVA_HOME=/path/to/jdk-21

# 2. Android SDK components (sdkmanager ships with Android Studio cmdline-tools)
export ANDROID_HOME="$HOME/Android/Sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" \
  "platform-tools" "platforms;android-34" \
  "build-tools;34.0.0" "ndk;27.3.13750724"
export NDK_HOME="$ANDROID_HOME/ndk/27.3.13750724"   # Tauri needs NDK_HOME

# 3. Rust + the four Android targets (install rustup if you don't have it)
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  i686-linux-android x86_64-linux-android
```

NDK **r27 (LTS)** is the supported line for Tauri v2. Add the four `export`s to
your shell profile so every session has them.

## Build

```bash
cd apps/geolibre-desktop
npx tauri android init                          # generate src-tauri/gen/android (once)
npx tauri android build --apk --split-per-abi    # release APKs, one per ABI (~40 MB each)
```

- `gen/android` is generated (git-ignored) and regenerated on demand.
- Build **release**, not `--debug`: the stripped, size-optimized Cargo profile
  makes each APK ~40 MB; a debug build is ~200 MB (unstripped `.so` with
  debuginfo).
- `--split-per-abi` emits one APK per architecture instead of a single ~150 MB
  universal APK. Install the **`arm64-v8a`** one on real phones.
- Output:
  `src-tauri/gen/android/app/build/outputs/apk/<abi>/release/app-<abi>-release-unsigned.apk`.

The app is named **GeoLibre** on Android (the desktop build is "GeoLibre
Desktop"), set via `src-tauri/tauri.android.conf.json`, which also drops the
Python backend from the Android bundle.

## Signing

Release APKs are unsigned. To install one, sign it (a debug key is fine for
testing; use a real key for distribution):

```bash
BT="$ANDROID_HOME/build-tools/34.0.0"
KS="$HOME/.android/debug.keystore"   # auto-created by Android tooling; or make your own
"$BT/zipalign" -p -f 4 app-arm64-v8a-release-unsigned.apk aligned.apk
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android \
  --ks-key-alias androiddebugkey --key-pass pass:android \
  --out geolibre-arm64.apk aligned.apk
"$BT/apksigner" verify geolibre-arm64.apk
```

For a real upload/release key:

```bash
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA \
  -keysize 2048 -validity 10000
```

## Continuous integration

`.github/workflows/android.yml` builds **signed**, per-ABI release APKs on each
published GitHub release (and on demand via the "Run workflow" button) and
uploads them as the `geolibre-android-release-apks` artifact. It signs with your release keystore when these repository secrets are
set, and otherwise falls back to a throwaway debug key so the artifact is still
installable for testing:

- `ANDROID_KEYSTORE_BASE64` — `base64 -w0 upload.jks`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

## Install / test

### On a phone

1. Enable **Developer options** (tap Build number 7×) and **USB debugging**.
2. Sideload the signed APK:
   ```bash
   adb install -r geolibre-arm64.apk
   ```
   Or copy the APK to the phone and tap it (allow "install unknown apps").

For live development with hot reload, connect the device and run
`npm run tauri android dev`.

### On an emulator

```bash
sdkmanager --sdk_root="$ANDROID_HOME" \
  "emulator" "system-images;android-34;google_apis_playstore;x86_64"
avdmanager create avd -n geolibre \
  -k "system-images;android-34;google_apis_playstore;x86_64" -d pixel_7
emulator -avd geolibre
adb install -r geolibre-arm64.apk
```

> If you ever rebuild with a **different** signing key, uninstall the old copy
> first (`adb uninstall org.geolibre.desktop`) — Android rejects updates whose
> signature changed. The package id stays `org.geolibre.desktop` even though the
> visible name is "GeoLibre".

## Known limitations / follow-ups

- Local-file sources (MBTiles, local rasters, project files) assume real
  filesystem paths; Android scoped storage returns content URIs, so those flows
  need adapting before they work natively.
- The **Download Offline Area** tool relies on a service worker, which the Tauri
  builds (desktop and Android) don't use — it's a PWA feature. Native offline
  basemap caching (bundled/downloaded MBTiles/PMTiles) is a future enhancement.
- Earth Engine OAuth uses a desktop loopback/multi-window flow; a mobile
  deep-link redirect is future work.
