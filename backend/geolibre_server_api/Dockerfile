FROM python:3.13-slim

WORKDIR /app
COPY pyproject.toml README.md ./
COPY geolibre_server_api ./geolibre_server_api
RUN pip install --no-cache-dir ".[postgres,s3]"

RUN useradd --create-home geolibre && mkdir -p /data && chown geolibre:geolibre /data
USER geolibre

ENV GEOLIBRE_DATABASE_URL=sqlite:////data/geolibre-server-api.db \
    GEOLIBRE_STORAGE_PATH=/data/objects
EXPOSE 8000
CMD ["geolibre-server-api"]
