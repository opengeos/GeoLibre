FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/collab-core/package.json packages/collab-core/package.json
COPY workers/collab-node/package.json workers/collab-node/package.json
RUN npm ci --workspace geolibre-collab-node --workspace @geolibre/collab-core
COPY packages/collab-core packages/collab-core
COPY workers/collab-node workers/collab-node
RUN npm run build -w geolibre-collab-node

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 COLLAB_DB_PATH=/data/collab.sqlite
WORKDIR /app
# --chown on the COPY rather than a recursive chown afterwards: chowning /app
# rewrites every file, node_modules included, into a second copy in a new layer.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/workers/collab-node/package.json ./workers/collab-node/package.json
COPY --from=build --chown=node:node /app/workers/collab-node/dist ./workers/collab-node/dist
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
