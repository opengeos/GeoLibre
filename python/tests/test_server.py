"""Tests for the static server's kernel-side local-file route (Range support).

The route backs add_raster's local-GeoTIFF support: the in-iframe GeoTIFF
reader needs HTTP Range, which the stdlib static handler does not implement.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from pathlib import Path

import pytest

from geolibre import _server


@pytest.fixture
def served(tmp_path, monkeypatch):
    """Boot the static server against a stub bundle and yield helpers.

    Resets the module-level server singleton so the test owns a fresh server,
    then registers a known-content file and returns its URL plus the payload.
    """
    # Force a fresh singleton: other tests/imports may have started one already.
    monkeypatch.setattr(_server, "_server", None)
    monkeypatch.setattr(_server, "_base_url", None)
    monkeypatch.setattr(_server, "_port", None)
    monkeypatch.setattr(_server, "_local_files", {})

    bundle = tmp_path / "app"
    bundle.mkdir()
    (bundle / "index.html").write_text("<html></html>", encoding="utf-8")
    _server.serve_app(bundle)

    payload = bytes(range(256)) * 40  # 10_240 deterministic bytes
    raster = tmp_path / "dem.tif"
    raster.write_bytes(payload)
    url = _server.register_local_file(raster)
    return url, payload


def _get(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310 - loopback
        return response.status, dict(response.headers), response.read()


def test_full_get_returns_whole_file(served):
    url, payload = served
    status, headers, body = _get(url)
    assert status == 200
    assert body == payload
    assert headers["Accept-Ranges"] == "bytes"


def test_range_request_returns_206_slice(served):
    url, payload = served
    status, headers, body = _get(url, {"Range": "bytes=100-199"})
    assert status == 206
    assert headers["Content-Range"] == f"bytes 100-199/{len(payload)}"
    assert body == payload[100:200]


def test_suffix_range(served):
    url, payload = served
    status, _headers, body = _get(url, {"Range": "bytes=-50"})
    assert status == 206
    assert body == payload[-50:]


def test_open_ended_range(served):
    url, payload = served
    status, headers, body = _get(url, {"Range": "bytes=10200-"})
    assert status == 206
    assert headers["Content-Range"] == f"bytes 10200-{len(payload) - 1}/{len(payload)}"
    assert body == payload[10200:]


def test_unsatisfiable_range_returns_416(served):
    url, payload = served
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        _get(url, {"Range": "bytes=999999-"})
    assert excinfo.value.code == 416
    assert excinfo.value.headers["Content-Range"] == f"bytes */{len(payload)}"


def test_unknown_token_404s(served):
    url, _payload = served
    base = url.split("/_geolibre_local/", 1)[0]
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        _get(f"{base}/_geolibre_local/deadbeeftoken/x.tif")
    assert excinfo.value.code == 404


def test_register_missing_file_raises(served):
    with pytest.raises(ValueError, match="not found"):
        _server.register_local_file(Path("/no/such/raster.tif"))


def test_register_requires_running_server(monkeypatch, tmp_path):
    monkeypatch.setattr(_server, "_base_url", None)
    existing = tmp_path / "f.tif"
    existing.write_bytes(b"x")
    with pytest.raises(RuntimeError, match="not running"):
        _server.register_local_file(existing)
