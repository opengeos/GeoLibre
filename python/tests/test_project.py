"""Unit tests for the project/layer builders.

These exercise the pure-Python layer construction without needing a browser or
the bundled web app, so they run in plain CI.
"""

from __future__ import annotations

import json

import pytest

import geolibre
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


def test_top_level_package_exports_headless_authoring_api(tmp_path):
    proj = project.build_empty_project()
    assert geolibre.basemap_catalog()
    assert geolibre.builtin_legend_names()
    assert geolibre.color_ramp_names()

    path = tmp_path / "map.geolibre.json"
    geolibre.save_project(path, proj)
    loaded = geolibre.load_project(path)
    assert geolibre.describe_project(loaded)["layerCount"] == 0


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


def test_wms_layer_bounds_are_optional():
    # A service layer carries no geometry, so without bounds the app has
    # nothing to zoom to; omitting them must leave the source as it was.
    layer = project.wms_layer("x", "https://e/wms", "a", bounds=[8.14, 38.85, 9.83, 41.31])
    assert layer["source"]["bounds"] == [8.14, 38.85, 9.83, 41.31]
    assert "bounds" not in project.wms_layer("x", "https://e/wms", "a")["source"]


def test_wmts_layer_bounds_are_optional():
    layer = project.wmts_layer("x", "https://e/{z}/{y}/{x}.png", bounds=[-10, 35, 5, 45])
    assert layer["source"]["bounds"] == [-10, 35, 5, 45]
    assert "bounds" not in project.wmts_layer("x", "https://e/{z}/{y}/{x}.png")["source"]


@pytest.mark.parametrize("bad", [[], [1, 2], [1, 2, 3, 4, 5]])
def test_ogc_layer_bounds_must_have_four_values(bad):
    # A short list would reach the app as an extent it cannot use, and an empty
    # one would be dropped without a word, so both are refused here.
    with pytest.raises(ValueError, match="exactly 4 elements"):
        project.wms_layer("x", "https://e/wms", "a", bounds=bad)
    with pytest.raises(ValueError, match="exactly 4 elements"):
        project.wmts_layer("x", "https://e/{z}/{y}/{x}.png", bounds=bad)


@pytest.mark.parametrize(
    ("builder", "args"),
    [
        (project.wms_layer, ("x", "https://e/wms", "a")),
        (project.wmts_layer, ("x", "https://e/{z}/{y}/{x}.png")),
    ],
)
def test_ogc_layer_bounds_reject_non_numbers(builder, args):
    # Four values of the wrong kind must fail like the wrong count does, not
    # with a bare "could not convert string to float" from the comprehension.
    with pytest.raises(ValueError, match="four numbers"):
        builder(*args, bounds=[8, 38, 9, "x"])
    # float() takes "nan" and "inf" without a word, and either would reach the
    # app as an extent it cannot fit to. Map.fit_bounds refuses them too.
    for bad in ([float("nan"), 38, 9, 41], [8, 38, float("inf"), 41]):
        with pytest.raises(ValueError, match="finite numbers"):
            builder(*args, bounds=bad)
    # An int too large for a float raises OverflowError, not ValueError.
    with pytest.raises(ValueError, match="four numbers"):
        builder(*args, bounds=[8, 38, 9, 10**1000])
    # An iterable without len() must not escape as a bare TypeError: the MCP
    # tool wrapper only restates ValueError, so anything else reaches the agent
    # stripped of its message.
    assert builder(*args, bounds=iter([8, 38, 9, 41]))["source"]["bounds"] == [8.0, 38.0, 9.0, 41.0]
    with pytest.raises(ValueError, match="exactly 4 elements"):
        builder(*args, bounds=iter([8, 38, 9]))


@pytest.mark.parametrize(
    ("builder", "args"),
    [
        (project.wms_layer, ("x", "https://e/wms", "a")),
        (project.wmts_layer, ("x", "https://e/{z}/{y}/{x}.png")),
    ],
)
def test_ogc_layer_bounds_check_latitudes_but_not_longitudes(builder, args):
    # A south > north box is the axis-order mixup the docstrings warn about,
    # and latitudes have no wraparound to excuse it.
    with pytest.raises(ValueError, match="latitudes inverted"):
        builder(*args, bounds=[8, 41, 9, 38])
    with pytest.raises(ValueError, match=r"within \+/-90"):
        builder(*args, bounds=[8, -95, 9, 41])
    # Longitudes are another matter: RFC 7946 section 5.2 writes a box crossing
    # the antimeridian as west > east, and authoring.fit_bounds frames one.
    fiji = builder(*args, bounds=[170, -20, -170, -10])
    assert fiji["source"]["bounds"] == [170.0, -20.0, -170.0, -10.0]


@pytest.mark.parametrize(
    ("builder", "args"),
    [
        (project.wms_layer, ("x", "https://e/wms", "a")),
        (project.wmts_layer, ("x", "https://e/{z}/{y}/{x}.png")),
    ],
)
def test_ogc_layer_bounds_are_coerced_to_floats(builder, args):
    # Ints compare equal to floats, so assert the stored types: what reaches
    # the project file has to be JSON numbers the app reads as coordinates.
    stored = builder(*args, bounds=[8, 38, 9, 41])["source"]["bounds"]
    assert stored == [8.0, 38.0, 9.0, 41.0]
    assert all(isinstance(v, float) for v in stored)


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


# -- popups, tooltips, and marker symbology ------------------------------------


def test_popup_field_builds_format_block():
    config = project.popup_field(
        "pop", label="Population", kind="number", decimals=1, thousands=True, suffix=" people"
    )
    assert config == {
        "field": "pop",
        "label": "Population",
        "kind": "number",
        "format": {"decimals": 1, "thousands": True, "suffix": " people"},
    }


def test_popup_field_omits_the_default_kind_and_empty_format():
    assert project.popup_field("name") == {"field": "name"}


def test_popup_field_rejects_an_unknown_kind():
    with pytest.raises(ValueError, match="kind must be one of"):
        project.popup_field("name", kind="markdown")


def test_popup_field_rejects_an_unknown_date_format():
    with pytest.raises(ValueError, match="date_format must be one of"):
        project.popup_field("when", kind="date", date_format="rfc2822")


def test_popup_field_rejects_decimals_out_of_intl_range():
    # Intl.NumberFormat throws past 20, taking the whole popup render with it.
    with pytest.raises(ValueError, match="decimals must be between 0 and 20"):
        project.popup_field("pop", kind="number", decimals=25)


def test_popup_field_rejects_a_blank_name():
    with pytest.raises(ValueError, match="non-empty string"):
        project.popup_field("   ")


def test_normalize_popup_returns_none_when_nothing_is_configured():
    assert project.normalize_popup() is None


def test_normalize_popup_accepts_a_single_field_name():
    assert project.normalize_popup("name") == {"fields": [{"field": "name"}]}


def test_normalize_popup_false_suppresses_the_click_popup():
    assert project.normalize_popup(False) == {"click": False}


def test_normalize_popup_accepts_names_and_mappings_together():
    config = project.normalize_popup(["name", {"field": "photo", "kind": "image"}])
    assert config["fields"] == [{"field": "name"}, {"field": "photo", "kind": "image"}]


def test_normalize_popup_accepts_camel_and_snake_config_keys():
    snake = project.normalize_popup({"title_field": "name", "show_feature_id": False})
    camel = project.normalize_popup({"titleField": "name", "showFeatureId": False})
    assert snake == camel == {"titleField": "name", "showFeatureId": False}


def test_normalize_popup_rejects_an_unknown_config_key():
    with pytest.raises(ValueError, match="unknown popup key 'titel'"):
        project.normalize_popup({"titel": "name"})


def test_normalize_popup_rejects_an_unknown_field_key():
    with pytest.raises(ValueError, match="unknown popup field key 'kinde'"):
        project.normalize_popup([{"field": "name", "kinde": "text"}])


def test_normalize_popup_accepts_a_nested_format_block():
    config = project.normalize_popup(
        [{"field": "pop", "kind": "number", "format": {"decimals": 0, "thousands": True}}]
    )
    assert config["fields"][0]["format"] == {"decimals": 0, "thousands": True}


def test_tooltip_flags_the_named_field_and_turns_hover_on():
    config = project.normalize_popup(["name", "pop"], tooltip="name")
    assert config["hover"] is True
    assert config["fields"] == [{"field": "name", "hover": True}, {"field": "pop"}]


def test_tooltip_adds_a_field_the_popup_did_not_list():
    # The hover subset is drawn from `fields`, so a tooltip-only property still
    # has to appear there or the tip would come up empty.
    config = project.normalize_popup(["name"], tooltip=["elev"])
    assert config["fields"][-1] == {"field": "elev", "hover": True}


def test_tooltip_true_flags_every_configured_field():
    config = project.normalize_popup(["name", "pop"], tooltip=True)
    assert [entry["hover"] for entry in config["fields"]] == [True, True]


def test_tooltip_true_without_anything_to_show_is_rejected():
    # createHoverTooltipElement returns null for this, so the tooltip would
    # silently never appear.
    with pytest.raises(ValueError, match="nothing would render in it"):
        project.normalize_popup(tooltip=True)


def test_hover_true_without_anything_to_show_is_rejected_too():
    # The same dead tooltip, reached through the lower-level `hover` argument
    # rather than the tooltip shorthand.
    with pytest.raises(ValueError, match="nothing would render in it"):
        project.normalize_popup({"hover": True})


def test_hover_true_is_fine_once_a_field_carries_it():
    config = project.normalize_popup({"hover": True, "fields": ["name"]}, tooltip="name")
    assert config["hover"] is True


def test_empty_tooltip_sequence_turns_the_tooltip_off():
    # `tooltip=[]` selects no fields, which is what `tooltip=False` means; the
    # MCP tool maps its empty list the same way.
    config = project.normalize_popup(["a"], tooltip=[])
    assert config["hover"] is False
    assert config["fields"] == [{"field": "a"}]


def test_tooltip_true_is_allowed_when_a_title_carries_the_tip():
    config = project.normalize_popup({"title": "name"}, tooltip=True)
    assert config == {"titleField": "name", "hover": True}


def test_tooltip_false_turns_hover_off():
    assert project.normalize_popup("name", tooltip=False)["hover"] is False


def test_popup_can_be_spelled_inside_the_config_mapping():
    assert project.normalize_popup({"fields": ["name"], "tooltip": "name"}) == {
        "fields": [{"field": "name", "hover": True}],
        "hover": True,
    }


def test_layer_builders_put_the_popup_beside_the_style_not_in_it():
    layer = project.geojson_layer("Sites", POINT_FC, popup=["name"], tooltip="name")
    assert layer["popup"] == {"fields": [{"field": "name", "hover": True}], "hover": True}
    assert "popup" not in layer["style"]
    assert "tooltip" not in layer["style"]


def test_layer_builders_omit_the_popup_key_when_none_is_asked_for():
    assert "popup" not in project.geojson_layer("Sites", POINT_FC)


def test_normalize_hex_color_expands_shorthand_and_rejects_names():
    assert project.normalize_hex_color("f00") == "#ff0000"
    assert project.normalize_hex_color("#F00") == "#ff0000"
    assert project.normalize_hex_color("red") is None


def test_marker_style_keeps_circle_rendering_by_default():
    style = project.marker_style(color="#e11d48", radius=8, opacity=0.5)
    assert style["circleRadius"] == 8
    assert "markerEnabled" not in style


def test_marker_style_switches_to_a_sprite_for_a_shape():
    style = project.marker_style(shape="pin", color="#e11d48", size=32)
    assert style["markerEnabled"] is True
    assert style["markerShape"] == "pin"
    assert style["markerColor"] == "#e11d48"
    assert style["markerSize"] == 32


def test_marker_style_size_alone_enables_the_sprite():
    assert project.marker_style(size=24)["markerEnabled"] is True


def test_marker_style_icon_implies_a_custom_shape():
    style = project.marker_style(icon="<svg/>")
    assert style["markerShape"] == "custom"
    assert style["markerSvg"] == "<svg/>"


def test_marker_style_custom_shape_needs_an_icon():
    with pytest.raises(ValueError, match='shape="custom" needs icon='):
        project.marker_style(shape="custom")


def test_marker_style_rejects_an_icon_alongside_another_shape():
    # markerSvg is only read for markerShape "custom", so honoring the icon
    # would quietly throw away the shape the caller asked for.
    with pytest.raises(ValueError, match='icon= implies shape="custom"'):
        project.marker_style(shape="pin", icon="<svg/>")


def test_marker_style_allows_icon_with_an_explicit_custom_shape():
    assert project.marker_style(shape="custom", icon="<svg/>")["markerShape"] == "custom"


def test_marker_style_rejects_a_named_color_for_a_sprite():
    # The sprite baker runs markerColor through normalizeHexColor and falls
    # back to blue, so a CSS name would draw the wrong marker in silence.
    with pytest.raises(ValueError, match="marker sprites need a hex color"):
        project.marker_style(shape="pin", color="red")


def test_marker_style_allows_a_named_color_for_a_circle():
    style = project.marker_style(color="red")
    assert style["fillColor"] == "red"
    assert "markerColor" not in style


def test_marker_style_rejects_an_unknown_shape():
    with pytest.raises(ValueError, match="shape must be one of"):
        project.marker_style(shape="hexagon")


def test_marker_style_rejects_out_of_range_numbers():
    with pytest.raises(ValueError, match="opacity must be between 0 and 1"):
        project.marker_style(opacity=1.5)
    with pytest.raises(ValueError, match="radius must be a finite number"):
        project.marker_style(radius=0)
    with pytest.raises(ValueError, match="size must be a finite number"):
        project.marker_style(size=float("nan"))


def test_marker_style_rejects_circle_only_settings_on_a_sprite():
    # layer-sync removes the circle layer when a sprite is active, and the
    # sprite draws its own white halo, so these would never render.
    with pytest.raises(ValueError, match="only applies to circle markers"):
        project.marker_style(shape="pin", radius=8)
    with pytest.raises(ValueError, match="opacity, stroke_width"):
        project.marker_style(size=20, opacity=0.5, stroke_width=2)


def test_marker_style_still_takes_color_on_a_sprite():
    style = project.marker_style(shape="star", color="#22c55e", size=20)
    assert style["markerColor"] == "#22c55e"


def test_marker_style_is_empty_when_nothing_is_passed():
    assert project.marker_style() == {}


def test_normalize_popup_rejects_a_value_that_is_not_a_field_spec():
    with pytest.raises(ValueError, match="popup fields must be a property name"):
        project.normalize_popup(42)


def test_tooltip_rejects_a_value_that_is_not_a_name_or_sequence():
    with pytest.raises(ValueError, match="tooltip must be True/False"):
        project.normalize_popup(["a"], tooltip=42)


def test_tooltip_only_image_fields_is_rejected():
    # resolvePopupRows drops image rows from the hover subset, so flagging only
    # an image leaves the same empty tip as flagging nothing.
    with pytest.raises(ValueError, match="only image fields are flagged"):
        project.normalize_popup([{"field": "photo", "kind": "image"}], tooltip="photo")


def test_tooltip_accepts_an_image_alongside_a_text_field():
    config = project.normalize_popup(
        [{"field": "photo", "kind": "image"}, "name"], tooltip=["photo", "name"]
    )
    assert config["hover"] is True


def test_a_tooltip_field_also_narrows_the_click_popup():
    # Documented consequence of the app's schema: the tooltip and the click
    # popup share `fields`, and a non-empty list is what the click popup shows.
    assert project.normalize_popup(None, "name")["fields"] == [{"field": "name", "hover": True}]


def test_popup_field_format_block_rejects_a_field_level_flag():
    # `hover` is a field-level flag, not a format concern; accepting it inside
    # `format` would be a hole in the reject-what-you-do-not-recognize rule.
    with pytest.raises(ValueError, match="unknown popup field format key 'hover'"):
        project.normalize_popup([{"field": "x", "format": {"hover": True}}])


def test_popup_field_rejects_a_fractional_decimals():
    # Truncating to 2 would format to a precision nobody asked for.
    with pytest.raises(ValueError, match="decimals must be a whole number"):
        project.popup_field("pop", kind="number", decimals=2.9)


def test_popup_field_accepts_an_integral_float_for_decimals():
    assert project.popup_field("pop", kind="number", decimals=2.0)["format"]["decimals"] == 2
