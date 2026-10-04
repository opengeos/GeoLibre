# `geolibre-mcp` tool reference

Every tool that reads or writes a project takes `path`, the `.geolibre.json`
file, resolved against the workspace roots. Relative paths resolve against the
first root, so `city.geolibre.json` works without knowing the host layout.
`list_catalog` and the `live_*` tools take no path: the live tools move the
map open in Desktop instead of a file.

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
| A LAS/LAZ/COPC/EPT point cloud | `add_lidar_layer` | COPC and EPT stream by level of detail; the app's Point Cloud Annotation plugin can label it. |
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
get_point_cloud_annotations(path)
set_point_cloud_classes(path, classes)
prelabel_point_cloud(path, url, input_file, tool="ground", only_unclassified=True)
write_labeled_point_cloud(path, url, input_file, output_file, overwrite=False)
list_catalog()
```

`create_project` refuses to clobber a file that is not a readable GeoLibre
project even with `overwrite=True`, so a retry cannot destroy an unrelated
`package.json` sitting in a root.

`describe_project` reports inlined feature data as a count, never echoed back.

`get_point_cloud_annotations` reports, per point cloud URL, how many points the
app's annotator relabelled into each class and how many points each instance id
holds, the custom classes, the 3D vectors (polylines, polygons, keypoints),
plus every saved 3D box (with its status and attributes).

`set_point_cloud_classes` defines the annotator's custom classes (its label
schema): `[{"code": 64, "name": "Car", "color": "#e11d48"}]`, codes 19-255.
Existing labels, instances and boxes are kept; an empty list clears them.

`prelabel_point_cloud` runs the app's Pre-label classifiers (`ground`,
`ground-vegetation`) on a local copy of a LiDAR layer's file and saves the
changed classes as labels for the layer `url`. `write_labeled_point_cloud`
writes that local file with the project's labels (and instance ids) applied, as
full-resolution LAS/LAZ. Both need the `geolibre[pointcloud]` extra, and `url`
must be a LiDAR layer in the project.

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
              version="1.1.1", crs=None, bounds=None, index=None)
add_tiles_layer(path, name, url, kind="pmtiles", tile_type="vector",
                source_layers=None, style=None, index=None)
add_lidar_layer(path, name, url, index=None)
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
  values is an error rather than a silently dropped extent. `crs` is the CRS
  WMS tiles are requested in, `EPSG:3857` when omitted: check that the layer
  lists it in the capabilities, because a server without Web Mercator answers
  every tile with an XML exception and the layer stays blank. For such a
  server pass a CRS it does list, preferably a geographic one (`EPSG:4326`,
  `EPSG:4258`, `EPSG:6706`, or `CRS:84` with `version="1.3.0"`), otherwise a
  projected `EPSG:<code>` such as `EPSG:25832`: the desktop app redraws or
  warps those tiles into Web Mercator, while the web build and `export_html`
  pages cannot show them.

### Editing

```text
update_layer(path, layer, name=None, visible=None, opacity=None, index=None)
remove_layer(path, layer)
style_layer(path, layer, style)
set_layer_popup(path, layer, fields=None, click=None, title=None,
                title_expression=None, body_expression=None,
                show_feature_id=None, max_width=None, image_height=None,
                tooltip=None, merge=False)
classify_layer(path, layer, column, class_count=5, colormap="viridis",
               scheme="equal-interval")
list_layer_properties(path, layer)
set_layer_filter(path, layer, expression=None)
set_labels(path, layer, field=None, expression=None, enabled=None,
           placement=None, size=None, color=None, halo_color=None,
           halo_width=None, min_zoom=None, max_zoom=None,
           allow_overlap=None, anchor=None, options=None)
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
tip; `[]` turns the tip off. `max_width` (288–1200) is how wide the click popup
may draw and `image_height` (40–1200) how tall an `image` field's thumbnail may
draw inside it, both in CSS pixels; a thumbnail keeps its aspect ratio, so raise
`max_width` too for a landscape photo to use the extra height. `merge=True`
edits the existing config in place, so a tooltip can be added without restating
the fields. Run `list_layer_properties` first to get the real column names.

`classify_layer` clamps `class_count` to 2–12. `scheme` is `equal-interval`
(even value ranges) or `quantile` (even feature counts per class). It needs an
inlined GeoJSON layer; run `list_layer_properties` first to get the real column
name and a sense of the values.

`set_layer_filter` hides the features that do not match a **boolean** MapLibre
expression, the saved filter the app's Select by Expression → Filter layer
writes: `[">=", ["get", "pop"], 100000]`, or several combined with `all` /
`any`. The data is untouched. Omit `expression` to clear it. An expression that
is not true/false (`["get", "pop"]`) is refused, because the app would drop it
on load.

`set_labels` labels features from a property (`field`) or a text `expression`
(`["concat", ["get", "name"], " (", ["get", "pop"], ")"]`). Settings you omit
keep their current values, so a second call can restyle without restating the
field; `enabled=False` hides the labels and keeps the settings. `placement` is
`point` or `line`; `anchor` is `center`, `top`, `bottom`, `left`, `right` or a
corner such as `top-left`. Rarer settings go in `options` by name: `offset_x`,
`offset_y`, `rotation`, `max_width`, `transform` (`none`, `uppercase`,
`lowercase`), `number_format`, `number_decimals`, `number_locale`, `dedupe`
(`off`, `unique`, `concatenate`), and the data-defined `size_expression`,
`color_expression`, `opacity_expression`, `visibility_expression`,
`priority_expression`.

### Plugin state and story maps

```text
set_plugin_state(path, plugin_id, state=None, position=None, activate=True,
                 allow_unknown=False, clear=False)
set_story_map(path, title=None, subtitle=None, byline=None, footer=None,
              theme=None, show_markers=None, marker_color=None, inset=None,
              inset_position=None, hide_chapter_nav=None, start_slide=None,
              end_slide=None)
add_story_chapter(path, title, description="", center=None, zoom=None,
                  pitch=None, bearing=None, image=None, alignment="left",
                  hidden=False, map_animation="flyTo", rotate_animation=False,
                  on_enter=None, on_exit=None, index=None)
remove_story_chapter(path, chapter)
move_story_chapter(path, chapter, index)
```

- `set_plugin_state` stores a plugin's saved settings, the blob the plugin
  reads back when the project opens (the Time Slider's timeline, a grid
  plugin's resolution). `list_catalog` returns the built-in ids as
  `pluginStateIds`; another id needs `allow_unknown=True` and an external
  plugin loaded from a manifest URL. The shape of `state` is the plugin's own,
  so copy it from a project the app saved rather than inventing keys. Omit
  `state` to change only `position` / `activate`; `clear=True` removes the
  stored state. Prefer
  `add_swipe`, `add_legend` and `add_colorbar` for those controls.
- A story map is the scroll-driven narrative presented from Project → Story
  Map. `set_story_map` sets its title block and presentation (`theme` is
  `light` or `dark`; `start_slide` / `end_slide` are `none`, `blank`, `black`,
  `global` or `adjacent`). `add_story_chapter` appends a chapter, or inserts it
  at `index`; a camera value you omit comes from the project's saved view, so
  `set_view` then `add_story_chapter` captures that view. `on_enter` /
  `on_exit` fade layers: `[{"layer": "Cities", "opacity": 1, "duration": 800}]`.
  `chapter` is a chapter id, title, or 0-based index.

### Framing and decoration

```text
set_renderer(path, renderer, pane_id=None)
set_map_layout(path, rows, cols, view_kinds=None, sync_view=True)
set_view(path, center=None, zoom=None, bearing=None, pitch=None, bbox=None)
set_basemap(path, basemap)
set_map_legend(path, title=None, position=None, group_by_layer=None,
               visible=None, collapsed=None)
add_legend(path, title=None, legend_dict=None, labels=None, colors=None,
           builtin=None, position="bottom-left", shape="square")
add_colorbar(path, colormap="viridis", vmin=0.0, vmax=1.0, label="", units="",
             colors=None, orientation="vertical", position="bottom-right")
add_swipe(path, left_layers, right_layers, orientation="vertical",
          position=50, control_position="top-right")
```

- `set_renderer`: use `"maplibre"`, `"cesium"`, `"mapbox"` or `"arcgis"`; omit `pane_id` for the primary map. `"mapbox"` needs a Mapbox access token configured in the app's Settings; `"arcgis"` (the ArcGIS Maps SDK for JavaScript, loaded from Esri's CDN) works without a key and uses an ArcGIS API key from Settings for Esri basemap styles.
- `set_map_layout`: rows/cols are integers 1–4. `view_kinds` lists every pane renderer, primary first. Read secondary IDs from the returned `secondaryMapViews` before changing a named pane.
- `set_view`: `zoom` is clamped to 0–24. `bbox` is `[west, south, east, north]`
  and is resolved to a camera approximately — see the SKILL's gotcha list.
- `set_basemap` takes a named basemap or a MapLibre style JSON URL. An XYZ
  raster basemap (OpenStreetMap, Esri imagery) is **not** a basemap style — add
  it with `add_tile_layer` at `index=0`.
- `set_map_legend`: the app's own legend panel (Controls > Legend). Its rows
  come from each visible layer's symbology, so after `classify_layer` it lists
  the classes with no entries to write. Prefer it to `add_legend` for a styled
  layer; a project has one, and calling it again updates it.
- `add_legend`: hand-written entries. Give it exactly one of `legend_dict` (`{label: color}`),
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

## Live desktop map

These tools do not take a `path`. They move the map open in GeoLibre Desktop.
`live_status()` first: if `connected` is false, the user opens
Processing → Jupyter Notebook once. A live edit persists only after the user
saves in the app. Layer ids come from `live_list_layers()`, not from a
project file.

```text
live_status()
live_list_layers()
live_fly_to(lng=None, lat=None, zoom=None)
live_fit_bounds(bounds)
live_zoom_to_layer(layer_id)
live_set_basemap(basemap)
live_add_geojson(data, name="GeoJSON", style=None)
live_set_visibility(layer_id, visible)
live_set_opacity(layer_id, opacity)
live_set_style(layer_id, style)
live_remove_layer(layer_id)
live_list_algorithms(query=None)
live_run_algorithm(algorithm_id, parameters=None)
```

Processing runs in the app, so it is live-only: there is no file tool for it.
`live_list_algorithms` returns each algorithm's `id` and `parameters`;
`live_run_algorithm` runs one on the open map, adds its result layers, and
returns their ids. Layer parameters take ids from `live_list_layers()`. The
relay waits about five seconds: a longer run keeps going in the app and the
call reports that it did not finish, so check `live_list_layers()` before
running it again.

`live_set_basemap` takes a catalog name (`liberty`, `bright`, `positron`,
`dark`, `fiord`) or an `http(s)` style URL. `live_add_geojson` confines a
local path to the workspace, the same way `add_geojson_layer` does.

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
