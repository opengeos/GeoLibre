# iOS

GeoLibre runs as a native iOS app built from the same React codebase via **Tauri
v2 mobile** — no separate app. The webview UI (WKWebView) is bundled in the app,
so the shell works offline; map tiles and the heavier engines are fetched on
demand (same as the desktop and Android builds).

> **Status: scaffolding.** The iOS config, `Info.ios.plist`, and CI workflow are
> in place, but — unlike Android — no iOS build has been shipped yet. Everything
> below has to be run and verified on a Mac (iOS cannot be cross-compiled from
> Linux). Treat the first `tauri ios build` as a bring-up, not a routine build.

## What works on iOS vs desktop

Same split as Android. The iOS build ships the full map workspace, Add Data, the
Vector tools (Turf.js / in-browser GeoPandas via Pyodide), the SQL Workspace
(DuckDB-WASM and PGlite/PostGIS), the Python Console (Pyodide), geocoding,
statistics, the AI assistant, story maps, and plugins.

Tools that depend on a **local desktop process** are hidden on mobile, because
iOS has no Python sidecar or local helper binaries and its sandbox forbids
spawning subprocesses:

- Processing → **Whitebox**, **Raster**, **Conversion**, **AI Segmentation**
  (all need the Python sidecar)
- Add Data → **PostgreSQL** (served by the local Martin tile server)

These are gated by a user-agent `isMobile()` check (which already matches
iPhone/iPad) so they never appear and then fail. Everything else runs
client-side.

## Location permission (required)

This is the one place iOS differs sharply from Android. Android's geolocation
plugin declares the runtime permission and the OS shows a generic dialog; **iOS
terminates the app the instant it requests location if no usage-description
string is present.** GeoLibre supplies it in
`src-tauri/Info.ios.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>GeoLibre uses your location to center the map, capture GPS points during Field Collection, and record GPS tracks.</string>
```

Tauri merges `Info.ios.plist` into the generated
`gen/apple/geolibre_iOS/Info.plist` at build time. `gen/apple` is git-ignored, so
this file is the durable home for the string — the same reason Android's manifest
permissions come from the plugin rather than a hand-edited, regenerated manifest.
It covers all three location consumers: Field Collection, GPS Tracking, and the
Controls → GeoLocate map control. After a build, confirm the key survived the
merge (see *Build* below).

## Toolchain setup (one time)

You need a **Mac** with **Xcode** (from the App Store; open it once to accept the
license and install the iOS platform), the command-line tools, CocoaPods, and the
Rust iOS targets.

```bash
xcode-select --install                 # command-line tools (if not already)
sudo xcodebuild -license accept
brew install cocoapods                 # or `gem install cocoapods`

# Rust device + simulator targets (install rustup first if needed)
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

`aarch64-apple-ios` is real devices and the App Store `.ipa`;
`aarch64-apple-ios-sim` is the simulator on Apple Silicon Macs.

## Build

```bash
cd apps/geolibre-desktop
npx tauri ios init                     # generate src-tauri/gen/apple (once)
npx tauri ios dev                      # run in the simulator / on a tethered device
npx tauri ios build                    # release archive → signed .ipa (needs signing, below)
```

- `gen/apple` is generated (git-ignored) and regenerated on demand. `init` also
  merges `tauri.ios.conf.json` (bundle id, drops the Python backend) and
  `Info.ios.plist` (the location string).
- The app is named **GeoLibre** on iOS (the desktop build is "GeoLibre Desktop")
  and uses the bundle id **`org.geolibre.app`**, both set via
  `src-tauri/tauri.ios.conf.json` — the same override pattern and reasoning as
  Android (`identifier` in `tauri.conf.json` stays `org.geolibre.desktop` so it
  keeps keying desktop settings and the Linux/macOS packaging).
- Verify the location string landed after a build:
  ```bash
  /usr/libexec/PlistBuddy -c 'Print :NSLocationWhenInUseUsageDescription' \
    src-tauri/gen/apple/geolibre_iOS/Info.plist
  ```

## Signing

Every build that runs on a real device or reaches the App Store must be signed —
there is no debug-keystore shortcut like Android's. You need:

1. An **Apple Developer Program** membership ($99/year).
2. A **signing certificate** (Apple Distribution for App Store; Apple Development
   for device testing), exported from Keychain as a `.p12`.
3. A **provisioning profile** for the `org.geolibre.app` app id.
4. Your **Team ID** (App Store Connect → Membership).

Locally, opening `gen/apple/geolibre.xcodeproj` in Xcode once and enabling
"Automatically manage signing" with your team is the simplest path. For CI, the
identity is imported from secrets (below).

## Continuous integration

`.github/workflows/ios.yml` runs on `macos-14` on each published GitHub release
(and on demand via "Run workflow"). Because iOS can't be cross-compiled from
Linux, this is the only mobile workflow that needs a macOS runner.

- **With Apple signing secrets set**, it imports the identity into a throwaway
  keychain, archives, exports a signed `.ipa`, verifies its bundle id, and
  uploads it as the `geolibre-ios-ipa` artifact:
  - `APPLE_CERTIFICATE_BASE64` — `base64 -i dist.p12`
  - `APPLE_CERTIFICATE_PASSWORD`
  - `APPLE_PROVISIONING_PROFILE_BASE64` — `base64 -i profile.mobileprovision`
  - `APPLE_DEVELOPMENT_TEAM` — your 10-char Team ID
- **Without them**, it falls back to a no-signing **compile check**
  (`cargo build --lib --target aarch64-apple-ios`) so CI still catches iOS build
  breakage; it just can't produce an installable `.ipa`.

The `workflow_dispatch` `export_method` input picks the export path
(`app-store-connect` for TestFlight/App Store, `release-testing` for ad-hoc
registered devices, `debugging` for development).

## Install / test

- **Simulator:** `npx tauri ios dev` and pick a simulator, or open the Xcode
  project and Run. No paid account needed for the simulator.
- **Your own device:** tether it, open `gen/apple/geolibre.xcodeproj` in Xcode,
  select the device, and Run (a free Apple ID allows 7-day device signing).
- **Testers:** distribute a signed build through **TestFlight** (upload the `.ipa`
  via Xcode Organizer or Transporter, then invite testers in App Store Connect).

## Publishing to the App Store

The build side is covered by the CI workflow; the rest is App Store Connect
onboarding.

1. **App record.** In App Store Connect, create a new app with the bundle id
   `org.geolibre.app` (register the app id in the Developer portal first).
2. **Minimum Functionality (Guideline 4.2).** Apple rejects apps that are "a
   repackaged website." GeoLibre passes because it's a bundled native app with
   real device integration — GPS, offline-capable map workspace, local file
   handling — not a wrapper that loads a remote URL. Keep it that way: ship the
   web assets in the binary (the default here), don't point the webview at
   `geolibre.app`.
3. **Upload** the `.ipa` from the `geolibre-ios-ipa` CI artifact (or Xcode) to a
   TestFlight build, then submit that build for App Store review. The build
   number (`CFBundleVersion`) is derived from the version in `tauri.conf.json`
   and must increase on every upload.
4. **Store listing:** icon (already generated under `src-tauri/icons/ios`),
   screenshots for the required device sizes (6.7" and 6.5" iPhone, plus 12.9"
   iPad — a GIS workspace is genuinely iPad-appropriate), description, keywords.
5. **Privacy.** Fill the **App Privacy** questionnaire honestly — declare each
   network destination (geocoding, the AI assistant, basemap/tile fetches, Google
   OAuth for Earth Engine) and that location is used *when in use* and not
   collected by a backend. Point the privacy policy URL at the published
   [privacy policy](privacy.md).
6. **Age rating** questionnaire and category (Navigation or Productivity).

## Known limitations / follow-ups

Most mirror Android:

- Local-file sources (MBTiles, local rasters, project files) assume real
  filesystem paths; iOS hands apps sandboxed URLs via the document picker, so
  those flows need adapting before they work natively.
- The **Download Offline Area** tool relies on a service worker, which the Tauri
  builds don't use — it's a PWA feature. Native offline basemap caching is future
  work.
- Earth Engine OAuth uses a desktop loopback/multi-window flow; a mobile
  deep-link redirect (an iOS URL scheme / universal link) is future work.
- iPadOS multitasking (Split View / Stage Manager) hasn't been tuned; the
  responsive layout should adapt, but verify on a real iPad before release.
