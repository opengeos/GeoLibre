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
The optional Python sidecar tools (Whitebox, raster, conversion) need Python
available just as in the installed build; everything else runs without it.

## macOS installation

Signing and notarization apply to **v1.4.1 and later**. For v1.4.0 and earlier
(ad-hoc signed), remove the quarantine attribute after installing, repeating it
after each upgrade:

```bash
xattr -dr com.apple.quarantine "/Applications/GeoLibre Desktop.app"
```

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

## Linux installation

GeoLibre offers several Linux install options. The AUR, COPR, and Flatpak
packages auto-update (through your system package manager or `flatpak update`);
the direct `.deb`, `.rpm`, and AppImage downloads are updated by re-downloading
the new release.

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

## Build from source

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
npm run tauri:build
```

Desktop builds require the Rust toolchain and Tauri platform prerequisites.
