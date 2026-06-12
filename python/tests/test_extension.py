"""Tests for the GeoLibre Jupyter Server extension that serves the bundled app."""

from __future__ import annotations

import json
import logging
import pathlib
from types import SimpleNamespace

import pytest
from tornado.testing import AsyncHTTPTestCase
from tornado.web import Application

import geolibre
from geolibre import _extension

_HAS_BUNDLE = (_extension._STATIC_APP / "index.html").is_file()
_needs_bundle = pytest.mark.skipif(
    not _HAS_BUNDLE,
    reason="bundled app not built (run `npm run build:embed`)",
)


def test_extension_points():
    assert geolibre._jupyter_server_extension_points() == [{"module": "geolibre"}]


def test_config_drop_in_enables_extension():
    config = (
        pathlib.Path(__file__).resolve().parents[1]
        / "jupyter-config"
        / "jupyter_server_config.d"
        / "geolibre.json"
    )
    data = json.loads(config.read_text(encoding="utf-8"))
    assert data["ServerApp"]["jpserver_extensions"]["geolibre"] is True


@_needs_bundle
class ExtensionRouteTest(AsyncHTTPTestCase):
    def get_app(self):
        app = Application(base_url="/")
        serverapp = SimpleNamespace(
            web_app=app, log=logging.getLogger("geolibre-test")
        )
        _extension.load_jupyter_server_extension(serverapp)
        return app

    def test_serves_index_html(self):
        resp = self.fetch("/geolibre/app/index.html")
        assert resp.code == 200
        assert b"<!doctype html" in resp.body[:64].lower()

    def test_directory_defaults_to_index(self):
        resp = self.fetch("/geolibre/app/")
        assert resp.code == 200
        assert b"<!doctype html" in resp.body[:64].lower()

    def test_unknown_asset_is_404(self):
        resp = self.fetch("/geolibre/app/does-not-exist.js")
        assert resp.code == 404
