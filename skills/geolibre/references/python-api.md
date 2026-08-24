# `geolibre` Python API

```bash
pip install geolibre              # or: conda install -c conda-forge geolibre
pip install "geolibre[all]"       # + GeoPandas/Shapely, for GeoDataFrames and
                                  #   local Shapefile/GPKG/KML/GeoParquet reads
```

`geolibre.Map` is a [leafmap](https://leafmap.org)-style API over the same
project format the MCP server writes. Two ways to use it:

- **In a notebook** — the full GeoLibre app renders in the cell as an
  [anywidget](https://anywidget.dev), and state syncs both ways: layers you add
  from Python appear in the UI, and pans, zooms, and edits you make in the UI
  read back into Python.
- **Headless, in a plain script** — construct a `Map`, build it up, and call
  `save_project()` / `to_html()`. No kernel, no browser, no display needed. This
  is the fallback when the MCP server isn't installed, and the right tool when
  you need a loop, a `for` over a directory, or data from pandas/GeoPandas.

## Headless generation

```python
from geolibre import Map

m = Map(center=(-100, 40), zoom=4, basemap="positron")
m.add_geojson("https://example.com/counties.geojson", name="Counties")
m.save_project("counties.geolibre.json")   # a project the app opens
m.to_html("counties.html", title="Counties")  # a page anyone opens
```

`save_project()` and `to_project()` **strip credentials by default**. Pass
`keep_credentials=True` only for a trusted local file you are not sharing.

## Adding data

```python
m.add_geojson(data, name="GeoJSON", **style)          # URL, path, or a dict
m.add_gdf(gdf, name="GeoDataFrame", column=None)      # GeoPandas
m.add_data(data, column=None, name="Data")            # dispatches on the format
m.add_vector(data, name="Vector", render_mode="geojson", data_format=None)
m.add_shp(data, name="Shapefile")
m.add_gpkg(data, name="GeoPackage", layer=None)
m.add_kml(data, name="KML")
m.add_geoparquet(data, name="GeoParquet")
m.add_flatgeobuf(data, name="FlatGeobuf")
m.add_csv(data, x="longitude", y="latitude", name="CSV")
m.add_cog(url, name="COG", bands=None, colormap=None, rescale=None)
m.add_raster(...)                                     # same, incl. a local GeoTIFF
m.add_tile_layer(url, name, tile_size=256, attribution=None)
m.add_ee_layer(ee_object, vis_params=None, name="Earth Engine", shown=True,
               opacity=1.0)
m.add_pmtiles(url, name, tile_type="vector", source_layers=None)
m.add_vector_tiles(url, name, source_layers=None)
m.add_wms(endpoint, layers, name, version="1.1.1")
m.add_wmts(endpoint, name)
m.add_wfs(endpoint, type_name, max_features=1000)
m.add_3d_tiles(url, name, altitude_offset=0)
m.add_video(...)
```

Every `add_*` returns the new layer's **id** and accepts style keyword
arguments inline (`m.add_geojson(url, name="Roads", strokeColor="#ef4444",
strokeWidth=3)`).

`add_ee_layer` accepts an authenticated Earth Engine Image, ImageCollection,
FeatureCollection, Feature, or Geometry. Initialize the Earth Engine Python API
before calling it; ImageCollections are mosaicked and vector objects are styled
into raster tiles — for a FeatureCollection/Feature/Geometry, `vis_params` takes
`ee.FeatureCollection.style()` keys (`color`, `fillColor`, `width`, `pointSize`,
`pointShape`, `lineType`, `styleProperty`, `neighborhood`), not image keys like
`min`/`max`/`palette`. The stored tile URL is tied to an Earth Engine map id
that expires, so a project loaded later may need the Earth Engine layer
regenerated. The result is a plain raster tile layer, not one of the live
layers the app's own Earth Engine panel manages.

### Symbology without precomputing

```python
m.add_choropleth(data, column="pop", class_count=5, colormap="blues",
                 scheme="quantile")
m.add_marker(-122.4, 37.8, properties={"name": "San Francisco"})
m.add_markers(points)
m.add_circle_markers(points)
m.add_marker_cluster(points, cluster_radius=50, cluster_max_zoom=14)
m.add_heatmap(points, radius=35, intensity=1)
m.add_polyline(...)
```

### Local files vs. hosted URLs

`add_raster` / `add_cog` accept a **local** GeoTIFF path on the kernel host: the
bundled localhost server serves it so the app can read it. That only works where
the **browser can reach the kernel's localhost** — local Jupyter, VS Code. On
Colab, JupyterHub, or any remote kernel, pass a hosted URL. The served URL is
also session-scoped, so a saved project or exported HTML will not restore a
local raster later. **For anything durable or shareable, use a hosted URL.**

## Camera, basemap, layers

```python
m.set_center(-122.4, 37.8, zoom=11)
m.set_zoom(9); m.set_bearing(30); m.set_pitch(45)
m.fit_project_bounds([west, south, east, north])
m.set_basemap("dark")            # liberty | bright | positron | dark | fiord
m.add_basemap("dark")            # same, kept for leafmap familiarity

m.layers                          # Layer objects, in draw order
m.layer_names
m.get_layer(id_or_name); m.find_layer(name)
m.set_layer_visibility(layer, False); m.set_layer_opacity(layer, 0.5)
m.rename_layer(layer, "New name"); m.move_layer(layer, index)
m.duplicate_layer(layer); m.remove_layer(layer); m.clear_layers()
m.layer_properties(layer); m.column_values(layer, "column")
m.describe()
```

A `Layer` object mirrors the same operations as attributes:
`layer.name`, `layer.visible`, `layer.opacity`, `layer.style`,
`layer.set_style(...)`, `layer.get_features()`, `layer.zoom_to()`,
`layer.move(i)`, `layer.duplicate()`, `layer.remove()`.

## Map controls

```python
m.add_legend(title="Land cover", builtin="nlcd")
m.add_legend(title="Population", legend_dict={"Low": "#eff6ff", "High": "#1e3a8a"})
m.add_colorbar(colormap="terrain", vmin=0, vmax=3000, label="Elevation", units="m")
m.split_map(left_layers=["Before"], right_layers=["After"], orientation="vertical")
```

## Live interaction (notebook only)

These need a running widget, so they are unavailable headless:

```python
m.fly_to(lng, lat, zoom=12)
m.fit_bounds(bounds)
m.zoom_to_layer(layer)
m.get_view(); m.get_center(); m.get_bounds()
m.identify(lng, lat)
m.get_features(layer)
m.get_selected_features(); m.get_drawn_features(); m.user_rois
m.on_click(fn); m.on_selection_change(fn); m.on_layer_change(fn)
m.to_image()                                    # a PNG of the rendered map
m.list_algorithms(); m.run_algorithm(...)       # client-side processing
m.list_whitebox_tools(); m.run_whitebox_tool(...)
m.run_model_builder(...)
```

## Round-tripping

```python
project = m.to_project()          # a detached dict, credentials stripped
m.load_project("existing.geolibre.json")   # dict, JSON string, or a path
```

`load_project` validates the required top-level keys (`version`, `name`,
`mapView`) and raises `ValueError` rather than failing silently, so it doubles
as a validator for a project you wrote by hand.

## Also available

- **R**: an equivalent R package — <https://geolibre.app/r/>.
- **MCP**: `geolibre.authoring` is the widget-free module both `Map` and the MCP
  tools delegate to. Import it directly if you want project operations without
  constructing a `Map`.
