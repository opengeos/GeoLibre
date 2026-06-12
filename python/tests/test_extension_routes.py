"""Route-serving tests for the GeoLibre Jupyter Server extension.

These exercise the bundled app served over a running tornado app, so they need
both tornado and the built app bundle. tornado is an implicit Jupyter Server
dependency but is not guaranteed in the minimal CI test environment, so the
whole module is skipped when it is absent.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

pytest.importorskip("tornado")

from tornado.testing import AsyncHTTPTestCase  # noqa: E402
from tornado.web import Application  # noqa: E402

from geolibre import _extension  # noqa: E402

pytestmark = pytest.mark.skipif(
    not (_extension._STATIC_APP / "index.html").is_file(),
    reason="bundled app not built (run `npm run build:embed`)",
)


def _load_app(base_url: str) -> Application:
    app = Application(base_url=base_url)
    serverapp = SimpleNamespace(web_app=app, log=logging.getLogger("geolibre-test"))
    _extension.load_jupyter_server_extension(serverapp)
    return app


class _RouteCases:
    """Shared assertions; a mixin (not a TestCase) so it is not collected alone.

    ``PREFIX`` is the Jupyter Server ``base_url``; subclasses pin it to the local
    ("/") and JupyterHub-style ("/user/alice/") cases.
    """

    PREFIX = "/"

    def get_app(self):
        return _load_app(self.PREFIX)

    def test_serves_index_html(self):
        resp = self.fetch(f"{self.PREFIX}geolibre/app/index.html")
        assert resp.code == 200
        assert b"<!doctype html" in resp.body[:64].lower()

    def test_head_probe_reaches_index_html(self):
        # The front-end gates extension mode on a HEAD probe of index.html; make
        # sure HEAD is served (a GET-only regression would slip past otherwise).
        resp = self.fetch(f"{self.PREFIX}geolibre/app/index.html", method="HEAD")
        assert resp.code == 200

    def test_directory_defaults_to_index(self):
        resp = self.fetch(f"{self.PREFIX}geolibre/app/")
        assert resp.code == 200
        assert b"<!doctype html" in resp.body[:64].lower()

    def test_unknown_asset_is_404(self):
        resp = self.fetch(f"{self.PREFIX}geolibre/app/does-not-exist.js")
        assert resp.code == 404


class TestRootBaseUrlRoute(_RouteCases, AsyncHTTPTestCase):
    """Default base_url, as on local Jupyter."""

    PREFIX = "/"


class TestHubBaseUrlRoute(_RouteCases, AsyncHTTPTestCase):
    """JupyterHub-style base_url prefix -- the scenario this extension fixes."""

    PREFIX = "/user/alice/"
