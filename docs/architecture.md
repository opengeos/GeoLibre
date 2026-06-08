# GeoLibre Desktop Architecture

## Overview

GeoLibre Desktop is an npm workspaces monorepo. The UI is a React app hosted by Tauri v2. Map rendering uses MapLibre GL JS in the browser webview, with deck.gl used for advanced raster, point cloud, and 3D overlays. Application state lives in a Zustand store (`@geolibre/core`).

```mermaid
flowchart LR
  UI[React UI] --> Store[Zustand Store]
  Store --> MapPkg[MapController]
  MapPkg --> ML[MapLibre GL JS]
  Plugins[Built-in plugins] --> Store
  Plugins --> ML
  UI --> Tauri[Tauri Plugins]
  Tauri --> FS[File System]
  Proc[Processing] --> Store
  Proc -.-> Sidecar[FastAPI optional]
```

## Packages

| Package | Responsibility |
|---------|----------------|
| `@geolibre/core` | Domain types, project JSON schema, global store |
| `@geolibre/map` | MapLibre lifecycle, layer sync, GeoJSON, raster, tile, MBTiles, control, and selection styling |
| `@geolibre/ui` | Shared UI primitives (shadcn-style) |
| `@geolibre/processing` | Client-side algorithm registry |
| `@geolibre/plugins` | Plugin interface and built-in plugins |
| `geolibre-desktop` | Shell layout, Tauri I/O, composition |

## State flow

1. User adds data through the Add Data menu, the Tauri dialog, browser file picker, drag and drop, or a built-in plugin control.
2. Local vector data is parsed directly or converted to GeoJSON with DuckDB-WASM Spatial, then passed to `addGeoJsonLayer` in the store.
3. Tile, service, raster, ArcGIS, MBTiles, and plugin-backed layers create `GeoLibreLayer` records with source metadata and native MapLibre layer ids when applicable.
4. `MapCanvas` subscribes to `layers`, then `MapController.syncLayers` updates MapLibre sources and layers and keeps the layer control in sync.
5. Style panel and layer panel updates change layer state, then map sync updates paint, visibility, opacity, ordering, and removal.
6. Attribute table selections update the highlighted feature source and can zoom the map to the selected feature.
7. Desktop save uses `projectFromStore` and writes `.geolibre.json` to disk.

## DuckDB-WASM

Vector file import uses DuckDB-WASM for formats that need conversion before MapLibre can render them:

```sql
INSTALL spatial;
LOAD spatial;
```

GeoParquet is read with DuckDB's Parquet reader after loading Spatial. Other local vector formats are passed to Spatial `ST_Read` when the WebAssembly extension can load the GDAL-backed reader. Zipped Shapefiles are parsed with `shpjs` first, then DuckDB Spatial is tried if that parser cannot read the file. KMZ archives are unzipped in the browser and their KML files are passed through the same DuckDB Spatial KML reader.

## Advanced Add Data workflows

The v0.9.0 Add Data surface includes native dialogs for XYZ, WMS, WFS, vector files (via the Add Vector dialog backed by `maplibre-gl-vector`), GeoJSON URLs, vector tile sources, delimited text, raster tile templates, COG and GeoTIFF rasters (via the Add Raster dialog backed by `maplibre-gl-raster`), MBTiles, ArcGIS FeatureServer or VectorTileServer layers, and GPX waypoints, tracks, and routes. It also supports 3D Tiles layers, WFS and GeoJSON URL refresh, text marker labels, and multiple DuckDB SQL query-result layers with identify, selection, and attribute table support. The Components plugin wraps `maplibre-gl-components` panels for FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats, then mirrors added layers into the GeoLibre store so the Layer panel, project format, and layer control can reason about them. Additional data sources are available through the Planetary Computer and Earth Engine panels, the Overture Maps plugin, and the federal Web Services plugins.

Local MBTiles tiles are read through a custom MapLibre protocol backed by Tauri commands. Remote rasters are fetched through the desktop backend when needed, and the local development server includes a raster proxy for selected release assets that need CORS handling.

## Python sidecar

The FastAPI app in `backend/geolibre_server` backs the Whitebox toolbox through a managed local processing sidecar. The desktop app starts the sidecar on demand, communicates over `127.0.0.1`, and keeps the heavier Python processing stack outside the browser bundle.

Future processing releases are expected to expand the same sidecar pattern for GDAL, Rasterio, GeoPandas, DuckDB Spatial SQL, Leafmap, GeoAI, and SamGeo workflows.

## Container image

The root Dockerfile packages the browser version of the app. It uses a Node build stage to run the workspace build for `geolibre-desktop`, then copies `apps/geolibre-desktop/dist` into an nginx runtime image. The nginx config serves static assets and falls back to `index.html` for browser-entry URLs.

The `Publish Container Image` GitHub Actions workflow builds the image for pull requests and publishes it to GitHub Container Registry for pushes to `main`, version tags, and manual runs. The upstream image name is `ghcr.io/opengeos/geolibre`.

The container does not run the Tauri desktop shell or the optional Python sidecar. Workflows that depend on desktop filesystem access still require the installed desktop app.

## Security

- Tauri CSP allowlists tile and style hosts (OpenFreeMap, CARTO).
- File access uses dialog-selected paths only.
