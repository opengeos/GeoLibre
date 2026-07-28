"""Tests for shared managed-runtime environment handling."""

from __future__ import annotations

import pytest

from geolibre_server.app.runtime import _clean_env


def test_clean_env_drops_inherited_proj_search_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Managed geospatial wheels must discover their own bundled PROJ data."""
    monkeypatch.setenv("PROJ_DATA", "/system/share/proj")
    monkeypatch.setenv("PROJ_LIB", "/legacy/system/share/proj")
    monkeypatch.setenv("GEOLIBRE_RUNTIME_DIR", "/managed/geolibre")

    env = _clean_env()

    assert "PROJ_DATA" not in env
    assert "PROJ_LIB" not in env
    assert env["GEOLIBRE_RUNTIME_DIR"] == "/managed/geolibre"
