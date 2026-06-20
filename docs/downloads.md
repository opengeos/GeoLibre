# Downloads

GeoLibre desktop installers are published from GitHub Releases.

[View releases](https://github.com/opengeos/GeoLibre/releases){ .md-button .md-button--primary }
[Open live demo](https://viewer.geolibre.app/){ .md-button }

## Release assets

Release builds are produced for:

- Linux x64: Debian package, RPM package, and AppImage
- Windows x64: unsigned desktop binary
- macOS Apple Silicon: Developer ID signed and notarized DMG and app bundle (v1.4.1+)
- macOS Intel: Developer ID signed and notarized DMG and app bundle (v1.4.1+)

The Windows build is unsigned and may require a platform-specific trust prompt. Check each release note for the exact assets and platform guidance.

## macOS installation

Signing and notarization apply to **v1.4.1 and later**. For v1.4.0 and earlier
(ad-hoc signed), remove the quarantine attribute after installing, repeating it
after each upgrade:

```bash
xattr -dr com.apple.quarantine "/Applications/GeoLibre Desktop.app"
```

### Homebrew (recommended)

GeoLibre is available as a [Homebrew Cask](https://docs.brew.sh/Cask-Cookbook)
from a self-hosted tap:

```bash
brew tap opengeos/geolibre
brew trust --cask opengeos/geolibre/geolibre
brew install --cask geolibre
```

The `brew trust` step is a one-time approval. Homebrew refuses to load casks
from non-official taps until you trust them; this is enforced when
`HOMEBREW_REQUIRE_TAP_TRUST=1` is set and becomes the default in a future
Homebrew release. `brew trust opengeos/geolibre` trusts the whole tap instead of
just this cask. The command exists in Homebrew 5.1 and later; on older versions
skip it.

The macOS DMGs are signed with an Apple Developer ID certificate and notarized
by Apple, so Gatekeeper allows the app to launch normally with no quarantine
workaround. Upgrade later with:

```bash
brew upgrade --cask geolibre
```

### Manual installation

The macOS builds are signed with an Apple Developer ID certificate and notarized
by Apple, so Gatekeeper allows them to open without any extra steps:

1. Download the DMG for your Mac (`aarch64` for Apple Silicon, `x64` for
   Intel).
2. Open the DMG and drag **GeoLibre Desktop** into **Applications**.
3. Launch GeoLibre Desktop from Applications.

## Build from source

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
npm run tauri:build
```

Desktop builds require the Rust toolchain and Tauri platform prerequisites.
