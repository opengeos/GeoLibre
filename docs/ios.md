# iOS

GeoLibre runs as a native iOS app built from the same React codebase via **Tauri
v2 mobile** — no separate app. The webview UI (WKWebView) is bundled in the app,
so the shell works offline; map tiles and the heavier engines are fetched on
demand (same as the desktop and Android builds).

> **Status: builds and signs locally; not yet shipped.** The full pipeline has
> been run through on a Mac (Xcode 26.6 / iOS SDK 26.5): `tauri ios init` →
> unsigned archive → `xcodebuild -exportArchive` produces a **submittable**
> `.ipa` — bundle id `org.geolibre.app`, signed by *Apple Distribution*,
> `get-task-allow=false`, an embedded App Store provisioning profile, the merged
> location usage string, and the web assets embedded in the binary. The
> manual-signing recipe CI uses has also been exercised locally against a
> portal-issued certificate and profile.
>
> What has **not** happened: a run of the signed **CI** job on a GitHub runner,
> and any App Store Connect upload or review submission. Uploading additionally
> needs an App Store Connect app record for the bundle id. Everything below still
> has to be run on a Mac (iOS cannot be cross-compiled from Linux).

## What works on iOS vs desktop

Same split as Android. The iOS build ships the full map workspace, Add Data, the
Vector tools (Turf.js / in-browser GeoPandas via Pyodide), the SQL Workspace
(DuckDB-WASM and PGlite/PostGIS), the Python Console (Pyodide), geocoding,
statistics, the AI assistant, story maps, and plugins.

Tools that depend on a **local desktop process** are hidden on mobile because
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
`gen/apple/geolibre-desktop_iOS/Info.plist` at build time. `gen/apple` is git-ignored, so
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
npx tauri ios build --no-sign          # unsigned .ipa + .xcarchive (no Apple account needed)
```

> **`npx tauri ios build --export-method app-store-connect` does not work as-is.**
> The project `tauri ios init` generates bakes `CODE_SIGN_IDENTITY = "iPhone
> Developer"` into *both* the debug and release configurations, so Xcode resolves
> **development** signing even when the export method is App Store. Automatic
> development signing then demands a registered device and fails with:
>
> ```
> error: Your team has no devices from which to generate a provisioning profile.
> error: No profiles for 'org.geolibre.app' were found: Xcode couldn't find any
>        iOS App Development provisioning profiles matching 'org.geolibre.app'.
> ```
>
> Overriding `CODE_SIGN_IDENTITY="Apple Distribution"` does not help either —
> Xcode rejects it as *"automatically signed for development, but a conflicting
> code signing identity … has been manually specified."*
>
> Split the archive from the export instead. Archive **unsigned**, then let the
> export step do the distribution signing — this needs no registered device, and
> Xcode creates the Apple Distribution certificate, registers the App ID, and
> generates the App Store profile on the fly:
>
> ```bash
> cd apps/geolibre-desktop
> npx tauri ios build --no-sign          # → gen/apple/build/geolibre-desktop_iOS.xcarchive
>
> G=src-tauri/gen/apple
> cat > "$G/ExportOptions-appstore.plist" <<'PLIST'
> <?xml version="1.0" encoding="UTF-8"?>
> <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
> <plist version="1.0"><dict>
>   <key>method</key><string>app-store-connect</string>
>   <key>teamID</key><string>YOUR_TEAM_ID</string>
>   <key>signingStyle</key><string>automatic</string>
>   <key>uploadSymbols</key><true/>
> </dict></plist>
> PLIST
>
> xcodebuild -exportArchive -allowProvisioningUpdates \
>   -archivePath "$G/build/geolibre-desktop_iOS.xcarchive" \
>   -exportOptionsPlist "$G/ExportOptions-appstore.plist" \
>   -exportPath "$G/build/appstore"
> ```
>
> This produces a genuinely submittable `build/appstore/GeoLibre.ipa`: signed by
> `Apple Distribution`, `get-task-allow=false`, entitlement
> `<TEAM>.org.geolibre.app`, and an embedded *iOS Team Store Provisioning
> Profile*. Verify with `codesign -dvvv` before uploading.
>
> Note the certificate Xcode creates this way is **Cloud Managed**, so it does
> *not* appear in `security find-identity -v -p codesigning`. An empty identity
> list is not evidence the signing failed — check the `.ipa` itself.

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
    src-tauri/gen/apple/geolibre-desktop_iOS/Info.plist
  ```

  The merge happens during `tauri ios build`/`dev`, **not** during `ios init` —
  straight after `init` the generated plist does not contain the key yet, and
  that is expected. Note also that the Xcode project, target, and plist
  directory are named from the **Cargo package** (`geolibre-desktop` in
  `src-tauri/Cargo.toml`), not from `productName`. The user-visible app name and
  bundle id still come from `tauri.ios.conf.json` — they land as `PRODUCT_NAME:
  GeoLibre` and `PRODUCT_BUNDLE_IDENTIFIER: org.geolibre.app` in the generated
  `project.yml`.

## Signing

Every build that runs on a real device or reaches the App Store must be signed —
there is no debug-keystore shortcut like Android's. You need:

1. An **Apple Developer Program** membership ($99/year).
2. A **signing certificate** (Apple Distribution for App Store; Apple Development
   for device testing), exported from Keychain as a `.p12`.
3. A **provisioning profile** for the `org.geolibre.app` app id.
4. Your **Team ID** (App Store Connect → Membership).

Locally, opening `gen/apple/geolibre-desktop.xcodeproj` in Xcode once and enabling
"Automatically manage signing" with your team is the simplest path. For CI, the
identity is imported from secrets (below).

> **The local and CI identities are not interchangeable.** The export recipe
> above lets Xcode create a **Cloud Managed** Apple Distribution certificate and
> an Xcode-managed profile. Neither can be fed to CI: a cloud-managed identity
> has no exportable private key, so there is no `.p12` to base64, and CI's
> manual-signing export rejects an Xcode-managed profile outright
> (*"is Xcode managed, but signing settings require a manually managed
> profile"*). For CI you must create a **separate, manually managed** pair in the
> Developer portal — an Apple Distribution certificate from a CSR you generate in
> Keychain Access (so you hold the private key and can export the `.p12`), plus
> an App Store provisioning profile for `org.geolibre.app` bound to it. Holding
> both a cloud-managed and a manual distribution certificate at once is fine and
> normal.

## Continuous integration

`.github/workflows/ios.yml` runs on `macos-14` on each published GitHub release
(and on demand via "Run workflow"). Because iOS can't be cross-compiled from
Linux, this is the only mobile workflow that needs a macOS runner.

- **With Apple signing secrets set**, it imports the identity into a throwaway
  keychain, archives, exports a signed `.ipa`, verifies its bundle id, and
  uploads it as the `geolibre-ios-ipa` artifact:
  - `APPLE_IOS_CERTIFICATE_BASE64` — `base64 -i dist.p12`
  - `APPLE_IOS_CERTIFICATE_PASSWORD`
  - `APPLE_IOS_PROVISIONING_PROFILE_BASE64` — `base64 -i profile.mobileprovision`
  - `APPLE_TEAM_ID` — **reused** from the existing macOS/Homebrew signing
    secrets; the Team ID is account-wide.
- **Without them**, it falls back to a no-signing **compile check**
  (`cargo build --lib --target aarch64-apple-ios`) so CI still catches iOS build
  breakage; it just can't produce an installable `.ipa`.

### Reusing the macOS/Homebrew signing secrets?

Only the **Team ID**. The repo's release workflow already signs and notarizes the
macOS build for the Homebrew cask, but its `APPLE_CERTIFICATE` is a **Developer ID
Application** certificate — that type signs macOS apps distributed *outside* the
App Store and **cannot sign an iOS app**. iOS needs its own **Apple Distribution**
certificate and a **provisioning profile** (Developer ID distribution has
neither), so those are the `APPLE_IOS_*` secrets above, deliberately named apart
from the macOS ones to avoid feeding in the wrong cert/password. The good news:
they're created under the **same paid Apple Developer account** at no extra cost —
add an Apple Distribution certificate and an App Store provisioning profile for
`org.geolibre.app` in the Developer portal, and reuse the existing `APPLE_TEAM_ID`.

> **The signed CI job has not yet run on a GitHub runner.** The job archives with
> `npx tauri ios build --no-sign` and then signs in a separate
> `xcodebuild -exportArchive` step using **manual** signing, for the reason given
> under *Build*: `tauri ios build --export-method` cannot sign this project,
> because the generated project bakes in `CODE_SIGN_IDENTITY = "iPhone
> Developer"` and automatic signing therefore hunts for a development profile no
> matter what the export method says. That sequence has been reproduced locally
> against a portal-issued certificate and profile and produces a valid signed
> `.ipa`, but the workflow itself is still unexercised end to end — treat the
> first release-triggered run as a bring-up.

> **The runner's Xcode sets a hard floor.** `tauri ios init` generates an Xcode
> project in **object format 77**, which only **Xcode 16+** can open. On
> `macos-14` the archive failed immediately, before compiling anything:
>
> ```
> xcodebuild: error: Unable to load workspace '.../geolibre-desktop.xcodeproj/project.xcworkspace/'.
>   Reason: The project 'geolibre-desktop' cannot be opened because it is in a
>   future Xcode project file format (77).
> ```
>
> The job therefore runs on `macos-15` and explicitly selects the newest Xcode on
> the image rather than trusting its default, failing early with a clear message
> if that is older than 16. Note this floor comes from the **Tauri CLI's**
> generated project, not from anything in this repo — re-check it whenever the
> Tauri CLI is bumped.
>
> Separately, App Store Connect rejects uploads built against an SDK below its
> current floor. That failure is *silent* at build time — an older-but-openable
> Xcode still produces an `.ipa` and only fails at upload. The Xcode version and
> iOS SDK list are printed into the run log so a rejected upload can be diagnosed
> from the run instead of guessed at.

The `workflow_dispatch` `export_method` input picks the export path
(`app-store-connect` for TestFlight/App Store, `release-testing` for ad-hoc
registered devices, `debugging` for development).

## Install / test

- **Simulator:** `npx tauri ios dev` and pick a simulator, or open the Xcode
  project and Run. No paid account needed for the simulator.
- **Your own device:** tether it, open `gen/apple/geolibre-desktop.xcodeproj` in Xcode,
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
7. **Export compliance.** App Store Connect asks about encryption on *every*
   upload, and an unanswered build cannot be submitted or sent to testers. To
   answer it once instead of per upload, add the key to
   `src-tauri/Info.ios.plist`:

   ```xml
   <key>ITSAppUsesNonExemptEncryption</key>
   <false/>
   ```

   `false` is the right answer only if GeoLibre's use of encryption stays
   limited to what Apple treats as exempt — HTTPS/TLS via the system libraries
   for tiles, geocoding, the AI assistant, and the collaboration relay. That is
   true today, but it is a **legal declaration**, so confirm it before adding the
   key, and revisit it if the app ever ships its own cryptography.

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
