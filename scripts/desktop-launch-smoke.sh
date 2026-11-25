#!/usr/bin/env bash
# Launch the built desktop binary and fail if it exits during startup.
#
# `cargo check` and the Rust unit tests never run `tauri::Builder::build`, so a
# plugin whose config does not deserialize, or a setup hook that errors, only
# shows up as a crash at launch. v3.10.0 shipped exactly that: the updater
# plugin was registered without a `plugins.updater` block and every desktop
# build aborted at startup (issues #3631, #3632). This keeps that class of bug
# out of `main`.
#
# Usage: scripts/desktop-launch-smoke.sh <binary> [seconds]
# On Linux without a display, run it under `xvfb-run -a`.
set -euo pipefail

binary="${1:?usage: desktop-launch-smoke.sh <binary> [seconds]}"
seconds="${2:-20}"
log="$(mktemp)"

# A throwaway HOME keeps the launch from reading or writing a real profile.
home="$(mktemp -d)"
HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share" \
  "$binary" >"$log" 2>&1 &
pid=$!

for _ in $(seq "$seconds"); do
  if ! kill -0 "$pid" 2>/dev/null; then
    status=0
    wait "$pid" || status=$?
    echo "::error::GeoLibre Desktop exited during startup (status $status)"
    cat "$log"
    exit 1
  fi
  sleep 1
done

kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
echo "GeoLibre Desktop was still running after ${seconds}s."
if grep -q "panicked" "$log"; then
  echo "::error::GeoLibre Desktop logged a panic during startup"
  cat "$log"
  exit 1
fi
