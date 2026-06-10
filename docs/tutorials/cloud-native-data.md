# Cloud-Native Data

GeoLibre is built for cloud-native geospatial formats: GeoParquet and FlatGeobuf for vector, Cloud-Optimized GeoTIFF (COG) for raster, and PMTiles for tiles. This tutorial loads them from remote URLs and converts a local dataset.

## Load a remote GeoParquet

GeoParquet is a compressed, columnar vector format that reads well over HTTP.

1. Open **Add Data → GeoParquet Layer** (or **Vector Layer**).
2. Enter a GeoParquet URL, for example:
   ```text
   https://data.source.coop/giswqs/opengeos/countries.parquet
   ```
3. To avoid copying a large file into memory, enable **Stream GeoParquet (no copy)**, which queries it in place with HTTP range requests. This works best for large remote files whose rows are spatially sorted (for example, Hilbert order, as written by GeoLibre's own Conversion tools), so only the relevant row groups are fetched.
4. Click **Load**.

## Load a FlatGeobuf

FlatGeobuf is a streaming-friendly vector format with a spatial index.

1. Open **Add Data → FlatGeobuf Layer**.
2. Enter a `.fgb` URL and load it. GeoLibre fetches only the features in view where the format allows.

## Load a COG

A Cloud-Optimized GeoTIFF is a regular GeoTIFF organized so clients can read just the tiles they need.

1. Open **Add Data → Raster Layer**.
2. Enter the URL of a COG (`.tif`) and load it. You can then adjust brightness, contrast, saturation, and hue in the [Style panel](../user-guide/styling.md).

!!! tip "Drag and drop"
    You can also drag a local GeoTIFF or COG onto the map to add it as a raster layer. See [Adding Data](../user-guide/adding-data.md#drag-and-drop).

## Convert local data to cloud-native

Use **Processing → Conversion** to write cloud-native files. See [Processing Tools](../user-guide/processing.md#conversion).

- **Vector to GeoParquet** and **CSV to GeoParquet** run in the browser with DuckDB-WASM.
- **Vector to FlatGeobuf**, **Vector to PMTiles**, and **Raster to COG** run on the Python sidecar (desktop app).

For example, to publish a local GeoJSON as GeoParquet:

1. Open **Processing → Conversion → Vector to GeoParquet**.
2. Choose the input file and an output path.
3. Run the conversion, then add the resulting GeoParquet back to the map to verify it.

## Next steps

- Query these formats directly in [Spatial SQL](spatial-sql.md); the SQL Workspace reads Parquet, CSV, JSON, and GeoJSON from URLs.
- Animate a time series of COGs with the Time Slider plugin. See [Data Integrations](../user-guide/data-integrations.md).
