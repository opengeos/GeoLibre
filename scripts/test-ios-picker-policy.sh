#!/usr/bin/env bash
set -euo pipefail

policy_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
policy_sources="$policy_repo_root/apps/geolibre-desktop/src-tauri/vendor/tauri-plugin-dialog/ios"
policy_tmp="$(mktemp -d "${TMPDIR:-/tmp}/geolibre-picker-policy.XXXXXX")"
trap 'rm -rf "$policy_tmp"' EXIT

swiftc --version
swiftc -module-cache-path "$policy_tmp/modules" \
  "$policy_sources/Sources/FilePickerPolicy.swift" \
  "$policy_sources/Tests/FilePickerPolicyTests.swift" \
  -o "$policy_tmp/policy-tests"
"$policy_tmp/policy-tests"
