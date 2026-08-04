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
- `GEOLIBRE_PUBLIC_URL`: externally reachable API origin.
- `GEOLIBRE_VIEWER_URL`: GeoLibre viewer origin.
- `GEOLIBRE_CORS_ORIGINS`: comma-separated web origins, default `*`.
- `GEOLIBRE_MAX_PROJECT_BYTES`, `GEOLIBRE_MAX_THUMBNAIL_BYTES`: upload limits.
- `GEOLIBRE_HOST`, `GEOLIBRE_PORT`: bind address and port for the
  `geolibre-server-api` entry point, default `0.0.0.0` and `8000`. Bind to
  `127.0.0.1` when a reverse proxy fronts the service.

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

`429` and token expiry are part of the contract but are not implemented here;
see the "What the reference server leaves to the operator" section of
`docs/server-api.md` before exposing this publicly.
