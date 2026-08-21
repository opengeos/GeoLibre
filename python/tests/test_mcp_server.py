"""Tests for the MCP server's tool surface and its filesystem confinement.

The workspace tests need only the standard library. The tool tests need the
optional ``mcp`` SDK and skip without it, so the default CI install (which does
not pull the SDK) stays green rather than silently losing coverage it never had.
"""

from __future__ import annotations

import asyncio
import builtins
import json
import os
import sys

import pytest

import geolibre.mcp as mcp_package
from geolibre.mcp.workspace import Workspace, WorkspaceError

mcp = pytest.importorskip("mcp", reason="the mcp SDK is an optional extra")

from mcp.server.mcpserver.exceptions import ToolError  # noqa: E402 - after the skip guard

from geolibre.mcp.server import build_server  # noqa: E402 - after the skip guard

POINT_FC = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "A", "pop": 10},
            "geometry": {"type": "Point", "coordinates": [-84, 36]},
        },
        {
            "type": "Feature",
            "properties": {"name": "B", "pop": 90},
            "geometry": {"type": "Point", "coordinates": [-83, 35]},
        },
    ],
}


@pytest.fixture
def server(tmp_path):
    """A server confined to a fresh temporary workspace."""
    return build_server(Workspace([tmp_path]))


# `server` and the tool name are positional-only so that a tool's own `name`
# argument (create_project, add_geojson_layer, ...) lands in **arguments instead
# of colliding with the helper's parameter.
def call(server, tool, /, **arguments):
    """Invoke a tool and return its structured result, failing on a tool error."""
    result = asyncio.run(server.call_tool(tool, arguments))
    if result.is_error:
        raise AssertionError(f"{tool} failed: {result.content[0].text}")
    return result.structured_content


def call_error(server, tool, /, **arguments):
    """Invoke a tool expected to fail and return its error text.

    A tool that raises surfaces as a ``ToolError`` from this in-process entry
    point; over the wire the same failure reaches the client as an ``isError``
    result.
    """
    with pytest.raises(ToolError) as excinfo:
        asyncio.run(server.call_tool(tool, arguments))
    return str(excinfo.value)


@pytest.fixture
def project_path(server):
    """A created project, returned as the path string tools take."""
    call(server, "create_project", path="map.geolibre.json", name="Demo")
    return "map.geolibre.json"


# -- the console-script entry point -------------------------------------------


def _import_failing_on_the_sdk(missing: str):
    """An __import__ that fails any `mcp` import, blaming *missing*."""
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name.split(".")[0] == "mcp":
            raise ModuleNotFoundError(f"No module named {missing!r}", name=missing)
        return real_import(name, *args, **kwargs)

    return fake_import


def test_entry_point_reports_a_missing_sdk_without_a_traceback(monkeypatch, capsys):
    """`pip install geolibre` then `geolibre-mcp` must say what to install."""
    monkeypatch.delitem(sys.modules, "geolibre.mcp.server", raising=False)
    monkeypatch.setattr(builtins, "__import__", _import_failing_on_the_sdk("mcp"))
    assert mcp_package.main([]) == 1
    assert 'pip install "geolibre[mcp]"' in capsys.readouterr().err


def test_entry_point_propagates_an_unrelated_import_error(monkeypatch):
    """A dependency missing under an installed SDK is a broken env, not a missing extra."""
    monkeypatch.delitem(sys.modules, "geolibre.mcp.server", raising=False)
    monkeypatch.setattr(builtins, "__import__", _import_failing_on_the_sdk("sse_starlette"))
    with pytest.raises(ModuleNotFoundError, match="sse_starlette"):
        mcp_package.main([])


# -- workspace confinement ----------------------------------------------------


def test_workspace_rejects_a_path_outside_its_roots(tmp_path):
    workspace = Workspace([tmp_path])
    with pytest.raises(WorkspaceError, match="outside this server's workspace"):
        workspace.resolve("/etc/passwd")


def test_workspace_rejects_traversal_out_of_a_root(tmp_path):
    workspace = Workspace([tmp_path])
    with pytest.raises(WorkspaceError, match="outside this server's workspace"):
        workspace.resolve("../../etc/passwd")


def test_workspace_rejects_a_symlink_escape(tmp_path):
    """A link planted inside a root resolves to its target, which is not inside."""
    outside = tmp_path.parent / "outside-root"
    outside.mkdir(exist_ok=True)
    (outside / "secret.json").write_text("{}", encoding="utf-8")
    root = tmp_path / "root"
    root.mkdir()
    (root / "link.json").symlink_to(outside / "secret.json")
    workspace = Workspace([root])
    with pytest.raises(WorkspaceError, match="outside this server's workspace"):
        workspace.resolve("link.json")


def test_workspace_resolves_relative_paths_against_the_first_root(tmp_path):
    workspace = Workspace([tmp_path])
    assert workspace.resolve("maps/a.json") == (tmp_path / "maps" / "a.json").resolve()


def test_workspace_rejects_an_unsupported_output_extension(tmp_path):
    workspace = Workspace([tmp_path])
    with pytest.raises(WorkspaceError, match="Refusing to write"):
        workspace.resolve_output("notes.txt", suffixes=(".json",))


def test_workspace_guards_an_existing_output(tmp_path):
    (tmp_path / "a.json").write_text("{}", encoding="utf-8")
    workspace = Workspace([tmp_path])
    with pytest.raises(WorkspaceError, match="already exists"):
        workspace.resolve_output("a.json", suffixes=(".json",))
    assert workspace.resolve_output("a.json", suffixes=(".json",), overwrite=True)


def test_workspace_rejects_a_bare_dotfile_output(tmp_path):
    """`.json` is a suffix match but has no stem, so it is not a project name."""
    workspace = Workspace([tmp_path])
    with pytest.raises(WorkspaceError, match="Refusing to write"):
        workspace.resolve_output(".json", suffixes=(".json",))


def test_workspace_rejects_a_root_that_is_not_a_directory(tmp_path):
    missing = tmp_path / "nope"
    with pytest.raises(WorkspaceError, match="not a directory"):
        Workspace([missing])


def test_workspace_rejects_an_environment_holding_only_separators(monkeypatch):
    """A separators-only value filters down to no roots, which cannot serve."""
    monkeypatch.setenv("GEOLIBRE_MCP_ROOTS", os.pathsep)
    with pytest.raises(WorkspaceError, match="No workspace roots configured"):
        Workspace()


# -- tool surface -------------------------------------------------------------


def test_every_tool_is_registered_with_a_description(server):
    tools = asyncio.run(server.list_tools())
    names = {tool.name for tool in tools}
    assert {"create_project", "add_geojson_layer", "classify_layer", "export_html"} <= names
    # An undescribed tool is invisible to a model choosing between them.
    assert all(tool.description for tool in tools)


def test_create_project_writes_a_file(server, tmp_path):
    result = call(
        server,
        "create_project",
        path="map.geolibre.json",
        name="Knoxville",
        center=[-83.92, 35.96],
        zoom=10,
        basemap="dark",
    )
    written = json.loads((tmp_path / "map.geolibre.json").read_text(encoding="utf-8"))
    assert result["name"] == "Knoxville"
    assert written["mapView"]["center"] == [-83.92, 35.96]
    assert written["basemapStyleUrl"].endswith("/dark")


def test_create_project_refuses_to_clobber_without_overwrite(server, project_path):
    assert "already exists" in call_error(server, "create_project", path=project_path)
    assert call(server, "create_project", path=project_path, name="Replaced", overwrite=True)


def test_create_project_refuses_a_path_outside_the_workspace(server):
    assert "outside this server's workspace" in call_error(
        server, "create_project", path="/tmp/escaped.geolibre.json"
    )


def test_create_project_refuses_to_overwrite_a_json_file_that_is_not_a_project(server, tmp_path):
    """`overwrite` replaces the project there, not whatever happens to be there."""
    config = tmp_path / "config.json"
    original = {"name": "app", "settings": {"theme": "dark"}}
    config.write_text(json.dumps(original), encoding="utf-8")
    assert "does not look like a GeoLibre project" in call_error(
        server, "create_project", path="config.json", overwrite=True
    )
    assert json.loads(config.read_text(encoding="utf-8")) == original


def test_create_project_refuses_to_overwrite_an_unreadable_file(server, tmp_path):
    """A file that will not parse is the case to refuse hardest, not to wave through."""
    for name, content in (("broken.json", "{not json"), ("list.json", "[1, 2, 3]")):
        (tmp_path / name).write_text(content, encoding="utf-8")
        assert "could not be read as a GeoLibre project" in call_error(
            server, "create_project", path=name, overwrite=True
        )
        assert (tmp_path / name).read_text(encoding="utf-8") == content


def test_create_project_clamps_the_initial_zoom(server, tmp_path):
    """The starting camera is clamped the same way a later set_view would be."""
    call(server, "create_project", path="map.geolibre.json", zoom=100)
    written = json.loads((tmp_path / "map.geolibre.json").read_text(encoding="utf-8"))
    assert written["mapView"]["zoom"] == 24


def test_editing_refuses_a_json_file_that_is_not_a_project(server, tmp_path):
    """An unrelated JSON file inside a root is not a project to be rewritten."""
    package = tmp_path / "package.json"
    package.write_text(json.dumps({"name": "app", "version": "1.0.0"}), encoding="utf-8")
    error = call_error(
        server, "add_geojson_layer", path="package.json", name="X", data=json.dumps(POINT_FC)
    )
    assert "does not look like a GeoLibre project" in error
    assert json.loads(package.read_text(encoding="utf-8")) == {"name": "app", "version": "1.0.0"}


def test_editing_refuses_a_config_that_merely_has_a_layers_array(server, tmp_path):
    """A top-level `layers` array is not exclusive to this format."""
    style = tmp_path / "style.json"
    original = {"name": "Some style", "layers": [{"id": "background", "type": "background"}]}
    style.write_text(json.dumps(original), encoding="utf-8")
    assert "does not look like a GeoLibre project" in call_error(
        server, "set_view", path="style.json", zoom=4
    )
    assert json.loads(style.read_text(encoding="utf-8")) == original


def test_editing_refuses_a_destination_with_an_unsupported_extension(server, tmp_path):
    (tmp_path / "notes.txt").write_text("{}", encoding="utf-8")
    assert "Refusing to write" in call_error(server, "set_view", path="notes.txt", zoom=4)


def test_add_geojson_layer_checks_the_destination_before_loading_data(server, tmp_path):
    """A bad destination fails without the fetch or read that would follow."""
    (tmp_path / "notes.txt").write_text("{}", encoding="utf-8")
    assert "Refusing to write" in call_error(
        server,
        "add_geojson_layer",
        path="notes.txt",
        name="Cities",
        # A URL that would fail loudly if it were ever reached.
        data="https://nonexistent.invalid/cities.geojson",
    )


def test_add_geojson_layer_inlines_literal_geojson(server, project_path):
    result = call(
        server,
        "add_geojson_layer",
        path=project_path,
        name="Cities",
        data=json.dumps(POINT_FC),
        style={"fillColor": "#ff0000"},
    )
    assert result["layerCount"] == 1
    described = call(server, "describe_project", path=project_path)
    assert described["layers"][0]["featureCount"] == 2


def test_add_geojson_layer_reports_a_colliding_style_key(server, project_path):
    """A model sees only "style: object", so a guessed builder keyword is likely."""
    error = call_error(
        server,
        "add_geojson_layer",
        path=project_path,
        name="Cities",
        data=json.dumps(POINT_FC),
        style={"source_url": "https://example.com/cities.geojson"},
    )
    assert "style keys ['source_url'] name parameters of this layer type" in error


def test_add_geojson_layer_reports_a_style_key_colliding_with_a_positional(server, project_path):
    """A positional parameter is in the signature too, so it is caught up front."""
    error = call_error(
        server,
        "add_geojson_layer",
        path=project_path,
        name="Cities",
        data=json.dumps(POINT_FC),
        style={"name": "Other"},
    )
    assert "style keys ['name'] name parameters of this layer type" in error


def test_style_cannot_reach_a_builder_parameter_the_tool_does_not_expose(server, project_path):
    """`style` is paint-only; a behavioral parameter must not bind through it."""
    error = call_error(
        server,
        "add_vector_layer",
        path=project_path,
        name="Roads",
        url="https://example.com/roads.fgb",
        # vector_layer takes `picker`, but add_vector_layer does not forward it.
        style={"picker": False},
    )
    assert "style keys ['picker'] name parameters of this layer type" in error


def test_add_raster_layer_reports_a_colliding_style_key(server, project_path):
    """The same guard covers every builder the tools splat a style into."""
    error = call_error(
        server,
        "add_raster_layer",
        path=project_path,
        name="DEM",
        url="https://example.com/dem.tif",
        style={"colormap": "viridis"},
    )
    assert "style keys ['colormap'] name parameters of this layer type" in error


def test_add_geojson_layer_reads_a_file_inside_the_workspace(server, project_path, tmp_path):
    (tmp_path / "cities.geojson").write_text(json.dumps(POINT_FC), encoding="utf-8")
    result = call(
        server, "add_geojson_layer", path=project_path, name="Cities", data="cities.geojson"
    )
    assert result["layerCount"] == 1


def test_add_geojson_layer_refuses_a_file_outside_the_workspace(server, project_path):
    assert "outside this server's workspace" in call_error(
        server, "add_geojson_layer", path=project_path, name="Escape", data="/etc/hosts"
    )


def test_add_raster_layer_records_its_source(server, project_path):
    call(
        server,
        "add_raster_layer",
        path=project_path,
        name="DEM",
        url="https://example.com/dem.tif",
        bands=[1],
        colormap="terrain",
        rescale=[[0, 3000]],
    )
    described = call(server, "describe_project", path=project_path)
    assert described["layers"][0]["name"] == "DEM"


@pytest.mark.parametrize(
    ("tool", "arguments", "expected_type"),
    [
        # render_mode picks the layer type: "geojson" loads into a GeoJSON
        # source, "tiles" tiles it in the browser.
        (
            "add_vector_layer",
            {"url": "https://example.com/data.fgb", "data_format": "flatgeobuf"},
            "geojson",
        ),
        (
            "add_vector_layer",
            {"url": "https://example.com/data.fgb", "render_mode": "tiles"},
            "vector-tiles",
        ),
        ("add_tile_layer", {"url": "https://example.com/{z}/{x}/{y}.png"}, "xyz"),
        ("add_3d_tiles_layer", {"url": "https://example.com/tileset.json"}, "3d-tiles"),
        (
            "add_tiles_layer",
            {"url": "https://example.com/a.pmtiles", "kind": "pmtiles"},
            "pmtiles",
        ),
        (
            "add_tiles_layer",
            {"url": "https://example.com/{z}/{x}/{y}.pbf", "kind": "vector-tiles"},
            "vector-tiles",
        ),
        (
            "add_ogc_layer",
            {"service": "wmts", "endpoint": "https://example.com/wmts/{z}/{x}/{y}.png"},
            "wmts",
        ),
        (
            "add_ogc_layer",
            {"service": "wms", "endpoint": "https://example.com/wms", "layers": "topo"},
            "wms",
        ),
    ],
)
def test_each_layer_tool_adds_a_layer_of_its_type(
    server, project_path, tool, arguments, expected_type
):
    """Every add_* tool's happy path, since each plumbs a different builder."""
    result = call(server, tool, path=project_path, name="Added", **arguments)
    assert result["layerCount"] == 1
    described = call(server, "describe_project", path=project_path)
    assert described["layers"][0]["name"] == "Added"
    assert described["layers"][0]["type"] == expected_type


def test_add_vector_layer_rejects_an_undocumented_render_mode(server, project_path):
    """The tool's docstring names the accepted values; they must be the real ones."""
    assert "render_mode" in call_error(
        server,
        "add_vector_layer",
        path=project_path,
        name="Bad",
        url="https://example.com/data.fgb",
        render_mode="vector-tiles",
    )


def test_style_layer_merges_into_the_existing_style(server, project_path):
    call(server, "add_geojson_layer", path=project_path, name="Cities", data=json.dumps(POINT_FC))
    call(server, "style_layer", path=project_path, layer="Cities", style={"fillColor": "#ff0000"})
    result = call(
        server, "style_layer", path=project_path, layer="Cities", style={"strokeWidth": 4}
    )
    # The second call must not drop the first call's key.
    assert result["style"]["fillColor"] == "#ff0000"
    assert result["style"]["strokeWidth"] == 4


def test_remove_layer_drops_it(server, project_path):
    call(server, "add_geojson_layer", path=project_path, name="Cities", data=json.dumps(POINT_FC))
    result = call(server, "remove_layer", path=project_path, layer="Cities")
    assert result["layerCount"] == 0
    assert call(server, "describe_project", path=project_path)["layers"] == []


def test_set_basemap_resolves_a_name(server, project_path):
    result = call(server, "set_basemap", path=project_path, basemap="dark")
    assert result["basemapStyleUrl"].endswith("/dark")


def test_set_basemap_rejects_an_unknown_name(server, project_path):
    assert call_error(server, "set_basemap", path=project_path, basemap="not-a-basemap")


def test_add_legend_from_a_preset(server, project_path):
    result = call(server, "add_legend", path=project_path, builtin="nlcd", position="top-right")
    assert result["legend"]["title"] == "NLCD Land Cover"
    assert result["legend"]["legendPosition"] == "top-right"
    assert "legend" in call(server, "describe_project", path=project_path)["mapControls"]


def test_add_legend_from_paired_labels_and_colors(server, project_path):
    result = call(
        server,
        "add_legend",
        path=project_path,
        title="Cover",
        labels=["Water", "Land"],
        colors=["#0000ff", "#00ff00"],
        shape="circle",
    )
    assert [item["label"] for item in result["legend"]["items"]] == ["Water", "Land"]
    assert result["legend"]["items"][0]["shape"] == "circle"


def test_add_legend_rejects_mismatched_labels_and_colors(server, project_path):
    assert "same length" in call_error(
        server, "add_legend", path=project_path, labels=["a", "b"], colors=["#111"]
    )


def test_add_colorbar_writes_its_range(server, project_path):
    result = call(
        server,
        "add_colorbar",
        path=project_path,
        colormap="terrain",
        vmin=0,
        vmax=3000,
        label="Elevation",
        units="m",
    )
    assert result["colorbar"]["vmin"] == 0
    assert result["colorbar"]["vmax"] == 3000
    assert "colorbar" in call(server, "describe_project", path=project_path)["mapControls"]


def test_add_colorbar_rejects_an_inverted_range(server, project_path):
    assert "must be less than" in call_error(
        server, "add_colorbar", path=project_path, vmin=100, vmax=1
    )


def test_a_legend_and_a_colorbar_coexist(server, project_path):
    """Both ride one settings blob, so adding the second must keep the first."""
    call(server, "add_legend", path=project_path, legend_dict={"A": "#111"})
    call(server, "add_colorbar", path=project_path, vmin=0, vmax=10)
    controls = call(server, "describe_project", path=project_path)["mapControls"]
    assert sorted(controls) == ["colorbar", "legend"]


def test_add_ogc_layer_requires_layers_for_wms(server, project_path):
    assert "'layers' is required" in call_error(
        server,
        "add_ogc_layer",
        path=project_path,
        name="WMS",
        service="wms",
        endpoint="https://example.com/wms",
    )


def test_add_ogc_layer_rejects_an_unknown_service(server, project_path):
    assert "wms" in call_error(
        server,
        "add_ogc_layer",
        path=project_path,
        name="Weird",
        service="wfs",
        endpoint="https://example.com",
    )


def test_add_tiles_layer_rejects_an_unknown_kind(server, project_path):
    assert "pmtiles" in call_error(
        server,
        "add_tiles_layer",
        path=project_path,
        name="Tiles",
        url="https://example.com/t.pmtiles",
        kind="mbtiles",
    )


def test_layers_can_be_referenced_by_name(server, project_path):
    call(server, "add_geojson_layer", path=project_path, name="Cities", data=json.dumps(POINT_FC))
    updated = call(server, "update_layer", path=project_path, layer="Cities", opacity=0.5)
    assert updated["layer"]["opacity"] == 0.5


def test_classify_layer_writes_graduated_stops(server, project_path):
    call(server, "add_geojson_layer", path=project_path, name="Cities", data=json.dumps(POINT_FC))
    result = call(
        server, "classify_layer", path=project_path, layer="Cities", column="pop", class_count=3
    )
    assert result["symbology"]["vectorStyleMode"] == "graduated"
    assert len(result["symbology"]["vectorStyleStops"]) == 3


def test_list_layer_properties_reports_columns(server, project_path):
    call(server, "add_geojson_layer", path=project_path, name="Cities", data=json.dumps(POINT_FC))
    result = call(server, "list_layer_properties", path=project_path, layer="Cities")
    assert result["properties"]["pop"] == [10, 90]


def test_a_failing_tool_leaves_the_project_untouched(server, project_path, tmp_path):
    """The write happens only after the mutation returns, so a failure is a no-op."""
    before = (tmp_path / "map.geolibre.json").read_text(encoding="utf-8")
    assert call_error(server, "remove_layer", path=project_path, layer="Nonexistent")
    assert (tmp_path / "map.geolibre.json").read_text(encoding="utf-8") == before


def test_set_view_fits_a_bounding_box(server, project_path):
    result = call(server, "set_view", path=project_path, bbox=[-84.0, 35.9, -83.8, 36.0])
    assert result["mapView"]["center"][0] == pytest.approx(-83.9)
    assert result["mapView"]["zoom"] > 8


def test_set_view_lets_an_explicit_zoom_win_over_a_bbox(server, project_path):
    result = call(server, "set_view", path=project_path, bbox=[-84, 35.9, -83.8, 36], zoom=3)
    assert result["mapView"]["zoom"] == 3


def test_add_swipe_resolves_names_to_ids(server, project_path):
    added = call(
        server, "add_geojson_layer", path=project_path, name="Cities", data=json.dumps(POINT_FC)
    )
    result = call(
        server,
        "add_swipe",
        path=project_path,
        left_layers=["__basemap__"],
        right_layers=["Cities"],
    )
    assert result["swipe"]["rightLayers"] == [added["layerId"]]


def test_list_catalog_reports_the_workspace(server, tmp_path):
    catalog = call(server, "list_catalog")
    assert "liberty" in catalog["basemaps"]
    assert "viridis" in catalog["colorRamps"]
    assert catalog["workspaceRoots"] == [str(tmp_path.resolve())]


def test_export_html_embeds_the_project(server, project_path, tmp_path):
    call(server, "add_geojson_layer", path=project_path, name="Cities", data=json.dumps(POINT_FC))
    result = call(server, "export_html", path=project_path, out_path="map.html", title="Demo")
    html = (tmp_path / "map.html").read_text(encoding="utf-8")
    assert result["bytes"] == len(html.encode("utf-8"))
    assert "<title>Demo</title>" in html
    assert "geolibre:load-project" in html
    # The project rides in a JSON script block, so its layer is in the page.
    assert "Cities" in html


def test_export_html_keeps_the_composed_map_controls(server, project_path, tmp_path):
    """The documented flow is compose-then-export; the export must carry both."""
    call(server, "add_geojson_layer", path=project_path, name="Cities", data=json.dumps(POINT_FC))
    call(server, "add_legend", path=project_path, legend_dict={"A": "#112233"})
    call(server, "add_colorbar", path=project_path, vmin=0, vmax=100, colormap="viridis")
    call(server, "export_html", path=project_path, out_path="map.html")
    html = (tmp_path / "map.html").read_text(encoding="utf-8")
    assert "#112233" in html
    assert "colorbar" in html


def test_add_geojson_layer_caps_literal_text(server, project_path):
    """The documented 50 MB cap covers literal text, not just URLs and files."""
    huge = '{"type": "FeatureCollection", "features": [' + " " * (50 * 1024 * 1024) + "]}"
    assert "exceeds the 50 MB size limit" in call_error(
        server, "add_geojson_layer", path=project_path, name="Huge", data=huge
    )


def test_export_html_refuses_a_non_html_destination(server, project_path):
    assert "Refusing to write" in call_error(
        server, "export_html", path=project_path, out_path="map.json"
    )
