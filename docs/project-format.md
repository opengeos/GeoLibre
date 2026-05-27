# GeoLibre Project Format

Projects are saved as **`.geolibre.json`** files.

## Schema (v0.1)

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Format version (`0.1.0`) |
| `name` | string | Project display name |
| `mapView` | object | `center`, `zoom`, `bearing`, `pitch`, optional `bbox` |
| `basemapStyleUrl` | string | MapLibre style JSON URL |
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
    "fillColor": "#3b82f6",
    "strokeColor": "#1e40af",
    "strokeWidth": 2,
    "fillOpacity": 0.6,
    "circleRadius": 6
  },
  "metadata": {},
  "geojson": { "type": "FeatureCollection", "features": [] },
  "sourcePath": "/path/to/file.geojson"
}
```

## Layer types

| Type | MVP status |
|------|------------|
| `geojson` | Supported |
| `xyz` | Partial (raster tiles) |
| `vector-tiles` | Partial |
| `pmtiles` | Placeholder (v0.3) |
| `cog` | Placeholder (v0.3) |
| `flatgeobuf` | Placeholder (v0.3) |
| `geoparquet` | Placeholder (v0.3) |
| `duckdb-query` | Placeholder (v0.4) |

## Example

See [sample-data/example.geolibre.json](../sample-data/example.geolibre.json).

## API

```typescript
import { createEmptyProject, parseProject, serializeProject } from "@geolibre/core";
```
