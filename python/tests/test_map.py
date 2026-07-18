"""Tests for Map helpers that do not require a running widget/server."""

from __future__ import annotations

import pytest

import geolibre.geolibre as gmod
from geolibre.geolibre import Map


@pytest.fixture
def m(monkeypatch):
    """A Map instance with the static server stubbed out (no bundle needed)."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    return Map()


def _last_layer(widget):
    return widget.project["layers"][-1]


def test_remote_mode_explicit():
    assert Map._resolve_remote_mode(True) == "remote"
    assert Map._resolve_remote_mode(False) == ""


def test_remote_mode_auto_local(monkeypatch):
    monkeypatch.delenv("JUPYTERHUB_SERVICE_PREFIX", raising=False)
    assert Map._resolve_remote_mode("auto") == ""


def test_remote_mode_auto_jupyterhub(monkeypatch):
    monkeypatch.setenv("JUPYTERHUB_SERVICE_PREFIX", "/user/alice/")
    assert Map._resolve_remote_mode("auto") == "remote"


def test_remote_mode_invalid():
    with pytest.raises(ValueError):
        Map._resolve_remote_mode("bogus")


def test_remote_mode_colab_forces_direct(monkeypatch):
    # Colab uses its own port proxy (front-end), which needs the localhost
    # server; an explicit server_proxy=True must not switch it to the remote
    # path.
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: True))
    assert Map._resolve_remote_mode(True) == ""


def test_remote_mode_non_colab_uses_remote(monkeypatch):
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: False))
    assert Map._resolve_remote_mode(True) == "remote"


def test_add_wms_appends_record_and_bumps_seq(m):
    seq = m._seq
    layer_id = m.add_wms("https://e/wms", "a,b")
    layer = _last_layer(m)
    assert layer["id"] == layer_id
    assert layer["type"] == "wms"
    assert m._seq == seq + 1


def test_add_wmts(m):
    m.add_wmts("https://t/{z}/{y}/{x}.png")
    assert _last_layer(m)["type"] == "wmts"


def test_add_raster_is_cog(m):
    m.add_raster("https://e/dem.tif", bands=[1, 2, 3])
    layer = _last_layer(m)
    assert layer["type"] == "cog"
    assert layer["metadata"]["rasterState"]["bands"] == [1, 2, 3]


def test_add_vector_url_uses_control(m):
    m.add_vector("https://e/data.fgb", data_format="flatgeobuf")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["metadata"]["sourceKind"] == "maplibre-gl-vector"


def test_add_geoparquet_sets_format(m):
    m.add_geoparquet("https://e/d.parquet")
    assert _last_layer(m)["metadata"]["vectorState"]["format"] == "parquet"


def test_add_flatgeobuf_sets_format(m):
    m.add_flatgeobuf("https://e/d.fgb")
    assert _last_layer(m)["metadata"]["vectorState"]["format"] == "flatgeobuf"


def test_add_vector_tiles(m):
    m.add_vector_tiles("https://e/tiles.json", source_layer="x")
    layer = _last_layer(m)
    assert layer["type"] == "vector-tiles"
    assert layer["source"]["sourceLayer"] == "x"


def test_add_pmtiles(m):
    m.add_pmtiles("https://e/x.pmtiles", source_layers=["roads"])
    layer = _last_layer(m)
    assert layer["type"] == "pmtiles"
    assert layer["metadata"]["sourceLayers"] == ["roads"]


def test_add_3d_tiles(m):
    m.add_3d_tiles("https://e/tileset.json", altitude_offset=5)
    layer = _last_layer(m)
    assert layer["type"] == "3d-tiles"
    assert layer["source"]["altitudeOffset"] == 5


def test_add_video_wraps_single_url(m):
    m.add_video("https://e/a.mp4", [[0, 0], [1, 0], [1, 1], [0, 1]])
    assert _last_layer(m)["source"]["urls"] == ["https://e/a.mp4"]


def test_add_wfs_inlines_geojson(monkeypatch, m):
    fake_fc = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": None}],
    }
    monkeypatch.setattr(gmod._project, "load_featurecollection", lambda _url: fake_fc)
    m.add_wfs("https://e/wfs", "topp:states")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["geojson"] == fake_fc
    assert layer["metadata"]["service"] == "wfs"
    assert layer["metadata"]["sourceKind"] == "wfs-getfeature"
    assert layer["metadata"]["typeName"] == "topp:states"
    assert layer["metadata"]["featureCount"] == 1
    # Protocol fields are persisted on the source for round-trip editing.
    assert layer["source"]["service"] == "wfs"
    assert layer["source"]["typeName"] == "topp:states"
    assert layer["source"]["version"] == "2.0.0"
    assert layer["source"]["outputFormat"] == "application/json"


def test_add_vector_local_file_inlined(monkeypatch, m):
    fake_fc = {"type": "FeatureCollection", "features": []}
    captured = {}

    def fake_read(path, data_format=None):
        captured["path"] = path
        captured["data_format"] = data_format
        return fake_fc

    monkeypatch.setattr(gmod, "_read_local_vector", fake_read)
    # add_geoparquet routes a local path with the parquet hint threaded through.
    m.add_geoparquet("/data/cities.parquet")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["geojson"] == fake_fc
    assert captured["data_format"] == "parquet"


def test_add_vector_local_file_warns_on_ignored_kwargs(monkeypatch, m):
    monkeypatch.setattr(gmod, "_read_local_vector", lambda _p, data_format=None: {"type": "x"})
    with pytest.warns(UserWarning, match="ignored for local files"):
        m.add_vector("/data/parcels.shp", source_layer="layer0")


def test_add_vector_geo_interface_inlined(m):
    class Fake:
        __geo_interface__ = {"type": "FeatureCollection", "features": []}

    m.add_vector(Fake(), name="GDF")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["name"] == "GDF"


def test_add_vector_geo_interface_warns_on_ignored_kwargs(m):
    class Fake:
        __geo_interface__ = {"type": "FeatureCollection", "features": []}

    with pytest.warns(UserWarning, match="__geo_interface__ objects"):
        m.add_vector(Fake(), render_mode="tiles")


# -- local raster ---------------------------------------------------------


def test_add_raster_local_path_served(monkeypatch, m):
    monkeypatch.setattr(
        gmod, "register_local_file", lambda path: f"http://127.0.0.1:0/served/{path}"
    )
    m.add_raster("/data/dem.tif", colormap="terrain")
    layer = _last_layer(m)
    assert layer["type"] == "cog"
    assert layer["source"]["url"] == "http://127.0.0.1:0/served//data/dem.tif"
    assert layer["metadata"]["rasterState"]["colormap"] == "terrain"


def test_add_raster_url_not_served(monkeypatch, m):
    called = {"n": 0}

    def boom(_path):
        called["n"] += 1
        raise AssertionError("URL rasters must not be routed to the file server")

    monkeypatch.setattr(gmod, "register_local_file", boom)
    m.add_raster("https://e/dem.tif")
    assert called["n"] == 0
    assert _last_layer(m)["source"]["url"] == "https://e/dem.tif"


# -- markers --------------------------------------------------------------


def test_add_marker_single_point(m):
    m.add_marker(-100, 40, properties={"name": "Center"}, fillColor="#ff0000")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    feature = layer["geojson"]["features"][0]
    assert feature["geometry"]["coordinates"] == [-100.0, 40.0]
    assert feature["properties"]["name"] == "Center"
    assert layer["style"]["fillColor"] == "#ff0000"


def test_add_markers_from_pairs(m):
    m.add_markers([(-100, 40), (-90, 35)])
    features = _last_layer(m)["geojson"]["features"]
    assert [f["geometry"]["coordinates"] for f in features] == [
        [-100.0, 40.0],
        [-90.0, 35.0],
    ]


def test_add_markers_from_dicts_keeps_properties(m):
    m.add_markers([{"lon": -100, "lat": 40, "pop": 5}, {"x": -90, "y": 35}])
    features = _last_layer(m)["geojson"]["features"]
    assert features[0]["properties"] == {"pop": 5}
    assert features[1]["geometry"]["coordinates"] == [-90.0, 35.0]


def test_add_markers_rejects_bad_pair(m):
    with pytest.raises(ValueError, match="lng, lat"):
        m.add_markers([(-100, 40, 1)])


def test_add_markers_rejects_dict_missing_coords(m):
    with pytest.raises(ValueError, match="longitude"):
        m.add_markers([{"pop": 5}])


def test_add_markers_rejects_non_point_geojson(m):
    polygon_fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
            }
        ],
    }
    with pytest.raises(ValueError, match="Point/MultiPoint"):
        m.add_markers(polygon_fc)


def test_add_markers_from_geojson(m):
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Point", "coordinates": [1, 2]},
            }
        ],
    }
    m.add_markers(fc)
    assert _last_layer(m)["geojson"]["features"][0]["geometry"]["coordinates"] == [1, 2]


def test_add_circle_markers_sets_radius(m):
    m.add_circle_markers([(0, 0)], radius=12)
    assert _last_layer(m)["style"]["circleRadius"] == 12.0


def test_add_marker_cluster_enables_clustering(m):
    m.add_marker_cluster([(0, 0), (1, 1)], cluster_radius=80, cluster_max_zoom=10)
    style = _last_layer(m)["style"]
    assert style["pointRenderer"] == "cluster"
    assert style["clusterRadius"] == 80
    assert style["clusterMaxZoom"] == 10


# -- choropleth -----------------------------------------------------------


def _choropleth_fc():
    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"pop": v}, "geometry": None}
            for v in (0, 10, 20, 30, 40)
        ],
    }


def test_add_choropleth_builds_graduated_style(m):
    m.add_choropleth(_choropleth_fc(), "pop", class_count=5, colormap="blues")
    style = _last_layer(m)["style"]
    assert style["vectorStyleMode"] == "graduated"
    assert style["vectorStyleProperty"] == "pop"
    assert style["vectorStyleColorRamp"] == "blues"
    assert len(style["vectorStyleStops"]) == 5
    assert style["vectorStyleStops"][0]["value"] == 0.0
    assert style["vectorStyleStops"][-1]["value"] == 40.0


def test_add_choropleth_missing_column_raises(m):
    with pytest.raises(ValueError, match="not found"):
        m.add_choropleth(_choropleth_fc(), "missing")


def test_add_choropleth_non_numeric_column_raises(m):
    fc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"name": label}, "geometry": None}
            for label in ("alpha", "beta", "gamma")
        ],
    }
    with pytest.raises(ValueError, match="numeric value"):
        m.add_choropleth(fc, "name")


def test_add_choropleth_style_override_wins(m):
    m.add_choropleth(_choropleth_fc(), "pop", strokeColor="#000000")
    assert _last_layer(m)["style"]["strokeColor"] == "#000000"


def test_add_data_without_column_is_plain_geojson(m):
    m.add_data(_choropleth_fc())
    assert _last_layer(m)["style"]["vectorStyleMode"] == "single"


def test_add_data_with_column_is_choropleth(m):
    m.add_data(_choropleth_fc(), column="pop")
    assert _last_layer(m)["style"]["vectorStyleMode"] == "graduated"


# -- split map / legend / colorbar -------------------------------------------


def _plugins(widget):
    return widget.project.get("plugins", {})


def test_split_map_activates_swipe_plugin(m):
    a = m.add_geojson(_choropleth_fc(), name="A")
    b = m.add_geojson(_choropleth_fc(), name="B")
    m.split_map(a, b, position=40, control_position="bottom-right")
    plugins = _plugins(m)
    assert "maplibre-gl-swipe" in plugins["activePluginIds"]
    assert plugins["mapControlPositions"]["maplibre-gl-swipe"] == "bottom-right"
    swipe = plugins["settings"]["maplibre-gl-swipe"]
    assert swipe["leftLayers"] == [a]
    assert swipe["rightLayers"] == [b]
    assert swipe["position"] == 40
    assert swipe["active"] is True


def test_plugins_block_seeds_default_active(m):
    # A fresh plugins block must keep the app's default plugins active, else
    # restoreProjectState would tear down the layer control / deck.gl overlay.
    m.split_map()
    active = _plugins(m)["activePluginIds"]
    for plugin_id in (
        "maplibre-layer-control",
        "maplibre-deckgl-viz",
        "maplibre-atmosphere-effects",
    ):
        assert plugin_id in active


def test_split_map_accepts_layer_objects_and_lists(m):
    a = m.add_geojson(_choropleth_fc(), name="A")
    layer = m.get_layer(a)
    m.split_map(layer, ["__basemap__"])
    swipe = _plugins(m)["settings"]["maplibre-gl-swipe"]
    assert swipe["leftLayers"] == [a]
    assert swipe["rightLayers"] == ["__basemap__"]


def test_split_map_clamps_position(m):
    m.split_map(position=999)
    assert _plugins(m)["settings"]["maplibre-gl-swipe"]["position"] == 100


def test_split_map_rejects_bad_orientation(m):
    with pytest.raises(ValueError, match="orientation"):
        m.split_map(orientation="diagonal")


def test_split_map_rejects_bad_layer_reference(m):
    with pytest.raises(ValueError, match="layer id"):
        m.split_map([123])


def test_split_map_rejects_bare_non_iterable(m):
    # A bare non-iterable must raise the documented ValueError, not TypeError.
    with pytest.raises(ValueError, match="layer id"):
        m.split_map(123)


def test_existing_plugins_block_is_not_reseeded(m):
    # A project that already carries a plugins block reflects deliberate choices,
    # so adding a control must not inject the default-active ids into it.
    project = m.to_project()
    project["plugins"] = {
        "manifestUrls": [],
        "activePluginIds": ["maplibre-layer-control"],
        "mapControlPositions": {},
        "settings": {},
    }
    m.load_project(project)
    m.add_legend(legend_dict={"a": "#111"})
    assert _plugins(m)["activePluginIds"] == ["maplibre-layer-control"]


def _components(widget):
    return _plugins(widget)["settings"]["maplibre-gl-components"]


def test_add_legend_from_dict(m):
    m.add_legend("Cover", legend_dict={"Water": "#0000ff", "Land": "#00ff00"})
    # The Components plugin restores from settings alone; it is not added to
    # activePluginIds (that would mount the full Components toolbar).
    assert "maplibre-gl-components" not in _plugins(m)["activePluginIds"]
    legend = _components(m)["legend"]
    assert legend["visible"] is True
    assert legend["title"] == "Cover"
    assert legend["hasLegend"] is True
    assert legend["selectedLegendIndex"] == 0
    assert legend["legends"][0]["items"] == [
        {"label": "Water", "color": "#0000ff", "shape": "square"},
        {"label": "Land", "color": "#00ff00", "shape": "square"},
    ]


def test_add_legend_from_labels_and_colors(m):
    m.add_legend(labels=["a", "b"], colors=["#111", "#222"], shape="circle")
    items = _components(m)["legend"]["legends"][0]["items"]
    assert [i["label"] for i in items] == ["a", "b"]
    assert all(i["shape"] == "circle" for i in items)


def test_add_legend_builtin_nlcd(m):
    m.add_legend(builtin="nlcd")
    legend = _components(m)["legend"]
    assert legend["title"] == "NLCD Land Cover"
    labels = [i["label"] for i in legend["legends"][0]["items"]]
    assert "Open Water" in labels


def test_add_legend_builtin_esa_alias(m):
    m.add_legend(builtin="esa")
    assert _components(m)["legend"]["title"] == "ESA WorldCover"


def test_add_legend_unknown_builtin_raises(m):
    with pytest.raises(ValueError, match="Unknown built-in legend"):
        m.add_legend(builtin="nope")


def test_add_legend_requires_entries(m):
    with pytest.raises(ValueError, match="Provide legend entries"):
        m.add_legend("Empty")


def test_add_legend_mismatched_labels_colors(m):
    with pytest.raises(ValueError, match="same length"):
        m.add_legend(labels=["a", "b"], colors=["#111"])


def test_add_legend_rejects_combined_sources(m):
    # The three entry sources are mutually exclusive.
    with pytest.raises(ValueError, match="exactly one of"):
        m.add_legend(builtin="nlcd", legend_dict={"a": "#111"})


def test_add_legend_appends_multiple(m):
    m.add_legend(legend_dict={"a": "#111"})
    m.add_legend(legend_dict={"b": "#222"}, position="top-right")
    legend = _components(m)["legend"]
    assert len(legend["legends"]) == 2
    assert legend["selectedLegendIndex"] == 1
    assert legend["legends"][1]["legendPosition"] == "top-right"


def test_add_colorbar_named(m):
    m.add_colorbar(colormap="plasma", vmin=0, vmax=255, label="Elevation", units="m")
    colorbar = _components(m)["colorbar"]
    assert colorbar["visible"] is True
    assert colorbar["mode"] == "named"
    assert colorbar["colormap"] == "plasma"
    assert colorbar["vmin"] == 0
    assert colorbar["vmax"] == 255
    assert colorbar["colorbars"][0]["label"] == "Elevation"


def test_add_colorbar_custom_colors(m):
    m.add_colorbar(colors=["#000000", "#ffffff"])
    colorbar = _components(m)["colorbar"]
    assert colorbar["mode"] == "custom"
    assert colorbar["customColors"] == "#000000, #ffffff"


def test_add_colorbar_empty_custom_colors_raises(m):
    with pytest.raises(ValueError, match="non-empty"):
        m.add_colorbar(colors=[])


def test_add_colorbar_bad_position_raises(m):
    with pytest.raises(ValueError, match="position"):
        m.add_colorbar(position="middle")


def test_add_colorbar_rejects_inverted_range(m):
    with pytest.raises(ValueError, match="must be less than"):
        m.add_colorbar(vmin=100, vmax=0)


def test_add_colormap_is_colorbar_alias(m):
    m.add_colormap("inferno", vmin=1, vmax=9, units="K")
    colorbar = _components(m)["colorbar"]
    assert colorbar["colormap"] == "inferno"
    assert colorbar["vmin"] == 1
    assert colorbar["vmax"] == 9


def test_legend_and_colorbar_coexist(m):
    m.add_legend(legend_dict={"a": "#111"})
    m.add_colorbar(colormap="viridis")
    components = _components(m)
    # Adding a colorbar must not drop the existing legend, and vice versa.
    assert "legend" in components
    assert "colorbar" in components
