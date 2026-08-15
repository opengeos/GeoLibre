# Downloads

GeoLibre desktop installers are published from GitHub Releases.

[View releases](https://github.com/opengeos/GeoLibre/releases){ .md-button .md-button--primary }
[Launch GeoLibre Web](https://web.geolibre.app/){ .md-button }

## Release assets

Release builds are produced for:

- Linux x64: Debian package, RPM package, and AppImage
- Windows x64: unsigned desktop binary
- macOS Apple Silicon: Developer ID signed and notarized DMG and app bundle (v1.4.1+)
- macOS Intel: Developer ID signed and notarized DMG and app bundle (v1.4.1+)
- Android: signed APKs, one per ABI (`geolibre-android-arm64.apk` and friends)

The Windows GitHub Release build is unsigned and may require a platform-specific
trust prompt; the [Microsoft Store](#windows-installation) build is signed and
auto-updating. Check each release note for the exact assets and platform
guidance.

## Windows installation

### Microsoft Store (recommended)

GeoLibre is available on the
[Microsoft Store](https://apps.microsoft.com/detail/9nwt67rv531x). The Store
build is signed and updates automatically, so it installs and launches without
a trust prompt:

[Get GeoLibre from the Microsoft Store](https://apps.microsoft.com/detail/9nwt67rv531x){ .md-button .md-button--primary }

### winget

The [Windows Package Manager](https://learn.microsoft.com/windows/package-manager/)
distributes GeoLibre as `OpenGeos.GeoLibre` (the GitHub Release build):

```powershell
winget install OpenGeos.GeoLibre
```

### Manual installation

Download the Windows installer (`.msi` or `.exe`) from the latest
[release](https://github.com/opengeos/GeoLibre/releases) and run it. This build
is unsigned, so Windows SmartScreen may warn you; choose **More info → Run
anyway** to proceed.

### Portable (no install)

Prefer not to install? Download the `*-x64-portable.zip` asset from the latest
[release](https://github.com/opengeos/GeoLibre/releases), unzip it anywhere
(including a USB drive), and run `geolibre-desktop.exe`. No installer, admin
rights, or registry changes are involved, and the build does not auto-update, so
download a newer zip to upgrade.

The portable build relies on the Microsoft Edge WebView2 Runtime, which is
preinstalled on Windows 11 and current Windows 10. If the app does not start,
install the
[Evergreen runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
The optional Python sidecar tools (raster, conversion, AI Segmentation) need
Python available just as in the installed build; everything else — including the
1,000+ tool Whitebox geoprocessing toolbox, which runs on WebAssembly — runs
without it.

## macOS installation

Signing and notarization apply to **v1.4.1 and later**. For v1.4.0 and earlier
(ad-hoc signed), remove the quarantine attribute after installing, repeating it
after each upgrade:

```bash
xattr -dr com.apple.quarantine "/Applications/GeoLibre Desktop.app"
```

macOS has two builds to choose from. The **Homebrew / DMG** build is the full
app; the **Mac App Store** build is sandboxed and drops the features Apple's
rules do not allow (see [below](#mac-app-store)).

### Homebrew (recommended)

GeoLibre is available as an official
[Homebrew Cask](https://github.com/Homebrew/homebrew-cask/blob/main/Casks/g/geolibre.rb),
so no tap or trust step is needed — just install:

```bash
brew install --cask geolibre
```

The macOS DMGs are signed with an Apple Developer ID certificate and notarized
by Apple, so Gatekeeper allows the app to launch normally with no quarantine
workaround. Upgrade later with:

```bash
brew upgrade --cask geolibre
```

To remove it:

```bash
brew uninstall --cask geolibre
```

### Manual installation

The macOS builds are signed with an Apple Developer ID certificate and notarized
by Apple, so Gatekeeper allows them to open without any extra steps:

1. Download the DMG for your Mac (`aarch64` for Apple Silicon, `x64` for
   Intel).
2. Open the DMG and drag **GeoLibre Desktop** into **Applications**.
3. Launch GeoLibre Desktop from Applications.

### Mac App Store

GeoLibre Desktop is also on the
[Mac App Store](https://apps.apple.com/app/geolibre-desktop/id6796848769), which
installs and updates it like any other Store app, with no Terminal and no
Gatekeeper prompt:

[Get GeoLibre Desktop on the Mac App Store](https://apps.apple.com/app/geolibre-desktop/id6796848769){ .md-button .md-button--primary }

#### What the Store build leaves out

The App Store requires the App Sandbox and forbids downloading or running
executable code that changes an app's features (guideline 2.5.2). GeoLibre's
optional Python sidecar, Jupyter server, and martin tile server are all runtime
downloads of executable code, so the Store build compiles them out rather than
shipping them broken. Here is how the two macOS builds compare:

| Feature | Homebrew / DMG | Mac App Store |
| --- | --- | --- |
| Whitebox toolbox (1,000+ WebAssembly tools) | Yes | Yes |
| Processing → GeoLibre Toolbox → Vector, browser-engine Conversion, client raster tools | Yes | Yes |
| SQL Workspace (DuckDB-WASM, PGlite/PostGIS, in-browser Apache Sedona on CereusDB) | Yes | Yes |
| Python sidecar engines (GeoPandas vector, rasterio raster, GDAL conversion, SamGeo segmentation, the SedonaDB sidecar behind the Apache Sedona engine) | Yes | No |
| Add Data → PostgreSQL / PostGIS (martin tile server) | Yes | No |
| Notebook panel on a local JupyterLab server | Yes | JupyterLite only |
| Installing external plugins from a zip or the registry | Yes | Built-in and bundled plugins only |
| Earth Engine sign-in | Yes | No |
| In-app update checks | Yes | Updates come from the Store |

Everything client-side is unchanged: MapLibre and deck.gl rendering, Add Data for
local and remote files, DuckDB-WASM vector reading, the Whitebox WASM toolbox,
Turf/Pyodide vector tools, browser-engine conversions, client raster tools, the
SQL Workspace, the Python console, in-browser detection and segmentation,
geocoding, and collaboration. All three SQL engines still run, Apache Sedona
included: without a sidecar it uses its in-browser CereusDB build, which carries
the [attribute-SQL limitation](user-guide/sql-workspace.md#choosing-a-sql-engine)
that engine has everywhere else.

The sandbox also changes three behaviors:

- **Loose shapefiles**: the app can only read files you picked in the dialog, so
  select **every** shapefile part (`.shp`, `.dbf`, `.prj`, ...) at once, or load
  a zipped shapefile. A `.shp` picked alone loads without attributes or CRS.
- **API keys from the shell environment**: a sandboxed app does not inherit a
  login shell, so enter keys in Settings instead.
- **Reopening projects that reference local files**: the file grant ends with the
  process, so after a relaunch a layer backed by a local path outside the app
  container needs to be re-added.

If you need the Python sidecar engines, Add Data → PostgreSQL/PostGIS through
martin, a local Jupyter server, Earth Engine, or external plugins, install the
Homebrew / DMG build instead. See [Mac App Store](mac-app-store.md) for the full
technical detail.

## Linux installation

GeoLibre offers several Linux install options. The AUR, COPR, and Flatpak
packages auto-update (through your system package manager or `flatpak update`);
the AppImage updates itself in place with [AppImageUpdate](#appimage-any-distribution),
and the direct `.deb` and `.rpm` downloads are updated by re-downloading the new
release.

### Arch Linux / Manjaro (AUR)

GeoLibre is on the [AUR](https://aur.archlinux.org/packages/geolibre-bin) as
`geolibre-bin`, a binary package that repackages the official release (no source
build needed):

```bash
yay -S geolibre-bin      # or: paru -S geolibre-bin
```

### Fedora / RHEL (COPR)

```bash
sudo dnf copr enable giswqs/geolibre
sudo dnf install geolibre
```

On RHEL and derivatives, enable the COPR plugin first with
`sudo dnf install dnf-plugins-core`.

### Flatpak (via [FlatPark](https://flatpark.org/apps/app.geolibre.GeoLibre/))

Works on any distribution with Flatpak. Add the remote once, then install:

```bash
flatpak remote-add --if-not-exists flatpark https://dl.flatpark.org/flatpark.flatpakrepo
flatpak install flatpark app.geolibre.GeoLibre
```

### Debian / Ubuntu (.deb)

Download the `.deb` from the latest release and install it (apt resolves the
dependencies):

```bash
sudo apt install ./GeoLibre.Desktop_<version>_amd64.deb
```

### Other RPM distributions (.rpm)

```bash
sudo dnf install ./GeoLibre.Desktop-<version>-1.x86_64.rpm
```

Use `yum` on older RHEL/CentOS, or `sudo zypper install --allow-unsigned-rpm ./...rpm`
on openSUSE.

### AppImage (any distribution)

Download it, mark it executable, and run it:

```bash
chmod +x GeoLibre.Desktop_<version>_amd64.AppImage
./GeoLibre.Desktop_<version>_amd64.AppImage
```

AppImages need FUSE. On distros that no longer ship it by default, install
`libfuse2` (for example `sudo apt install libfuse2`) or run with
`--appimage-extract-and-run`.

#### Delta updates

Releases after v2.3.0 embed update information in the AppImage, so
[AppImageUpdate](https://github.com/AppImageCommunity/AppImageUpdate),
[AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher),
[AppManager](https://github.com/kem-a/AppManager) and
[AM](https://github.com/ivan-hc/AM) can update it in place. Each release also
ships a `.zsync` file next to the AppImage, so an update transfers only the
blocks that changed rather than the whole image:

```bash
appimageupdatetool GeoLibre.Desktop_<version>_amd64.AppImage
```

Check what an AppImage points at with
`./GeoLibre.Desktop_<version>_amd64.AppImage --appimage-updateinfo`.

## Android installation

### Google Play (recommended)

GeoLibre is on
[Google Play](https://play.google.com/store/apps/details?id=org.geolibre.app) as
a native Android app, built from the same codebase as the desktop and web builds.
The Play build is signed and updates automatically:

[Get GeoLibre on Google Play](https://play.google.com/store/apps/details?id=org.geolibre.app){ .md-button .md-button--primary }

### Sideload an APK

Each [release](https://github.com/opengeos/GeoLibre/releases) also attaches
signed, per-ABI APKs. Download the one matching your device
(`geolibre-android-arm64.apk` for nearly every modern phone), allow installs
from unknown sources, and tap it — or install it over ADB:

```bash
adb install -r geolibre-android-arm64.apk
```

Sideloaded builds do not update themselves, so download a newer APK to upgrade.

!!! note

    The Play build and the sideloaded APKs are signed with different keys, so
    Android will not upgrade one into the other. Uninstall the existing copy
    (`adb uninstall org.geolibre.app`) before switching between them.

Tools that need a local desktop process — the Raster, Conversion, and AI
Segmentation toolboxes, and the PostgreSQL data source — are hidden on Android.
The Whitebox geoprocessing toolbox runs on WebAssembly and stays available. See
[Android](android.md) for the full list and for build instructions.

## iOS installation

GeoLibre is on the
[App Store](https://apps.apple.com/app/geolibre/id6796039674) as a native app for
iPhone and iPad, built from the same codebase as the desktop, web, and Android
builds:

[Get GeoLibre on the App Store](https://apps.apple.com/app/geolibre/id6796039674){ .md-button .md-button--primary }

GeoLibre does not publish a sideloadable `.ipa` for end users, so unlike Android
there are no iOS files attached to GitHub releases: the App Store listing, and
TestFlight for beta builds, are how it is distributed. To run an unreleased
build, build it yourself on a Mac (see [iOS](ios.md)).

The tools that are hidden on Android are hidden on iOS too, for the same reason:
the Raster, Conversion, and AI Segmentation toolboxes and the PostgreSQL data
source all need a local desktop process, and the iOS sandbox forbids spawning
one. The Whitebox geoprocessing toolbox runs on WebAssembly and stays available.
See [iOS](ios.md) for the full list.

!!! note

    The App Store listing above is the iPhone and iPad app
    (`org.geolibre.app`). The [Mac App Store](#mac-app-store) listing is a
    separate record for the sandboxed macOS **desktop** build
    (`org.geolibre.desktop`); the two are different apps with different feature
    sets.

## Build from source

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
npm run tauri:build
```

The default desktop build keeps the Linux binary small and uses DuckDB-WASM for
DuckDB-backed browser features. To build a larger desktop binary with the native
`duckdb-rs` vector loader enabled, run `npm run tauri:build:native-duckdb`.

Desktop builds require the Rust toolchain and Tauri platform prerequisites.
