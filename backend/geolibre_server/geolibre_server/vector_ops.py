"""Pure vector geometry operations (GeoPandas/Shapely), framework-free.

This module is the single source of truth for the GeoLibre vector tools. It has
**no FastAPI dependency** so the exact same code runs in two places:

* the FastAPI sidecar (``app/vector.py`` wraps :func:`run_vector_tool` and maps
  the exceptions below to HTTP status codes), and
* the browser, where the source is loaded into Pyodide and ``run_vector_tool``
  is called directly (see ``apps/geolibre-desktop/src/lib/pyodide``).

Keeping one implementation guarantees the "Sidecar (GeoPandas)" and
"Python (Pyodide)" engines produce identical results. Handlers raise
:class:`ValueError` (or :class:`VectorInputTooLarge`) on bad input; the sidecar
translates those to 400/413 responses.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

WGS84 = "EPSG:4326"

# Cap the input size so a very large layer cannot block the event loop or
# exhaust memory (GeoPandas runs synchronously). The sidecar maps the
# resulting VectorInputTooLarge to HTTP 413.
MAX_FEATURES = 50_000

# Conversion factors from the requested unit to meters.
_DISTANCE_UNITS = {
    "kilometers": 1000.0,
    "meters": 1.0,
    "miles": 1609.344,
}


class VectorInputTooLarge(ValueError):
    """Raised when an input layer exceeds :data:`MAX_FEATURES`.

    A :class:`ValueError` subclass so generic callers treat it as bad input,
    while the sidecar can catch it specifically to return HTTP 413.
    """


def _import_geopandas() -> Any:
    """Import GeoPandas, raising ImportError if the optional dependency is missing."""
    import geopandas as gpd  # noqa: PLC0415

    return gpd


def geopandas_import_error() -> Optional[str]:
    """Return the GeoPandas import error message, or None if it imports cleanly.

    Lets callers log *why* the runtime is unavailable (a missing package vs. a
    subtler failure such as a compiled-extension ABI mismatch) rather than a
    generic "unavailable".
    """
    try:
        _import_geopandas()
        return None
    except Exception as exc:  # noqa: BLE001 - report any import failure
        return str(exc)


def _check_size(geojson: Optional[dict], label: str) -> None:
    """Reject payloads with more than ``MAX_FEATURES`` features."""
    if geojson and len(geojson.get("features", [])) > MAX_FEATURES:
        raise VectorInputTooLarge(f"{label} exceeds the {MAX_FEATURES}-feature limit")


def _load_gdf(geojson: Optional[dict], label: str) -> Any:
    """Build a WGS84 GeoDataFrame from a GeoJSON FeatureCollection."""
    gpd = _import_geopandas()
    if not geojson or not geojson.get("features"):
        raise ValueError(f"{label} has no features")
    gdf = gpd.GeoDataFrame.from_features(geojson["features"], crs=WGS84)
    if gdf.empty:
        raise ValueError(f"{label} has no features")
    return gdf


def _to_feature_collection(gdf) -> dict:
    """Serialize a GeoDataFrame back to a GeoJSON FeatureCollection dict."""
    # GeoPandas only emits valid GeoJSON in WGS84; reproject if needed.
    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(WGS84)
    return json.loads(gdf.to_json())


def _buffer(geojson, overlay, parameters) -> tuple[dict, list[str]]:
    gdf = _load_gdf(geojson, "Input layer")
    distance = float(parameters.get("distance", 1) or 0)
    units = str(parameters.get("units", "kilometers"))
    factor = _DISTANCE_UNITS.get(units)
    if factor is None:
        raise ValueError(f"Unknown unit '{units}'. Accepted: {list(_DISTANCE_UNITS)}")
    meters = distance * factor
    if meters < 0:
        # The UI enforces a non-negative distance; keep the server consistent
        # rather than silently performing an inward (erosion) buffer.
        raise ValueError("Buffer distance must be >= 0")
    # Buffer in a local metric CRS so the distance is in real-world meters,
    # then reproject the result back to WGS84.
    metric_crs = gdf.estimate_utm_crs()
    projected = gdf.to_crs(metric_crs)
    projected["geometry"] = projected.geometry.buffer(meters)
    return (
        _to_feature_collection(projected),
        [f"Buffered {len(gdf)} feature(s) by {distance} {units}"],
    )


def _centroids(geojson, overlay, parameters) -> tuple[dict, list[str]]:
    gdf = _load_gdf(geojson, "Input layer")
    # Compute centroids in a local metric CRS (like _buffer) so the result is
    # accurate for large or elongated features, then reproject back to WGS84.
    metric_crs = gdf.estimate_utm_crs()
    projected = gdf.to_crs(metric_crs)
    result = projected.copy()
    result["geometry"] = projected.geometry.centroid
    result = result.to_crs(WGS84)
    return _to_feature_collection(result), [f"Computed {len(result)} centroid(s)"]


def _convex_hull(geojson, overlay, parameters) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    gdf = _load_gdf(geojson, "Input layer")
    hull = gdf.geometry.union_all().convex_hull
    result = gpd.GeoDataFrame(geometry=[hull], crs=WGS84)
    return _to_feature_collection(result), ["Computed convex hull"]


def _dissolve(geojson, overlay, parameters) -> tuple[dict, list[str]]:
    gdf = _load_gdf(geojson, "Input layer")
    field = str(parameters.get("field", "") or "").strip()
    if field and field not in gdf.columns:
        raise ValueError(f"Dissolve field '{field}' not found in layer attributes.")
    if field:
        dissolved = gdf.dissolve(by=field).reset_index()
    else:
        dissolved = gdf.dissolve()
    return (
        _to_feature_collection(dissolved),
        [f"Dissolved {len(gdf)} feature(s) into {len(dissolved)} feature(s)"],
    )


def _bounding_box(geojson, overlay, parameters) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    from shapely.geometry import box  # noqa: PLC0415

    gdf = _load_gdf(geojson, "Input layer")
    minx, miny, maxx, maxy = gdf.total_bounds
    result = gpd.GeoDataFrame(geometry=[box(minx, miny, maxx, maxy)], crs=WGS84)
    return _to_feature_collection(result), ["Computed bounding box"]


def _simplify(geojson, overlay, parameters) -> tuple[dict, list[str]]:
    gdf = _load_gdf(geojson, "Input layer")
    # Tolerance is in degrees (the geometry stays in WGS84), matching the UI
    # label and the client engine. Do not introduce a metric-projected path
    # here without also reinterpreting the tolerance unit.
    tolerance = float(parameters.get("tolerance", 0.01) or 0)
    result = gdf.copy()
    result["geometry"] = gdf.geometry.simplify(tolerance)
    return (
        _to_feature_collection(result),
        [f"Simplified {len(result)} feature(s) (tolerance {tolerance})"],
    )


def _overlay_op(geojson, overlay, parameters, how: str) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    left = _load_gdf(geojson, "Input layer")
    right = _load_gdf(overlay, "Overlay layer")
    # Keep only polygonal output for difference so degenerate boundary slivers
    # (lines/points at shared edges) are dropped, per GIS convention.
    result = gpd.overlay(left, right, how=how, keep_geom_type=(how == "difference"))
    return (
        _to_feature_collection(result),
        [f"{how.capitalize()}: produced {len(result)} feature(s)"],
    )


def _clip(geojson, overlay, parameters) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    left = _load_gdf(geojson, "Input layer")
    right = _load_gdf(overlay, "Overlay layer")
    clipped = gpd.clip(left, right)
    return _to_feature_collection(clipped), [f"Clip: produced {len(clipped)} feature(s)"]


# Spatial-join predicates exposed by the UI (a safe subset of the predicates
# GeoPandas' spatial index accepts). The relationship reads left (input) → right
# (join): "within" is input-within-join, "contains" is input-contains-join.
_SJOIN_PREDICATES = {"intersects", "within", "contains"}
_SJOIN_HOW = {"inner", "left"}


def _spatial_join(geojson, overlay, parameters) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    left = _load_gdf(geojson, "Input layer")
    right = _load_gdf(overlay, "Join layer")
    predicate = str(parameters.get("predicate", "intersects") or "intersects")
    if predicate not in _SJOIN_PREDICATES:
        raise ValueError(
            f"Unknown predicate '{predicate}'. Accepted: {sorted(_SJOIN_PREDICATES)}"
        )
    how = str(parameters.get("how", "inner") or "inner")
    if how not in _SJOIN_HOW:
        raise ValueError(f"Unknown join type '{how}'. Accepted: {sorted(_SJOIN_HOW)}")
    joined = gpd.sjoin(left, right, predicate=predicate, how=how)
    # sjoin appends an "index_right" bookkeeping column; drop it so the output
    # carries only the two layers' real attributes.
    joined = joined.drop(columns=["index_right"], errors="ignore")
    return (
        _to_feature_collection(joined),
        [f"Spatial join: produced {len(joined)} feature(s)"],
    )


def _union(geojson, overlay, parameters) -> tuple[dict, list[str]]:
    gpd = _import_geopandas()
    left = _load_gdf(geojson, "Input layer")
    right = _load_gdf(overlay, "Overlay layer")
    # Match the client engine: dissolve both layers into a single merged
    # geometry rather than gpd.overlay(how="union")'s full-outer-join, which
    # would return many attributed parts and diverge from the Turf.js result.
    merged = gpd.GeoSeries(
        [left.geometry.union_all(), right.geometry.union_all()], crs=WGS84
    ).union_all()
    result = gpd.GeoDataFrame(geometry=[merged], crs=WGS84)
    return _to_feature_collection(result), ["Union: produced 1 feature"]


# tool_id -> handler(geojson, overlay, parameters) -> (feature_collection, messages)
_DISPATCH: dict[str, Callable[..., tuple[dict, list[str]]]] = {
    "buffer": _buffer,
    "centroids": _centroids,
    "convex-hull": _convex_hull,
    "dissolve": _dissolve,
    "bounding-box": _bounding_box,
    "simplify": _simplify,
    "clip": _clip,
    "intersection": lambda g, o, p: _overlay_op(g, o, p, "intersection"),
    "difference": lambda g, o, p: _overlay_op(g, o, p, "difference"),
    "union": _union,
    "spatial-join": _spatial_join,
}


def run_vector_tool(
    tool_id: str,
    geojson: Optional[dict] = None,
    overlay: Optional[dict] = None,
    parameters: Optional[dict[str, Any]] = None,
) -> tuple[dict, list[str]]:
    """Run a single vector geometry operation.

    Args:
        tool_id: One of the keys in :data:`_DISPATCH`.
        geojson: The input layer as a GeoJSON FeatureCollection dict.
        overlay: The overlay layer for two-layer tools (clip/overlay/union).
        parameters: Tool-specific parameters (e.g. ``distance``, ``units``).

    Returns:
        A ``(feature_collection, messages)`` tuple where ``feature_collection``
        is a GeoJSON FeatureCollection dict and ``messages`` is a list of log
        strings.

    Raises:
        VectorInputTooLarge: An input layer exceeds :data:`MAX_FEATURES`.
        ValueError: Unknown ``tool_id`` or invalid input/parameters.
    """
    if not tool_id:
        raise ValueError("tool_id is required")
    handler = _DISPATCH.get(tool_id)
    if handler is None:
        raise ValueError(f"Unknown vector tool: {tool_id!r}")

    _check_size(geojson, "Input layer")
    _check_size(overlay, "Overlay layer")

    return handler(geojson, overlay, parameters or {})


def run_vector_tool_json(payload: str) -> str:
    """JSON-string wrapper around :func:`run_vector_tool` for the Pyodide boundary.

    Takes a JSON string ``{tool_id, geojson, overlay, parameters}`` and returns a
    JSON string ``{geojson, messages}``. Errors propagate as exceptions for the
    caller (the Pyodide worker) to translate.

    Args:
        payload: JSON-encoded request object.

    Returns:
        JSON-encoded ``{"geojson": ..., "messages": [...]}`` result.
    """
    request = json.loads(payload)
    if not isinstance(request, dict):
        raise ValueError(f"Expected a JSON object, got {type(request).__name__}")
    geojson, messages = run_vector_tool(
        request.get("tool_id"),
        request.get("geojson"),
        request.get("overlay"),
        request.get("parameters") or {},
    )
    return json.dumps({"geojson": geojson, "messages": messages})
