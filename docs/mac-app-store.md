# Mac App Store

GeoLibre Desktop is published on the
[Mac App Store](https://apps.apple.com/app/geolibre-desktop/id6796848769):

[Get GeoLibre Desktop on the Mac App Store](https://apps.apple.com/app/geolibre-desktop/id6796848769){ .md-button .md-button--primary }

For the user-facing comparison of the two macOS builds, see
[Downloads](downloads.md#mac-app-store). This page documents how the Store build
is produced and why it differs.

GeoLibre Desktop ships on macOS two ways:

- **Developer ID** (the default): the notarized `.dmg` published by
  `release.yml` on every GitHub release and distributed through the website,
  Homebrew, and winget-style channels. Full feature set, hardened runtime, no
  App Sandbox.
- **Mac App Store (MAS)**: a sandboxed variant built by the
  `mas-store.yml` workflow (or `npm run tauri:build:mas` locally). This page
  documents that variant.

The App Store imposes two hard rules the default build cannot satisfy:

1. **App Sandbox is mandatory.** The app is confined to its container plus
   files the user explicitly picks in an open dialog. Spawning downloaded,
   unsigned executables is impossible.
2. **Guideline 2.5.2**: the app may not download or execute code that changes
   its features. The default build bootstraps `uv`, a Python environment, and
   the martin tile server at runtime, all of which are downloads of executable
   code.

So the MAS build compiles those services out instead of shipping them broken.

## What the MAS build removes

The `mas` cargo feature (`apps/geolibre-desktop/src-tauri`) replaces these
Tauri commands with stubs, and `GEOLIBRE_MAS_BUILD=1` hides the matching UI:

- **Python sidecar** (Whitebox server engine, Conversion/Raster sidecar
  engines, PostGIS endpoints, SamGeo segmentation, SedonaDB SQL).
- **Jupyter server** (the Notebook panel falls back to the bundled
  JupyterLite, which the web build already uses; Pyodide executes inside
  WebKit, which App Review permits).
- **martin tile server** and its GitHub binary download (Add Data →
  PostgreSQL is hidden).
- **External plugin installation** (zip archives and registry installs).
  Built-in and bundled drop-in plugins keep working.
- **In-app update checks** (`GEOLIBRE_STORE_BUILD=1`, same as the Microsoft
  Store MSIX build): a Store app updates only through the Store.
- **Earth Engine sign-in** (Processing → Earth Engine, and the GeoAgent
  plugin's Earth Engine overlay). Unlike the items above this is not a sandbox
  limit but an *entitlement* one — see below.

### Earth Engine and the `network.server` entitlement

Earth Engine sign-in uses Google's OAuth **loopback-redirect** flow for native
apps: `src-tauri/src/earth_engine_oauth.rs` binds a listener on `127.0.0.1`,
opens the consent page in the system browser, and accepts the browser's inbound
redirect to receive the token. Accepting an inbound connection requires
`com.apple.security.network.server`.

App Review **rejected GeoLibre Desktop 2.4.0** over exactly this (guideline
2.4.5, submission `76036eca-dc21-45d3-873e-39b015d37036`): an automated analysis
flags the server entitlement when it cannot find matching functionality, and the
bind happens lazily inside a Tauri command, so nothing static points at it.

Rather than defend the entitlement in App Review Information, both Apple targets
drop the feature: the module is gated
`#[cfg(not(any(feature = "mas", target_os = "ios")))]` and replaced with stub
commands that bind nothing, so **neither the Mac App Store build nor the iOS app
ever opens a listening socket**. The entitlement is gone from
`mas/Entitlements.mas.plist.template`, and `mas-store.yml` fails the build if it
reappears in the signature. (iOS has no entitlements file — those sandbox keys
are macOS-only — but it ships through the same review pipeline, so it gets the
same treatment.)

On the UI side, `isEarthEngineAvailable()`
(`packages/plugins/src/plugins/earth-engine-auth.ts`) hides the Processing menu
item and the command-palette entry, and `authenticateEarthEngine` throws early
if anything else reaches it. It detects the macOS build from the
`__GEOLIBRE_MAS_BUILD__` define and iOS from the user agent, and only applies
inside the packaged app — the **web build keeps Earth Engine everywhere**,
including Safari on iOS, because a browser uses Google's popup/redirect flow and
binds nothing.

If a future feature genuinely needs to accept an inbound connection, re-adding
the entitlement is not sufficient on its own: describe the functionality in **App
Review Information** before submitting, or the automated check rejects it again.

Everything client-side is unchanged and fully functional: MapLibre/deck.gl
rendering, Add Data for local and remote files, DuckDB-WASM vector reading,
Whitebox WASM tools, Turf/Pyodide vector tools, browser-engine conversions,
client raster tools, the SQL Workspace on CereusDB/PGlite, the Python console,
onnxruntime-web detection/segment-everything, geocoding, and collaboration.

### Known limitations under the sandbox

- **Loose shapefiles**: the sandbox only grants access to the files the user
  picked, so the automatic read of `.dbf`/`.prj`/`.shx` siblings next to a
  picked `.shp` is denied. The MAS build compensates by matching companions
  out of the same dialog selection, so **multi-select every shapefile part**
  (`.shp`, `.dbf`, `.prj`, ...) or load a **zipped shapefile**. A `.shp`
  picked alone loads without attributes or CRS. This also applies when a saved
  project restores a loose `.shp` layer: re-add it or use a zip.
- **Environment variables**: the "read API keys from the shell environment"
  convenience returns nothing, because a sandboxed app does not inherit a
  login shell environment. Enter keys in Settings instead.
- **Reopening projects that reference local files**: the sandbox grant for a
  picked file ends with the process unless the app stores a security-scoped
  bookmark, which GeoLibre does not do yet. After a relaunch, a project layer
  backed by a local path outside the container fails to restore its data;
  re-add the file to reload it. Adopting security-scoped bookmarks (e.g. via
  `tauri-plugin-persisted-scope`'s macOS bookmark support) is the planned fix.

## Building locally

Unlike the other desktop builds, this one **embeds the JupyterLite site**, so
the `jupyter lite` CLI has to be installed before you build:

```bash
pip install -r apps/geolibre-desktop/jupyterlite/requirements.txt
```

Without it the build fails with an explicit error rather than producing an app
whose Notebook panel loads the wrong thing (Tauri answers a missing asset with
`index.html`, so a MAS build with no JupyterLite renders a second copy of
GeoLibre inside the panel).

```bash
# One-time: render the entitlements with your team id.
APPLE_TEAM_ID=XXXXXXXXXX scripts/render-mas-entitlements.sh

# Put a Mac App Store provisioning profile for org.geolibre.desktop at
# apps/geolibre-desktop/src-tauri/mas/embedded.provisionprofile
# (App Store Connect → Profiles → macOS App Development/Distribution).

APPLE_SIGNING_IDENTITY="Apple Distribution: Your Name (XXXXXXXXXX)" \
  npm run tauri:build:mas -- --target universal-apple-darwin

# Wrap the .app into a Store-submittable installer package.
xcrun productbuild \
  --sign "3rd Party Mac Developer Installer: Your Name (XXXXXXXXXX)" \
  --component "apps/geolibre-desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/GeoLibre Desktop.app" \
  /Applications GeoLibre-Desktop-mas.pkg
```

`npm run tauri:build:mas` wires everything else: the `mas` cargo feature, the
`tauri.mas.conf.json` overlay (App Sandbox entitlements, embedded provisioning
profile, no bundled sidecar resources, hardened runtime off), and the
`GEOLIBRE_MAS_BUILD`/`GEOLIBRE_STORE_BUILD` frontend flags. It refuses to run
with `--native-duckdb` (native DuckDB loads its spatial extension as unsigned
native code at runtime).

The sandboxed app can be smoke-tested by running the built
`GeoLibre Desktop.app` directly; `codesign -d --entitlements - --xml` on the
bundle should show `com.apple.security.app-sandbox`, and must **not** show
`com.apple.security.network.server`.

## CI: the `mas-store.yml` workflow

Runs on each **published GitHub release** (matching `release.yml`, `android.yml`
and `ios.yml`) and on demand via the "Run workflow" button: it builds the
universal sandboxed app, signs it, verifies the sandbox entitlement, produces the
signed `.pkg`, and uploads it as the `geolibre-mas-pkg` artifact. On a release
run it also attaches that `.pkg` to the release, so the exact submitted bytes for
a tag remain available after the CI artifact's retention window. It never uploads
to App Store Connect — that step stays manual (see *Submitting* below).

> A MAS-signed `.pkg` can only be installed through the App Store; downloading it
> from the releases page gets you a package that will not install. It is attached
> as a submission archive, not as a macOS download. Point users at the App Store
> listing, the Homebrew cask, or the Developer ID `.dmg` from `release.yml`.

A missing-secrets run is handled by the `secrets-gate` job: on a
`workflow_dispatch` it is a hard error (you asked for a `.pkg` and cannot get
one), while on a release it logs a warning and skips the macOS job so an
otherwise-good release does not go red.

Required repository secrets:

| Secret | Contents |
| --- | --- |
| `APPLE_MAS_CERTIFICATE` | base64 `.p12` containing **both** the "Apple Distribution" and "3rd Party Mac Developer Installer" certificates with private keys |
| `APPLE_MAS_CERTIFICATE_PASSWORD` | password of that `.p12` |
| `APPLE_MAS_SIGNING_IDENTITY` | `Apple Distribution: Name (TEAMID)` |
| `APPLE_MAS_INSTALLER_IDENTITY` | `3rd Party Mac Developer Installer: Name (TEAMID)` |
| `APPLE_MAS_PROVISIONING_PROFILE` | base64 Mac App Store `.provisionprofile` for `org.geolibre.desktop` |
| `APPLE_TEAM_ID` | already configured for `release.yml` |

Creating the inputs (Apple Developer account required):

1. In the developer portal, create an **App ID** for `org.geolibre.desktop`
   (macOS, no extra capabilities).
2. Create the two certificates ("Apple Distribution" and "3rd Party Mac
   Developer Installer") via Keychain Access CSRs, then export both together
   from Keychain Access as one `.p12`: `base64 -i certs.p12 | pbcopy`.
3. Create a **Mac App Store Connect** provisioning profile for that App ID and
   the distribution certificate: `base64 -i profile.provisionprofile | pbcopy`.

## Submitting

1. Create the app record in App Store Connect for `org.geolibre.desktop`
   (the same team as the iOS `org.geolibre.app` record; the two are separate
   apps). This is already done for GeoLibre Desktop, App Store ID `6796848769`
   (the numeric listing identifier App Store Connect labels "Apple ID" on the App
   Information page), so later releases start at step 2.
2. Download the `.pkg` — from the `geolibre-mas-pkg` artifact of the release's
   workflow run, or from the release's own
   `GeoLibre.Desktop_<version>_universal_mas.pkg` asset once the artifact has
   expired — and upload it with the **Transporter** app (or
   `xcrun altool --upload-app -f <pkg> -t macos`).
3. Fill in screenshots, description, and the privacy questionnaire
   (see `docs/privacy.md`; the app makes no tracking calls).
4. In the review notes, mention that processing engines run client-side as
   WebAssembly inside the webview and that the app downloads only data (map
   tiles, user-requested datasets), never code.

Version numbers come from `tauri.conf.json` (`CFBundleShortVersionString`);
every upload needs a version or build number higher than the last one in App
Store Connect.
