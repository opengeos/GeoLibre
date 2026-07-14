# Run the build stage on the builder's native platform: the output is
# arch-independent static files, so emulating arm64 with QEMU here only
# slows down multi-arch builds without changing the result.
# ($BUILDPLATFORM is a Docker-provided automatic ARG, set by BuildKit.)
FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app

# Copy every workspace member's package.json before npm ci so the install
# layer is cached. Adding a new package under apps/ or packages/ requires
# adding its package.json here, or npm ci fails with a missing workspace.
COPY package.json package-lock.json ./
COPY apps/geolibre-desktop/package.json apps/geolibre-desktop/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/map/package.json packages/map/package.json
COPY packages/plugins/package.json packages/plugins/package.json
COPY packages/processing/package.json packages/processing/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN npm ci

COPY . .

ARG GEOLIBRE_APP_BASE=/
ARG VITE_GEE_OAUTH_CLIENT_ID=
ARG VITE_MAPILLARY_ACCESS_TOKEN=
# Set to 1 (or true) to disable the first-launch welcome wizard for the whole
# deployment; visitors land straight on the map.
ARG VITE_WELCOME_DISABLED=
ENV GEOLIBRE_APP_BASE=${GEOLIBRE_APP_BASE}
ENV VITE_GEE_OAUTH_CLIENT_ID=${VITE_GEE_OAUTH_CLIENT_ID}
ENV VITE_MAPILLARY_ACCESS_TOKEN=${VITE_MAPILLARY_ACCESS_TOKEN}
ENV VITE_WELCOME_DISABLED=${VITE_WELCOME_DISABLED}

RUN npm run build

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
  && printf '# Basic Auth disabled (GEOLIBRE_AUTH_USER/GEOLIBRE_AUTH_PASSWORD not set).\n' > /etc/nginx/geolibre-auth.conf
COPY --from=build /app/apps/geolibre-desktop/dist /usr/share/nginx/html

EXPOSE 80

# /healthz is exempt from the optional Basic Auth, so the check keeps passing
# when GEOLIBRE_AUTH_USER/GEOLIBRE_AUTH_PASSWORD are set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1/healthz', timeout=4).status==200 else 1)" || exit 1

CMD ["/usr/local/bin/entrypoint.sh"]
