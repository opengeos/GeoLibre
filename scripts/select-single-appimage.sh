#!/usr/bin/env bash
#
# Print the one .AppImage path out of tauri-action's `artifactPaths` output.
#
# Both release.yml and test-build.yml have to hand exactly that path to
# scripts/embed-appimage-update-info.sh. Reading the action's own output beats
# globbing the bundle directory, which also holds the AppImage-packaged build
# tools, and keeping the selection in one place stops the two workflows from
# drifting apart.
#
# Usage:
#   image="$(scripts/select-single-appimage.sh "$ARTIFACT_PATHS")"
#
# The argument is the JSON array tauri-action emits. Exits non-zero unless
# exactly one entry ends in .AppImage, so a bundler change that stops producing
# one (or starts producing several) fails the build rather than silently
# patching the wrong file.
set -euo pipefail

# No apostrophe in the message: bash parses quotes inside ${var:?word}, so one
# there would swallow the rest of the file.
artifacts="${1:?Pass the artifactPaths JSON array from tauri-action}"

mapfile -t images < <(jq -r '.[] | select(endswith(".AppImage"))' <<<"$artifacts")
if [[ ${#images[@]} -ne 1 ]]; then
  echo "Expected exactly one .AppImage in artifactPaths, found ${#images[@]}" >&2
  exit 1
fi
printf '%s\n' "${images[0]}"
