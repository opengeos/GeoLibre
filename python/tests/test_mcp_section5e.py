"""Tests for Section 5e MCP authoring and live desktop tool parity."""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import Any

import pytest

import geolibre.geolibre as gmod
from geolibre import Map, authoring
from geolibre.mcp.workspace import Workspace

mcp_mod = pytest.importorskip("mcp")
from geolibre.mcp.server import build_server  # noqa: E402, I001


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


def _call(server: Any, tool_name: str, **kwargs: Any) -> Any:
    result = asyncio.run(server.call_tool(tool_name, kwargs))
    # MCPServer.call_tool returns either (content, structured) or CallToolResult
    if isinstance(result, tuple) and len(result) == 2:
        return result[1]
    if hasattr(result, "structured_content") and result.structured_content is not None:
        return result.structured_content
    if hasattr(result, "content") and result.content:
        return json.loads(result.content[0].text)
    return result


def test_mcp_authoring_clear_popup_set_projection_duplicate_layer_and_export_html(tmp_path):
    ws = Workspace([tmp_path])
    server = build_server(ws)
    proj_path = str(tmp_path / "demo.geolibre.json")

    _call(server, "create_project", path=proj_path, name="Demo")
    added = _call(
        server,
        "add_geojson_layer",
        path=proj_path,
        name="Cities",
        data=json.dumps(POINT_FC),
    )
    orig_id = added["layerId"]

    # set_layer_popup then clear_popup
    _call(server, "set_layer_popup", path=proj_path, layer="Cities", fields=["name"])
    loaded = authoring.load_project(proj_path)
    assert "popup" in authoring.find_layer(loaded, "Cities")

    cleared = _call(server, "clear_popup", path=proj_path, layer="Cities")
    assert cleared["layer"]["id"] == orig_id
    loaded = authoring.load_project(proj_path)
    assert "popup" not in authoring.find_layer(loaded, "Cities")

    # set_projection
    proj_res = _call(server, "set_projection", path=proj_path, projection="mercator")
    assert proj_res["projection"] == "mercator"
    loaded = authoring.load_project(proj_path)
    assert loaded["preferences"]["map"]["projection"] == "mercator"

    with pytest.raises(Exception, match="globe|mercator"):
        _call(server, "set_projection", path=proj_path, projection="robinson")

    # duplicate_layer
    dup = _call(server, "duplicate_layer", path=proj_path, layer="Cities", name="Cities Copy")
    assert dup["layerCount"] == 2
    assert dup["layer"]["name"] == "Cities Copy"
    assert dup["layer"]["id"] != orig_id

    # export_html forwards layout & theme
    out_html = tmp_path / "out.html"
    exported = _call(
        server,
        "export_html",
        path=proj_path,
        out_path=str(out_html),
        layout="maponly",
        theme="dark",
    )
    assert Path(exported["path"]) == out_html
    html_text = out_html.read_text(encoding="utf-8")
    assert "maponly" in html_text
    assert "dark" in html_text


def test_map_delegates_duplicate_layer_and_set_projection(monkeypatch):
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    m = Map()
    layer_id = m.add_geojson(POINT_FC, name="Cities")
    dup_id = m.duplicate_layer(layer_id, name="Cities 2")
    assert dup_id != layer_id
    assert len(m.layers) == 2
    m.set_projection("mercator")
    assert m.projection == "mercator"
    m.set_projection("globe")
    assert m.projection == "globe"


def test_mcp_live_tools_for_raster_tiles_labels_filter_and_renderer(tmp_path, monkeypatch):
    calls: list[tuple[str, dict[str, Any]]] = []

    class FakeRelay:
        def call(self, command: str, params: dict[str, Any] | None = None) -> Any:
            calls.append((command, dict(params or {})))
            if command in ("addTileLayer", "addCogLayer", "addRasterBytes"):
                return f"layer-{len(calls)}"
            if command == "setLabels":
                return (params or {}).get("labels", {})
            return None

    monkeypatch.setattr("geolibre.mcp.live.require", lambda: FakeRelay())

    ws = Workspace([tmp_path])
    server = build_server(ws)

    # live_add_tile_layer
    tile = _call(
        server,
        "live_add_tile_layer",
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        name="OSM",
        options={"tileSize": 256},
    )
    assert tile["layerId"] == "layer-1"
    assert calls[-1][0] == "addTileLayer"

    # live_add_cog
    cog = _call(
        server,
        "live_add_cog",
        url="https://example.com/dem.tif",
        name="DEM",
        options={"colormap": "terrain"},
    )
    assert cog["layerId"] == "layer-2"
    assert calls[-1][0] == "addCogLayer"

    # live_add_raster with local workspace GeoTIFF
    tif = tmp_path / "sample.tif"
    tif.write_bytes(b"II*\x00fake-tiff-bytes")
    local_r = _call(server, "live_add_raster", source=str(tif), name="Local DEM")
    assert local_r["layerId"] == "layer-3"
    assert calls[-1][0] == "addRasterBytes"
    assert base64.b64decode(calls[-1][1]["data"]) == b"II*\x00fake-tiff-bytes"

    # live_add_raster with URL delegates to addCogLayer
    remote_r = _call(server, "live_add_raster", source="https://example.com/ndvi.tif")
    assert remote_r["layerId"] == "layer-4"
    assert calls[-1][0] == "addCogLayer"

    # live_set_labels sends validated partial patch, including restyling without restating field
    lbl = _call(
        server,
        "live_set_labels",
        layer_id="layer-1",
        field="name",
        size=14,
        color="#112233",
        options={"line_gap": True, "line_gap_padding": 3, "line_spacing": 200},
    )
    assert calls[-1][0] == "setLabels"
    assert calls[-1][1]["labels"] == {
        "field": "name",
        "enabled": True,
        "size": 14.0,
        "color": "#112233",
        "lineGap": True,
        "lineGapPadding": 3.0,
        "lineSpacing": 200.0,
    }
    assert lbl["layerId"] == "layer-1"

    # Partial restyle without field/expression succeeds and only sends updated keys
    restyle = _call(server, "live_set_labels", layer_id="layer-1", size=18)
    assert calls[-1][0] == "setLabels"
    assert calls[-1][1]["labels"] == {"size": 18.0}
    assert restyle["layerId"] == "layer-1"

    # one_per_polygon maps to onePerPolygon (polygon labels placed once)
    _call(server, "live_set_labels", layer_id="layer-1", options={"one_per_polygon": False})
    assert calls[-1][1]["labels"] == {"onePerPolygon": False}

    # live_set_filter validates and sends expression, and clears on None
    flt = _call(
        server,
        "live_set_filter",
        layer_id="layer-1",
        expression=[">=", ["get", "pop"], 100000],
    )
    assert calls[-1] == (
        "setFilter",
        {"layerId": "layer-1", "expression": [">=", ["get", "pop"], 100000]},
    )
    assert flt["expression"] == [">=", ["get", "pop"], 100000]

    cleared = _call(server, "live_set_filter", layer_id="layer-1", expression=None)
    assert calls[-1] == ("setFilter", {"layerId": "layer-1", "expression": None})
    assert cleared["expression"] is None

    # live_set_renderer
    ren = _call(server, "live_set_renderer", renderer="cesium")
    assert calls[-1] == ("setRenderer", {"renderer": "cesium"})
    assert ren["renderer"] == "cesium"

    with pytest.raises(Exception, match="renderer"):
        _call(server, "live_set_renderer", renderer="invalid")
