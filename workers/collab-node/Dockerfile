FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches patches
COPY scripts/apply-dependency-patches.mjs scripts/apply-dependency-patches.mjs
COPY packages/collab-core/package.json packages/collab-core/package.json
COPY workers/collab-node/package.json workers/collab-node/package.json
RUN npm ci --workspace geolibre-collab-node --workspace @geolibre/collab-core
COPY packages/collab-core packages/collab-core
COPY workers/collab-node workers/collab-node
RUN npm run build -w geolibre-collab-node

# Assemble the runtime tree under /runtime so the final stage is one COPY of a
# layout that is known to resolve. esbuild bundles everything except `ws`, and
# `ws` does not always land in /app/node_modules: the root lockfile carries two
# versions of it (8.21.0 hoisted for the app's transitive deps, ^8.21.3 for this
# worker), so npm installs this workspace's copy at the nested
# workers/collab-node/node_modules. Copying only /app/node_modules dropped it and
# the container exited at startup with ERR_MODULE_NOT_FOUND (GeoLibre#1866), so
# take the nested tree too, guarded because it disappears whenever a dependency
# bump lets npm hoist `ws` to the root instead. packages/collab-core comes along
# for a weaker reason: esbuild inlines it, so the running server never imports it
# and it is not what broke the image. It is copied so that the symlink npm leaves
# at node_modules/@geolibre/collab-core points at something, since a dangling
# entry in node_modules trips anything that walks the tree in the container. The
# reinstall drops esbuild and the other dev dependencies now that the bundle is
# built, which is what keeps the copied tree small.
RUN npm ci --omit=dev --workspace geolibre-collab-node --workspace @geolibre/collab-core \
  && mkdir -p /runtime/workers/collab-node \
  && cp -a node_modules /runtime/node_modules \
  && cp -a packages /runtime/packages \
  && cp -a workers/collab-node/package.json workers/collab-node/dist /runtime/workers/collab-node/ \
  && if [ -d workers/collab-node/node_modules ]; then \
       cp -a workers/collab-node/node_modules /runtime/workers/collab-node/node_modules; \
     fi

# Load the staged bundle from the path it will actually sit at, so a layout
# regression fails the build here instead of at container start. Importing it is
# side-effect-free: server.js only listens when it is process.argv[1]. The
# `test` is the weaker half -- nothing at runtime resolves that symlink, it just
# asserts the tree was copied whole.
RUN node --input-type=module \
  -e "await import('/runtime/workers/collab-node/dist/server.js');" \
  && test -e /runtime/node_modules/@geolibre/collab-core

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 COLLAB_DB_PATH=/data/collab.sqlite
WORKDIR /app
# --chown on the COPY rather than a recursive chown afterwards: chowning /app
# rewrites every file, node_modules included, into a second copy in a new layer.
COPY --from=build --chown=node:node /runtime ./
# /data is created and owned here so a named volume mounted over it inherits the
# ownership; Docker only copies image ownership onto a volume when the path
# already exists, otherwise the mountpoint lands root-owned.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "workers/collab-node/dist/server.js"]
