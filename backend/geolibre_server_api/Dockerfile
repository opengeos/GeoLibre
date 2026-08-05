FROM python:3.13-slim

WORKDIR /app
COPY pyproject.toml README.md ./
COPY geolibre_server_api ./geolibre_server_api
RUN pip install --no-cache-dir ".[postgres,s3]"

# Create the storage directory in the image, not just /data. A named volume
# mounted at /data/objects inherits the image's ownership only when that exact
# path already exists; otherwise Docker creates the mountpoint as root and the
# unprivileged user below cannot write projects into it.
# uid/gid pinned to 1000 rather than taking the next free id: README.md documents
# `chown -R 1000:1000` to repair a volume created by an earlier root-owned image,
# and that instruction is only correct while this user keeps that id.
RUN groupadd --gid 1000 geolibre \
  && useradd --uid 1000 --gid 1000 --create-home geolibre \
  && mkdir -p /data/objects \
  && chown -R geolibre:geolibre /data
USER geolibre

ENV GEOLIBRE_DATABASE_URL=sqlite:////data/geolibre-server-api.db \
    GEOLIBRE_STORAGE_PATH=/data/objects
EXPOSE 8000
CMD ["geolibre-server-api"]
