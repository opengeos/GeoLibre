"""Regression tests for Section 3a Python SDK and MCP bug fixes."""

from __future__ import annotations

import inspect
import json
import sys
import types
from unittest.mock import MagicMock

import pytest

from geolibre import Map, authoring
from geolibre._server import _QuietHandler
from geolibre.geolibre import render_project_html
from geolibre.mcp import live as mcp_live
from geolibre.mcp.server import build_server


def _empty_project() -> dict:
    return {"version": "1.0", "layers": [], "mapView": {"center": [0, 0], "zoom": 2}}


def test_live_set_identify_accepts_list_of_layer_ids(tmp_path):
    mcp = build_server(tmp_path)
    tools = {tool.name: tool for tool in mcp._tool_manager.list_tools()}
    tool = tools["live_set_identify"]
    sig = inspect.signature(tool.fn)
    annotation = str(sig.parameters["layer_id"].annotation)
    assert "list[str]" in annotation


def test_set_plugin_state_deactivates_when_activate_false():
    project = _empty_project()
    authoring.set_plugin_state(project, "maplibre-h3-grid", {"resolution": 5}, activate=True)
    assert "maplibre-h3-grid" in project["plugins"]["activePluginIds"]

    result = authoring.set_plugin_state(project, "maplibre-h3-grid", state=None, activate=False)
    assert result["active"] is False
    assert "maplibre-h3-grid" not in project["plugins"]["activePluginIds"]
    assert project["plugins"]["settings"]["maplibre-h3-grid"] == {"resolution": 5}


def test_remove_layer_scrubs_bookmarks_storymap_and_secondary_views():
    project = _empty_project()
    layer_a = authoring.add_layer(
        project,
        {
            "id": "layer-a",
            "name": "Layer A",
            "type": "geojson",
            "source": {"type": "geojson", "data": {"type": "FeatureCollection", "features": []}},
        },
    )
    layer_b = authoring.add_layer(
        project,
        {
            "id": "layer-b",
            "name": "Layer B",
            "type": "geojson",
            "source": {"type": "geojson", "data": {"type": "FeatureCollection", "features": []}},
        },
    )
    authoring.add_bookmark(project, "View 1", visible_layers=[layer_a, layer_b])
    authoring.add_story_chapter(
        project,
        "Intro",
        on_enter=[{"layer": layer_a, "opacity": 1.0}, {"layer": layer_b, "opacity": 0.5}],
        on_exit=[{"layer": layer_a, "opacity": 0.0}],
    )
    project["secondaryMapViews"] = [
        {"id": "pane-1", "layerVisibility": {layer_a: True, layer_b: False}}
    ]

    authoring.remove_layer(project, layer_a)

    assert project["bookmarks"][0]["extra"]["visibleLayerIds"] == [layer_b]
    chapter = project["storymap"]["chapters"][0]
    assert [e["layerId"] for e in chapter["onChapterEnter"]] == [layer_b]
    assert chapter["onChapterExit"] == []
    assert project["secondaryMapViews"][0]["layerVisibility"] == {layer_b: False}


def test_non_finite_numeric_values_are_rejected():
    project = _empty_project()
    layer_id = authoring.add_layer(
        project,
        {
            "id": "layer-finite",
            "name": "Finite",
            "type": "geojson",
            "source": {"type": "geojson", "data": {"type": "FeatureCollection", "features": []}},
        },
    )
    with pytest.raises(ValueError, match="finite"):
        authoring.update_layer(project, layer_id, opacity=float("nan"))
    with pytest.raises(ValueError, match="finite"):
        authoring.add_colorbar(project, vmin=float("nan"), vmax=10.0)
    with pytest.raises(ValueError, match="finite"):
        authoring.add_colorbar(project, vmin=0.0, vmax=float("inf"))

    project["layers"][0]["opacity"] = float("nan")
    with pytest.raises(ValueError):
        render_project_html(project)

    relay = mcp_live.Relay("http://127.0.0.1:8765/geolibre/relay", "tok")
    with pytest.raises(ValueError):
        relay._exchange("POST", "/command", {"val": float("nan")}, timeout=1.0)


def test_save_project_writes_embedded_geojson_compactly(tmp_path):
    project = _empty_project()
    authoring.add_layer(
        project,
        {
            "id": "pts",
            "name": "Points",
            "type": "geojson",
            "source": {
                "type": "geojson",
                "data": {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": [-84.0, 36.0]},
                            "properties": {"name": "Knoxville"},
                        }
                    ],
                },
            },
        },
    )
    dest = tmp_path / "compact.geolibre.json"
    authoring.save_project(dest, project)
    text = dest.read_text(encoding="utf-8")
    # Valid JSON round-trip and compact single-line GeoJSON object.
    assert json.loads(text)["layers"][0]["name"] == "Points"
    assert '"coordinates":[-84.0,36.0]' in text


def test_render_project_html_normalizes_app_origin():
    project = _empty_project()
    html_https = render_project_html(project, app_url="https://user:pass@geolibre.app:443/map")
    assert '"https://geolibre.app"' in html_https
    assert "user:pass" not in html_https.split('"https://geolibre.app"')[1][:40]

    html_http = render_project_html(project, app_url="http://localhost:80/")
    assert '"http://localhost"' in html_http

    html_ipv6 = render_project_html(project, app_url="http://[::1]:5173/")
    assert '"http://[::1]:5173"' in html_ipv6


def test_tabular_records_raises_for_missing_file_path():
    with pytest.raises(FileNotFoundError, match="missing/cities.csv"):
        Map._tabular_records("missing/cities.csv")
    with pytest.raises(FileNotFoundError, match="nonexistent.csv"):
        Map._tabular_records("nonexistent.csv")
    # Inline CSV still works.
    rows = Map._tabular_records("longitude,latitude\n-84,36\n")
    assert rows == [{"longitude": "-84", "latitude": "36"}]


def test_live_relay_ipv6_url_and_pid_alive(monkeypatch):
    relay = mcp_live.Relay("http://[::1]:8765/geolibre/relay", "secret")
    assert relay.redacted_url == "http://[::1]:8765/geolibre/relay"

    assert mcp_live._pid_alive(0) is False
    assert mcp_live._pid_alive(-1) is False

    def fake_kill_eperm(_pid, _sig):
        raise PermissionError()

    def fake_kill_esrch(_pid, _sig):
        raise ProcessLookupError()

    monkeypatch.setattr(mcp_live.os, "kill", fake_kill_eperm)
    assert mcp_live._pid_alive(12345) is True

    monkeypatch.setattr(mcp_live.os, "kill", fake_kill_esrch)
    assert mcp_live._pid_alive(12345) is False


def test_server_raster_tile_returns_204_on_tile_outside_bounds(monkeypatch):
    class FakeTileOutsideBounds(Exception):
        pass

    class FakeReader:
        def __init__(self, _path):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def tile(self, *_args, **_kwargs):
            raise FakeTileOutsideBounds("outside bounds")

    fake_rio = types.ModuleType("rio_tiler")
    fake_cmap = types.ModuleType("rio_tiler.colormap")
    fake_cmap.cmap = MagicMock()
    fake_errors = types.ModuleType("rio_tiler.errors")
    fake_errors.TileOutsideBounds = FakeTileOutsideBounds
    fake_io = types.ModuleType("rio_tiler.io")
    fake_io.Reader = FakeReader

    monkeypatch.setitem(sys.modules, "rio_tiler", fake_rio)
    monkeypatch.setitem(sys.modules, "rio_tiler.colormap", fake_cmap)
    monkeypatch.setitem(sys.modules, "rio_tiler.errors", fake_errors)
    monkeypatch.setitem(sys.modules, "rio_tiler.io", fake_io)

    handler = object.__new__(_QuietHandler)
    statuses: list[int] = []
    headers: list[tuple[str, str]] = []
    handler.send_response = lambda code: statuses.append(code)  # type: ignore[method-assign]
    handler.send_header = lambda k, v: headers.append((k, v))  # type: ignore[method-assign]
    handler.end_headers = lambda: None  # type: ignore[method-assign]
    handler.send_error = lambda code, msg="": statuses.append(code)  # type: ignore[method-assign]

    handler._serve_raster_tile(("/tmp/fake.tif", None, None, None, 5, 99, 99), head_only=False)
    assert statuses == [204]
    assert ("Access-Control-Allow-Origin", "*") in headers
