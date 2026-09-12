# `geolibre-mcp` tool reference

Every tool that reads or writes a project takes `path`, the `.geolibre.json`
file, resolved against the workspace roots. Relative paths resolve against the
first root, so `city.geolibre.json` works without knowing the host layout.
(`list_catalog` is the one exception — it takes no arguments at all.)

The server's own docstrings are the authority — this page is the map of the
surface, so you can pick the right tool before calling anything.

## Choosing an `add_*_layer` tool

Pick by what the data **is**:

| You have | Tool | Notes |
| --- | --- | --- |
| A GeoJSON URL, file, or literal | `add_geojson_layer` | Inlined into the project. Self-contained. **The only kind `classify_layer` can style.** Cap: 50 MB. |
| A big remote FlatGeobuf / GeoParquet / GeoJSON | `add_vector_layer` | Read in place, not copied. No attribute table in the file. |
| A Cloud Optimized GeoTIFF / COG | `add_raster_layer` | `bands`, `colormap`, `rescale`. |
| An XYZ raster tile template (`{z}/{x}/{y}.png`) | `add_tile_layer` | Basemaps like OSM go here, not `set_basemap`. |
| A PMTiles archive, or a vector tile service | `add_tiles_layer` | `kind="pmtiles"` (with `tile_type`) or `kind="vector-tiles"`. |
| A WMS or WMTS endpoint | `add_ogc_layer` | `service="wms"` or `"wmts"`. |
| An OGC 3D Tiles tileset | `add_3d_tiles_layer` | `altitude_offset` to sit it on the ground; `ion_asset_id` instead of `url` for a Cesium Ion tileset. |
| A Cesium Ion asset (tileset or imagery) | `add_cesium_ion_layer` | 3D globe only: pair it with `set_renderer` / `primaryRenderer: "cesium"`. `kind="imagery"` for imagery. |
| A CZML (Cesium Language) dynamic scene: orbits, tracks, moving models | `add_czml_layer` | 3D globe only: `url` for a `.czml` document, or `data` for its packet array inline. The globe follows the document's `clock`. |
| Native KML/KMZ with document styling | `add_cesium_kml_layer` | 3D globe only. Supply `url`, inline XML in `data`, or a KMZ data URL. Package local icons and overlays in KMZ for sharing. |
| A Shapefile, GeoPackage, KML, CSV | Convert first | Read it with GeoPandas and pass GeoJSON to `add_geojson_layer`, or use the Python API's `Map.add_shp` / `Map.add_gpkg` / `Map.add_kml` / `Map.add_csv`. |

Layers draw bottom-first. Every `add_*` takes an optional `index` (draw-order
position); omitted, the layer goes on top.

## Signatures

### Project lifecycle

```text
create_project(path, name="Untitled Project", center=None, zoom=None,
               basemap=None, overwrite=False)
describe_project(path)
list_catalog()
```

`create_project` refuses to clobber a file that is not a readable GeoLibre
project even with `overwrite=True`, so a retry cannot destroy an unrelated
`package.json` sitting in a root.

`describe_project` reports inlined feature data as a count, never echoed back.

`list_catalog` returns the basemaps, color ramp names, legend presets, and the
active workspace roots. Call it before guessing any of those names.

### Adding layers

```text
add_geojson_layer(path, name, data, style=None, index=None)
add_vector_layer(path, name, url, render_mode="geojson", data_format=None,
                 source_layer=None, style=None, index=None)
add_raster_layer(path, name, url, bands=None, colormap=None, rescale=None,
                 style=None, index=None)
add_tile_layer(path, name, url, tile_size=256, attribution=None, index=None)
add_ogc_layer(path, name, service, endpoint, layers=None, styles="",
              image_format="image/png", transparent=True, tile_size=256,
              version="1.1.1", bounds=None, index=None)
add_tiles_layer(path, name, url, kind="pmtiles", tile_type="vector",
                source_layers=None, style=None, index=None)
add_3d_tiles_layer(path, name, url=None, ion_asset_id=None, altitude_offset=0, index=None)
add_cesium_ion_layer(path, name, asset_id, kind="3d-tiles", altitude_offset=0, index=None)
add_czml_layer(path, name, url=None, data=None, index=None)
add_cesium_kml_layer(path, name, url=None, data=None, index=None)
```

- `add_geojson_layer(data=...)` takes an `http(s)` URL, a workspace file path,
  or a literal GeoJSON object.
- `add_vector_layer(render_mode=...)`: `"geojson"` loads it into a GeoJSON
  source; `"tiles"` tiles it in the browser as you pan. `data_format` overrides
  the format detected from the URL (`flatgeobuf`, `geoparquet`, `geojson`).
- `add_raster_layer`: `bands` are **1-based** (`[1]` single-band, `[1, 2, 3]`
  RGB), and `rescale` is a list of `[min, max]` pairs, one per band
  (`[[0, 3000]]`). The COG URL must be publicly readable **and CORS-enabled** —
  the browser fetches the tiles directly.
- `add_ogc_layer`: `layers` is required when `service="wms"`. `version` defaults
  to `1.1.1`; pass what the server advertises when it differs. For
  `service="wmts"`, `endpoint` is a full tile URL template. `bounds` is the
  layer's extent as `[west, south, east, north]`: a service layer has no
  geometry to derive it from, so without it "zoom to layer" has nowhere to go.
  Read it from the capabilities document: `EX_GeographicBoundingBox` for WMS,
  `ows:WGS84BoundingBox` for WMTS, which is where the WMS element is absent.
  Both are already lon/lat, unlike a WMS 1.3.0 `BoundingBox CRS="EPSG:4326"`,
  whose axis order servers often get wrong. Passing anything other than four
  values is an error rather than a silently dropped extent.

### Editing

```text
update_layer(path, layer, name=None, visible=None, opacity=None, index=None)
remove_layer(path, layer)
style_layer(path, layer, style)
set_layer_popup(path, layer, fields=None, click=None, title=None,
                title_expression=None, body_expression=None,
                show_feature_id=None, tooltip=None, merge=False)
classify_layer(path, layer, column, class_count=5, colormap="viridis",
               scheme="equal-interval")
list_layer_properties(path, layer)
```

`layer` is a layer id **or** its display name, everywhere.

`style_layer` merges keys into the layer's existing style rather than replacing
it. Common keys: `fillColor`, `fillOpacity`, `strokeColor`, `strokeWidth`,
`circleRadius`, `minZoom`, `maxZoom`, and for rasters `rasterBrightnessMin` /
`rasterBrightnessMax` / `rasterSaturation` / `rasterContrast` /
`rasterHueRotate`. Colors are CSS strings (`"#3b82f6"`).

`set_layer_popup` chooses what a click (and, with `tooltip`, a hover) shows.
Without it a layer shows its name plus every visible property. Each `fields`
entry is a property name or an object with `field` plus any of `label`, `kind`,
`hover`, `decimals`, `thousands`, `date_format`, `prefix`, `suffix`,
`link_label`. `kind` is `auto`, `text`, `number`, `date`, `link` (an http(s) URL
becomes an anchor) or `image` (an http(s) URL or inline base64 raster data URL
becomes a thumbnail). `tooltip` takes the property names to put in the hover
tip; `[]` turns the tip off. `merge=True` edits the existing config in place, so
a tooltip can be added without restating the fields. Run
`list_layer_properties` first to get the real column names.

`classify_layer` clamps `class_count` to 2–12. `scheme` is `equal-interval`
(even value ranges) or `quantile` (even feature counts per class). It needs an
inlined GeoJSON layer; run `list_layer_properties` first to get the real column
name and a sense of the values.

### Framing and decoration

```text
set_renderer(path, renderer, pane_id=None)
set_map_layout(path, rows, cols, view_kinds=None, sync_view=True)
set_view(path, center=None, zoom=None, bearing=None, pitch=None, bbox=None)
set_basemap(path, basemap)
add_legend(path, title=None, legend_dict=None, labels=None, colors=None,
           builtin=None, position="bottom-left", shape="square")
add_colorbar(path, colormap="viridis", vmin=0.0, vmax=1.0, label="", units="",
             colors=None, orientation="vertical", position="bottom-right")
add_swipe(path, left_layers, right_layers, orientation="vertical",
          position=50, control_position="top-right")
```

- `set_renderer`: use `"maplibre"` or `"cesium"`; omit `pane_id` for the primary map.
- `set_map_layout`: rows/cols are integers 1–4. `view_kinds` lists every pane renderer, primary first. Read secondary IDs from the returned `secondaryMapViews` before changing a named pane.
- `set_view`: `zoom` is clamped to 0–24. `bbox` is `[west, south, east, north]`
  and is resolved to a camera approximately — see the SKILL's gotcha list.
- `set_basemap` takes a named basemap or a MapLibre style JSON URL. An XYZ
  raster basemap (OpenStreetMap, Esri imagery) is **not** a basemap style — add
  it with `add_tile_layer` at `index=0`.
- `add_legend`: give it exactly one of `legend_dict` (`{label: color}`),
  `labels` + `colors` (paired lists), or `builtin` (a preset name such as `nlcd`
  or `esa_worldcover`).
- `add_colorbar`: `vmin` must be less than `vmax`. `colors` overrides `colormap`
  with a custom gradient.
- `add_swipe`: `left_layers` / `right_layers` take layer ids or names; the
  string `__basemap__` refers to the basemap.

Positions are `top-left`, `top-right`, `bottom-left`, `bottom-right`.

### Export

```text
export_html(path, out_path, title="GeoLibre Map", width="100%", height="800px",
            app_url=None, overwrite=False)
```

Writes a standalone page that embeds the hosted GeoLibre viewer and injects the
project into it. Credentials are stripped on the way out. `app_url` is a trust
boundary — see the SKILL.

## Workspace rules

- Writes are limited to `.json` (projects) and `.html`/`.htm` (exports). A bare
  `.json` with no name is refused.
- Existing files are never replaced without `overwrite=True`.
- A tool that edits an existing project first checks the file really is one.
- Reads are capped at 256 MB per project file.
- Remote fetches refuse hosts resolving to private, loopback, or link-local
  addresses, on every redirect hop.

## When a call fails

| Error | What to do |
| --- | --- |
| Path outside the workspace roots | Write inside a root, or ask the user to add one with `--root`. |
| File already exists | Pass `overwrite=True` — but only if replacing it is what the user wants. |
| Unknown basemap / colormap / legend preset | Call `list_catalog` and use a real name. |
| Layer not found | `describe_project` for the current names and ids. |
| "not a GeoLibre project" | The target is some other JSON. Pick a different path. |
| `classify_layer` reports no attribute data | The layer is not an inlined GeoJSON one. Re-add it with `add_geojson_layer`. |
