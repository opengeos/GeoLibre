"""A Jupyter Server extension that serves the bundled GeoLibre web app.

The widget renders the full GeoLibre single-page app inside an ``<iframe>``. On
remote deployments (JupyterHub and managed/shared hubs) the browser cannot reach
the kernel's ``localhost``, and raw-port proxying via ``jupyter-server-proxy`` is
frequently unavailable or disabled. This extension sidesteps both problems by
serving the bundled app from the Jupyter Server's own origin at
``{base_url}geolibre/app/`` -- the same authenticated origin that serves the
notebook, so it is reachable wherever the notebook itself is.

The files served here are only the static app bundle (the same public app
published at geolibre.app); no notebook or project data passes through this
route. Project state is exchanged separately over ``window.postMessage`` between
the kernel and the iframe. The bundle is therefore served without per-request
authentication, matching how Jupyter serves its own static assets.

The extension auto-enables on install via the
``etc/jupyter/jupyter_server_config.d/geolibre.json`` drop-in shipped in the
wheel; the package-level ``_jupyter_server_extension_points`` /
``_load_jupyter_server_extension`` hooks (in ``geolibre/__init__.py``) delegate
to :func:`load_jupyter_server_extension` below.
"""

from __future__ import annotations

import pathlib
from typing import Any

from tornado.web import StaticFileHandler

# Mount point under the Jupyter Server base URL. Kept in sync with the front-end
# (_frontend.js), which loads "{base_url}geolibre/app/index.html".
APP_ROUTE = "geolibre/app"

_HERE = pathlib.Path(__file__).parent
_STATIC_APP = _HERE / "static" / "app"


class _AppStaticHandler(StaticFileHandler):
    """Serve the bundled app, defaulting a bare directory request to index.html.

    A plain tornado ``StaticFileHandler`` (not a ``JupyterHandler``) is used on
    purpose: the static app bundle carries no user data, so it is served like any
    other static asset, and this also keeps Jupyter Server from flagging it as an
    unauthenticated handler.
    """


def load_jupyter_server_extension(serverapp: Any) -> None:
    """Register the static-app route on a running Jupyter Server.

    Args:
        serverapp: The ``jupyter_server.serverapp.ServerApp`` instance passed by
            Jupyter Server when it loads the extension.
    """
    from jupyter_server.utils import url_path_join

    web_app = serverapp.web_app
    base_url = web_app.settings["base_url"]
    route = url_path_join(base_url, APP_ROUTE, "(.*)")
    web_app.add_handlers(
        ".*$",
        [
            (
                route,
                _AppStaticHandler,
                {"path": str(_STATIC_APP), "default_filename": "index.html"},
            )
        ],
    )
    serverapp.log.info(
        "[geolibre] Serving the bundled app at %s%s/", base_url, APP_ROUTE
    )
