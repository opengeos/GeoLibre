# geolibre

GeoLibre in Jupyter: the full [GeoLibre](https://geolibre.app) GIS app as an
[anywidget](https://anywidget.dev), with a leafmap-style Python API.

The widget embeds the complete GeoLibre app (menus, panels, processing tools)
inside a notebook cell. State syncs both ways through a single
`.geolibre.json` project, so data you add from Python appears in the UI, and
edits you make in the UI are readable back from Python.

## Install

```bash
pip install geolibre
```

## Quickstart

```python
from geolibre import Map

m = Map(center=(-100, 40), zoom=4)
m.add_geojson("https://example.com/data.geojson", name="Data")
m
```

Add more data and drive the view:

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

Round-trip the project:

```python
m.save_project("my-map.geolibre.json")

m2 = Map()
m2.load_project("my-map.geolibre.json")

# Read state edited in the UI (e.g. after panning/zooming):
m.to_project()["mapView"]["center"]
```

## API

| Method | Description |
| --- | --- |
| `Map(center, zoom, basemap=, height=, layout=, theme=)` | Create a map. `layout` is `"embed"`, `"full"`, or `"maponly"`. |
| `add_geojson(data, name=, **style)` | Add GeoJSON (dict, path, URL, JSON, or GeoDataFrame). |
| `add_tile_layer(url, name=, tile_size=, attribution=)` | Add a raster XYZ tile layer. |
| `add_cog(url, name=, bands=, colormap=, rescale=)` | Add a Cloud Optimized GeoTIFF. |
| `add_basemap(basemap)` | Set the background basemap. |
| `set_center(lng, lat, zoom=None)` | Center (and optionally zoom) the map. |
| `set_center_zoom(lng, lat, zoom=None)` | Alias of `set_center` (leafmap compatibility). |
| `remove_layer(layer_id)` / `clear_layers()` | Remove layers. |
| `to_project()` / `load_project(src)` / `save_project(path)` | Project I/O. |

## Notes

- The bundled app is served from a localhost HTTP server, so the interactive
  widget works in local Jupyter and VS Code directly. **Google Colab** routes
  through its built-in port proxy automatically. **JupyterHub** routes through
  [`jupyter-server-proxy`](https://jupyter-server-proxy.readthedocs.io)
  automatically (install it with `pip install "geolibre[hub]"`). On other remote
  servers (Binder, remote JupyterLab), pass `Map(server_proxy=True)` (also needs
  `jupyter-server-proxy`); `Map(server_proxy=False)` forces the direct path.
- Optional extras: `pip install geolibre[all]` adds GeoPandas/Shapely support
  for `add_geojson(geodataframe)`.
- `add_geojson` inlines file/URL data into the project (up to 50 MB), so a large
  dataset is held in memory and re-synced on every project update. For very large
  layers, prefer a tile or COG source (`add_tile_layer`/`add_cog`) the app fetches
  directly.
