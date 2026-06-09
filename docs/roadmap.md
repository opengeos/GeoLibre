# GeoLibre Roadmap

## v0.1: Map viewer and GeoJSON

- [x] Tauri + React + MapLibre shell
- [x] GeoJSON load, layer panel, style panel
- [x] Attribute table (basic)
- [x] Processing UI with local algorithms
- [x] Plugin interface + sample plugins

## v0.2: Project persistence

- [x] `.geolibre.json` save/open
- [x] In-session recent project tracking
- [x] Feature highlight from attribute table
- [x] Optional zoom to selected feature
- [x] Recent projects UI and persistence

## v0.3: Cloud-native formats

- [x] GeoParquet import through DuckDB-WASM
- [x] FlatGeobuf import through DuckDB-WASM and URL-based Components plugin panel
- [x] PMTiles through Components plugin
- [x] COG and GeoTIFF raster rendering
- [x] Zoom to layer for GeoJSON and source-bounds-aware layer types

## v0.4: DuckDB Spatial

- [x] DuckDB-WASM integration
- [x] `INSTALL spatial` / `LOAD spatial`
- [x] Shapefile, KMZ/KML, GeoPackage, GeoParquet, FlatGeobuf, GML, and related vector import paths

## v0.5: Advanced Add Data and plugin-backed layers

- [x] Add Data dialogs for XYZ, WMS, vector files, GeoJSON URLs, vector tiles, raster tile templates, COG and GeoTIFF rasters, MBTiles, and ArcGIS layers
- [x] MapLibre Components plugin with FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splat panels
- [x] Desktop MBTiles metadata and tile reads through Tauri commands
- [x] Plugin control position controls in the Plugins menu
- [x] Layer control integration for GeoLibre-managed layers

## v0.6: Project access, web embeds, and expanded integrations

- [x] Persistent recent projects with desktop file recents and URL-backed web recents
- [x] Separate Open Project from File and Open Project from URL flows
- [x] Browser demo query options for compact layout, icon-only toolbar, and hidden panels
- [x] PostgreSQL layer workflow through desktop Martin server integration
- [x] STAC search workflow for adding catalog-backed raster layers
- [x] Esri Wayback, GeoAgent, GeoEditor, Street View, and Swipe plugin integrations

## v0.7: Add Data expansion, identify, settings, and processing

- [x] GPX loading from URL or local file, with selectable waypoint, track, and route layers
- [x] Delimited text loading from URL or local file using longitude and latitude fields
- [x] WFS GetFeature loading through the Add Data dialog
- [x] WMS GetFeatureInfo identify support with hardened popup handling
- [x] Whitebox toolbox backed by a managed Python sidecar
- [x] Inline attribute editing, horizontal table scrolling, and scrollable identify popups
- [x] Settings dialog for map preferences and runtime environment variables
- [x] Plugin state persistence in project files
- [x] Default GeoJSON sample URL and larger identify popup
- [x] Local raster file loading fix
- [x] Large-file pre-commit guard

## v0.8: Viewer, desktop packaging, plugins, and dynamic layers

- [x] Cloudflare Worker viewer served from `viewer.geolibre.app`
- [x] Browser demo links updated to the production viewer
- [x] GPX drag-and-drop split into named waypoint, track, and route layers
- [x] Vector layers reprojected to EPSG:4326 on load
- [x] Desktop About dialog update check
- [x] Dynamic external plugin zip loading from the app data plugins directory
- [x] Safe fallback for `crypto.randomUUID` in non-secure contexts
- [x] External plugin manifest support with `plugin.json`
- [x] 3D Tiles layer support through `maplibre-gl-3d-tiles`
- [x] 3D Tiles restoration when reopening projects
- [x] GeoParquet panel DuckDB startup fix
- [x] MSIX desktop packaging and cleaner build output
- [x] External native GeoJSON layers registered from local directories
- [x] Raster basemaps registered as external native layers
- [x] Text marker labels rendered on GeoJSON layers
- [x] Manual and automatic refresh for WFS and GeoJSON URL layers
- [x] Multiple DuckDB SQL query-result layers
- [x] Desktop diagnostics panel and improved diagnostics/status bar contrast
- [x] Toolbar toggles for Colorbar, Legend, and HTML panels

## v0.9: Data integrations, processing, and menu reorganization (current)

- [x] SQL Workspace for running DuckDB Spatial SQL against loaded layers, local files, and remote URLs, with sample queries, query history, and adding results to the map or exporting them
- [x] Planetary Computer panel for browsing and loading STAC data
- [x] Earth Engine panel for browsing and loading datasets
- [x] Overture Maps plugin for loading Overture data themes
- [x] Time Slider plugin for animating time series raster and vector data, powered by `maplibre-gl-time-slider`
- [x] Web Services menu with four federal data plugins
- [x] Add Raster Layer powered by the `maplibre-gl-raster` plugin
- [x] Add Vector Layer powered by the `maplibre-gl-vector` plugin
- [x] Identify, selection, and attribute table support for DuckDB layers
- [x] Conversion menu under Processing for Vector to GeoParquet/FlatGeobuf/PMTiles, CSV to GeoParquet, and Raster to COG, backed by a hardened conversion sidecar with a path allowlist
- [x] Whitebox batch tools run against a selected input directory
- [x] Controls menu with Measure, Bookmark, Minimap, and View State tools
- [x] Print menu backed by `PrintControl`
- [x] Project menu consolidating New, Open, Save, and Save As
- [x] Layout settings with per-panel visibility toggles
- [x] Insert before dropdown for placing layers in the stack
- [x] Component panels persisted and controls reset on new project
- [x] Plugins can declare and handle URL query parameters
- [x] `maponly` query parameter for chrome-free map embeds
- [x] Docker support for the browser app
- [x] `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` for offline spatial extension loading

## v1.0: Processing pipelines, external plugin system, and stable prototype

- [ ] GDAL / Rasterio / GeoPandas pipelines
- [ ] Buffer, reproject, and export GeoJSON processing tools
- [ ] Expanded WhiteboxTools coverage
- [ ] Leafmap, GeoAI, and SamGeo integrations (selective)
- [ ] External plugin package distribution workflow
- [x] Plugin marketplace / registry design (see [Plugin marketplace and registry](#plugin-marketplace-and-registry-design))
- [x] Plugin marketplace MVP: curated registry plus browse and install UI
- [x] Plugin update (in-place re-fetch) and uninstall with confirmation
- [ ] Plugin integrity verification (hashes and signing)
- [ ] Sandboxed worker plugins
- [ ] Performance tuning and test suite
- [ ] Cross-platform installers
- [ ] Documentation and tutorials

## Plugin marketplace and registry (design)

This captures the design for the `v1.0` "Plugin marketplace / registry" item. It
builds on the existing external-plugin foundation, the `plugin.json` manifest
contract, HTTPS manifest-URL loading, the desktop app data `plugins/` scan, and
the bundled `public/plugins/` drop-in mechanism, and it relates to the "External
plugin package distribution workflow" and "Sandboxed worker plugins" items.

### Goal

Let users discover, install, update, and remove trusted external plugins from a
curated registry without hand-entering manifest URLs, on both the desktop and
web builds, while keeping the existing trust model in which plugins are trusted
code.

### Registry

- A curated, versioned index published as static JSON (for example
  `registry.json` hosted on `geolibre.app`, or generated from a GitHub
  repository of submissions). No live backend is required for the MVP.
- Each entry carries `id`, `name`, `version`, `description`, `author`,
  `homepage`, `manifestUrl`, `categories`, `minGeoLibreVersion`, optional
  `screenshots`, and an integrity `hash` for the entry bundle.
- The index is fetched over HTTPS and cached; entries point at the same
  `plugin.json` manifests the existing loader already understands.

### Browse and install UI

- A Browse tab in Settings > Plugins lists registry entries with search,
  category filters, and per-entry install, installed, and update states.
- Install reuses the current external-plugin loader: it resolves the entry's
  `manifestUrl`, validates it, and registers the plugin.
  - Desktop: download the bundle into the app data `plugins/<id>/` directory so
    it persists and loads on startup through the existing scan.
  - Web: record the entry's `manifestUrl` in desktop settings (and, for shared
    projects, in the project `plugins.manifestUrls`) so it loads on next open.
- Remove unregisters the plugin and deletes the downloaded bundle (desktop) or
  drops the recorded manifest URL (web).

### Updates and versioning

- Compare the installed `version` against the registry entry, surface an update
  available state, and offer a one-click update that re-fetches the bundle.
- Honor `minGeoLibreVersion` so incompatible plugins are flagged, not installed.

### Trust and security

- The registry is an allowlist; only curated entries are offered for install.
- HTTPS-only manifests (the existing `isAllowedPluginManifestUrl` rule), plus
  integrity verification of the downloaded entry against the registry `hash`.
- Explicit user consent on install, because plugin entries execute as trusted
  code (the desktop CSP permits `blob:` script execution by design).
- Plugin signing and the separate "Sandboxed worker plugins" item harden this
  further; until then the curated registry and integrity checks are the primary
  controls.

### Relationship to bundled plugins

- Bundled `public/plugins/<id>/` drop-ins remain the zero-config way to ship
  first-party or private plugins inside a build. The marketplace covers
  discoverable, user-installed third-party plugins; the two are complementary
  and share the same `plugin.json` contract and loader.

### Phasing

1. Curated static registry plus browse and install through manifest URLs
   (reuses the current loader; records the manifest URL in settings). **Done.**
2. Version checks, update and removal flows, and integrity hashes.
3. Submission workflow for third-party authors, plugin signing, and sandboxed
   execution.

### Implementation (phase 1)

The MVP ships in the desktop app and, because the same frontend serves the web
build, works in both:

- `apps/geolibre-desktop/src/lib/plugin-registry.ts` fetches and normalizes a
  registry (`{ "plugins": [...] }`), resolving each entry's `manifestUrl`
  against the registry location. The registry URL is
  `VITE_GEOLIBRE_PLUGIN_REGISTRY_URL` or a bundled
  `public/plugin-registry.json` fallback.
- `apps/geolibre-desktop/src/components/layout/PluginMarketplace.tsx` renders a
  Browse list in Settings > Plugins with search, install, a confirm step before
  uninstall, an Update action when a newer version is published,
  `minGeoLibreVersion` compatibility checks, and inline error handling.
- Installing records the entry's manifest URL in the plugin manifest URL list,
  so the existing external-plugin loader fetches and registers it. No new trust
  path is introduced. Uninstalling (after confirmation) unregisters the plugin
  at runtime — tearing down any active map control — so the Plugins menu updates
  without a reload. Update re-fetches the manifest URL and re-registers the
  published version in place, fetching the new version before tearing down the
  old one so a failed update leaves the installed plugin intact.
- `public/plugin-registry.json` ships a working same-origin sample plugin
  (`public/marketplace/sample/`) so the marketplace is usable out of the box;
  maintainers add curated external entries to the registry.
