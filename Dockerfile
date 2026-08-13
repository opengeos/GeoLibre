# Run the build stage on the builder's native platform: the output is
# arch-independent static files, so emulating arm64 with QEMU here only
# slows down multi-arch builds without changing the result.
# ($BUILDPLATFORM is a Docker-provided automatic ARG, set by BuildKit.)
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build

# Debian rather than Alpine because this stage now also runs the JupyterLite
# build, whose Python dependency tree (jupyterlab, notebook, jupyterlite-core)
# resolves to prebuilt manylinux wheels here instead of compiling against musl.
# Only apps/geolibre-desktop/dist is copied into the runtime image, so the larger
# builder costs nothing in the shipped image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

# A venv keeps pip off the Debian-managed interpreter, which refuses installs
# under PEP 668.
ENV VIRTUAL_ENV=/opt/jupyterlite
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /app

# Copy every workspace member's package.json before npm ci so the install
# layer is cached. Adding a new package under apps/ or packages/ requires
# adding its package.json here, or npm ci fails with a missing workspace.
COPY package.json package-lock.json ./
COPY apps/geolibre-desktop/package.json apps/geolibre-desktop/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/collab-core/package.json packages/collab-core/package.json
COPY packages/map/package.json packages/map/package.json
COPY packages/plugins/package.json packages/plugins/package.json
COPY packages/processing/package.json packages/processing/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY scripts/patch-maplibre-read-buffer.mjs scripts/patch-maplibre-read-buffer.mjs

RUN npm ci

# Its own layer, keyed only on the requirements file, so touching app source does
# not reinstall the Python tree.
COPY apps/geolibre-desktop/jupyterlite/requirements.txt apps/geolibre-desktop/jupyterlite/requirements.txt
RUN pip install --no-cache-dir -r apps/geolibre-desktop/jupyterlite/requirements.txt

COPY . .

ARG GEOLIBRE_APP_BASE=/
ARG VITE_GEE_OAUTH_CLIENT_ID=
ARG VITE_MAPILLARY_ACCESS_TOKEN=
# Set to 1 (or true) to disable the first-launch welcome wizard for the whole
# deployment; visitors land straight on the map.
ARG VITE_WELCOME_DISABLED=
# Comma-separated origins allowed to drive a framed app over the embed
# postMessage API. Usually set at RUN time instead (-e GEOLIBRE_EMBED_ORIGINS=…),
# which the entrypoint writes into the runtime config without a rebuild.
ARG VITE_GEOLIBRE_EMBED_ORIGINS=
# Self-hosted project sharing server (https://…, or "off" to remove Share and the
# Project Gallery). Unset uses the public hosted service. Like the embed origins,
# normally set at RUN time instead (-e GEOLIBRE_SHARE_URL=…) so a prebuilt image
# can be repointed without a rebuild.
ARG VITE_GEOLIBRE_SHARE_URL=
# Self-hosted collaboration relay (wss://…). Unset leaves collaboration dark.
# Also settable at RUN time (-e GEOLIBRE_COLLAB_URL=…).
ARG VITE_GEOLIBRE_COLLAB_URL=
ENV GEOLIBRE_APP_BASE=${GEOLIBRE_APP_BASE}
ENV VITE_GEE_OAUTH_CLIENT_ID=${VITE_GEE_OAUTH_CLIENT_ID}
ENV VITE_MAPILLARY_ACCESS_TOKEN=${VITE_MAPILLARY_ACCESS_TOKEN}
ENV VITE_WELCOME_DISABLED=${VITE_WELCOME_DISABLED}
ENV VITE_GEOLIBRE_EMBED_ORIGINS=${VITE_GEOLIBRE_EMBED_ORIGINS}
ENV VITE_GEOLIBRE_SHARE_URL=${VITE_GEOLIBRE_SHARE_URL}
ENV VITE_GEOLIBRE_COLLAB_URL=${VITE_GEOLIBRE_COLLAB_URL}

# The `prebuild` hook of apps/geolibre-desktop runs scripts/build-jupyterlite.mjs,
# which generates the site the Notebook panel embeds. That script is best-effort
# by default: without the `jupyter lite` CLI it warns and exits 0, and the build
# still succeeds. nginx then answers the panel's iframe URL with index.html
# through its SPA fallback, so the panel renders a second copy of GeoLibre
# instead of a notebook, which is how this image shipped for so long
# (GeoLibre#1851). Make the absence fatal here rather than silent.
ENV GEOLIBRE_JUPYTERLITE_REQUIRED=1

RUN npm run build

# The site is generated, not committed (public/jupyterlite/ is git-ignored), so
# assert it reached the output rather than trusting the step above.
RUN test -f apps/geolibre-desktop/dist/jupyterlite/lab/index.html \
  || (echo "ERROR: dist/jupyterlite is missing; the Notebook panel would render a second copy of the app." && exit 1)

# Runtime image bundles the static web app (served by nginx) and the optional
# Python conversion/Whitebox sidecar (uvicorn), reverse-proxied at /sidecar.
# A glibc base (not alpine/musl) is required for the prebuilt geo wheels
# (duckdb, rasterio/rio-cogeo, freestiler, whitebox-workflows).
FROM python:3.12-slim-bookworm AS runtime

# TARGETARCH is provided by BuildKit (amd64 / arm64).
ARG TARGETARCH

# libexpat1 is a runtime dependency of rasterio (pulled in by rio-cogeo) that
# the slim base image does not ship. openssl provides `openssl passwd` used by
# entrypoint.sh to hash the optional Basic Auth password.
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx libexpat1 openssl \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default

# Install the sidecar package plus the core conversion stack. duckdb and
# rio-cogeo (rasterio) publish linux/arm64 wheels, so Vector->GeoParquet,
# CSV->GeoParquet and Raster->COG work on both architectures.
COPY backend/geolibre_server /opt/geolibre_server
RUN pip install --no-cache-dir /opt/geolibre_server \
  && pip install --no-cache-dir "duckdb>=1.1.0" "rio-cogeo>=5.0.0"

# freestiler (PMTiles) and whitebox-workflows publish no linux/arm64 wheels, so
# they are installed on amd64 only. On arm64 those tools report unavailable
# while the other conversions keep working.
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      pip install --no-cache-dir "freestiler>=0.1.0" "whitebox-workflows>=2.0.2"; \
    else \
      echo "Skipping freestiler + whitebox-workflows on $TARGETARCH (no wheels)"; \
    fi

# Point the sidecar at this interpreter so it skips the managed-runtime
# bootstrap and uses the prebaked packages. Confine conversion reads/writes to
# /data by default: the sidecar is reachable same-origin through the nginx
# proxy, so without this an arbitrary same-origin caller could read or
# overwrite container paths. Mount input files at /data (read-write for
# outputs); override GEOLIBRE_CONVERSION_ROOTS to widen or disable.
ENV GEOLIBRE_CONVERSION_PYTHON=/usr/local/bin/python \
    WBW_EXTERNAL_PYTHON=/usr/local/bin/python \
    GEOLIBRE_CONVERSION_ROOTS=/data
RUN mkdir -p /data

# For the same reason, the sidecar's PostGIS endpoints refuse every destination
# until GEOLIBRE_POSTGIS_HOSTS names the allowed databases (comma-separated
# `host` or `host:port`) — otherwise a same-origin caller could aim them at
# hosts only this container can reach. Deliberately left unset: set it at
# `docker run` time to enable PostGIS, or `*` to accept any connection string.

# WARNING: docker/nginx.conf's CSP allows http://localhost:* / http://127.0.0.1:*
# (and ws:// equivalents) in connect-src for local-dev data sources (PMTiles/COGs
# from a dev server on another port). This image is intended for local/single-user
# use; on a public host those allowances let the served JS probe each visitor's
# loopback. Drop them from the CSP before publishing publicly.
# Ship nginx.conf as an immutable template (not loaded directly). entrypoint.sh
# renders it to /etc/nginx/conf.d/default.conf on every boot, substituting the
# per-launch sidecar token, so a container restart never keeps a stale token.
COPY docker/nginx.conf /etc/nginx/nginx.conf.template
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  # Default auth snippet (disabled). entrypoint.sh rewrites it at start based
  # on GEOLIBRE_AUTH_USER/GEOLIBRE_AUTH_PASSWORD; baking a valid default keeps
  # `nginx -t` and non-entrypoint invocations working.
  && printf '# Basic Auth disabled (GEOLIBRE_AUTH_USER/GEOLIBRE_AUTH_PASSWORD not set).\n' > /etc/nginx/geolibre-auth.conf \
  && printf '# AI proxy disabled (GEOLIBRE_AI_URL not set).\n' > /etc/nginx/geolibre-ai-proxy.conf
COPY --from=build /app/apps/geolibre-desktop/dist /usr/share/nginx/html

EXPOSE 80

# /healthz is exempt from the optional Basic Auth, so the check keeps passing
# when GEOLIBRE_AUTH_USER/GEOLIBRE_AUTH_PASSWORD are set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1/healthz', timeout=4).status==200 else 1)" || exit 1

CMD ["/usr/local/bin/entrypoint.sh"]
