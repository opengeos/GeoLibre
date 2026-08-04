# GeoLibre Node collaboration relay

This is the Docker-friendly, single-process host for GeoLibre's collaboration
protocol. It uses the same `@geolibre/collab-core` policy as the hosted
Cloudflare Worker and persists session state in SQLite.

```bash
npm run build -w geolibre-collab-node
PORT=8787 COLLAB_DB_PATH=./data/collab.sqlite npm start -w geolibre-collab-node
```

Configuration:

- `PORT` — HTTP/WebSocket port (default `8787`)
- `HOST` — listen address (default `0.0.0.0`)
- `COLLAB_DB_PATH` — SQLite file (default `./data/collab.sqlite`)
- `COLLAB_MAX_SNAPSHOT_BYTES` — maximum UTF-8 snapshot frame size (default
  `1000000`, matching the hosted Worker)
- `COLLAB_IDLE_TTL_MS` — time after the last participant disconnects before the
  session and its persisted data are deleted (default two hours)

Endpoints are `POST /sessions`, `GET /sessions/:id/ws`, and `GET /health`.
Persist the directory containing `COLLAB_DB_PATH`, and terminate TLS at the
ingress so browsers can connect with `wss://`.

## Volume ownership

The container runs as the unprivileged `node` user, and the image creates
`/data` so a fresh named volume inherits that ownership. Docker only does this
for a volume it creates: a volume that already has content from an image that
ran as root keeps its root ownership, and the relay then exits at boot with
`SQLITE_READONLY: attempt to write a readonly database`. Repair it once with

```bash
docker run --rm -v geolibre_geolibre-collab:/data busybox chown -R 1000:1000 /data
```

The same applies to the projects server's volume, using its `geolibre` user.
