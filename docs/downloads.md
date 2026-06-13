# Downloads

GeoLibre desktop installers are published from GitHub Releases.

[View releases](https://github.com/opengeos/GeoLibre/releases){ .md-button .md-button--primary }
[Open live demo](https://viewer.geolibre.app/){ .md-button }

## Release assets

Release builds are produced for:

- Linux x64: Debian package, RPM package, and AppImage
- Windows x64: unsigned desktop binary
- macOS Apple Silicon: ad-hoc signed DMG and app bundle
- macOS Intel: ad-hoc signed DMG and app bundle

The Windows build is unsigned and may require a platform-specific trust prompt. Check each release note for the exact assets and platform guidance.

## macOS installation

### Homebrew (recommended)

GeoLibre is available as a [Homebrew Cask](https://docs.brew.sh/Cask-Cookbook)
from a self-hosted tap:

```bash
brew tap opengeos/geolibre
brew install --cask --no-quarantine geolibre
```

The `--no-quarantine` flag is required because the DMGs are ad-hoc signed but
not notarized by Apple; it lets Homebrew skip the Gatekeeper quarantine that
would otherwise show a "damaged" prompt (see below). Upgrade later with:

```bash
brew upgrade --cask --no-quarantine geolibre
```

The tap is not the official `homebrew/cask` repository, which requires a
notarized, Apple-signed app.

### Manual installation

The macOS builds are not signed with an Apple Developer certificate, so
Gatekeeper blocks them on first launch. Depending on your macOS version and
which release you downloaded, the message is one of:

> "GeoLibre Desktop" cannot be opened because the developer cannot be
> verified.

or:

> "GeoLibre Desktop" is damaged and can't be opened. You should move it to
> the Bin.

The app is not actually damaged. macOS attaches a quarantine attribute to
files downloaded from the internet and refuses to open apps that are not
notarized by Apple. To install:

1. Download the DMG for your Mac (`aarch64` for Apple Silicon, `x64` for
   Intel) and drag **GeoLibre Desktop** into **Applications**.
2. Open **Terminal** and remove the quarantine attribute:

    ```bash
    xattr -cr "/Applications/GeoLibre Desktop.app"
    ```

3. Launch GeoLibre Desktop from Applications as usual.

This is a one-time step per installed version. You only need to repeat it
after installing a new release.

## Build from source

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
npm run tauri:build
```

Desktop builds require the Rust toolchain and Tauri platform prerequisites.
