# GeoLibre Project Format

Projects are saved as **`.geolibre.json`** files.

## Schema

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Format version (`0.1.0`) |
| `name` | string | Project display name |
| `mapView` | object | `center`, `zoom`, `bearing`, `pitch`, optional `bbox` |
| `basemapStyleUrl` | string | MapLibre style JSON URL, or an empty string for a blank background |
| `basemapVisible` | boolean | Whether the Background layer is visible |
| `basemapOpacity` | number | Background layer opacity from `0` to `1` |
| `layers` | array | Layer definitions (see below) |
| `styles` | object | Map of layer id → `LayerStyle` |
| `metadata` | object | Free-form project metadata |

## Layer object

```json
{
  "id": "uuid",
  "name": "My Layer",
  "type": "geojson",
  "source": { "type": "geojson" },
  "visible": true,
  "opacity": 1,
  "style": {
    "minZoom": 0,
    "maxZoom": 24,
    "fillColor": "#3b82f6",
    "strokeColor": "#1e40af",
    "strokeWidth": 2,
    "fillOpacity": 0.6,
    "circleRadius": 6,
    "rasterBrightnessMin": 0,
    "rasterBrightnessMax": 1,
    "rasterSaturation": 0,
    "rasterContrast": 0,
    "rasterHueRotate": 0
  },
  "metadata": {},
  "geojson": { "type": "FeatureCollection", "features": [] },
  "sourcePath": "/path/to/file.geojson"
}
```

## Layer types

| Type | v0.5.0 status |
|------|---------------|
| `geojson` | Supported for imported files and GeoJSON URLs |
| `xyz` | Supported for raster tile templates |
| `wms` | Supported as tiled WMS GetMap layers |
| `raster` | Supported for raster tile templates |
| `vector-tiles` | Supported for MapLibre vector tile sources |
| `mbtiles` | Supported in the desktop app through a local MapLibre protocol |
| `arcgis` | Supported for ArcGIS FeatureServer and VectorTileServer layers |
| `pmtiles` | Supported through the Components plugin |
| `cog` | Supported for COG and GeoTIFF raster layers |
| `flatgeobuf` | Supported through the Components plugin and imported as GeoJSON when loaded as a local vector file |
| `zarr` | Supported through the Components plugin |
| `lidar` | Supported through the Components plugin |
| `gaussian-splat` | Supported through the Components plugin |
| `geoparquet` | Imported as GeoJSON via DuckDB-WASM |
| `duckdb-query` | Reserved for SQL query-result layers |

## Example

See [`sample-data/example.geolibre.json`](https://github.com/opengeos/GeoLibre/blob/main/sample-data/example.geolibre.json).

## API

```typescript
import { createEmptyProject, parseProject, serializeProject } from "@geolibre/core";
```
