# GeoLibre Server (Python sidecar)

Optional FastAPI backend for heavy geoprocessing. **Not required** to run GeoLibre Desktop UI.

## Install

```bash
cd backend/geolibre_server
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e .
```

## Run

```bash
uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765 --reload
```

Or:

```bash
geolibre-server
```

## Whitebox runtime

Whitebox tools use a dedicated GeoLibre-managed Python environment. On first
use, the sidecar looks for `uv`; if it is not available, it downloads the
official uv standalone installer and installs uv into the GeoLibre runtime cache.
It then creates a Whitebox virtual environment and installs
`whitebox-workflows`.

Useful overrides:

```bash
GEOLIBRE_RUNTIME_DIR=/path/to/cache
GEOLIBRE_UV=/path/to/uv
GEOLIBRE_UV_DIR=/path/to/managed-uv
GEOLIBRE_WHITEBOX_ENV=/path/to/whitebox-venv
GEOLIBRE_WHITEBOX_PACKAGE='whitebox-workflows>=2.0.2'
WBW_EXTERNAL_PYTHON=/path/to/python
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/algorithms` | List algorithms |
| POST | `/run` | Run algorithm (501 placeholder) |

## Future stack

The sidecar will integrate (see `docs/roadmap.md` v0.5):

- **GDAL / Rasterio** — COG, warping, raster analysis
- **GeoPandas** — vector ops, reproject, export
- **DuckDB Spatial** — SQL on cloud-native formats
- **WhiteboxTools** — terrain & hydrology
- **Leafmap** — notebook-style geospatial utilities
- **GeoAI / SamGeo** — ML segmentation workflows

Tauri will bundle the sidecar as an `externalBin` in a later release.
