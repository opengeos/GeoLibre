"""Unit tests for the project/layer builders.

These exercise the pure-Python layer construction without needing a browser or
the bundled web app, so they run in plain CI.
"""

from __future__ import annotations

import json

import pytest

from geolibre import project

POINT_FC = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "A"},
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }
    ],
}


def test_build_empty_project_defaults():
    proj = project.build_empty_project()
    assert proj["version"] == project.PROJECT_VERSION
    assert proj["mapView"]["center"] == [-100, 40]
    assert proj["layers"] == []
    # Preferences must be a fresh copy, not the shared default.
    assert proj["preferences"] is not project.DEFAULT_PROJECT_PREFERENCES


def test_build_empty_project_overrides():
    proj = project.build_empty_project(center=(10, 20), zoom=7, basemap_url="x")
    assert proj["mapView"]["center"] == [10.0, 20.0]
    assert proj["mapView"]["zoom"] == 7.0
    assert proj["basemapStyleUrl"] == "x"


def test_geojson_layer_inlines_data():
    layer = project.geojson_layer("Pts", POINT_FC, fillColor="#ff0000")
    assert layer["type"] == "geojson"
    assert layer["source"] == {"type": "geojson"}
    assert layer["geojson"] == POINT_FC
    assert layer["style"]["fillColor"] == "#ff0000"
    # Unspecified style fields fall back to the defaults.
    assert layer["style"]["strokeWidth"] == project.DEFAULT_LAYER_STYLE["strokeWidth"]


def test_geojson_layer_with_source_url():
    layer = project.geojson_layer("R", POINT_FC, source_url="https://e/x.geojson")
    assert layer["source"]["url"] == "https://e/x.geojson"
    assert layer["sourcePath"] == "https://e/x.geojson"


def test_tile_layer_shape():
    layer = project.tile_layer("OSM", "https://t/{z}/{x}/{y}.png")
    assert layer["type"] == "xyz"
    assert layer["source"]["type"] == "raster"
    assert layer["source"]["tiles"] == ["https://t/{z}/{x}/{y}.png"]
    assert layer["source"]["tileSize"] == 256
    assert layer["metadata"]["sourceKind"] == "xyz-url"


def test_cog_layer_restore_shape():
    layer = project.cog_layer(
        "DEM", "https://e/dem.tif", bands=[1, 2, 3], colormap="terrain"
    )
    assert layer["type"] == "cog"
    assert layer["source"] == {"type": "raster", "url": "https://e/dem.tif"}
    md = layer["metadata"]
    assert md["sourceKind"] == "maplibre-gl-raster"
    assert md["rasterSource"] == "url"
    assert md["externalNativeLayer"] is True
    assert md["nativeLayerIds"] == [layer["id"]]
    assert md["rasterState"]["bands"] == [1, 2, 3]
    assert md["rasterState"]["mode"] == "rgb"
    assert md["rasterState"]["colormap"] == "terrain"


def test_load_featurecollection_passthrough():
    assert project.load_featurecollection(POINT_FC) is POINT_FC


def test_load_featurecollection_wraps_feature():
    feature = POINT_FC["features"][0]
    fc = project.load_featurecollection(feature)
    assert fc["type"] == "FeatureCollection"
    assert fc["features"] == [feature]


def test_load_featurecollection_wraps_geometry():
    fc = project.load_featurecollection({"type": "Point", "coordinates": [1, 2]})
    assert fc["features"][0]["geometry"]["coordinates"] == [1, 2]


def test_load_featurecollection_from_json_string():
    fc = project.load_featurecollection(json.dumps(POINT_FC))
    assert fc["features"][0]["properties"]["name"] == "A"


def test_load_featurecollection_from_file(tmp_path):
    path = tmp_path / "pts.geojson"
    path.write_text(json.dumps(POINT_FC), encoding="utf-8")
    fc = project.load_featurecollection(str(path))
    assert fc == POINT_FC


def test_load_featurecollection_geo_interface():
    class Fake:
        __geo_interface__ = POINT_FC

    assert project.load_featurecollection(Fake()) == POINT_FC


def test_load_featurecollection_invalid():
    with pytest.raises(ValueError):
        project.load_featurecollection(42)
