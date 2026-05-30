# GeoLibre Desktop

Lightweight, cloud-native desktop GIS prototype built with **Tauri v2**, **React**, **TypeScript**, **MapLibre GL JS**, and **DuckDB-WASM Spatial**.

## Features (v0.4.0)

- MapLibre map with OpenFreeMap Liberty basemap
- Load local vector layers supported by DuckDB-WASM Spatial, including common formats such as GeoJSON, GeoParquet, GeoPackage, Shapefile, FlatGeobuf, KML, and GML
- Layer panel (visibility, opacity, reorder, remove)
- Live style panel (fill, stroke, opacity, circle radius)
- Attribute table for imported vector layers
- Save/open `.geolibre.json` projects
- Processing toolbox with local bounds and feature count algorithms
- Plugin system with basemap, layer control, swipe, street view, lidar, GeoAgent, and GeoEditor integrations
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

## Run (web dev — map in browser)

```bash
npm run dev
```

Open http://localhost:5173. The map and browser vector import support local vector files that DuckDB-WASM Spatial can read, including common formats such as GeoJSON, GeoParquet, GeoPackage, Shapefile, FlatGeobuf, KML, and GML, with direct handling for GeoJSON and zipped Shapefiles. You can choose files from Add Vector Layer or drag them onto the app. Desktop filesystem dialogs require Tauri.

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

Built-in plugins live in `packages/plugins/src/plugins/` and are registered by the desktop app in `apps/geolibre-desktop/src/hooks/usePlugins.ts`.

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

Built-in MapLibre controls such as Navigation, Fullscreen, Geolocate, Globe, Terrain, Scale, Attribution, and Logo are toggled from the desktop app's Controls menu. Keep project-specific controls such as Layer Control in the plugin menu when they use the plugin API or need plugin lifecycle behavior.

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
