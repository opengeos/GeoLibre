#!/usr/bin/env bash
#
# Render the cask for submission to the official homebrew/homebrew-cask repo.
#
# Unlike scripts/render-homebrew-cask.sh (which renders the self-hosted-tap cask
# consumed by the release workflow), this emits the cask intended for the
# official repository as Casks/g/geolibre.rb. It uses the `arch` helper and a
# `livecheck` block so Homebrew's BrewTestBot can auto-bump the version on each
# new GitHub release.
#
# The official tap rejects unsigned/non-notarized apps, so this is only valid
# for Developer ID signed and notarized DMGs (v1.4.1 and later).
#
# Usage:
#   # auto: resolve the latest release, download both DMGs, compute sha256
#   scripts/render-official-cask.sh > geolibre.rb
#
#   # pin a version (still downloads that release's DMGs to hash them):
#   VERSION=1.4.1 scripts/render-official-cask.sh > geolibre.rb
#
#   # supply the hashes directly (skips the download entirely):
#   VERSION=1.4.1 SHA256_ARM=<hex> SHA256_INTEL=<hex> \
#     scripts/render-official-cask.sh > geolibre.rb
#
# Requires: gh (for the auto-download path) and sha256sum or shasum. The
# rendered cask is written to stdout. Run `brew audit --new --cask geolibre`
# and `brew install --cask ./geolibre.rb` on a Mac before opening the PR.
set -euo pipefail

REPO="${REPO:-opengeos/GeoLibre}"

# Resolve the version: an explicit VERSION wins, otherwise use the latest
# published release tag (gh excludes drafts; it includes prereleases, so pin
# VERSION when the latest tag is a prerelease).
if [[ -z "${VERSION:-}" ]]; then
  tag="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
  VERSION="${tag#v}"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || {
  echo "VERSION does not look like a semver string: '$VERSION'" >&2
  exit 1
}

arm_dmg="GeoLibre.Desktop_${VERSION}_aarch64.dmg"
intel_dmg="GeoLibre.Desktop_${VERSION}_x64.dmg"

# Download and hash the DMGs unless both hashes were supplied.
if [[ -z "${SHA256_ARM:-}" || -z "${SHA256_INTEL:-}" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  gh release download "v${VERSION}" --repo "$REPO" \
    --pattern "$arm_dmg" --pattern "$intel_dmg" --dir "$tmp"

  sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1" | awk '{print $1}'
    else
      shasum -a 256 "$1" | awk '{print $1}'
    fi
  }
  SHA256_ARM="${SHA256_ARM:-$(sha256_of "$tmp/$arm_dmg")}"
  SHA256_INTEL="${SHA256_INTEL:-$(sha256_of "$tmp/$intel_dmg")}"
fi

# Validate the hashes so a truncated value can't produce a cask that only fails
# at `brew install` time.
[[ "$SHA256_ARM" =~ ^[0-9a-f]{64}$ ]] || {
  echo "SHA256_ARM is not a 64-char sha256 hex string" >&2
  exit 1
}
[[ "$SHA256_INTEL" =~ ^[0-9a-f]{64}$ ]] || {
  echo "SHA256_INTEL is not a 64-char sha256 hex string" >&2
  exit 1
}

cat <<RUBY
cask "geolibre" do
  arch arm: "aarch64", intel: "x64"

  version "${VERSION}"
  sha256 arm:   "${SHA256_ARM}",
         intel: "${SHA256_INTEL}"

  url "https://github.com/${REPO}/releases/download/v#{version}/GeoLibre.Desktop_#{version}_#{arch}.dmg",
      verified: "github.com/${REPO}/"
  name "GeoLibre Desktop"
  desc "Lightweight, cloud-native GIS platform"
  homepage "https://geolibre.app/"

  livecheck do
    url :url
    strategy :github_latest
  end

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
