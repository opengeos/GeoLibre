#!/usr/bin/env bash
# Render the Mac App Store entitlements from the committed template by
# substituting the Apple Developer team ID. Run before `npm run tauri:build:mas`.
#
# Usage: APPLE_TEAM_ID=XXXXXXXXXX scripts/render-mas-entitlements.sh
set -euo pipefail

if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "APPLE_TEAM_ID must be set (your Apple Developer team ID)." >&2
  exit 1
fi

# Team IDs are 10 alphanumerics. Validating keeps the sed substitution below
# trivially safe (no metacharacters) and catches a mispasted secret early.
if [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "APPLE_TEAM_ID must be a 10-character Apple Developer team ID, got \"$APPLE_TEAM_ID\"." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mas_dir="$repo_root/apps/geolibre-desktop/src-tauri/mas"
template="$mas_dir/Entitlements.mas.plist.template"
rendered="$mas_dir/Entitlements.mas.plist"

# sed instead of envsubst: gettext is not preinstalled on macOS (including the
# GitHub Actions runners), and only this one placeholder needs substituting.
sed "s/\${APPLE_TEAM_ID}/$APPLE_TEAM_ID/g" "$template" > "$rendered"
plutil -lint "$rendered" >/dev/null
echo "Rendered $rendered for team $APPLE_TEAM_ID"
