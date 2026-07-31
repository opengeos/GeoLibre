#!/usr/bin/env bash
# Copy the real GeoLibre app icons over the ones `tauri ios init` generates.
#
# Why this exists: `tauri ios init` populates
# gen/apple/Assets.xcassets/AppIcon.appiconset/ from cargo-mobile2's *template*
# icon (a yellow/cyan placeholder baked into the Tauri CLI binary) and ignores
# src-tauri/icons/ios entirely. gen/apple is git-ignored and regenerated on every
# build, including in CI, so without this step every iOS build ships the
# placeholder. Build 2.4.0 (5) reached App Store Connect that way before anyone
# noticed, because the icon is not visible anywhere in the build logs.
#
# The 18 filenames in src-tauri/icons/ios match the generated catalog exactly, so
# this is a straight copy; Contents.json is left alone. If a future Tauri CLI
# changes the catalog's filenames, the verification below fails loudly rather than
# silently leaving the placeholder in place.
#
# Run after `tauri ios init` and before `tauri ios build`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/apps/geolibre-desktop/src-tauri/icons/ios"
dest="$here/apps/geolibre-desktop/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"

if [ ! -d "$src" ]; then
  echo "error: source icons not found at $src" >&2
  exit 1
fi
if [ ! -d "$dest" ]; then
  echo "error: generated asset catalog not found at $dest" >&2
  echo "       run \`npx tauri ios init\` first" >&2
  exit 1
fi

copied=0
missing=0
for f in "$src"/*.png; do
  name="$(basename "$f")"
  if [ ! -f "$dest/$name" ]; then
    echo "warning: $name has no counterpart in the generated catalog" >&2
    missing=$((missing + 1))
    continue
  fi
  cp "$f" "$dest/$name"
  copied=$((copied + 1))
done

# Apple rejects app icons that carry an alpha channel, and the failure surfaces
# at upload ("Invalid large app icon ... can't be transparent") after a full
# build. Assert it here instead. The committed icons are already opaque; this
# guards against a future regeneration reintroducing transparency.
alpha_found=0
for f in "$dest"/*.png; do
  if [ "$(sips -g hasAlpha "$f" 2>/dev/null | awk '/hasAlpha/{print $2}')" = "yes" ]; then
    echo "error: $(basename "$f") has an alpha channel; App Store Connect will reject it" >&2
    alpha_found=$((alpha_found + 1))
  fi
done

if [ "$missing" -gt 0 ] || [ "$alpha_found" -gt 0 ]; then
  echo "error: icon sync incomplete ($missing missing, $alpha_found with alpha)" >&2
  exit 1
fi

echo "Synced $copied app icons into the generated asset catalog (all opaque)."
