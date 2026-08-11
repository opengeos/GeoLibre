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

# Optional AI proxy. All three values are required together so merely setting a
# model never embeds or enables ai.geolibre.app. GEOLIBRE_AI_URL is deliberately
# restricted to the same-origin /ai route; the remote Worker URL and instance
# token remain server-side in nginx.
AI_PROXY_CONF=/etc/nginx/geolibre-ai-proxy.conf
if [ -n "${GEOLIBRE_AI_URL:-}" ] || [ -n "${GEOLIBRE_AI_PROXY_URL:-}" ] || [ -n "${GEOLIBRE_AI_PROXY_TOKEN:-}" ]; then
  if [ -z "${GEOLIBRE_AI_URL:-}" ] || [ -z "${GEOLIBRE_AI_PROXY_URL:-}" ] || [ -z "${GEOLIBRE_AI_PROXY_TOKEN:-}" ]; then
    echo "ERROR: GEOLIBRE_AI_URL, GEOLIBRE_AI_PROXY_URL, and GEOLIBRE_AI_PROXY_TOKEN must be set together." >&2
    exit 1
  fi
  case "$GEOLIBRE_AI_URL" in
    /ai|/ai/) GEOLIBRE_AI_URL=/ai ;;
    *)
      echo "ERROR: Docker GEOLIBRE_AI_URL must be the same-origin path /ai." >&2
      exit 1
      ;;
  esac
  case "$GEOLIBRE_AI_PROXY_TOKEN" in
    "" | *[!A-Za-z0-9._-]*)
      echo "ERROR: GEOLIBRE_AI_PROXY_TOKEN must contain only [A-Za-z0-9._-]." >&2
      exit 1
      ;;
  esac
  export GEOLIBRE_AI_URL
  export GEOLIBRE_AI_MODEL="${GEOLIBRE_AI_MODEL:-openai/gpt-5.5}"
  export GEOLIBRE_AI_PROXY_URL GEOLIBRE_AI_PROXY_TOKEN

  python -c '
import ipaddress
import os
from urllib.parse import urlsplit

upstream = os.environ["GEOLIBRE_AI_PROXY_URL"].rstrip("/")
parsed = urlsplit(upstream)
if (
    parsed.scheme != "https"
    or not parsed.hostname
    or parsed.username
    or parsed.password
    or parsed.path not in ("", "/")
    or parsed.query
    or parsed.fragment
):
    raise SystemExit(
        "ERROR: GEOLIBRE_AI_PROXY_URL must be an HTTPS origin without credentials, path, query, or fragment."
    )

host = parsed.hostname
# urlsplit strips the brackets from an IPv6 literal; Host and SNI need them back
# or the generated header is ambiguous and nginx rejects the config.
authority = f"[{host}]" if ":" in host else host
host_header = authority if parsed.port is None else f"{authority}:{parsed.port}"

# Behind a fronting TLS proxy $remote_addr is that proxy, which would collapse
# every user into a single rate-limit bucket upstream. Trust X-Forwarded-For
# only from explicitly listed proxy CIDRs; unset means trust nobody. Each entry
# is parsed as a network before it reaches the config, so nothing else can be
# smuggled into the generated directives.
trusted = []
for entry in os.environ.get("GEOLIBRE_TRUSTED_PROXIES", "").split(","):
    entry = entry.strip()
    if not entry:
        continue
    try:
        trusted.append(str(ipaddress.ip_network(entry, strict=False)))
    except ValueError:
        raise SystemExit(
            f"ERROR: GEOLIBRE_TRUSTED_PROXIES entry {entry!r} is not an IP address or CIDR."
        )
real_ip = "".join(f"    set_real_ip_from {entry};\n" for entry in trusted)
if real_ip:
    real_ip += "    real_ip_header X-Forwarded-For;\n    real_ip_recursive on;\n"

token = os.environ["GEOLIBRE_AI_PROXY_TOKEN"]
config = f"""
location /ai/ {{
{real_ip}
    proxy_pass {upstream}/;
    proxy_http_version 1.1;
    proxy_ssl_server_name on;
    proxy_ssl_name {host};
    proxy_set_header Host {host_header};
    proxy_set_header Authorization "";
    proxy_set_header Origin "";
    proxy_set_header X-GeoLibre-Instance-Token "{token}";
    proxy_set_header X-GeoLibre-Client-IP $remote_addr;
    proxy_set_header X-Forwarded-For "";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
}}
"""
open("/etc/nginx/geolibre-ai-proxy.conf", "w").write(config)
'
  chmod 640 "$AI_PROXY_CONF"
  echo "Authenticated AI proxy enabled at /ai."
else
  printf '# AI proxy disabled (GEOLIBRE_AI_URL not set).\n' > "$AI_PROXY_CONF"
fi

# Runtime config the app reads at load (index.html pulls it in before the
# bundle). Written on every boot, after the optional blocks above have exported
# their values, so toggling any of these env vars across restarts takes effect.
# Python JSON-encodes the values, so nothing an operator passes can break out of
# the generated script.
python -c '
import json
import os
import re
import base64
from urllib.parse import urlsplit

deployment = {}
if os.environ.get("GEOLIBRE_AI_URL"):
    deployment["VITE_GEOLIBRE_AI_URL"] = os.environ["GEOLIBRE_AI_URL"]
    deployment["VITE_GEOLIBRE_AI_MODEL"] = os.environ["GEOLIBRE_AI_MODEL"]

# Optional Clerk sign-in gate. The publishable key is intentionally public and
# is all the browser needs; Clerk secrets never enter the image or runtime
# config. A publishable key is `pk_test_`/`pk_live_` + base64url of the Frontend
# API hostname with a trailing "$" delimiter, so check the whole shape now: the
# prefix rejects a secret key pasted into this variable (which would otherwise be
# published to every visitor in the runtime config), and decoding the hostname
# makes an invalid key fail at container startup instead of leaving a blank
# login page.
clerk_key = os.environ.get("GEOLIBRE_CLERK_PUBLISHABLE_KEY", "").strip()
if clerk_key:
    if not clerk_key.startswith(("pk_test_", "pk_live_")):
        raise SystemExit(
            "ERROR: GEOLIBRE_CLERK_PUBLISHABLE_KEY must be a Clerk publishable key (pk_test_... or pk_live_...)."
        )
    try:
        encoded = clerk_key.split("_", 2)[2]
        encoded += "=" * (-len(encoded) % 4)
        # validate=True so stray characters are an error rather than silently
        # discarded, which would decode a malformed key into a plausible host.
        clerk_fapi = base64.b64decode(encoded, altchars="-_", validate=True).decode()
    except (IndexError, ValueError, UnicodeDecodeError) as error:
        raise SystemExit("ERROR: GEOLIBRE_CLERK_PUBLISHABLE_KEY is invalid.") from error
    if not clerk_fapi.endswith("$"):
        raise SystemExit("ERROR: GEOLIBRE_CLERK_PUBLISHABLE_KEY is invalid.")
    clerk_fapi = clerk_fapi[:-1]
    if not re.fullmatch(r"[A-Za-z0-9.-]+", clerk_fapi) or "." not in clerk_fapi:
        raise SystemExit("ERROR: GEOLIBRE_CLERK_PUBLISHABLE_KEY contains an invalid Frontend API host.")
    deployment["VITE_GEOLIBRE_CLERK_PUBLISHABLE_KEY"] = clerk_key

# Optional waitlist screen, for a Clerk instance whose sign-up mode is
# "Waitlist": visitors request access and an admin approves each one from the
# Clerk Dashboard. Off by default, because on a "Restricted" (invite-only)
# instance the form would take submissions nobody can approve.
clerk_waitlist = os.environ.get("GEOLIBRE_CLERK_WAITLIST", "").strip().lower()
if clerk_waitlist in ("1", "true"):
    # Refuse rather than ignore: an operator who set this expects visitors to be
    # able to request access, and silently serving a public app instead would be
    # the opposite of what they asked for.
    if not clerk_key:
        raise SystemExit(
            "ERROR: GEOLIBRE_CLERK_WAITLIST needs GEOLIBRE_CLERK_PUBLISHABLE_KEY; the waitlist is part of the Clerk sign-in gate."
        )
    deployment["VITE_GEOLIBRE_CLERK_WAITLIST"] = "1"
elif clerk_waitlist not in ("", "0", "false"):
    raise SystemExit("ERROR: GEOLIBRE_CLERK_WAITLIST must be 1/true or 0/false.")

# Origins allowed to drive a framed app over the embed postMessage API. Unset
# means the API stays off, so a public deployment can never be driven by the
# page that frames it. "*" allows any origin: private networks only.
origins = []
for entry in os.environ.get("GEOLIBRE_EMBED_ORIGINS", "").replace(",", " ").split():
    if entry == "*":
        origins.append(entry)
        continue
    parsed = urlsplit(entry)
    # postMessage can only be scoped to an origin, so a path/query/fragment on an
    # otherwise valid URL is dropped rather than rejected (matching how the app
    # parses the same value). Credentials and other schemes are a mistake worth
    # failing the boot for, since they can never match a real host.
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        raise SystemExit(
            f"ERROR: GEOLIBRE_EMBED_ORIGINS entry {entry!r} must be an http(s) "
            "origin such as https://portal.example.com."
        )
    origins.append(f"{parsed.scheme}://{parsed.netloc}")
if origins:
    deployment["VITE_GEOLIBRE_EMBED_ORIGINS"] = ",".join(origins)


def service_url(name, value, schemes, loopback_schemes, loopback_hosts):
    """Validate a self-hosted service URL, or exit with an explanation.

    Both of these carry a Bearer token, so a plaintext scheme is only allowed on
    loopback (development). The app applies the same rule and *refuses* a value it
    rejects rather than falling back to the public hosted service — so a value
    that reaches the app unvalidated becomes a silently disabled feature. Failing
    the boot instead puts the error where an operator will actually see it.
    """
    parsed = urlsplit(value)
    # Both checks below run before the loopback shortcut, so their guarantees hold
    # for every accepted value. That ordering is load-bearing: urlsplit() parses
    # ws://localhost:8080"; ... with hostname "localhost", which would match the
    # loopback allowlist while netloc still carried the rest.
    #
    # Credentials: both values are echoed to stdout further down, so a credentialed
    # URL would also land in the container logs.
    if parsed.username or parsed.password:
        raise SystemExit(f"ERROR: {name} must not embed credentials.")
    # Character set: netloc is substituted unescaped into the double-quoted CSP
    # add_header value in nginx.conf.template, so anything outside a hostname,
    # port, or IPv6 literal could break out of that string and inject nginx
    # directives. urlsplit() puts everything up to the next /, ? or # into netloc,
    # quotes and semicolons included. Same discipline as GEOLIBRE_TRUSTED_PROXIES
    # (parsed through ipaddress) and GEOLIBRE_AI_PROXY_URL (no path/query/fragment).
    if re.search(r"[^A-Za-z0-9.\-:\[\]]", parsed.netloc):
        raise SystemExit(
            f"ERROR: {name} host may contain only letters, digits, dots, hyphens, "
            f"colons, and brackets, not {parsed.netloc!r}."
        )
    if parsed.scheme in loopback_schemes and parsed.hostname in loopback_hosts:
        return value
    if parsed.scheme not in schemes or not parsed.netloc:
        # Joined outside the f-string, and with double quotes. This whole program
        # is one single-quoted `python -c` argument, so a literal apostrophe here
        # would close that argument in the shell; Python would then receive
        # `{/.join(...)}` and die of a SyntaxError. Note -c compiles as a unit, so
        # that failure hits every deployment at boot, not just an invalid URL.
        allowed_hosts = "/".join(loopback_hosts)
        raise SystemExit(
            f"ERROR: {name} must be a {schemes[0]}:// URL "
            f"(or {loopback_schemes[0]}:// on {allowed_hosts}), not {value!r}."
        )
    return value


# Project sharing server. Unset means the public hosted service; "off" removes
# Share and the Project Gallery from the UI entirely.
share_url = os.environ.get("GEOLIBRE_SHARE_URL", "").strip()
if share_url:
    if share_url.lower() == "off":
        deployment["VITE_GEOLIBRE_SHARE_URL"] = "off"
    else:
        deployment["VITE_GEOLIBRE_SHARE_URL"] = service_url(
            "GEOLIBRE_SHARE_URL", share_url, ("https",), ("http",), ("localhost", "127.0.0.1")
        )

# Live collaboration relay. Unset leaves collaboration dark.
collab_url = os.environ.get("GEOLIBRE_COLLAB_URL", "").strip()
if collab_url:
    deployment["VITE_GEOLIBRE_COLLAB_URL"] = service_url(
        "GEOLIBRE_COLLAB_URL", collab_url, ("wss",), ("ws",), ("localhost", "127.0.0.1", "::1")
    )

with open("/usr/share/nginx/html/geolibre-runtime-config.js", "w") as output:
    output.write("window.__GEOLIBRE_DEPLOYMENT_ENV__ = ")
    json.dump(deployment, output, separators=(",", ":"))
    output.write(";\n")
'

# Strip surrounding whitespace exactly as the Python block above does, so the boot
# log reports the value that actually landed in the runtime config rather than the
# raw variable (`" off "` is disabled there, and should read as disabled here too).
trim() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

if [ -n "$(trim "${GEOLIBRE_SHARE_URL:-}")" ]; then
  SHARE_URL_LOG=$(trim "$GEOLIBRE_SHARE_URL")
  # Case-insensitive to match the Python validator above and the client's
  # resolveShareHost, both of which lowercase before comparing to "off".
  case "$SHARE_URL_LOG" in
    [oO][fF][fF]) echo "Project sharing disabled (GEOLIBRE_SHARE_URL=off)." ;;
    *) echo "Project sharing server: $SHARE_URL_LOG" ;;
  esac
fi

if [ -n "$(trim "${GEOLIBRE_COLLAB_URL:-}")" ]; then
  echo "Collaboration relay: $(trim "$GEOLIBRE_COLLAB_URL")"
fi

if [ -n "${GEOLIBRE_EMBED_ORIGINS:-}" ]; then
  echo "Embed postMessage API enabled for: $GEOLIBRE_EMBED_ORIGINS"
fi

if [ -n "$(trim "${GEOLIBRE_CLERK_PUBLISHABLE_KEY:-}")" ]; then
  # Lower-cased to match the Python validator above, which compares after
  # `.lower()` — so a spelling like `TRue` enables the screen and must not then
  # be logged as a plain sign-in gate.
  case "$(trim "${GEOLIBRE_CLERK_WAITLIST:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true) echo "Clerk sign-in gate enabled, with the waitlist screen." ;;
    *) echo "Clerk sign-in gate enabled." ;;
  esac
fi

# Render the nginx config from the immutable image template on every boot. The
# template is never mutated, so a container *restart* (which re-runs this script
# with a freshly generated token but keeps the writable layer) always writes a
# config whose forwarded token matches the token exported to uvicorn above.
# Python's str.replace handles the token literally (no shell/sed metacharacter
# surprises).
python -c '
import os
import re
import base64
from urllib.parse import urlsplit

token = os.environ["GEOLIBRE_SIDECAR_TOKEN"]

# A self-hosted relay has to be allowed in connect-src or the browser blocks its
# WebSocket: the directive has a bare "https:" (so any share host works) but no
# bare "wss:". Only the origin is inserted -- CSP source expressions do not take a
# path, and the value was already validated above.
collab = os.environ.get("GEOLIBRE_COLLAB_URL", "").strip()
# Carries its own leading space so the header is byte-identical to the template
# when no relay is configured.
collab_src = ""
if collab:
    parsed = urlsplit(collab)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    # Re-checked here rather than trusting service_url(): this string goes into a
    # quoted nginx directive, so it must be a plain origin or nothing at all.
    if not re.fullmatch(r"[A-Za-z]+://[A-Za-z0-9.\-:\[\]]+", origin):
        raise SystemExit(f"ERROR: GEOLIBRE_COLLAB_URL is not a plain origin: {collab!r}.")
    collab_src = f" {origin}"

# Clerk loads its browser SDK from the Frontend API hostname encoded in the
# publishable key. Add only that exact hostname to script-src. The remaining
# documented Clerk requirements are fixed origins in the nginx template.
#
# The runtime-config block above already decoded and validated this same key
# (`set -e` means we never get here if it rejected one), but the decode is
# repeated with its own try/except rather than relying on that ordering: this is
# a separate `python -c` process, so an edit that reorders, extracts, or drops
# the earlier block would otherwise turn an invalid key into a raw traceback
# instead of the clean ERROR message.
clerk_src = ""
clerk_frame_src = ""
clerk_key = os.environ.get("GEOLIBRE_CLERK_PUBLISHABLE_KEY", "").strip()
if clerk_key:
    if not clerk_key.startswith(("pk_test_", "pk_live_")):
        raise SystemExit(
            "ERROR: GEOLIBRE_CLERK_PUBLISHABLE_KEY must be a Clerk publishable key (pk_test_... or pk_live_...)."
        )
    try:
        encoded = clerk_key.split("_", 2)[2]
        encoded += "=" * (-len(encoded) % 4)
        clerk_fapi = base64.b64decode(encoded, altchars="-_", validate=True).decode()
    except (IndexError, ValueError, UnicodeDecodeError) as error:
        raise SystemExit("ERROR: GEOLIBRE_CLERK_PUBLISHABLE_KEY is invalid.") from error
    if not clerk_fapi.endswith("$"):
        raise SystemExit("ERROR: GEOLIBRE_CLERK_PUBLISHABLE_KEY is invalid.")
    clerk_fapi = clerk_fapi[:-1]
    if not re.fullmatch(r"[A-Za-z0-9.-]+", clerk_fapi) or "." not in clerk_fapi:
        raise SystemExit("ERROR: GEOLIBRE_CLERK_PUBLISHABLE_KEY contains an invalid Frontend API host.")
    clerk_src = f" https://{clerk_fapi} https://challenges.cloudflare.com https://*.protect.clerk.com"
    clerk_frame_src = " https://challenges.cloudflare.com https://*.protect.clerk.com"

src = open("/etc/nginx/nginx.conf.template").read()
open("/etc/nginx/conf.d/default.conf", "w").write(
    src.replace("__GEOLIBRE_SIDECAR_TOKEN__", token).replace(
        "__GEOLIBRE_COLLAB_CONNECT_SRC__", collab_src
    ).replace(
        "__GEOLIBRE_CLERK_SCRIPT_SRC__", clerk_src
    ).replace(
        "__GEOLIBRE_CLERK_FRAME_SRC__", clerk_frame_src
    )
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
