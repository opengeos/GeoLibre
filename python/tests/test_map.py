"""Tests for Map helpers that do not require a running widget/server."""

from __future__ import annotations

import pytest

from geolibre.geolibre import Map


def test_remote_mode_explicit():
    assert Map._resolve_remote_mode(True) == "remote"
    assert Map._resolve_remote_mode(False) == ""


def test_remote_mode_auto_local(monkeypatch):
    monkeypatch.delenv("JUPYTERHUB_SERVICE_PREFIX", raising=False)
    assert Map._resolve_remote_mode("auto") == ""


def test_remote_mode_auto_jupyterhub(monkeypatch):
    monkeypatch.setenv("JUPYTERHUB_SERVICE_PREFIX", "/user/alice/")
    assert Map._resolve_remote_mode("auto") == "remote"


def test_remote_mode_invalid():
    with pytest.raises(ValueError):
        Map._resolve_remote_mode("bogus")


def test_remote_mode_colab_forces_direct(monkeypatch):
    # Colab uses its own port proxy (front-end), which needs the localhost
    # server; an explicit server_proxy=True must not switch it to the remote
    # path.
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: True))
    assert Map._resolve_remote_mode(True) == ""


def test_remote_mode_non_colab_uses_remote(monkeypatch):
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: False))
    assert Map._resolve_remote_mode(True) == "remote"
