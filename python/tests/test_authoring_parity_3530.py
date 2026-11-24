"""Python/MCP authoring parity: layer groups, ArcGIS, Zarr, WFS, video,
dashboards, and Print Layout (opengeos/GeoLibre#3530, section 4).

Builder shapes follow the app's own records (see each builder's docstring for
the TypeScript source it mirrors), so a project written here opens and renders
the same way as one saved by the app.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

import geolibre.geolibre as gmod
from geolibre import Map, authoring
from geolibre import project as _project

POINT_FC = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Knoxville", "pop": 195000},
            "geometry": {"type": "Point", "coordinates": [-83.92, 35.96]},
        }
    ],
}


def _project_with(*names: str) -> dict[str, Any]:
    project = _project.build_empty_project("Parity")
    for name in names:
        authoring.add_layer(project, _project.geojson_layer(name, POINT_FC))
    return project


def _layer_names(project: dict[str, Any]) -> list[str]:
    return [layer["name"] for layer in project["layers"]]


@pytest.mark.parametrize("service", ["map", "image", "feature"])
def test_arcgis_rejects_embedded_credentials(service):
    """Prevent service credentials from being persisted into projects."""
    with pytest.raises(ValueError, match="credentials"):
        _project.arcgis_layer(
            "Private", "https://user:secret@example.com/MapServer", service=service
        )


@pytest.mark.parametrize("kind", ["wfs", "zarr", "video"])
def test_other_authoring_builders_reject_url_userinfo(kind):
    """Reject embedded credentials that browser fetch cannot consume.

    Args:
        kind: The layer builder being checked.
    """
    url = "https://private-user:private-password@example.com/data"
    with pytest.raises(ValueError, match="credentials") as error:
        if kind == "wfs":
            _project.wfs_layer("WFS", url, "cities")
        elif kind == "zarr":
            _project.zarr_layer("Cube", url, "tas")
        else:
            _project.video_layer("Video", [url], [[0, 1], [1, 1], [1, 0], [0, 0]])
    assert "private-password" not in str(error.value)


def test_signed_sources_are_preserved_privately_and_redacted_when_sharing(tmp_path, monkeypatch):
    """Keep authenticated sources usable while Map saves redact by default.

    Args:
        tmp_path: The output directory.
        monkeypatch: The pytest patch fixture.
    """
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    token = "private-query-credential"
    project = _project.build_empty_project("Private sources")
    for layer in (
        _project.wfs_layer("WFS", f"https://example.com/wfs?token={token}", "cities"),
        _project.zarr_layer("Cube", f"https://example.com/a.zarr?token={token}", "tas"),
        _project.video_layer(
            "Video", [f"https://example.com/a.mp4?token={token}"], [[0, 1], [1, 1], [1, 0], [0, 0]]
        ),
    ):
        authoring.add_layer(project, layer)
    private = tmp_path / "private.geolibre.json"
    authoring.save_project(private, project)
    assert token in private.read_text()
    m = Map()
    m.load_project(project)
    public = tmp_path / "public.geolibre.json"
    m.save_project(str(public))
    assert token not in public.read_text()
    assert token not in json.dumps(m.to_project())
    assert token in json.dumps(m.to_project(keep_credentials=True))


@pytest.mark.parametrize("rule", ["[]", '"Hillshade"', "null", "42"])
def test_arcgis_rendering_rule_requires_an_object(rule):
    """Reject valid JSON that cannot describe an ArcGIS rendering rule."""
    with pytest.raises(ValueError, match="object"):
        _project.arcgis_layer(
            "Image", "https://example.com/ImageServer", service="image", rendering_rule=rule
        )


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_zarr_selector_rejects_nonfinite_values(value):
    """Keep Zarr selectors valid in strict JSON exports."""
    with pytest.raises(ValueError, match="selector"):
        _project.zarr_layer("Cube", "https://example.com/a.zarr", "tas", selector={"time": value})


def test_zarr_accepts_explicit_fill_opacity():
    """Allow caller style overrides of the default cube opacity."""
    layer = _project.zarr_layer("Cube", "https://example.com/a.zarr", "tas", fillOpacity=0.4)
    assert layer["style"]["fillOpacity"] == 0.4


@pytest.mark.parametrize(
    "widget_type,option", [("bar", "aggregation"), ("indicator", "indicatorAggregation")]
)
@pytest.mark.parametrize("value", [[], {}])
def test_widget_aggregation_rejects_unhashable_values(widget_type, option, value):
    """Return a validation error for malformed aggregation options."""
    with pytest.raises(ValueError, match="aggregation"):
        _project.dashboard_widget("layer", widget_type, **{option: value})


def test_print_layout_reserves_explicit_ids_and_copies_columns():
    """Generate unique legend ids and own mutable table-column settings."""
    columns = ["name"]
    layout = _project.print_layout_settings(
        custom_legend_entries=[{"label": "Generated"}, {"id": "cl-1", "label": "Explicit"}],
        table_columns=columns,
    )
    assert [entry["id"] for entry in layout["customLegendEntries"]] == ["cl-2", "cl-1"]
    columns.append("pop")
    assert layout["tableColumns"] == ["name"]
    with pytest.raises(ValueError, match="unique"):
        _project.print_layout_settings(custom_legend_entries=[{"id": "same"}, {"id": "same"}])


@pytest.mark.parametrize("destination", [None, "Other"])
def test_moving_middle_member_normalizes_its_previous_group(destination):
    """Keep the former group contiguous after a member moves or is ungrouped."""
    project = _project_with("A", "B", "C", "D")
    authoring.add_layer_group(project, "First", layers=["A", "B", "C"])
    authoring.add_layer_group(project, "Other", layers=["D"])
    authoring.set_layer_group(project, ["B"], destination)
    assert _layer_names(project) == ["A", "C", "B", "D"]


@pytest.mark.parametrize("operation", ["add", "move", "widget"])
@pytest.mark.parametrize("stale", [False, True])
def test_map_authoring_validates_layer_handles(monkeypatch, operation, stale):
    """Reject foreign and removed handles before mutating any project."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    owner = Map()
    layer_id = owner.add_geojson(POINT_FC, name="Cities")
    handle = owner.get_layer(layer_id)
    target = owner if stale else Map()
    if not stale:
        target.load_project(owner.project)
    if stale:
        owner.remove_layer(handle)
    before = target.to_project()
    with pytest.raises(ValueError):
        if operation == "add":
            target.add_layer_group("Invalid", layers=[handle])
        elif operation == "move":
            target.set_layer_group([handle], None)
        else:
            target.add_dashboard_widget(handle, "histogram", field="pop")
    assert target.to_project() == before


# -- builders -------------------------------------------------------------------


def test_wfs_layer_is_a_reference_the_app_fetches_on_open():
    layer = _project.wfs_layer("States", "https://example.com/wfs", "topp:states")
    assert layer["type"] == "geojson"
    assert "geojson" not in layer
    assert layer["source"]["service"] == "wfs"
    assert layer["source"]["typeName"] == "topp:states"
    assert layer["source"]["url"].startswith("https://example.com/wfs?")
    assert "typeNames=topp%3Astates" in layer["source"]["url"]
    assert layer["metadata"]["sourceKind"] == "wfs-getfeature"
    assert layer["sourcePath"] == layer["source"]["url"]

    inlined = _project.wfs_layer("States", "https://example.com/wfs", "topp:states", data=POINT_FC)
    assert inlined["geojson"] == POINT_FC
    assert inlined["metadata"]["featureCount"] == 1
    with pytest.raises(ValueError, match="type_name"):
        _project.wfs_layer("x", "https://example.com/wfs", " ")


def test_arcgis_map_service_draws_export_tiles():
    layer = _project.arcgis_layer(
        "Census",
        "https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer/",
        sublayers=[0, 2],
        bounds=[-125, 24, -66, 50],
    )
    assert layer["type"] == "raster"
    tile = layer["source"]["tiles"][0]
    assert tile.startswith(
        "https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer/export?"
    )
    assert "bbox={bbox-epsg-3857}" in tile
    assert "dpi=96" in tile
    assert "layers=show%3A0%2C2" in tile
    assert tile.endswith("&f=image")
    assert layer["source"]["bounds"] == [-125.0, 24.0, -66.0, 50.0]
    assert layer["metadata"]["sourceKind"] == "arcgis-map-service"
    assert layer["metadata"]["arcgisLayerType"] == "map-service"
    assert layer["metadata"]["arcgisSublayers"] == "0,2"
    assert layer["metadata"]["hasAccessToken"] is False


def test_arcgis_image_service_carries_its_rendering_rule():
    layer = _project.arcgis_layer(
        "Elevation",
        "https://elevation.arcgis.com/arcgis/rest/services/WorldElevation/Terrain/ImageServer",
        service="image",
        rendering_rule={"rasterFunction": "Hillshade"},
    )
    tile = layer["source"]["tiles"][0]
    assert "/ImageServer/exportImage?" in tile
    assert "dpi=" not in tile
    assert "renderingRule=%7B%22rasterFunction%22%3A%22Hillshade%22%7D" in tile
    assert layer["metadata"]["sourceKind"] == "arcgis-image-service"
    assert layer["metadata"]["arcgisRenderingRule"] == '{"rasterFunction":"Hillshade"}'


def test_arcgis_feature_layer_is_viewport_loaded():
    layer = _project.arcgis_layer(
        "Parcels",
        "https://services.arcgis.com/x/arcgis/rest/services/P/FeatureServer/0",
        service="feature",
        max_features=5000,
    )
    assert layer["type"] == "geojson"
    assert layer["geojson"] == {"type": "FeatureCollection", "features": []}
    assert layer["source"]["arcgisQueryUrl"].endswith("/FeatureServer/0/query")
    assert layer["source"]["maxFeatures"] == 5000
    assert layer["metadata"] == {"sourceKind": "arcgis-feature-query", "viewportLoading": True}
    assert "f=geojson" in layer["sourcePath"]


@pytest.mark.parametrize(
    ("kwargs", "match"),
    [
        ({"service": "vector"}, "service"),
        ({"service": "image", "sublayers": "0"}, "sublayers"),
        ({"service": "map", "rendering_rule": "{}"}, "rendering_rule"),
        ({"service": "map", "max_features": 10}, "max_features"),
        ({"service": "map", "sublayers": "zero"}, "sublayers"),
        *[
            ({"service": "map", "sublayers": values}, "sublayers")
            for values in ([1.9], [1.0], [True], ["1"], [-1], [float("nan")])
        ],
        ({"service": "image", "rendering_rule": "not json"}, "JSON"),
    ],
)
def test_arcgis_layer_rejects_misapplied_options(kwargs, match):
    with pytest.raises(ValueError, match=match):
        _project.arcgis_layer("x", "https://example.com/arcgis/rest/services/A/MapServer", **kwargs)


def test_arcgis_layer_refuses_a_token():
    with pytest.raises(ValueError, match="token"):
        _project.arcgis_layer("x", "https://example.com/A/MapServer?token=abc")


def test_google_storage_zarr_uses_a_restorable_https_endpoint():
    """Normalize Google Storage stores while preserving their access query."""
    layer = _project.zarr_layer("Cube", "gs://public-bucket/a.zarr?token=abc", "tas")
    assert layer["source"]["url"] == "https://storage.googleapis.com/public-bucket/a.zarr?token=abc"


def test_zarr_rejects_mapping_color_ranges_with_a_validation_error():
    """Reject a sized mapping without leaking an indexing KeyError."""
    with pytest.raises(ValueError, match="clim must be"):
        _project.zarr_layer("Cube", "https://example.com/a.zarr", "tas", clim={"min": 0, "max": 1})


@pytest.mark.parametrize("key", ["project", "layer_id", "widget_id", "widgetId"])
def test_python_dashboard_rejects_reserved_options(key, monkeypatch):
    """Match the MCP guard before modifying the project.

    Args:
        key: A reserved authoring option.
        monkeypatch: The pytest patch fixture.
    """
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    with pytest.raises(ValueError, match="options cannot"):
        Map().add_dashboard_widget("missing", "indicator", **{key: "reserved"})


def test_python_print_layout_rejects_a_project_override(monkeypatch):
    """Return an actionable error instead of duplicate Python arguments.

    Args:
        monkeypatch: The pytest patch fixture.
    """
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    with pytest.raises(ValueError, match="settings cannot override"):
        Map().set_print_layout(project={})


def test_zarr_layer_matches_the_restorable_record():
    layer = _project.zarr_layer(
        "Air temperature",
        "https://carbonplan-maps.s3.us-west-2.amazonaws.com/v2/demo/4d/tavg-prec-month",
        "climate",
        selector={"band": "tavg", "month": 1},
        clim=[-20, 30],
        colormap="viridis",
    )
    assert layer["type"] == "zarr"
    # isRestorableZarrLayer: type zarr, non-empty source.url and source.variable.
    assert layer["source"]["url"].startswith("https://")
    assert layer["source"]["variable"] == "climate"
    assert layer["source"]["selector"] == {"band": "tavg", "month": 1}
    assert layer["source"]["clim"] == [-20.0, 30.0]
    assert layer["metadata"]["sourceKind"] == "zarr-url"
    assert layer["metadata"]["paintMode"] == "plugin"
    assert layer["metadata"]["nativeLayerIds"] == [layer["id"]]
    assert layer["style"]["fillOpacity"] == 1


@pytest.mark.parametrize(
    ("url", "kwargs", "match"),
    [
        ("https://example.com/repo#icechunk=main", {}, "Icechunk"),
        ("local-zarr:abc", {}, "Icechunk"),
        ("ftp://example.com/x.zarr", {}, "url"),
        ("https://example.com/x.zarr", {"clim": [5, 1]}, "clim"),
        ("https://example.com/x.zarr", {"selector": {"time": [1]}}, "selector"),
        ("https://example.com/x.zarr", {"spatial_dimensions": {"z": "y"}}, "spatial"),
    ],
)
def test_zarr_layer_rejects_what_the_app_cannot_reopen(url, kwargs, match):
    with pytest.raises(ValueError, match=match):
        _project.zarr_layer("x", url, "v", **kwargs)


def test_video_layer_records_the_form_urls():
    layer = _project.video_layer(
        "Drone",
        ["https://example.com/a.mp4", "https://example.com/a.webm"],
        [[-122.51, 37.56], [-122.51, 37.56], [-122.51, 37.56], [-122.51, 37.56]],
    )
    assert layer["metadata"]["sourceUrl"] == "https://example.com/a.mp4"
    assert layer["metadata"]["fallbackSourceUrl"] == "https://example.com/a.webm"


# -- layer groups ---------------------------------------------------------------


def test_layer_groups_nest_collect_members_and_stay_contiguous():
    project = _project_with("A", "B", "C", "D")
    outer = authoring.add_layer_group(project, "Outer", layers=["A", "C"], opacity=0.5)
    assert outer["layerIds"] == [project["layers"][0]["id"], project["layers"][1]["id"]]
    # C moved next to A, the first member.
    assert _layer_names(project) == ["A", "C", "B", "D"]
    inner = authoring.add_layer_group(project, "Inner", parent="Outer", layers=["D"])
    assert project["layerGroups"][1]["parentId"] == outer["id"]
    assert inner["layerIds"] == [project["layers"][3]["id"]]
    assert project["layerGroups"][0] == {
        "id": outer["id"],
        "name": "Outer",
        "collapsed": False,
        "visible": True,
        "opacity": 0.5,
    }

    authoring.set_layer_group(project, ["B"], "Inner")
    assert _layer_names(project) == ["A", "C", "B", "D"]
    authoring.set_layer_group(project, ["B"], None)
    assert "groupId" not in project["layers"][2]


def test_remove_layer_group_moves_members_and_children_up():
    project = _project_with("A", "B")
    outer = authoring.add_layer_group(project, "Outer", layers=["A"])
    inner = authoring.add_layer_group(project, "Inner", parent=outer["id"], layers=["B"])
    authoring.add_layer_group(project, "Leaf", parent=inner["id"])
    remaining = authoring.remove_layer_group(project, "Inner")
    assert [group["name"] for group in remaining] == ["Outer", "Leaf"]
    assert project["layers"][1]["groupId"] == outer["id"]
    assert project["layerGroups"][1]["parentId"] == outer["id"]
    authoring.remove_layer_group(project, "Outer")
    authoring.remove_layer_group(project, "Leaf")
    assert "layerGroups" not in project
    assert all("groupId" not in layer for layer in project["layers"])


def test_layer_group_validation_leaves_the_project_unchanged():
    project = _project_with("A")
    with pytest.raises(ValueError, match="No layer matches"):
        authoring.add_layer_group(project, "G", layers=["missing"])
    assert "layerGroups" not in project
    with pytest.raises(ValueError, match="opacity"):
        authoring.add_layer_group(project, "G", opacity=2)
    with pytest.raises(ValueError, match="no layer group"):
        authoring.set_layer_group(project, ["A"], "nope")


# -- dashboards -----------------------------------------------------------------


def test_dashboard_widgets_validate_like_normalize_widgets():
    project = _project_with("Cities")
    widget = authoring.add_dashboard_widget(
        project, "Cities", "indicator", field="pop", indicator_aggregation="sum", suffix=" people"
    )
    assert widget["layerId"] == project["layers"][0]["id"]
    assert widget["indicatorAggregation"] == "sum"
    assert widget["suffix"] == " people"
    bar = authoring.add_dashboard_widget(
        project, "Cities", "bar", title="By name", category="name", aggregation="count"
    )
    assert project["widgets"] == [widget, bar]
    assert authoring.set_dashboard_columns(project, 3)["columns"] == 3

    for kwargs, match in (
        ({"widget_type": "map"}, "widget_type"),
        ({"widget_type": "pie", "aggregation": "mean"}, "aggregation"),
        ({"widget_type": "bar", "multiple": True}, "selector"),
        ({"widget_type": "histogram", "bins": 0}, "bins"),
        ({"widget_type": "bar", "color": "red"}, "color"),
        ({"widget_type": "bar", "colour": "#fff"}, "unknown"),
    ):
        with pytest.raises(ValueError, match=match):
            authoring.add_dashboard_widget(project, "Cities", **kwargs)
    with pytest.raises(ValueError, match="columns"):
        authoring.set_dashboard_columns(project, 7)

    authoring.remove_dashboard_widget(project, "By name")
    assert project["widgets"] == [widget]


def test_removing_a_layer_drops_its_widgets_and_print_blocks():
    project = _project_with("Cities", "Other")
    authoring.add_dashboard_widget(project, "Cities", "histogram", field="pop")
    authoring.set_print_layout(project, show_data_table=True, table_layer_id="Cities")
    authoring.remove_layer(project, "Cities")
    assert "widgets" not in project
    assert project["printLayout"]["tableLayerId"] == ""
    assert project["printLayout"]["showDataTable"] is False


# -- print layout ---------------------------------------------------------------


def test_print_layout_merges_validated_settings_and_resolves_layers():
    project = _project_with("Parcels")
    layout = authoring.set_print_layout(
        project, title="Flood extent", paper_size="a3", orientation="portrait"
    )
    assert layout == {"title": "Flood extent", "paperSize": "a3", "orientation": "portrait"}
    layout = authoring.set_print_layout(
        project, atlasEnabled=True, atlas_layer_id="Parcels", extent_bbox=[-84, 35, -83, 36]
    )
    assert layout["title"] == "Flood extent"
    assert layout["atlasLayerId"] == project["layers"][0]["id"]
    assert layout["extentBbox"] == [-84.0, 35.0, -83.0, 36.0]
    assert authoring.set_print_layout(project, reset=True, show_legend=False) == {
        "showLegend": False
    }


@pytest.mark.parametrize(
    ("settings", "match"),
    [
        ({"paper_size": "a5"}, "paper_size"),
        ({"export_dpi": 96}, "export_dpi"),
        ({"show_legend": "yes"}, "show_legend"),
        ({"table_max_rows": 0}, "table_max_rows"),
        ({"extent_bbox": [1, 1, 0, 2]}, "extent_bbox"),
        ({"page_background": "white"}, "page_background"),
        ({"page_size": "a4"}, "unknown"),
    ],
)
def test_print_layout_rejects_values_the_app_would_discard(settings, match):
    with pytest.raises(ValueError, match=match):
        authoring.set_print_layout(_project_with("A"), **settings)


def test_print_layout_settings_mirror_the_app_defaults():
    """Every default key is one the app's PrintLayoutConfig has, and vice versa."""
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[2] / "packages" / "core" / "src" / "print-layout-config.ts"
    )
    if not source.is_file():
        pytest.skip("monorepo sources not available")
    text = source.read_text(encoding="utf-8")
    body = text.split("export const DEFAULT_PRINT_LAYOUT: PrintLayoutConfig = {", 1)[1]
    body = body.split("\n};", 1)[0]
    import re

    keys = set(re.findall(r"^  ([A-Za-z]+):", body, re.M))
    assert keys == set(_project.PRINT_LAYOUT_DEFAULTS)


# -- Map delegates to the same authoring ------------------------------------------


def test_map_methods_write_the_same_project_parts(monkeypatch):
    # Stub the bundled-app server so the test needs no frontend build.
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    m = Map()
    a = m.add_geojson(POINT_FC, name="Cities")
    group = m.add_layer_group("Group", layers=[m.get_layer(a)])
    assert group["layerIds"] == [a]
    widget = m.add_dashboard_widget(m.get_layer(a), "histogram", field="pop")
    m.set_dashboard_columns(4)
    m.set_print_layout(title="Map")
    arc = m.add_arcgis_layer(
        "https://example.com/arcgis/rest/services/A/MapServer", name="Arc", sublayers="1"
    )
    zarr = m.add_zarr("https://example.com/cube.zarr", "tas", selector={"time": 0})
    project = m.project
    assert project["layers"][0]["groupId"] == group["id"]
    assert project["widgets"] == [widget]
    assert project["dashboardColumns"] == 4
    assert project["printLayout"] == {"title": "Map"}
    assert {layer["id"]: layer["type"] for layer in project["layers"]}[arc] == "raster"
    assert {layer["id"]: layer["type"] for layer in project["layers"]}[zarr] == "zarr"
    m.remove_layer_group("Group")
    assert "layerGroups" not in m.project


def test_map_wfs_fetches_the_normalized_persisted_url(monkeypatch):
    """Use exactly the same GetFeature request for fetching and future refresh."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    fetched = []
    monkeypatch.setattr(
        _project, "load_featurecollection", lambda url: fetched.append(url) or POINT_FC
    )
    m = Map()
    layer_id = m.add_wfs(" https://example.com/wfs ", " topp:states ")
    layer = next(layer for layer in m.project["layers"] if layer["id"] == layer_id)
    assert fetched == [layer["sourcePath"]]
    assert "typeNames=topp%3Astates" in fetched[0]
    assert layer["metadata"]["featureCount"] == 1


# -- MCP tools --------------------------------------------------------------------


@pytest.fixture
def server(tmp_path):
    pytest.importorskip("mcp", reason="the mcp SDK is an optional extra")
    from geolibre.mcp.server import build_server
    from geolibre.mcp.workspace import Workspace

    return build_server(Workspace([tmp_path]))


def _call(server: Any, tool_name: str, **kwargs: Any) -> Any:
    result = asyncio.run(server.call_tool(tool_name, kwargs))
    if hasattr(result, "structured_content") and result.structured_content is not None:
        return result.structured_content
    return json.loads(result.content[0].text)


@pytest.mark.parametrize("key", ["project", "reset"])
def test_print_layout_tool_rejects_reserved_settings(server, tmp_path, key):
    """Return an actionable validation error before opening the project file."""
    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError, match="settings cannot override"):
        _call(
            server,
            "set_print_layout",
            path=str(tmp_path / "missing.geolibre.json"),
            settings={key: True},
        )


@pytest.mark.parametrize("key", ["project", "layer", "layer_id", "widget_type"])
def test_dashboard_tool_rejects_reserved_options(server, tmp_path, key):
    """Reject keyword collisions instead of exposing a Python argument error."""
    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError, match="options cannot override"):
        _call(
            server,
            "add_dashboard_widget",
            path=str(tmp_path / "missing.geolibre.json"),
            layer="Cities",
            widget_type="indicator",
            options={key: "reserved"},
        )


def test_mcp_tools_cover_the_parity_surface(server, tmp_path):
    path = str(tmp_path / "parity.geolibre.json")
    _call(server, "create_project", path=path, name="Parity")
    cities = _call(server, "add_geojson_layer", path=path, name="Cities", data=json.dumps(POINT_FC))
    _call(
        server,
        "add_wfs_layer",
        path=path,
        name="States",
        endpoint="https://example.com/wfs",
        type_name="topp:states",
    )
    _call(
        server,
        "add_arcgis_layer",
        path=path,
        name="Imagery",
        url="https://example.com/arcgis/rest/services/I/ImageServer",
        service="image",
        rendering_rule={"rasterFunction": "Hillshade"},
    )
    _call(
        server,
        "add_zarr_layer",
        path=path,
        name="Temp",
        url="s3://bucket/cube.zarr",
        variable="tas",
        selector={"time": 3},
    )
    _call(
        server,
        "add_video_layer",
        path=path,
        name="Video",
        urls=["https://example.com/v.mp4"],
        coordinates=[[0, 1], [1, 1], [1, 0], [0, 0]],
    )
    group = _call(server, "add_layer_group", path=path, name="Vectors", layers=["Cities", "States"])
    assert len(group["layerGroup"]["layerIds"]) == 2
    _call(server, "set_layer_group", path=path, layers=["States"])
    widget = _call(
        server,
        "add_dashboard_widget",
        path=path,
        layer="Cities",
        widget_type="bar",
        title="Count",
        options={"category": "name"},
    )
    assert widget["widget"]["title"] == "Count"
    _call(server, "set_dashboard_columns", path=path, columns=3)
    layout = _call(
        server,
        "set_print_layout",
        path=path,
        settings={"title": "Parity", "chart_layer_id": "Cities", "show_data_chart": True},
    )
    assert layout["printLayout"]["chartLayerId"] == cities["layerId"]

    project = json.loads((tmp_path / "parity.geolibre.json").read_text())
    assert [layer["type"] for layer in project["layers"]] == [
        "geojson",
        "geojson",
        "raster",
        "zarr",
        "video",
    ]
    assert project["layers"][0]["groupId"] == group["layerGroup"]["id"]
    assert "groupId" not in project["layers"][1]
    assert project["widgets"][0]["category"] == "name"
    assert project["dashboardColumns"] == 3
    assert project["printLayout"]["title"] == "Parity"

    _call(server, "remove_dashboard_widget", path=path, widget="Count")
    _call(server, "remove_layer_group", path=path, group="Vectors")
    project = json.loads((tmp_path / "parity.geolibre.json").read_text())
    assert "widgets" not in project
    assert "layerGroups" not in project


@pytest.mark.parametrize("kind", ["arcgis", "zarr"])
@pytest.mark.parametrize("scheme", ["ftp", "file"])
def test_invalid_scheme_errors_do_not_echo_embedded_credentials(kind, scheme):
    """Scheme validation cannot expose credentials before userinfo validation.

    Args:
        kind: The layer builder to exercise.
        scheme: An unsupported URL scheme carrying userinfo.
    """
    url = f"{scheme}://private-user:private-password@example.com/data?token=private-token"
    with pytest.raises(ValueError) as error:
        if kind == "arcgis":
            _project.arcgis_layer("Private", url)
        else:
            _project.zarr_layer("Private", url, variable="temperature")
    assert "private-password" not in str(error.value)
    assert "private-token" not in str(error.value)
