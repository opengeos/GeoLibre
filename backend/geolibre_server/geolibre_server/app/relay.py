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
    in ``Sec-WebSocket-Protocol`` (outside access-logged URL paths), and
    restricted to the app's origins.
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

The relay is off until the desktop applies an explicit opt-in through the
sidecar-authenticated ``POST /relay/access`` endpoint. It also requires
``GEOLIBRE_LIVE_RELAY_PORT`` (set by the desktop shell) and multi-tenant mode off: a shared
server must never broadcast one user's commands to another user's window.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import os
import secrets
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import unquote
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

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
SEND_TIMEOUT_SECONDS = 1.0
MAX_SEND_TIMEOUT_SECONDS = 30.0
SEND_BYTES_PER_SECOND = 1024 * 1024
_access_allowed = False
_access_generation = 0

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/relay", tags=["relay"])


class _Hub:
    """Open app sockets and the correlated requests waiting on them."""

    def __init__(self) -> None:
        self.listeners: list[WebSocket] = []
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.pending_request_ids: set[str] = set()
        self.recipients: dict[str, set[WebSocket]] = {}
        self.access_lock = asyncio.Lock()

    async def broadcast(self, message: dict[str, Any], delivered: list[int] | None = None) -> int:
        """Send concurrently, recording deliveries before the slowest peer finishes.

        Args:
            message: The command to broadcast.
            delivered: Optional one-item counter shared with the result waiter.

        Returns:
            The number of windows reached.
        """
        encoded = json.dumps(message)
        # ASCII JSON has one byte per character. Large GeoJSON and base64
        # frames get a proportional transfer budget, still capped for stalls.
        send_timeout = min(
            MAX_SEND_TIMEOUT_SECONDS, SEND_TIMEOUT_SECONDS + len(encoded) / SEND_BYTES_PER_SECOND
        )
        delivered = delivered if delivered is not None else [0]
        sockets = list(self.listeners)
        request_id = message.get("requestId")
        if request_id in self.pending:
            self.recipients[request_id] = set(sockets)

        async def send(socket: WebSocket) -> int:
            """Deliver to one window within the socket send budget.

            Args:
                socket: The subscribed app window.

            Returns:
                One on delivery, or zero after dropping a stalled or dead peer.
            """
            try:
                await asyncio.wait_for(socket.send_text(encoded), send_timeout)
            except (Exception, asyncio.CancelledError) as error:
                # Cancellation can interrupt an ASGI frame write after bytes
                # were accepted. Deliberately close that uncertain connection
                # and let the app reconnect instead of reusing a partial write.
                # Peers whose sends already completed remain subscribed.
                self.drop(socket)
                # Trigger the desktop's onclose/reconnect path. Close attempts
                # run concurrently and cannot extend cleanup indefinitely.
                with contextlib.suppress(Exception, asyncio.CancelledError):
                    await asyncio.wait_for(socket.close(code=1013), 0.1)
                if isinstance(error, asyncio.CancelledError):
                    raise
                return 0
            delivered[0] += 1
            return 1

        return sum(await asyncio.gather(*(send(socket) for socket in sockets)))

    def drop(self, socket: WebSocket) -> None:
        """Unregister a socket, tolerating one that is already gone."""
        if socket in self.listeners:
            self.listeners.remove(socket)
        for request_id, recipients in self.recipients.items():
            if socket not in recipients:
                continue
            recipients.discard(socket)
            future = self.pending.get(request_id)
            if not recipients and future is not None and not future.done():
                future.set_result(
                    {
                        "ok": False,
                        "error": "GeoLibre disconnected before returning a result.",
                    }
                )

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
        True after explicit desktop opt-in when ``GEOLIBRE_LIVE_RELAY_PORT``
        names a port and multi-tenant mode is off.
    """
    return _access_allowed and _configured_port() is not None and not is_multi_tenant_enabled()


@router.post("/access")
async def set_relay_access(request: Request) -> dict[str, bool]:
    """Apply the desktop's explicit Live MCP access preference.

    Args:
        request: Sidecar-authenticated request containing an enabled boolean.

    Returns:
        Whether access is now enabled.

    Raises:
        HTTPException: On missing credentials, invalid input, or a shared server.
    """
    from .main import SIDECAR_TOKEN

    provided = request.headers.get("x-geolibre-token", "")
    if not SIDECAR_TOKEN or not hmac.compare_digest(provided.encode(), SIDECAR_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="Missing or invalid sidecar token")
    if _configured_port() is None or is_multi_tenant_enabled():
        raise HTTPException(status_code=404, detail="Live relay is not available")
    try:
        payload = await request.json()
    except (ValueError, UnicodeError) as error:
        raise HTTPException(status_code=400, detail="Expected an enabled boolean") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("enabled"), bool):
        raise HTTPException(status_code=400, detail="Expected an enabled boolean")
    global _access_allowed, _access_generation
    async with _hub.access_lock:
        _access_allowed = payload["enabled"]
        if _access_allowed:
            await run_in_threadpool(write_discovery_file)
        else:
            _access_generation += 1
            await run_in_threadpool(remove_discovery_file)
            for future in _hub.pending.values():
                if not future.done():
                    future.set_result({"ok": False, "error": "Live MCP access was disabled."})
            for socket in list(_hub.listeners):
                _hub.drop(socket)
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(socket.close(code=1008), SEND_TIMEOUT_SECONDS)
        return {"enabled": _access_allowed}


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


@contextlib.contextmanager
def _discovery_lock(target: Path) -> Iterator[None]:
    """Serialize discovery publication and conditional removal across processes.

    Args:
        target: The shared discovery file path.

    Yields:
        While this process holds the adjacent lock file. The lock file remains
        in place so all processes continue locking the same inode.
    """
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(str(target) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, "r+b") as handle:
        if os.name == "nt":
            import msvcrt

            if not handle.read(1):
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def write_discovery_file() -> Path | None:
    """Advertise the relay URL, token, and pid to local Live MCP clients.

    The file is created with owner-only permissions before the token is written,
    and replaced atomically so a reader never sees a half-written file.

    Returns:
        The path written, or None when the relay is disabled or the file could
        not be written. Failures are logged; the relay still works through
        explicit ``GEOLIBRE_RELAY_URL`` / ``GEOLIBRE_RELAY_TOKEN`` configuration.
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
    temporary: Path | None = None
    try:
        with _discovery_lock(target):
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=target.parent,
                prefix=f".{target.name}.",
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
                json.dump(payload, handle)
            os.replace(temporary, target)
    except OSError as error:
        logger.warning(
            "Could not publish Live MCP discovery file (%s); explicit "
            "GEOLIBRE_RELAY_URL/GEOLIBRE_RELAY_TOKEN configuration remains available",
            type(error).__name__,
        )
        if temporary is not None:
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
        if not target.exists():
            return
        with _discovery_lock(target):
            info = json.loads(target.read_text(encoding="utf-8"))
            if isinstance(info, dict) and info.get("pid") == os.getpid():
                target.unlink()
    except (OSError, UnicodeError, json.JSONDecodeError):
        return


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
    protocols = websocket.scope.get("subprotocols", [])
    provided = next(
        (
            unquote(value[len("geolibre-token.") :])
            for value in protocols
            if value.startswith("geolibre-token.")
        ),
        "",
    )
    if (
        "geolibre-relay" not in protocols
        or not SIDECAR_TOKEN
        or not hmac.compare_digest(provided.encode("utf-8"), SIDECAR_TOKEN.encode("utf-8"))
    ):
        await websocket.close(code=1008)
        return
    generation = _access_generation
    await websocket.accept(subprotocol="geolibre-relay")
    if not relay_enabled() or generation != _access_generation:
        await websocket.close(code=1008)
        return
    _hub.listeners.append(websocket)
    try:
        await websocket.send_text(json.dumps({"type": "geolibre:relay-ready"}))
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if isinstance(message.get("text"), str):
                _hub.resolve(message["text"])
            elif message.get("bytes") is not None:
                await websocket.close(code=1003)
                break
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

    async def wait_for_response() -> tuple[int, dict[str, Any] | None]:
        """Wait for delivery or the first app result without serializing them.

        Returns:
            The delivery count and result, or no result when no window was reached.
        """
        delivered = [0]
        broadcast = asyncio.create_task(_hub.broadcast(message, delivered))
        try:
            await asyncio.wait({future, broadcast}, return_when=asyncio.FIRST_COMPLETED)
            if future.done():
                return max(1, delivered[0]), future.result()
            reached = broadcast.result()
            if reached == 0:
                return 0, None
            return reached, await future
        finally:
            # A first result completes this request's best-effort delivery.
            # Do not delay it behind another window or detach request-owned
            # writes; cancelling a partial frame deliberately reconnects its peer.
            broadcast.cancel()
            await asyncio.gather(broadcast, return_exceptions=True)

    try:
        try:
            delivered, result = await asyncio.wait_for(wait_for_response(), timeout)
        except asyncio.TimeoutError as error:
            raise HTTPException(
                status_code=504, detail="GeoLibre did not return a result in time."
            ) from error
        if result is None:
            return {"delivered": delivered}
        result["requestId"] = request_id
        return {"delivered": delivered, **result}
    finally:
        _hub.pending.pop(dispatch_id, None)
        _hub.recipients.pop(dispatch_id, None)
        _hub.pending_request_ids.discard(request_id)
        if not future.done():
            future.cancel()


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
