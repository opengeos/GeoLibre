#!/usr/bin/env bash
#
# Render the cask for the official homebrew/homebrew-cask repo.
#
# GeoLibre is published in the official repository as Casks/g/geolibre.rb, where
# Homebrew's BrewTestBot auto-bumps the version on each new GitHub release via
# the `livecheck` block below. Use this script to regenerate that cask (e.g. when
# editing metadata or re-submitting). Unlike scripts/render-homebrew-cask.sh
# (which renders the self-hosted-tap fallback consumed by the release workflow),
# this emits the official cask and uses the `arch` helper.
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
# REPO is interpolated verbatim into the generated cask's url/verified lines, so
# guard its shape (the default is safe; this only matters on a fork override).
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "REPO must be in owner/repo format (e.g. opengeos/GeoLibre): '$REPO'" >&2
  exit 1
}

# Resolve the version: an explicit VERSION wins, otherwise use the latest full
# release. `gh release view` with no tag calls GitHub's /releases/latest, which
# already excludes prereleases and drafts; pin VERSION only to target an older
# tag. (The X.Y.Z check below is a belt-and-suspenders guard regardless.)
if [[ -z "${VERSION:-}" ]]; then
  tag="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
  VERSION="${tag#v}"
fi
# Anchor both ends: the official tap takes only final X.Y.Z releases, so a
# prerelease tag (1.2.3-rc.1) or any trailing junk must be rejected, not just
# matched as a prefix.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "VERSION does not look like a final X.Y.Z release: '$VERSION'" >&2
  exit 1
}

arm_dmg="GeoLibre.Desktop_${VERSION}_aarch64.dmg"
intel_dmg="GeoLibre.Desktop_${VERSION}_x64.dmg"

# Download and hash the DMGs unless both hashes were supplied.
if [[ -z "${SHA256_ARM:-}" || -z "${SHA256_INTEL:-}" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # Fetch only the DMG(s) whose hash is still unknown, so supplying one hash
  # does not pull the other ~100 MB file needlessly.
  [[ -n "${SHA256_ARM:-}" ]] || gh release download "v${VERSION}" --repo "$REPO" \
    --pattern "$arm_dmg" --dir "$tmp"
  [[ -n "${SHA256_INTEL:-}" ]] || gh release download "v${VERSION}" --repo "$REPO" \
    --pattern "$intel_dmg" --dir "$tmp"

  # Fail loudly if the expected DMG is missing (e.g. a partial download): the
  # awk pipe alone would mask the hash binary's failure and yield an empty
  # string, surfacing only as a cryptic format error further down.
  sha256_of() {
    [[ -f "$1" ]] || {
      echo "expected DMG not found (download failed?): $1" >&2
      return 1
    }
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1" | awk '{print $1}'
    else
      shasum -a 256 "$1" | awk '{print $1}'
    fi
  }
  # Plain `||` assignments (not a ${:-} default) so a hashing failure aborts the
  # script under `set -e` instead of silently producing an empty hash.
  [[ -n "${SHA256_ARM:-}" ]] || SHA256_ARM="$(sha256_of "$tmp/$arm_dmg")"
  [[ -n "${SHA256_INTEL:-}" ]] || SHA256_INTEL="$(sha256_of "$tmp/$intel_dmg")"
fi

# Normalise to lowercase so a hash pasted from a tool that emits uppercase (e.g.
# `openssl dgst -sha256`) still validates; sha256sum/shasum already emit
# lowercase. `tr` keeps this working on macOS's default Bash 3.2, where the
# `${var,,}` lowercase expansion is unavailable.
SHA256_ARM="$(printf '%s' "$SHA256_ARM" | tr '[:upper:]' '[:lower:]')"
SHA256_INTEL="$(printf '%s' "$SHA256_INTEL" | tr '[:upper:]' '[:lower:]')"

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

  depends_on :macos

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
