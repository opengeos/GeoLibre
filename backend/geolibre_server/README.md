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

## Test

```bash
python -m pytest
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

## Conversion runtime

The **Processing → Conversion** menu uses a dedicated managed runtime
(DuckDB + rio-cogeo + freestiler), bootstrapped the same way as Whitebox: the
sidecar finds or installs `uv`, creates a virtual environment, and installs the
conversion packages on first use.

- **Vector → GeoParquet** and **CSV → GeoParquet** also run entirely in the
  browser with DuckDB-WASM, so they work in the web build with **no sidecar**.
- **Vector → FlatGeobuf**, **Vector → PMTiles**, and **Raster → COG** have no
  in-browser writer and require the sidecar.

To enable them, install the optional extras and run the sidecar:

```bash
pip install -e ".[conversion]"
geolibre-server
```

For the **web** build, serve the app from `localhost:5173` — CORS is restricted
to that origin and the Tauri origins, so other ports cannot reach the sidecar.

Useful overrides:

```bash
GEOLIBRE_CONVERSION_PYTHON=/path/to/python   # reuse an existing env (skip bootstrap)
GEOLIBRE_CONVERSION_ENV=/path/to/venv        # managed runtime location
GEOLIBRE_CONVERSION_PACKAGES='duckdb>=1.1.0 rio-cogeo>=5.0.0 freestiler>=0.1.0'  # whitespace-separated
GEOLIBRE_CONVERSION_ROOTS=/data:/srv/geo      # confine inputs/outputs to these roots (os.pathsep-separated; unset = no restriction)
```

When the sidecar is reachable by untrusted same-origin content (e.g. the
bundled Docker image), set `GEOLIBRE_CONVERSION_ROOTS` so conversions cannot
read or overwrite arbitrary filesystem paths. It is unset by default for the
desktop app, where paths are the user's own filesystem.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/algorithms` | List algorithms |
| POST | `/run` | Run algorithm (501 placeholder) |
| GET | `/conversion/status` | Conversion runtime availability |
| POST | `/conversion/vector-to-geoparquet` | Vector → Hilbert-sorted GeoParquet |
| POST | `/conversion/vector-to-flatgeobuf` | Vector → Hilbert-sorted FlatGeobuf |
| POST | `/conversion/csv-to-geoparquet` | CSV (lon/lat) → GeoParquet |
| POST | `/conversion/vector-to-pmtiles` | Vector → PMTiles (freestiler) |
| POST | `/conversion/raster-to-cog` | Raster → Cloud Optimized GeoTIFF |
| GET | `/conversion/jobs/{id}` | Conversion job status |

## Future stack

The sidecar will integrate (see `docs/roadmap.md` v0.5):

- **GDAL / Rasterio** — COG, warping, raster analysis
- **GeoPandas** — vector ops, reproject, export
- **DuckDB Spatial** — SQL on cloud-native formats
- **WhiteboxTools** — terrain & hydrology
- **Leafmap** — notebook-style geospatial utilities
- **GeoAI / SamGeo** — ML segmentation workflows

Tauri will bundle the sidecar as an `externalBin` in a later release.
