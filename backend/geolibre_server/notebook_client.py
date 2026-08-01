"""``geolibre`` — drive the host GeoLibre map from a notebook cell.

This module is made importable inside GeoLibre's **Notebook panel** (both the
in-browser JupyterLite kernel on web and the JupyterLab server on desktop), and
in any kernel of the desktop app's Jupyter server — including one driven from an
external client such as VS Code's Jupyter extension. It is the kernel side of the
notebook scripting bridge: it forwards commands to the running GeoLibre app.

Scope: this client speaks GeoLibre's **scripting bridge** (the same
``createScriptingHandlers`` surface used by the in-app Python console). That is a
focused map-control API — camera, layers, styling, GeoJSON, processing — and is
intentionally a smaller surface than the full ``geolibre`` PyPI widget (which
mutates a whole project model and renders its own app). Marker/choropleth helpers
here build GeoJSON and add it through the same layer command, so no extra bridge
commands are needed.

Mutation calls are fire-and-forget except ``add_geojson`` on desktop, which uses
the relay's correlated request/reply path to return the new layer id. The same
path powers ``list_layers`` and ``get_layer`` against the live map. JupyterLite
continues to use browser ``postMessage`` without a comm dependency; synchronous
read-back is unavailable there because blocking the Python call would also block
the browser event loop that has to deliver its result.

Two transports carry those commands, picked per call:

1. **The relay** (``geolibre_server/jupyter_relay.py``), when the kernel belongs
   to a GeoLibre desktop Jupyter server. Commands are POSTed to a loopback
   endpoint the app subscribes to, so they arrive no matter which *frontend* is
   driving the kernel — the Notebook panel, or an external client such as VS
   Code's Jupyter extension (issue #1442).
2. **``display(Javascript(...))`` → ``window.parent.postMessage``**, the fallback.
   This only reaches the map when the notebook is rendered inside the app's own
   iframe, which is exactly the case on web (JupyterLite).

When neither can deliver, the call emits a :class:`GeoLibreNotConnectedWarning`
rather than doing nothing at all. Turn it into an error with::

    import warnings, geolibre
    warnings.simplefilter("error", geolibre.GeoLibreNotConnectedWarning)

Usage::

    import geolibre

    m = geolibre.connect()
    m.fly_to(-122.4, 37.8, zoom=11)
    layer_id = m.add_geojson(gdf, name="My layer")  # returns an id on desktop
    m.get_layer(layer_id)
    m.add_markers([(-122.4, 37.8), (-73.9, 40.7)], name="Cities")

Canonical source: ``backend/geolibre_server/notebook_client.py``. The web build
copies it into the JupyterLite contents (see ``scripts/build-jupyterlite.mjs``)
and the desktop launcher copies it onto the kernel's import path
(``src-tauri/src/lib.rs``); keep those copies in sync with this file.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid
import warnings
from collections.abc import Iterable, Sequence
from typing import Any

from IPython.display import Javascript, display

__all__ = [
    "GeoLibreNotConnectedWarning",
    "HostMap",
    "Map",
    "connect",
    "is_connected",
]

# Published by the relay extension into the Jupyter server's environment, which
# every kernel it spawns inherits. See geolibre_server/jupyter_relay.py.
_RELAY_URL_ENV = "GEOLIBRE_RELAY_URL"
_RELAY_TOKEN_ENV = "GEOLIBRE_RELAY_TOKEN"

# Loopback round-trip to the local app. Short: a hung relay must not stall a
# notebook, and the caller only loses a fire-and-forget command.
#
# Read-back calls wait one second longer than this (see _request_from_relay), so
# they stay above the relay's own RESULT_TIMEOUT_SECONDS (5.0, in
# geolibre_server/jupyter_relay.py) and surface its precise 504 rather than
# timing out here first. Keep the two in step if either moves.
_RELAY_TIMEOUT_SECONDS = 5.0

_NOT_CONNECTED_HINT = (
    "The command was not delivered to a GeoLibre map. Open GeoLibre Desktop and "
    "its Notebook panel (Processing -> Jupyter Notebook) so the app is running "
    "and connected to this Jupyter server, then run the cell again."
)


class GeoLibreNotConnectedWarning(UserWarning):
    """Warned when a map command could not be delivered to a GeoLibre window."""


def _relay_url() -> str | None:
    """Return the relay base URL for this kernel, or None when there is none."""
    url = os.environ.get(_RELAY_URL_ENV, "").strip()
    return url.rstrip("/") or None


def _is_browser_kernel() -> bool:
    """Whether this kernel runs in the browser (JupyterLite / Pyodide).

    There the notebook page is itself the app's iframe, so the ``postMessage``
    transport is the right (and only) one, and a missing relay is expected.
    """
    return sys.platform == "emscripten"


def _post_to_relay(url: str, message: dict[str, Any]) -> tuple[int, str | None]:
    """POST one command to the relay.

    Args:
        url: The relay base URL (no trailing slash).
        message: The command envelope to deliver.

    Returns:
        ``(delivered, error)`` — how many app windows received the command, and a
        human-readable reason when the relay itself could not be reached.
    """
    request = _relay_request(url, message)
    try:
        with urllib.request.urlopen(  # noqa: S310 - see above
            request, timeout=_RELAY_TIMEOUT_SECONDS
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as error:
        return 0, _relay_failure_reason(error)
    delivered = payload.get("delivered")
    return (delivered if isinstance(delivered, int) else 0), None


def _relay_failure_reason(error: Exception) -> str:
    """Describe a failed relay call, in the terms that actually apply.

    An :class:`urllib.error.HTTPError` means the relay *was* reached and answered
    with an error status (400 for a malformed command, 409 for a duplicate
    request id, 504 when the app did not return a result in time); saying it
    "could not be reached" would send a reader looking in the wrong place.
    """
    if isinstance(error, urllib.error.HTTPError):
        return f"the local GeoLibre relay returned HTTP {error.code} ({_http_error_detail(error)})"
    return f"the local GeoLibre relay could not be reached ({error})"


def _http_error_detail(error: urllib.error.HTTPError) -> str:
    """Best-effort human message from a relay error response."""
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except (OSError, ValueError):
        payload = None
    if isinstance(payload, dict):
        message = payload.get("message") or payload.get("reason")
        if isinstance(message, str) and message:
            return message
    return str(error.reason or error)


def _relay_request(url: str, message: dict[str, Any]) -> urllib.request.Request:
    """Build an authenticated command request for the loopback relay."""
    headers = {"Content-Type": "application/json"}
    token = os.environ.get(_RELAY_TOKEN_ENV, "").strip()
    if token:
        headers["Authorization"] = f"token {token}"
    return urllib.request.Request(  # noqa: S310 - fixed http:// loopback URL
        f"{url}/command",
        data=json.dumps(message).encode("utf-8"),
        headers=headers,
        method="POST",
    )


def _request_from_relay(url: str, method: str, params: dict[str, Any] | None = None) -> Any:
    """Run one scripting command and return its correlated result."""
    message = {
        "type": "geolibre:command",
        "requestId": uuid.uuid4().hex,
        "method": method,
        "params": params or {},
    }
    request = _relay_request(url, message)
    try:
        with urllib.request.urlopen(  # noqa: S310 - see above
            request, timeout=_RELAY_TIMEOUT_SECONDS + 1
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise RuntimeError(f"GeoLibre read-back failed: {_relay_failure_reason(error)}") from error
    if not payload.get("delivered"):
        raise RuntimeError(f"No GeoLibre window is connected. {_NOT_CONNECTED_HINT}")
    if not payload.get("ok"):
        raise RuntimeError(str(payload.get("error") or "GeoLibre command failed."))
    return payload.get("value")


def _request(method: str, params: dict[str, Any] | None = None) -> Any:
    """Run a read-back command through the desktop relay."""
    url = _relay_url()
    if url is None:
        raise RuntimeError(
            "GeoLibre read-back requires the desktop Notebook server relay. "
            "It is not available in this kernel."
        )
    return _request_from_relay(url, method, params)


def _post_message_via_display(message: dict[str, Any]) -> None:
    """Emit the ``window.parent.postMessage`` transport as a display output.

    The notebook document is an iframe inside the app, so ``window.parent`` is
    the app. Inert in a frontend that does not execute JavaScript output (which
    is why the relay is tried first).
    """
    # json.dumps leaves "<" and ">" unescaped; escape them so a value containing
    # "</script>" (e.g. a layer name) can't break out of the <script> block that
    # IPython's Javascript() display wraps this code in. The \uXXXX escapes are
    # valid JSON and decode back to the same characters in the browser.
    payload = json.dumps(message).replace("<", "\\u003c").replace(">", "\\u003e")
    # Target the embedding host's origin rather than "*" so the command payload
    # isn't broadcast to an arbitrary parent; fall back to "*" when the referrer
    # is unavailable (e.g. a strict referrer policy).
    display(
        Javascript(
            "if (window.parent && window.parent !== window) {"
            "  var target = document.referrer"
            "    ? new URL(document.referrer).origin"
            "    : '*';"
            f"  window.parent.postMessage({payload}, target);"
            "}"
        )
    )


def is_connected() -> bool:
    """Whether a GeoLibre window is currently listening for map commands.

    Only the relay transport can answer this. On the in-browser kernel
    (JupyterLite) commands travel through the notebook's own iframe and there is
    nothing to ask, so this reports True.

    Returns:
        True when at least one GeoLibre window would receive a command now.
    """
    url = _relay_url()
    if url is None:
        return _is_browser_kernel()
    headers = {}
    token = os.environ.get(_RELAY_TOKEN_ENV, "").strip()
    if token:
        headers["Authorization"] = f"token {token}"
    request = urllib.request.Request(  # noqa: S310 - fixed http:// loopback URL
        f"{url}/status", headers=headers
    )
    try:
        with urllib.request.urlopen(  # noqa: S310 - see above
            request, timeout=_RELAY_TIMEOUT_SECONDS
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return False
    return bool(payload.get("listeners"))


def _send(method: str, params: dict[str, Any] | None = None) -> None:
    """Post one scripting command to the host GeoLibre app.

    Prefers the relay (works from any Jupyter frontend, and reports delivery);
    falls back to the ``postMessage`` display transport (the embedded panel and
    JupyterLite). An empty ``requestId`` marks a fire-and-forget call (the host
    still replies; we just don't await it).

    Warns with :class:`GeoLibreNotConnectedWarning` when the command provably did
    not reach a map, so a disconnected setup never looks like a silent success.
    """
    message = {
        "type": "geolibre:command",
        "requestId": "",
        "method": method,
        "params": params or {},
    }
    url = _relay_url()
    if url is not None:
        delivered, error = _post_to_relay(url, message)
        if delivered:
            return
        # Last-ditch: an app old enough to lack the relay socket still listens on
        # postMessage, and this notebook may be embedded in its Notebook panel.
        _post_message_via_display(message)
        reason = error or "no GeoLibre window is connected to this Jupyter server"
        # stacklevel=3: HostMap method -> _send -> the user's cell, so the warning
        # points at their code (and repeats in each new cell rather than once).
        warnings.warn(
            f"GeoLibre: {reason}. {_NOT_CONNECTED_HINT}",
            GeoLibreNotConnectedWarning,
            stacklevel=3,
        )
        return

    _post_message_via_display(message)
    if not _is_browser_kernel():
        warnings.warn(
            "GeoLibre: this kernel is not running on a GeoLibre Jupyter server, "
            "so map commands can only be delivered when the notebook is rendered "
            f"inside the app's Notebook panel. {_NOT_CONNECTED_HINT}",
            GeoLibreNotConnectedWarning,
            stacklevel=3,
        )


def _to_featurecollection(data: Any) -> dict[str, Any]:
    """Coerce GeoJSON-ish input into a FeatureCollection dict.

    Accepts a FeatureCollection/Feature/geometry dict, a JSON string, or any
    object exposing ``__geo_interface__`` (e.g. a GeoDataFrame or shapely
    geometry).
    """
    if isinstance(data, str):
        data = json.loads(data)
    if hasattr(data, "__geo_interface__"):
        data = data.__geo_interface__
    if not isinstance(data, dict):
        raise TypeError(
            "Expected GeoJSON: a dict, a JSON string, or an object with "
            "__geo_interface__ (e.g. a GeoDataFrame)."
        )
    kind = data.get("type")
    if kind == "FeatureCollection":
        return data
    if kind == "Feature":
        return {"type": "FeatureCollection", "features": [data]}
    # A bare geometry → wrap it as a single feature.
    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": data}],
    }


def _point_feature(lng: float, lat: float, properties: dict | None = None) -> dict:
    return {
        "type": "Feature",
        "properties": dict(properties or {}),
        "geometry": {"type": "Point", "coordinates": [float(lng), float(lat)]},
    }


def _points_to_featurecollection(points: Iterable[Any]) -> dict[str, Any]:
    """Build a Point FeatureCollection from an iterable of points.

    Each point may be a ``(lng, lat)`` pair/sequence or a mapping with ``lng``/
    ``lat`` (or ``lon``/``longitude``/``latitude``) keys; any extra mapping keys
    become feature properties.
    """
    features: list[dict] = []
    for point in points:
        if isinstance(point, dict):
            lng = point.get("lng", point.get("lon", point.get("longitude")))
            lat = point.get("lat", point.get("latitude"))
            if lng is None or lat is None:
                raise ValueError("Point dict needs lng/lat (or lon/longitude, latitude).")
            props = {
                k: v
                for k, v in point.items()
                if k not in {"lng", "lon", "longitude", "lat", "latitude"}
            }
            features.append(_point_feature(lng, lat, props))
        else:
            lng, lat = point[0], point[1]
            features.append(_point_feature(lng, lat))
    return {"type": "FeatureCollection", "features": features}


class HostMap:
    """A handle to the live map in the surrounding GeoLibre app."""

    def __repr__(self) -> str:
        return "<GeoLibre map (commands are sent to the live app)>"

    # -- camera ---------------------------------------------------------------

    def fly_to(
        self,
        lng: float | None = None,
        lat: float | None = None,
        *,
        zoom: float | None = None,
        bearing: float | None = None,
        pitch: float | None = None,
        duration: float | None = None,
    ) -> None:
        """Animate the camera. Only the fields you pass change."""
        params: dict[str, Any] = {}
        if lng is not None and lat is not None:
            params["center"] = [float(lng), float(lat)]
        if zoom is not None:
            params["zoom"] = float(zoom)
        if bearing is not None:
            params["bearing"] = float(bearing)
        if pitch is not None:
            params["pitch"] = float(pitch)
        if duration is not None:
            params["duration"] = float(duration)
        _send("flyTo", params)

    def set_view(self, lng: float, lat: float, *, zoom: float | None = None) -> None:
        """Jump the camera to ``(lng, lat)`` (and optional ``zoom``)."""
        params: dict[str, Any] = {"center": [float(lng), float(lat)]}
        if zoom is not None:
            params["zoom"] = float(zoom)
        _send("setView", params)

    def fit_bounds(self, bounds: Sequence[float]) -> None:
        """Fit the camera to ``[west, south, east, north]``."""
        _send("fitBounds", {"bounds": [float(b) for b in bounds]})

    def zoom_to_layer(self, layer_id: str) -> None:
        """Fit the camera to a layer's extent."""
        _send("zoomToLayer", {"layerId": layer_id})

    # -- basemap --------------------------------------------------------------

    def set_basemap(self, url: str) -> None:
        """Switch the basemap to a style URL (http(s) or root-relative)."""
        _send("setBasemap", {"url": url})

    # -- layers ---------------------------------------------------------------

    def list_layers(self) -> list[dict[str, Any]]:
        """Return live layer metadata in draw order."""
        value = _request("listLayers")
        if not isinstance(value, list):
            # A successful reply that is not a list means the app's handler is
            # broken; returning [] would read as "the map has no layers".
            raise RuntimeError(f"GeoLibre returned an unexpected layer list: {value!r}")
        return value

    def get_layer(self, layer_id: str) -> dict[str, Any]:
        """Return live metadata for one layer id (raises if absent)."""
        for layer in self.list_layers():
            if layer.get("id") == layer_id:
                return layer
        raise ValueError(f"No layer with id {layer_id!r}")

    def add_geojson(self, data: Any, name: str = "GeoJSON", **style: Any) -> str | None:
        """Add a GeoJSON layer.

        Args:
            data: A FeatureCollection/Feature/geometry dict, a JSON string, or
                any object with ``__geo_interface__`` (e.g. a GeoDataFrame).
            name: Layer display name.
            **style: Style overrides applied when the layer is created (e.g.
                ``fillColor="#facc15"`` or ``strokeColor="#d97706"``).
        """
        params = {
            "name": name,
            "geojson": _to_featurecollection(data),
            "style": dict(style),
        }
        # Desktop kernels have a correlated request/reply relay, so return the
        # new layer id. JupyterLite retains its display/postMessage transport,
        # where a synchronous Python call cannot wait on the browser event loop.
        if _relay_url() is not None:
            value = _request("addGeoJsonLayer", params)
            if not isinstance(value, str) or not value:
                # Fail loudly rather than handing back an id ("None") that no
                # later set_style/remove_layer call could ever resolve.
                raise RuntimeError(f"GeoLibre returned an unexpected layer id: {value!r}")
            return value
        _send("addGeoJsonLayer", params)
        return None

    def add_marker(
        self, lng: float, lat: float, *, name: str = "Marker", **properties: Any
    ) -> None:
        """Add a single point marker (extra kwargs become feature properties)."""
        fc = {
            "type": "FeatureCollection",
            "features": [_point_feature(lng, lat, properties)],
        }
        _send("addGeoJsonLayer", {"name": name, "geojson": fc})

    def add_markers(self, points: Iterable[Any], *, name: str = "Markers") -> None:
        """Add many point markers from ``(lng, lat)`` pairs or point mappings."""
        _send(
            "addGeoJsonLayer",
            {"name": name, "geojson": _points_to_featurecollection(points)},
        )

    # add_circle_markers is an alias today; kept for parity with the geolibre
    # package's vocabulary.
    add_circle_markers = add_markers

    def remove_layer(self, layer_id: str) -> None:
        """Remove a layer by id."""
        _send("removeLayer", {"layerId": layer_id})

    def set_visibility(self, layer_id: str, visible: bool) -> None:
        """Show or hide a layer by id."""
        _send("setVisibility", {"layerId": layer_id, "visible": bool(visible)})

    def set_opacity(self, layer_id: str, opacity: float) -> None:
        """Set a layer's opacity in ``[0, 1]``."""
        _send("setOpacity", {"layerId": layer_id, "opacity": float(opacity)})

    def set_style(self, layer_id: str, **style: Any) -> None:
        """Update a layer's style (e.g. ``fillColor='#ff0000'``)."""
        _send("setStyle", {"layerId": layer_id, "style": dict(style)})

    # -- processing -----------------------------------------------------------

    def run_algorithm(self, algorithm_id: str, **params: Any) -> None:
        """Run a client-side processing algorithm by id.

        Result layers are added to the map. (Fire-and-forget, so the returned
        logs/result-layer ids are not available here.)
        """
        _send("runAlgorithm", {"id": algorithm_id, "params": dict(params)})


def connect() -> HostMap:
    """Return a handle to the live map in the surrounding GeoLibre app.

    Warns with :class:`GeoLibreNotConnectedWarning` when no GeoLibre window is
    listening, so a misconfigured session says so up front instead of at the
    first command that quietly goes nowhere.
    """
    if _relay_url() is not None and not is_connected():
        warnings.warn(
            f"GeoLibre: no GeoLibre window is connected to this Jupyter server. "
            f"{_NOT_CONNECTED_HINT}",
            GeoLibreNotConnectedWarning,
            stacklevel=2,
        )
    return HostMap()


# ``geolibre.Map()`` is accepted as an alias for ``geolibre.connect()``.
Map = HostMap
