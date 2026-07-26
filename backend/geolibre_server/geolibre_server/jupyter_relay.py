"""Jupyter Server extension: relay map commands from ANY kernel to the app.

The kernel-side ``geolibre`` client (``notebook_client.py``) drives the live
GeoLibre map. Its original transport was ``display(Javascript(...))`` posting to
``window.parent``, which only works when the notebook is rendered *inside* the
app's Notebook-panel ``<iframe>``. Connect an external Jupyter frontend to the
same server — VS Code's Jupyter extension, ``jupyter console``, nbclient — and
that output is never executed in a window the app can see, so every map command
silently did nothing (issue #1442).

This extension adds a transport that does not depend on how the notebook is
being *displayed*, only on which server the kernel belongs to:

``POST {base_url}geolibre/relay/command``
    Send one scripting command (the kernel side). Responds with
    ``{"delivered": n}`` — the number of connected app windows it reached, so the
    client can warn instead of failing silently.
``GET {base_url}geolibre/relay/socket`` (WebSocket)
    Subscribe to commands (the app side). Every posted command is broadcast to
    all open sockets.
``GET {base_url}geolibre/relay/status``
    ``{"listeners": n}`` — whether any app window is currently subscribed.

Kernels find the relay through two environment variables exported here at
extension load; kernels the server spawns inherit them, which is what lets an
externally driven kernel reach the map with no extra setup:

- ``GEOLIBRE_RELAY_URL`` — the ``…/geolibre/relay`` base URL
- ``GEOLIBRE_RELAY_TOKEN`` — the server's auth token (may be empty)

Security: the server binds loopback and every endpoint here requires the same
per-launch token as the rest of the Jupyter API, so a command can only be
injected by something that already has full kernel-execution rights on this
server. WebSocket origins are restricted to the app's own origins (the same set
``jupyter_server_config.py`` allows to frame the server).

Enabled from ``jupyter_server_config.py``; the app side is
``apps/geolibre-desktop/src/hooks/useJupyterRelay.ts``.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlparse

from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.base.websocket import WebSocketMixin
from jupyter_server.utils import url_path_join
from tornado import web, websocket

__all__ = [
    "ENV_RELAY_TOKEN",
    "ENV_RELAY_URL",
    "RELAY_PATH",
    "is_allowed_origin",
    "normalize_command",
    "relay_base_url",
]

#: URL segment the relay endpoints live under, relative to the server's base_url.
RELAY_PATH = "geolibre/relay"

#: Environment variables kernels read to find the relay (see module docstring).
ENV_RELAY_URL = "GEOLIBRE_RELAY_URL"
ENV_RELAY_TOKEN = "GEOLIBRE_RELAY_TOKEN"

#: Message envelope the scripting bridge speaks, shared with the postMessage
#: transport (``useNotebookBridge``) so the app dispatches both identically.
COMMAND_TYPE = "geolibre:command"

# Origins allowed to open the relay WebSocket: the Tauri webview (tauri:// on
# macOS/Linux, https://tauri.localhost on Windows) and any loopback dev origin.
# This mirrors the `frame-ancestors` list in jupyter_server_config.py — the app
# that may embed this server is exactly the app that may drive the map.
_ALLOWED_ORIGIN_HOSTS = frozenset({"localhost", "127.0.0.1", "tauri.localhost"})
_ALLOWED_ORIGIN_SCHEMES = frozenset({"http", "https", "tauri"})

# Open app-side sockets. Module level (not per-handler) because every handler
# instance is created per request: the POST handler needs the set the WebSocket
# handlers registered themselves in.
_listeners: set[GeoLibreRelaySocket] = set()


def is_allowed_origin(origin: str | None) -> bool:
    """Return whether ``origin`` may open the relay WebSocket.

    Args:
        origin: The request's ``Origin`` header, or None when absent (a non-browser
            client such as a test harness, which is not subject to the same-origin
            policy and is already token-gated).

    Returns:
        True when the origin is one of the GeoLibre app origins (Tauri webview or
        loopback), or when no origin was sent.
    """
    if not origin:
        return True
    parsed = urlparse(origin)
    if parsed.scheme not in _ALLOWED_ORIGIN_SCHEMES:
        return False
    return (parsed.hostname or "") in _ALLOWED_ORIGIN_HOSTS


def normalize_command(payload: Any) -> dict[str, Any]:
    """Validate a posted command and return the envelope to broadcast.

    Args:
        payload: The decoded JSON request body.

    Returns:
        A ``{"type", "requestId", "method", "params"}`` envelope.

    Raises:
        ValueError: If the payload is not a command envelope with a method name.
    """
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object.")
    method = payload.get("method")
    if not isinstance(method, str) or not method:
        raise ValueError("Missing a non-empty 'method'.")
    params = payload.get("params") or {}
    if not isinstance(params, dict):
        raise ValueError("'params' must be an object.")
    request_id = payload.get("requestId")
    return {
        "type": COMMAND_TYPE,
        "requestId": request_id if isinstance(request_id, str) else "",
        "method": method,
        "params": params,
    }


def relay_base_url(host: str, port: int, base_url: str) -> str:
    """Build the ``…/geolibre/relay`` URL kernels post commands to.

    Args:
        host: The server's bind address; a wildcard or empty value becomes
            ``127.0.0.1`` (the relay is only ever reached over loopback).
        port: The server's port.
        base_url: The server's ``base_url`` prefix (usually ``/``).

    Returns:
        An absolute ``http://`` URL with no trailing slash.
    """
    if host in {"", "0.0.0.0", "::"}:  # noqa: S104 - matched, not bound
        host = "127.0.0.1"
    return f"http://{host}:{port}" + url_path_join(base_url, RELAY_PATH)


def _broadcast(message: dict[str, Any]) -> int:
    """Send ``message`` to every open app socket; return how many received it."""
    encoded = json.dumps(message)
    delivered = 0
    # Copy: write_message on a closed socket raises and we drop it from the set.
    for socket in list(_listeners):
        try:
            socket.write_message(encoded)
        except Exception:  # noqa: BLE001 - a dead peer must not fail the request
            _listeners.discard(socket)
            continue
        delivered += 1
    return delivered


class GeoLibreRelaySocket(WebSocketMixin, websocket.WebSocketHandler, JupyterHandler):
    """The app side: subscribes to every command posted to the relay."""

    def check_origin(self, origin: str | None = None) -> bool:
        """Allow the GeoLibre app's origins (see :func:`is_allowed_origin`)."""
        return is_allowed_origin(origin or self.request.headers.get("Origin"))

    async def pre_get(self) -> None:
        """Reject an unauthenticated upgrade before the WebSocket handshake."""
        if self.current_user is None:
            raise web.HTTPError(403)

    async def get(self, *args: Any, **kwargs: Any) -> None:
        """Authenticate, then complete the WebSocket handshake."""
        await self.pre_get()
        await super().get(*args, **kwargs)

    def open(self, *args: Any, **kwargs: Any) -> None:
        """Register this app window as a command listener."""
        _listeners.add(self)
        self.write_message(json.dumps({"type": "geolibre:relay-ready"}))

    def on_message(self, message: str) -> None:
        """Ignore app→relay traffic: commands are fire-and-forget today."""

    def on_close(self) -> None:
        """Unregister this app window."""
        _listeners.discard(self)


class GeoLibreRelayCommandHandler(APIHandler):
    """The kernel side: posts one command to every connected app window."""

    @web.authenticated
    def post(self) -> None:
        """Relay the posted command and report how many windows received it."""
        try:
            message = normalize_command(json.loads(self.request.body or b"{}"))
        except (ValueError, json.JSONDecodeError) as error:
            raise web.HTTPError(400, str(error)) from error
        self.finish(json.dumps({"delivered": _broadcast(message)}))


class GeoLibreRelayStatusHandler(APIHandler):
    """Report whether any app window is listening, without sending a command."""

    @web.authenticated
    def get(self) -> None:
        """Return the number of connected app windows."""
        self.finish(json.dumps({"listeners": len(_listeners)}))


def _jupyter_server_extension_points() -> list[dict[str, str]]:
    """Declare this module as the extension entry point (Jupyter Server API)."""
    return [{"module": "geolibre_server.jupyter_relay"}]


def _load_jupyter_server_extension(serverapp: Any) -> None:
    """Register the relay endpoints and publish them to future kernels.

    Args:
        serverapp: The running ``ServerApp``, supplied by Jupyter Server.
    """
    web_app = serverapp.web_app
    base_url = web_app.settings["base_url"]
    prefix = url_path_join(base_url, RELAY_PATH)
    web_app.add_handlers(
        ".*$",
        [
            (url_path_join(prefix, "socket"), GeoLibreRelaySocket),
            (url_path_join(prefix, "command"), GeoLibreRelayCommandHandler),
            (url_path_join(prefix, "status"), GeoLibreRelayStatusHandler),
        ],
    )

    # Kernels inherit the server process environment at spawn time, so exporting
    # here (startup, before any kernel exists) is what makes `import geolibre`
    # work from an externally driven kernel with no configuration.
    os.environ[ENV_RELAY_URL] = relay_base_url(serverapp.ip, serverapp.port, base_url)
    os.environ[ENV_RELAY_TOKEN] = _server_token(serverapp)
    serverapp.log.info("GeoLibre map-command relay listening at %s", prefix)


def _server_token(serverapp: Any) -> str:
    """Best-effort read of the server's auth token across Jupyter Server versions."""
    identity_provider = getattr(serverapp, "identity_provider", None)
    token = getattr(identity_provider, "token", None)
    if not isinstance(token, str):
        token = getattr(serverapp, "token", None)
    return token if isinstance(token, str) else ""
