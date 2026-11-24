# GeoLibre server API

Reference implementation of [`docs/server-api.md`](../../docs/server-api.md).
It is a separate multi-user service from the local desktop processing sidecar.

```bash
pip install -e ".[test]"
geolibre-server-api
```

Configuration:

- `GEOLIBRE_DATABASE_URL`: SQLAlchemy URL; defaults to
  `sqlite:///./geolibre-server-api.db`. Use
  `postgresql+psycopg://user:password@host/database` with the `postgres` extra.
- `GEOLIBRE_STORAGE_PATH`: local object directory, default `./data`.
- `GEOLIBRE_STORAGE=s3`, `GEOLIBRE_S3_BUCKET`, and optional
  `GEOLIBRE_S3_ENDPOINT` / `GEOLIBRE_S3_REGION`: S3-compatible storage (install
  the `s3` extra; standard AWS credential environment variables apply).
- `GEOLIBRE_PUBLIC_URL`: externally reachable API URL and, when OAuth is
  enabled, its canonical issuer. Production OAuth requires HTTPS. Loopback HTTP
  requires `localhost` or `127.0.0.1` plus an explicit port.
- `GEOLIBRE_VIEWER_URL`: GeoLibre viewer origin.
- `GEOLIBRE_CORS_ORIGINS`: comma-separated web origins, default `*` for
  ordinary API routes. OAuth CORS always includes registered web callback
  origins, but never inherits `*`. Register the exact browser app origin;
  self-hosted desktop calls use browser CORS, so allow `tauri://localhost`
  and/or `http://tauri.localhost` there as well. The shipped
  `https://share.geolibre.app` desktop origin uses native HTTP for
  authenticated requests instead; other hosts do not silently bypass CORS.
- `GEOLIBRE_OAUTH_CLIENTS`: JSON array of exact public-client registrations:
  ```json
  [
    {"client_id":"geolibre-web","name":"GeoLibre Web",
     "redirect_uris":["https://app.example/oauth-callback.html"],
     "scopes":["read:projects","write:projects","share:public","manage:sessions"]},
    {"client_id":"geolibre-desktop","name":"GeoLibre Desktop",
     "redirect_uris":["org.geolibre.desktop:/oauth/callback"],
     "scopes":["read:projects","write:projects","share:public","manage:sessions"]}
  ]
  ```
  Empty or unset disables OAuth without validating OAuth-only settings. Both
  clients must use their own exact redirect; the desktop callback works only
  after the URI handler is registered by an installed app. The three project
  scopes form a refreshable project grant; `manage:sessions` must be requested
  alone for a fresh, access-only, five-minute consent. Personal API tokens
  cannot carry that scope.
- `GEOLIBRE_OAUTH_CODE_TTL_SECONDS` (default `60`),
  `GEOLIBRE_OAUTH_ACCESS_TTL_SECONDS` (`600`), and
  `GEOLIBRE_OAUTH_REFRESH_TTL_SECONDS` (`2592000`): positive integer grant
  lifetimes. Refresh rotation never extends a project family's absolute expiry;
  the management grant always expires within 300 seconds and never refreshes.
- `GEOLIBRE_TRUSTED_PROXIES`: comma-separated IPs or CIDR networks of reverse
  proxies whose `X-Forwarded-For` header is trusted when resolving the client
  address for rate limits and organization admin IP allowlists (default empty:
  the direct peer is the client). An invalid entry fails startup.
- `GEOLIBRE_PROXY_AUTH`: `true` (or `1`/`yes`) lets those trusted proxies sign
  users in on the OAuth consent page through their identity headers (default
  empty: identity headers are ignored, even from a trusted proxy).
- `GEOLIBRE_PROXY_USER_HEADER` (default `Remote-User`) and
  `GEOLIBRE_PROXY_EMAIL_HEADER` (default `Remote-Email`): the headers a trusted
  proxy uses to pass the signed-in user and their email when
  `GEOLIBRE_PROXY_AUTH` is on. The proxy must strip these headers from client
  requests.
- `GEOLIBRE_OIDC_CA_BUNDLE`: PEM file of CA certificates trusted for calls to
  organization identity providers in addition to the public CAs bundled with
  `certifi`, for providers behind a private CA (default empty: the public CAs
  only). An unreadable file fails startup.
- `GEOLIBRE_SECRET_KEYS`: comma-separated Fernet keys that encrypt each
  organization identity provider's OIDC `client_secret` at rest. Generate one
  with
  `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
  and keep it out of the database backups it protects. The first key
  encrypts; every listed key decrypts, so rotate by prepending a new key and
  restarting (startup re-encrypts every secret under the new key), then drop
  the old one. Startup also encrypts secrets stored in plaintext by earlier
  builds, as does `alembic upgrade head`. The key is required by default,
  including with the default localhost public URL: startup fails if
  identity-provider secrets are stored without it, and saving a provider
  secret answers `503`. A
  malformed key, or one that cannot decrypt a stored secret, fails startup.
  Migrations use the same key requirement and development opt-out as startup.
  Set `GEOLIBRE_PUBLIC_URL` to the deployment URL when running Alembic,
  including when an application supplies its URL directly to `create_app`.
- `GEOLIBRE_ALLOW_PLAINTEXT_SECRETS` (default `0`): an explicit development-only
  opt-out from secret encryption. It is honored only with a loopback
  `GEOLIBRE_PUBLIC_URL`. Use it only for development servers that are not
  publicly reachable. Without a key, secrets beginning with `enc:v1:` are
  rejected with `422` because they would be confused with ciphertext.
  For credentials saved by an older build that already used this prefix, see
  [recovering an ambiguous legacy secret](../../docs/server-api.md#recovering-an-ambiguous-legacy-secret).
- `GEOLIBRE_OIDC_ALLOWED_NETWORKS`: comma-separated IPs or CIDR networks that
  organization identity providers may be reached on even though they are not
  public, such as an on-premises IdP on `10.20.0.0/16` (default empty: calls
  to loopback, private, link-local, CGNAT, multicast, and reserved addresses
  are refused, because any user who creates an organization chooses its
  provider URLs). An invalid entry fails startup.
- `GEOLIBRE_MAX_PROJECT_BYTES`, `GEOLIBRE_MAX_THUMBNAIL_BYTES`: upload limits.
- `GEOLIBRE_MAX_REQUEST_BYTES`: ceiling on any request body (default: six
  times `GEOLIBRE_MAX_PROJECT_BYTES` plus 1 KiB, the worst-case JSON encoding
  of a full project). A declared `Content-Length` above it is refused before
  the body is read; a chunked or HTTP/2 body is counted as it streams and cut
  off with `413` once it crosses the ceiling.
- `GEOLIBRE_RATE_LIMIT_AUTH` (default `30/60`) and `GEOLIBRE_RATE_LIMIT_API`
  (default `600/60`): client budgets as `<requests>/<seconds>`, or
  `off`. The first covers the credential routes (`/oauth/authorize`,
  `/oauth/token`, `/oauth/sso/callback`, `/api/auth/token`, `/api/accounts`,
  `/api/account/password`); the second covers every other route except
  `/health` and CORS preflights. Over budget answers `429` with
  `Retry-After`. The client is the `X-Forwarded-For` address only behind a
  `GEOLIBRE_TRUSTED_PROXIES` peer. IPv4 clients are counted per address;
  IPv6 clients share a budget within each /64 subnet. Counters live in each worker process, so
  several workers or replicas multiply the effective budget. A malformed value
  fails startup.
- `GEOLIBRE_HOST`, `GEOLIBRE_PORT`: bind address and port for the
  `geolibre-server-api` entry point, default `0.0.0.0` and `8000`. Bind to
  `127.0.0.1` when a reverse proxy fronts the service.

On startup, the API adds the OAuth lookup and expiry indexes to databases
created by earlier builds as well as to fresh databases, without changing
unexpired grants or tokens. Index creation on a populated database can hold
write locks, so start one API instance during the upgrade before scaling out.

## Volume ownership

The container runs as the unprivileged `geolibre` user, and the image creates
`/data/objects` so a fresh named volume inherits that ownership. Docker applies
image ownership only to a volume it creates, so one that already holds data from
an image that ran as root stays root-owned and every upload fails with
`PermissionError`. Repair it once with

```bash
docker run --rm -v geolibre_geolibre-projects:/data/objects busybox \
  chown -R 1000:1000 /data/objects
```

## Hardening

The API enforces a request-body ceiling and per-process, per-client-IP rate
limits (see `GEOLIBRE_MAX_REQUEST_BYTES` and `GEOLIBRE_RATE_LIMIT_*` above).
Those counters are not shared between workers or replicas, so a public
deployment should still rate-limit **GET and POST** `/oauth/authorize`,
`POST /oauth/token`, `POST /api/auth/token`, and `POST /api/accounts` at its
proxy; the Compose API port binds to loopback so that proxy cannot be bypassed
from outside the host. See "What the reference server leaves to the operator"
in `docs/server-api.md` before public exposure.

Behind a reverse proxy, set `GEOLIBRE_TRUSTED_PROXIES` to the proxy's actual
source IP or network and configure it to replace incoming forwarding headers.
If that setting is empty, every proxied user shares the proxy's address and
therefore one budget: by default, 30 credential requests and 600 other requests
per minute for the entire deployment. Do not trust arbitrary client-supplied
`X-Forwarded-For` headers to separate these budgets.
