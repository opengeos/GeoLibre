"""Drive the map open in GeoLibre Desktop from the MCP server.

GeoLibre Desktop answers scripting commands on one of two loopback relays,
which speak the same protocol:

- the **sidecar relay** (``POST /relay/command`` on the processing sidecar,
  port 8765). The sidecar advertises it in ``~/.geolibre/runtime/live-relay.json``
  (see :func:`sidecar_discovery_file`) while it runs. Desktop starts the sidecar
  at launch when Settings → Startup → "Allow AI agents to drive the map" is on,
  or whenever a processing tool needs it.
- the **Jupyter relay** (``POST /geolibre/relay/command`` on the JupyterLab
  server Desktop starts from Processing → Jupyter Notebook, port 8766), found
  through Jupyter's own connection file.

The endpoint is never taken from the model. It comes from ``GEOLIBRE_RELAY_URL``
or from one of those files, and only a loopback URL is accepted. Redirects are
refused so the relay token cannot be sent off the machine.
"""

from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import ParseResult, urlparse

__all__ = [
    "DESKTOP_PORT",
    "LiveError",
    "Relay",
    "command_timeout_seconds",
    "discover",
    "require",
    "runtime_directories",
    "sidecar_discovery_file",
]

#: Port ``start_jupyter_server`` binds. Anything else is some other Jupyter.
DESKTOP_PORT = 8766

#: Serialized command cap. The file tools allow 50 MB on disk; a live POST
#: also has to cross the app's scripting bridge in one request.
MAX_COMMAND_BYTES = 8 * 1024 * 1024

#: How long the relay waits for the app's result when a method has no entry in
#: :data:`METHOD_TIMEOUT_SECONDS`. View and layer-list commands answer in
#: milliseconds.
DEFAULT_TIMEOUT_SECONDS = 5.0

#: Result waits for commands that do real work in the app. Mirrors
#: ``METHOD_RESULT_TIMEOUT_SECONDS`` in the backend's ``relay_protocol.py``;
#: this side sends its choice as ``timeoutSeconds`` so the two cannot disagree.
METHOD_TIMEOUT_SECONDS: dict[str, float] = {
    "runAlgorithm": 30 * 60.0,
    "runWhiteboxTool": 30 * 60.0,
    "runModelBuilder": 60 * 60.0,
    "addRasterBytes": 120.0,
    "addGeoJsonLayer": 60.0,
    "getLayerFeatures": 60.0,
    "toImage": 60.0,
}

#: Bounds a caller-supplied timeout is clamped to (the relay clamps the same way).
MIN_TIMEOUT_SECONDS = 0.5
MAX_TIMEOUT_SECONDS = 4 * 60 * 60.0

#: Extra socket time over the relay's result wait, so the relay's precise HTTP
#: 504 arrives as the error instead of a generic client timeout.
SOCKET_GRACE_SECONDS = 5.0

#: Kept for callers that read it: the socket timeout of a default command.
COMMAND_TIMEOUT_SECONDS = DEFAULT_TIMEOUT_SECONDS + SOCKET_GRACE_SECONDS

#: Overrides where the sidecar relay's discovery file is read from.
SIDECAR_DISCOVERY_ENV = "GEOLIBRE_LIVE_RELAY_FILE"

NOT_CONNECTED = (
    "No GeoLibre window is listening. Open GeoLibre Desktop with Settings → "
    'Startup → "Allow AI agents to drive the map" turned on (or open '
    "Processing → Jupyter Notebook once; the panel can be closed afterwards), "
    "and retry."
)


class LiveError(ValueError):
    """A live command could not be completed.

    A ``ValueError`` so the MCP tool wrapper reports the message to the
    caller instead of an internal traceback.
    """


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Reject redirects. A loopback relay must not forward the token."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise LiveError(f"Refusing to follow a relay redirect to {newurl}.")


class Relay:
    """One discovered desktop relay."""

    def __init__(self, base_url: str, token: str) -> None:
        parsed = _require_loopback(base_url)
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.host = parsed.hostname or ""
        self.port = parsed.port or 80

    @property
    def redacted_url(self) -> str:
        """The relay URL with no token, safe to return to a model."""
        host = f"[{self.host}]" if ":" in self.host else self.host
        path = urlparse(self.base_url).path or "/geolibre/relay"
        return f"http://{host}:{self.port}{path}"

    def listeners(self) -> int:
        """Return how many GeoLibre windows are subscribed."""
        payload = self._exchange("GET", "/status", None, timeout=2.0)
        count = payload.get("listeners")
        if not isinstance(count, int):
            raise LiveError("GeoLibre relay returned an unexpected status.")
        return count

    def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        """Run one scripting command and return the app's result value.

        Args:
            method: The scripting method name.
            params: The method's parameters.
            timeout: Seconds the relay waits for the app's result. None picks
                the per-method default (:func:`command_timeout_seconds`).

        Returns:
            The value the app returned.

        Raises:
            LiveError: When no window is listening, the relay is unreachable,
                the command failed in the app, or it did not finish in time.
        """
        wait = command_timeout_seconds(method, timeout)
        body = {
            "type": "geolibre:command",
            "requestId": uuid.uuid4().hex,
            "method": method,
            "params": params or {},
            "timeoutSeconds": wait,
        }
        payload = self._exchange("POST", "/command", body, timeout=wait + SOCKET_GRACE_SECONDS)
        delivered = payload.get("delivered")
        if not isinstance(delivered, int) or delivered < 1:
            raise LiveError(NOT_CONNECTED)
        if payload.get("ok") is not True:
            raise LiveError(str(payload.get("error") or "GeoLibre command failed."))
        return payload.get("value")

    def _exchange(
        self,
        method: str,
        suffix: str,
        body: dict[str, Any] | None,
        *,
        timeout: float,
    ) -> dict[str, Any]:
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, allow_nan=False).encode("utf-8")
            if len(data) > MAX_COMMAND_BYTES:
                raise LiveError(
                    f"Live command is {len(data)} bytes; the limit is {MAX_COMMAND_BYTES}."
                )
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"token {self.token}"
        request = urllib.request.Request(  # noqa: S310 - loopback checked above and below
            self.base_url + suffix,
            data=data,
            headers=headers,
            method=method,
        )
        # An empty ProxyHandler stops HTTP_PROXY from routing the token
        # through a proxy instead of straight to the loopback relay.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _RefuseRedirects)
        try:
            with opener.open(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except LiveError:
            raise
        except urllib.error.HTTPError as error:
            raise LiveError(_http_error(error)) from error
        except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError) as error:
            raise LiveError(
                f"GeoLibre relay could not be reached ({error}). {NOT_CONNECTED}"
            ) from error
        if not isinstance(payload, dict):
            raise LiveError("GeoLibre relay returned a non-object response.")
        return payload


def command_timeout_seconds(method: str, requested: float | None = None) -> float:
    """Return how long the relay should wait for ``method``'s result.

    Args:
        method: The scripting method name.
        requested: A caller-chosen wait in seconds, or None for the default.

    Returns:
        ``requested`` clamped to [:data:`MIN_TIMEOUT_SECONDS`,
        :data:`MAX_TIMEOUT_SECONDS`], or the per-method default.

    Raises:
        LiveError: If ``requested`` is not a finite positive number.
    """
    if requested is None:
        return METHOD_TIMEOUT_SECONDS.get(method, DEFAULT_TIMEOUT_SECONDS)
    if (
        isinstance(requested, bool)
        or not isinstance(requested, (int, float))
        or not math.isfinite(requested)
        or requested <= 0
    ):
        raise LiveError("timeout_seconds must be a positive number of seconds.")
    return float(min(max(requested, MIN_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS))


def discover() -> Relay | None:
    """Find the desktop relay, or None when Desktop has not started one.

    ``GEOLIBRE_RELAY_URL`` wins when set. Next is the sidecar relay's discovery
    file (:func:`sidecar_discovery_file`) when its pid is alive. Last, Jupyter
    connection files for port 8766 whose ``root_dir`` is the desktop notebooks
    directory are candidates; a dead pid is skipped, and two live servers is an
    error (set the environment variable to pick one).
    """
    explicit = os.environ.get("GEOLIBRE_RELAY_URL", "").strip()
    if explicit:
        token = os.environ.get("GEOLIBRE_RELAY_TOKEN", "").strip()
        return Relay(_with_relay_path(explicit), token)

    sidecar = _relay_from_sidecar_file(sidecar_discovery_file())
    if sidecar is not None:
        return sidecar

    found: list[Relay] = []
    for directory in runtime_directories():
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("jpserver-*.json")):
            relay = _relay_from_connection_file(path)
            if relay is not None:
                found.append(relay)
    if not found:
        return None
    if len(found) > 1:
        raise LiveError(
            "More than one GeoLibre Desktop Jupyter server is running. "
            "Set GEOLIBRE_RELAY_URL to the one to drive."
        )
    return found[0]


def require() -> Relay:
    """Return the desktop relay, or raise a message the user can act on."""
    relay = discover()
    if relay is None:
        raise LiveError(NOT_CONNECTED)
    return relay


def sidecar_discovery_file() -> Path:
    """Return where the desktop sidecar advertises its relay.

    Returns:
        ``GEOLIBRE_LIVE_RELAY_FILE`` when set, else
        ``~/.geolibre/runtime/live-relay.json`` (written by the backend's
        ``geolibre_server.app.relay``).
    """
    override = os.environ.get(SIDECAR_DISCOVERY_ENV, "").strip()
    if override:
        return Path(override)
    return Path.home() / ".geolibre" / "runtime" / "live-relay.json"


def runtime_directories() -> list[Path]:
    """Jupyter runtime directories, in the order a connection file is sought."""
    directories: list[Path] = []
    override = os.environ.get("JUPYTER_RUNTIME_DIR", "").strip()
    if override:
        directories.append(Path(override))
    home = Path.home()
    directories.extend(
        [
            home / "Library" / "Jupyter" / "runtime",
            home / ".local" / "share" / "jupyter" / "runtime",
            home / "AppData" / "Roaming" / "jupyter" / "runtime",
        ]
    )
    return directories


def _relay_from_sidecar_file(path: Path) -> Relay | None:
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(info, dict):
        return None
    url = info.get("url")
    token = info.get("token")
    if not isinstance(url, str) or not isinstance(token, str) or not token:
        return None
    pid = info.get("pid")
    if not isinstance(pid, int) or not _pid_alive(pid):
        return None
    try:
        if not _loopback_host(url):
            return None
        return Relay(url, token)
    except (LiveError, ValueError):
        return None


def _relay_from_connection_file(path: Path) -> Relay | None:
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(info, dict):
        return None
    if info.get("port") != DESKTOP_PORT:
        return None
    url = info.get("url")
    token = info.get("token")
    root = info.get("root_dir")
    if not isinstance(url, str) or not isinstance(token, str) or not isinstance(root, str):
        return None
    if not _loopback_host(url):
        return None
    normalized_root = root.replace("\\", "/").rstrip("/")
    if not normalized_root.endswith("/notebooks"):
        return None
    pid = info.get("pid")
    if isinstance(pid, int) and not _pid_alive(pid):
        return None
    try:
        return Relay(_with_relay_path(url), token)
    except LiveError:
        return None


def _with_relay_path(url: str) -> str:
    parsed = _require_loopback(url)
    path = parsed.path.rstrip("/")
    if path.endswith("/geolibre/relay"):
        base = url.rstrip("/")
    else:
        base = url.rstrip("/") + "/geolibre/relay"
    return base


def _require_loopback(url: str) -> ParseResult:
    parsed = urlparse(url)
    if parsed.scheme != "http" or not _loopback_host(url):
        raise LiveError(
            "GEOLIBRE_RELAY_URL must be an http:// loopback address (127.0.0.1, localhost, or ::1)."
        )
    return parsed


def _loopback_host(url: str) -> bool:
    host = urlparse(url).hostname
    return host in {"127.0.0.1", "localhost", "::1"}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _http_error(error: urllib.error.HTTPError) -> str:
    detail = ""
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        payload = None
    if isinstance(payload, dict):
        message = payload.get("message") or payload.get("reason") or payload.get("detail")
        if isinstance(message, str):
            detail = message
    if error.code == 504:
        return "GeoLibre did not return a result in time. The command may still be running."
    if detail:
        return f"GeoLibre relay returned HTTP {error.code} ({detail})."
    return f"GeoLibre relay returned HTTP {error.code}."


def _windows_pid_alive(pid: int) -> bool:
    # os.kill(pid, 0) is not an existence probe on Windows: signal 0 is
    # CTRL_C_EVENT, sent through GenerateConsoleCtrlEvent. Waiting on the
    # process handle avoids mistaking an exit code of 259 for STILL_ACTIVE.
    import ctypes

    synchronize = 0x00100000
    wait_timeout = 0x00000102
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    kernel32.OpenProcess.argtypes = (ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong)
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_ulong)
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == wait_timeout
    finally:
        kernel32.CloseHandle(handle)
