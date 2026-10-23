# MCP server

GeoLibre ships an [MCP](https://modelcontextprotocol.io) server that authors
GeoLibre projects. Point an MCP client (Claude Desktop, Claude Code, or any
other) at it and you can ask for a map in words: the server writes a real
`.geolibre.json` project you open in the desktop app, the web app, or the
`geolibre` Jupyter widget, and can export it as a standalone HTML page.

The project-authoring tools are **headless**. They need no browser, no running
GeoLibre instance, and no bundled web build. They build project files with the
same [project builders](python.md) the Python package uses, so a project they
write is byte-for-byte the kind the app already loads. The optional `show_map`
in-chat preview uses a bundled MCP App view.

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

## In-chat map previews

Call `show_map(path="city.geolibre.json")` after creating or changing a project.
Clients supporting [MCP Apps](https://apps.extensions.modelcontextprotocol.io/)
render an interactive, **read-only** map inline: saved camera, GeoLibre layer
styling, pan/zoom, and click-to-identify. Other clients receive a text/structured
summary without inlined feature data. Neither preview tool writes the project.

The App uses the workspace `@geolibre/core` and `@geolibre/map/headless`
renderer, not a hosted-viewer iframe. It draws MapLibre-native layers (inline
GeoJSON, raster/WMS/WMTS/XYZ tiles, vector tiles, and image overlays). Everything
else in the project is named in a status notice instead of silently missing:
plugin-rendered layers (point clouds, 3D Tiles, COG, ArcGIS, PMTiles, DuckDB,
deck.gl), desktop-local sources (MBTiles, `file:` paths), video overlays,
Z-elevated GeoJSON, active plugins, legends, map controls, additional map views,
and a non-MapLibre primary renderer. Mapbox basemaps are blank because
credentials are stripped. Configured popup image fields show their URL as text,
because the shared popup renderer would load the image outside the approval
gate below.

The status bar shows loading progress, and failures that need action: a failed
project load, a basemap style that could not load (the preview falls back to a
blank background and still draws the project's layers), and per-source tile
errors, counted rather than repeated. Rendered content stays visible.

The host must support App-to-server tool calls (`serverTools`): the preview
loads the credential-redacted project through app-only `get_map_preview`, then
uses app-only tools to approve origins, fetch resource bytes, and close the
preview session. Do not call those tools directly; full feature data is not
part of `show_map`'s model-visible result. Hosts without this capability show
an explanation rather than receiving feature data through the summary.

App-only tool visibility requires a compliant host that honors
`ui.visibility: ["app"]`. It is not server-side authentication: a client that
ignores this metadata can expose the redacted project and approval/fetch tools
to the model. The consent UI is therefore not an independent server-side
security boundary. Grant, public-address, and resource-limit checks remain
enforced by the server regardless of the caller.

### Network access

The preview supports public HTTP and HTTPS resources, including WMS endpoints
and hosts discovered inside remotely fetched style documents. One consent panel
lists the origins known from the basemap and visible, renderable layer sources
up front. **Allow all** or **Block all** applies to that list, including sources
that begin loading after the basemap style. No resource request is sent before
approval; blocking leaves inline data available over a blank map background.
New origins discovered inside remote styles are batched into the same panel,
not silently approved by an earlier decision. Already-blocked origins stay
blocked. The panel supports light/dark themes, narrow views, and keyboard use.
It uses GeoLibre's shared web/desktop palette from `@geolibre/ui/theme.css`:
blue primary actions and slate/navy dark surfaces. The host selects light or
dark mode; it does not replace GeoLibre's color scheme.

Approved resources are fetched by the **GeoLibre Python MCP server**, not the
browser. The destination sees the server machine's IP address, which may differ
from the browser's IP; the prompt makes this explicit. Resource bytes travel
back through app-only MCP tool calls. The bundled view declares no external
CSP origins, so browser CORS, mixed-content restrictions, and desktop hosts'
wildcard-CSP normalization do not govern these resource requests. The host
must still permit the App's server-tool calls.

Consent is scoped to one preview and is not persisted. Server-side previews
expire after 30 minutes of inactivity; successful origin approval and resource
authorization refresh that idle timeout. Origin grants still expire after five
minutes and are renewed only for origins already allowed in that preview.
Closing the preview revokes its grants. Call `show_map` again to choose
differently or reopen an idle-expired session.

The server allows at most 64 active preview sessions. It refuses new sessions
at that limit rather than evicting a live preview and revoking its grants.
Closing a preview frees its slot; abandoned sessions retain theirs until the
30-minute idle expiry.

The server checks DNS addresses and connects only to the checked public IPs,
with HTTPS certificate/hostname verification using system trust plus certifi's
public CA bundle. Loopback, private/LAN, link-local, reserved, and multicast
targets are rejected, even after approval; **private-network services are not
supported by this preview**.

Known credentials in project URLs and source configuration are redacted before
the App receives them, and known credential-like resource URL parameters are
rejected. These name-based checks are heuristic, not a guarantee that every
vendor-specific secret is detected. Conservative keys such as `key` and `sr`
are rejected even when used for a non-secret value; use a public URL without
these parameters. Do not preview projects containing secrets in custom fields
or URL parameters. No cookies, caller headers, environment proxies, or browser
credentials are forwarded.

Redirects fail closed: use and approve the direct destination URL instead.
Each resource body is limited to 4 MiB (about 5.3 MiB when base64-encoded for
transport) and a 15-second network deadline. An oversized `Content-Length` is
rejected before reading the body; the streaming limit also applies when the
length is missing or understated. The server requests identity encoding and
rejects compressed responses. Video sources inside a fetched style are removed
because MapLibre loads video outside the consent-controlled request path.

After updating a checkout, run these commands from the monorepo root.
Install JavaScript dependencies and rebuild the view before the editable Python
install, whose build hook can build any missing frontend assets:

```bash
npm install
npm run build:mcp-app
python -m pip install -e "python[mcp]"
```

Use the Python executable configured in your desktop client's MCP server
command. Fully quit and reopen the client, then make a fresh `show_map` call:
an already-mounted preview can retain the previous HTML and tool definitions.

### Building from a checkout

Published wheels include `geolibre/static/mcp/show-map.html`. From a checkout,
run `npm install` and `npm run build:mcp-app` to build, scan, and stage the
single-file MCP App without building the Jupyter app. `npm run build:embed`
independently builds and stages the Jupyter/web app.

The Python packaging hook runs each frontend build only when its own staged
output is missing. Set `GEOLIBRE_FORCE_JS_BUILD=1` to rebuild both from a full
checkout. Prebuilt sdists can produce wheels without Node or the monorepo
sources. Both frontend build outputs and pre-staged package assets are scanned
for credentials before packaging.

The consent panel uses a named vanilla Lucide icon rendered directly into SVG
DOM nodes, keeping React's server renderer out of the single-file preview.

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
| `add_spaceborne_lidar_layer` | ICESat-2 (ATL06, ATL08) or GEDI (L2A, L2B, L4A) footprints from a local HDF5 granule (needs `geolibre[spaceborne]`). |
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
| `add_bookmark` | Add a saved view to the Bookmarks panel, optionally in a folder (a new folder name creates it) and with the layers to show when it is opened. A camera value left out comes from the project's saved view. |
| `remove_bookmark` | Drop a bookmark by id, name, or index. |

The shapes match what the app reads (`parseProject` in `@geolibre/core`); a
round-trip test loads a project these tools wrote through it and checks nothing
is dropped or rewritten.


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
