"""``geolibre`` — drive the host GeoLibre map from a notebook cell.

This module is made importable inside GeoLibre's **Notebook panel** (both the
in-browser JupyterLite kernel on web and the JupyterLab server on desktop). It
is the kernel side of the notebook scripting bridge: it forwards commands to the
GeoLibre app that embeds this notebook (the parent window).

Scope: this client speaks GeoLibre's **scripting bridge** (the same
``createScriptingHandlers`` surface used by the in-app Python console). That is a
focused map-control API — camera, layers, styling, GeoJSON, processing — and is
intentionally a smaller surface than the full ``geolibre`` PyPI widget (which
mutates a whole project model and renders its own app). Marker/choropleth helpers
here build GeoJSON and add it through the same layer command, so no extra bridge
commands are needed.

It is **fire-and-forget**: each call posts a command and returns immediately
without waiting for a reply, so it behaves identically in JupyterLite (a
browser/WebAssembly kernel) and a real JupyterLab server, with no
``anywidget``/comm dependency. Consequently *read-back* queries (``get_view``,
``identify``, ``list_layers``, …) are not available here — they need the blocking
request/reply path the ``geolibre`` widget uses.

Usage::

    import geolibre

    m = geolibre.connect()
    m.fly_to(-122.4, 37.8, zoom=11)
    m.add_geojson(gdf, name="My layer")          # GeoDataFrame, dict, or JSON
    m.add_markers([(-122.4, 37.8), (-73.9, 40.7)], name="Cities")

Canonical source: ``backend/geolibre_server/notebook_client.py``. The web build
copies it into the JupyterLite contents (see ``scripts/build-jupyterlite.mjs``)
and the desktop launcher copies it onto the kernel's import path
(``src-tauri/src/lib.rs``); keep those copies in sync with this file.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Sequence

from IPython.display import Javascript, display

__all__ = ["HostMap", "Map", "connect"]


def _send(method: str, params: dict[str, Any] | None = None) -> None:
    """Post one scripting command up to the host GeoLibre app window.

    The notebook document is itself an iframe inside the app, so
    ``window.parent`` is the app. An empty ``requestId`` marks a fire-and-forget
    call (the host still replies; we just don't await it).
    """
    message = {
        "type": "geolibre:command",
        "requestId": "",
        "method": method,
        "params": params or {},
    }
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
        return "<GeoLibre map (live, connected to the app)>"

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

    def add_geojson(self, data: Any, name: str = "GeoJSON") -> None:
        """Add a GeoJSON layer.

        Args:
            data: A FeatureCollection/Feature/geometry dict, a JSON string, or
                any object with ``__geo_interface__`` (e.g. a GeoDataFrame).
            name: Layer display name.
        """
        _send(
            "addGeoJsonLayer",
            {"name": name, "geojson": _to_featurecollection(data)},
        )

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

    # add_circle_markers is an alias today (styling is applied via set_style or
    # the Style panel); kept for parity with the geolibre package's vocabulary.
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
    """Return a handle to the live map in the surrounding GeoLibre app."""
    return HostMap()


# ``geolibre.Map()`` is accepted as an alias for ``geolibre.connect()``.
Map = HostMap
