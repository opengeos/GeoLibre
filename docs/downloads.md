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
brew trust --cask opengeos/geolibre/geolibre
brew install --cask geolibre
xattr -dr com.apple.quarantine "/Applications/GeoLibre Desktop.app"
```

The `brew trust` step is a one-time approval. Homebrew refuses to load casks
from non-official taps until you trust them; this is enforced when
`HOMEBREW_REQUIRE_TAP_TRUST=1` is set and becomes the default in a future
Homebrew release. `brew trust opengeos/geolibre` trusts the whole tap instead of
just this cask. The command exists in Homebrew 5.1 and later; on older versions
skip it.

The `xattr` step is required because the DMGs are ad-hoc signed but not
notarized by Apple, so macOS Gatekeeper would otherwise block the app with a
"damaged" prompt (see below). It removes the quarantine attribute Homebrew
attaches on download. Upgrade later with:

```bash
brew upgrade --cask geolibre
xattr -dr com.apple.quarantine "/Applications/GeoLibre Desktop.app"
```

Re-run the `xattr` command after each upgrade, since it applies to the newly
installed app bundle.

Homebrew removed the `--no-quarantine` flag in version 5.1, so the manual
`xattr` step replaces it. The tap is also not the official `homebrew/cask`
repository, which requires a notarized, Apple-signed app.

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
