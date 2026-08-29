# GeoLibre Project Format

Projects are saved as **`.geolibre`** files. GeoLibre continues to open the
earlier **`.geolibre.json`** name, but the single extension lets desktop
installers associate projects with GeoLibre without taking ownership of every
JSON file on the system.

## Desktop file opening

Desktop installers register `.geolibre` as a GeoLibre Project document. Opening
one from the file manager launches GeoLibre, or brings the existing GeoLibre
window forward, and loads the project. The desktop executable also accepts both
supported names on the command line:

```text
geolibre-desktop /path/to/watershed.geolibre
geolibre-desktop /path/to/legacy.geolibre.json
```

Operating systems see only `.json` at the end of a `.geolibre.json` name. Those
legacy files continue to open from inside GeoLibre and from the command line,
but renaming one to `.geolibre` is required for file-manager association. The
file contents do not change.

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
| `printLayout`     | object  | Optional Print Layout composer settings (title, page size, orientation, blocks, atlas); omitted when default  |
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

## Print layout

The Print Layout composer (Project -> Print Layout) belongs to the project, so
the page it composes reopens as it was saved. The section is written only once
a setting differs from the defaults, so a project that never opened the composer
carries no `printLayout` key.

```json
{
  "title": "Dentists by region",
  "subtitle": "2026",
  "paperSize": "a3",
  "orientation": "portrait",
  "pageMargin": "normal",
  "showLegend": true,
  "showScaleBar": true,
  "showNorthArrow": true,
  "showDataTable": true,
  "tableLayerId": "layer-a",
  "tableColumns": ["name", "count"],
  "atlasEnabled": false
}
```

- Title block: `title`, `subtitle`, `titlePlacement`, `titleAlign`. A blank
  `title` follows the project name rather than freezing a copy of it.
- Page: `paperSize` (`a4`, `a3`, `letter`, `legal`, `tabloid`, `fullhd`, `hd`,
  `uhd4k`, `square`, `custom`), `orientation`, `customWidth` / `customHeight` /
  `customUnit` for `custom`, `pageMargin`, and the page/map frame colours.
- Elements: the `show*` toggles for legend, scale bar, north arrow, footer,
  date, attribution, colorbar, custom legend and info block, with their
  per-element settings.
- Data blocks: `tableLayerId` / `chartLayerId` name a project layer; a block
  whose layer is missing from the project opens cleared rather than blank.
- Atlas: `atlasEnabled` plus the coverage layer, extent mode, sorting, filter
  and filename pattern for the map series.

Unknown or malformed values fall back to the default for that field, so a
hand-edited file never leaves the composer in an unusable state. Per-session
state (the captured map image, the current atlas page, the dialog's panel
widths) is deliberately not stored.

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
  "sourcePath": "/path/to/file.geojson",
  "editorTracking": {
    "enabled": false,
    "createdByField": "created_by",
    "createdAtField": "created_at",
    "editedByField": "edited_by",
    "editedAtField": "edited_at"
  },
  "capabilities": {
    "query": true,
    "create": true,
    "update": true,
    "delete": true,
    "export": true
  }
}
```

A layer can define an optional `capabilities` set (`query`, `create`, `update`,
`delete`, `export`) to explicitly declare allowed user and session actions. Each
flag gates only the actions it names: `query` the identify/attribute-table and
feature-selection paths, `create`/`update`/`delete` the feature writes, and
`export` the paths that copy the layer's data out (Export, Save to Layer
Library, Export selection). Renaming a layer or removing it from the project is
not a feature edit and stays available. Omitted capabilities default to the
behavior inferred from the layer's source kind. When `export` is `false`,
project sharing/publishing strips embedded GeoJSON for that layer.

`export: false` strips the feature data the project file itself carries — the
layer's inline `geojson` and its `metadata.embeddedGeoJSON` snapshot. It does
not remove the layer's `source` or `connection`, so a layer that fetches its
data live (WFS, ArcGIS FeatureServer, a remote GeoJSON or tile URL) is still
shared with a reachable URL and re-fetches the same data when the project is
opened. For that class of layer the flag hides the copy in the file, not the
data itself.

`capabilities` describes the layer, and the app enforces it in the UI; it is not
an access-control mechanism. The PostGIS sidecar refuses writes that contradict
the capabilities the client sends with a save, which keeps an in-app edit from
contradicting the layer's own configuration, but the sidecar has no independent
record of a table's capabilities and cannot tell one caller from another. Use
database grants for restrictions that must hold against an untrusted client.

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

Reloadable layers also persist a top-level `connection` record, which is the
primary source of truth for the refresh cadence and carries the durable
synchronization status shown in the Layers panel. `metadata.refresh` is kept as
a legacy fallback for projects saved before `connection` existed:

```json
{
  "connection": {
    "layerId": "layer-1",
    "interval": 60,
    "lastSyncedAt": "2026-08-01T14:20:00.000Z",
    "lastError": null,
    "onFailure": "keep-last"
  }
}
```

`interval` is the automatic refresh cadence in **seconds**, or `null` for
manual synchronization only. `lastSyncedAt` records the most recent successful
synchronization and `lastError` the most recent failure (cleared on the next
success). `onFailure` decides whether a failed synchronization retains the last
good data (`"keep-last"`, the default) or discards it (`"clear"`).

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

A vector layer may carry **quick filters** (Layer properties → Quick filters):
data-driven filter controls that narrow what the layer draws without anyone
writing a MapLibre expression. What persists is the *control state*, never the
compiled output, so a saved filter can always be reopened and changed:

```json
{
  "quickFilters": [
    {
      "id": "uuid",
      "field": "state",
      "kind": "categorical",
      "values": ["OR", "WA"]
    },
    { "id": "uuid", "field": "pop", "kind": "range", "min": 200000, "max": null },
    {
      "id": "uuid",
      "field": "founded",
      "kind": "date",
      "dateKind": "iso",
      "start": "1840-01-01",
      "end": "1900-12-31"
    },
    { "id": "uuid", "field": "name", "kind": "text", "operator": "contains", "text": "port" }
  ]
}
```

`kind` picks the control and the comparison: `categorical` (checkboxes over
`values`), `range` (inclusive numeric `min`/`max`, either side `null` for an
open bound), `date` (inclusive `YYYY-MM-DD` `start`/`end`), and `text`
(case-insensitive `contains` / `startsWith` / `equals` against `text`).
`dateKind` says how the field stores its timestamps — `iso` (the default,
comparing the leading `YYYY-MM-DD` of ISO text), `epochMs`, or `epochS` — and
`enabled: false` mutes a control without discarding what it was answered with.
A control with nothing chosen places no constraint, so an emptied selection
shows every feature rather than none.

A quick filter narrows the *rendered* features, so a point layer using the
cluster renderer is an exception worth noting: MapLibre clusters at the source,
from the layer's whole dataset, so cluster bubbles and their counts describe the
unfiltered data while clustering is on (as they already do for a Time Slider
window or a rule filter).

The compiled filter is combined with the transient `timeFilter` and
`embedFilter` and with the rule-based renderer's hide-unmatched filter under a
single `all`, so a host page's `setFilter`, a Time Slider window, and a user's
quick filter narrow the layer together instead of replacing one another. Quick
filters are also shown in the read-only `layout=viewer` chrome: filtering is a
way of reading a shared map, not of editing it.

When a `geojson` layer enables `style.simpleStyleEnabled`, individual features
may override the layer style with [simplestyle-spec](https://github.com/mapbox/simplestyle-spec)
properties (`stroke`, `fill`, `stroke-width`, `fill-opacity`, ...). GeoLibre also
honors a per-feature `text-color` on text-marker points (used by the Annotations
layer), falling back to `style.textColor` when a feature does not set it.

A vector layer may carry a `popup` block (Style panel → Popup): the design for
what a viewer sees when they click or hover a feature. It decides which fields
appear, in what order, under what labels and value formatting, what titles the
popup, and whether a hover tooltip follows the pointer:

```json
{
  "popup": {
    "click": true,
    "hover": true,
    "titleField": "name",
    "showFeatureId": false,
    "fields": [
      {
        "field": "pop_max",
        "label": "Population",
        "kind": "number",
        "format": { "thousands": true, "suffix": " people" },
        "hover": true
      },
      { "field": "region", "label": "Region" },
      { "field": "homepage", "kind": "link", "format": { "linkLabel": "City website" } }
    ]
  }
}
```

Every key is optional, and **a layer with no `popup` block keeps the historical
behavior**: the layer name as the heading, then every property as a row. `click`
defaults to `true` (`false` suppresses the Identify popup); `hover` defaults to
`false`. `fields` narrows and orders what is shown — an absent or empty list
means every visible field, in the data's own order — and a listed field the
feature does not carry is skipped rather than printed empty. Each field's `kind`
is one of `auto` (the untyped rendering: sanitized KML `description` markup and
inline `data:image/*;base64` values as thumbnails), `text`, `number`, `date`,
`link`, or `image`, and `format` carries `decimals`, `thousands`, `dateFormat`
(`date` | `datetime` | `time` | `iso` | `year`), `prefix`, `suffix`, and
`linkLabel`. `hover: true` on a field puts it in the tooltip's short subset; a
tooltip with no flagged field shows the title alone, or nothing when the title
is just the layer name.

`titleField` leads the popup with a feature's own value instead of the layer
name; `titleExpression` (a MapLibre expression source) wins over it, and both
fall back to the layer name when they produce nothing. `bodyExpression`
replaces the whole body — the field rows and the `id` row with them — with a
sentence built from the feature's properties, so `showFeatureId` has no effect
while one is set.

`fieldVisibility` stays authoritative: a field marked `"hidden"` or
`"excluded"` never reaches a popup, even when the `popup` block names it — the
popup design selects from what is visible, it cannot re-expose what the author
hid. That holds for the expressions too: `titleExpression` and `bodyExpression`
are evaluated against the visible properties only, so a `["get", …]` cannot
pull back a hidden column or one of GeoLibre's internal ones. Raster pixel identify goes through a different path and ignores `popup`.

## Layer types

| Type             | Status                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `geojson`        | Supported for imported files and GeoJSON URLs                                                      |
| `xyz`            | Supported for raster tile templates                                                                |
| `wms`            | Supported as tiled WMS GetMap layers                                                               |
| `raster`         | Supported for raster tile templates                                                                |
| `vector-tiles`   | Supported for MapLibre vector tile sources                                                         |
| `mbtiles`        | Supported in the desktop app through a local MapLibre protocol                                     |
| `arcgis`         | Supported for ArcGIS VectorTileServer layers (FeatureServer layers are saved as `geojson`, and MapServer/ImageServer layers as `raster`) |
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
  redactCredentials,
  serializeProject,
} from "@geolibre/core";
```

## Credential redaction

A local project may contain credentials needed to restore authenticated data,
including layer request headers, geocoding API keys, environment variables, and
plugin settings. Any project leaving the local workspace must pass through
`redactCredentials(project)` first. GeoLibre applies this invariant to Share,
standalone HTML export, embed snapshots, and collaboration snapshots. Local
Save and Save As ask whether credentials should be stripped or deliberately
kept.

Saved model and processing-history parameter bags do not currently accept
credentials and are treated as structural project content. If a future
processing tool accepts credentials, those fields must be added to the central
redaction registry and traversal.

The redaction pass removes credential-bearing fields and authentication
parameters in URLs while preserving non-secret broker references. External
plugin settings are arbitrary, so they are omitted from egress snapshots by
default. Recipients retain the plugin manifest and activation metadata, but
must configure their own settings.
