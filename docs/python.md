# Python package (Jupyter)

[![image](https://img.shields.io/pypi/v/geolibre.svg)](https://pypi.python.org/pypi/geolibre)
[![image](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/opengeos/GeoLibre/blob/main/python/examples/getting-started.ipynb)
[![image](https://img.shields.io/conda/vn/conda-forge/geolibre.svg)](https://anaconda.org/conda-forge/geolibre)
[![Conda Recipe](https://img.shields.io/badge/recipe-geolibre-green.svg)](https://github.com/conda-forge/geolibre-feedstock)

GeoLibre ships a Python package, **`geolibre`**, that embeds the full GeoLibre
app inside a Jupyter notebook cell as an [anywidget](https://anywidget.dev),
with a [leafmap](https://leafmap.org)-style API.

The widget loads the complete GeoLibre app (menus, panels, processing tools) in
an iframe. State syncs both ways through a single `.geolibre.json` project, so
data you add from Python appears in the UI, and edits you make in the UI
(panning, zooming, adding layers) are readable back from Python.

## Install

```bash
pip install geolibre
```

Or with conda from [conda-forge](https://anaconda.org/conda-forge/geolibre):

```bash
conda install -c conda-forge geolibre
```

Optional extras for `add_geojson()` from a GeoDataFrame and for reading **local**
vector files with `add_vector()` / `add_geoparquet()` / `add_flatgeobuf()` /
`add_shp()` (remote URLs for those formats need no extras):

```bash
pip install "geolibre[all]"   # adds GeoPandas and Shapely
```

The optional `[all]` extra is pip-only. If you installed via conda, add it with
`pip install "geolibre[all]"` inside the same environment.

## Quickstart

```python
from geolibre import Map

m = Map(center=(-100, 40), zoom=4)
m.add_geojson("https://example.com/data.geojson", name="Data")
m
```

The full GeoLibre UI renders in the cell. Add more data and drive the view:

```python
m.add_tile_layer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    name="OpenStreetMap",
    attribution="(c) OpenStreetMap contributors",
)
m.add_cog("https://example.com/dem.tif", name="DEM", colormap="terrain")
m.add_basemap("dark")
m.set_center(-120, 47, zoom=8)
```

`add_raster` / `add_cog` also accept a **local** GeoTIFF path on the kernel host:
the file is served by the bundled localhost server so the app can read it. This
only works where the **browser can reach the kernel's localhost** (local Jupyter,
VS Code); on remote/browser-separated setups (Colab, JupyterHub, remote servers)
the localhost route is unreachable, so pass a hosted URL there. The served URL is
also session-scoped, so a project saved with a local raster will not restore it
when reopened later — pass a hosted URL for durable projects.

Add markers and data-driven symbology without precomputing styles:

```python
m.add_marker(-122.4, 37.8, properties={"name": "San Francisco"})
m.add_marker_cluster([(-122.4, 37.8), (-122.3, 37.9), (-122.5, 37.7)])
m.add_choropleth(
    "https://example.com/counties.geojson",
    column="population",
    colormap="blues",
    scheme="quantile",
)
```

## Two-way sync

Because the project syncs both ways, you can pan or zoom the map in the UI and
then read the live state back from Python:

```python
proj = m.to_project()
proj["mapView"]["center"]              # reflects the live UI view
[layer["name"] for layer in proj["layers"]]
```

Save and reload projects, fully interchangeable with the desktop and web apps:

```python
m.save_project("my-map.geolibre.json")

m2 = Map()
m2.load_project("my-map.geolibre.json")
m2
```

## Map options

```python
Map(
    center=(-100, 40),   # [lng, lat]
    zoom=4,
    basemap="dark",      # a basemap name or a MapLibre style URL
    height="800px",
    layout="embed",      # "embed" (compact UI), "full" (desktop UI), or "maponly"
    theme="light",       # "light" or "dark"
)
```

## Interactive scripting

Beyond adding data, the widget can **query the live app and react to it** — the
same surface as the in-app [Python Console](user-guide/python-console.md). These
calls round-trip to the running map, so the map must be displayed first (show
`m` in a cell), then run the queries in a later cell.

```python
m.get_center()                 # live [lng, lat], reflecting UI pans/zooms
m.get_bounds()                 # [west, south, east, north]
m.fly_to(-122.4, 37.8, zoom=10)
m.identify(-122.4, 37.8)       # features at a point, like clicking the map

# Layer objects: read and mutate layers, read their features
for layer in m.layers:
    layer.opacity = 0.6
features = m.layers[0].get_features()   # list of GeoJSON Feature objects

# Run a processing algorithm; result layers are added to the map
m.list_algorithms()
m.run_algorithm("buffer", {"layer": layer_id, "distance": 1000})

png = m.to_image()             # PNG bytes (or m.to_image("map.png"))
```

React to user interaction with event callbacks:

```python
m.on_click(lambda e: print("clicked", e["lngLat"]))
m.on_selection_change(lambda e: print("selected", e))
m.on_layer_change(lambda e: print("layers", e["layerIds"]))
```

!!! note "Blocking queries"
    Interactive queries block the kernel until the app replies (via
    `jupyter_ui_poll`, installed automatically). Pass `timeout=` for slow calls,
    e.g. `m.run_algorithm(..., timeout=300)`.

## API reference

### Interactive queries, events & processing

| Method | Description |
| --- | --- |
| `get_view()` / `get_center()` / `get_bounds()` | Read the live camera / center / viewport bounds. |
| `fly_to(lng, lat, zoom=, bearing=, pitch=, duration=)` | Animate the camera. |
| `fit_bounds([w, s, e, n])` | Fit the camera to a bounding box. |
| `identify(lng, lat, layer_id=None)` | Query rendered features at a point. |
| `get_features(layer_id)` | A layer's features as `Feature` objects. |
| `layers` / `get_layer(id)` | `Layer` handles (read state; set `name`/`visible`/`opacity`, `set_style`, `get_features`, `zoom_to`, `remove`). |
| `list_algorithms()` | Available processing algorithms (`id`, `parameters`, …). |
| `run_algorithm(id, parameters=None, timeout=)` | Run an algorithm; returns `{logs, resultLayerIds}`. |
| `to_image(path=None, timeout=)` | Capture the map as PNG bytes, or write to `path`. |
| `on(event, cb)` / `on_click` / `on_selection_change` / `on_layer_change` | Register event callbacks; returns an unsubscribe function. |
| `request(method, params=None, timeout=)` | Low-level command primitive behind the methods above. |

### Data, view & projects

| Method | Description |
| --- | --- |
| `Map(center, zoom, basemap=, height=, layout=, theme=)` | Create a map. |
| `add_geojson(data, name=, **style)` | Add GeoJSON from a dict, file path, URL, JSON string, or GeoDataFrame. |
| `add_marker(lng, lat, name=, properties=, **style)` | Add a single point marker (shown as a circle; `properties` appear on click). |
| `add_markers(points, name=, **style)` | Add point markers from `(lng, lat)` pairs, `{lng/lon/x, lat/y, …}` dicts, GeoJSON, or a GeoDataFrame. |
| `add_circle_markers(points, name=, radius=, **style)` | Add circle markers with an explicit `radius`. |
| `add_marker_cluster(points, name=, cluster_radius=, cluster_max_zoom=, **style)` | Add clustered point markers. |
| `add_choropleth(data, column, name=, class_count=, colormap=, scheme=, **style)` | Add a GeoJSON layer with graduated symbology computed from a numeric `column`. |
| `add_data(data, column=None, name=, **kwargs)` | Add data; a choropleth when `column` is given, else a plain GeoJSON layer (leafmap parity). |
| `add_vector(data, name=, render_mode=, data_format=, source_layer=, **style)` | Add a vector dataset from a URL (GeoParquet, FlatGeobuf, zipped Shapefile, GeoJSON, …) or a local file (read via GeoPandas and inlined). |
| `add_geoparquet(data, name=, **style)` | Add a GeoParquet dataset (URL or local file). |
| `add_flatgeobuf(data, name=, **style)` | Add a FlatGeobuf dataset (URL or local file). |
| `add_shp(data, name=, **style)` | Add a Shapefile (zipped URL or local `.shp`). |
| `add_vector_tiles(url, name=, source_layers=, source_layer=, **style)` | Add a vector tile layer from a TileJSON endpoint. |
| `add_pmtiles(url, name=, tile_type=, source_layers=, **style)` | Add a PMTiles archive (vector or raster). |
| `add_tile_layer(url, name=, tile_size=, attribution=)` | Add a raster XYZ tile layer. |
| `add_wms(endpoint, layers, name=, styles=, image_format=, transparent=, tile_size=, **style)` | Add a WMS layer (GetMap, tiled raster). |
| `add_wmts(url, name=, tile_size=, **style)` | Add a WMTS layer from a tile URL template. |
| `add_wfs(endpoint, type_name, name=, version=, output_format=, srs_name=, max_features=, **style)` | Add a WFS layer (GetFeature GeoJSON, fetched and inlined). |
| `add_cog(url, name=, bands=, colormap=, rescale=, **style)` | Add a Cloud Optimized GeoTIFF (URL or a kernel-side local GeoTIFF path). |
| `add_raster(url, name=, bands=, colormap=, rescale=, **style)` | Add a raster (COG/GeoTIFF), URL or local path; alias of `add_cog`. |
| `add_3d_tiles(url, name=, altitude_offset=, request_headers=, **style)` | Add a 3D Tiles `tileset.json`. |
| `add_video(urls, coordinates, name=, **style)` | Add a georeferenced video (four `[lng, lat]` corners). |
| `add_basemap(basemap)` | Set the background basemap. |
| `set_center(lng, lat, zoom=None)` | Center (and optionally zoom) the map. |
| `set_center_zoom(lng, lat, zoom=None)` | Alias of `set_center` (leafmap compatibility). |
| `remove_layer(layer_id)` / `clear_layers()` | Remove layers. |
| `to_project()` | Return the current project as a dict. |
| `load_project(src)` | Replace the project from a dict, JSON string, or `.geolibre.json` path. |
| `save_project(path)` | Write the current project to a `.geolibre.json` file. |

Style keyword arguments (for example `fillColor`, `strokeColor`, `strokeWidth`,
`circleRadius`) map to the GeoLibre [layer style fields](project-format.md).

## How it works

The wheel bundles the GeoLibre web build. At import time the package starts a
small localhost static server that serves the bundled app; the widget renders
that app in an iframe and exchanges the project over `window.postMessage`.
Adding data from Python rewrites the synced project and pushes it into the app;
UI edits flow back the same way.

!!! note "Environment support"

    The interactive widget works in **local Jupyter, VS Code, Google Colab, and
    JupyterHub / remote servers**:

    - **Local Jupyter / VS Code** - the app is served directly from localhost.
    - **Google Colab** - routes through Colab's built-in port proxy
      (`google.colab.kernel.proxyPort`) automatically.
    - **JupyterHub** (including managed/shared hubs, detected at runtime via
      `JUPYTERHUB_SERVICE_PREFIX`) - the front-end probes two same-origin routes
      and uses whichever is live, so a host needs only **one** of them:
        - the Jupyter Server extension bundled with `geolibre`, mounted at
          `{base_url}geolibre/app/` on the notebook server's own origin. It is
          enabled automatically on `pip install geolibre` and needs no
          `jupyter-server-proxy` and no extra port, so it works on locked-down
          hubs that block raw-port proxying -- but it only registers after the
          Jupyter server restarts, since it loads from a startup config drop-in.
        - `jupyter-server-proxy` at `{base_url}proxy/{port}/`, which reaches the
          kernel's localhost bundle in the **running** server with no restart,
          wherever `jupyter-server-proxy` is installed.
    - **Other remote servers** (Binder, remote JupyterLab over SSH/network) -
      pass `Map(server_proxy=True)` to use that same dual-route remote path.

    Set `Map(server_proxy=False)` to force the direct localhost path. If the app
    fails to load on a hub, either install `jupyter-server-proxy`, or confirm the
    extension is enabled with `jupyter server extension list` (look for
    `geolibre`; run `jupyter server extension enable geolibre` if absent) and
    **restart** the Jupyter server so the extension loads.

!!! warning "URL fetching"

    `add_geojson(url)` fetches the URL from the **kernel**, following redirects,
    so a notebook can reach any host the kernel can (including private and
    link-local addresses such as cloud metadata endpoints). This is intended for
    single-user local notebooks, where you already control the kernel. Private
    and localhost URLs are intentionally allowed so you can load from a local
    tile server. Do not load untrusted `.geolibre.json` projects or URLs on a
    shared/multi-tenant kernel.

## Building from source

The package lives in [`python/`](https://github.com/opengeos/GeoLibre/tree/main/python).
The bundled app is produced from the monorepo with:

```bash
npm run build:embed      # builds the app and stages it into the wheel
python -m build          # builds the wheel
python -m twine upload dist/*  # upload to PyPI
pip install -e python    # editable install for development
```

Changes to the Python code are picked up on kernel restart. Changes to the app
(TypeScript) require re-running `npm run build:embed` and restarting the kernel.
