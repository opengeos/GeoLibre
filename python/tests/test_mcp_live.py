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

    from mcp.server.mcpserver.exceptions import ToolError

    server = _live_server(tmp_path)
    monkeypatch.setenv("GEOLIBRE_RELAY_URL", f"http://127.0.0.1:{relay_server.port}")
    relay_server.status_code = 504
    relay_server.response = {"message": "GeoLibre did not return a result in time."}
    with pytest.raises(ToolError, match="may still be running"):
        asyncio.run(server.call_tool("live_run_algorithm", {"algorithm_id": "buffer"}))
