# GeoLibre Desktop

Lightweight, cloud-native desktop GIS prototype built with **Tauri v2**, **React**, **TypeScript**, **MapLibre GL JS**, **DuckDB-WASM Spatial**, and **deck.gl**.

[![](https://files.opengeos.org/GeoLibre-demo.webp)](https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json)

## Features (v0.9.0)

- MapLibre map workspace with OpenFreeMap basemaps, blank background support, and toggleable navigation, fullscreen, geolocation, globe, terrain, scale, attribution, and logo controls
- Load local vector layers supported by DuckDB-WASM Spatial, including common formats such as GeoJSON, GeoParquet, GeoPackage, Shapefile, FlatGeobuf, KML/KMZ, GML, delimited text, and GPX
- Reproject vector layers to EPSG:4326 on load and split dragged GPX files into named waypoint, track, and route layers
- Add Data menu for XYZ tiles, WMS, WFS, GeoJSON URLs, vector tiles, COG and GeoTIFF rasters, MBTiles, ArcGIS FeatureServer and VectorTileServer layers, PMTiles, Zarr, LiDAR, 3D Tiles, and Gaussian splats
- Manual and automatic refresh for WFS and GeoJSON URL layers
- Layer panel for visibility, opacity, reordering, zoom-to-layer, identify, labels, and remove actions
- Live style panel (fill, stroke, opacity, circle radius)
- Attribute table with filtering, sorting, resize controls, feature highlighting, and optional zoom to selected features
- SQL Workspace for running DuckDB SQL against loaded layers, local files, and remote URLs, with sample queries, query history, and adding results to the map
- Multiple DuckDB SQL query-result layers
- Save/open `.geolibre.json` projects
- Desktop diagnostics panel, update check, and MSIX packaging support
- Plugin system with basemap, layer control, MapLibre components, swipe, street view, LiDAR, GeoAgent, and GeoEditor integrations, including configurable control positions and external plugin manifests
- External plugin zip loading from the app data plugins directory and local development plugin directories
- Optional Python FastAPI sidecar for heavier processing workflows

## Prerequisites

- **Node.js** 22+
- **Rust** toolchain ([rustup](https://rustup.rs/)) for Tauri desktop builds
- Linux: `webkit2gtk`, `libayatana-appindicator` (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

## Install

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
```

Bun users can run `bun install`. The root `trustedDependencies` list allows the known install scripts for `core-js`, `@google/genai`, and `protobufjs`.

## Run (web dev, map in browser)

```bash
npm run dev
```

Open http://localhost:5173. The map and browser vector import support local vector files that DuckDB-WASM Spatial can read, including common formats such as GeoJSON, GeoParquet, GeoPackage, Shapefile, FlatGeobuf, KML/KMZ, and GML, with direct handling for GeoJSON, zipped Shapefiles, and KMZ archives. You can choose files from Add Vector Layer or drag them onto the app. Desktop filesystem dialogs, local MBTiles, and local raster file reads require Tauri.

## Run with Docker

Build and run the browser version of GeoLibre:

```bash
docker build -t geolibre .
docker run --rm -p 8080:80 geolibre
```

Open http://localhost:8080. The Docker image serves the production Vite build with nginx. Desktop-only features such as Tauri filesystem dialogs, local MBTiles, local raster file reads, and project save/open require the desktop app.

### Bundled conversion sidecar

The image also bundles the Python conversion/Whitebox sidecar (uvicorn) and
reverse-proxies it at `/sidecar`, so the browser reaches it same-origin with no
CORS or separate process to manage. `/conversion/status` is reachable at
`http://localhost:8080/sidecar/conversion/status`.

- **Vector → GeoParquet** and **CSV → GeoParquet** run in the browser with
  DuckDB-WASM and need no sidecar.
- **Vector → FlatGeobuf**, **Vector → PMTiles**, and **Raster → COG** use the
  sidecar. These read a file **path on the sidecar's filesystem**, so from a
  pure browser they currently work for files mounted into the container (a
  browser cannot hand the container an absolute path); upload-based input is a
  planned follow-up. The desktop app passes real local paths, so all
  conversions work there.
- **PMTiles** and **Whitebox** are **amd64-only** in the container —
  `freestiler` and `whitebox-workflows` publish no linux/arm64 wheels. On arm64
  the other conversions still work; those two report unavailable.

Because the sidecar is reachable same-origin, conversion reads/writes are
confined to `GEOLIBRE_CONVERSION_ROOTS` (default `/data` in the image). Mount
your files there:

```bash
docker run --rm -p 8080:80 -v "$PWD/data:/data" geolibre
```

Set `GEOLIBRE_DISABLE_SIDECAR=1` to run nginx only (the original web-only
behavior):

```bash
docker run --rm -p 8080:80 -e GEOLIBRE_DISABLE_SIDECAR=1 geolibre
```

The published image is available from GitHub Container Registry:

```bash
docker pull ghcr.io/opengeos/geolibre:latest
docker run --rm -p 8080:80 ghcr.io/opengeos/geolibre:latest
```

For deployments under a URL subpath, pass `GEOLIBRE_APP_BASE` at build time:

```bash
docker build --build-arg GEOLIBRE_APP_BASE=/geolibre/ -t geolibre .
```

The container always serves the app from its root path. The build argument only sets the URL prefix that the app expects, so subpath deployments also require a reverse proxy in front of the container that strips the prefix before forwarding requests (for example, nginx `proxy_pass http://geolibre/;` with a trailing slash).

## SQL Workspace

The SQL Workspace runs DuckDB SQL (with the Spatial extension loaded, so `ST_*` functions are available) directly in the browser against your loaded layers and remote data. Open it from the Processing menu.

- **Query loaded layers.** Every vector layer with in-memory features is exposed as a table; the queryable table names are listed at the top of the dialog.
- **Read files and URLs.** Use `read_parquet()`, `read_csv_auto()`, `read_json_auto()`, or `ST_Read()`. A bare URL or path after `FROM`/`JOIN` (for example `SELECT * FROM https://host/data.parquet`) is auto-wrapped in the matching reader. Remote files are streamed over HTTP range requests, so large datasets are not downloaded in full.
- **Sample queries.** A dropdown of ready-to-run examples (attribute-only, aggregate, and spatial queries) against a public sample dataset, plus a per-layer "sample query for layer" dropdown.
- **Query history.** Recently run queries are saved (in `localStorage`) and can be reloaded from the History dropdown.
- **Results and export.** Results show in a grid (capped for display; the full result is kept for export). When a query returns a geometry column, you can add the result to the map as a new layer (with an optional custom **layer name**) or export it as CSV or GeoParquet.

```sql
SELECT NAME, CONTINENT, POP_EST, geom
FROM https://data.source.coop/giswqs/opengeos/countries.parquet
WHERE POP_EST > 50000000
ORDER BY POP_EST DESC;
```

Only a single statement is supported per run; remote `s3://` URLs are not read directly, so use the HTTPS form instead.

## Embed the demo

The browser demo supports URL parameters for iframe-friendly layouts.

Open a project by URL:

<https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json>

Supported query parameters:

| Parameter    | Example                                                  | Description                                                                                                                 |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `url`        | `url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json` | Loads a `.geolibre.json` project from a public URL.                                                                         |
| `layout`     | `layout=compact`                                         | Uses the compact embed layout with icon-only toolbar buttons and hidden project metadata. `embed` and `iframe` are aliases. |
| `toolbar`    | `toolbar=icons`                                          | Shows icon-only toolbar buttons without enabling the full compact layout.                                                   |
| `panels`     | `panels=none`                                            | Hides the Layers, Style, and Attribute table panels. `hidden`, `hide`, and `off` are aliases.                               |
| `hidePanels` | `hidePanels=true`                                        | Alternative way to hide the Layers, Style, and Attribute table panels.                                                      |
| `maponly`    | `maponly`                                                | Hides all chrome (toolbar menu, Layers/Style/Attribute panels, and status bar), leaving only the map. The bare flag or any of `true`, `1`, `yes`, `on` enable it. |

Use compact mode for narrow embeds. This shows icon-only toolbar buttons and hides project metadata:

```text
https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json&layout=compact
```

Hide the Layers, Style, and Attribute table panels for map-focused embeds:

```text
https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json&layout=compact&panels=none
```

Use `toolbar=icons` when you only want icon-only toolbar buttons. `panels=hidden`, `panels=hide`, `panels=off`, and `hidePanels=true` are accepted aliases for hiding panels.

For a fully chrome-free, map-only embed, use `maponly`. It hides the toolbar menu, all panels, and the status bar:

```text
https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json&maponly
```

## Environment variables

The Street View plugin can use Google Street View and Mapillary imagery. Create `apps/geolibre-desktop/.env.local` and set one or both provider credentials:

```env
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
VITE_MAPILLARY_ACCESS_TOKEN=your_mapillary_access_token
```

For Google Street View, enable the Maps Embed API for the key in Google Cloud. For Mapillary, create an app in the Mapillary developer dashboard and use its client access token.

Restart `npm run dev` or `npm run tauri:dev` after changing these values. Vite only exposes variables with the `VITE_` prefix to the frontend.

## Run (desktop)

```bash
npm run tauri:dev
```

## Build

```bash
npm run build
npm run tauri:build
```

## Quality checks

Run the fast TypeScript unit tests:

```bash
npm run test:frontend
```

Run the full local quality gate:

```bash
npm run ci
```

## Optional Python sidecar

```bash
cd backend/geolibre_server
python -m venv .venv && source .venv/bin/activate
pip install -e .
uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
```

### Conversion tools (Processing → Conversion)

The **Processing → Conversion** menu (Vector → GeoParquet / FlatGeobuf,
CSV → GeoParquet, Vector → PMTiles, Raster → COG) talks to this sidecar at
`http://127.0.0.1:8765`. **Vector → GeoParquet** and **CSV → GeoParquet** also
run fully in the browser with DuckDB-WASM and need no sidecar; the others
require it.

To use them from the **web** build, start the sidecar and serve the app from
`localhost:5173` (CORS is restricted to that origin and the Tauri origins):

```bash
# install the conversion extras (DuckDB, rio-cogeo, freestiler)
pip install -e "backend/geolibre_server[conversion]"
# run it
geolibre-server   # or: uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
```

The sidecar self-bootstraps a managed runtime on first use; set
`GEOLIBRE_CONVERSION_PYTHON=$(which python)` to reuse the current environment
instead. See [backend/geolibre_server/README.md](backend/geolibre_server/README.md)
for details.

## Repository layout

```
apps/geolibre-desktop   # Tauri + React app
packages/core           # Types, store, project format
packages/map            # MapLibre integration
packages/ui             # Tailwind + shadcn/ui
packages/plugins        # Plugin API
packages/processing     # Algorithm registry
backend/geolibre_server # FastAPI sidecar
sample-data/            # Sample GeoJSON & project
docs/                   # Architecture & API docs
```

## Add a plugin

Built-in plugins live in `packages/plugins/src/plugins/` and are registered by the desktop app in `apps/geolibre-desktop/src/hooks/usePlugins.ts`. Map control plugins can expose a control position through `getMapControlPosition()` and `setMapControlPosition()` so the Plugins menu can move them between map corners.

For external plugin development, start from the [GeoLibre plugin template](https://github.com/opengeos/geolibre-plugin-template). It includes a `plugin.json` manifest, a GeoLibre plugin wrapper entry point, and a `package:geolibre` script that creates a zip file for the desktop app data `plugins/` directory. During development, Settings > Plugins can scan an additional local plugin directory, including an unpacked bundle folder such as the template's `geolibre-plugin/` directory, or a hosted `plugin.json` manifest URL. See the [Plugin API](docs/plugin-api.md) for the external plugin contract.

For web builds, an external plugin can be bundled by placing its built folder under `apps/geolibre-desktop/public/plugins/<plugin-id>/` and loading `/plugins/<plugin-id>/plugin.json` as a manifest URL. Browsers cannot scan plugin folders at runtime, so bundled web plugins still need explicit manifest URLs unless they are registered as built-in plugins.

1. Create a plugin file in `packages/plugins/src/plugins/`.

```typescript
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const myPlugin: GeoLibrePlugin = {
  id: "my-plugin",
  name: "My Plugin",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    app.setBasemap("https://example.com/style.json");
  },
  deactivate: () => {},
};
```

2. Export it from `packages/plugins/src/index.ts`.

```typescript
export { myPlugin } from "./plugins/my-plugin";
```

3. Register it in `apps/geolibre-desktop/src/hooks/usePlugins.ts`.

```typescript
import { myPlugin } from "@geolibre/plugins";

manager.registerAll([
  maplibreLayerControlPlugin,
  maplibreGeoAgentPlugin,
  maplibreGeoEditorPlugin,
  myPlugin,
]);
```

Plugins can use the app API to change basemaps, add GeoJSON layers, or attach MapLibre controls. For a MapLibre control plugin, add the package dependency, import its CSS in `apps/geolibre-desktop/src/main.tsx`, then call `app.addMapControl(control, "top-left")` in `activate()` and `app.removeMapControl(control)` in `deactivate()`.

Built-in MapLibre controls such as Navigation, Fullscreen, Geolocate, Globe, Terrain, Scale, Attribution, and Logo are toggled from the desktop app's Controls menu. The same menu also opens Search, a standalone place search panel backed by the Components plugin. Keep project-specific controls such as Layer Control and Components in the plugin menu when they use the plugin API or need plugin lifecycle behavior.

The Components plugin wraps `maplibre-gl-components` controls and wires their layer events into the GeoLibre store. It provides Add Data shortcuts for FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats, while raster COG and GeoTIFF layers can also be added through the standard Add Raster Layer dialog.

If a third-party MapLibre control needs app-specific styling fixes, add scoped overrides in `apps/geolibre-desktop/src/index.css` instead of editing files in `node_modules`. Keep selectors limited to the plugin control class. For example, GeoEditor toolbar buttons need a local override because MapLibre's default control button CSS can override their flex centering:

```css
.geo-editor-control .geo-editor-tool-button {
  align-items: center;
  display: flex !important;
  justify-content: center;
  line-height: 0;
  padding: 0;
}

.geo-editor-control .geo-editor-tool-button svg {
  display: block;
  flex: 0 0 auto;
  margin: 0;
}
```

Run checks before submitting changes:

```bash
npm run build
pre-commit run --all-files
```

## Documentation

- [Architecture](docs/architecture.md)
- [Project format](docs/project-format.md)
- [Plugin API](docs/plugin-api.md)
- [Roadmap](docs/roadmap.md)

## License

MIT
