"""A tiny localhost static server for the bundled GeoLibre web app.

The widget renders the full GeoLibre single-page app inside an ``<iframe>``. A
multi-chunk Vite SPA needs a real HTTP origin to resolve its dynamically
imported chunks, so the package serves the bundled ``static/app`` directory from
a background ``ThreadingHTTPServer`` bound to loopback. The server is a
process-wide singleton: every widget instance shares the one origin.

Note: because it binds to 127.0.0.1, the iframe URL is only reachable when the
browser runs on the same host as the kernel (local Jupyter, VS Code). Remote
setups (JupyterHub, Colab) would need a proxy; that is a known limitation.
"""

from __future__ import annotations

import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_lock = threading.Lock()
_server: ThreadingHTTPServer | None = None
_base_url: str | None = None


class _QuietHandler(SimpleHTTPRequestHandler):
    """A request handler that does not spam the notebook with access logs."""

    def log_message(self, *args: object) -> None:  # noqa: D401 - silence logs
        pass


class _QuietServer(ThreadingHTTPServer):
    """A server that swallows the broken-pipe noise of early-closed requests.

    Browsers routinely abort asset requests (e.g. on reload), which would
    otherwise print connection-reset tracebacks into the notebook/kernel log.
    """

    daemon_threads = True

    def handle_error(self, request: object, client_address: object) -> None:
        # Silently discard connection resets and broken pipes; these are
        # expected when browsers abort in-flight asset requests. Any other
        # exception is a genuine handler bug, so surface it as usual.
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def serve_app(static_dir: Path) -> str:
    """Start (once) the static server for ``static_dir`` and return its base URL.

    Args:
        static_dir: Directory containing the built app (``index.html`` etc.).

    Returns:
        The base URL of the running server, ending with ``/``.

    Raises:
        FileNotFoundError: If the bundled app is not present.
    """
    global _server, _base_url

    if not (static_dir / "index.html").is_file():
        raise FileNotFoundError(
            f"The bundled GeoLibre app was not found at {static_dir}. "
            "Reinstall the geolibre wheel, or run `npm run build:embed` from a "
            "checkout of the GeoLibre repository."
        )

    with _lock:
        if _server is None or _base_url is None:
            handler = partial(_QuietHandler, directory=str(static_dir))
            server = _QuietServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(
                target=server.serve_forever,
                name="geolibre-static-server",
                daemon=True,
            )
            thread.start()
            host, port = server.server_address[:2]
            _server = server
            _base_url = f"http://{host}:{port}/"
        return _base_url
