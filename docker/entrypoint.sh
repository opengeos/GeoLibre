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

AUTH_CONF=/etc/nginx/geolibre-auth.conf
HTPASSWD=/etc/nginx/.htpasswd

# Optional HTTP Basic Auth: when both GEOLIBRE_AUTH_USER and
# GEOLIBRE_AUTH_PASSWORD are set, protect the whole server (app + /sidecar
# proxy) behind a single credential. The snippet and htpasswd are rewritten on
# every start so toggling the env vars across restarts behaves as expected.
# /healthz is exempted in nginx.conf so the container HEALTHCHECK keeps
# passing. Basic Auth is cleartext without TLS; front the container with an
# HTTPS proxy on untrusted networks.
if [ -n "${GEOLIBRE_AUTH_USER:-}" ] || [ -n "${GEOLIBRE_AUTH_PASSWORD:-}" ]; then
  if [ -z "${GEOLIBRE_AUTH_USER:-}" ] || [ -z "${GEOLIBRE_AUTH_PASSWORD:-}" ]; then
    echo "ERROR: GEOLIBRE_AUTH_USER and GEOLIBRE_AUTH_PASSWORD must be set together." >&2
    exit 1
  fi
  case "$GEOLIBRE_AUTH_USER" in
    *:*)
      echo "ERROR: GEOLIBRE_AUTH_USER must not contain ':' (htpasswd field separator)." >&2
      exit 1
      ;;
    '#'*)
      echo "ERROR: GEOLIBRE_AUTH_USER must not start with '#' (htpasswd treats such lines as comments)." >&2
      exit 1
      ;;
  esac
  # An embedded newline would make `openssl passwd -stdin` hash each line
  # separately and corrupt the single-entry htpasswd; a CR (e.g. from a
  # CRLF-terminated --env-file) would silently become part of the stored
  # credential. Fail loudly instead.
  NL='
'
  CR=$(printf '\r')
  case "${GEOLIBRE_AUTH_USER}${GEOLIBRE_AUTH_PASSWORD}" in
    *"$NL"*|*"$CR"*)
      echo "ERROR: GEOLIBRE_AUTH_USER and GEOLIBRE_AUTH_PASSWORD must not contain newlines or carriage returns." >&2
      exit 1
      ;;
  esac
  # -6 = SHA-512 crypt (supported by nginx via glibc crypt(), stronger than
  # the MD5-based apr1); -stdin keeps the password out of openssl's argv.
  HASH=$(printf '%s\n' "$GEOLIBRE_AUTH_PASSWORD" | openssl passwd -6 -stdin)
  printf '%s:%s\n' "$GEOLIBRE_AUTH_USER" "$HASH" > "$HTPASSWD"
  # nginx workers (www-data) open the htpasswd at request time.
  chown root:www-data "$HTPASSWD"
  chmod 640 "$HTPASSWD"
  cat > "$AUTH_CONF" <<'EOF'
auth_basic "GeoLibre";
auth_basic_user_file /etc/nginx/.htpasswd;
EOF
  echo "HTTP Basic Auth enabled for user '$GEOLIBRE_AUTH_USER'."
else
  printf '# Basic Auth disabled (GEOLIBRE_AUTH_USER/GEOLIBRE_AUTH_PASSWORD not set).\n' > "$AUTH_CONF"
  rm -f "$HTPASSWD"
fi

if [ "${GEOLIBRE_DISABLE_SIDECAR:-0}" != "1" ]; then
  python -m uvicorn geolibre_server.app.main:app \
    --host 127.0.0.1 --port 8765 &
fi

exec nginx -g 'daemon off;'
