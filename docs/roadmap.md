# GeoLibre Desktop Roadmap

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
- [ ] Plugin marketplace / registry (design)
- [ ] Sandboxed worker plugins
- [ ] Performance tuning and test suite
- [ ] Cross-platform installers
- [ ] Documentation and tutorials
