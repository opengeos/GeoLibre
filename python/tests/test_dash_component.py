"""Tests for the optional Dash component integration."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

import geolibre
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


def test_importing_geolibre_does_not_import_dash():
    # Dash opens a comm at import, which Jupyter frontends log as an error.
    code = (
        "import sys, geolibre\n"
        "assert 'dash' not in sys.modules\n"
        "assert 'geolibre.dash_component' not in sys.modules\n"
        "assert geolibre.DashMap is not None\n"
        "assert 'geolibre.dash_component' in sys.modules\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True)


def test_unknown_package_attribute_raises_attribute_error():
    with pytest.raises(AttributeError, match="no_such_name"):
        geolibre.no_such_name
