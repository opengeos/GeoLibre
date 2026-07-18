"""Tests for the /ml segmentation proxy router.

The router is a thin reverse-proxy in front of a separate ``samgeo-api`` server,
so these tests exercise the proxy logic (status reporting, on-demand launch
decision, request forwarding, error mapping) without a live model server.
"""

from __future__ import annotations

import asyncio
import json
import subprocess

import pytest

from geolibre_server.app import ml
from geolibre_server.app.runtime import RuntimeBootstrapError

# --- fakes ----------------------------------------------------------------


class _FakeResp:
    def __init__(self, content=b'{"ok": 1}', status_code=200, content_type="application/json"):
        self.content = content
        self.status_code = status_code
        self.headers = {"content-type": content_type}

    def json(self):
        return json.loads(self.content)


class _FakeAsyncClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, content=None, headers=None):
        # _forward_segment streams the body as an async generator; consume it so
        # assertions can inspect the forwarded bytes.
        if hasattr(content, "__aiter__"):
            buffered = b""
            async for chunk in content:
                buffered += chunk
            content = buffered
        _FakeHttpx.calls.append(("POST", url, content, headers))
        return _FakeResp(content=b'{"type": "FeatureCollection", "features": []}')

    async def get(self, url):
        _FakeHttpx.calls.append(("GET", url))
        return _FakeResp()


class _FakeHttpx:
    """Minimal stand-in for the httpx module used by ml.py."""

    calls: list = []
    HTTPError = Exception
    AsyncClient = _FakeAsyncClient

    @staticmethod
    def get(url, timeout=None):
        if url.endswith("/health"):
            return _FakeResp(content=b'{"status": "ok", "version": "1.3.2"}')
        if url.endswith("/models"):
            return _FakeResp(content=b'{"models": {"sam3": ["facebook/sam3"]}}')
        return _FakeResp()


# --- status ----------------------------------------------------------------


def test_status_unavailable_when_backend_missing(monkeypatch):
    """No external URL and samgeo-api not on PATH -> available: false."""
    monkeypatch.setattr(ml, "_EXTERNAL_URL", None)
    monkeypatch.setattr(ml, "_child", {"proc": None, "url": None})
    monkeypatch.setattr(ml, "_launch_command", lambda: None)
    monkeypatch.setattr(ml, "_require_httpx", lambda: _FakeHttpx)

    status = ml.ml_status()
    assert status["available"] is False
    assert status["default_model"] == "sam3"
    assert "segment-geospatial" in status["message"]


def test_status_available_when_launchable(monkeypatch):
    """samgeo-api on PATH (but not yet running) -> available, lazy start."""
    monkeypatch.setattr(ml, "_EXTERNAL_URL", None)
    monkeypatch.setattr(ml, "_child", {"proc": None, "url": None})
    monkeypatch.setattr(ml, "_launch_command", lambda: ["samgeo-api"])
    monkeypatch.setattr(ml, "_require_httpx", lambda: _FakeHttpx)

    status = ml.ml_status()
    assert status["available"] is True
    assert "first use" in status["message"]


def test_status_reports_models_when_server_healthy(monkeypatch):
    """A reachable server -> available with version and model catalogue."""
    monkeypatch.setattr(ml, "_EXTERNAL_URL", None)
    monkeypatch.setattr(ml, "_child", {"proc": None, "url": "http://127.0.0.1:9"})
    monkeypatch.setattr(ml, "_is_healthy", lambda base, timeout=3.0: True)
    monkeypatch.setattr(ml, "_require_httpx", lambda: _FakeHttpx)

    status = ml.ml_status()
    assert status["available"] is True
    assert status["version"] == "1.3.2"
    assert status["models"] == {"sam3": ["facebook/sam3"]}


def test_status_external_url_not_responding(monkeypatch):
    """An explicitly configured URL that is down -> available: false."""
    monkeypatch.setattr(ml, "_EXTERNAL_URL", "http://127.0.0.1:9999")
    monkeypatch.setattr(ml, "_is_healthy", lambda base, timeout=3.0: False)
    monkeypatch.setattr(ml, "_require_httpx", lambda: _FakeHttpx)

    status = ml.ml_status()
    assert status["available"] is False
    assert "not responding" in status["message"]


# --- launch decision / error mapping --------------------------------------


def test_ensure_server_raises_without_command(monkeypatch):
    """With no external URL and no launchable command, bootstrap fails."""
    monkeypatch.setattr(ml, "_EXTERNAL_URL", None)
    monkeypatch.setattr(ml, "_child", {"proc": None, "url": None})
    monkeypatch.setattr(ml, "_launch_command", lambda: None)
    with pytest.raises(RuntimeBootstrapError):
        ml._ensure_server()


def test_ensure_server_timeout_cleans_up_child(monkeypatch):
    """A child that never becomes healthy is terminated, killed, and forgotten."""

    class _FakeProc:
        def __init__(self):
            self.terminated = False
            self.killed = False

        def poll(self):
            return None  # always "running" so the timeout path is taken

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.killed = True

        def wait(self, timeout=None):
            # Ignore SIGTERM so _terminate_process escalates to kill().
            raise subprocess.TimeoutExpired(cmd="samgeo-api", timeout=timeout)

    created = []

    def fake_popen(*args, **kwargs):
        proc = _FakeProc()
        created.append(proc)
        return proc

    monkeypatch.setattr(ml, "_EXTERNAL_URL", None)
    monkeypatch.setattr(ml, "_child", {"proc": None, "url": None})
    monkeypatch.setattr(ml, "_launch_command", lambda: ["samgeo-api"])
    monkeypatch.setattr(ml, "_free_port", lambda: 12345)
    monkeypatch.setattr(ml, "_is_healthy", lambda base, timeout=3.0: False)
    monkeypatch.setattr(ml, "_HEALTH_TIMEOUT_SECS", 0)
    monkeypatch.setattr(ml.subprocess, "Popen", fake_popen)

    with pytest.raises(RuntimeBootstrapError):
        ml._ensure_server()

    assert created and created[0].terminated and created[0].killed
    assert ml._child["proc"] is None
    assert ml._child["url"] is None


def test_resolve_base_maps_bootstrap_error_to_503(monkeypatch):
    """A RuntimeBootstrapError from _ensure_server surfaces as HTTP 503."""

    def boom():
        raise RuntimeBootstrapError("no backend")

    monkeypatch.setattr(ml, "_ensure_server", boom)
    with pytest.raises(ml.HTTPException) as exc_info:
        asyncio.run(ml._resolve_base())
    assert exc_info.value.status_code == 503


def test_redact_url_strips_credentials():
    """Credentials embedded in a samgeo-api URL are not surfaced to clients."""
    assert ml._redact_url("http://user:pass@gpu-host:8000") == "http://gpu-host:8000"
    # URLs without credentials are returned unchanged.
    assert ml._redact_url("http://127.0.0.1:8000") == "http://127.0.0.1:8000"


def test_launch_command_none_when_not_on_path(monkeypatch):
    """_launch_command returns None when the executable is not found."""
    monkeypatch.setattr(ml.shutil, "which", lambda _name: None)
    monkeypatch.setattr(ml, "_LAUNCH_CMD", "definitely-not-a-real-binary")
    assert ml._launch_command() is None


# --- request forwarding (needs httpx for TestClient) -----------------------


def test_segment_forwards_request_to_backend(monkeypatch):
    """POST /ml/segment/text streams through to samgeo-api /segment/text."""
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from geolibre_server.app.main import app

    _FakeHttpx.calls.clear()
    monkeypatch.setattr(ml, "_require_httpx", lambda: _FakeHttpx)
    monkeypatch.setattr(ml, "_ensure_server", lambda: "http://backend:9")

    client = TestClient(app)
    resp = client.post(
        "/ml/segment/text",
        files={"file": ("a.tif", b"fakebytes", "image/tiff")},
        data={"prompt": "tree", "model_version": "sam3"},
    )
    assert resp.status_code == 200
    assert resp.json()["type"] == "FeatureCollection"
    forwarded = [c for c in _FakeHttpx.calls if c[0] == "POST"]
    assert forwarded and forwarded[0][1] == "http://backend:9/segment/text"
    # The original multipart body is streamed through unchanged.
    assert b"fakebytes" in forwarded[0][2]
