# geolibre

[![image](https://img.shields.io/pypi/v/geolibre.svg)](https://pypi.python.org/pypi/geolibre)
[![image](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/opengeos/GeoLibre/blob/main/python/examples/getting-started.ipynb)
[![image](https://img.shields.io/conda/vn/conda-forge/geolibre.svg)](https://anaconda.org/conda-forge/geolibre)
[![Conda Recipe](https://img.shields.io/badge/recipe-geolibre-green.svg)](https://github.com/conda-forge/geolibre-feedstock)

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

Or with conda from [conda-forge](https://anaconda.org/conda-forge/geolibre):

```bash
conda install -c conda-forge geolibre
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
| `add_vector(data, name=, render_mode=, data_format=, source_layer=, **style)` | Add a vector dataset from a URL (GeoParquet, FlatGeobuf, zipped Shapefile, GeoJSON) or a local file (read via GeoPandas, inlined). |
| `add_geoparquet` / `add_flatgeobuf` / `add_shp` `(data, name=, **style)` | Format-specific wrappers over `add_vector`. |
| `add_vector_tiles(url, name=, source_layers=, source_layer=, **style)` | Add vector tiles from a TileJSON endpoint. |
| `add_pmtiles(url, name=, tile_type=, source_layers=, **style)` | Add a PMTiles archive (vector or raster). |
| `add_tile_layer(url, name=, tile_size=, attribution=)` | Add a raster XYZ tile layer. |
| `add_wms(endpoint, layers, name=, styles=, image_format=, transparent=, tile_size=, **style)` | Add a WMS (GetMap) tiled raster layer. |
| `add_wmts(url, name=, tile_size=, **style)` | Add a WMTS tile URL template. |
| `add_wfs(endpoint, type_name, name=, version=, output_format=, srs_name=, max_features=, **style)` | Add a WFS layer (GeoJSON, fetched and inlined). |
| `add_cog(url, name=, bands=, colormap=, rescale=)` | Add a Cloud Optimized GeoTIFF. |
| `add_raster(url, name=, bands=, colormap=, rescale=)` | Add a raster (alias of `add_cog`). |
| `add_3d_tiles(url, name=, altitude_offset=, request_headers=, **style)` | Add a 3D Tiles `tileset.json`. |
| `add_video(urls, coordinates, name=, **style)` | Add a georeferenced video (four `[lng, lat]` corners). |
| `add_basemap(basemap)` | Set the background basemap. |
| `set_center(lng, lat, zoom=None)` | Center (and optionally zoom) the map. |
| `set_center_zoom(lng, lat, zoom=None)` | Alias of `set_center` (leafmap compatibility). |
| `remove_layer(layer_id)` / `clear_layers()` | Remove layers. |
| `to_project()` / `load_project(src)` / `save_project(path)` | Project I/O. |

## Notes

- The bundled app is served from a localhost HTTP server, so the interactive
  widget works in local Jupyter and VS Code directly. **Google Colab** routes
  through its built-in port proxy automatically. On **JupyterHub** (including
  managed/shared hubs) the front-end tries two same-origin routes and uses
  whichever is live, so a host needs only one of them: the Jupyter Server
  extension bundled with `geolibre` at `{base_url}geolibre/app/` (enabled
  automatically on `pip install geolibre`, but registered only after the Jupyter
  server restarts), and `jupyter-server-proxy` at `{base_url}proxy/{port}/`
  (works in the running server with no restart where it is installed). On other
  remote servers (Binder, remote JupyterLab), pass `Map(server_proxy=True)` to
  use that same remote path; `Map(server_proxy=False)` forces the direct path.
- Optional extras: `pip install geolibre[all]` adds GeoPandas/Shapely support
  for `add_geojson(geodataframe)` and for reading **local** vector files
  (`add_vector`/`add_geoparquet`/`add_flatgeobuf`/`add_shp`), which the kernel
  reads and inlines as GeoJSON. Remote URLs for the same formats stream through
  the in-browser vector control and need no extras.
- `add_geojson` inlines file/URL data into the project (up to 50 MB), so a large
  dataset is held in memory and re-synced on every project update. For very large
  layers, prefer a tile or COG source (`add_tile_layer`/`add_cog`) the app fetches
  directly.
