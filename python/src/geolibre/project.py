"""Builders for GeoLibre project (`.geolibre.json`) dicts and their layers.

The shapes here mirror the TypeScript interfaces in
``packages/core/src/types.ts`` and ``packages/core/src/project.ts``. Keeping the
Python builders faithful to those interfaces is what lets the embedded app load
a project produced entirely from Python.
"""

from __future__ import annotations

import copy
import ipaddress
import json
import socket
import uuid
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

from .basemaps import DEFAULT_BASEMAP

PROJECT_VERSION = "0.1.0"

# Cap GeoJSON inputs (URL fetches and local files alike) so a huge source cannot
# silently exhaust kernel memory when inlined into the project.
_MAX_GEOJSON_BYTES = 50 * 1024 * 1024  # 50 MB


def _assert_public_url(url: str) -> None:
    """Reject a URL whose host resolves to a non-public address.

    Guards the kernel-side fetch against SSRF: without this a redirect (or a
    crafted URL) could reach a private/loopback/link-local address such as a
    cloud metadata endpoint (``169.254.169.254``) and inline the response into
    the project. Every address the host resolves to must be globally routable.

    Args:
        url: The URL about to be fetched (or a redirect target).

    Raises:
        ValueError: If the host is missing, unresolvable, or maps to any
            non-public address.
    """
    host = urlsplit(url).hostname
    if not host:
        raise ValueError(f"URL has no host: {url}")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve host for URL: {url}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError(
                f"Refusing to fetch from a non-public address ({ip}): {url}"
            )


class _PublicOnlyRedirectHandler(HTTPRedirectHandler):
    """Redirect handler that re-validates every hop against ``_assert_public_url``."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        _assert_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# Opener used for all remote GeoJSON fetches: follows redirects but rejects any
# hop that points at a non-public address (SSRF defence).
_GEOJSON_OPENER = build_opener(_PublicOnlyRedirectHandler)

# Mirror of DEFAULT_LAYER_STYLE in packages/core/src/types.ts. The app fills in
# any missing fields on load, so layers only need to override what differs, but
# carrying the full default keeps round-tripped projects stable.
DEFAULT_LAYER_STYLE: dict[str, Any] = {
    "minZoom": 0,
    "maxZoom": 24,
    "fillColor": "#3b82f6",
    "strokeColor": "#1e40af",
    "strokeWidth": 2,
    "fillOpacity": 0.6,
    "circleRadius": 6,
    "textColor": "#111827",
    "textHaloColor": "#ffffff",
    "textHaloWidth": 2,
    "textSize": 16,
    "extrusionEnabled": False,
    "extrusionColor": "#3b82f6",
    "extrusionOpacity": 0.8,
    "extrusionHeightProperty": "height",
    "extrusionHeightScale": 1,
    "extrusionBase": 0,
    "extrusionAdvancedStyleEnabled": False,
    "extrusionColorExpression": "",
    "extrusionHeightExpression": "",
    "vectorStyleMode": "single",
    "vectorStyleProperty": "",
    "vectorStyleClassCount": 5,
    "vectorStyleColorRamp": "viridis",
    "vectorStyleClassificationScheme": "equal-interval",
    "vectorStyleStops": [
        {"value": 0, "color": "#dbeafe"},
        {"value": 1, "color": "#2563eb"},
    ],
    "vectorStyleExpression": "",
    "rasterBrightnessMin": 0,
    "rasterBrightnessMax": 1,
    "rasterSaturation": 0,
    "rasterContrast": 0,
    "rasterHueRotate": 0,
}

# Mirror of DEFAULT_PROJECT_PREFERENCES in packages/core/src/types.ts.
DEFAULT_PROJECT_PREFERENCES: dict[str, Any] = {
    "map": {
        "restrictBounds": False,
        "bounds": [-180, -85, 180, 85],
        "minZoom": 0,
        "maxZoom": 24,
        "maxPitch": 85,
        "renderWorldCopies": True,
    },
    "environmentVariables": [],
}


def default_map_view() -> dict[str, Any]:
    """Return the app's default camera (createDefaultMapView in project.ts)."""
    return {"center": [-100, 40], "zoom": 2, "bearing": 0, "pitch": 0}


def build_empty_project(
    name: str = "Untitled Project",
    *,
    center: list[float] | tuple[float, float] | None = None,
    zoom: float | None = None,
    basemap_url: str | None = None,
) -> dict[str, Any]:
    """Build an empty GeoLibre project dict.

    Args:
        name: Project display name.
        center: Optional ``[lng, lat]`` map center.
        zoom: Optional initial zoom level.
        basemap_url: Optional MapLibre style URL; defaults to the app default.

    Returns:
        A project dict ready to be assigned to the widget's ``project`` trait.
    """
    map_view = default_map_view()
    if center is not None:
        if len(center) != 2:
            raise ValueError(
                "center must be a [lng, lat] sequence with exactly 2 elements"
            )
        map_view["center"] = [float(center[0]), float(center[1])]
    if zoom is not None:
        map_view["zoom"] = float(zoom)
    return {
        "version": PROJECT_VERSION,
        "name": name,
        "mapView": map_view,
        "basemapStyleUrl": basemap_url or DEFAULT_BASEMAP,
        "basemapVisible": True,
        "basemapOpacity": 1,
        "layers": [],
        "styles": {},
        "preferences": copy.deepcopy(DEFAULT_PROJECT_PREFERENCES),
        "metadata": {},
    }


def _layer_base(name: str, layer_type: str, **style: Any) -> dict[str, Any]:
    # Deep-copy the defaults so nested values (e.g. the vectorStyleStops list)
    # are not shared with the module constant; a caller mutating a returned
    # layer's style must not corrupt DEFAULT_LAYER_STYLE for later layers.
    merged_style = {**copy.deepcopy(DEFAULT_LAYER_STYLE), **style}
    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "type": layer_type,
        "visible": True,
        "opacity": 1,
        "style": merged_style,
        "metadata": {},
    }


def geojson_layer(
    name: str,
    data: dict[str, Any],
    *,
    source_url: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a GeoJSON layer with an inlined FeatureCollection.

    Args:
        name: Layer display name.
        data: A GeoJSON FeatureCollection dict.
        source_url: Optional URL the data originated from (recorded on the
            source for restore/refresh).
        **style: Style overrides merged into the default layer style
            (e.g. ``fillColor="#ff0000"``).

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "geojson", **style)
    source: dict[str, Any] = {"type": "geojson"}
    if source_url:
        source["url"] = source_url
        layer["sourcePath"] = source_url
    layer["source"] = source
    layer["geojson"] = data
    return layer


def tile_layer(
    name: str,
    url: str,
    *,
    tile_size: int = 256,
    attribution: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a raster XYZ tile layer (e.g. an ``{z}/{x}/{y}`` template).

    Args:
        name: Layer display name.
        url: The XYZ tile URL template.
        tile_size: Tile size in pixels (typically 256).
        attribution: Optional attribution string.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "xyz", **style)
    source: dict[str, Any] = {
        "type": "raster",
        "tiles": [url],
        "tileSize": tile_size,
        "url": url,
    }
    if attribution:
        source["attribution"] = attribution
    layer["source"] = source
    layer["metadata"] = {"sourceKind": "xyz-url"}
    return layer


def cog_layer(
    name: str,
    url: str,
    *,
    bands: list[int] | None = None,
    colormap: str | None = None,
    rescale: list[list[float]] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a Cloud Optimized GeoTIFF (COG) layer.

    The shape matches what ``restoreRasterLayers`` replays from a saved project
    (see packages/plugins/src/plugins/raster-layer-sync.ts), so the app rebuilds
    the deck.gl raster overlay on load.

    Args:
        name: Layer display name.
        url: URL of the COG / GeoTIFF.
        bands: Optional 1-based band indices to render (e.g. ``[1, 2, 3]``).
        colormap: Optional colormap name for single-band rendering.
        rescale: Optional list of ``[min, max]`` ranges, one per rendered band.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "cog", **style)
    raster_state: dict[str, Any] = {}
    if rescale is not None:
        raster_state["rescale"] = rescale
    if bands is not None:
        raster_state["bands"] = bands
        raster_state["mode"] = "rgb" if len(bands) >= 3 else "single"
    if colormap is not None:
        raster_state["colormap"] = colormap
    layer["source"] = {"type": "raster", "url": url}
    layer["metadata"] = {
        "customLayerType": "raster",
        "externalDeckLayer": True,
        "externalNativeLayer": True,
        "identifiable": False,
        "nativeLayerIds": [layer["id"]],
        "panelCollapsed": True,
        "rasterOverlayMode": "interleaved",
        "rasterSource": "url",
        "rasterState": raster_state,
        "sourceIds": [],
        "sourceKind": "maplibre-gl-raster",
    }
    layer["sourcePath"] = url
    return layer


def load_featurecollection(data: Any) -> dict[str, Any]:
    """Coerce assorted inputs into a GeoJSON FeatureCollection dict.

    Accepts a FeatureCollection/Feature/geometry dict, a file path or URL to a
    GeoJSON file, a JSON string, or any object exposing ``__geo_interface__``
    (e.g. a GeoPandas GeoDataFrame/GeoSeries or a Shapely geometry).

    Args:
        data: The input geometry/collection in one of the supported forms.

    Returns:
        A GeoJSON FeatureCollection dict.

    Raises:
        ValueError: If the input cannot be interpreted as GeoJSON.
    """
    if hasattr(data, "__geo_interface__"):
        data = data.__geo_interface__

    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8")

    if isinstance(data, str):
        text = data.strip()
        if text.startswith(("http://", "https://")):
            # Reject non-public hosts up front, then fetch through an opener that
            # re-checks every redirect hop, so a redirect to a private/metadata
            # address cannot be followed (SSRF defence).
            _assert_public_url(text)
            # Bound the request so a slow or oversized response cannot hang the
            # kernel or exhaust memory. read(limit + 1) detects an over-limit
            # body without buffering the whole thing.
            try:
                with _GEOJSON_OPENER.open(text, timeout=30) as response:  # noqa: S310 - user URL
                    raw = response.read(_MAX_GEOJSON_BYTES + 1)
            except (URLError, TimeoutError) as exc:
                # Normalize transport failures to the documented ValueError
                # contract (decode/JSON errors are already ValueError-derived).
                raise ValueError(f"Could not load GeoJSON from URL: {text}") from exc
            if len(raw) > _MAX_GEOJSON_BYTES:
                raise ValueError("GeoJSON response exceeds the 50 MB size limit")
            data = json.loads(raw.decode("utf-8"))
        elif text.startswith(("{", "[")):
            data = json.loads(text)
        else:
            path = Path(text).expanduser()
            if not path.is_file():
                raise ValueError(f"GeoJSON file not found: {text}")
            if path.stat().st_size > _MAX_GEOJSON_BYTES:
                raise ValueError(f"GeoJSON file exceeds the 50 MB size limit: {text}")
            data = json.loads(path.read_text(encoding="utf-8"))

    if not isinstance(data, dict) or "type" not in data:
        raise ValueError("Could not interpret input as GeoJSON")

    geom_type = data["type"]
    if geom_type == "FeatureCollection":
        if not isinstance(data.get("features"), list):
            raise ValueError("FeatureCollection must have a 'features' list")
        return data
    if geom_type == "Feature":
        return {"type": "FeatureCollection", "features": [data]}
    # A bare geometry: wrap it in a feature.
    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": data}],
    }
