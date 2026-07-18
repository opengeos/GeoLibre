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
    layer = project.cog_layer("DEM", "https://e/dem.tif", bands=[1, 2, 3], colormap="terrain")
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


def test_wms_layer_shape_and_url():
    layer = project.wms_layer(
        "NAIP",
        "https://example.com/wms",
        "layer:a,layer:b",
        styles="",
        image_format="image/png",
    )
    assert layer["type"] == "wms"
    src = layer["source"]
    assert src["type"] == "raster"
    assert src["tileSize"] == 256
    assert src["url"] == "https://example.com/wms"
    assert src["layers"] == "layer:a,layer:b"
    assert layer["metadata"]["service"] == "wms"
    tile = src["tiles"][0]
    # The bbox placeholder is preserved verbatim; other values are encoded.
    assert "BBOX={bbox-epsg-3857}" in tile
    assert "SERVICE=WMS" in tile
    assert "REQUEST=GetMap" in tile
    assert "LAYERS=layer%3Aa%2Clayer%3Ab" in tile
    assert "SRS=EPSG%3A3857" in tile
    assert "WIDTH=256" in tile


def test_wms_layer_version_1_3_0_uses_crs():
    # A 1.3.0-only server (e.g. the IGN Géoplateforme raster endpoint) rejects
    # a 1.1.1 GetMap, so the version must be honored and SRS renamed to CRS.
    layer = project.wms_layer("x", "https://e/wms", "a", version="1.3.0")
    tile = layer["source"]["tiles"][0]
    assert "VERSION=1.3.0" in tile
    assert "CRS=EPSG%3A3857" in tile
    assert "SRS=" not in tile
    assert "BBOX={bbox-epsg-3857}" in tile
    assert layer["source"]["version"] == "1.3.0"


def test_wms_layer_version_defaults_to_1_1_1():
    layer = project.wms_layer("x", "https://e/wms", "a")
    tile = layer["source"]["tiles"][0]
    assert "VERSION=1.1.1" in tile
    assert "SRS=EPSG%3A3857" in tile
    assert "CRS=" not in tile
    assert layer["source"]["version"] == "1.1.1"
    # An unrecognized version falls back rather than emitting a bad request.
    assert (
        project.wms_layer("x", "https://e/wms", "a", version="2.0")["source"]["version"] == "1.1.1"
    )
    # A None from an untyped caller must not raise.
    assert (
        project.wms_layer("x", "https://e/wms", "a", version=None)["source"]["version"] == "1.1.1"
    )


def test_wms_layer_transparent_false():
    layer = project.wms_layer("x", "https://e/wms", "a", transparent=False, tile_size=512)
    tile = layer["source"]["tiles"][0]
    assert "TRANSPARENT=FALSE" in tile
    assert "WIDTH=512" in tile
    assert layer["source"]["tileSize"] == 512


def test_append_query_keeps_fragment_after_query():
    # A "#fragment" must stay at the end so the query is not pushed past it.
    layer = project.wms_layer("x", "https://e/ows#v2", "a")
    tile = layer["source"]["tiles"][0]
    assert tile.startswith("https://e/ows?SERVICE=WMS")
    assert tile.endswith("#v2")
    assert tile.index("SERVICE=WMS") < tile.index("#v2")


def test_vector_tiles_layer_warns_on_both_source_layer_args():
    with pytest.warns(UserWarning, match="source_layer is ignored"):
        project.vector_tiles_layer("VT", "https://e/t.json", source_layers=["a"], source_layer="b")


def test_wmts_layer_shape():
    layer = project.wmts_layer("W", "https://t/{z}/{y}/{x}.png")
    assert layer["type"] == "wmts"
    assert layer["source"]["tiles"] == ["https://t/{z}/{y}/{x}.png"]
    assert layer["source"]["type"] == "raster"
    assert layer["metadata"]["service"] == "wmts"


def test_wfs_getfeature_url_v2():
    url = project.wfs_getfeature_url(
        "https://e/wfs", "topp:states", version="2.0.0", max_features=10
    )
    assert "typeNames=topp%3Astates" in url
    assert "count=10" in url
    assert "service=WFS" in url
    assert "outputFormat=application%2Fjson" in url


def test_wfs_getfeature_url_v1_uses_legacy_params():
    url = project.wfs_getfeature_url(
        "https://e/wfs?token=1", "ns:type", version="1.1.0", max_features=5
    )
    assert "typeName=ns%3Atype" in url
    assert "maxFeatures=5" in url
    # An existing query string is respected with an "&" separator.
    assert "wfs?token=1&" in url


def test_vector_layer_geojson_mode():
    layer = project.vector_layer("V", "https://e/data.parquet", data_format="parquet")
    assert layer["type"] == "geojson"
    assert layer["source"] == {"type": "geojson", "url": "https://e/data.parquet"}
    md = layer["metadata"]
    assert md["sourceKind"] == "maplibre-gl-vector"
    assert md["externalNativeLayer"] is True
    assert md["controlOwnsPaint"] is True
    assert md["vectorSource"] == "url"
    assert md["vectorState"] == {"renderMode": "geojson", "format": "parquet"}
    assert layer["sourcePath"] == "https://e/data.parquet"


def test_vector_layer_tiles_mode():
    layer = project.vector_layer("V", "https://e/data.fgb", render_mode="tiles")
    assert layer["type"] == "vector-tiles"
    assert layer["source"]["type"] == "vector"
    assert layer["metadata"]["vectorState"]["renderMode"] == "tiles"


def test_vector_layer_invalid_render_mode():
    with pytest.raises(ValueError, match="render_mode must be"):
        project.vector_layer("V", "https://e/x", render_mode="bogus")


def test_vector_tiles_layer_shape():
    layer = project.vector_tiles_layer("VT", "https://e/tiles.json", source_layers=["a", "b"])
    assert layer["type"] == "vector-tiles"
    assert layer["source"] == {
        "type": "vector",
        "url": "https://e/tiles.json",
        "sourceLayers": ["a", "b"],
    }


def test_pmtiles_layer_vector_shape():
    layer = project.pmtiles_layer("P", "https://e/tiles.pmtiles", source_layers=["roads"])
    assert layer["type"] == "pmtiles"
    assert layer["source"]["type"] == "vector"
    assert layer["source"]["tileType"] == "vector"
    assert layer["source"]["sourceId"] == layer["id"]
    md = layer["metadata"]
    assert md["sourceKind"] == "pmtiles-url"
    assert md["externalNativeLayer"] is True
    assert md["sourceLayers"] == ["roads"]
    # nativeLayerIds must be non-empty or isExternalNativeLayer() skips render.
    assert md["nativeLayerIds"] == [layer["id"]]


def test_pmtiles_layer_raster_shape():
    layer = project.pmtiles_layer("P", "https://e/r.pmtiles", tile_type="raster")
    assert layer["source"]["type"] == "raster"
    assert layer["metadata"]["tileType"] == "raster"
    # Raster placeholder matches ensurePMTilesExternalLayer's computed fallback.
    assert layer["metadata"]["nativeLayerIds"] == [f"{layer['id']}-raster"]


def test_pmtiles_layer_invalid_tile_type():
    with pytest.raises(ValueError, match="tile_type must be"):
        project.pmtiles_layer("P", "https://e/x.pmtiles", tile_type="bogus")


def test_three_d_tiles_layer_shape():
    layer = project.three_d_tiles_layer(
        "T", "https://e/tileset.json", altitude_offset=12, request_headers={"k": "v"}
    )
    assert layer["type"] == "3d-tiles"
    assert layer["source"]["url"] == "https://e/tileset.json"
    assert layer["source"]["altitudeOffset"] == 12
    assert layer["source"]["requestHeaders"] == {"k": "v"}
    md = layer["metadata"]
    assert md["sourceKind"] == "3d-tiles-url"
    assert md["externalNativeLayer"] is True
    assert md["customLayerType"] == "3d-tiles"
    assert md["nativeLayerIds"] == [layer["id"]]


def test_three_d_tiles_layer_omits_empty_headers():
    layer = project.three_d_tiles_layer("T", "https://e/tileset.json")
    assert "requestHeaders" not in layer["source"]


def test_video_layer_shape():
    corners = [[-122, 38], [-121, 38], [-121, 37], [-122, 37]]
    layer = project.video_layer("Vid", ["https://e/a.mp4", "https://e/a.webm"], corners)
    assert layer["type"] == "video"
    assert layer["source"]["type"] == "video"
    assert layer["source"]["urls"] == ["https://e/a.mp4", "https://e/a.webm"]
    assert layer["source"]["coordinates"] == corners
    assert layer["sourcePath"] == "https://e/a.mp4"
    assert layer["metadata"]["sourceKind"] == "video-url"
    # bounds is [west, south, east, north] of the four corners.
    assert layer["metadata"]["bounds"] == [-122, 37, -121, 38]


def test_video_layer_requires_url():
    with pytest.raises(ValueError, match="non-empty URL"):
        project.video_layer("Vid", [], [[0, 0], [1, 0], [1, 1], [0, 1]])


def test_video_layer_requires_four_corners():
    with pytest.raises(ValueError, match=r"four \[lng, lat\] corners"):
        project.video_layer("Vid", ["https://e/a.mp4"], [[0, 0], [1, 1]])


def test_video_layer_rejects_non_https():
    with pytest.raises(ValueError, match="https://"):
        project.video_layer("Vid", ["http://e/a.mp4"], [[0, 0], [1, 0], [1, 1], [0, 1]])


def test_video_layer_rejects_non_string_url():
    with pytest.raises(ValueError, match="non-empty string"):
        project.video_layer("Vid", ["https://e/a.mp4", None], [[0, 0], [1, 0], [1, 1], [0, 1]])


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
