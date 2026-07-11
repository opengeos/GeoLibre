#!/bin/sh
# Start the optional Python sidecar in the background, then run nginx in the
# foreground as PID 1. If nginx exits the container stops; if the sidecar dies
# the static app keeps serving (conversion/Whitebox features report
# unavailable until the container is restarted).
set -e

# Per-container shared secret the sidecar requires on every request (see the
# require_sidecar_token middleware). nginx forwards it on /sidecar/ proxied
# requests and uvicorn enforces it, so the loopback sidecar cannot be driven by
# anything other than the trusted proxy even if its port is ever exposed.
# Honour an operator-provided value; otherwise mint a random one.
GEOLIBRE_SIDECAR_TOKEN="${GEOLIBRE_SIDECAR_TOKEN:-$(python -c 'import secrets; print(secrets.token_hex(16))')}"
export GEOLIBRE_SIDECAR_TOKEN

# The token is embedded in a double-quoted nginx header value, so reject any
# character that could break the config (quotes, backslashes, whitespace, &).
# The auto-generated hex always passes; an operator override must be URL-safe.
case "$GEOLIBRE_SIDECAR_TOKEN" in
  "" | *[!A-Za-z0-9._-]*)
    echo "GEOLIBRE_SIDECAR_TOKEN must be non-empty and contain only [A-Za-z0-9._-]" >&2
    exit 1
    ;;
esac

# Render the nginx config from the immutable image template on every boot. The
# template is never mutated, so a container *restart* (which re-runs this script
# with a freshly generated token but keeps the writable layer) always writes a
# config whose forwarded token matches the token exported to uvicorn above.
# Python's str.replace handles the token literally (no shell/sed metacharacter
# surprises).
python -c '
import os
token = os.environ["GEOLIBRE_SIDECAR_TOKEN"]
src = open("/etc/nginx/nginx.conf.template").read()
open("/etc/nginx/conf.d/default.conf", "w").write(
    src.replace("__GEOLIBRE_SIDECAR_TOKEN__", token)
)
'

if [ "${GEOLIBRE_DISABLE_SIDECAR:-0}" != "1" ]; then
  python -m uvicorn geolibre_server.app.main:app \
    --host 127.0.0.1 --port 8765 &
fi

exec nginx -g 'daemon off;'
