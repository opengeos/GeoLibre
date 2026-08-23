# MCP server

GeoLibre ships an [MCP](https://modelcontextprotocol.io) server that authors
GeoLibre projects. Point an MCP client (Claude Desktop, Claude Code, or any
other) at it and you can ask for a map in words: the server writes a real
`.geolibre.json` project you open in the desktop app, the web app, or the
`geolibre` Jupyter widget, and can export it as a standalone HTML page.

The server is **headless**. It needs no browser, no running GeoLibre instance,
and no bundled web build. It builds project files with the same
[project builders](python.md) the Python package uses, so a project it writes is
byte-for-byte the kind the app already loads.

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
is the current directory.

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
| `list_catalog` | List the named basemaps, color ramps, and legend presets, plus the active workspace roots. |

### Adding layers

| Tool | For |
| --- | --- |
| `add_geojson_layer` | Vector data inlined into the project, from a URL, a workspace file, or literal GeoJSON. Self-contained, and the only kind `classify_layer` can style. |
| `add_vector_layer` | A large remote FlatGeobuf / GeoParquet / GeoJSON read in place. |
| `add_raster_layer` | A Cloud Optimized GeoTIFF, with band, colormap, and rescale options. |
| `add_tile_layer` | A raster XYZ tile template. |
| `add_tiles_layer` | PMTiles archives and vector tile services. |
| `add_ogc_layer` | WMS and WMTS endpoints. |
| `add_3d_tiles_layer` | OGC 3D Tiles tilesets. |

### Editing

| Tool | What it does |
| --- | --- |
| `update_layer` | Rename, show/hide, set opacity, or reorder. |
| `remove_layer` | Drop a layer. |
| `style_layer` | Merge style keys (`fillColor`, `strokeWidth`, `circleRadius`, …). |
| `classify_layer` | Build a graduated choropleth from a numeric column. |
| `list_layer_properties` | List a layer's feature properties with sample values. |

Layers are addressed by id **or** by display name, so a client can work from
what `describe_project` showed it without tracking UUIDs.

### Framing and decoration

| Tool | What it does |
| --- | --- |
| `set_view` | Set center, zoom, bearing, and pitch, or pass a `bbox` to frame an area. |
| `set_basemap` | Switch the background style. |
| `add_legend` | Add a legend from a preset, a `{label: color}` map, or paired lists. |
| `add_colorbar` | Add a colorbar for continuous data. |
| `add_swipe` | Configure the split-map comparison slider. |

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
- The server authors projects; it does **not** drive a live map. Interactive
  control of a running GeoLibre instance goes through the scripting bridge that
  backs the [Python widget](python.md) and the
  [embed API](user-guide/embedding.md).

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
