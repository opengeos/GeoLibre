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
ENV GEOLIBRE_APP_BASE=${GEOLIBRE_APP_BASE}

RUN npm run build

FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/geolibre-desktop/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
