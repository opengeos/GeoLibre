# GeoLibre Project Format

Projects are saved as **`.geolibre.json`** files.

## Schema

| Field             | Type    | Description                                                                                                  |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `version`         | string  | Format version (`0.1.0`)                                                                                     |
| `name`            | string  | Project display name                                                                                         |
| `mapView`         | object  | `center`, `zoom`, `bearing`, `pitch`, optional `bbox`                                                        |
| `basemapStyleUrl` | string  | MapLibre style JSON URL, or an empty string for a blank background                                           |
| `basemapVisible`  | boolean | Whether the Background layer is visible                                                                      |
| `basemapOpacity`  | number  | Background layer opacity from `0` to `1`                                                                     |
| `layers`          | array   | Layer definitions (see below)                                                                                |
| `styles`          | object  | Map of layer id → `LayerStyle`                                                                               |
| `plugins`         | object  | Optional external plugin manifest URLs, active plugin IDs, plugin map-control positions, and plugin settings |
| `legend`          | object  | Optional Print Layout legend customizations (title, grouping, ordering, per-item rename/hide)                |
| `storymap`        | object  | Optional scroll-driven story map (chapters and presentation settings); omitted when there are no chapters    |
| `widgets`         | array   | Optional Dashboard panel chart widgets (see below); omitted when there are none                              |
| `dashboardColumns`| number  | Optional Dashboard widget-grid column count (1-6, default 2); omitted when default                          |
| `styleLibrary`    | array   | Optional project-scoped Style Manager entries (name, tags, kind, `LayerStyle` subset); omitted when empty    |
| `metadata`        | object  | Free-form project metadata                                                                                   |

## Plugin state

```json
{
  "manifestUrls": ["https://example.com/plugins/example-plugin/plugin.json"],
  "activePluginIds": ["maplibre-layer-control", "maplibre-gl-swipe"],
  "mapControlPositions": {
    "maplibre-layer-control": "top-right",
    "maplibre-gl-swipe": "top-left"
  },
  "settings": {
    "maplibre-gl-swipe": {
      "orientation": "vertical",
      "position": 50,
      "collapsed": false,
      "active": true,
      "leftLayers": ["layer-a"],
      "rightLayers": ["layer-b"]
    }
  }
}
```

Projects without a `plugins` section open with the built-in default plugin state.

## Legend

The Print Layout legend is always derived from the visible layers' symbology; the
`legend` object stores only the user's edits layered on top, so customizations
survive layer additions and removals.

```json
{
  "title": "Legend",
  "groupByLayer": true,
  "order": ["layer-b", "layer-a"],
  "overrides": {
    "layer-a": { "label": "Roads" },
    "layer-b::0": { "label": "Low" },
    "layer-b::1": { "hidden": true }
  }
}
```

- `title` — heading drawn above the legend entries.
- `groupByLayer` — when `true`, graduated/categorized classes are grouped under a
  per-layer heading; when `false`, classes are listed flat.
- `order` — top-level entry order by layer id (top-first); layers not listed keep
  their default order after the listed ones.
- `overrides` — per-item `label` and `hidden` edits keyed by a stable item key: a
  layer id for a whole entry, or `${layerId}::${index}` for an individual class
  within a graduated/categorized entry.

Projects without a `legend` section open with the default legend (auto-generated
from the layers, titled "Legend").

## Story map

A story map turns the project into a scroll-driven narrative. Each chapter
captures a camera view plus text, and can fade project layers in or out on
enter/exit. The section is omitted entirely when the project has no chapters.

```json
{
  "title": "A Tour of Three Cities",
  "subtitle": "Built with GeoLibre",
  "byline": "By the GeoLibre team",
  "footer": "Source: OpenStreetMap",
  "theme": "dark",
  "showMarkers": true,
  "markerColor": "#3fb1ce",
  "inset": false,
  "insetPosition": "bottom-right",
  "chapters": [
    {
      "id": "intro",
      "title": "San Francisco",
      "description": "A hilly city on the tip of a peninsula. <em>HTML allowed.</em>",
      "image": "https://example.com/sf.jpg",
      "alignment": "left",
      "hidden": false,
      "location": { "center": [-122.4194, 37.7749], "zoom": 11, "pitch": 45, "bearing": 0 },
      "mapAnimation": "flyTo",
      "rotateAnimation": false,
      "onChapterEnter": [{ "layerId": "layer-a", "opacity": 1, "duration": 2000 }],
      "onChapterExit": [{ "layerId": "layer-a", "opacity": 0 }]
    }
  ]
}
```

`alignment` is one of `left`, `center`, `right`, `full`; `mapAnimation` is
`flyTo`, `easeTo`, or `jumpTo`. Layer opacity changes reference project layer
ids. Build and present story maps from **Project → Story Map**, or export a
self-contained HTML page for static hosting.

## Dashboard widgets

```json
{
  "widgets": [
    { "id": "w1", "layerId": "layer-a", "type": "histogram", "field": "pop", "bins": 12 },
    { "id": "w2", "layerId": "layer-a", "type": "bar", "category": "kind", "aggregation": "sum", "valueField": "pop", "title": "Population by kind" }
  ]
}
```

Each widget binds a chart to a layer's attributes. `type` is one of `histogram`,
`scatter`, `bar`, `line`, `box`, or `pie`. Which other keys apply depends on the
type: `field` (histogram/line/box), `xField`/`yField` (scatter), `category` +
`aggregation` + `valueField` (bar/pie), `bins` (histogram). Bar `aggregation` is
`count`/`sum`/`mean`; pie is `count`/`sum` only. `title` is an optional label and
`color` an optional hex (`#rgb`/`#rrggbb`) for the chart's marks (the series
color for single-series charts; the base of a monochromatic ramp for bar/pie).
Unused keys are ignored. The Dashboard panel (Tools → Dashboard, or the
**Dashboard** button in the attribute table) also stores `dashboardColumns`, the
widget-grid column count (1-6, default 2), at the top level of the project.
Charts read from GeoJSON-backed vector layers and DuckDB query layers; widgets
bound to a missing or non-attribute layer are shown as empty.

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
    "strokeWidthUnit": "pixels",
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

For WFS GetFeature and GeoJSON URL layers, `metadata.refresh` can persist an
optional auto-refresh interval. `intervalMs` can be any positive interval in
milliseconds:

```json
{
  "metadata": {
    "refresh": { "enabled": true, "intervalMs": 60000 }
  }
}
```

Manual refresh uses the same saved source URL without requiring this metadata.

For local-file vector layers on the desktop app, `metadata.watch` can persist a
"watch this file for changes" toggle. When enabled, the desktop app registers a
filesystem watcher that reloads the layer's features from `sourcePath` whenever
the file changes on disk:

```json
{
  "metadata": {
    "watch": { "enabled": true }
  }
}
```

The key is omitted when watching is off, and it has no effect off the desktop
host (the browser cannot watch a local filesystem path).

A layer may carry persistent attribute joins (Layer properties → Joins): live
left joins that materialize columns from another layer's attribute table —
typically a geometry-less table added via Delimited Text with no coordinate
fields — into this layer's feature properties, matched on a key field:

```json
{
  "joins": [
    {
      "id": "uuid",
      "joinLayerId": "other-layer-uuid",
      "targetField": "name",
      "joinField": "state_name",
      "fields": ["pop_2025", "median_income"],
      "prefix": "census_",
      "enabled": true,
      "addedFields": ["census_pop_2025", "census_median_income"],
      "stats": {
        "matchedCount": 50,
        "unmatchedTargetCount": 2,
        "unmatchedJoinCount": 2
      }
    }
  ]
}
```

`fields` (subset to bring over; omitted = every field except the key), `prefix`,
and `enabled` are optional. `addedFields` and `stats` are engine bookkeeping,
rewritten on every apply: `addedFields` lists the output columns the join added
(so re-applying can strip them first, keeping the operation idempotent), and
`stats` records the last match counts shown in the Joins UI. Joins re-resolve
against the loaded layer set on project open, so a saved copy of the joined
output self-heals if the join table changed.

When a `geojson` layer enables `style.simpleStyleEnabled`, individual features
may override the layer style with [simplestyle-spec](https://github.com/mapbox/simplestyle-spec)
properties (`stroke`, `fill`, `stroke-width`, `fill-opacity`, ...). GeoLibre also
honors a per-feature `text-color` on text-marker points (used by the Annotations
layer), falling back to `style.textColor` when a feature does not set it.

## Layer types

| Type             | v1.0 status                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `geojson`        | Supported for imported files and GeoJSON URLs                                                      |
| `xyz`            | Supported for raster tile templates                                                                |
| `wms`            | Supported as tiled WMS GetMap layers                                                               |
| `raster`         | Supported for raster tile templates                                                                |
| `vector-tiles`   | Supported for MapLibre vector tile sources                                                         |
| `mbtiles`        | Supported in the desktop app through a local MapLibre protocol                                     |
| `arcgis`         | Supported for ArcGIS FeatureServer and VectorTileServer layers                                     |
| `pmtiles`        | Supported through the Components plugin                                                            |
| `cog`            | Supported for COG and GeoTIFF raster layers                                                        |
| `flatgeobuf`     | Supported through the Components plugin and imported as GeoJSON when loaded as a local vector file |
| `zarr`           | Supported through the Components plugin                                                            |
| `lidar`          | Supported through the Components plugin                                                            |
| `gaussian-splat` | Supported through the Components plugin                                                            |
| `geoparquet`     | Imported as GeoJSON via DuckDB-WASM                                                                |
| `duckdb-query`   | Supported for SQL query-result layers                                              |
| `3d-tiles`       | Supported through the `maplibre-gl-3d-tiles` plugin                               |

## API

```typescript
import {
  createEmptyProject,
  parseProject,
  serializeProject,
} from "@geolibre/core";
```
