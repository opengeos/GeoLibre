# GeoLibre Desktop

Lightweight, cloud-native desktop GIS prototype built with **Tauri v2**, **React**, **TypeScript**, **MapLibre GL JS**, **DuckDB-WASM Spatial**, and **deck.gl**.

[![](https://files.opengeos.org/GeoLibre-OPERA-demo.webp)](https://geolibre.app/demo/?url=https://data.geolibre.app/opera-dswx.geolibre.json)

## Features (v0.5.0)

- MapLibre map workspace with OpenFreeMap basemaps, blank background support, and toggleable navigation, fullscreen, geolocation, globe, terrain, scale, attribution, and logo controls
- Load local vector layers supported by DuckDB-WASM Spatial, including common formats such as GeoJSON, GeoParquet, GeoPackage, Shapefile, FlatGeobuf, KML/KMZ, and GML
- Add Data menu for XYZ tiles, WMS, GeoJSON URLs, vector tiles, COG and GeoTIFF rasters, MBTiles, ArcGIS FeatureServer and VectorTileServer layers, PMTiles, Zarr, LiDAR, and Gaussian splats
- Layer panel for visibility, opacity, reordering, zoom-to-layer, identify, and remove actions
- Live style panel (fill, stroke, opacity, circle radius)
- Attribute table with filtering, sorting, resize controls, feature highlighting, and optional zoom to selected features
- Save/open `.geolibre.json` projects
- Processing toolbox with local bounds and feature count algorithms
- Plugin system with basemap, layer control, MapLibre components, swipe, street view, LiDAR, GeoAgent, and GeoEditor integrations, including configurable control positions
- Optional Python FastAPI sidecar for heavier processing workflows

## Prerequisites

- **Node.js** 18+
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

## Optional Python sidecar

```bash
cd backend/geolibre_server
python -m venv .venv && source .venv/bin/activate
pip install -e .
uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
```

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

The v0.5.0 Components plugin wraps `maplibre-gl-components` controls and wires their layer events into the GeoLibre store. It provides Add Data shortcuts for FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats, while raster COG and GeoTIFF layers can also be added through the standard Add Raster Layer dialog.

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
