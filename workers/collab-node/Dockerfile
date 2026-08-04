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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/workers/collab-node/package.json ./workers/collab-node/package.json
COPY --from=build /app/workers/collab-node/dist ./workers/collab-node/dist
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "workers/collab-node/dist/server.js"]
