# Writing `.geolibre.json` by hand

Use this when neither the MCP server nor the Python package is available, or
when you need to repair a project file. Otherwise prefer a tool — the schema has
more corners than this page covers.

The reference lives at <https://geolibre.app/project-format/>.

## Only three fields are required

`version`, `name`, and `mapView`. Everything else is defaulted on load:
`basemapStyleUrl` falls back to the app default, `layers` to `[]`, `styles` to
`{}`, and every unset style key on a layer to its own default. A hand-written
project can therefore be very small — do **not** try to reproduce the ~60 style
keys the app writes out, they are defaults being serialized.

Out-of-range values are clamped and unknown or malformed values fall back to the
default for that field, so a hand-edit cannot leave the app unusable. It can,
however, silently ignore what you meant — check the result with
`describe_project`, `geolibre.Map.load_project()`, or by opening the file.

## A minimal, valid project

```json
{
  "version": "0.1.0",
  "name": "Cities",
  "mapView": { "center": [-100, 40], "zoom": 4, "bearing": 0, "pitch": 0 },
  "basemapStyleUrl": "https://tiles.openfreemap.org/styles/positron",
  "basemapVisible": true,
  "basemapOpacity": 1,
  "layers": [
    {
      "id": "8f1c0f6a-1f26-4a1e-9a5f-2b1d3c4e5f60",
      "name": "Cities",
      "type": "geojson",
      "source": { "type": "geojson" },
      "visible": true,
      "opacity": 1,
      "style": { "circleRadius": 6, "fillColor": "#ef4444" },
      "geojson": {
        "type": "FeatureCollection",
        "features": [
          {
            "type": "Feature",
            "geometry": { "type": "Point", "coordinates": [-122.4, 37.8] },
            "properties": { "name": "San Francisco" }
          }
        ]
      }
    }
  ],
  "styles": {},
  "metadata": {}
}
```

`id` must be unique within the project; a UUID is the convention. Layers draw in
array order, **first is bottom**.

Coordinates are WGS84 lon/lat, and `center` is `[lng, lat]` — not `[lat, lng]`.
A map that lands in the ocean off West Africa is a swapped pair; one in
Antarctica or off the map entirely is usually a projected CRS that was never
reprojected.

## Top-level fields

| Field | Type | Notes |
| --- | --- | --- |
| `version` | string | `"0.1.0"` |
| `name` | string | Display name |
| `mapView` | object | `center`, `zoom`, `bearing`, `pitch`, optional `bbox` |
| `basemapStyleUrl` | string | MapLibre style JSON URL; `""` for a blank background |
| `basemapVisible` | boolean | |
| `basemapOpacity` | number | 0–1 |
| `layers` | array | Layer objects, bottom-first |
| `styles` | object | layer id → style, for styles kept outside the layer |
| `preferences` | object | Map limits (`restrictBounds`, `minZoom`, `maxZoom`, `maxPitch`, …) |
| `plugins` | object | `manifestUrls`, `activePluginIds`, `mapControlPositions`, `settings` |
| `legend` | object | Print Layout legend *edits* only; the legend itself is derived |
| `printLayout` | object | Print composer settings; omitted when default |
| `storymap` | object | Scroll-driven chapters; omitted when there are none |
| `widgets` / `dashboardColumns` | array / number | Dashboard charts |
| `styleLibrary` | array | Project-scoped Style Manager entries |
| `metadata` | object | Free-form |

## The layer object

```json
{
  "id": "uuid",
  "name": "My Layer",
  "type": "geojson",
  "source": { "type": "geojson" },
  "visible": true,
  "opacity": 1,
  "style": { "fillColor": "#3b82f6", "strokeWidth": 2, "fillOpacity": 0.6 },
  "geojson": { "type": "FeatureCollection", "features": [] },
  "sourcePath": "/path/to/file.geojson",
  "metadata": {}
}
```

Useful style keys: `minZoom`, `maxZoom`, `fillColor`, `fillOpacity`,
`strokeColor`, `strokeWidth`, `strokeWidthUnit`, `circleRadius`, `textColor`,
`textSize`, and for rasters `rasterBrightnessMin`, `rasterBrightnessMax`,
`rasterSaturation`, `rasterContrast`, `rasterHueRotate`.

### Layer types

`geojson`, `xyz`, `raster`, `wms`, `vector-tiles`, `mbtiles`, `arcgis`,
`pmtiles`, `cog`, `flatgeobuf`, `zarr`, `lidar`, `gaussian-splat`, `geoparquet`,
`duckdb-query`, `3d-tiles`.

ArcGIS FeatureServer layers are saved as `geojson`; MapServer and ImageServer as
`raster`. GeoParquet imported from a local file becomes `geojson`.

### Other layer fields

A layer may also carry `capabilities` (`query`, `create`, `update`, `delete`,
`export`) to declare what users may do with it, `joins` for live attribute
joins, `connection` for auto-refresh cadence, and `editorTracking`. Omitted
capabilities default to what the source kind implies. `capabilities` is a UI
declaration, not access control.

## Before you ship a project

- **Redact credentials.** A local project may hold layer request headers,
  geocoding API keys, environment variables, and plugin settings. Anything
  leaving the workspace must pass through `redactCredentials(project)` — which
  is what Share, HTML export, embed snapshots, and `Map.save_project()` already
  do. Only a deliberate, trusted local save keeps them.
- **Check the URLs are reachable and CORS-enabled** — the browser fetches them
  directly, so a URL that works in `curl` can still fail in the app.
- **Local `sourcePath` layers do not travel.** They resolve on the authoring
  machine only.

## Validating

```python
from geolibre import Map
Map().load_project("my.geolibre.json")   # raises ValueError on a bad project
```

Or in TypeScript, from `@geolibre/core`: `parseProject`, `serializeProject`,
`createEmptyProject`, `redactCredentials`.
