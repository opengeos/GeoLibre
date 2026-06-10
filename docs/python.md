# Python package (Jupyter)

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

Optional extras for `add_geojson()` from a GeoDataFrame:

```bash
pip install "geolibre[all]"   # adds GeoPandas and Shapely
```

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

## API reference

| Method | Description |
| --- | --- |
| `Map(center, zoom, basemap=, height=, layout=, theme=)` | Create a map. |
| `add_geojson(data, name=, **style)` | Add GeoJSON from a dict, file path, URL, JSON string, or GeoDataFrame. |
| `add_tile_layer(url, name=, tile_size=, attribution=)` | Add a raster XYZ tile layer. |
| `add_cog(url, name=, bands=, colormap=, rescale=)` | Add a Cloud Optimized GeoTIFF. |
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
    - **JupyterHub** - routes through
      [`jupyter-server-proxy`](https://jupyter-server-proxy.readthedocs.io)
      automatically (detected via `JUPYTERHUB_SERVICE_PREFIX`). Install it in the
      single-user image with `pip install "geolibre[hub]"` (or
      `pip install jupyter-server-proxy`).
    - **Other remote servers** (Binder, remote JupyterLab over SSH/network) -
      pass `Map(server_proxy=True)`, which also requires `jupyter-server-proxy`.

    Set `Map(server_proxy=False)` to force the direct localhost path.

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
