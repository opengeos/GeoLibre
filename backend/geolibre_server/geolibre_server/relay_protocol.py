"""Wire protocol of the GeoLibre map-command relays.

The Jupyter Server extension (``jupyter_relay.py``) carries scripting commands
from a kernel to the open app window over a WebSocket and returns correlated
results. The desktop shell's Live MCP relay (``src-tauri/src/live_relay.rs``)
speaks the same command and result envelopes and mirrors the per-method result
budgets below, which ``python/tests/test_mcp_live.py`` compares across all
three implementations. The helpers here have no Jupyter dependency.
"""

from __future__ import annotations

import math
from typing import Any
from urllib.parse import urlparse

__all__ = [
    "COMMAND_TYPE",
    "DEFAULT_RESULT_TIMEOUT_SECONDS",
    "MAX_RESULT_TIMEOUT_SECONDS",
    "METHOD_RESULT_TIMEOUT_SECONDS",
    "MIN_RESULT_TIMEOUT_SECONDS",
    "RESULT_TYPE",
    "is_allowed_origin",
    "normalize_command",
    "normalize_result",
    "result_timeout_seconds",
]

#: Message envelope the scripting bridge speaks, shared with the postMessage
#: transport (``useNotebookBridge``) so the app dispatches both identically.
COMMAND_TYPE = "geolibre:command"

#: Envelope of the app's reply to a correlated command.
RESULT_TYPE = "geolibre:result"

#: How long a correlated command waits for the app's result when neither the
#: caller nor :data:`METHOD_RESULT_TIMEOUT_SECONDS` says otherwise. View and
#: layer-list commands answer in milliseconds; a short wait keeps a hung window
#: from stalling a notebook cell.
DEFAULT_RESULT_TIMEOUT_SECONDS = 5.0

#: Bounds a caller-requested ``timeoutSeconds`` is clamped to.
MIN_RESULT_TIMEOUT_SECONDS = 0.5
MAX_RESULT_TIMEOUT_SECONDS = 4 * 60 * 60.0

#: Default result waits for commands that do real work in the app. Processing
#: runs Turf.js, DuckDB-WASM, or Whitebox WASM in the webview and can take
#: minutes on a real dataset; a 5 second wait reported those as failures while
#: they were still running.
METHOD_RESULT_TIMEOUT_SECONDS: dict[str, float] = {
    "runAlgorithm": 30 * 60.0,
    "runWhiteboxTool": 30 * 60.0,
    "runModelBuilder": 60 * 60.0,
    "addRasterBytes": 120.0,
    "addGeoJsonLayer": 60.0,
    "getLayerFeatures": 60.0,
    "toImage": 60.0,
}

# Origins allowed to open a relay WebSocket: the Tauri webview (tauri:// on
# macOS/Linux, http://tauri.localhost on Windows, or https:// there if
# useHttpsScheme is ever turned on) and any loopback dev origin. Matching is on
# host and scheme separately, so both Windows schemes are already covered.
_ALLOWED_ORIGIN_HOSTS = frozenset({"localhost", "127.0.0.1", "tauri.localhost"})
_ALLOWED_ORIGIN_SCHEMES = frozenset({"http", "https", "tauri"})


def is_allowed_origin(origin: str | None) -> bool:
    """Return whether ``origin`` may open a relay WebSocket.

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
    try:
        parsed = urlparse(origin)
        if parsed.scheme not in _ALLOWED_ORIGIN_SCHEMES:
            return False
        return (parsed.hostname or "") in _ALLOWED_ORIGIN_HOSTS
    except ValueError:
        return False


def result_timeout_seconds(method: str, requested: Any = None) -> float:
    """Return how long a correlated command waits for the app's result.

    Args:
        method: The scripting method name, used to pick a per-method default.
        requested: The caller's ``timeoutSeconds``, if any. A finite positive
            number overrides the default and is clamped to
            [:data:`MIN_RESULT_TIMEOUT_SECONDS`, :data:`MAX_RESULT_TIMEOUT_SECONDS`].
            Anything else is ignored.

    Returns:
        The wait in seconds.
    """
    if (
        isinstance(requested, (int, float))
        and not isinstance(requested, bool)
        and (not isinstance(requested, float) or math.isfinite(requested))
        and requested > 0
    ):
        return float(min(max(requested, MIN_RESULT_TIMEOUT_SECONDS), MAX_RESULT_TIMEOUT_SECONDS))
    return METHOD_RESULT_TIMEOUT_SECONDS.get(method, DEFAULT_RESULT_TIMEOUT_SECONDS)


def normalize_command(payload: Any) -> dict[str, Any]:
    """Validate a posted command and return the envelope to broadcast.

    Args:
        payload: The decoded JSON request body.

    Returns:
        A ``{"type", "requestId", "method", "params"}`` envelope. A caller's
        ``timeoutSeconds`` is not forwarded to the app; use
        :func:`result_timeout_seconds` on the original payload instead.

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


def normalize_result(payload: Any) -> dict[str, Any]:
    """Validate an app-side scripting result sent over a relay socket.

    Args:
        payload: The decoded JSON frame the app sent.

    Returns:
        ``{"requestId", "ok", "value"}`` on success or
        ``{"requestId", "ok", "error"}`` on failure.

    Raises:
        ValueError: If the frame is not a well-formed result.
    """
    if not isinstance(payload, dict) or payload.get("type") != RESULT_TYPE:
        raise ValueError("Expected a GeoLibre result object.")
    request_id = payload.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("Missing a non-empty 'requestId'.")
    ok = payload.get("ok")
    if not isinstance(ok, bool):
        raise ValueError("Missing boolean 'ok'.")
    result: dict[str, Any] = {
        "requestId": request_id,
        "ok": ok,
    }
    if ok:
        result["value"] = payload.get("value")
    else:
        result["error"] = str(payload.get("error") or "GeoLibre command failed.")
    return result
