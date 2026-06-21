# Getting Started

[![live demo](https://img.shields.io/badge/Live-demo-green.svg)](https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json)
[![GeoLibre shared project](https://img.shields.io/badge/GeoLibre-share-green.svg)](https://share.geolibre.app)
[![GeoLibre plugins](https://img.shields.io/badge/GeoLibre-plugins-green.svg)](https://plugins.geolibre.app)
[![image](https://img.shields.io/pypi/v/geolibre.svg)](https://pypi.python.org/pypi/geolibre)
[![image](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/opengeos/GeoLibre/blob/main/python/examples/getting-started.ipynb)
[![image](https://img.shields.io/conda/vn/conda-forge/geolibre.svg)](https://anaconda.org/conda-forge/geolibre)
[![Conda Recipe](https://img.shields.io/badge/recipe-geolibre-green.svg)](https://github.com/conda-forge/geolibre-feedstock)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/geolibre)
[![Open in StackBlitz](https://img.shields.io/badge/Open%20in-StackBlitz-blue?logo=stackblitz)](https://stackblitz.com/github/opengeos/geolibre)
[![image](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GeoLibre is a lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data across desktop and web environments, with a responsive layout for mobile screens. It is an npm workspaces monorepo: the main app lives in `apps/geolibre-desktop` and is built with Tauri, React, TypeScript, and MapLibre GL JS. The same workspace runs as a native desktop app and as a browser-based web app, and adapts responsively to mobile and small screens.

## Video tutorial

Watch the introduction: [GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere (Browser, Desktop & Jupyter)](https://youtu.be/87Cm0QagtxI)

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

## Update

To update an existing source checkout to the latest version, pull the changes, reinstall dependencies (in case `package.json` changed), and rebuild:

```bash
cd /path/to/GeoLibre   # your GeoLibre checkout
git pull origin main
npm install            # or: bun install
```

If you run a production build, rebuild afterwards with `npm run build` (web) or `npm run tauri:build` (desktop). If you work from the dev servers (`npm run dev` or `npm run tauri:dev`), the `git pull` and `npm install` above are enough — just restart the dev server to pick up the changes.

## Run the browser UI

```bash
npm run dev
```

Open `http://localhost:5173`. The map and browser vector import support local vector files that DuckDB-WASM Spatial can read, with direct handling for GeoJSON, zipped Shapefiles, and KMZ archives. Use Add Vector Layer or drag files onto the app; GeoTIFF/COG rasters can also be dragged onto the map to add them as raster layers. The browser UI can also add URL-based services and datasets such as XYZ, WMS, GeoJSON URLs, vector tiles, COG rasters, ArcGIS services, FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats.

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

Where to find the output:

- **Web build** — static files in `apps/geolibre-desktop/dist/`. Serve this directory with any static web server (or the Docker image above).
- **Desktop installers** — `apps/geolibre-desktop/src-tauri/target/release/bundle/`, with per-platform subfolders: `deb/`, `rpm/`, and `appimage/` on Linux; `msi/` and `nsis/` on Windows; `dmg/` and `macos/` on macOS. The unbundled executable is in `apps/geolibre-desktop/src-tauri/target/release/`. On Linux, `npm run tauri:build` builds `deb` and `rpm` by default; passing `--bundles` replaces that default selection rather than adding to it, so list every format you want, for example `npm run tauri:build -- --bundles deb,rpm,appimage` for all three.

## Optional imagery credentials

The Street View plugin can use Google Street View and Mapillary imagery. Create `apps/geolibre-desktop/.env.local` and set one or both provider credentials:

```env
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
VITE_MAPILLARY_ACCESS_TOKEN=your_mapillary_access_token
```

For Google Street View, enable the Maps Embed API for the key in Google Cloud. For Mapillary, create an app in the Mapillary developer dashboard and use its client access token.

Restart `npm run dev` or `npm run tauri:dev` after changing environment variables.

## Optional basemap credentials

The **New map** dialog offers [Protomaps](https://protomaps.com) basemaps (Light, Dark, White, Grayscale, Black) when a Protomaps API key is configured. Without a key these options are hidden, and you can still use the OpenFreeMap basemaps or a custom style URL.

Use your own key — create one in the [Protomaps dashboard](https://protomaps.com). Set it one of two ways:

- **For your own deployment** — bake it into the build with the `VITE_PROTOMAPS_API_KEY` environment variable, for example in `apps/geolibre-desktop/.env.local`:

  ```env
  VITE_PROTOMAPS_API_KEY=your_protomaps_api_key
  ```

  In CI/CD, pass it as a build-time environment variable (the GitHub Pages workflow reads it from the `VITE_PROTOMAPS_API_KEY` repository secret). The resulting style URL is `https://api.protomaps.com/styles/v5/<flavor>/en.json?key=<your_key>`.

- **At runtime, no rebuild** — add an environment variable named `VITE_PROTOMAPS_API_KEY` in **Settings → Environment Variables**. The Protomaps basemaps appear as soon as the key is enabled. See [Settings](user-guide/settings.md#environment-variables).

## Optional traffic overlays

The **Basemaps** control includes a **Traffic** category with real-time traffic overlays that stack on top of any basemap (enable the panel's add/multiple toggle). Each provider authenticates with your own API key, set in **Settings → Environment Variables** (or baked into `apps/geolibre-desktop/.env.local`):

```env
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key   # Google Traffic (Map Tiles API)
VITE_TOMTOM_API_KEY=your_tomtom_api_key             # TomTom Traffic Flow
VITE_HERE_API_KEY=your_here_api_key                 # HERE Traffic Flow
```

Google Traffic reuses the same `VITE_GOOGLE_MAPS_API_KEY` as Street View; enable the **Map Tiles API** for that key in Google Cloud. A newly entered key takes effect immediately, without reopening the project. Until a provider's key is set, its overlay reports a missing-key error instead of loading tiles.

## Optional Python sidecar

The optional FastAPI sidecar is reserved for heavier processing workflows and is not required for the desktop UI.

```bash
cd backend/geolibre_server
python -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
```
