"""Tests for Map helpers that do not require a running widget/server."""

from __future__ import annotations

import pytest

from geolibre.geolibre import Map


def test_server_proxy_explicit():
    assert Map._resolve_server_proxy(True) is True
    assert Map._resolve_server_proxy(False) is False


def test_server_proxy_auto_local(monkeypatch):
    monkeypatch.delenv("JUPYTERHUB_SERVICE_PREFIX", raising=False)
    assert Map._resolve_server_proxy("auto") is False


def test_server_proxy_auto_jupyterhub(monkeypatch):
    monkeypatch.setenv("JUPYTERHUB_SERVICE_PREFIX", "/user/alice/")
    assert Map._resolve_server_proxy("auto") is True


def test_server_proxy_invalid():
    with pytest.raises(ValueError):
        Map._resolve_server_proxy("bogus")
