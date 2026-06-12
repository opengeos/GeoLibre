"""Tornado-free tests for the GeoLibre Jupyter Server extension wiring.

The route-serving tests (which require tornado) live in
``test_extension_routes.py`` so this module can be collected and run in CI
environments that install only ``anywidget``/``traitlets``/``pytest``.
"""

from __future__ import annotations

import json
import pathlib

import geolibre
from geolibre import _extension


def test_extension_points():
    assert geolibre._jupyter_server_extension_points() == [{"module": "geolibre"}]


def test_app_route_matches_frontend():
    # The front-end (_frontend.js) loads "{base_url}geolibre/app/index.html".
    assert _extension.APP_ROUTE == "geolibre/app"


def test_config_drop_in_enables_extension():
    config = (
        pathlib.Path(__file__).resolve().parents[1]
        / "jupyter-config"
        / "jupyter_server_config.d"
        / "geolibre.json"
    )
    data = json.loads(config.read_text(encoding="utf-8"))
    assert data["ServerApp"]["jpserver_extensions"]["geolibre"] is True
