"""Live MCP command relay hosted on the sidecar.

The Live MCP tools (``python/src/geolibre/mcp/live.py``) drive the map open in
GeoLibre Desktop through a loopback relay. Originally the only relay lived on
the desktop JupyterLab server, so Live MCP needed Processing -> Jupyter Notebook
opened once per launch. This router serves the same protocol from the sidecar,
which the desktop starts on demand (or at launch when Settings -> Startup ->
"Allow AI agents to drive the map" is on), so no Jupyter server is needed.

Endpoints, all under ``/relay``:

``GET /relay/socket`` (WebSocket)
    The app side. Subscribes to every posted command and sends back
    ``geolibre:result`` frames. Authenticated with the per-launch sidecar token
    in the ``token`` query parameter (a WebSocket handshake cannot carry a
    header from the webview), and restricted to the app's origins.
``POST /relay/command``
    The client side. Posts one command and, when it carries a ``requestId``,
    waits for the correlated result. The wait is per method and a caller may set
    its own with ``timeoutSeconds`` (see ``relay_protocol``).
``GET /relay/status``
    ``{"listeners": n}``.

The client side does not use the sidecar token. It uses a separate relay token
generated per process and written, with the URL and pid, to a discovery file
readable only by the current user (:func:`discovery_file`). A Live MCP client
therefore gets the right to send map commands and nothing else the sidecar
serves.

The relay is off unless ``GEOLIBRE_LIVE_RELAY_PORT`` is set (the desktop shell
sets it when it spawns the sidecar) and multi-tenant mode is off: a shared
server must never broadcast one user's commands to another user's window.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import os
import secrets
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from ..relay_protocol import (
    is_allowed_origin,
    normalize_command,
    normalize_result,
    result_timeout_seconds,
)
from .tenant import is_multi_tenant_enabled

__all__ = [
    "DISCOVERY_FILE_ENV",
    "PORT_ENV",
    "RELAY_CLIENT_PATHS",
    "discovery_file",
    "relay_enabled",
    "relay_token",
    "remove_discovery_file",
    "router",
    "write_discovery_file",
]

#: Set by the desktop shell to the sidecar's port; its presence enables the relay.
PORT_ENV = "GEOLIBRE_LIVE_RELAY_PORT"

#: Overrides where the discovery file is written (tests, unusual home dirs).
DISCOVERY_FILE_ENV = "GEOLIBRE_LIVE_RELAY_FILE"

#: Paths authenticated with the relay token instead of the sidecar token.
RELAY_CLIENT_PATHS = frozenset({"/relay/command", "/relay/status"})

_RELAY_TOKEN = secrets.token_urlsafe(32)

router = APIRouter(prefix="/relay", tags=["relay"])


class _Hub:
    """Open app sockets and the correlated requests waiting on them."""

    def __init__(self) -> None:
        self.listeners: list[WebSocket] = []
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.pending_request_ids: set[str] = set()

    async def broadcast(self, message: dict[str, Any]) -> int:
        """Send ``message`` to every app socket and count the ones it reached."""
        encoded = json.dumps(message)
        delivered = 0
        for socket in list(self.listeners):
            try:
                await socket.send_text(encoded)
            except Exception:  # noqa: BLE001 - a dead peer must not fail the request
                self.drop(socket)
                continue
            delivered += 1
        return delivered

    def drop(self, socket: WebSocket) -> None:
        """Unregister a socket, tolerating one that is already gone."""
        if socket in self.listeners:
            self.listeners.remove(socket)

    def resolve(self, raw: str) -> None:
        """Hand an app result frame to the request waiting for it."""
        try:
            result = normalize_result(json.loads(raw))
        except (ValueError, json.JSONDecodeError):
            return
        future = self.pending.get(result["requestId"])
        if future is not None and not future.done():
            future.set_result(result)


_hub = _Hub()


def relay_enabled() -> bool:
    """Return whether this sidecar serves the Live MCP relay.

    Returns:
        True when ``GEOLIBRE_LIVE_RELAY_PORT`` names a port and multi-tenant mode
        is off.
    """
    return _configured_port() is not None and not is_multi_tenant_enabled()


def relay_token() -> str:
    """Return this process's relay token (the client-side credential)."""
    return _RELAY_TOKEN


def discovery_file() -> Path:
    """Return where the relay advertises itself to Live MCP clients.

    Returns:
        ``GEOLIBRE_LIVE_RELAY_FILE`` when set, else
        ``~/.geolibre/runtime/live-relay.json``. ``geolibre.mcp.live`` reads the
        same location.
    """
    override = os.environ.get(DISCOVERY_FILE_ENV, "").strip()
    if override:
        return Path(override)
    return Path.home() / ".geolibre" / "runtime" / "live-relay.json"


def write_discovery_file() -> Path | None:
    """Advertise the relay URL, token, and pid to local Live MCP clients.

    The file is created with owner-only permissions before the token is written,
    and replaced atomically so a reader never sees a half-written file.

    Returns:
        The path written, or None when the relay is disabled or the file could
        not be written (the relay still works through ``GEOLIBRE_RELAY_URL``).
    """
    port = _configured_port()
    if port is None or not relay_enabled():
        return None
    target = discovery_file()
    payload = {
        "kind": "sidecar",
        "url": f"http://127.0.0.1:{port}/relay",
        "token": _RELAY_TOKEN,
        "pid": os.getpid(),
    }
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(target.parent, 0o700)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(temporary, target)
    except OSError:
        with contextlib.suppress(OSError):
            temporary.unlink()
        return None
    return target


def remove_discovery_file() -> None:
    """Delete the discovery file if this process wrote it.

    Another sidecar may have replaced the file since; its pid is left alone.
    """
    target = discovery_file()
    try:
        info = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return
    if isinstance(info, dict) and info.get("pid") == os.getpid():
        with contextlib.suppress(OSError):
            target.unlink()


def check_client_token(request: Request) -> None:
    """Require the relay token on a client-side request.

    Accepts ``Authorization: token <t>`` (what the Jupyter relay clients send),
    ``Authorization: Bearer <t>``, or ``X-GeoLibre-Relay-Token: <t>``.

    Args:
        request: The incoming request.

    Raises:
        HTTPException: 404 when the relay is disabled, 401 on a bad token.
    """
    if not relay_enabled():
        raise HTTPException(status_code=404, detail="Live relay is not enabled")
    provided = request.headers.get("x-geolibre-relay-token", "")
    if not provided:
        scheme, _, value = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() in {"token", "bearer"}:
            provided = value.strip()
    if not hmac.compare_digest(provided.encode("utf-8"), _RELAY_TOKEN.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Missing or invalid relay token")


@router.websocket("/socket")
async def relay_socket(websocket: WebSocket) -> None:
    """Subscribe one app window to relayed commands."""
    # Imported here: main imports this module, so a module-level import would
    # be circular.
    from .main import SIDECAR_TOKEN

    if not relay_enabled() or not is_allowed_origin(websocket.headers.get("origin")):
        await websocket.close(code=1008)
        return
    provided = websocket.query_params.get("token", "")
    if SIDECAR_TOKEN and not hmac.compare_digest(
        provided.encode("utf-8"), SIDECAR_TOKEN.encode("utf-8")
    ):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    _hub.listeners.append(websocket)
    try:
        await websocket.send_text(json.dumps({"type": "geolibre:relay-ready"}))
        while True:
            _hub.resolve(await websocket.receive_text())
    except WebSocketDisconnect:
        pass
    finally:
        _hub.drop(websocket)


@router.post("/command")
async def relay_command(request: Request) -> dict[str, Any]:
    """Relay one command to every app window, waiting for a correlated result."""
    check_client_token(request)
    try:
        payload = json.loads(await request.body() or b"{}")
        message = normalize_command(payload)
    except (ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    request_id = message["requestId"]
    if not request_id:
        return {"delivered": await _hub.broadcast(message)}
    if request_id in _hub.pending_request_ids:
        raise HTTPException(status_code=409, detail="Duplicate requestId.")

    timeout = result_timeout_seconds(message["method"], payload.get("timeoutSeconds"))
    dispatch_id = uuid4().hex
    message["requestId"] = dispatch_id
    future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
    _hub.pending_request_ids.add(request_id)
    _hub.pending[dispatch_id] = future
    try:
        delivered = await _hub.broadcast(message)
        if delivered == 0:
            return {"delivered": 0}
        try:
            result = await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError as error:
            raise HTTPException(
                status_code=504, detail="GeoLibre did not return a result in time."
            ) from error
        result["requestId"] = request_id
        return {"delivered": delivered, **result}
    finally:
        _hub.pending.pop(dispatch_id, None)
        _hub.pending_request_ids.discard(request_id)


@router.get("/status")
async def relay_status(request: Request) -> dict[str, int]:
    """Report how many app windows are subscribed."""
    check_client_token(request)
    return {"listeners": len(_hub.listeners)}


def _configured_port() -> int | None:
    raw = os.environ.get(PORT_ENV, "").strip()
    if not raw.isdigit():
        return None
    port = int(raw)
    return port if 0 < port < 65536 else None
