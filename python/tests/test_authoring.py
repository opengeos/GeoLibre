"""Unit tests for the widget-free project-authoring operations.

These cover the layer that both :class:`geolibre.Map` and the MCP server build
on, so they run without the ``mcp`` SDK, a browser, or the bundled app.
"""

from __future__ import annotations

import json

import pytest

from geolibre import authoring, project

POINT_FC = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "A", "pop": 10},
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        },
        {
            "type": "Feature",
            "properties": {"name": "B", "pop": 90},
            "geometry": {"type": "Point", "coordinates": [1, 1]},
        },
    ],
}


@pytest.fixture
def proj():
    """A project with one inlined GeoJSON layer named "Cities"."""
    p = project.build_empty_project("Test")
    authoring.add_layer(p, project.geojson_layer("Cities", POINT_FC))
    return p


# -- file I/O -----------------------------------------------------------------


def test_save_and_load_round_trip(proj, tmp_path):
    out = tmp_path / "nested" / "map.geolibre.json"
    written = authoring.save_project(out, proj)
    assert written == out
    assert authoring.load_project(out) == proj


def test_save_project_writes_readable_json(proj, tmp_path):
    out = tmp_path / "map.geolibre.json"
    authoring.save_project(out, proj)
    text = out.read_text(encoding="utf-8")
    assert text.endswith("\n")
    # Indented, so a project file diffs line by line rather than as one blob.
    assert "\n  " in text


def test_save_project_leaves_no_temporary_file_behind(proj, tmp_path):
    """The write lands atomically, so only the project itself is left in place."""
    out = tmp_path / "map.geolibre.json"
    authoring.save_project(out, proj)
    authoring.save_project(out, proj)
    assert [path.name for path in tmp_path.iterdir()] == ["map.geolibre.json"]


def test_save_project_preserves_the_destination_mode(proj, tmp_path):
    """Re-saving must not narrow a project the user made group/world readable."""
    out = tmp_path / "map.geolibre.json"
    authoring.save_project(out, proj)
    out.chmod(0o644)
    authoring.save_project(out, proj)
    assert out.stat().st_mode & 0o777 == 0o644


def test_load_project_missing_file(tmp_path):
    with pytest.raises(ValueError, match="not found"):
        authoring.load_project(tmp_path / "nope.json")


def test_load_project_rejects_non_json(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("not json at all", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON"):
        authoring.load_project(bad)


def test_load_project_rejects_non_object(tmp_path):
    bad = tmp_path / "list.json"
    bad.write_text("[1, 2, 3]", encoding="utf-8")
    with pytest.raises(ValueError, match="JSON object"):
        authoring.load_project(bad)


def test_load_project_seeds_missing_layers(tmp_path):
    partial = tmp_path / "partial.json"
    partial.write_text(json.dumps({"name": "Hand written"}), encoding="utf-8")
    assert authoring.load_project(partial)["layers"] == []


# -- layer lookup -------------------------------------------------------------


def test_find_layer_by_id_and_name(proj):
    layer = proj["layers"][0]
    assert authoring.find_layer(proj, layer["id"]) is layer
    assert authoring.find_layer(proj, "Cities") is layer
    assert authoring.find_layer(proj, "cities") is layer


def test_find_layer_prefers_an_id_over_a_name(proj):
    """A layer named after another layer's id must not shadow it."""
    target = proj["layers"][0]
    decoy = project.geojson_layer(target["id"], POINT_FC)
    authoring.add_layer(proj, decoy)
    assert authoring.find_layer(proj, target["id"]) is target


def test_find_layer_ambiguous_name(proj):
    authoring.add_layer(proj, project.geojson_layer("Cities", POINT_FC))
    with pytest.raises(ValueError, match="2 layers are named"):
        authoring.find_layer(proj, "Cities")


def test_find_layer_unknown_lists_what_exists(proj):
    with pytest.raises(ValueError, match="'Cities'"):
        authoring.find_layer(proj, "Rivers")


def test_resolve_layer_ids_passes_the_basemap_through(proj):
    ids = authoring.resolve_layer_ids(proj, ["Cities", "__basemap__"])
    assert ids == [proj["layers"][0]["id"], "__basemap__"]


# -- reading ------------------------------------------------------------------


def test_layer_summary_counts_features_without_echoing_them(proj):
    summary = authoring.layer_summary(proj["layers"][0])
    assert summary["featureCount"] == 2
    assert "geojson" not in summary


def test_describe_project_reports_controls(proj):
    authoring.add_legend(proj, legend_dict={"A": "#111"})
    authoring.add_colorbar(proj, vmin=0, vmax=1)
    authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=[])
    described = authoring.describe_project(proj)
    assert described["layerCount"] == 1
    assert sorted(described["mapControls"]) == ["colorbar", "legend", "swipe"]


def test_describe_project_omits_a_deactivated_swipe(proj):
    """A settings blob left behind by a deactivated control is not a control."""
    authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=[])
    proj["plugins"]["activePluginIds"] = [
        plugin for plugin in proj["plugins"]["activePluginIds"] if "swipe" not in plugin
    ]
    assert authoring.describe_project(proj)["mapControls"] == []


def test_layer_properties_samples_values(proj):
    properties = authoring.layer_properties(proj["layers"][0])
    assert properties["name"] == ["A", "B"]
    assert properties["pop"] == [10, 90]


def test_layer_properties_requires_inlined_geojson(proj):
    authoring.add_layer(proj, project.tile_layer("Basemap tiles", "https://x/{z}/{x}/{y}.png"))
    with pytest.raises(ValueError, match="no inlined GeoJSON"):
        authoring.layer_properties(authoring.find_layer(proj, "Basemap tiles"))


def test_column_values_rejects_a_missing_column(proj):
    with pytest.raises(ValueError, match="not found in any feature"):
        authoring.column_values(proj["layers"][0], "nope")


def test_column_values_separates_an_absent_column_from_an_all_null_one(proj):
    for feature in proj["layers"][0]["geojson"]["features"]:
        feature["properties"]["empty"] = None
    with pytest.raises(ValueError, match="is null in every feature"):
        authoring.column_values(proj["layers"][0], "empty")


def test_column_values_tolerates_a_null_properties_member(proj):
    """GeoJSON permits `"properties": null`; that feature reads as no value."""
    layer = proj["layers"][0]
    layer["geojson"]["features"].append(
        {
            "type": "Feature",
            "properties": None,
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }
    )
    assert authoring.column_values(layer, "pop") == [10, 90, None]


# -- layer mutation -----------------------------------------------------------


def test_add_layer_appends_by_default(proj):
    added = authoring.add_layer(proj, project.geojson_layer("Second", POINT_FC))
    assert [layer["id"] for layer in proj["layers"]][-1] == added


def test_add_layer_honors_an_index(proj):
    added = authoring.add_layer(proj, project.geojson_layer("Under", POINT_FC), index=0)
    assert proj["layers"][0]["id"] == added


def test_remove_layer_by_name(proj):
    authoring.remove_layer(proj, "Cities")
    assert proj["layers"] == []


def test_remove_layer_drops_a_swipe_reference_to_it(proj):
    """A swipe split must not keep pointing at a layer that is gone."""
    layer_id = proj["layers"][0]["id"]
    authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=[layer_id])
    swipe = proj["plugins"]["settings"]["maplibre-gl-swipe"]
    assert swipe["rightLayers"] == [layer_id]
    authoring.remove_layer(proj, "Cities")
    assert swipe["rightLayers"] == []
    # The basemap pseudo-id is not a layer, so it survives untouched.
    assert swipe["leftLayers"] == ["__basemap__"]


def test_update_layer_applies_only_what_is_passed(proj):
    summary = authoring.update_layer(proj, "Cities", visible=False)
    assert summary["visible"] is False
    assert summary["name"] == "Cities"


def test_update_layer_clamps_opacity(proj):
    assert authoring.update_layer(proj, "Cities", opacity=5)["opacity"] == 1.0
    assert authoring.update_layer(proj, "Cities", opacity=-5)["opacity"] == 0.0


def test_add_layer_refuses_the_reserved_basemap_name(proj):
    """The reservation holds at creation, not only on rename."""
    with pytest.raises(ValueError, match="reserved for the basemap"):
        authoring.add_layer(proj, project.geojson_layer("__basemap__", POINT_FC))
    assert len(proj["layers"]) == 1


def test_update_layer_refuses_the_reserved_basemap_name(proj):
    """resolve_layer_ids passes the sentinel through, so a layer must not wear it."""
    with pytest.raises(ValueError, match="reserved for the basemap"):
        authoring.update_layer(proj, "Cities", name="__basemap__")
    assert authoring.resolve_layer_ids(proj, ["Cities"]) == [proj["layers"][0]["id"]]


def test_update_layer_reorders(proj):
    second = authoring.add_layer(proj, project.geojson_layer("Second", POINT_FC))
    authoring.update_layer(proj, second, index=0)
    assert proj["layers"][0]["id"] == second


def test_apply_style_merges_rather_than_replaces(proj):
    merged = authoring.apply_style(proj, "Cities", {"fillColor": "#ff0000"})
    assert merged["fillColor"] == "#ff0000"
    # Untouched defaults survive the merge.
    assert merged["strokeWidth"] == project.DEFAULT_LAYER_STYLE["strokeWidth"]


def test_apply_style_rejects_a_non_mapping(proj):
    with pytest.raises(ValueError, match="must be an object"):
        authoring.apply_style(proj, "Cities", ["fillColor", "#ff0000"])


def test_classify_layer_writes_graduated_symbology(proj):
    fragment = authoring.classify_layer(proj, "Cities", "pop", class_count=3)
    assert fragment["vectorStyleMode"] == "graduated"
    assert fragment["vectorStyleProperty"] == "pop"
    assert len(fragment["vectorStyleStops"]) == 3
    assert proj["layers"][0]["style"]["vectorStyleStops"] == fragment["vectorStyleStops"]


def test_classify_layer_rejects_a_non_numeric_column(proj):
    with pytest.raises(ValueError, match="at least one numeric value"):
        authoring.classify_layer(proj, "Cities", "name")


def test_build_choropleth_style_clamps_the_class_count():
    fragment = authoring.build_choropleth_style([1, 2, 3], "pop", class_count=99)
    assert fragment["vectorStyleClassCount"] == 12


# -- camera and basemap -------------------------------------------------------


def test_set_view_clamps_zoom_and_pitch(proj):
    view = authoring.set_view(proj, zoom=99, pitch=180)
    assert view["zoom"] == 24.0
    assert view["pitch"] == 85.0


def test_set_view_rejects_a_malformed_center(proj):
    with pytest.raises(ValueError, match="exactly 2 finite numbers"):
        authoring.set_view(proj, center=[1, 2, 3])


def test_set_view_rejects_non_finite_camera_values(proj):
    """`1e400` parses to inf, and json.dumps would write a bare Infinity token."""
    infinity = float("1e400")
    with pytest.raises(ValueError, match="exactly 2 finite numbers"):
        authoring.set_view(proj, center=[infinity, 0])
    for field in ("zoom", "bearing", "pitch"):
        with pytest.raises(ValueError, match=f"{field} must be a finite number"):
            authoring.set_view(proj, **{field: infinity})
        with pytest.raises(ValueError, match=f"{field} must be a finite number"):
            authoring.set_view(proj, **{field: float("nan")})


def test_save_project_refuses_to_write_invalid_json(proj, tmp_path):
    """The backstop: no path may write an Infinity token the app cannot parse."""
    proj["mapView"]["zoom"] = float("inf")
    with pytest.raises(ValueError):
        authoring.save_project(tmp_path / "map.geolibre.json", proj)
    assert list(tmp_path.iterdir()) == []


def test_set_view_drops_a_bbox_the_camera_no_longer_shows(proj):
    """A stale bbox would keep feeding the app's status-bar extent readout."""
    authoring.fit_bounds(proj, [-10, -10, 10, 10])
    assert authoring.set_view(proj, bearing=45)["bbox"] == [-10, -10, 10, 10]
    assert "bbox" not in authoring.set_view(proj, center=[100, 20])
    authoring.fit_bounds(proj, [-10, -10, 10, 10])
    assert "bbox" not in authoring.set_view(proj, zoom=3)


def test_fit_bounds_centers_on_the_box(proj):
    view = authoring.fit_bounds(proj, [-10, -10, 10, 10])
    assert view["center"][0] == pytest.approx(0)
    assert view["center"][1] == pytest.approx(0, abs=1e-9)
    assert view["bbox"] == [-10, -10, 10, 10]


def test_fit_bounds_frames_a_box_crossing_the_antimeridian(proj):
    """RFC 7946 5.2 writes such a box with min_lng > max_lng; Fiji, not an error."""
    view = authoring.fit_bounds(proj, [170, -20, -170, -10])
    assert view["center"][0] == pytest.approx(180 if view["center"][0] > 0 else -180)
    # The box spans 20 degrees the short way, not 340 the long way, so the fit
    # is as close in as the equivalent box that does not cross.
    plain = authoring.fit_bounds(proj, [10, -20, 30, -10])["zoom"]
    assert view["zoom"] == pytest.approx(plain)


def test_fit_bounds_zooms_further_in_for_a_smaller_box(proj):
    world = authoring.fit_bounds(proj, [-180, -85, 180, 85])["zoom"]
    city = authoring.fit_bounds(proj, [-84.0, 35.9, -83.8, 36.0])["zoom"]
    assert world < 1.5
    assert city > 8
    assert city > world


def test_fit_bounds_handles_a_degenerate_box(proj):
    """A point box has no extent to fit, so it falls back to a close-in zoom."""
    view = authoring.fit_bounds(proj, [5, 5, 5, 5])
    assert view["center"][0] == pytest.approx(5)
    assert view["zoom"] == 14.0


def test_fit_bounds_rejects_an_inverted_box(proj):
    with pytest.raises(ValueError, match="inverted"):
        authoring.fit_bounds(proj, [10, 10, -10, -10])


def test_fit_bounds_rejects_latitudes_outside_web_mercator(proj):
    with pytest.raises(ValueError, match="Web Mercator"):
        authoring.fit_bounds(proj, [-10, -89, 10, 89])


def test_fit_bounds_rejects_a_short_box(proj):
    with pytest.raises(ValueError, match="min_lng"):
        authoring.fit_bounds(proj, [-10, -10, 10])


def test_set_basemap_resolves_a_name(proj):
    url = authoring.set_basemap(proj, "dark")
    assert url.endswith("/dark")
    assert proj["basemapStyleUrl"] == url


def test_set_basemap_accepts_a_url(proj):
    url = "https://example.com/style.json"
    assert authoring.set_basemap(proj, url) == url


def test_catalogs_are_non_empty():
    assert "liberty" in authoring.basemap_catalog()
    assert "viridis" in authoring.color_ramp_names()


# -- map controls -------------------------------------------------------------


def test_add_legend_from_a_dict(proj):
    entry = authoring.add_legend(proj, "Cover", legend_dict={"Water": "#00f"})
    assert entry["title"] == "Cover"
    settings = proj["plugins"]["settings"][project.COMPONENTS_PLUGIN_ID]
    assert settings["legend"]["legends"][0]["items"][0]["label"] == "Water"


def test_add_legend_from_a_builtin_preset(proj):
    entry = authoring.add_legend(proj, builtin="nlcd")
    assert entry["title"] == "NLCD Land Cover"


def test_add_legend_rejects_combined_sources(proj):
    with pytest.raises(ValueError, match="exactly one of"):
        authoring.add_legend(proj, builtin="nlcd", legend_dict={"a": "#111"})


def test_add_legend_rejects_a_bad_shape(proj):
    with pytest.raises(ValueError, match="shape must be one of"):
        authoring.add_legend(proj, legend_dict={"a": "#111"}, shape="hexagon")


def test_adding_a_colorbar_keeps_an_existing_legend(proj):
    """Both features share one settings blob, so neither may clobber the other."""
    authoring.add_legend(proj, legend_dict={"a": "#111"})
    authoring.add_colorbar(proj, vmin=0, vmax=100)
    components = proj["plugins"]["settings"][project.COMPONENTS_PLUGIN_ID]
    assert "legend" in components
    assert "colorbar" in components


def test_add_colorbar_rejects_an_inverted_range(proj):
    with pytest.raises(ValueError, match="must be less than"):
        authoring.add_colorbar(proj, vmin=10, vmax=1)


def test_add_colorbar_rejects_empty_custom_colors(proj):
    with pytest.raises(ValueError, match="non-empty"):
        authoring.add_colorbar(proj, colors=[])


def test_add_swipe_clamps_the_slider_position(proj):
    state = authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=[], position=999)
    assert state["position"] == 100.0
    assert project.SWIPE_PLUGIN_ID in proj["plugins"]["settings"]


def test_add_swipe_lists_the_style_layer_id_of_a_raster_layer(proj):
    """A WMS side carries the id the control acts on, not just the layer id."""
    authoring.add_layer(proj, project.wms_layer("Aerial", "https://example.org/wms", "aerial"))
    authoring.add_layer(proj, project.wms_layer("Historic", "https://example.org/wms", "historic"))
    aerial = authoring.find_layer(proj, "Aerial")["id"]
    historic = authoring.find_layer(proj, "Historic")["id"]

    state = authoring.add_swipe(proj, left_layers=[historic], right_layers=[aerial])

    assert state["leftLayers"] == [historic, f"layer-{historic}-raster"]
    assert state["rightLayers"] == [aerial, f"layer-{aerial}-raster"]


def test_add_swipe_leaves_non_raster_sides_alone(proj):
    """A GeoJSON layer draws through several style layers, so it is untouched."""
    cities = authoring.find_layer(proj, "Cities")["id"]
    state = authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=[cities])
    assert state["leftLayers"] == ["__basemap__"]
    assert state["rightLayers"] == [cities]


def test_remove_layer_drops_the_style_layer_id_too(proj):
    """Removing a WMS layer leaves no dangling style id behind on a side."""
    authoring.add_layer(proj, project.wms_layer("Aerial", "https://example.org/wms", "aerial"))
    aerial = authoring.find_layer(proj, "Aerial")["id"]
    authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=[aerial])

    authoring.remove_layer(proj, "Aerial")

    swipe = proj["plugins"]["settings"][project.SWIPE_PLUGIN_ID]
    assert swipe["rightLayers"] == []


def test_add_swipe_lists_the_style_layer_id_of_a_raster_pmtiles_layer(proj):
    """A raster PMTiles archive is drawn as `<sourceId>-raster`, with no prefix."""
    authoring.add_layer(
        proj,
        project.pmtiles_layer("Scan", "https://example.org/scan.pmtiles", tile_type="raster"),
    )
    scan = authoring.find_layer(proj, "Scan")
    source_id = scan["metadata"]["sourceId"]

    state = authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=[scan["id"]])

    assert state["rightLayers"] == [scan["id"], f"{source_id}-raster"]


def test_add_swipe_leaves_a_vector_pmtiles_layer_alone(proj):
    """Vector tile ids depend on source layer and kind, so none is derived here."""
    authoring.add_layer(
        proj,
        project.pmtiles_layer(
            "Roads", "https://example.org/roads.pmtiles", source_layers=["roads"]
        ),
    )
    roads = authoring.find_layer(proj, "Roads")["id"]

    state = authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=[roads])

    assert state["rightLayers"] == [roads]


def test_add_swipe_lists_the_style_layer_id_of_a_video_layer(proj):
    """A video draws through `layer-<id>-video`, its own suffix."""
    authoring.add_layer(
        proj,
        project.video_layer(
            "Storm",
            ["https://example.org/storm.mp4"],
            [[0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]],
        ),
    )
    storm = authoring.find_layer(proj, "Storm")["id"]

    state = authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=[storm])

    assert state["rightLayers"] == [storm, f"layer-{storm}-video"]


def test_add_swipe_lists_the_style_layer_id_of_a_raster_mbtiles_layer(proj):
    """An mbtiles layer has no builder here; it reaches this API through a saved project."""
    authoring.add_layer(
        proj,
        {
            "id": "mb-1",
            "name": "Relief",
            "type": "mbtiles",
            "source": {"type": "raster", "url": "mbtiles://relief"},
            "metadata": {"tileType": "raster"},
        },
    )

    state = authoring.add_swipe(proj, left_layers=["__basemap__"], right_layers=["mb-1"])

    assert state["rightLayers"] == ["mb-1", "layer-mb-1-raster"]


def test_remove_layer_drops_a_derived_style_layer_id_of_any_shape(proj):
    """Removal mirrors expansion, so no derived id outlives its layer."""
    authoring.add_layer(
        proj,
        project.pmtiles_layer("Scan", "https://example.org/scan.pmtiles", tile_type="raster"),
    )
    authoring.add_layer(
        proj,
        project.video_layer(
            "Storm",
            ["https://example.org/storm.mp4"],
            [[0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]],
        ),
    )
    scan = authoring.find_layer(proj, "Scan")
    storm = authoring.find_layer(proj, "Storm")["id"]
    authoring.add_swipe(proj, left_layers=[scan["id"]], right_layers=[storm])
    swipe = proj["plugins"]["settings"][project.SWIPE_PLUGIN_ID]
    # Spell the sides out the way a project saved by the app carries them, so
    # this covers removal on its own rather than only in step with add_swipe.
    swipe["leftLayers"] = [scan["id"], f"{scan['metadata']['sourceId']}-raster"]
    swipe["rightLayers"] = [storm, f"layer-{storm}-video"]

    authoring.remove_layer(proj, "Scan")
    authoring.remove_layer(proj, "Storm")

    swipe = proj["plugins"]["settings"][project.SWIPE_PLUGIN_ID]
    assert swipe["leftLayers"] == []
    assert swipe["rightLayers"] == []


def test_add_swipe_rejects_a_bad_orientation(proj):
    with pytest.raises(ValueError, match="orientation must be one of"):
        authoring.add_swipe(proj, left_layers=[], right_layers=[], orientation="diagonal")
