# GeoLibre

GeoLibre is an open-source Rust desktop GIS prototype focused on cloud-native
geospatial formats, modular architecture, and MapLibre-based rendering.

This repository currently contains **GeoLibre Desktop**, a lightweight MVP
inspired by QGIS but intentionally scoped as a prototype, not a full replacement.

## MVP Features

- Native desktop shell using `wry` and MapLibre GL JS in an embedded webview
- Central globe map canvas, layer panel, properties panel, toolbar, and status bar
- Default OpenFreeMap Liberty vector basemap from `https://tiles.openfreemap.org/styles/liberty`
- Project model saved as `.geolibre.json`
- Real GeoJSON loading and MapLibre GL JS overlay rendering
- Placeholder layer types for FlatGeobuf, PMTiles, COG, XYZ tiles, DuckDB, and GeoParquet
- Simple vector style model
- Processing framework with a real bounding box algorithm and placeholders for buffer/reproject
- Plugin trait with an OpenStreetMap basemap plugin
- Renderer abstraction with MapLibre GL JS as the desktop backend and an egui fallback crate

## Build and Run

```bash
cargo check --workspace --all-targets
cargo test --workspace
cargo run -p geolibre-desktop
```

The desktop app opens a single native window backed by the system webview.
MapLibre GL JS renders the OpenFreeMap Liberty vector style and sets globe
projection after the style loads. Pan, wheel zoom, navigation controls, and the
MapLibre globe control are handled by MapLibre GL JS.

The previous vendored `maplibre-rs` backend has been removed because it does not
currently provide the MapLibre GL JS feature surface needed for globe rendering
and full Liberty style fidelity.

## Workspace Layout

```text
apps/geolibre-desktop        Desktop binary with MapLibre GL JS webview
crates/geolibre-core         Project, layer, style, and geometry model
crates/geolibre-io           GeoJSON loader and placeholder IO adapters
crates/geolibre-render       MapCanvas trait, MapLibre GL JS marker type, and egui fallback
crates/geolibre-processing   ProcessingAlgorithm trait and sample algorithms
crates/geolibre-plugins      Plugin trait and example plugin
crates/geolibre-ui           egui fallback UI shell
docs/architecture.md         Architecture notes
examples/data                Sample geospatial data
examples/projects            Sample project files
```

## Optional Integrations

`gdal` and `duckdb` are optional features in `geolibre-io`. They are not needed
for the default MVP build.

```bash
cargo check -p geolibre-io --features duckdb
cargo check -p geolibre-io --features gdal
```

## Renderer Status

The current desktop renderer is MapLibre GL JS running inside a `wry` webview.
This gives GeoLibre immediate access to MapLibre GL JS features such as globe
projection, built-in navigation controls, and current style-spec behavior.

`MapCanvas` remains the Rust-side abstraction boundary for future renderer
experiments. `EguiMapCanvas` remains available in `geolibre-render` for simple
GeoJSON drawing and project/layer tooling tests.

Future renderer work:

- Replace CDN MapLibre GL JS assets with vendored assets for offline startup
- Add Rust-to-JavaScript project synchronization for save/load and processing
- Add FlatGeobuf, PMTiles, COG, DuckDB, and GeoParquet rendering paths
- Add richer identify/query support through MapLibre GL JS feature queries
