"""GeoLibre in-app Python console API.

This module is loaded into a main-thread Pyodide runtime by the Python Console
panel. It defines ``geolibre`` — a synchronous facade that drives the *running*
GeoLibre app (its Zustand store + MapController) through the JS scripting handlers
registered as ``_geolibre_js``. Method names mirror the ``geolibre.Map`` notebook
API so the two surfaces feel identical.
"""

import base64

import _geolibre_js as _js
import js
from pyodide.ffi import to_js


def _to_py(value):
    """Convert a JS return value (often a proxy) into a native Python object."""
    to_py = getattr(value, "to_py", None)
    return to_py() if callable(to_py) else value


def _to_js(obj):
    """Convert a Python params dict (recursively) into a plain JS object."""
    return to_js(obj, dict_converter=js.Object.fromEntries)


def _coerce_featurecollection(data):
    """Coerce a dict / geometry / Feature / ``__geo_interface__`` to a FeatureCollection."""
    if hasattr(data, "__geo_interface__"):
        data = data.__geo_interface__
    if not isinstance(data, dict):
        raise TypeError(
            "add_geojson expects a GeoJSON dict or an object exposing "
            "__geo_interface__; use load_geojson(url) for a remote URL."
        )
    kind = data.get("type")
    if kind == "FeatureCollection":
        return data
    if kind == "Feature":
        return {"type": "FeatureCollection", "features": [data]}
    # Treat anything else as a bare geometry.
    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": data}],
    }


class Feature(dict):
    """A GeoJSON feature with convenience accessors (it is also a plain dict)."""

    @property
    def geometry(self):
        return self.get("geometry")

    @property
    def properties(self):
        return self.get("properties") or {}

    @property
    def id(self):
        return self.get("id")

    @property
    def __geo_interface__(self):
        return dict(self)


class Layer:
    """A handle to one layer on the running map."""

    def __init__(self, info):
        self._info = info
        self._id = info["id"]

    @property
    def id(self):
        return self._id

    @property
    def name(self):
        return self._info.get("name")

    @property
    def type(self):
        return self._info.get("type")

    @property
    def visible(self):
        return self._info.get("visible", True)

    @visible.setter
    def visible(self, value) -> None:
        next_visible = bool(value)
        _js.setVisibility(_to_js({"layerId": self._id, "visible": next_visible}))
        # Keep the cached info in sync so a later read on this handle is correct.
        self._info["visible"] = next_visible

    @property
    def opacity(self):
        return self._info.get("opacity", 1.0)

    @opacity.setter
    def opacity(self, value) -> None:
        next_opacity = float(value)
        _js.setOpacity(_to_js({"layerId": self._id, "opacity": next_opacity}))
        self._info["opacity"] = next_opacity

    def set_style(self, **style):
        """Merge style overrides into the layer (e.g. ``fillColor="#ff0000"``)."""
        _js.setStyle(_to_js({"layerId": self._id, "style": style}))

    def get_features(self):
        """Return this layer's features as :class:`Feature` objects."""
        raw = _to_py(_js.getLayerFeatures(_to_js({"layerId": self._id})))
        return [Feature(f) for f in raw or []]

    def zoom_to(self):
        """Fit the map camera to this layer's extent."""
        _js.zoomToLayer(_to_js({"layerId": self._id}))

    def remove(self):
        """Remove this layer from the map."""
        _js.removeLayer(_to_js({"layerId": self._id}))

    def __repr__(self):
        return f"Layer(id={self._id!r}, name={self.name!r}, type={self.type!r})"


class _GeoLibre:
    """The console's entry point, exposed to user code as ``geolibre``."""

    # -- view / camera --------------------------------------------------
    def get_view(self):
        """Return the live camera ``{center, zoom, bearing, pitch, bbox}``."""
        return _to_py(_js.getView())

    def get_center(self):
        """Return the live map center as ``[lng, lat]``."""
        return _to_py(_js.getCenter())

    def get_bounds(self):
        """Return the live viewport bounds as ``[west, south, east, north]``."""
        return _to_py(_js.getBounds())

    def fly_to(self, lng=None, lat=None, *, zoom=None, bearing=None, pitch=None, duration=None):
        """Animate the camera; only the provided fields change."""
        params = {}
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
        _js.flyTo(_to_js(params))

    def fit_bounds(self, bounds):
        """Fit the camera to ``[west, south, east, north]``."""
        _js.fitBounds(_to_js({"bounds": [float(b) for b in bounds]}))

    def set_basemap(self, url):
        """Set the basemap style URL."""
        _js.setBasemap(_to_js({"url": url}))

    # -- queries --------------------------------------------------------
    def identify(self, lng, lat, layer_id=None):
        """Query rendered features at a geographic point (like clicking it)."""
        params = {"lngLat": [float(lng), float(lat)]}
        if layer_id is not None:
            params["layerId"] = layer_id
        return _to_py(_js.identify(_to_js(params)))

    # -- layers ---------------------------------------------------------
    @property
    def layers(self):
        """The current layers as :class:`Layer` objects, in draw order."""
        return [Layer(info) for info in _to_py(_js.listLayers()) or []]

    def get_layer(self, layer_id):
        """Return the :class:`Layer` with ``layer_id`` (raises if absent)."""
        for layer in self.layers:
            if layer.id == layer_id:
                return layer
        raise ValueError(f"No layer with id {layer_id!r}")

    def add_geojson(self, data, name="GeoJSON"):
        """Add a GeoJSON layer from a dict / geometry / ``__geo_interface__``.

        Returns the new layer id. For a remote URL use :meth:`load_geojson`.
        """
        fc = _coerce_featurecollection(data)
        return _js.addGeoJsonLayer(_to_js({"name": name, "geojson": fc}))

    async def load_geojson(self, url, name="GeoJSON"):
        """Fetch a GeoJSON URL and add it as a layer (async). Returns the id."""
        from pyodide.http import pyfetch

        response = await pyfetch(url)
        # pyfetch resolves for 4xx/5xx too; surface a clear HTTP error instead of
        # trying to parse an error body as GeoJSON.
        if not response.ok:
            raise RuntimeError(f"Failed to fetch {url!r}: HTTP {response.status}")
        fc = _coerce_featurecollection(await response.json())
        return _js.addGeoJsonLayer(_to_js({"name": name, "geojson": fc}))

    def remove_layer(self, layer_id):
        """Remove a layer by id."""
        _js.removeLayer(_to_js({"layerId": layer_id}))

    # -- processing -----------------------------------------------------
    def list_algorithms(self):
        """List the available client-side processing algorithms."""
        return _to_py(_js.listAlgorithms())

    async def run_algorithm(self, algorithm_id, parameters=None):
        """Run a processing algorithm and add its result layers (async)."""
        result = await _js.runAlgorithm(_to_js({"id": algorithm_id, "params": parameters or {}}))
        return _to_py(result)

    # -- export / packages ---------------------------------------------
    def to_image(self):
        """Capture the current map view as PNG bytes.

        Matches the notebook ``Map.to_image()`` return type. Writing to a host
        file path is not available in the in-browser runtime, so this always
        returns the bytes; persist them yourself if needed.
        """
        data_url = str(_js.toImage())
        _, sep, encoded = data_url.partition(",")
        if not sep:
            raise ValueError(f"toImage returned an unexpected value: {data_url!r}")
        return base64.b64decode(encoded)

    async def load_package(self, name):
        """Load a Pyodide package on demand, e.g. ``await geolibre.load_package("numpy")``."""
        await _js.loadPackage(name)


geolibre = _GeoLibre()


def _geolibre_complete(source: str, end: int) -> str:
    """Return completion candidates for the console autocomplete.

    Introspects the live runtime namespace (the same globals user code runs in),
    so attribute access (``geolibre.``) lists real methods and bare names complete
    from globals, builtins, and keywords. Private (``_``-prefixed) names are hidden
    unless the prefix explicitly starts with ``_``.

    Args:
        source: The full editor text.
        end: The caret offset into ``source``.

    Returns:
        A JSON string ``{"prefix": str, "candidates": [str, ...]}`` — ``prefix``
        is the text being replaced; ``candidates`` is sorted and de-duplicated.
    """
    import builtins
    import json
    import keyword
    import re

    text = source[: max(0, end)]
    # The dotted identifier chain ending at the caret, e.g. "geolibre.fly_".
    match = re.search(r"[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\.?$", text)
    token = match.group(0) if match else ""
    if "." in token:
        base, _, prefix = token.rpartition(".")
    else:
        base, prefix = "", token

    ns = globals()

    def _visible(name: str) -> bool:
        if name.startswith("_") and not prefix.startswith("_"):
            return False
        return name.startswith(prefix)

    if base:
        try:
            obj = eval(base, ns)  # noqa: S307 - base is a parsed identifier chain
        except Exception:  # noqa: BLE001 - any eval failure yields no completions
            return json.dumps({"prefix": prefix, "candidates": []})
        names = dir(obj)
    else:
        names = list(ns.keys()) + dir(builtins) + keyword.kwlist

    candidates = sorted({name for name in names if _visible(name)})
    return json.dumps({"prefix": prefix, "candidates": candidates})
