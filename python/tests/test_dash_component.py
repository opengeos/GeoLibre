"""Tests for the optional Dash component integration."""

from __future__ import annotations

from pathlib import Path

import pytest

import geolibre.dash_component as dmod


def test_dash_bundle_is_packaged():
    bundle = Path(dmod.__file__).parent / "static" / "dash" / "geolibre.js"
    assert bundle.is_file()
    assert "clickData" in bundle.read_text(encoding="utf-8")


def test_dashmap_requires_dash_or_has_component():
    if dmod.Component is None:
        with pytest.raises(ImportError, match=r"geolibre\[dash\]"):
            dmod.DashMap()
    else:
        assert dmod.DashMap._namespace == "geolibre"
        assert dmod.DashMap._type == "DashMap"
        assert "clickData" in dmod.DashMap._prop_names
