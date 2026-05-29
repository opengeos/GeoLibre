# GeoLibre Desktop Roadmap

## v0.1: Map viewer and GeoJSON (current)

- [x] Tauri + React + MapLibre shell
- [x] GeoJSON load, layer panel, style panel
- [x] Attribute table (basic)
- [x] Processing UI with local algorithms
- [x] Plugin interface + sample plugins

## v0.2: Project persistence

- [x] `.geolibre.json` save/open
- [ ] Recent projects list (persistence)
- [ ] Feature highlight from attribute table

## v0.3: Cloud-native formats

- [ ] PMTiles
- [ ] FlatGeobuf
- [ ] GeoParquet
- [ ] COG (raster)
- [ ] Zoom to layer for all types

## v0.4: DuckDB Spatial

- [ ] DuckDB-WASM integration
- [ ] `INSTALL spatial` / `LOAD spatial`
- [ ] SQL panel and query-result layers

## v0.5: Python processing sidecar

- [ ] Bundle FastAPI server as Tauri external bin
- [ ] GDAL / Rasterio / GeoPandas pipelines
- [ ] Buffer, reproject, export GeoJSON
- [ ] WhiteboxTools, Leafmap, GeoAI, SamGeo (selective)

## v0.6: Plugin system

- [ ] External plugin packages
- [ ] Plugin marketplace / registry (design)

## v1.0: Stable prototype

- [ ] Performance tuning, test suite
- [ ] Cross-platform installers
- [ ] Documentation & tutorials
