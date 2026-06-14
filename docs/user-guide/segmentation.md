# AI Segmentation

**Processing → AI Segmentation** turns imagery into vector features
using [segment-geospatial](https://github.com/opengeos/segment-geospatial)
(SamGeo) and Meta's **SAM 3** model. Describe what you want — *"trees"*,
*"buildings"*, *"water"* — or run automatic segmentation, and GeoLibre adds the
resulting polygons as a new vector layer.

!!! note "Requires the Python sidecar and a model backend"
    Segmentation runs deep-learning models, so it needs the GeoLibre desktop
    app with the Python sidecar **plus** a running `samgeo-api` model server. A
    CUDA GPU is strongly recommended; CPU inference works but is slow. See
    [Setup](#setup) below.

## How it works

The heavy model stack (PyTorch + SAM 3) does **not** run inside the GeoLibre
sidecar. Instead the sidecar exposes a thin `/ml` reverse-proxy in front of a
separate **`samgeo-api`** server (the REST server shipped with
`segment-geospatial`). GeoLibre uploads the image to the sidecar, which forwards
it to `samgeo-api`, runs SAM 3, and returns GeoJSON polygons.

```text
SegmentationDialog ──image+prompt──▶ sidecar /ml/segment/* ──▶ samgeo-api (SAM 3) ──▶ GeoJSON
```

This keeps the GeoLibre sidecar small and lets the model server run wherever you
have a GPU.

## Setup

Install `segment-geospatial` with the API and SAM 3 extras in a Python
environment that has a working PyTorch build (ideally CUDA):

```bash
pip install "segment-geospatial[api,samgeo3]"
```

Then either let GeoLibre launch the model server for you, or run it yourself:

- **Auto-launch (default).** If `samgeo-api` is on the `PATH` of the environment
  the sidecar runs in, GeoLibre starts it automatically on first use.
- **Run it yourself / on another machine.** Start the server and point GeoLibre
  at it:

    ```bash
    samgeo-api --port 8000
    # then run the sidecar with:
    GEOLIBRE_ML_SAMGEO_URL=http://127.0.0.1:8000
    ```

!!! note "Desktop app: point it at an external `samgeo-api`"

    The desktop app runs its sidecar in a managed (uv) environment that ships
    the `ml` extra but **not** the heavy `segment-geospatial` model stack, so
    `samgeo-api` is not on its `PATH` and auto-launch does not apply. Install
    `segment-geospatial[api,samgeo3]` in a PyTorch-capable environment, start
    `samgeo-api` there, and launch the desktop app from a shell that exports
    `GEOLIBRE_ML_SAMGEO_URL` so the sidecar proxies to it:

    ```bash
    # in your PyTorch env
    samgeo-api --port 8000

    # launch the desktop app with the proxy target set
    GEOLIBRE_ML_SAMGEO_URL=http://127.0.0.1:8000 npm run tauri:dev
    ```

    The Tauri process passes its environment to the sidecar it spawns. Without
    `GEOLIBRE_ML_SAMGEO_URL`, the sidecar has no model backend and `/ml/status`
    reports the segmentation backend as unavailable.

Install the sidecar's optional `ml` extra (just an HTTP client — the models live
in `samgeo-api`):

```bash
pip install -e "backend/geolibre_server[ml]"
```

### Configuration

| Environment variable | Purpose |
| --- | --- |
| `GEOLIBRE_ML_SAMGEO_URL` | Base URL of an already-running `samgeo-api`. When set, the sidecar proxies here and does not launch a child process. |
| `GEOLIBRE_ML_SAMGEO_CMD` | Command used to launch `samgeo-api` on demand (default `samgeo-api`). `--host`/`--port` are appended automatically. |
| `GEOLIBRE_ML_DEFAULT_MODEL` | Model the UI defaults to (default `sam3`). |

## Using it

1. Open **Processing → AI Segmentation**.
2. If the backend isn't reachable, the dialog shows a message and a **Start
   server** button (desktop) — click it to launch the sidecar and model server.
3. **Choose a GeoTIFF.** Pick a georeferenced raster (`.tif`/`.tiff`; PNG/JPG
   also work but produce pixel-space results). The polygons come back in the
   raster's coordinate system, so they land in the right place on the map.
4. **Pick a mode:**
    - **Text prompt** — type what to segment (e.g. `trees`, `buildings`,
      `cars`) and set a **Confidence threshold** (0–1; lower finds more, higher
      is stricter). SAM 3 finds every matching object in the image.
    - **Automatic (everything)** — segments all distinct objects without a
      prompt.
5. Click **Segment**. The result is added as a new GeoJSON polygon layer named
   after the prompt, and the map zooms to it.

## Notes & limitations

- **SAM 3 only.** GeoLibre uses the SAM 3 backend, which covers text, box/point,
  and automatic prompts well. (SAM 2 is intentionally not wired up.)
- **Desktop only.** Like the raster tools, segmentation needs the desktop app
  and the Python sidecar; it is not available in the browser-only build.
- **No objects found** is a normal outcome — try a different prompt or lower the
  confidence threshold.
- **Box / point prompts** drawn on the map are not in the UI yet; the
  `/ml/segment/predict` endpoint already supports them for scripted use.

## API (advanced)

The sidecar exposes these endpoints (proxied to `samgeo-api`):

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/ml/status` | Backend availability, default model, version, and model list. |
| POST | `/ml/segment/text` | Text-prompt segmentation (`prompt`, `confidence_threshold`). |
| POST | `/ml/segment/automatic` | Automatic mask generation. |
| POST | `/ml/segment/predict` | Box/point prompt segmentation (`boxes`, `point_coords`, `point_labels`, `point_crs`). |

Each `segment/*` endpoint takes a multipart `file` (the image) plus
`model_version` (default `sam3`) and `output_format` (default `geojson`) and
returns a GeoJSON `FeatureCollection`.

See also [Processing Tools](processing.md) and
[Reference → Architecture](../architecture.md#python-sidecar).
