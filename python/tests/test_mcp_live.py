"""Tests for the MCP server's live desktop relay client.

The HTTP tests speak to a loopback fake of ``/geolibre/relay``. They do not
need GeoLibre Desktop or the optional ``mcp`` SDK. The tool test skips
without the SDK, matching ``test_mcp_server.py``.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from geolibre.mcp.live import DESKTOP_PORT, LiveError, discover, require


class _RelayServer:
    """A loopback stand-in for the desktop Jupyter relay."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        self.authorization: str | None = None
        self.body: dict = {}
        self.response: dict = {"delivered": 1, "ok": True, "value": "layer-1"}
        self.status_code = 200
        self.redirect_to: str | None = None
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - stdlib handler name
                self._handle()

            def do_POST(self) -> None:  # noqa: N802 - stdlib handler name
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b""
                server.body = json.loads(raw.decode("utf-8")) if raw else {}
                self._handle()

            def _handle(self) -> None:
                server.paths.append(self.path.split("?", 1)[0])
                server.authorization = self.headers.get("Authorization")
                if server.redirect_to:
                    self.send_response(302)
                    self.send_header("Location", server.redirect_to)
                    self.end_headers()
                    return
                encoded = json.dumps(server.response).encode("utf-8")
                self.send_response(server.status_code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, format: str, *args: object) -> None:
                return

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._httpd.shutdown()
        self._thread.join(timeout=5)
        self._httpd.server_close()


@pytest.fixture
def relay_server():
    server = _RelayServer()
    yield server
    server.close()


def _connection_file(directory: Path, **overrides: object) -> None:
    payload = {
        "url": f"http://127.0.0.1:{DESKTOP_PORT}/",
        "token": "secret",
        "port": DESKTOP_PORT,
        "pid": os.getpid(),
        "root_dir": "/tmp/geolibre/runtime/notebooks",
    }
    payload.update(overrides)
    (directory / "jpserver-1.json").write_text(json.dumps(payload), encoding="utf-8")


def test_discover_reads_a_desktop_connection_file(tmp_path, monkeypatch):
    monkeypatch.delenv("GEOLIBRE_RELAY_URL", raising=False)
    monkeypatch.setattr("geolibre.mcp.live.runtime_directories", lambda: [tmp_path])
    _connection_file(tmp_path)
    relay = discover()
    assert relay is not None
    assert relay.redacted_url == f"http://127.0.0.1:{DESKTOP_PORT}/geolibre/relay"
    assert relay.token == "secret"
    assert "secret" not in relay.redacted_url


def test_discover_skips_another_jupyter_and_a_dead_pid(tmp_path, monkeypatch):
    monkeypatch.delenv("GEOLIBRE_RELAY_URL", raising=False)
    monkeypatch.setattr("geolibre.mcp.live.runtime_directories", lambda: [tmp_path])
    _connection_file(tmp_path, port=8888, pid=os.getpid())
    assert discover() is None
    _connection_file(tmp_path, pid=2**22)
    assert discover() is None


def test_explicit_url_must_be_loopback(monkeypatch):
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", "https://example.com/geolibre/relay")
    with pytest.raises(LiveError, match="loopback"):
        discover()


def test_command_posts_to_the_relay_and_returns_the_value(relay_server, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    monkeypatch.setenv("GEOLIBRE_RELAY_TOKEN", "secret")
    value = require().call("listLayers")
    assert value == "layer-1"
    assert relay_server.paths == ["/geolibre/relay/command"]
    assert relay_server.authorization == "token secret"
    assert relay_server.body["method"] == "listLayers"
    assert relay_server.body["requestId"]


def test_zero_listeners_is_a_live_error(relay_server, monkeypatch):
    relay_server.response = {"delivered": 0}
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    monkeypatch.setenv("GEOLIBRE_RELAY_TOKEN", "secret")
    with pytest.raises(LiveError, match="Jupyter Notebook"):
        require().call("flyTo", {"zoom": 4})


def test_redirect_is_not_followed(relay_server, monkeypatch):
    relay_server.redirect_to = f"http://127.0.0.1:{relay_server.port}/evil"
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}/geolibre/relay")
    monkeypatch.setenv("GEOLIBRE_RELAY_TOKEN", "secret")
    with pytest.raises(LiveError, match="redirect"):
        require().listeners()
    assert relay_server.paths == ["/geolibre/relay/status"]


def test_live_fly_to_tool_reports_a_missing_window(tmp_path, monkeypatch):
    pytest.importorskip("mcp", reason="the mcp SDK is an optional extra")
    import asyncio

    from mcp.server.mcpserver.exceptions import ToolError

    from geolibre.mcp.server import build_server
    from geolibre.mcp.workspace import Workspace

    monkeypatch.delenv("GEOLIBRE_RELAY_URL", raising=False)
    monkeypatch.setattr("geolibre.mcp.live.runtime_directories", lambda: [tmp_path])
    server = build_server(Workspace([tmp_path]))
    with pytest.raises(ToolError, match="Jupyter Notebook"):
        asyncio.run(server.call_tool("live_fly_to", {"lng": 72.5, "lat": 23.0, "zoom": 11}))


def test_environment_proxy_is_bypassed(relay_server, monkeypatch):
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.delenv("no_proxy", raising=False)
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    monkeypatch.setenv("GEOLIBRE_RELAY_TOKEN", "secret")
    assert require().call("listLayers") == "layer-1"
    assert relay_server.authorization == "token secret"


def test_live_set_opacity_rejects_out_of_range_values(tmp_path, monkeypatch):
    pytest.importorskip("mcp", reason="the mcp SDK is an optional extra")
    import asyncio

    from mcp.server.mcpserver.exceptions import ToolError

    from geolibre.mcp.server import build_server
    from geolibre.mcp.workspace import Workspace

    monkeypatch.delenv("GEOLIBRE_RELAY_URL", raising=False)
    monkeypatch.setattr("geolibre.mcp.live.runtime_directories", lambda: [tmp_path])
    server = build_server(Workspace([tmp_path]))
    with pytest.raises(ToolError, match="between 0 and 1"):
        asyncio.run(server.call_tool("live_set_opacity", {"layer_id": "a", "opacity": 1.5}))


def _live_server(tmp_path):
    """Build an MCP server for the live tool tests (skips without the SDK)."""
    pytest.importorskip("mcp", reason="the mcp SDK is an optional extra")
    from geolibre.mcp.server import build_server
    from geolibre.mcp.workspace import Workspace

    return build_server(Workspace([tmp_path]))


def test_live_list_algorithms_filters_by_query(relay_server, monkeypatch, tmp_path):
    import asyncio

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    relay_server.response = {
        "delivered": 1,
        "ok": True,
        "value": [
            {"id": "buffer", "name": "Buffer", "group": "Geometry", "description": ""},
            {"id": "centroid", "name": "Centroids", "group": "Geometry", "description": ""},
        ],
    }
    result = asyncio.run(server.call_tool("live_list_algorithms", {"query": "BUFF"}))
    assert [item["id"] for item in result.structured_content["result"]] == ["buffer"]
    assert relay_server.body["method"] == "listAlgorithms"


def test_live_run_algorithm_sends_the_parameters(relay_server, monkeypatch, tmp_path):
    import asyncio

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    relay_server.response = {
        "delivered": 1,
        "ok": True,
        "value": {"logs": ["done"], "resultLayerIds": ["out-1"]},
    }
    result = asyncio.run(
        server.call_tool(
            "live_run_algorithm",
            {"algorithm_id": "buffer", "parameters": {"layer": "a", "distance": 100}},
        )
    )
    assert result.structured_content == {"logs": ["done"], "resultLayerIds": ["out-1"]}
    assert relay_server.body["method"] == "runAlgorithm"
    assert relay_server.body["params"] == {
        "id": "buffer",
        "params": {"layer": "a", "distance": 100},
    }


def test_live_run_algorithm_reports_a_slow_run(relay_server, monkeypatch, tmp_path):
    import asyncio

    server = _live_server(tmp_path)
    from mcp.server.mcpserver.exceptions import ToolError

    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    relay_server.status_code = 504
    relay_server.response = {"message": "GeoLibre did not return a result in time."}
    with pytest.raises(ToolError, match="may still be running"):
        asyncio.run(server.call_tool("live_run_algorithm", {"algorithm_id": "buffer"}))


def test_live_get_layer_returns_matching_layer_or_raises(relay_server, monkeypatch, tmp_path):
    """live_get_layer resolves one layer by id from listLayers and rejects missing ids."""
    import asyncio

    from mcp.server.mcpserver.exceptions import ToolError

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    relay_server.response = {
        "delivered": 1,
        "ok": True,
        "value": [
            {"id": "layer-1", "name": "Roads", "type": "geojson", "visible": True, "opacity": 1.0},
            {"id": "layer-2", "name": "Lakes", "type": "geojson", "visible": False, "opacity": 0.5},
        ],
    }
    result = asyncio.run(server.call_tool("live_get_layer", {"layer_id": "layer-2"}))
    assert result.structured_content == {
        "id": "layer-2",
        "name": "Lakes",
        "type": "geojson",
        "visible": False,
        "opacity": 0.5,
    }
    assert relay_server.body["method"] == "listLayers"

    with pytest.raises(ToolError, match="No layer with id 'missing'"):
        asyncio.run(server.call_tool("live_get_layer", {"layer_id": "missing"}))


def test_live_get_and_set_view_and_fly_to_camera_fields(relay_server, monkeypatch, tmp_path):
    """live_get_view, live_set_view, and live_fly_to round-trip camera fields."""
    import asyncio

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    relay_server.response = {
        "delivered": 1,
        "ok": True,
        "value": {
            "center": [77.2, 28.6],
            "zoom": 10.5,
            "bearing": 15.0,
            "pitch": 30.0,
            "bbox": [77.0, 28.4, 77.4, 28.8],
        },
    }
    view = asyncio.run(server.call_tool("live_get_view", {}))
    assert view.structured_content["center"] == [77.2, 28.6]
    assert relay_server.body["method"] == "getView"

    set_res = asyncio.run(
        server.call_tool(
            "live_set_view",
            {"lng": 77.2, "lat": 28.6, "zoom": 12, "bearing": 45, "pitch": 60},
        )
    )
    assert set_res.structured_content == {
        "center": [77.2, 28.6],
        "zoom": 12.0,
        "bearing": 45.0,
        "pitch": 60.0,
    }
    assert relay_server.body["method"] == "setView"

    fly_res = asyncio.run(
        server.call_tool(
            "live_fly_to",
            {"lng": 77.2, "lat": 28.6, "zoom": 11, "bearing": 20, "pitch": 40, "duration": 1500},
        )
    )
    assert fly_res.structured_content == {
        "center": [77.2, 28.6],
        "zoom": 11,
        "bearing": 20.0,
        "pitch": 40.0,
        "duration": 1500.0,
    }
    assert relay_server.body["method"] == "flyTo"
    assert relay_server.body["params"] == {
        "center": [77.2, 28.6],
        "zoom": 11.0,
        "bearing": 20.0,
        "pitch": 40.0,
        "duration": 1500.0,
    }


def test_live_add_marker_and_add_markers(relay_server, monkeypatch, tmp_path):
    """live_add_marker and live_add_markers build Point FeatureCollections for addGeoJsonLayer."""
    import asyncio

    from mcp.server.mcpserver.exceptions import ToolError

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    relay_server.response = {"delivered": 1, "ok": True, "value": "marker-layer-1"}

    res1 = asyncio.run(
        server.call_tool(
            "live_add_marker",
            {
                "lng": 77.5946,
                "lat": 12.9716,
                "name": "Bengaluru",
                "properties": {"city": "Bengaluru"},
                "style": {"fillColor": "#ef4444"},
            },
        )
    )
    assert res1.structured_content == {"layerId": "marker-layer-1", "layerName": "Bengaluru"}
    assert relay_server.body["method"] == "addGeoJsonLayer"
    assert relay_server.body["params"]["geojson"]["features"] == [
        {
            "type": "Feature",
            "properties": {"city": "Bengaluru"},
            "geometry": {"type": "Point", "coordinates": [77.5946, 12.9716]},
        }
    ]

    relay_server.response = {"delivered": 1, "ok": True, "value": "markers-layer-2"}
    res2 = asyncio.run(
        server.call_tool(
            "live_add_markers",
            {
                "points": [
                    [72.8777, 19.0760],
                    {"lon": 88.3639, "latitude": 22.5726, "label": "Kolkata"},
                ],
                "name": "Cities",
            },
        )
    )
    assert res2.structured_content == {
        "layerId": "markers-layer-2",
        "layerName": "Cities",
        "count": 2,
    }
    features = relay_server.body["params"]["geojson"]["features"]
    assert len(features) == 2
    assert features[1]["properties"] == {"label": "Kolkata"}

    with pytest.raises(ToolError, match="points must not be empty"):
        asyncio.run(server.call_tool("live_add_markers", {"points": []}))


def test_live_feature_queries_and_identify(relay_server, monkeypatch, tmp_path):
    """Feature query tools and live_identify forward requests and return feature lists."""
    import asyncio

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    sample_feature = {
        "type": "Feature",
        "properties": {"name": "Lake"},
        "geometry": {"type": "Point", "coordinates": [77.0, 32.0]},
    }
    relay_server.response = {"delivered": 1, "ok": True, "value": [sample_feature]}

    res_layer = asyncio.run(server.call_tool("live_get_layer_features", {"layer_id": "lakes-1"}))
    assert res_layer.structured_content["result"] == [sample_feature]
    assert relay_server.body["method"] == "getLayerFeatures"
    assert relay_server.body["params"] == {"layerId": "lakes-1"}

    res_sel = asyncio.run(server.call_tool("live_get_selected_features", {}))
    assert res_sel.structured_content["result"] == [sample_feature]
    assert relay_server.body["method"] == "getSelectedFeatures"

    res_drawn = asyncio.run(server.call_tool("live_get_drawn_features", {}))
    assert res_drawn.structured_content["result"] == [sample_feature]
    assert relay_server.body["method"] == "getDrawnFeatures"

    res_id = asyncio.run(
        server.call_tool("live_identify", {"lng": 77.0, "lat": 32.0, "layer_id": "lakes-1"})
    )
    assert res_id.structured_content["result"] == [sample_feature]
    assert relay_server.body["method"] == "identify"
    assert relay_server.body["params"] == {"lngLat": [77.0, 32.0], "layerId": "lakes-1"}


def test_live_identify_toggle_and_control_visibility(relay_server, monkeypatch, tmp_path):
    """live_set_identify, live_get_identify, and live_set_control_visible."""
    import asyncio

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    relay_server.response = {"delivered": 1, "ok": True, "value": "*"}

    set_id = asyncio.run(server.call_tool("live_set_identify", {"layer_id": "*"}))
    assert set_id.structured_content == {"layerId": "*"}
    assert relay_server.body["method"] == "setIdentify"

    get_id = asyncio.run(server.call_tool("live_get_identify", {}))
    assert get_id.structured_content == {"layerId": "*"}
    assert relay_server.body["method"] == "getIdentify"

    relay_server.response = {"delivered": 1, "ok": True, "value": True}
    ctrl = asyncio.run(
        server.call_tool(
            "live_set_control_visible",
            {"control": "minimap", "visible": True, "options": {"size": "sm"}},
        )
    )
    assert ctrl.structured_content == {"control": "minimap", "visible": True}
    assert relay_server.body["method"] == "setControlVisible"
    assert relay_server.body["params"] == {
        "control": "minimap",
        "visible": True,
        "options": {"size": "sm"},
    }


def test_live_whitebox_tools_and_model_builder(relay_server, monkeypatch, tmp_path):
    """live_list_whitebox_tools, live_run_whitebox_tool, and live_run_model_builder."""
    import asyncio

    from mcp.server.mcpserver.exceptions import ToolError

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    relay_server.response = {
        "delivered": 1,
        "ok": True,
        "value": [
            {"id": "slope", "name": "Slope", "category": "Terrain", "description": "Slope angle"},
            {"id": "aspect", "name": "Aspect", "category": "Terrain", "description": "Aspect"},
        ],
    }
    tools_res = asyncio.run(server.call_tool("live_list_whitebox_tools", {"query": "SLOPE"}))
    assert [t["id"] for t in tools_res.structured_content["result"]] == ["slope"]
    assert relay_server.body["method"] == "listWhiteboxTools"

    relay_server.response = {
        "delivered": 1,
        "ok": True,
        "value": {"logs": ["slope complete"], "resultLayerIds": ["wb-1"]},
    }
    run_wb = asyncio.run(
        server.call_tool(
            "live_run_whitebox_tool",
            {"tool_id": "slope", "parameters": {"dem": "dem-1", "units": "degrees"}},
        )
    )
    assert run_wb.structured_content == {"logs": ["slope complete"], "resultLayerIds": ["wb-1"]}
    assert relay_server.body["method"] == "runWhiteboxTool"
    assert relay_server.body["params"] == {
        "id": "slope",
        "params": {"dem": "dem-1", "units": "degrees"},
    }

    relay_server.response = {
        "delivered": 1,
        "ok": True,
        "value": {"outputLayerIds": ["model-out-1"]},
    }
    graph = {"nodes": [{"id": "n1", "kind": "input", "layerId": "a"}], "edges": []}
    model_res = asyncio.run(server.call_tool("live_run_model_builder", {"graph": graph}))
    assert model_res.structured_content == {"outputLayerIds": ["model-out-1"]}
    assert relay_server.body["method"] == "runModelBuilder"
    assert relay_server.body["params"] == {"graph": graph}

    with pytest.raises(ToolError, match="non-empty"):
        asyncio.run(server.call_tool("live_run_model_builder", {"graph": {}}))


def test_live_to_image_returns_data_url_or_writes_workspace_png(
    relay_server, monkeypatch, tmp_path
):
    """live_to_image returns a PNG dataUrl or writes a confined .png in the workspace."""
    import asyncio
    import base64

    from mcp.server.mcpserver.exceptions import ToolError

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    raw_png = b"\x89PNG\r\n\x1a\nfakepngbytes"
    data_url = "data:image/png;base64," + base64.b64encode(raw_png).decode("ascii")
    relay_server.response = {"delivered": 1, "ok": True, "value": data_url}

    res_inline = asyncio.run(server.call_tool("live_to_image", {}))
    assert res_inline.structured_content == {"dataUrl": data_url, "bytes": len(raw_png)}
    assert relay_server.body["method"] == "toImage"

    res_file = asyncio.run(server.call_tool("live_to_image", {"out_path": "snapshot.png"}))
    written = tmp_path / "snapshot.png"
    assert written.read_bytes() == raw_png
    assert res_file.structured_content == {"path": str(written.resolve()), "bytes": len(raw_png)}

    with pytest.raises(ToolError, match="already exists"):
        asyncio.run(server.call_tool("live_to_image", {"out_path": "snapshot.png"}))

    with pytest.raises(ToolError, match="expected a file ending in .png"):
        asyncio.run(server.call_tool("live_to_image", {"out_path": "bad.txt"}))
