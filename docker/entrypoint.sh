#!/bin/sh
# Start the optional Python sidecar in the background, then run nginx in the
# foreground as PID 1. If nginx exits the container stops; if the sidecar dies
# the static app keeps serving (conversion/Whitebox features report
# unavailable until the container is restarted).
set -e

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
  esac
  # An embedded newline would make `openssl passwd -stdin` hash each line
  # separately and corrupt the single-entry htpasswd; fail loudly instead.
  NL='
'
  case "${GEOLIBRE_AUTH_USER}${GEOLIBRE_AUTH_PASSWORD}" in
    *"$NL"*)
      echo "ERROR: GEOLIBRE_AUTH_USER and GEOLIBRE_AUTH_PASSWORD must not contain newlines." >&2
      exit 1
      ;;
  esac
  # -stdin keeps the password out of the openssl process's argv.
  HASH=$(printf '%s\n' "$GEOLIBRE_AUTH_PASSWORD" | openssl passwd -apr1 -stdin)
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
