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

  # The DMGs are ad-hoc signed but not notarized, so install with
  # \`--no-quarantine\` to avoid the Gatekeeper "damaged" prompt.
  app "GeoLibre Desktop.app"

  zap trash: [
    "~/Library/Application Support/org.geolibre.desktop",
    "~/Library/Caches/org.geolibre.desktop",
    "~/Library/Preferences/org.geolibre.desktop.plist",
    "~/Library/Saved Application State/org.geolibre.desktop.savedState",
    "~/Library/WebKit/org.geolibre.desktop",
  ]
end
RUBY
