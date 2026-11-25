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
| `bookmarks` / `bookmarkGroups` | array / array | Saved views and their folders (Bookmarks panel) |
| `styleLibrary` | array | Project-scoped Style Manager entries |
| `metadata` | object | Free-form |

Native offline basemaps may use `geolibre://offline-basemap/pkg-<id>/<flavor>`.
These refer to an app-managed package on the same device, with a stable flavor
such as `light` or `dark`. They are restored from the native package catalog
before a project renders. They are not portable archive URLs: another device
must import the archive and select its own package. Do not invent these ids
when authoring a project or replace the address with an export/share result.

Native PMTiles and MBTiles packages can back these addresses. Raster packages
use image tiles without glyph or sprite downloads; generic vector MBTiles are
project layers rather than Protomaps basemaps. Obtain package references from a
project exported on the device that owns the archive. Project exports preserve
references, rather than bundling the archives.

Preserve exported tile templates for managed vector MBTiles. Android and
custom-scheme platforms use `geolibre-native-mbtiles://tile/` to dispatch reads
through the main document; replacing it with native HTTP breaks Android worker
reads. Windows keeps the native HTTP form, also usable by Mapbox. Mapbox does
not support the custom protocols on the other platforms.

MBTiles extraction does not generate overview tiles. Newly extracted or
reapplied packages open at or above their minimum tile zoom; zooming below the
stored pyramid can show an empty map.
Sparse extracts retain the requested selection extent separately from their
copied-tile default view, omitting archive bounds when complete coverage cannot
be established at every stored zoom. Applying a package above the project
maximum zoom reports an error before changing the map; the renderer supports
zoom levels up to 24. Declared roads/places/landcover fields must include `kind`
for native Protomaps styling; incompatible sources use generic overlays.

For local MBTiles area extraction in the native app, use a non-wrapping extent
and zooms 0 through 30. The native writer preserves encoded tile bytes,
normalizes rows to TMS, and limits each output to 200,000 tiles, 32 MiB per tile,
1 MiB of metadata in at most 1,024 rows, and a final SQLite file of 512 MiB.
These are accepted-data limits, not a whole-process memory bound. Duplicate
metadata keys, including case-only duplicates, are rejected before extraction.
Cancellation interrupts SQLite work and staged publication; an already committed package may
remain in the catalog after a late cancel. Prepared/running jobs are limited to
eight, with unclaimed preparations expiring after 60 seconds. Native iOS device
verification remains outstanding.

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
`strokeColor`, `strokeWidth`, `strokeWidthUnit`, `strokeOpacity` (0-1, fades
lines and outlines only), `strokeDash` (dash and gap lengths in multiples of
the stroke width, `[]` for solid, e.g. `[4, 2]`), `strokeBlur` (px),
`circleRadius`, `textColor`, `textSize`, for 3D extrusions `extrusionEnabled`,
`extrusionHeightProperty`, `extrusionHeightScale`, `extrusionBase`,
`extrusionBaseProperty`, `extrusionBaseScale`, `extrusionFloorHeight`,
`extrusionColor`, `extrusionOpacity`, and for rasters `rasterBrightnessMin`,
`rasterBrightnessMax`, `rasterSaturation`, `rasterContrast`, `rasterHueRotate`.

### Layer types

`geojson`, `xyz`, `raster`, `wms`, `wmts`, `vector-tiles`, `mbtiles`, `arcgis`,
`pmtiles`, `cog`, `flatgeobuf`, `zarr`, `lidar`, `gaussian-splat`, `geoparquet`,
`duckdb-query`, `3d-tiles`, `deckgl-viz`, `video`, `image`.

ArcGIS FeatureServer layers are saved as `geojson`; MapServer and ImageServer as
`raster`. GeoParquet imported from a local file becomes `geojson`.

The app's **Add data > WCS layer** supports WCS 1.0.0 and 2.0.1 numerical
GeoTIFF subsets. WCS 2 needs a two-dimensional axis-aligned rectified grid and
the scaling extension, with the CRS extension for reprojection. Its coverage
and grid axes are read from metadata, and both direct TIFF and multipart
GML/TIFF responses are accepted. This imports a fixed file-backed raster;
export its GeoTIFF to retain the bytes. A saved project alone does not retain
that downloaded file, and a WCS service endpoint is not a tile-source URL.

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
  do. Only a deliberate, trusted local save keeps them. Environment variable
  rows marked `"secret": false` are ordinary values and are kept.
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

## GeoEditor feature properties

Set optional `preferences.map.geoEditor` to customize the properties form:

```json
{
  "showAfterDraw": false,
  "fields": [
    { "name": "height", "label": "Height (m)", "type": "number", "geometry": "polygon" },
    { "name": "name", "label": "Site name", "type": "string", "geometry": "all" }
  ]
}
```

`showAfterDraw` defaults to `true`. `fields` defaults to a polygon-only numeric
`height` field; an empty array removes configured fields. Existing public text,
number, and boolean attributes are discovered automatically. Configure an
existing property by its exact name to override its label, type, or scope.
Supported types are `string`, `number`, `boolean`, `color`, `date`, and `textarea`;
geometry scopes are `all`, `polygon`, `line`, and `point`. Use unique names without
quotes, backslashes, control characters, `__` prefixes, or Object prototype names.
Invalid entries are omitted on load. Nested or mixed-type attributes and derived
or editor-tracking fields remain read-only.

The UI edits these options in **Settings → GeoEditor**. Turning off the automatic
popup still allows selecting an existing feature to edit its properties. In an
existing vector-layer session, the layer's **Save** commits both geometry and
properties; **Cancel** discards both. Edited source-backed layers use the existing
`metadata.geometryEdited` marker for either kind of change so project save can
embed their changed features rather than reload the original source.
