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
  "platform-tools" "platforms;android-36" \
  "build-tools;36.0.0" "ndk;27.3.13750724"
export NDK_HOME="$ANDROID_HOME/ndk/27.3.13750724"   # Tauri needs NDK_HOME

# 3. Rust + the four Android targets (install rustup if you don't have it)
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  i686-linux-android x86_64-linux-android
```

NDK **r27 (LTS)** is the supported line for Tauri v2. Add the four `export`s to
your shell profile so every session has them.

API **36** (Android 16), not 34: the Tauri v2.11 Android template generates
`compileSdk = 36` / `targetSdk = 36`, so Gradle needs the matching platform
installed. It is also Google Play's floor — from **2026-08-31** new apps and
updates must target API 36 to be accepted.

### 16 KB page sizes

Google Play rejects apps targeting Android 15+ whose native libraries are not
aligned for 16 KB memory pages, and such libraries fail to load on 16 KB
devices. NDK r28+ does this by default; **r27 does not**, so the flags are
passed explicitly. Export this before an Android build (CI sets it at workflow
level in `.github/workflows/android.yml`):

```bash
export RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384"
```

> It has to be the `RUSTFLAGS` **environment variable**. Putting the same flags
> in `target.<triple>.rustflags` in a `.cargo/config.toml` does *not* work: the
> Tauri CLI sets `RUSTFLAGS` itself when it invokes cargo for Android, and an
> env `RUSTFLAGS` overrides the config file outright. The config-file form is
> silently ignored — it parses, it builds, and it ships 4 KB-aligned libraries
> that Play rejects. Tauri appends to an inherited value, so exporting it works.

Check the result on a built APK — the bytes Play actually receives:

```bash
unzip -o -q app-arm64-release-unsigned.apk 'lib/*/*.so' -d /tmp/apkcheck
"$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-objdump" -p \
  /tmp/apkcheck/lib/*/*.so | awk '$1 == "LOAD" { print $NF }' | sort -u
# every value must be 2**14 or greater; 2**12 means the flags did not apply
```

Use `llvm-objdump -p` rather than `readelf -l`: readelf wraps each LOAD across
two lines, so it is easy to parse the wrong column and read an address as an
alignment. CI runs this same check over every packaged `.so` and fails on a
regression.

## Build

```bash
cd apps/geolibre-desktop
npx tauri android init                          # generate src-tauri/gen/android (once)
npx tauri android build --apk --split-per-abi    # release APKs, one per ABI (~40 MB each)
npx tauri android build --aab                    # universal AAB for Google Play
```

- `gen/android` is generated (git-ignored) and regenerated on demand.
- Build **release**, not `--debug`: the stripped, size-optimized Cargo profile
  makes each APK ~40 MB; a debug build is ~200 MB (unstripped `.so` with
  debuginfo).
- `--split-per-abi` emits one APK per architecture instead of a single ~150 MB
  universal APK. Install the **`arm64`** one on real phones.
- Output:
  `src-tauri/gen/android/app/build/outputs/apk/<abi>/release/app-<abi>-release-unsigned.apk`,
  where `<abi>` is Tauri's short name — **`arm64`**, `arm`, `x86`, `x86_64` —
  *not* the Android ABI directory name (`arm64-v8a`, `armeabi-v7a`) that appears
  inside the APK under `lib/`.

- Sideload/GitHub-release path: the per-ABI **APKs**.
- Google Play path: the universal **AAB** (Play generates per-device splits from
  it). Don't `--split-per-abi` the AAB — Play wants the one bundle.

The app is named **GeoLibre** on Android (the desktop build is "GeoLibre
Desktop") and uses the package id **`org.geolibre.app`**, both set via
`src-tauri/tauri.android.conf.json`, which also drops the Python backend from
the Android bundle.

The Android id is overridden there rather than in `tauri.conf.json` on purpose:
`identifier` is shared by every platform and also determines the macOS bundle ID,
the Linux AppStream id, and the webview data directory. Changing it globally
would orphan existing desktop users' settings and break the Linux/COPR/Homebrew
packaging, all of which still key off `org.geolibre.desktop`.

## Signing

Release APKs are unsigned. To install one, sign it (a debug key is fine for
testing; use a real key for distribution):

```bash
BT="$ANDROID_HOME/build-tools/36.0.0"
KS="$HOME/.android/debug.keystore"   # auto-created by Android tooling; or make your own
"$BT/zipalign" -p -f 4 app-arm64-release-unsigned.apk aligned.apk
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

It also builds a universal **AAB** and uploads it as the separate
`geolibre-android-play-aab` artifact — but *only* on runs that have the real
release keystore, since Play rejects a debug-signed bundle. Without the keystore
the AAB build is skipped entirely rather than built and discarded. The AAB is
not attached to the GitHub Release (an `.aab` is not user-installable).

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
  "emulator" "system-images;android-36;google_apis_playstore;x86_64"
avdmanager create avd -n geolibre \
  -k "system-images;android-36;google_apis_playstore;x86_64" -d pixel_7
emulator -avd geolibre
# x86_64 APK to match the x86_64 system image — the emulator can translate the
# arm64 build, but far slower, and it would not exercise the x86_64 libraries.
adb install -r geolibre-x86_64.apk
```

> If you ever rebuild with a **different** signing key, uninstall the old copy
> first (`adb uninstall org.geolibre.app`) — Android rejects updates whose
> signature changed. This also applies when moving between a sideloaded APK and
> the Play build: Play App Signing re-signs with Google's key, so the two are not
> upgrade-compatible.

## Publishing to Google Play

The build side is covered by the CI workflow above; the rest is Play Console
onboarding.

1. **Developer account** ($25, one-time). Register as an **organization** rather
   than a personal account if you can: personal accounts created after
   2023-11-13 must run a closed test with **12 opted-in testers for 14
   consecutive days** before they can apply for production access. Organization
   accounts are exempt.
2. **Play App Signing.** Upload `upload.jks` as the *upload* key; Google holds
   the actual app signing key and re-signs each bundle. The repository's
   `ANDROID_KEYSTORE_*` secrets are that upload key — keep the keystore backed
   up, since losing it requires a Play support reset.
3. **Upload the AAB** from the `geolibre-android-play-aab` CI artifact. The
   `versionCode` is derived from the version in `tauri.conf.json` and must
   increase on every upload.
4. **Store listing assets:** 512×512 icon, a **1024×500 feature graphic**, and
   at least two phone screenshots. Add 7-inch and 10-inch tablet screenshots
   too — Play down-ranks apps without them, and a GIS workspace is genuinely
   tablet-appropriate.
5. **Privacy policy URL** — point at the published [privacy policy](privacy.md).
6. **Data safety form.** Declare each network destination honestly: geocoding,
   the AI assistant, basemap/tile fetches, and Google OAuth for Earth Engine.
   Note which are *transmitted* versus *collected* — GeoLibre does not operate a
   backend that retains user data, but the form asks per-purpose.
7. **Content rating** questionnaire and target audience.

Before the first public release, re-read *Known limitations* below: several Add
Data paths are inert on Android. A reviewer tapping one and getting nothing is a
one-star review, so consider gating them on mobile the way the sidecar tools
already are via `isMobile()`.

## Known limitations / follow-ups

- Local-file sources (MBTiles, local rasters, project files) assume real
  filesystem paths; Android scoped storage returns content URIs, so those flows
  need adapting before they work natively.
- The **Download Offline Area** tool relies on a service worker, which the Tauri
  builds (desktop and Android) don't use — it's a PWA feature. Native offline
  basemap caching (bundled/downloaded MBTiles/PMTiles) is a future enhancement.
- Earth Engine OAuth uses a desktop loopback/multi-window flow; a mobile
  deep-link redirect is future work.
