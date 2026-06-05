# Getting Started

GeoLibre Desktop is an npm workspaces monorepo. The main app lives in `apps/geolibre-desktop` and is built with Tauri, React, TypeScript, and MapLibre GL JS.

## Prerequisites

- Node.js 22 or newer
- Rust toolchain for desktop builds
- Linux desktop build dependencies from the Tauri v2 prerequisites

## Install

```bash
git clone https://github.com/opengeos/GeoLibre.git
cd GeoLibre
npm install
```

Bun users can run `bun install`. The root `trustedDependencies` list allows the known install scripts for `core-js`, `@google/genai`, and `protobufjs`.

## Run the browser UI

```bash
npm run dev
```

Open `http://localhost:5173`. The map and browser vector import support local vector files that DuckDB-WASM Spatial can read, with direct handling for GeoJSON, zipped Shapefiles, and KMZ archives. Use Add Vector Layer or drag files onto the app. The browser UI can also add URL-based services and datasets such as XYZ, WMS, GeoJSON URLs, vector tiles, COG rasters, ArcGIS services, FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats.

Desktop filesystem dialogs, local MBTiles, local raster file reads, project save/open, and other filesystem operations require Tauri.

## Run with Docker

The repository includes a Dockerfile for the browser version of GeoLibre. It builds the Vite app and serves the production files with nginx:

```bash
docker build -t geolibre .
docker run --rm -p 8080:80 geolibre
```

Open `http://localhost:8080`. The containerized browser UI supports web-capable workflows, but desktop filesystem dialogs, local MBTiles, local raster file reads, project save/open, and other Tauri-only features require the desktop app.

The published image is available from GitHub Container Registry:

```bash
docker pull ghcr.io/opengeos/geolibre:latest
docker run --rm -p 8080:80 ghcr.io/opengeos/geolibre:latest
```

For deployments under a URL subpath, pass the app base at build time:

```bash
docker build --build-arg GEOLIBRE_APP_BASE=/geolibre/ -t geolibre .
```

The container always serves the app from its root path. The build argument only sets the URL prefix that the app expects, so subpath deployments also require a reverse proxy in front of the container that strips the prefix before forwarding requests (for example, nginx `proxy_pass http://geolibre/;` with a trailing slash).

## Run the desktop app

```bash
npm run tauri:dev
```

## Build

```bash
npm run build
npm run tauri:build
```

## Optional imagery credentials

The Street View plugin can use Google Street View and Mapillary imagery. Create `apps/geolibre-desktop/.env.local` and set one or both provider credentials:

```env
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
VITE_MAPILLARY_ACCESS_TOKEN=your_mapillary_access_token
```

For Google Street View, enable the Maps Embed API for the key in Google Cloud. For Mapillary, create an app in the Mapillary developer dashboard and use its client access token.

Restart `npm run dev` or `npm run tauri:dev` after changing environment variables.

## Optional Python sidecar

The optional FastAPI sidecar is reserved for heavier processing workflows and is not required for the desktop UI.

```bash
cd backend/geolibre_server
python -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
```
