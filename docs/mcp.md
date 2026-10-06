# MCP server

GeoLibre ships an [MCP](https://modelcontextprotocol.io) server that authors
GeoLibre projects. Point an MCP client (Claude Desktop, Claude Code, or any
other) at it and you can ask for a map in words: the server writes a real
`.geolibre.json` project you open in the desktop app, the web app, or the
`geolibre` Jupyter widget, and can export it as a standalone HTML page.

The file tools are **headless**. They need no browser, no running GeoLibre
instance, and no bundled web build. They build project files with the same
[project builders](python.md) the Python package uses, so a project they write
is byte-for-byte the kind the app already loads.

The `live_*` tools are the other half. They speak the desktop Notebook relay
([Notebook panel](notebook.md)), so a command from an MCP client moves the map
already open in GeoLibre Desktop. Open **Processing → Jupyter Notebook** once
per app launch; the panel can be closed after that. Web and JupyterLite have
no relay, so those tools have nothing to attach to there.

## Install

The MCP SDK is an optional extra:

```bash
pip install "geolibre[mcp]"
```

## Run it

```bash
geolibre-mcp --root ~/maps
```

The server speaks MCP over stdio, which is what desktop clients spawn. The
`--root` flag is repeatable, and `GEOLIBRE_MCP_ROOTS` (`:`-separated, `;` on
Windows) does the same job from the environment. With neither set, the workspace
is the current directory. `--transport` switches from the default `stdio` to
`streamable-http` or `sse` for clients that connect over HTTP.

### Client configuration

Claude Desktop (`claude_desktop_config.json`) and most other clients take the
same shape:

```json
{
  "mcpServers": {
    "geolibre": {
      "command": "geolibre-mcp",
      "args": ["--root", "/Users/you/maps"]
    }
  }
}
```

For Claude Code:

```bash
claude mcp add geolibre -- geolibre-mcp --root ~/maps
```

If `geolibre-mcp` is not on the client's `PATH` (common when it was installed
into a virtualenv), give the interpreter instead:

```json
{
  "mcpServers": {
    "geolibre": {
      "command": "/path/to/venv/bin/python",
      "args": ["-m", "geolibre.mcp", "--root", "/Users/you/maps"]
    }
  }
}
```

## The workspace

Every path in every tool call is resolved against the allowed roots before the
server touches it, mirroring `GEOLIBRE_CONVERSION_ROOTS` in the
[sidecar](server-api.md). Paths outside them are refused, and so is a symlink
inside a root that points out of it. Relative paths resolve against the first
root, so a client can say `city.geolibre.json` without knowing the host layout.

Three more guards on writes: the server only writes files ending in `.json`
(projects) or `.html` (exports) — a bare `.json` with no name is refused too —
it refuses to replace an existing file unless the call passes `overwrite`, and
a tool that edits an existing project first checks the file actually is one, so
an unrelated `package.json` sitting inside a root cannot be rewritten as a map.

Give it a directory meant for maps, not your home directory.

## Tools

### Project lifecycle

| Tool | What it does |
| --- | --- |
| `create_project` | Write a new, empty project with a name, center, zoom, and basemap. |
| `describe_project` | Summarize the camera, basemap, layers, and map controls. Inlined feature data is reported as a count, never echoed back. |
| `get_point_cloud_annotations` | Per point cloud, how many points the app's annotator relabelled into each class and how many points each instance holds, plus the custom classes, 3D vectors and saved 3D boxes (with status and attributes). |
| `set_point_cloud_classes` | Define the annotator's custom classes (codes 19-255, name, `#rrggbb` color); keeps existing labels and boxes. |
| `prelabel_point_cloud` | Run the app's Whitebox pre-label classifiers on a local copy of a LiDAR layer and save the changed classes as its labels (needs `geolibre[pointcloud]`). |
| `write_labeled_point_cloud` | Write a local copy of a LiDAR layer's LAS/LAZ/COPC file with the project's labels and instance ids applied (needs `geolibre[pointcloud]`). |
| `list_catalog` | List the named basemaps, color ramps, legend presets, and the plugin ids `set_plugin_state` accepts, plus the active workspace roots. |

### Adding layers

| Tool | For |
| --- | --- |
| `add_geojson_layer` | Vector data inlined into the project, from a URL, a workspace file, or literal GeoJSON. Self-contained, and the only kind `classify_layer` can style. |
| `add_vector_layer` | A large remote FlatGeobuf / GeoParquet / GeoJSON read in place. |
| `add_raster_layer` | A Cloud Optimized GeoTIFF, with band, colormap, and rescale options. |
| `add_tile_layer` | A raster XYZ tile template. |
| `add_tiles_layer` | PMTiles archives and vector tile services. |
| `add_ogc_layer` | WMS and WMTS endpoints. |
| `add_lidar_layer` | LAS/LAZ/COPC/EPT point clouds by URL. |
| `add_3d_tiles_layer` | OGC 3D Tiles tilesets, by URL or Cesium Ion asset id. |
| `add_cesium_ion_layer` | Cesium Ion assets (tileset or imagery) by id; rendered by the 3D globe only. |
| `add_czml_layer` | A CZML (Cesium Language) dynamic 3D scene, by URL or inline packets; rendered by the 3D globe only. |
| `add_cesium_kml_layer` | Native globe KML/KMZ from a URL, inline XML, or KMZ data URL, preserving document styles and overlays. |

### Editing

| Tool | What it does |
| --- | --- |
| `update_layer` | Rename, show/hide, set opacity, or reorder. |
| `remove_layer` | Drop a layer. |
| `style_layer` | Merge style keys (`fillColor`, `strokeWidth`, `circleRadius`, …). |
| `set_layer_popup` | Choose the fields a click popup shows, their labels and formats, its width and image height, and an optional hover tooltip. |
| `set_layer_metadata` | Describe a layer for catalogs (title, abstract, keywords, license, attribution, contact, lineage, temporal extent, links): what the app's Metadata dialog edits and exports as a STAC Item. |
| `classify_layer` | Build a graduated choropleth from a numeric column. |
| `list_layer_properties` | List a layer's feature properties with sample values. |
| `set_layer_filter` | Hide the features that do not match a boolean MapLibre expression (the saved filter Select by Expression → Filter layer writes); omit the expression to clear it. |
| `set_labels` | Label features from a property or a text expression, with size, colors, halo, zoom range, anchor, and the rarer settings under `options`. Settings left out keep their values. |

Layers are addressed by id **or** by display name, so a client can work from
what `describe_project` showed it without tracking UUIDs.

### Framing and decoration

| Tool | What it does |
| --- | --- |
| `set_view` | Set center, zoom, bearing, and pitch, or pass a `bbox` to frame an area. |
| `set_basemap` | Switch the background style. |
| `set_map_legend` | Show the map legend, built from the layers' own symbology. |
| `add_legend` | Add a legend from a preset, a `{label: color}` map, or paired lists. |
| `add_colorbar` | Add a colorbar for continuous data. |
| `add_swipe` | Configure the split-map comparison slider. |

### Plugin state and story maps

| Tool | What it does |
| --- | --- |
| `set_plugin_state` | Store a plugin's saved project state (the blob it restores on open, such as the Time Slider's timeline). Built-in ids come from `list_catalog`; an external plugin's id needs `allow_unknown`. |
| `set_story_map` | Set a story map's title block, theme, markers, inset, and start/end slides. |
| `add_story_chapter` | Add a chapter with its camera, text, image, alignment, animation, and layer fades. A camera value left out comes from the project's saved view. |
| `move_story_chapter` / `remove_story_chapter` | Reorder or drop a chapter by id, title, or index. |

The shapes match what the app reads (`parseProject` in `@geolibre/core`); a
round-trip test loads a project these tools wrote through it and checks nothing
is dropped or rewritten.

Bookmarks have no tool: the app keeps them in browser storage, not in the
project file, so there is nothing for a project tool to write. Story chapters
are the saved, shareable equivalent.

### Live desktop map

| Tool | What it does |
| --- | --- |
| `live_status` | Report whether a GeoLibre Desktop window is listening. |
| `live_list_layers` | List the open map's layers. |
| `live_fly_to` / `live_fit_bounds` / `live_zoom_to_layer` | Move the camera. |
| `live_set_basemap` | Switch the basemap. |
| `live_add_geojson` / `live_remove_layer` | Add or remove a layer. |
| `live_set_visibility` / `live_set_opacity` / `live_set_style` | Change a layer. |
| `live_list_algorithms` | List the app's processing algorithms and their parameters, optionally filtered by `query`. |
| `live_run_algorithm` | Run an algorithm on the open map; returns its logs and the ids of the result layers it added. |

Processing is live-only. The algorithm catalog and the engines that run it
(Turf.js, DuckDB-WASM) live in the app, so there is nothing a file tool could
run. The relay waits about five seconds for a result: a longer run keeps going
in the app, and the tool reports that it did not finish in time instead of its
result layer ids, so check `live_list_layers` before running it again.

### Export

`export_html` writes a standalone page that embeds the hosted GeoLibre viewer
and injects the project into it, so the recipient needs no install. Credentials
are stripped from the project on the way out. Layers pointing at local files
will not load for anyone else, so use hosted URLs for a shareable export.

!!! warning "`app_url` is a trust boundary"

    `export_html`'s optional `app_url` names the viewer the exported page
    embeds, and the page posts the project to exactly that origin (it must be
    an `http`/`https` URL). It exists so you can pin a self-hosted deployment.

    Treat it as a destination, not a cosmetic setting: whoever opens the
    exported file hands the project's contents — inlined GeoJSON, layer URLs,
    the camera — to that origin. Credentials are already stripped, so this is
    not a key leak, but the rest of the project still travels.

    This matters because the caller here is a model, which may be acting on
    content it has read. If an exported page points somewhere you did not
    choose, that is worth a second look. Only accept an `app_url` you
    intended.

## Notes and limits

- **`set_view` with a `bbox` is approximate.** A saved project stores a center
  and zoom, and the app applies those verbatim on load rather than fitting a
  stored bbox. The server therefore resolves the box to a camera itself, using
  an assumed map-pane size, and lands within roughly half a zoom level of what
  the app's own "zoom to layer" would pick. Pass `center` and `zoom` when you
  need exact framing.
- **Inlined GeoJSON is capped at 50 MB**, and a project file the server reads at
  256 MB. Past those, use `add_vector_layer` or a tiled source.
- **Remote fetches are checked**: a URL whose host resolves to a private,
  loopback, or link-local address is refused, on every redirect hop as well as
  the first request, so a crafted URL cannot reach a cloud metadata endpoint.
- **File tools write a project. `live_*` tools move the open desktop map.**
  A live edit is in the session until you save it from the app. The relay is
  loopback-only and refuses redirects, so the Jupyter token stays on the
  machine. The same scripting surface backs the [Python widget](python.md)
  and the [embed API](user-guide/embedding.md); those remain how a host page
  or a notebook drives a map without MCP.

## Driving the server from an agent

GeoLibre ships an [agent skill](agent-skill.md) that teaches an external AI
agent how to use these tools well: which `add_*_layer` tool fits which data,
what order to call things in, and the limits above. Install it from
`skills/geolibre/` in the repository.

## Under the hood

The tools are thin wrappers over `geolibre.authoring`, a widget-free module of
operations on project dicts (add/remove/restyle a layer, move the camera,
compose the map controls). `geolibre.Map` delegates to the same module, so the
notebook widget and the MCP server cannot drift apart in how they build a
project.

## Renderer and pane authoring

Use `set_renderer(path, "cesium")` to open a project on the globe.
`set_map_layout(path, 1, 2, view_kinds=["cesium", "maplibre"])` creates a mixed
grid and returns the secondary panes, with their IDs, as `secondaryMapViews`. Pass one as `pane_id` to `set_renderer`
to change only that pane. Camera tools continue to use longitude/latitude and
the shared zoom, bearing, and pitch convention. The accepted renderer names are
`maplibre`, `mapbox`, `cesium`, and `arcgis`.
