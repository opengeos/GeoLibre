# GeoLibre Desktop

Lightweight, cloud-native desktop GIS prototype built with **Tauri v2**, **React**, **TypeScript**, and **MapLibre GL JS**.

## Features (v0.1 MVP)

- MapLibre map with OpenFreeMap Liberty basemap
- Load local GeoJSON layers
- Layer panel (visibility, opacity, reorder, remove)
- Live style panel (fill, stroke, opacity, circle radius)
- Attribute table for GeoJSON
- Save/open `.geolibre.json` projects
- Processing toolbox (bounds, count + placeholders)
- Plugin system (basemap + sample GeoJSON plugins)
- Optional Python FastAPI sidecar (design only)

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

## Run (web dev — map in browser)

```bash
npm run dev
```

Open http://localhost:1420 — map works; file dialogs require Tauri.

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

## Documentation

- [Architecture](docs/architecture.md)
- [Project format](docs/project-format.md)
- [Plugin API](docs/plugin-api.md)
- [Roadmap](docs/roadmap.md)

## License

MIT
