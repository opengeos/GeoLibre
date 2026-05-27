# GeoLibre Desktop Architecture

GeoLibre Desktop is organized as a Rust workspace with small crates that can
evolve independently. The MVP keeps project state, IO, processing, plugins, and
renderer-facing abstractions separate so experimental renderer or data-access
work does not leak into the core model.

## Crates

- `geolibre-core`: stable domain types for projects, layers, sources, styles,
  extents, and vector features.
- `geolibre-io`: readers and source adapters. GeoJSON is implemented. Modern
  cloud-native formats are represented as placeholders for future work.
- `geolibre-render`: `MapCanvas` trait, viewport math, a MapLibre GL JS marker
  canvas type, and `EguiMapCanvas`.
- `geolibre-processing`: processing algorithm trait and sample algorithms.
- `geolibre-plugins`: plugin trait and bundled example plugins.
- `geolibre-ui`: egui fallback panels and application state.
- `geolibre-desktop`: native `wry` desktop shell that hosts MapLibre GL JS and
  the MVP GIS UI in one webview.

## Data Flow

The Rust crates define the project and layer model. The desktop binary builds an
initial `GeoLibreProject`, loads the sample GeoJSON through `geolibre-io`, and
serializes that state into the webview at startup. The webview owns the current
interactive UI state for this MVP, including layer visibility, opacity, status
display, identify placeholder output, and GeoJSON overlay rendering.

Processing algorithms remain native Rust APIs. The current webview UI includes
matching controls, with a real client-side bounding box action for the sample
GeoJSON and placeholders for buffer and reproject until the Rust-to-JavaScript
bridge is expanded.

## Rendering Strategy

The default renderer is MapLibre GL JS running inside a `wry` webview. The map
uses the OpenFreeMap Liberty style from
`https://tiles.openfreemap.org/styles/liberty`. After `style.load`, GeoLibre
calls `map.setProjection({ type: "globe" })`, matching the MapLibre GL JS globe
projection API. MapLibre GL JS owns pan, zoom, navigation controls, the globe
control, style evaluation, and vector tile rendering.

The previous vendored `maplibre-rs` renderer has been removed. It was useful for
a native Rust experiment, but it did not match MapLibre GL JS feature coverage
for globe projection or full Liberty style rendering.

`MapCanvas` remains the Rust-side swap point for future renderers. A later
backend can be a deeper webview bridge, a new native renderer, or a different
GPU implementation without changing the project and processing crates.

## Format Roadmap

Implemented:

- GeoJSON feature loading
- Project save/load as `.geolibre.json`
- MapLibre GL JS rendering of the sample GeoJSON overlay
- OpenFreeMap Liberty vector basemap with globe projection

Placeholders:

- FlatGeobuf
- PMTiles
- Cloud Optimized GeoTIFF
- XYZ raster/vector tiles beyond layer records
- DuckDB Spatial
- GeoParquet

## Plugin Roadmap

The MVP plugin trait is native Rust only. WASM plugin support is a future TODO
and should be added as a separate runtime boundary, not mixed into the native
plugin trait.
