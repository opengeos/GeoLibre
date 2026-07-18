"""A tiny localhost static server for the bundled GeoLibre web app.

The widget renders the full GeoLibre single-page app inside an ``<iframe>``. A
multi-chunk Vite SPA needs a real HTTP origin to resolve its dynamically
imported chunks, so the package serves the bundled ``static/app`` directory from
a background ``ThreadingHTTPServer`` bound to loopback. The server is a
process-wide singleton: every widget instance shares the one origin.

Note: because it binds to 127.0.0.1, the iframe URL is only reachable when the
browser runs on the same host as the kernel (local Jupyter, VS Code). Remote
setups reach the app a different way: Google Colab routes through its port proxy,
and JupyterHub / remote servers load the bundle from the Jupyter Server extension
in ``_extension.py`` instead of this localhost server.
"""

from __future__ import annotations

import os
import secrets
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote

_lock = threading.Lock()
_server: ThreadingHTTPServer | None = None
_base_url: str | None = None
_port: int | None = None

# URL path prefix under which kernel-side local files (e.g. a local GeoTIFF for
# add_raster) are exposed by the static server, keyed by an unguessable token so
# only files the user explicitly registered are reachable. Trailing slash so the
# token starts immediately after it.
_LOCAL_FILE_PREFIX = "/_geolibre_local/"
# token -> absolute filesystem path for files registered via register_local_file.
_local_files: dict[str, Path] = {}
# Chunk size for streaming a (possibly ranged) local file response.
_STREAM_CHUNK = 64 * 1024


class _QuietHandler(SimpleHTTPRequestHandler):
    """Serve the app bundle plus registered local files, quietly.

    Adds a ``/_geolibre_local/<token>/...`` route on top of the static app
    directory so a kernel-side file (a local GeoTIFF handed to ``add_raster``)
    can be fetched by the in-iframe app. The route honours HTTP ``Range``
    requests, which the GeoTIFF reader (``geotiff.js``) relies on for partial
    reads; the stdlib handler does not implement Range for the static tree.
    """

    def log_message(self, *args: object) -> None:  # noqa: D401 - silence logs
        pass

    def _match_local_file(self) -> Path | None:
        """Return the registered file for a ``/_geolibre_local/<token>`` request.

        Returns:
            The absolute path registered under the request's token, or ``None``
            when the path is not a local-file route or the token is unknown.
        """
        path = unquote(self.path.split("?", 1)[0].split("#", 1)[0])
        if not path.startswith(_LOCAL_FILE_PREFIX):
            return None
        token = path[len(_LOCAL_FILE_PREFIX) :].split("/", 1)[0]
        with _lock:
            return _local_files.get(token)

    def _serve_local_file(self, file_path: Path, *, head_only: bool) -> None:
        """Serve a registered local file, honouring a single-range ``Range`` header.

        Args:
            file_path: Absolute path of the registered file to serve.
            head_only: When True, send headers only (a HEAD request).
        """
        try:
            handle = open(file_path, "rb")  # noqa: SIM115 - closed in finally
        except OSError:
            self.send_error(404, "File not found")
            return
        try:
            size = os.fstat(handle.fileno()).st_size
            start, end, status = 0, size - 1, 200
            range_header = self.headers.get("Range")
            if range_header and range_header.startswith("bytes="):
                parsed = self._parse_single_range(range_header, size)
                if parsed is None:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                start, end = parsed
                status = 206
            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", self.guess_type(str(file_path)))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            # Same-origin in local Jupyter/VS Code; the wildcard keeps the fetch
            # working if the app is served from a different origin (the file
            # server is loopback-only and serves only registered tokens).
            self.send_header("Access-Control-Allow-Origin", "*")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if head_only:
                return
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(_STREAM_CHUNK, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
        finally:
            handle.close()

    @staticmethod
    def _parse_single_range(range_header: str, size: int) -> tuple[int, int] | None:
        """Parse the first byte range of a ``Range: bytes=`` header.

        Args:
            range_header: The raw ``Range`` header value (``bytes=...``).
            size: Total size of the file in bytes.

        Returns:
            A ``(start, end)`` inclusive byte range clamped to the file, or
            ``None`` if the range is unsatisfiable (caller should reply 416).
        """
        spec = range_header.split("=", 1)[1].split(",", 1)[0].strip()
        first, _, last = spec.partition("-")
        try:
            if first == "":
                # Suffix range "-N": the final N bytes.
                length = int(last)
                if length <= 0:
                    return None
                start = max(0, size - length)
                end = size - 1
            else:
                start = int(first)
                end = int(last) if last else size - 1
        except ValueError:
            return None
        if start > end or start >= size:
            return None
        return start, min(end, size - 1)

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        matched = self._match_local_file()
        if matched is not None:
            self._serve_local_file(matched, head_only=False)
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802 - http.server naming
        matched = self._match_local_file()
        if matched is not None:
            self._serve_local_file(matched, head_only=True)
            return
        super().do_HEAD()

    def do_OPTIONS(self) -> None:  # noqa: N802 - http.server naming
        # Modern browsers treat a simple ``Range: bytes=…`` as a CORS-safelisted
        # request header (no preflight), but answer OPTIONS anyway so older
        # browsers / proxies that do preflight the ranged COG fetch don't get the
        # stdlib's 501 and silently fail to render the local raster.
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()


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


def ensure_bundle(static_dir: Path) -> None:
    """Verify the bundled app is present, raising a helpful error if not.

    Args:
        static_dir: Directory expected to contain the built app
            (``index.html`` and its assets).

    Raises:
        FileNotFoundError: If ``index.html`` is missing from ``static_dir``.
    """
    if not (static_dir / "index.html").is_file():
        raise FileNotFoundError(
            f"The bundled GeoLibre app was not found at {static_dir}. "
            "Reinstall the geolibre wheel, or run `npm run build:embed` from a "
            "checkout of the GeoLibre repository."
        )


def serve_app(static_dir: Path) -> str:
    """Start (once) the static server for ``static_dir`` and return its base URL.

    Args:
        static_dir: Directory containing the built app (``index.html`` etc.).
            On the second and subsequent calls this argument is ignored; the
            singleton server started by the first call is reused.

    Returns:
        The base URL of the running server, ending with ``/``.

    Raises:
        FileNotFoundError: If the bundled app is not present.
    """
    global _server, _base_url, _port

    with _lock:
        # _base_url, _server, and _port are always set together, so one check
        # covers all three. Validate the bundle only at first boot; later calls
        # reuse the running server regardless of `static_dir`, so a subsequently
        # missing/different path 404s rather than raising (acceptable: the
        # singleton always serves the same `_STATIC_APP` directory).
        if _base_url is None:
            ensure_bundle(static_dir)
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
            _port = port
        return _base_url


def register_local_file(path: str | os.PathLike[str]) -> str:
    """Register a kernel-side local file and return a URL the app can fetch.

    The bundled static server gains a ``/_geolibre_local/<token>/<name>`` route
    backed by ``path``, so the in-iframe app can read a file that lives on the
    kernel host (for example a local GeoTIFF passed to ``add_raster``). The token
    is unguessable and lives only for this kernel session, so the URL is not
    durable: a project saved with such a URL will 404 when reopened later.

    The static server must already be running (the :class:`~geolibre.Map`
    constructor starts it). The URL is only reachable when the browser runs on
    the same host as the kernel (local Jupyter, VS Code), matching the static
    server's loopback binding.

    Args:
        path: Filesystem path to the file to serve.

    Returns:
        An absolute URL on the static server that serves the file.

    Raises:
        ValueError: If the path does not point to an existing file.
        RuntimeError: If the static server has not been started yet.
    """
    file_path = Path(path).expanduser().resolve()
    if not file_path.is_file():
        raise ValueError(f"Local file not found: {path}")
    with _lock:
        if _base_url is None:
            raise RuntimeError("The GeoLibre static server is not running; create a Map first.")
        # Reuse an existing token for the same file so repeated add_raster calls
        # in a long-running notebook don't grow the registry without bound.
        token = next(
            (tok for tok, registered in _local_files.items() if registered == file_path),
            None,
        )
        if token is None:
            token = secrets.token_urlsafe(16)
            _local_files[token] = file_path
        base = _base_url
    return f"{base}{_LOCAL_FILE_PREFIX.lstrip('/')}{token}/{quote(file_path.name)}"


def app_port() -> int | None:
    """Return the port the static app server is listening on, if started.

    The port lets the front-end route through a host proxy (for example
    ``google.colab.kernel.proxyPort``) when the browser cannot reach the
    kernel's ``localhost`` directly.
    """
    return _port
