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
- [ ] Recent projects UI and persistence

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

## v0.5: Advanced Add Data and plugin-backed layers (current)

- [x] Add Data dialogs for XYZ, WMS, vector files, GeoJSON URLs, vector tiles, raster tile templates, COG and GeoTIFF rasters, MBTiles, and ArcGIS layers
- [x] MapLibre Components plugin with FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splat panels
- [x] Desktop MBTiles metadata and tile reads through Tauri commands
- [x] Plugin control position controls in the Plugins menu
- [x] Layer control integration for GeoLibre-managed layers

## v0.6: SQL and processing sidecar

- [ ] Bundle FastAPI server as Tauri external bin
- [ ] GDAL / Rasterio / GeoPandas pipelines
- [ ] Buffer, reproject, export GeoJSON
- [ ] WhiteboxTools, Leafmap, GeoAI, SamGeo (selective)
- [ ] SQL panel and query-result layers

## v0.7: Plugin system

- [ ] External plugin packages
- [ ] Plugin marketplace / registry (design)
- [ ] Dynamic plugin loading from a `plugins/` directory
- [ ] Plugin manifest (`plugin.json`)
- [ ] Sandboxed worker plugins

## v1.0: Stable prototype

- [ ] Performance tuning, test suite
- [ ] Cross-platform installers
- [ ] Documentation & tutorials
