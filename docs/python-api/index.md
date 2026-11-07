# Python API Reference

This reference is generated from the docstrings in the
[`geolibre`](https://pypi.org/project/geolibre/) Python package
(`python/src/geolibre`), so it always matches the source. For installation and a
guided tour of the API, see [Python Package](../python.md).

The names most notebooks need are re-exported from the top-level package:

```python
import geolibre

m = geolibre.Map(center=[-100, 40], zoom=3)
```

| Module | Contents |
| --- | --- |
| [Map, Layer and Feature](map.md) | The Jupyter widget and its leafmap-style API |
| [authoring](authoring.md) | Widget-free load, save, describe and edit operations on project dicts |
| [project](project.md) | Builders for `.geolibre.json` projects and their layers |
| [color_ramp](color_ramp.md) | Color ramps and classification breaks |
| [legends](legends.md) | Built-in legend presets |
| [basemaps](basemaps.md) | Named basemap styles |
| [polyline](polyline.md) | Google Encoded Polyline helpers |
| [pointcloud](pointcloud.md) | Point cloud labelling and LAS/LAZ writing |
| [spaceborne_lidar](spaceborne_lidar.md) | ICESat-2 and GEDI footprint readers |
| [dash_component](dash_component.md) | The `DashMap` component for Dash apps |
