# Getting Started

[![Launch GeoLibre Web](https://img.shields.io/badge/Launch-GeoLibre%20Web-green.svg)](https://web.geolibre.app/)
[![GeoLibre shared project](https://img.shields.io/badge/GeoLibre-share-green.svg)](https://share.geolibre.app)
[![GeoLibre plugins](https://img.shields.io/badge/GeoLibre-plugins-green.svg)](https://plugins.geolibre.app)
[![image](https://img.shields.io/pypi/v/geolibre.svg)](https://pypi.python.org/pypi/geolibre)
[![R package](https://img.shields.io/badge/R-package-276DC3?logo=r&logoColor=white)](https://r.geolibre.app/)
[![image](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/opengeos/GeoLibre/blob/main/python/examples/getting-started.ipynb)
[![image](https://img.shields.io/conda/vn/conda-forge/geolibre.svg)](https://anaconda.org/conda-forge/geolibre)
[![Conda Recipe](https://img.shields.io/badge/recipe-geolibre-green.svg)](https://github.com/conda-forge/geolibre-feedstock)
[![Microsoft Store](https://img.shields.io/badge/Microsoft%20Store-GeoLibre-0078D4?logo=windows)](https://apps.microsoft.com/detail/9nwt67rv531x)
[![Mac App Store](https://img.shields.io/badge/Mac%20App%20Store-GeoLibre-0D96F6?logo=apple&logoColor=white)](https://apps.apple.com/app/geolibre-desktop/id6796848769)
[![App Store](https://img.shields.io/badge/App%20Store-GeoLibre-0D96F6?logo=appstore&logoColor=white)](https://apps.apple.com/app/geolibre/id6796039674)
[![Google Play](https://img.shields.io/badge/Google%20Play-GeoLibre-01875F?logo=googleplay&logoColor=white)](https://play.google.com/store/apps/details?id=org.geolibre.app)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-GeoLibre-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/open-data-in-geolibre/joinecgbfoldanidcoakpjgkbaceaooj)
[![AUR version](https://img.shields.io/aur/version/geolibre-bin?logo=archlinux&label=AUR)](https://aur.archlinux.org/packages/geolibre-bin)
[![FlatPark](https://img.shields.io/badge/FlatPark-GeoLibre-4A90D9?logo=flatpak)](https://flatpark.org/apps/app.geolibre.GeoLibre/)
[![image](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20785400.svg)](https://doi.org/10.5281/zenodo.20785400)

GeoLibre is a free and open-source, lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data. It runs everywhere you do, in the web browser, on the desktop, on mobile, and inside Jupyter notebooks, all while keeping your data local and private.

This page helps you start using GeoLibre. If you want to contribute to GeoLibre or run it from source, jump to [Run from source](#run-from-source) below or read the [Contributing](contributing.md) guide.

## Use GeoLibre

Pick whichever fits how you work. The same app ships in every form, so projects and `.geolibre.json` files move between them.

### On the web

GeoLibre Web is the full app running in your browser, with nothing to install. It keeps your data local and private, processing everything client-side in your browser session.

[Launch GeoLibre Web](https://web.geolibre.app/){ .md-button .md-button--primary }

You can load browser-selected vector data supported by DuckDB-WASM Spatial, drag GeoTIFF/COG rasters onto the map, add URL-based services and datasets (XYZ, WMS, GeoJSON, vector tiles, COG, ArcGIS, FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats), style layers, and test plugins. Desktop-only file dialogs, local MBTiles, local raster file reads, and project save/open need the desktop app.

### On the desktop

The desktop app adds local filesystem dialogs, local MBTiles, local raster file reads, and project save/open. Installers are available for Windows, macOS, and Linux, including the Microsoft Store, the Mac App Store, Homebrew, winget, the AUR, COPR, and Flatpak. (The Mac App Store listing is the sandboxed *desktop* build; the [App Store](https://apps.apple.com/app/geolibre/id6796039674) listing is the iPhone and iPad app.)

[Download the desktop app](downloads.md){ .md-button .md-button--primary }

On macOS, prefer the Homebrew or DMG build: the [Mac App Store](https://apps.apple.com/app/geolibre-desktop/id6796848769) build is sandboxed, so it drops the Python sidecar engines, Add Data → PostgreSQL/PostGIS via martin, the local Jupyter server, Earth Engine sign-in, and external plugin installs. See [what the Store build leaves out](downloads.md#what-the-store-build-leaves-out).

### In Jupyter

The [`geolibre`](python.md) Python package embeds the full GeoLibre app in a Jupyter notebook and drives the map through an expanded leafmap-style API that syncs both ways, so UI edits read back from Python.

```bash
pip install geolibre
```

Or install it from conda-forge:

```bash
conda install -c conda-forge geolibre
```

See the [Python Package](python.md) reference to get started.

### In R

The [`geolibre`](r.md) R package embeds GeoLibre as an interactive HTML widget
in RStudio, Quarto, R Markdown, and Shiny. Install the development release from
GitHub:

```r
install.packages("pak")
pak::pak("opengeos/geolibre-r")
```

[Read the R package guide](r.md){ .md-button .md-button--primary }
[Try the interactive example](https://r.geolibre.app/articles/interactive-map.html){ .md-button }

### On Android

GeoLibre ships as a native Android app built from the same codebase, with a responsive touch layout for phones. Install it from Google Play and it updates automatically:

[Get GeoLibre on Google Play](https://play.google.com/store/apps/details?id=org.geolibre.app){ .md-button .md-button--primary }

Signed APKs are also attached to each [GitHub release](https://github.com/opengeos/GeoLibre/releases) if you prefer to sideload. See [Android](android.md) for what runs on mobile, sideloading instructions, and build details.

### On iOS

GeoLibre ships as a native iOS app for iPhone and iPad, built from the same codebase, with the same responsive touch layout. Install it from the App Store and it updates automatically:

[Get GeoLibre on the App Store](https://apps.apple.com/app/geolibre/id6796039674){ .md-button .md-button--primary }

See [iOS](ios.md) for what runs on mobile and for build details.

## Video tutorials

- [GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere (Browser, Desktop & Jupyter)](https://youtu.be/87Cm0QagtxI)
- [Geoprocessing in the Browser: 700+ Free GIS Tools in GeoLibre, Zero Install](https://youtu.be/W32bIQO_nG8)
- [GeoLibre + GeoLens: A Modern GIS Stack for Self-Hosting Geospatial Data](https://youtu.be/kQqgrxXGd4o)

## Run from source

This section is for contributors and developers who want to clone GeoLibre and run it locally. Most users do not need it. For the full development workflow, project layout, and quality gate, see the [Contributing](contributing.md) guide. GeoLibre is an npm workspaces monorepo: the main app lives in `apps/geolibre-desktop` and is built with Tauri, React, TypeScript, and MapLibre GL JS.

### Prerequisites

- Node.js 22 or newer
- Rust toolchain for desktop builds
- Linux desktop build dependencies from the Tauri v2 prerequisites

### Install

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
```

Bun users can run `bun install`. The root `trustedDependencies` list allows the known install scripts for `core-js`, `@google/genai`, and `protobufjs`.

### Update

To update an existing source checkout to the latest version, pull the changes, reinstall dependencies (in case `package.json` changed), and rebuild:

```bash
cd /path/to/GeoLibre   # your GeoLibre checkout
git pull origin main
npm install            # or: bun install
```

If you run a production build, rebuild afterwards with `npm run build` (web) or `npm run tauri:build` (desktop). If you work from the dev servers (`npm run dev` or `npm run tauri:dev`), the `git pull` and `npm install` above are enough — just restart the dev server to pick up the changes.

### Run the browser UI

```bash
npm run dev
```

Open `http://localhost:5173`. The map and browser vector import support local vector files that DuckDB-WASM Spatial can read, with direct handling for GeoJSON, zipped Shapefiles, and KMZ archives. Use Add Vector Layer or drag files onto the app; GeoTIFF/COG rasters can also be dragged onto the map to add them as raster layers. The browser UI can also add URL-based services and datasets such as XYZ, WMS, GeoJSON URLs, vector tiles, COG rasters, ArcGIS services, FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats.

Desktop filesystem dialogs, local MBTiles, local raster file reads, project save/open, and other filesystem operations require Tauri.

### Run with Docker

!!! tip "Private deployments"
    If you are deploying GeoLibre so a team can work with data that must stay on
    your own infrastructure, read
    [Self-Hosting & Private Data](self-hosting.md) alongside this section: it
    covers hosting the data (with [GeoLens](https://getgeolens.com)), putting
    both behind one sign-on layer, and why serving them from the same origin
    removes the CORS and cookie problems.

The repository includes a Dockerfile for the browser version of GeoLibre. It builds the Vite app and serves the production files with nginx:

```bash
docker build -t geolibre .
docker run --rm -p 8080:80 geolibre
```

Open `http://localhost:8080`. The containerized browser UI supports web-capable workflows, but desktop filesystem dialogs, local MBTiles, local raster file reads, project save/open, and other Tauri-only features require the desktop app.

The published image is available from GitHub Container Registry:

```bash
docker pull ghcr.io/opengeos/geolibre:latest
docker run --rm -p 8080:80 ghcr.io/opengeos/geolibre:latest
```

#### Bundled conversion sidecar

The image also bundles the Python sidecar (uvicorn) and reverse-proxies it at
`/sidecar`, so the browser reaches it same-origin with no CORS or separate
process to manage. `/conversion/status` is reachable at
`http://localhost:8080/sidecar/conversion/status`.

The browser build does **not** need the sidecar for the **Conversion** tools or
the **Whitebox** toolbox — both run client-side on DuckDB-WASM and
`geolibre-wasm`. What the bundled sidecar adds is:

- **Raster tools** (rasterio), which have a client-side fallback for the core
  tools but reach the full set through the sidecar.
- The optional **GeoPandas engine** for the Vector tools, which otherwise run
  client-side on Turf.js or Pyodide.

Sidecar jobs read and write **paths on the sidecar's own filesystem** — a
browser cannot hand the container an absolute host path — and those reads and
writes are confined to `GEOLIBRE_CONVERSION_ROOTS` (default `/data` in the
image). Mount your files there:

```bash
docker run --rm -p 8080:80 -v "$PWD/data:/data" ghcr.io/opengeos/geolibre:latest
```

The sidecar's PostGIS endpoints are gated the same way: they refuse every
destination until `GEOLIBRE_POSTGIS_HOSTS` lists the allowed databases, so that
a caller reaching the image cannot aim them at hosts only the container can
reach. Pass `-e GEOLIBRE_POSTGIS_HOSTS='db.internal:5432'` (or `*` to accept any
connection string) to enable them. The desktop app is not affected: its sidecar
is loopback-bound and started for a single user, so it defaults to unrestricted.

`freestiler` and `whitebox-workflows` publish no linux/arm64 wheels, so they are
installed on **amd64 only**; on arm64 the sidecar reports those tools
unavailable. This does not affect the browser's own PMTiles and Whitebox
engines, which are WebAssembly and run on any architecture.

Set `GEOLIBRE_DISABLE_SIDECAR=1` to run nginx only (web-only behavior):

```bash
docker run --rm -p 8080:80 -e GEOLIBRE_DISABLE_SIDECAR=1 ghcr.io/opengeos/geolibre:latest
```

#### Password protection (optional)

To require a username and password, set `GEOLIBRE_AUTH_USER` and
`GEOLIBRE_AUTH_PASSWORD`; nginx then protects the app and the `/sidecar` API
with HTTP Basic Auth (a single shared credential). Pair it with a
TLS-terminating reverse proxy outside trusted networks:

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_AUTH_USER=admin \
  -e GEOLIBRE_AUTH_PASSWORD='change-me' \
  ghcr.io/opengeos/geolibre:latest
```

To let authenticated users access the managed AI proxy without exposing its
server token, route AI requests through the same nginx instance:

```bash
export GEOLIBRE_AI_PROXY_TOKEN="$(openssl rand -hex 32)"
cd workers/ai-proxy
printf '%s' "$GEOLIBRE_AI_PROXY_TOKEN" |
  npx wrangler secret put GEOLIBRE_AI_PROXY_TOKEN
cd ../..

docker run --rm -p 8080:80 \
  -e GEOLIBRE_AUTH_USER=admin \
  -e GEOLIBRE_AUTH_PASSWORD='change-me' \
  -e GEOLIBRE_AI_URL=/ai \
  -e GEOLIBRE_AI_MODEL=openai/gpt-5.6-luna \
  -e GEOLIBRE_AI_PROXY_URL=https://ai.geolibre.app \
  -e GEOLIBRE_AI_PROXY_TOKEN="$GEOLIBRE_AI_PROXY_TOKEN" \
  ghcr.io/opengeos/geolibre:latest
```

The proxy token must match the `GEOLIBRE_AI_PROXY_TOKEN` Worker secret. nginx
injects it server-side and it never appears in frontend configuration. Direct
inference calls to `ai.geolibre.app` without the token return `401`. If
`GEOLIBRE_AI_URL` is unset, the image leaves the managed proxy disabled. Use
HTTPS and prefer an `--env-file` or secrets manager.

The NASA OPERA disaster workflow also uses this same `/ai` route for Tavily
news searches. Store `TAVILY_API_KEY` as a secret on the `geolibre-ai-proxy`
Worker, not in the Docker container. If you run a separate compatible news
Worker, set its public URL with
`GEOLIBRE_NASA_OPERA_NEWS_PROXY_ENDPOINT=https://news.example.org`.

Enabling the proxy does not by itself restrict who may use it: whoever can
reach `/ai` on the container spends against your Cloudflare account. Set
`GEOLIBRE_AUTH_USER`/`GEOLIBRE_AUTH_PASSWORD` as above, or put your own
authentication in front, before exposing an AI-enabled instance. If a TLS proxy
fronts the container, list its address in `GEOLIBRE_TRUSTED_PROXIES` (a
comma-separated list of IPs or CIDRs) so per-client rate limiting sees the real
client rather than counting every user as the proxy.

The browser prompts for the credentials on first visit. `/healthz` stays
unauthenticated so the container health check keeps working. When the variables
are unset (the default), no authentication is applied.

As with any Docker env var, a password passed with `-e` lands in your shell
history and is readable on the host via `docker inspect`. Beyond quick local
testing, prefer `--env-file` with a permission-restricted file, or a secrets
manager.

Basic Auth is a single shared credential, not per-user accounts, and sends
credentials with every request. For multi-user or SSO needs, put an auth proxy
such as `oauth2-proxy` or Authelia in front of the unmodified image instead (see
[Self-Hosting & Private Data](self-hosting.md#putting-both-behind-one-auth-layer)
for a worked example that also covers the data behind it).
Also see the note in
[`docker/nginx.conf`](https://github.com/opengeos/GeoLibre/blob/main/docker/nginx.conf)
about dropping the `localhost` CSP allowances before exposing the image
publicly.

#### Clerk sign-in gate (optional)

For individual user accounts instead of one shared password, configure a Clerk
application for the deployment domain and pass its publishable key. (If you
already use Auth0, skip to [the Auth0 gate](#auth0-sign-in-gate-optional) —
it is the same feature with a different provider, and you configure one or the
other, never both.)

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_CLERK_PUBLISHABLE_KEY='pk_live_...' \
  ghcr.io/opengeos/geolibre:latest
```

Clerk is not loaded and GeoLibre behaves exactly as before when neither this
variable nor the build-time `VITE_GEOLIBRE_CLERK_PUBLISHABLE_KEY` is set; the
runtime variable wins when both are.
The gate applies only to the hosted web application; the separately built
Tauri, mobile, and embedded/Jupyter builds remain available offline. It is a
property of the build, not of the request, so framing the gated deployment or
loading it with `?embed=1` still requires sign-in. Control who may register or
sign in through the Clerk Dashboard. Configure TLS and the deployment domain in
Clerk before using a production key.

##### Approving users

Who may sign in is decided in the Clerk Dashboard, not by GeoLibre:

- **Restrictions → Restricted** turns off self-service sign-up. You add people
  by invitation, through an enterprise connection, or by creating the user
  manually. This needs no extra configuration here.
- **Waitlist** lets visitors request access, which you approve one at a time
  (**Waitlist** page → the menu next to a person → **Invite**, or **Revoke** to
  decline). Enable the matching screen in GeoLibre so the sign-in card offers a
  "Join the waitlist" link instead of a dead end:

  ```bash
  docker run --rm -p 8080:80 \
    -e GEOLIBRE_CLERK_PUBLISHABLE_KEY='pk_live_...' \
    -e GEOLIBRE_CLERK_WAITLIST=1 \
    ghcr.io/opengeos/geolibre:latest
  ```

  The waitlist form lives at the `#/waitlist` fragment of the same page, so
  moving between it and the sign-in card never reloads the app. It is off
  unless you set this variable, because on a restricted instance the form would
  collect requests that cannot be approved. Set the Clerk instance's sign-up
  mode to **Waitlist** as well — the variable adds the screen, the Dashboard
  decides whether Clerk accepts submissions to it. Setting it without
  `GEOLIBRE_CLERK_PUBLISHABLE_KEY` is an error rather than a silently public
  app.

This client-side gate controls access to the GeoLibre interface but is not a
server authorization boundary by itself. Keep `/sidecar`, `/ai`, and any other
sensitive upstream service behind nginx authentication, Cloudflare Access, or a
backend that verifies Clerk session tokens on every request. Use the existing
`GEOLIBRE_AUTH_USER` and `GEOLIBRE_AUTH_PASSWORD` variables as well when the
whole container must be protected before its assets are served.

#### Auth0 sign-in gate (optional)

The same whole-app sign-in gate, for deployments that already use Auth0. Create
a **Single Page Application** in the Auth0 Dashboard and pass its domain and
client ID — both are public values, and an Auth0 client *secret* is neither
needed nor accepted here:

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_AUTH0_DOMAIN='example.us.auth0.com' \
  -e GEOLIBRE_AUTH0_CLIENT_ID='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
  ghcr.io/opengeos/geolibre:latest
```

Both variables are required together, and configuring Auth0 *and* Clerk at once
is refused at startup rather than resolved silently — pick one provider. As with
Clerk, neither SDK is loaded when nothing is configured, the gate applies only
to the hosted web application (the Tauri, mobile, and embedded/Jupyter builds
are compiled without it), and it is a property of the build rather than the
request, so `?embed=1` cannot switch it off. The build-time equivalents are
`VITE_GEOLIBRE_AUTH0_DOMAIN` and `VITE_GEOLIBRE_AUTH0_CLIENT_ID`; the runtime
variables win when both are present.

In the Auth0 application's settings, these three fields do not take the same
value:

- **Allowed Callback URLs** and **Allowed Logout URLs** take the deployment URL
  **with its trailing slash** — `https://gis.example.com/`, or
  `https://gis.example.com/geolibre/` for a [subpath
  deployment](#subpath-and-onboarding-build-arguments). Auth0 matches these
  exactly, and a missing entry surfaces as a callback error instead of a login.
- **Allowed Web Origins** takes the **origin only** — no trailing slash and no
  path, so `https://gis.example.com` even for a subpath deployment. A path here
  is not matched and breaks the silent-authentication request that restores an
  existing session.

Auth0 has no embedded sign-in card, so GeoLibre uses **Universal Login**: the
visitor clicks *Sign in*, is redirected to your tenant's hosted login page, and
is returned to the app. The URL they arrived on is carried through the round
trip, so a shared `?project=…` link still opens its project after signing in.

##### Approving users

Who may sign in is decided in the Auth0 Dashboard, not by GeoLibre:

- **Authentication → Database → Sign Ups** — turning off self-service sign-up
  makes the deployment invite-only; you then add people from **User Management
  → Users** or through an enterprise connection.
- **Actions** — a post-login Action that calls `api.access.deny()` for anyone
  outside your organization or role. GeoLibre shows the denial on its own error
  screen with a way to try another account, rather than a blank page.

There is no equivalent of Clerk's waitlist form, so `GEOLIBRE_CLERK_WAITLIST`
has no Auth0 counterpart.

The session is cached in the browser's local storage so a page reload does not
bounce through the login page again. Two things follow from that, worth knowing
before you enable the gate. Nothing here requests an API audience, so what is
cached is an identity assertion that grants no access to any upstream service by
itself, and no refresh token is stored — once it expires, renewal goes back
through a silent request to your tenant, which succeeds only while the Auth0
session cookie is available to answer it (a browser blocking that cookie sends
the visitor to the login page instead). But the cached entry does outlive the
tab, and GeoLibre runs plugins on the same origin as the app — a plugin you
install can read it, as it could any other same-origin storage. Install plugins
you trust, and keep the server-side protections below in place regardless.

Like the Clerk gate, this controls access to the GeoLibre interface but is not a
server authorization boundary. Keep `/sidecar`, `/ai`, and any other sensitive
upstream service behind nginx authentication, Cloudflare Access, or a backend
that verifies Auth0 tokens on every request, and use `GEOLIBRE_AUTH_USER` /
`GEOLIBRE_AUTH_PASSWORD` as well when the whole container must be protected
before its assets are served.

#### Subpath and onboarding build arguments

For deployments under a URL subpath, pass the app base at build time:

```bash
docker build --build-arg GEOLIBRE_APP_BASE=/geolibre/ -t geolibre .
```

The container always serves the app from its root path. The build argument only sets the URL prefix that the app expects, so subpath deployments also require a reverse proxy in front of the container that strips the prefix before forwarding requests (for example, nginx `proxy_pass http://geolibre/;` with a trailing slash).

To skip the first-launch welcome wizard for every visitor (kiosk or embedded
deployments), bake `VITE_WELCOME_DISABLED=1` into the build:

```bash
docker build --build-arg VITE_WELCOME_DISABLED=1 -t geolibre .
```

Individual links can also opt out at runtime with `?welcome=0`. See
[Embedding & Sharing](user-guide/embedding.md#url-parameters).

#### Driving an embedded map from a host page

To let a page that frames the app talk to the live map over `postMessage` (fly to
a record, highlight a feature, open a processing tool, and receive selection,
view, and tool events), list the origins you trust:

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_EMBED_ORIGINS="https://portal.example.com" \
  ghcr.io/opengeos/geolibre:latest
```

Unset (the default) the API stays off, so a public deployment can never be driven
by whoever frames it. See
[Talking to the map at runtime](user-guide/embedding.md#talking-to-the-map-at-runtime)
for the message reference and a host-page example.

#### Self-hosted sharing and collaboration servers

Project **Share** and the **Project Gallery** talk to `share.geolibre.app` by
default. Point them at your own server instead, or turn the feature off:

```bash
docker run --rm -p 8080:80 \
  -e GEOLIBRE_SHARE_URL=https://maps.example.org \
  -e GEOLIBRE_COLLAB_URL=wss://collab.example.org \
  ghcr.io/opengeos/geolibre:latest
```

| Variable | Effect |
| --- | --- |
| `GEOLIBRE_SHARE_URL` | Base URL of the project sharing server. Unset uses `share.geolibre.app`. Set it to `off` to remove Share and the Project Gallery from the UI entirely. |
| `GEOLIBRE_COLLAB_URL` | Base URL of the [collaboration](collaboration.md) relay. Unset leaves live collaboration disabled. |

Both are read at container startup, so a prebuilt image can be repointed by
restarting it with different values — no rebuild. (The equivalent build
arguments, `VITE_GEOLIBRE_SHARE_URL` and `VITE_GEOLIBRE_COLLAB_URL`, exist for
baking a default into your own image.)

When `GEOLIBRE_COLLAB_URL` is set, the entrypoint also adds that relay's origin to
the container's `Content-Security-Policy` `connect-src`, so the browser is allowed
to open the WebSocket. (The directive has a bare `https:`, which covers any share
server, but no bare `wss:`.) No manual edit of `docker/nginx.conf` is needed.

Both must use TLS — `https://` for the share server, `wss://` for the relay —
because the app sends your API token to the share server with every request.
Plaintext is accepted only on `localhost` / `127.0.0.1` for local development, so
put a self-hosted server behind a reverse proxy that terminates TLS. A value that
does not satisfy this **fails the container boot** with an error naming the
variable, rather than starting up and quietly using the public hosted service
with your users' projects.

GeoLibre includes reference implementations of both services. From the
repository root, start the web app, projects server, Node collaboration relay,
and Postgres together:

```bash
POSTGRES_PASSWORD=choose-a-password docker compose up --build
```

`POSTGRES_PASSWORD` is required, not defaulted: that account owns all project
metadata, and a password committed to this repository would be identical on
every deployment. Compose stops with an error naming the variable if it is
unset. Set it in your shell, an `.env` file next to `docker-compose.yml`, or
your orchestrator's secret store.

Postgres only applies this password when it initializes its data directory, so
changing it later does **not** change the password on an existing volume: the
projects server then fails authentication against a database that still expects
the old one. To rotate it, either `ALTER USER` inside the running database or
recreate the volume.

Open `http://localhost:8080`. The projects API is exposed at
`http://localhost:8000` and the relay at `ws://localhost:8787`; the web
container's runtime configuration is populated with those browser-reachable
URLs. For a real deployment, set `GEOLIBRE_SHARE_URL`,
`GEOLIBRE_COLLAB_URL`, `GEOLIBRE_VIEWER_URL`, and
`GEOLIBRE_CORS_ORIGINS` to the public TLS origins before starting Compose.

Behind a reverse proxy, only the web container should be reachable from outside
the host. The Compose file publishes the projects server on `8000` and the relay
on `8787` for local use, and pointing the browser URLs at your proxy does not
stop anyone connecting to those listeners directly. Bind them to loopback (or
drop the mappings entirely and let the proxy reach them over the Compose
network) with an override file:

```yaml
# docker-compose.override.yml
services:
  geolibre-server:
    ports: ["127.0.0.1:8000:8000"]
  geolibre-collab:
    ports: ["127.0.0.1:8787:8787"]
```

The password is substituted into a connection URL verbatim, so two characters
need care:

- `@` splits the URL early. `p@ssw0rd` is read as password `p` against host
  `ssw0rd@postgres`, and the projects server restarts in a loop on a psycopg
  error that never mentions the password.
- `%` starts a percent-escape. `we%20ird` is silently decoded to `we ird`, so
  the server authenticates with a password you never set and simply gets
  rejected.

Either avoid both characters or percent-encode the value in the URL (`%40` for
`@`, `%25` for `%`) while leaving `POSTGRES_PASSWORD` itself as the literal
password Postgres should expect.

The projects API can also run as one small SQLite-backed container, without
Postgres:

```bash
docker build -t geolibre-server backend/geolibre_server_api
docker run --rm -p 8000:8000 \
  -v geolibre-server-data:/data \
  -e GEOLIBRE_PUBLIC_URL=http://localhost:8000 \
  -e GEOLIBRE_VIEWER_URL=http://localhost:8080 \
  geolibre-server
```

Its Docker image defaults to a SQLite database and filesystem objects under
`/data`. See the complete [server API contract](server-api.md) and the
service's
[`README`](https://github.com/opengeos/GeoLibre/tree/main/backend/geolibre_server_api)
for Postgres and S3-compatible storage configuration.

### Run the desktop app

```bash
npm run tauri:dev
```

### Build

```bash
npm run build
npm run tauri:build
```

The default desktop build keeps the Linux binary small and uses DuckDB-WASM for
DuckDB-backed browser features. To build a larger desktop binary with the native
`duckdb-rs` vector loader enabled, run:

```bash
npm run tauri:build:native-duckdb
```

Where to find the output:

- **Web build** — static files in `apps/geolibre-desktop/dist/`. Serve this directory with any static web server (or the Docker image above).
- **Desktop installers** — `apps/geolibre-desktop/src-tauri/target/release/bundle/`, with per-platform subfolders: `deb/`, `rpm/`, and `appimage/` on Linux; `msi/` and `nsis/` on Windows; `dmg/` and `macos/` on macOS. The unbundled executable is in `apps/geolibre-desktop/src-tauri/target/release/`. On Linux, `npm run tauri:build` builds `deb` and `rpm` by default; passing `--bundles` replaces that default selection rather than adding to it, so list every format you want, for example `npm run tauri:build -- --bundles deb,rpm,appimage` for all three.

### Build-time flags

| Variable | Default | Effect |
| --- | --- | --- |
| `GEOLIBRE_PGLITE_CDN` | `1` (CDN) | Set `0` to bundle PGlite/PostGIS into the build (~22 MB) instead of loading from jsDelivr. |
| `GEOLIBRE_CEREUS_CDN` | `1` (CDN) | Set `0` to bundle CereusDB WASM (~40 MB) instead of loading from jsDelivr. |
| `GEOLIBRE_GDAL_CDN` | `1` (CDN) | Set `0` to disable GDAL export (the ~40 MB WASM/data are not bundled, just unavailable). |
| `GEOLIBRE_DUCKDB_WASM_CDN` | `0` (bundled) | Set `1` to move DuckDB-WASM to jsDelivr (required for Cloudflare Pages' 25 MiB per-file limit). |
| `GEOLIBRE_NO_EXTERNAL_CDN` | unset | Set `1` to strip **all GeoLibre-controlled** external CDN references from the build. Forces all `*_CDN=0` flags (so PGlite, CereusDB and DuckDB-WASM are bundled rather than fetched) and disables features that embed CDN URLs (storymap HTML export, built-in detection models, ONNX WASM, 3D Tiles decoders, GDAL export). Pyodide is not hard-disabled: the flag drops only its default index URL, so point `VITE_PYODIDE_INDEX_URL` at an approved mirror to keep it working. Some third-party packages keep their own internal CDN URLs, which this flag cannot remove — see [architecture.md](architecture.md). Mutually exclusive with `npm run lite:build` (and so with Cloudflare Pages/Workers hosting), which needs `GEOLIBRE_DUCKDB_WASM_CDN=1` to stay under the 25 MiB per-file cap; the build rejects that combination outright. Intended for enterprise deployments that cannot reference untrusted CDNs. |
| `GEOLIBRE_STORE_BUILD` | unset | Set `1` for Microsoft Store MSIX builds (removes in-app updater). |
| `GEOLIBRE_MAS_BUILD` | unset | Set `1` for Mac App Store builds (removes sidecar/server features). |
| `GEOLIBRE_EMBED` | unset | Set `1` for the Jupyter embed wheel build. |

Example — build with no external CDN dependencies:

```bash
GEOLIBRE_NO_EXTERNAL_CDN=1 npx vite build
```

## Optional imagery credentials

The Street View plugin can use Google Street View and Mapillary imagery. The 3D Tiles panel can also load Google Photorealistic 3D Tiles with the same Google Maps key. Create `apps/geolibre-desktop/.env.local` and set one or both provider credentials:

```env
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
VITE_MAPILLARY_ACCESS_TOKEN=your_mapillary_access_token
```

For Google Street View, enable the Maps Embed API for the key in Google Cloud. For Google Photorealistic 3D Tiles, enable the Map Tiles API. For local shell testing, `GOOGLE_MAPS_API_KEY` is also accepted by the desktop Vite build. For Mapillary, create an app in the Mapillary developer dashboard and use its client access token.

Restart `npm run dev` or `npm run tauri:dev` after changing environment variables.

## Optional basemap credentials

The **New map** dialog offers [Protomaps](https://protomaps.com) basemaps (Light, Dark, White, Grayscale, Black) when a Protomaps API key is configured. Without a key these options are hidden, and you can still use the OpenFreeMap basemaps or a custom style URL.

Use your own key — create one in the [Protomaps dashboard](https://protomaps.com). Set it one of two ways:

- **For your own deployment** — bake it into the build with the `VITE_PROTOMAPS_API_KEY` environment variable, for example in `apps/geolibre-desktop/.env.local`:

  ```env
  VITE_PROTOMAPS_API_KEY=your_protomaps_api_key
  ```

  In CI/CD, pass it as a build-time environment variable (the GitHub Pages workflow reads it from the `VITE_PROTOMAPS_API_KEY` repository secret). The resulting style URL is `https://api.protomaps.com/styles/v5/<flavor>/en.json?key=<your_key>`.

- **At runtime, no rebuild** — add an environment variable named `VITE_PROTOMAPS_API_KEY` in **Settings → Environment Variables**. The Protomaps basemaps appear as soon as the key is enabled. See [Settings](user-guide/settings.md#environment-variables).

## Optional traffic overlays

The **Basemaps** control includes a **Traffic** category with real-time traffic overlays that stack on top of any basemap (enable the panel's add/multiple toggle). Each provider authenticates with your own API key, set in **Settings → Environment Variables** (or baked into `apps/geolibre-desktop/.env.local`):

```env
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key   # Google Traffic (Map Tiles API)
VITE_TOMTOM_API_KEY=your_tomtom_api_key             # TomTom Traffic Flow
VITE_HERE_API_KEY=your_here_api_key                 # HERE Traffic Flow
```

Google Traffic and Google Photorealistic 3D Tiles reuse the same `VITE_GOOGLE_MAPS_API_KEY` as Street View; enable the **Map Tiles API** for that key in Google Cloud. A newly entered key takes effect immediately, without reopening the project. Until a provider's key is set, its overlay reports a missing-key error instead of loading tiles.

## Optional Amazon Location styles

The **Amazon Location** entries in the Basemaps control are *style basemaps* (they replace the whole map style, unlike the traffic overlays above). They authenticate with your own Amazon Location API key, set in **Settings → Environment Variables** (or baked into `apps/geolibre-desktop/.env.local`):

```env
VITE_AMAZON_LOCATION_API_KEY=your_amazon_location_api_key   # Amazon Location styles
VITE_AMAZON_LOCATION_AWS_REGION=us-east-1                   # optional; omit to use the control's built-in default region
```

## Optional Protomaps and Stadia Maps basemaps

The Basemaps control also carries **Protomaps** and **Stadia Maps** (including Stadia x Stamen) style basemaps. Both authenticate with your own key:

```env
VITE_PROTOMAPS_API_KEY=your_protomaps_api_key   # same key as the New map dialog's Protomaps basemaps
VITE_STADIA_API_KEY=your_stadia_api_key         # https://client.stadiamaps.com
```

Protomaps reuses the key described in [Optional basemap credentials](#optional-basemap-credentials) above — set it once and both places pick it up. Until each key is set, the panel shows a "Get a … API key" prompt in place of the basemap rather than loading tiles.

## Basemaps in mainland China

GeoLibre's default basemaps (OpenFreeMap, Protomaps) are hosted outside mainland China with no presence inside it, so from there they range from slow to unreachable, as does most of the Basemaps control's catalog. Two places offer basemaps served from inside China.

### The Regional section (no key)

**New project** and **Change basemap** both carry a collapsed **Regional → China (中国)** section with five keyless basemaps: 高德地图, 高德卫星, 高德混合 (Amap street, satellite, and satellite-with-labels) and 腾讯地图, 腾讯深色 (Tencent street and dark). Pick one and it applies like any other basemap. Nothing to configure.

### The Basemaps control (adds Tianditu)

The Basemaps control plugin carries the same Amap and Tencent tiles plus **Tianditu (天地图)**, China's official National Platform for Common Geospatial Information Services: vector, imagery, and terrain, each with a separate label overlay. Search the panel for `Tianditu`, `Amap`, or `Tencent`, or for their Chinese names.

Tianditu needs a free key from [console.tianditu.gov.cn](https://console.tianditu.gov.cn/api/key). Set it in **Settings → Environment Variables** (or type it into the panel's **API keys** view):

```env
VITE_TIANDITU_API_KEY=your_tianditu_api_key   # https://console.tianditu.gov.cn/api/key
```

Tianditu ships each basemap and its labels as separate layers. Turn on **Add basemaps (stack instead of replace)** in the panel to lay a label overlay over its base.

### Which to pick

| Provider | Datum | Key | Where |
|----------|-------|-----|-------|
| Tianditu (天地图) | CGCS2000 | required | Basemaps control |
| Amap (高德地图) | GCJ-02 | none | Regional section, Basemaps control |
| Tencent Maps (腾讯地图) | GCJ-02 | none | Regional section, Basemaps control |

**Prefer Tianditu whenever the map also carries your own data.** Chinese law requires public map services to publish in GCJ-02, an offset datum that displaces features by roughly 100 to 700 m from WGS84; nothing in GeoLibre or MapLibre applies the shift, so your layers will visibly misalign over Amap or Tencent. Tianditu publishes in CGCS2000, which is close enough to WGS84 that ordinary data lines up.

The Amap and Tencent tile endpoints are not documented public APIs. They are fine for exploration, but obtain a commercial key from the provider before building a product on either.

Keys set via **Settings → Environment Variables**, or typed directly into the panel's **API keys** view (the key button in the panel header), apply at runtime without reopening the project. A key baked into `apps/geolibre-desktop/.env.local` is read at build time and needs a dev server restart. When `VITE_AMAZON_LOCATION_API_KEY` is set in the environment it takes precedence over a key typed in the panel; removing it from the environment clears it on the next page reload.

## Optional 3D globe credentials (Cesium Ion)

The optional **Cesium 3D-globe view** — a split-pane globe rendered with [CesiumJS](https://cesium.com/platform/cesiumjs/) alongside the 2D MapLibre map — needs a [Cesium Ion](https://ion.cesium.com/) access token for its world imagery and terrain. Create a free Ion account, copy your default access token, and set it at build time:

```env
CESIUM_TOKEN=your_cesium_ion_access_token
```

`CESIUM_TOKEN` (or the `VITE_`-prefixed `VITE_CESIUM_TOKEN`) is read by `vite.config.ts` and baked into the build. You can **also set it at runtime** — with no rebuild — in the Settings dialog's **Environment Variables** section, which has a dedicated masked **Cesium Ion token** field. That token is stored locally on the device (in browser storage on the web build), **not** in the shared project file, and overrides the build-time value; it is how a web user brings their own Ion token. (A free-form `VITE_CESIUM_TOKEN` variable in the same section still works and takes precedence, as an override.) Without a token from any source, the 3D-globe toggle is hidden entirely (the 2D map is unaffected). Ion access tokens are designed to ship in client bundles. See [Architecture](architecture.md#3d-globe-view-cesiumjs) for how the globe integrates.

## Optional runtime mirrors (offline and air-gapped)

The **Python (Pyodide)** vector engine loads its runtime from the public jsDelivr CDN by default. To self-host it for offline or production use, point it at a mirrored copy of the Pyodide distribution:

```env
VITE_PYODIDE_INDEX_URL=https://your-host/pyodide/v0.27.7/full/
```

Similarly, the DuckDB Spatial extension is installed from DuckDB's remote extension repository by default. To load it from a mirror instead (so `INSTALL spatial` is skipped and the extension is loaded directly), set the full path or URL to the extension file:

```env
VITE_DUCKDB_SPATIAL_EXTENSION_PATH=https://your-host/duckdb/spatial.duckdb_extension.wasm
```

Both variables can also be set at runtime through the Settings dialog's environment variables (no rebuild required), so air-gapped or corporate deployments can point Pyodide and the DuckDB Spatial extension at internal mirrors without rebuilding.

## Optional Python sidecar

The optional FastAPI sidecar is reserved for heavier processing workflows and is not required for the desktop UI.

```bash
cd backend/geolibre_server
python -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
```

The sidecar self-bootstraps a managed runtime on first use; set
`GEOLIBRE_CONVERSION_PYTHON=$(which python)` to reuse the current environment
instead. See the
[sidecar README](https://github.com/opengeos/GeoLibre/blob/main/backend/geolibre_server/README.md)
for details.

### Optional extras

The base install is deliberately small. Each group of tools has its own extra;
install only the ones you need, then run `geolibre-server` (or the `uvicorn`
command above). These continue from `backend/geolibre_server`, the directory the
snippet above changes into:

```bash
# Conversion tools (DuckDB, rio-cogeo, freestiler)
pip install -e ".[conversion]"

# Vector tools — GeoPandas engine (GeoPandas, Shapely)
pip install -e ".[vector]"

# Raster tools (rasterio, numpy, contourpy)
pip install -e ".[raster]"

# AI Segmentation proxy (an HTTP client only; models live in samgeo-api)
pip install -e ".[ml]"
```

From the repository root instead, use the full path — for example
`pip install -e "backend/geolibre_server[conversion]"`.

To use the sidecar from the **web** build, start it and serve the app from
`localhost:5173` — CORS is restricted to that origin and the Tauri origins.
Where a tool has a browser engine (all Vector tools, and the GeoParquet/CSV
conversions), the dialog falls back to it automatically when the sidecar or its
extra is unavailable. See [Processing Tools](user-guide/processing.md) for what
each engine does, and [AI Segmentation](user-guide/segmentation.md) for the
separate `samgeo-api` model server.
