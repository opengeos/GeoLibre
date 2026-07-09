# GeoLibre

[![Launch GeoLibre Web](https://img.shields.io/badge/Launch-GeoLibre%20Web-green.svg)](https://web.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json)
[![GeoLibre shared project](https://img.shields.io/badge/GeoLibre-share-green.svg)](https://share.geolibre.app)
[![GeoLibre plugins](https://img.shields.io/badge/GeoLibre-plugins-green.svg)](https://plugins.geolibre.app)
[![image](https://img.shields.io/pypi/v/geolibre.svg)](https://pypi.python.org/pypi/geolibre)
[![image](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/opengeos/GeoLibre/blob/main/python/examples/getting-started.ipynb)
[![image](https://img.shields.io/conda/vn/conda-forge/geolibre.svg)](https://anaconda.org/conda-forge/geolibre)
[![Conda Recipe](https://img.shields.io/badge/recipe-geolibre-green.svg)](https://github.com/conda-forge/geolibre-feedstock)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/geolibre)
[![Open in StackBlitz](https://img.shields.io/badge/Open%20in-StackBlitz-blue?logo=stackblitz)](https://stackblitz.com/github/opengeos/geolibre)
[![Microsoft Store](https://img.shields.io/badge/Microsoft%20Store-GeoLibre-0078D4?logo=windows)](https://apps.microsoft.com/detail/9nwt67rv531x)
[![AUR version](https://img.shields.io/aur/version/geolibre-bin?logo=archlinux&label=AUR)](https://aur.archlinux.org/packages/geolibre-bin)
[![FlatPark](https://img.shields.io/badge/FlatPark-GeoLibre-4A90D9?logo=flatpak)](https://flatpark.org/apps/app.geolibre.GeoLibre/)
[![image](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20785400.svg)](https://doi.org/10.5281/zenodo.20785400)


A free and open-source, lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data. It runs everywhere you do, in the web browser, on the desktop, on mobile, and inside Jupyter notebooks, all while keeping your data local and private.

GeoLibre is built with **Tauri v2**, **React**, **TypeScript**, **MapLibre GL JS**, **DuckDB-WASM Spatial**, and **deck.gl**. The same workspace runs as a native desktop app, a native Android app, in any modern web browser, and adapts responsively to mobile and small screens.

[![GeoLibre demo showing 3D Tiles rendered on a MapLibre map](https://files.opengeos.org/GeoLibre-demo.webp)](https://web.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json)

**Video tutorials:**

- [GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere (Browser, Desktop & Jupyter)](https://youtu.be/87Cm0QagtxI)
- [Geoprocessing in the Browser: 700+ Free GIS Tools in GeoLibre, Zero Install](https://youtu.be/W32bIQO_nG8)

## Features (v1.10)

- Runs across desktop (Tauri), web (browser), native Android (Tauri v2 mobile), and mobile or small screens, with a responsive, touch-friendly layout that adapts menus, dialogs, and panels (on phones the Layers/Style panels overlay the map as slide-over sheets), plus per-panel visibility through Layout settings
- MapLibre map workspace with OpenFreeMap, Protomaps, EOX Sentinel-2 cloudless, and Openbasiskaart basemaps, stacking of multiple raster basemaps, blank background support, double-click to swap the core basemap from the layer panel, a right-click context menu for reading coordinates and quick actions, a Gridlines coordinate-grid overlay with edge labels, and toggleable navigation, fullscreen, geolocation, globe, terrain, scale, attribution, and logo controls, plus a View menu with viewport history navigation, a reset pitch and bearing control, and a distinct north arrow
- Multi-map grid that splits the workspace into a grid of synchronized map views, so you can compare basemaps, layers, or time steps side by side, with any pane switchable to an optional CesiumJS 3D globe (camera-synced with the 2D maps; requires a Cesium Ion token — see [Environment variables](#environment-variables))
- Load local vector layers supported by DuckDB-WASM Spatial, including common formats such as GeoJSON, GeoParquet, GeoPackage, Shapefile, FlatGeobuf, KML/KMZ (honoring embedded symbology), GML, delimited text, GPX, and OpenStreetMap PBF extracts (parsed in-browser with osmix)
- Reproject vector layers to EPSG:4326 on load and split dragged GPX files into named waypoint, track, and route layers
- Large local vector layers render through client-side vector tiling, with a warning before loading very large files
- Add Data menu for XYZ tiles, WMS and WFS (with layers and feature types discovered from the service's GetCapabilities so you pick from a populated dropdown), GeoJSON URLs, GeoRSS feeds (URL or file), vector tiles (including OGC API - Tiles vector tile services), COG and GeoTIFF rasters, Cloud-Optimized NetCDF/HDF (via kerchunk references) plus local HDF5 and NetCDF-4 files, MBTiles, ArcGIS FeatureServer and VectorTileServer layers, PMTiles, Zarr, LiDAR, 3D Tiles (including authenticated tilesets via custom request headers), ArcGIS I3S scene layers (Integrated Mesh and 3D Object layers rendered on deck.gl), CAD drawings (DXF/DWG) with a drawing-layer picker and CRS selector, Gaussian splats, glTF/GLB 3D models placed at coordinates, georeferenced video overlays, and geotagged photos imported as a point layer from their EXIF GPS (with manual placement and drag for photos lacking coordinates), with a fully internationalized dialog, comma decimal support, drag-and-dropped CSV coordinate files, sample-data dropdowns on every upstream-backed panel for loading ready-made example datasets, and a saved service library for storing and re-adding frequently used web-service endpoints
- Deck.gl Layer builder for composing deck.gl overlays from uploaded files or remote URLs
- Cloud data integrations through the Planetary Computer and Earth Engine panels, the Overture Maps plugin, and federal Web Services plugins
- Manual and automatic refresh for WFS, GeoJSON URL, and Add Vector Layer URL layers
- Layer panel for visibility, opacity, reordering, rename, zoom-to-layer, identify, labels, open attribute table, export, and remove actions, with collapsible layer groups/folders for organizing the layer stack and a Search places box in the footer for geocoding to a location without leaving the panel
- Live style panel with single, categorized, graduated, expression, and rule-based (filter-driven) symbology (fill, stroke, opacity, circle radius), proportional symbols, fill patterns, a built-in marker library, plus point heatmap and clustering renderers — all including for Add Vector Layer point layers, plus an inline color ramp picker that previews each colormap's gradient on the trigger and beside every option, and a transparent (no fill / no outline) option in the color picker
- Label engine for labeling vector features by any attribute, with ArcGIS-style placement and styling controls (anchor, X/Y offset, rotation, wrap width, letter case), a Duplicate labels option, and unique/concatenate modes that collapse points stacked at the same coordinate into a single deduplicated label
- Attribute table with filtering, sorting, resize controls, feature highlighting, optional zoom to selected features, add-field and field-calculator tools, a Charts panel (histogram, scatter, bar, line, box), a field statistics summary panel, column management (rename, delete, hide/show, reorder) with a column explorer for finding and toggling fields in wide tables, virtualized rows for large layers, and export to GeoJSON/GeoParquet/Shapefile/GeoPackage/CSV
- SQL Workspace for running DuckDB Spatial SQL against loaded layers, local files, and remote URLs, docked as a resizable panel beside the map with editor autocomplete for tables, columns, and SQL keywords, sample queries, query history, and adding results to the map or exporting them, plus an in-browser PostGIS SQL engine via PGlite and an Apache Sedona spatial SQL engine
- Multiple DuckDB SQL query-result layers with identify, selection, and attribute table support
- Controls menu with Measure, Bookmark, Minimap, View State, and Map annotation tools (draw text, arrows, and highlights on the map, saved with the project), a Search panel, persistent mode banners for the Directions and Reverse Geocode tools, a Camera Tour recorder that captures an animated keyframe tour to video (with per-keyframe recapture, per-keyframe hold and transition duration controls, and saving/loading a named tour setup as JSON), a Dashboard panel of configurable chart widgets that summarize the loaded layers, and a Print menu with a print layout composer (user-editable legend, explicit map-scale input, title block with editable title and footer, page-size controls, a custom print extent, and Copy to Clipboard) that exports the map to PNG or PDF
- Bookmarks that capture the active layers alongside the camera, organized into folders, with selectable export, a resizable and reorderable panel, and a save-as name prompt
- Field Collection tool for capturing point, line, and polygon observations with a per-layer custom form (text/number/date/choice fields and an optional photo), placed by device GPS or by tapping the map, written to a GeoJSON layer that flows into the attribute table, export, and offline use
- Story map builder that composes its chapters directly on the live map, with a presenter view, dedicated start and closing slides, an optional hide-itinerary toggle, a printable PDF handout generator (with subtitle and byline fields), and standalone HTML export
- Real-time multi-user collaboration (MVP; requires the `VITE_GEOLIBRE_COLLAB_URL` build variable — see [docs/collaboration.md](docs/collaboration.md)) so several people can edit the same project together, with per-participant permissions, an in-app chat panel, and an on-canvas session-status badge and roster (live dot, connected-participant count, and an expandable client list) while a session is active
- Natural-language GIS assistant that turns plain-English requests into auditable, undoable GeoLibre operations (Spatial SQL, symbology, add/remove data, and map control), provider-pluggable with your own API key and a dedicated AI Providers settings section with per-feature provider dropdowns
- In-app Python Console plus a Python automation API for scripting the app
- Notebook panel docked beside the map for running Jupyter against the live map: the web build embeds a self-hosted JupyterLite site (in-browser Pyodide kernel) and the desktop build launches a uv-managed JupyterLab server, with notebook cells driving the map through an auto-loaded `geolibre` client. See [Notebook Panel](docs/notebook.md)
- Command palette (`Ctrl`/`Cmd` + `K`) that searches and runs menu and toolbar actions across Add Data, Processing, Controls, Plugins, and Help, global keyboard shortcuts for New/Open/Save/Save As and Google Earth-style camera resets (`N` north up, `U` top-down, `R` reset view), and a `?` shortcuts cheat sheet
- Conversion menu for Vector to GeoParquet/FlatGeobuf/PMTiles, a generic Vector to Vector converter that translates between any supported vector formats by file extension, CSV to GeoParquet, and Raster to COG; GeoParquet and CSV conversions run in the browser with DuckDB-WASM, while FlatGeobuf, PMTiles, and COG require the optional Python sidecar
- Whitebox toolbox that runs entirely in the browser through a WebAssembly runtime with raster I/O (no Python sidecar required), surfacing both Whitebox tools and GeoLibre's own WASM raster tools, browsable by category directly in the Processing menu with nested subcategory submenus and an offline-bundled tool catalog, with batch tools run against a selected input directory
- Vector menu with common geometry and analysis tools (buffer, centroids, convex hull, dissolve, bounding box, simplify, clip, intersection, difference, union, spatial join, attribute join, select by value, select by location, movement, space-time, and cell coverage) that run in the browser with Turf.js, an optional GeoPandas sidecar engine for every tool, and an in-browser GeoPandas engine via Pyodide (no server, same results as the sidecar)
- Raster menu with common raster tools (hillshade, slope, aspect, reproject, resample, clip by extent, clip by mask layer, polygonize, contour, zonal statistics, raster calculator, reclassify, mosaic, focal statistics) backed by a rasterio Python sidecar, with a client-side fallback so core tools also run in the browser when no sidecar is available
- Spectral Index toolbox (NDVI, GNDVI, NDWI, NDMI, NDBI, NBR, EVI, SAVI) with Sentinel-2, Landsat 8-9, NAIP, and custom band layouts, evaluated client-side with geotiff.js or on the rasterio sidecar
- Spatial Statistics toolbox and a Processing batch runner with model/pipeline chaining to run a sequence of tools as one job
- Raster Georeferencer (Processing → Georeferencing) that pins a non-georeferenced image to the map with ground control points using a least-squares affine fit, reporting per-GCP and RMS residuals
- Single-band pseudocolor with classification, reversed and custom color ramps, the full colormap list shown as inline gradient swatches in the Color ramp picker, a Legend populated automatically from a paletted raster's embedded color table, and RGB band combination for styling raster layers, plus COG pixel-value inspection from the Identify icon
- Network analysis tools for isochrones, service areas, origin–destination (OD) cost matrices, and sequential routes (directions) through an ordered set of waypoints
- Geocoding tools for forward, batch, and reverse geocoding through a multi-provider abstraction
- AI Segmentation (SamGeo) that turns imagery into vector features with [segment-geospatial](https://github.com/opengeos/segment-geospatial) and Meta's SAM 3 — text prompts ("trees", "buildings") or automatic segmentation, proxied to a separate `samgeo-api` model server (GPU recommended)
- H3 tools to create hexagonal grids over an extent and bin point layers into H3 cells
- Undo/redo for layer and style operations
- Drag and drop vector and GeoTIFF/COG raster files onto the map to add them as layers
- Project menu to create, open, save, and Save As `.geolibre.json` projects, export a project to a single standalone interactive HTML file that runs offline with no server, and a project gallery for browsing and opening shared projects with one click
- Desktop diagnostics panel, a guided update workflow with a startup update check and update preferences, and MSIX packaging support, with macOS installers signed with an Apple Developer ID certificate and notarized by Apple so they open without a Gatekeeper workaround, plus Windows Package Manager (winget) distribution as `OpenGeos.GeoLibre` and a Windows portable zip build that runs without installation
- Customizable UI profiles that tailor which menus, panels, and data sources are visible, so a deployment can present a focused subset of the app to its users. See [UI Profiles](docs/ui-profiles.md)
- Plugin system with basemap, layer control, MapLibre components, swipe, street view, Overture Maps, USGS LiDAR, GeoAgent, and GeoEditor integrations (the GeoEditor can pull the vector features currently visible in the map view into the editor for editing without re-importing the source), including configurable control positions and external plugin manifests; external plugins can render on the host's shared deck.gl instance via `app.getDeckGL()`, use the maplibre-gl-raster stack and the map projection control, register native raster and tile layers, register first-class right-sidebar panels, toolbar menus, and floating panels through the plugin UI host API (including a shared-rail replace-style dock mode), and place their toolbar menus after the Help menu
- Time Slider plugin for animating time series raster and vector data, including binding existing vector layers already on the map to the timeline and a pixel time-series chart that plots a sampled pixel's value across a raster stack
- Atmosphere Effects plugin that renders a deep-space backdrop, parallax starfield, comets, and an atmospheric halo around the globe at low zoom (technique adapted from [Leonel Dias](https://leoneljdias.github.io/posts/globe-atmosphere-halo-comets/)), with a Spinning Globe panel and customizable atmosphere halo and deep-space colors
- Directions plugin for interactive routing via [maplibre-gl-directions](https://github.com/maplibre/maplibre-gl-directions): click the map to add waypoints, drag to reposition, and click a waypoint to remove it (uses the public OSRM demo server, driving only)
- Install external plugins from an uploaded zip on both desktop and web, plus external plugin zip loading from the app data plugins directory and local development plugin directories, with the Manage Plugins list sorted alphabetically
- Bundled drop-in plugins under `public/plugins/<id>/` that bake into both the web and desktop builds and load automatically with no manifest URL
- Browser deployment with Docker, embed-friendly URL parameters (including `?url=` project deep links that skip the welcome wizard and a `?welcome=0` param to opt out of onboarding), and a `maponly` chrome-free mode
- Native Android app built from the same codebase with Tauri v2 mobile, producing signed, per-architecture APKs (~40 MB) through a GitHub Actions workflow; tools that depend on a local desktop process (Whitebox, Raster, Conversion, AI Segmentation, PostgreSQL/Martin) are hidden on mobile so nothing is shown that cannot run. See [Android](docs/android.md)
- Installable, offline-capable Progressive Web App (PWA) build, plus a **Download Offline Area** tool that pre-caches the current map view's basemap tiles, and service-worker caching of the CDN-loaded Pyodide and PGlite/PostGIS engines so browser SQL and Python keep working offline after first use
- Internationalization framework with react-i18next and per-build translation catalogs, plus a `?locale`/`?lang` query parameter to set the embed language
- Accessibility pass with axe-checked screens, keyboard navigation, and screen-reader labels
- App-wide, section, and plugin React error boundaries that contain failures and keep the rest of the workspace usable
- Python package (`geolibre`) that embeds the full app in Jupyter notebooks as an [anywidget](https://anywidget.dev), with an expanded leafmap-style API (local raster, marker/cluster, and choropleth layers; `split_map`, `add_legend`, and `add_colorbar` helpers; typed read-back of selected/drawn features; and `to_html` export) and two-way project sync
- Optional Python FastAPI sidecar for heavier processing workflows

## Prerequisites

- **Node.js** 22+
- **Rust** toolchain ([rustup](https://rustup.rs/)) for Tauri desktop builds
- Linux: `webkit2gtk`, `libayatana-appindicator` (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

## Install

Prebuilt desktop installers for Linux, Windows, and macOS are published on the
[Releases](https://github.com/opengeos/GeoLibre/releases) page. On Windows you
can install the signed, auto-updating build from the
[Microsoft Store](https://apps.microsoft.com/detail/9nwt67rv531x), or the
unsigned GitHub Release build via `winget install OpenGeos.GeoLibre`. On macOS
you can install and update with Homebrew — GeoLibre is in the official
[Homebrew Cask](https://github.com/Homebrew/homebrew-cask/blob/main/Casks/g/geolibre.rb)
repository, so no tap is required:

```bash
brew install --cask geolibre
```

The macOS app is signed with an Apple Developer ID certificate and notarized by
Apple, so it launches normally with no quarantine workaround. See
[Downloads](docs/downloads.md) for details and the manual install steps.

To build from source instead:

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

## Run (web dev, map in browser)

```bash
npm run dev
```

Open http://localhost:5173. The map and browser vector import support local vector files that DuckDB-WASM Spatial can read, including common formats such as GeoJSON, GeoParquet, GeoPackage, Shapefile, FlatGeobuf, KML/KMZ, and GML, with direct handling for GeoJSON, zipped Shapefiles, and KMZ archives. You can choose files from Add Vector Layer or drag them onto the app. GeoTIFF/COG rasters can also be dragged onto the map to add them as raster layers. Desktop filesystem dialogs, local MBTiles, and local raster file reads require Tauri.

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

Only a single statement is supported per run. Cloud object-store URLs (`s3://`, `gs://`, `az://`) are transparently rewritten to their public HTTPS equivalents, so they work for anonymous / public datasets.

## Vector tools

The **Processing → Vector** menu opens a single Vector tools dialog with common geometry operations that run against your loaded GeoJSON layers. Pick a tool, choose the input layer (and an overlay layer for the two-layer tools), set the parameters, and the result is added to the map as a new layer.

- **Geometry tools.** **Buffer** (by a distance in kilometers, meters, or miles), **Centroids** (one centroid point per feature), **Convex hull** (a single polygon enclosing all features), **Dissolve** (merge polygons, optionally grouped by an attribute field), **Bounding box** (the rectangular envelope of all features), **Simplify** (Douglas-Peucker vertex reduction), **Smooth** (spline-based line/polygon smoothing), **Regular grid** (a point or polygon grid over an extent), and **Voronoi / Delaunay** (Voronoi polygons or a Delaunay triangulation from a point layer).
- **Overlay tools.** **Clip** (clip the input to an overlay layer, keeping input attributes), **Intersection**, **Difference**, and **Union** between two polygon layers.
- **Join tools.** **Spatial join** (attach a join layer's attributes to each input feature by a spatial relationship — intersects, within, or contains — with an inner or left join, for any geometry type) and **Attribute join** (attach a join table's attributes by a matching key field, no geometry — e.g. join census stats to boundary polygons — choosing which fields to bring over, with an inner or left join).
- **Select tools.** **Select by value** (extract features whose attribute matches a condition — =, ≠, >, ≥, <, ≤, contains, starts with, is empty/not empty) and **Select by location** (extract features by their spatial relationship to a second layer — intersects, within, contains, or disjoint) into new layers.
- **Three engines.** Every tool runs fully in the browser with [Turf.js](https://turfjs.org/), so no sidecar is required. Every tool can also run on the optional GeoPandas sidecar for projection-aware results; when the sidecar is unavailable the dialog falls back to the client engine. A third **Python (Pyodide)** engine runs the same GeoPandas/Shapely code as the sidecar but **entirely in the browser** via [Pyodide](https://pyodide.org) — no server, so it works on the web build too. The first run lazily downloads the Python runtime from a CDN (override with `VITE_PYODIDE_INDEX_URL` to self-host for offline use); results match the sidecar because both share one `vector_ops.py`.

To enable the sidecar engine, install the optional `vector` extra (it is not bundled by default to keep the sidecar small):

```bash
# install the vector extras (GeoPandas, Shapely)
pip install -e "backend/geolibre_server[vector]"
# run it
geolibre-server   # or: uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
```

## Raster tools

The **Processing → Raster** menu opens a single Raster tools dialog with common raster operations. Because raster processing cannot run in the browser, these tools run on the Python sidecar (rasterio) with a file path in and a file path out: pick a tool, choose an input raster and an output file, set the parameters, and run the job.

- **Terrain.** **Hillshade**, **Slope** (degrees or percent), and **Aspect** from an elevation model.
- **Reproject.** **Reproject** to a target CRS and **Resample** to a new pixel size, with selectable resampling (nearest, bilinear, cubic).
- **Clip.** **Clip by extent** (a bounding box in the raster's CRS) and **Clip by mask layer** (a GeoJSON mask, reprojected to the raster automatically).
- **Raster to vector.** **Polygonize** (vector polygons grouped by pixel value) and **Contour** (contour lines from an elevation model), written as GeoJSON.
- **Vector to raster.** **Interpolation (IDW / Kriging)** turns a point layer's numeric attribute into a continuous raster surface via inverse distance weighting or ordinary kriging.

The tools share the conversion sidecar job runner. Install the optional `raster` extra (rasterio is also pulled in by the `conversion` extra):

```bash
# install the raster extras (rasterio, numpy, contourpy)
pip install -e "backend/geolibre_server[raster]"
# run it
geolibre-server   # or: uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
```

## AI segmentation

The **Processing → AI Segmentation** dialog turns imagery into vector features with [segment-geospatial](https://github.com/opengeos/segment-geospatial) (SamGeo) and Meta's **SAM 3** model: choose a GeoTIFF, type a text prompt (e.g. "trees", "buildings", "water") or run automatic segmentation, and the resulting polygons are added as a new layer.

The model stack does not run inside the sidecar. The sidecar exposes a thin `/ml` reverse-proxy in front of a separate `samgeo-api` server (the REST server shipped with `segment-geospatial`), which runs SAM 3 and returns GeoJSON. A CUDA GPU is strongly recommended.

```bash
# install the model server (in an env with a working PyTorch build)
pip install "segment-geospatial[api,samgeo3]"
# install the sidecar's ml extra (just an HTTP client; models live in samgeo-api)
pip install -e "backend/geolibre_server[ml]"
```

`samgeo-api` is launched on demand when it's on the `PATH`, or point the sidecar at an existing server with `GEOLIBRE_ML_SAMGEO_URL=http://127.0.0.1:8000`. See [docs/user-guide/segmentation.md](docs/user-guide/segmentation.md) for details. Uses SAM 3.

## Embed the demo

The browser demo supports URL parameters for iframe-friendly layouts.

Open a project by URL:

<https://web.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json>

Supported query parameters:

| Parameter    | Example                                                  | Description                                                                                                                 |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `url`        | `url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json` | Loads a `.geolibre.json` project from a public URL.                                                                         |
| `layout`     | `layout=compact`                                         | Uses the compact embed layout with icon-only toolbar buttons and hidden project metadata. `embed` and `iframe` are aliases. |
| `toolbar`    | `toolbar=icons`                                          | Shows icon-only toolbar buttons without enabling the full compact layout.                                                   |
| `panels`     | `panels=none`                                            | Hides the Layers, Style, and Attribute table panels. `hidden`, `hide`, and `off` are aliases.                               |
| `hidePanels` | `hidePanels=true`                                        | Alternative way to hide the Layers, Style, and Attribute table panels.                                                      |
| `maponly`    | `maponly`                                                | Hides all chrome (toolbar menu, Layers/Style/Attribute panels, and status bar), leaving only the map. The bare flag or any of `true`, `1`, `yes`, `on` enable it. |
| `theme`      | `theme=dark`                                             | Sets the initial color theme on load, overriding the OS preference. Accepts `dark` or `light`; the in-app toggle still works afterwards. |

Use compact mode for narrow embeds. This shows icon-only toolbar buttons and hides project metadata:

```text
https://web.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json&layout=compact
```

Hide the Layers, Style, and Attribute table panels for map-focused embeds:

```text
https://web.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json&layout=compact&panels=none
```

Use `toolbar=icons` when you only want icon-only toolbar buttons. `panels=hidden`, `panels=hide`, `panels=off`, and `hidePanels=true` are accepted aliases for hiding panels.

For a fully chrome-free, map-only embed, use `maponly`. It hides the toolbar menu, all panels, and the status bar:

```text
https://web.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json&maponly
```

## Python package (Jupyter)

GeoLibre ships a Python package that embeds the **full** GeoLibre app (menus,
panels, processing tools) in a Jupyter notebook cell as an
[anywidget](https://anywidget.dev), with a leafmap-style API. State syncs both
ways through a single `.geolibre.json` project, so data you add from Python
appears in the UI, and edits you make in the UI are readable back from Python.

```bash
pip install geolibre
```

Or with conda:

```bash
conda install -c conda-forge geolibre
```

```python
from geolibre import Map

m = Map(center=(-100, 40), zoom=4)
m.add_geojson("https://example.com/data.geojson", name="Data")
m.add_tile_layer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", name="OpenStreetMap")
m.add_cog("https://example.com/dem.tif", name="DEM")
m  # the full GeoLibre UI renders in the cell
```

Read state edited in the UI, and round-trip projects:

```python
m.to_project()["mapView"]["center"]   # reflects the live UI view after panning
m.save_project("my-map.geolibre.json")
Map().load_project("my-map.geolibre.json")
```

The package source lives in [`python/`](python/), and the bundled web app is
built into the wheel by `npm run build:embed`. The interactive widget works in
local Jupyter, VS Code, Google Colab (its built-in port proxy is used
automatically), and JupyterHub / remote servers (through a Jupyter Server
extension bundled with the wheel and auto-enabled on install, so managed hubs
work without `jupyter-server-proxy`; pass `Map(server_proxy=True)` on non-Hub
remote setups). See the [Python package guide](docs/python.md) for the full API.

## Environment variables

The Street View plugin can use Google Street View and Mapillary imagery. Create `apps/geolibre-desktop/.env.local` and set one or both provider credentials:

```env
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
VITE_MAPILLARY_ACCESS_TOKEN=your_mapillary_access_token
```

For Google Street View, enable the Maps Embed API for the key in Google Cloud. For Mapillary, create an app in the Mapillary developer dashboard and use its client access token.

The optional **Cesium 3D-globe view** — a split-pane globe rendered with [CesiumJS](https://cesium.com/platform/cesiumjs/) alongside the 2D MapLibre map — needs a [Cesium Ion](https://ion.cesium.com/) access token for its world imagery and terrain. Create a free Ion account, copy your default access token, and set it at build time:

```env
CESIUM_TOKEN=your_cesium_ion_access_token
```

`CESIUM_TOKEN` (or the `VITE_`-prefixed `VITE_CESIUM_TOKEN`) is read by `vite.config.ts` and baked into the build. A user can **also set it at runtime** — with no rebuild — in the Settings dialog's **Environment Variables** section, which has a dedicated masked **Cesium Ion token** field. That token is stored locally on the device (in browser storage on the web build), **not** in the shared project file, and overrides the build-time value; it is how a web user brings their own Ion token. (A free-form `VITE_CESIUM_TOKEN` variable in the same section still works and takes precedence, as an override.) Without a token from any source, the 3D-globe toggle is hidden entirely (the 2D map is unaffected). Ion access tokens are designed to ship in client bundles. See [docs/architecture.md](docs/architecture.md#3d-globe-view-cesiumjs) for how the globe integrates.

The optional **Python (Pyodide)** vector engine loads its runtime from the public jsDelivr CDN by default. To self-host it for offline or production use, point it at a mirrored copy of the Pyodide distribution:

```env
VITE_PYODIDE_INDEX_URL=https://your-host/pyodide/v0.27.7/full/
```

Similarly, the DuckDB Spatial extension is installed from DuckDB's remote
extension repository by default. To load it from a mirror instead (so
`INSTALL spatial` is skipped and the extension is loaded directly), set the full
path or URL to the extension file:

```env
VITE_DUCKDB_SPATIAL_EXTENSION_PATH=https://your-host/duckdb/spatial.duckdb_extension.wasm
```

Both `VITE_PYODIDE_INDEX_URL` and `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` can also be set at runtime through the Settings dialog's runtime environment variables (no rebuild required), so air-gapped or corporate deployments can point Pyodide and the DuckDB Spatial extension at internal mirrors without rebuilding.

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

The default desktop build keeps the Linux binary small and uses DuckDB-WASM for
DuckDB-backed browser features. To build a larger desktop binary with the native
`duckdb-rs` vector loader enabled, run:

```bash
npm run tauri:build:native-duckdb
```

Where to find the output:

- **Web build** — static files in `apps/geolibre-desktop/dist/`. Serve this directory with any static web server (or the Docker image above).
- **Desktop installers** — `apps/geolibre-desktop/src-tauri/target/release/bundle/`, with per-platform subfolders: `deb/`, `rpm/`, and `appimage/` on Linux; `msi/` and `nsis/` on Windows; `dmg/` and `macos/` on macOS. The unbundled executable is in `apps/geolibre-desktop/src-tauri/target/release/`. On Linux, `npm run tauri:build` builds `deb` and `rpm` by default; passing `--bundles` replaces that default selection rather than adding to it, so list every format you want, for example `npm run tauri:build -- --bundles deb,rpm,appimage` for all three.

## Android

GeoLibre builds as a native Android app from the same codebase via Tauri v2
mobile. You need the Android SDK + NDK, a JDK (17 or 21), and the Rust Android
targets; see [docs/android.md](docs/android.md) for the full toolchain setup,
signing, and sideloading guide. Once set up:

```bash
cd apps/geolibre-desktop
npx tauri android init                          # generate the Gradle project (once)
npm run tauri android dev                        # run on a connected device/emulator
npx tauri android build --apk --split-per-abi    # release APKs, ~40 MB per ABI
```

Install the `arm64-v8a` APK on real phones. The CI workflow
(`.github/workflows/android.yml`) builds and signs per-ABI release APKs on each
published GitHub release (and on demand via the "Run workflow" button) and
uploads them as artifacts; set the `ANDROID_KEYSTORE_*` repository secrets
to sign with a real release key (otherwise a debug key is used for testable
builds). Heavy tools that need the Python sidecar or local helper processes are
hidden on mobile.

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
python/                 # geolibre Python package (Jupyter anywidget)
docs/                   # Architecture & API docs
```

## Add a plugin

Built-in plugins live in `packages/plugins/src/plugins/` and are registered by the desktop app in `apps/geolibre-desktop/src/hooks/usePlugins.ts`. Map control plugins can expose a control position through `getMapControlPosition()` and `setMapControlPosition()` so the Plugins menu can move them between map corners.

For external plugin development, start from the [GeoLibre plugin template](https://github.com/opengeos/geolibre-plugin-template). It includes a `plugin.json` manifest, a GeoLibre plugin wrapper entry point, and a `package:geolibre` script that creates a zip file for the desktop app data `plugins/` directory. During development, Settings → Manage Plugins can scan an additional local plugin directory, including an unpacked bundle folder such as the template's `geolibre-plugin/` directory, or a hosted `plugin.json` manifest URL. See the [Plugin API](docs/plugin-api.md) for the external plugin contract.

To bake an external plugin into the build so it loads automatically — with no Settings entry and no manifest URL — drop its built folder into `apps/geolibre-desktop/public/plugins/<plugin-id>/` (the same `plugin.json` + `dist/` a manifest URL would serve). The `bundledPlugins()` Vite plugin discovers it at build time and the app loads it through the normal external-plugin path. The same folder serves both the web build and the desktop build (which ships the same frontend), so one drop-in covers both. Private plugin bundles are git-ignored under that folder and copied in at build/deploy time. See the [Plugin API](docs/plugin-api.md#bundled-plugins-baked-into-the-build) for details and the security model.

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

Full documentation, including the User Guide and Tutorials, is published at
**[geolibre.app](https://geolibre.app)**.

- **User Guide** - a [feature-by-feature reference](https://geolibre.app/user-guide/interface/) for the interface, adding data, layers, styling, the attribute table, map controls, processing, the SQL Workspace, data integrations, plugins, settings, and embedding.
- **Tutorials** - [hands-on, end-to-end workflows](https://geolibre.app/tutorials/): your first map, cloud-native data, vector analysis, terrain analysis, spatial SQL, and sharing and embedding.
- **Reference**
  - [Architecture](docs/architecture.md)
  - [Android](docs/android.md)
  - [Project format](docs/project-format.md)
  - [Plugin API](docs/plugin-api.md)
  - [UI Profiles](docs/ui-profiles.md)
  - [Python package (Jupyter)](docs/python.md)
  - [Roadmap](docs/roadmap.md)
  - [How to Cite](docs/citation.md)

## Acknowledgements

GeoLibre is built on the free and open-source geospatial and web communities — including MapLibre GL JS, deck.gl, DuckDB-WASM Spatial, Turf.js, Tauri, React, and many more. See the full [Acknowledgements](https://geolibre.app/acknowledgements/) page for the complete list of projects and community contributors.

- The **Atmosphere Effects** plugin (deep-space backdrop, parallax starfield, comets, and the globe atmosphere halo) adapts the technique and visual design from [Leonel Dias](https://leoneljdias.github.io/)'s article [*Globe atmosphere, halo, and comets*](https://leoneljdias.github.io/posts/globe-atmosphere-halo-comets/) — the layered Canvas 2D approach, the halo gradient and "screen" blend, the limb-sampling that keeps the halo aligned under pitch, and the starfield/comet parameters.
- **Community contributors** — thanks to [**Ryanphoenix**](https://github.com/Ryanphoenix) for many valued contributions, including issue reports, feedback, and improvements.
- **Beta testers** — thanks to [**René van der Velde**](https://github.com/renevandervelde) (Netherlands) for early testing, detailed bug reports, and feature requests.

## Citation

If you use GeoLibre in your work, please cite it. GeoLibre is archived on [Zenodo](https://zenodo.org/), which mints a DOI for every release. The concept DOI below always resolves to the latest version.

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20785400.svg)](https://doi.org/10.5281/zenodo.20785400)

> Wu, Q. (2026). GeoLibre: A lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data. Zenodo. <https://doi.org/10.5281/zenodo.20785400>

You can also use GitHub's **"Cite this repository"** button (which reads [`CITATION.cff`](CITATION.cff)) to copy a ready-made APA or BibTeX entry. See the [How to Cite](https://geolibre.app/citation/) page for more formats.

## License

MIT
