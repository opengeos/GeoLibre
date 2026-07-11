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

# Substitute the token into the nginx /sidecar/ proxy config (the token is hex,
# so it is safe inside the sed replacement).
sed -i "s|__GEOLIBRE_SIDECAR_TOKEN__|${GEOLIBRE_SIDECAR_TOKEN}|g" \
  /etc/nginx/conf.d/default.conf

if [ "${GEOLIBRE_DISABLE_SIDECAR:-0}" != "1" ]; then
  python -m uvicorn geolibre_server.app.main:app \
    --host 127.0.0.1 --port 8765 &
fi

exec nginx -g 'daemon off;'
