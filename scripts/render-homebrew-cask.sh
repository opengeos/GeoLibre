#!/usr/bin/env bash
#
# Render the Homebrew cask for the GeoLibre desktop app.
#
# The macOS DMGs are ad-hoc signed but not notarized by Apple, so the cask is
# meant to be installed from a self-hosted tap with `--no-quarantine`. It is not
# suitable for the official homebrew/cask repository.
#
# Usage:
#   VERSION=1.2.0 \
#   SHA256_ARM=<sha256 of GeoLibre.Desktop_<version>_aarch64.dmg> \
#   SHA256_INTEL=<sha256 of GeoLibre.Desktop_<version>_x64.dmg> \
#   scripts/render-homebrew-cask.sh > Casks/geolibre.rb
#
# All three variables are required. The rendered cask is written to stdout.
set -euo pipefail

: "${VERSION:?Set VERSION to the release version, e.g. 1.2.0}"
: "${SHA256_ARM:?Set SHA256_ARM to the sha256 of the aarch64 DMG}"
: "${SHA256_INTEL:?Set SHA256_INTEL to the sha256 of the x64 DMG}"

# Validate formats so a truncated hash or stray metacharacter can't silently
# produce a malformed cask that only fails at `brew install` time.
[[ "$SHA256_ARM" =~ ^[0-9a-f]{64}$ ]] || { echo "SHA256_ARM is not a 64-char sha256 hex string" >&2; exit 1; }
[[ "$SHA256_INTEL" =~ ^[0-9a-f]{64}$ ]] || { echo "SHA256_INTEL is not a 64-char sha256 hex string" >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "VERSION does not look like a semver string" >&2; exit 1; }

REPO="${REPO:-opengeos/GeoLibre}"

cat <<RUBY
cask "geolibre" do
  version "${VERSION}"

  on_arm do
    sha256 "${SHA256_ARM}"

    url "https://github.com/${REPO}/releases/download/v#{version}/GeoLibre.Desktop_#{version}_aarch64.dmg",
        verified: "github.com/${REPO}/"
  end
  on_intel do
    sha256 "${SHA256_INTEL}"

    url "https://github.com/${REPO}/releases/download/v#{version}/GeoLibre.Desktop_#{version}_x64.dmg",
        verified: "github.com/${REPO}/"
  end

  name "GeoLibre Desktop"
  desc "Lightweight, cloud-native GIS platform"
  homepage "https://geolibre.app/"

  app "GeoLibre Desktop.app"

  # The DMGs are ad-hoc signed but not notarized by Apple, so macOS Gatekeeper
  # blocks them with a "damaged" prompt. Homebrew removed the --no-quarantine
  # flag in 5.1, so the user must strip the quarantine attribute by hand.
  caveats <<~EOS
    GeoLibre Desktop is not notarized by Apple. Before first launch, remove the
    quarantine attribute (repeat this after every upgrade):

      xattr -dr com.apple.quarantine "/Applications/GeoLibre Desktop.app"
  EOS

  zap trash: [
    "~/Library/Application Support/org.geolibre.desktop",
    "~/Library/Caches/org.geolibre.desktop",
    "~/Library/Preferences/org.geolibre.desktop.plist",
    "~/Library/Saved Application State/org.geolibre.desktop.savedState",
    "~/Library/WebKit/org.geolibre.desktop",
  ]
end
RUBY
