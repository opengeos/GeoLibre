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
import math
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


def _to_feature_collection(gdf: Any) -> dict:
    """Serialize a GeoDataFrame back to a GeoJSON FeatureCollection dict."""
    # GeoPandas only emits valid GeoJSON in WGS84; reproject if needed.
    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(WGS84)
    return json.loads(gdf.to_json())


# Every tool handler below shares the signature
# ``(geojson, overlay, parameters) -> (feature_collection, messages)`` so they
# can be dispatched uniformly (see _DISPATCH). Single-layer tools accept but
# ignore ``overlay``; two-layer tools (clip/overlay/union/joins) read it.
def _buffer(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Buffer each feature by a distance applied in a local metric (UTM) CRS.

    Reads ``distance`` (in ``units``: kilometers/meters/miles) from
    ``parameters``, buffers in the estimated UTM CRS so the offset is in
    real-world meters, then reprojects back to WGS84. Negative distance is
    rejected.
    """
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


def _centroids(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Replace each feature with its centroid (computed in a local metric CRS)."""
    gdf = _load_gdf(geojson, "Input layer")
    # Compute centroids in a local metric CRS (like _buffer) so the result is
    # accurate for large or elongated features, then reproject back to WGS84.
    metric_crs = gdf.estimate_utm_crs()
    projected = gdf.to_crs(metric_crs)
    result = projected.copy()
    result["geometry"] = projected.geometry.centroid
    result = result.to_crs(WGS84)
    return _to_feature_collection(result), [f"Computed {len(result)} centroid(s)"]


def _convex_hull(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Compute the single convex hull enclosing every input feature."""
    gpd = _import_geopandas()
    gdf = _load_gdf(geojson, "Input layer")
    hull = gdf.geometry.union_all().convex_hull
    result = gpd.GeoDataFrame(geometry=[hull], crs=WGS84)
    return _to_feature_collection(result), ["Computed convex hull"]


def _dissolve(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Merge features into one geometry, optionally grouped by ``field``."""
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


def _bounding_box(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Compute the axis-aligned bounding box of all features as one polygon."""
    gpd = _import_geopandas()
    from shapely.geometry import box  # noqa: PLC0415

    gdf = _load_gdf(geojson, "Input layer")
    minx, miny, maxx, maxy = gdf.total_bounds
    result = gpd.GeoDataFrame(geometry=[box(minx, miny, maxx, maxy)], crs=WGS84)
    return _to_feature_collection(result), ["Computed bounding box"]


def _simplify(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Reduce vertex count with Douglas-Peucker (``tolerance`` in degrees)."""
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


def _overlay_op(
    geojson: Optional[dict],
    overlay: Optional[dict],
    parameters: dict[str, Any],
    how: str,
) -> tuple[dict, list[str]]:
    """Run a two-layer GeoPandas overlay (``how``: intersection/difference)."""
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


def _clip(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Clip the input layer to the overlay layer's geometry."""
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


def _spatial_join(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Join overlay attributes onto input features by a spatial ``predicate``.

    ``predicate`` is one of intersects/within/contains and ``how`` is inner or
    left; an empty overlay keeps every input feature (left) or none (inner).
    """
    gpd = _import_geopandas()
    # Validate parameters before loading the layers so an unknown predicate/how
    # surfaces its actionable message instead of a generic load error.
    predicate = str(parameters.get("predicate", "intersects") or "intersects")
    if predicate not in _SJOIN_PREDICATES:
        raise ValueError(f"Unknown predicate '{predicate}'. Accepted: {sorted(_SJOIN_PREDICATES)}")
    how = str(parameters.get("how", "inner") or "inner")
    if how not in _SJOIN_HOW:
        raise ValueError(f"Unknown join type '{how}'. Accepted: {sorted(_SJOIN_HOW)}")
    left = _load_gdf(geojson, "Input layer")
    # An empty join layer is still well-defined and avoids a misleading "has no
    # features" error: a left join keeps every input feature unchanged, an inner
    # join yields nothing. Matches the client engine.
    if not overlay or not overlay.get("features"):
        result = left if how == "left" else left.iloc[0:0]
        return (
            _to_feature_collection(result),
            [f"Spatial join: produced {len(result)} feature(s)"],
        )
    right = _load_gdf(overlay, "Join layer")
    joined = gpd.sjoin(left, right, predicate=predicate, how=how)
    # sjoin appends an "index_right" bookkeeping column; drop it so the output
    # carries only the two layers' real attributes.
    joined = joined.drop(columns=["index_right"], errors="ignore")
    return (
        _to_feature_collection(joined),
        [f"Spatial join: produced {len(joined)} feature(s)"],
    )


# Comparison operators for Select by value; kept in sync with the client engine.
_VALUE_OPERATORS = {
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "starts-with",
    "is-null",
    "is-not-null",
}
# Spatial predicates for Select by location.
_SELECT_LOCATION_PREDICATES = {"intersects", "within", "contains", "disjoint"}


def _value_to_string(value: Any) -> str:
    """Stringify a property value the way the client's ``valueToString`` does."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        # Match JS, where 5.0 prints as "5"; avoids "5.0" vs "5" divergence.
        return str(int(value))
    if isinstance(value, (list, dict)):
        # Canonical JSON (sorted keys, no spaces) matching the client's
        # stableStringify, so eq/contains agree across engines for non-scalars.
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    return str(value)


def _is_finite_number(text: str) -> bool:
    try:
        return math.isfinite(float(text))
    except (TypeError, ValueError):
        return False


def _match_value(value: Any, operator: str, raw: str) -> bool:
    """Evaluate one attribute value against an operator and the user's input.

    Mirrors ``matchesValue`` in the client engine: comparisons are numeric only
    when both sides are finite numbers, otherwise string-based; empty values
    (None/NaN/empty string) match only the is-empty/is-not-empty operators.
    """
    is_empty = (
        value is None
        or (isinstance(value, float) and math.isnan(value))
        or _value_to_string(value) == ""
    )
    if operator == "is-null":
        return is_empty
    if operator == "is-not-null":
        return not is_empty
    if is_empty:
        return False

    sv = _value_to_string(value)
    if operator == "contains":
        # Python `in` puts the needle on the left: sv contains raw.
        return raw.lower() in sv.lower()
    if operator == "starts-with":
        return sv.lower().startswith(raw.lower())

    numeric = (
        raw.strip() != ""
        and not isinstance(value, bool)
        and _is_finite_number(sv)
        and _is_finite_number(raw)
    )
    if numeric:
        a: Any = float(sv)
        b: Any = float(raw)
    else:
        a, b = sv, raw
    if operator == "eq":
        return a == b
    if operator == "neq":
        return a != b
    if operator == "gt":
        return a > b
    if operator == "gte":
        return a >= b
    if operator == "lt":
        return a < b
    if operator == "lte":
        return a <= b
    return False


def _select_by_value(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Filter features by an attribute ``field``/``operator``/``value`` test."""
    # Pure attribute filter on the raw GeoJSON properties (no geometry), so it
    # produces byte-identical results to the client engine and needs no GeoPandas.
    if not geojson or not geojson.get("features"):
        raise ValueError("Input layer has no features")
    field = str(parameters.get("field", "") or "").strip()
    if not field:
        raise ValueError("A field is required")
    operator = str(parameters.get("operator", "eq") or "eq")
    if operator not in _VALUE_OPERATORS:
        raise ValueError(f"Unknown operator '{operator}'. Accepted: {sorted(_VALUE_OPERATORS)}")
    raw_param = parameters.get("value", "")
    raw = "" if raw_param is None else str(raw_param)
    if operator not in ("is-null", "is-not-null") and raw == "":
        raise ValueError("A value is required for this operator")
    features = geojson["features"]
    # A field absent from every feature is treated as all-empty (schemaless
    # GeoJSON): is-empty matches everything, the rest match nothing. _match_value
    # handles the missing value per feature; mirrors the client engine.
    selected = [
        f for f in features if _match_value((f.get("properties") or {}).get(field), operator, raw)
    ]
    fc = {"type": "FeatureCollection", "features": selected}
    return (
        fc,
        [f"Select by value: {len(selected)} of {len(features)} feature(s) matched"],
    )


def _select_by_location(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Select input features by spatial relationship to the filter layer.

    ``predicate`` is one of intersects/within/contains/disjoint; an empty
    filter layer selects everything for disjoint and nothing otherwise.
    """
    gpd = _import_geopandas()
    predicate = str(parameters.get("predicate", "intersects") or "intersects")
    if predicate not in _SELECT_LOCATION_PREDICATES:
        raise ValueError(
            f"Unknown predicate '{predicate}'. Accepted: {sorted(_SELECT_LOCATION_PREDICATES)}"
        )
    left = _load_gdf(geojson, "Input layer")
    # `total` is every input feature (matching the client's input.features.length
    # in the log); drop null-geometry rows from the candidates the same way the
    # client (`f.geometry` filter) does, so they never count as a disjoint match.
    total = len(left)
    left = left[left.geometry.notna()]
    # An empty filter layer selects everything for "disjoint" (nothing to
    # intersect) and nothing for the positive predicates. Matches the client.
    if not overlay or not overlay.get("features"):
        result = left if predicate == "disjoint" else left.iloc[0:0]
        return (
            _to_feature_collection(result),
            [f"Select by location: {len(result)} of {total} feature(s) matched"],
        )
    right = _load_gdf(overlay, "Filter layer")
    # Drop null geometries from the filter frame too; sjoin can raise or behave
    # unexpectedly on null-geometry rows depending on the GeoPandas version.
    right = right[right.geometry.notna()]
    test = "intersects" if predicate == "disjoint" else predicate
    matched = gpd.sjoin(left, right, predicate=test, how="inner").index.unique()
    # Preserve input order and emit one row per input feature (sjoin can match
    # several filter features). For disjoint, keep the features that matched none.
    mask = left.index.isin(matched)
    result = left[~mask] if predicate == "disjoint" else left[mask]
    return (
        _to_feature_collection(result),
        [f"Select by location: {len(result)} of {total} feature(s) matched"],
    )


# Join types for Attribute join; kept in sync with the client engine.
_ATTRIBUTE_JOIN_HOW = {"inner", "left"}


def _attribute_join_key(value: Any) -> Optional[str]:
    """Match key for Attribute join; mirrors the client's ``attributeJoinKey``.

    Empty values (None/NaN/empty string) never match a row (like a SQL/pandas
    NaN join key). Non-empty values are keyed by :func:`_value_to_string`, so a
    numeric ``5`` and the string ``"5"`` join while a zero-padded code like
    ``"01001"`` only matches another ``"01001"``.
    """
    is_empty = (
        value is None
        or (isinstance(value, float) and math.isnan(value))
        or _value_to_string(value) == ""
    )
    if is_empty:
        return None
    return _value_to_string(value)


def _attribute_join(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Attach a join layer's attributes onto each input feature by a key field.

    A pure attribute (non-spatial) join on the raw GeoJSON properties (geometry
    is carried through untouched), so it produces results identical to the client
    engine and needs no GeoPandas. One-to-one: the first matching join row wins.
    """
    if not geojson or not geojson.get("features"):
        raise ValueError("Input layer has no features")
    target_field = str(parameters.get("target_field", "") or "").strip()
    if not target_field:
        raise ValueError("A target key field is required")
    join_field = str(parameters.get("join_field", "") or "").strip()
    if not join_field:
        raise ValueError("A join key field is required")
    how = str(parameters.get("how", "left") or "left")
    if how not in _ATTRIBUTE_JOIN_HOW:
        raise ValueError(f"Unknown join type '{how}'. Accepted: {sorted(_ATTRIBUTE_JOIN_HOW)}")
    fields_raw = parameters.get("fields")
    requested_fields = None
    if isinstance(fields_raw, str) and fields_raw.strip():
        requested_fields = [s.strip() for s in fields_raw.split(",") if s.strip()]

    # An empty join layer is well-defined: a left join keeps every target feature
    # (no columns added), an inner join yields nothing. Matches the client.
    join_features = overlay.get("features", []) if overlay else []

    # Collect every join key in first-seen order so the output schema is
    # deterministic across both engines.
    join_keys_order: list[str] = []
    join_key_set: set[str] = set()
    for jf in join_features:
        if not isinstance(jf, dict):
            continue
        for key in jf.get("properties") or {}:
            if key not in join_key_set:
                join_key_set.add(key)
                join_keys_order.append(key)

    messages: list[str] = []
    # An empty list (e.g. fields = "," or ", ,") means the user effectively left
    # the field blank, so it is falsy and falls through to the default below.
    if requested_fields:
        selected_fields = [f for f in requested_fields if f in join_key_set]
        missing = [f for f in requested_fields if f not in join_key_set]
        if missing:
            messages.append("Note: join field(s) not found and skipped: " + ", ".join(missing))
        if not selected_fields:
            raise ValueError("None of the requested join fields exist in the join layer")
    else:
        # Default: every join field except the key (which would just duplicate
        # the target key column).
        selected_fields = [k for k in join_keys_order if k != join_field]
        # A join layer that carries only the key column transfers no attributes;
        # warn so the user isn't left thinking a silent no-op succeeded.
        if join_features and not selected_fields:
            messages.append(
                "Note: no fields to bring over (join layer only contains the key column)"
            )

    # First-match lookup: when several join rows share a key, the first wins.
    lookup: dict[str, dict] = {}
    for jf in join_features:
        if not isinstance(jf, dict):
            continue
        props = jf.get("properties") or {}
        key = _attribute_join_key(props.get(join_field))
        if key is None:
            continue
        if key not in lookup:
            lookup[key] = props

    null_fill = {f: None for f in selected_fields}
    input_features = geojson["features"]
    results = []
    matched = 0
    for feature in input_features:
        # The input layer must be strictly valid (a malformed feature is a hard
        # error), whereas non-dict entries in the join table are skipped above —
        # the same lenient-join convention as _spatial_join.
        if not isinstance(feature, dict):
            raise ValueError("Each feature must be a GeoJSON Feature object")
        props = feature.get("properties") or {}
        key = _attribute_join_key(props.get(target_field))
        join_props = lookup.get(key) if key is not None else None
        if join_props is None:
            if how == "left":
                # Target attributes win on a collision with a null-filled column.
                new_props = dict(null_fill)
                new_props.update(props)
                out = {
                    "type": "Feature",
                    "properties": new_props,
                    "geometry": feature.get("geometry"),
                }
                if "id" in feature:
                    out["id"] = feature["id"]
                results.append(out)
            continue
        matched += 1
        # .get returns None for a key absent from this particular join row,
        # matching the client's null fill for a schemaless join layer.
        picked = {f: join_props.get(f) for f in selected_fields}
        # Target attributes win on name collisions with brought-over fields.
        picked.update(props)
        out = {
            "type": "Feature",
            "properties": picked,
            "geometry": feature.get("geometry"),
        }
        if "id" in feature:
            out["id"] = feature["id"]
        results.append(out)
    fc = {"type": "FeatureCollection", "features": results}
    messages.append(
        f"Attribute join: {matched} of {len(input_features)} feature(s) matched; "
        f"produced {len(results)} feature(s)"
    )
    return fc, messages


def _union(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Merge both layers into a single dissolved geometry."""
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


def _reproject(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Reinterpret a layer's coordinates as a source CRS and transform to WGS84.

    GeoLibre stores and displays every vector layer as WGS84 GeoJSON, so the
    only reprojection that yields a *displayable* result is mapping data that is
    really in some other CRS back to longitude/latitude. The common case is data
    whose coordinates are in a projected CRS (e.g. Web Mercator EPSG:3857) but
    were loaded as if they were lon/lat, so the layer lands in the wrong place.
    This reads the input coordinates as ``source_crs`` and reprojects them to
    WGS84 (:func:`_to_feature_collection` always normalizes the output to WGS84).
    """
    gpd = _import_geopandas()
    if not geojson or not geojson.get("features"):
        raise ValueError("Input layer has no features")
    source_crs = str(parameters.get("source_crs", "") or "").strip()
    if not source_crs:
        raise ValueError("A source CRS is required (e.g. EPSG:3857)")
    # Build the frame WITHOUT the WGS84 assumption in _load_gdf: the stored
    # coordinates are really in `source_crs`. An unknown CRS raises here.
    try:
        gdf = gpd.GeoDataFrame.from_features(geojson["features"], crs=source_crs)
    except Exception as exc:  # noqa: BLE001 - surface any CRS/parse failure as 400
        raise ValueError(f"Invalid source CRS '{source_crs}': {exc}") from exc
    if gdf.empty:
        raise ValueError("Input layer has no features")
    return (
        _to_feature_collection(gdf),
        [f"Reprojected {len(gdf)} feature(s) from {source_crs} to WGS84"],
    )


def _explode(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Split multipart geometries into single-part features (multi -> single)."""
    gdf = _load_gdf(geojson, "Input layer")
    # index_parts=False keeps a flat index so the output is a plain list of
    # single-part features carrying each parent's attributes (one row per part).
    exploded = gdf.explode(index_parts=False).reset_index(drop=True)
    return (
        _to_feature_collection(exploded),
        [f"Exploded {len(gdf)} feature(s) into {len(exploded)} single-part feature(s)"],
    )


# Summary statistics supported by Aggregate by attribute; kept in sync with the
# client engine. "count" needs no value field; the rest reduce a numeric field.
_AGGREGATE_STATS = {"count", "sum", "mean", "min", "max", "median"}


def _aggregate(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Dissolve geometries by an attribute and attach a per-group summary stat.

    Mirrors GeoPandas ``dissolve(by=...)`` for the geometry merge plus a
    pandas ``groupby`` for the statistic. The output has one feature per group
    with the group field and a single statistic column (``count`` or
    ``<field>_<stat>``); kept in sync with the client engine.
    """
    import pandas as pd  # noqa: PLC0415

    gdf = _load_gdf(geojson, "Input layer")
    # The geometry column is in gdf.columns but is not a groupable/numeric
    # attribute; reject it explicitly so it fails with a clean 400 instead of a
    # later TypeError (unhashable geometry) surfacing as a 500.
    geom_col = gdf.geometry.name
    group_field = str(parameters.get("group_field", "") or "").strip()
    if not group_field:
        raise ValueError("A group field is required")
    if group_field not in gdf.columns or group_field == geom_col:
        raise ValueError(f"Group field '{group_field}' not found in layer attributes.")
    statistic = str(parameters.get("statistic", "count") or "count")
    if statistic not in _AGGREGATE_STATS:
        raise ValueError(f"Unknown statistic '{statistic}'. Accepted: {sorted(_AGGREGATE_STATS)}")
    stat_field = str(parameters.get("stat_field", "") or "").strip()
    if statistic != "count":
        if not stat_field:
            raise ValueError(f"A statistic field is required for '{statistic}'")
        if stat_field not in gdf.columns or stat_field == geom_col:
            raise ValueError(f"Statistic field '{stat_field}' not found in layer attributes.")
    # Restrict to polygons to match the client engine (and the tool's polygon-only
    # layer picker), so a mixed-geometry layer can't make the two engines count
    # different features per group.
    total = len(gdf)
    gdf = gdf[gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
    if gdf.empty:
        raise ValueError("Aggregate by attribute requires polygon features")
    skipped = total - len(gdf)
    # Merge each group's geometries into one (union), keeping only geometry so the
    # output carries just the group key and the computed statistic.
    result = gdf.dissolve(by=group_field)[["geometry"]].copy()
    if statistic == "count":
        out_col = "count"
        values = gdf.groupby(group_field).size()
    else:
        out_col = f"{stat_field}_{statistic}"
        # Coerce non-numeric/empty values to NaN so they are skipped, matching the
        # client engine. Call the GroupBy reducer by name (e.g. .median()) rather
        # than .agg("median"), whose NaN-skipping can vary by pandas version.
        numeric = pd.to_numeric(gdf[stat_field], errors="coerce")
        values = getattr(numeric.groupby(gdf[group_field]), statistic)()
    # Align the statistic to the dissolved geometry explicitly by index label so the
    # assignment stays correct even if either call's group ordering changes.
    result[out_col] = values.reindex(result.index)
    result = result.reset_index()
    message = f"Aggregated {len(gdf)} feature(s) into {len(result)} group(s) by '{group_field}'"
    # Mirror the client's "(N skipped, not polygons)" note for mixed-geometry input.
    if skipped:
        message += f" ({skipped} skipped, not polygons)"
    return _to_feature_collection(result), [message]


# Largest iteration count Smooth accepts; kept in sync with the client engine.
_SMOOTH_MAX_ITERATIONS = 10


def _chaikin_point(a: list[float], b: list[float], wa: float) -> list[float]:
    """Interpolate the point a fraction ``wa`` from ``a`` toward ``b``.

    ``wa = 0.75`` lands closer to ``a``. Z/elevation is carried through and
    interpolated when both endpoints are 3D; otherwise the result is 2D.
    """
    wb = 1 - wa
    x = a[0] * wa + b[0] * wb
    y = a[1] * wa + b[1] * wb
    if len(a) > 2 and len(b) > 2:
        return [x, y, a[2] * wa + b[2] * wb]
    return [x, y]


def _chaikin(points: list[list[float]], closed: bool) -> list[list[float]]:
    """One pass of Chaikin's corner-cutting over a list of positions.

    Each segment A->B contributes two new points at 1/4 and 3/4 along it. For a
    closed ring the segments wrap (every vertex is cut); for an open line the
    endpoints are preserved. Z is preserved/interpolated (see
    :func:`_chaikin_point`); extra coordinate dimensions are dropped. The
    arithmetic and ordering mirror the client's ``chaikinOnce`` exactly so both
    engines return bit-identical coordinates.
    """
    n = len(points)
    if n < (3 if closed else 2):
        return points
    out: list[list[float]] = []
    if closed:
        for i in range(n):
            a = points[i]
            b = points[(i + 1) % n]
            out.append(_chaikin_point(a, b, 0.75))
            out.append(_chaikin_point(a, b, 0.25))
    else:
        out.append(list(points[0][:3]))
        for i in range(n - 1):
            a = points[i]
            b = points[i + 1]
            out.append(_chaikin_point(a, b, 0.75))
            out.append(_chaikin_point(a, b, 0.25))
        out.append(list(points[n - 1][:3]))
    return out


def _smooth_line(coords: list[list[float]], iterations: int) -> list[list[float]]:
    """Apply ``iterations`` Chaikin passes to an open line's coordinates."""
    pts = [list(p[:3]) for p in coords]
    for _ in range(iterations):
        pts = _chaikin(pts, False)
    return pts


def _smooth_ring(ring: list[list[float]], iterations: int) -> list[list[float]]:
    """Apply ``iterations`` Chaikin passes to a polygon ring (re-closed)."""
    closed = len(ring) > 1 and ring[0][0] == ring[-1][0] and ring[0][1] == ring[-1][1]
    pts = [list(p[:3]) for p in (ring[:-1] if closed else ring)]
    for _ in range(iterations):
        pts = _chaikin(pts, True)
    # A ring needs >= 3 distinct vertices to form a valid polygon; an empty or
    # otherwise degenerate (1-2 vertex) ring collapses to an empty ring rather
    # than being re-closed into invalid GeoJSON (and never an IndexError 500).
    if len(pts) < 3:
        return []
    pts.append(list(pts[0]))
    return pts


def _smooth_geometry(geometry: dict, iterations: int) -> dict:
    """Smooth one GeoJSON geometry; non-line/polygon geometries pass through."""
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    # `coords or []` guards a malformed feature missing its coordinates key
    # (e.g. {"type": "LineString"}), whose `None` would otherwise raise a
    # TypeError (500) since the server accepts arbitrary JSON.
    if gtype == "LineString":
        return {"type": gtype, "coordinates": _smooth_line(coords or [], iterations)}
    if gtype == "MultiLineString":
        return {
            "type": gtype,
            "coordinates": [_smooth_line(line, iterations) for line in coords or []],
        }
    if gtype == "Polygon":
        return {
            "type": gtype,
            "coordinates": [_smooth_ring(ring, iterations) for ring in coords or []],
        }
    if gtype == "MultiPolygon":
        return {
            "type": gtype,
            "coordinates": [
                [_smooth_ring(ring, iterations) for ring in poly] for poly in coords or []
            ],
        }
    if gtype == "GeometryCollection":
        # Recurse so line/polygon members are smoothed instead of silently
        # passing through; point members fall to the pass-through below.
        return {
            "type": gtype,
            "geometries": [_smooth_geometry(g, iterations) for g in geometry.get("geometries", [])],
        }
    return geometry


def _smooth(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Round the corners of line/polygon features with Chaikin's algorithm.

    Works directly on the GeoJSON coordinates (no GeoPandas) so it produces
    bit-identical output to the client engine, distinct from Simplify's vertex
    reduction. Points pass through unchanged.
    """
    if not geojson or not geojson.get("features"):
        raise ValueError("Input layer has no features")
    # Mirror the client's `Math.round(numberParam(ctx, "iterations", 3))`: a
    # non-finite/unparseable value falls back to 3, and math.floor(x + 0.5)
    # rounds half up exactly like JS Math.round (not Python round()'s
    # banker's rounding), keeping the two engines bit-identical.
    raw_iterations = parameters.get("iterations", 3)
    # A JSON boolean is not a number on the client (numberParam returns the
    # fallback), so treat it as the default rather than float(True/False) = 1/0.
    if isinstance(raw_iterations, bool):
        value = 3.0
    else:
        try:
            value = float(raw_iterations)
        except (TypeError, ValueError):
            value = 3.0
    if not math.isfinite(value):
        value = 3.0
    iterations = math.floor(value + 0.5)
    if iterations < 1 or iterations > _SMOOTH_MAX_ITERATIONS:
        raise ValueError(f"Iterations must be between 1 and {_SMOOTH_MAX_ITERATIONS}")
    out_features = []
    smoothed = 0
    _smoothable = ("LineString", "MultiLineString", "Polygon", "MultiPolygon")
    for feature in geojson["features"]:
        # The server accepts arbitrary JSON, so a `null`/non-object feature would
        # raise AttributeError (500); reject it as bad input (ValueError -> 400),
        # matching the module contract.
        if not isinstance(feature, dict):
            raise ValueError("Each feature must be a GeoJSON Feature object")
        geometry = feature.get("geometry")
        if not geometry:
            out_features.append(feature)
            continue
        gtype = geometry.get("type")
        if gtype in _smoothable:
            smoothed += 1
        elif gtype == "GeometryCollection" and any(
            g.get("type") in _smoothable for g in geometry.get("geometries", [])
        ):
            # Only count a collection that actually has a line/polygon member;
            # a points-only collection passes through unchanged.
            smoothed += 1
        new_feature = {
            "type": "Feature",
            "properties": feature.get("properties") or {},
            "geometry": _smooth_geometry(geometry, iterations),
        }
        # Preserve the feature id (this raw-JSON path can keep it cheaply, unlike
        # the GeoPandas handlers that lose it through the GeoDataFrame round-trip).
        if "id" in feature:
            new_feature["id"] = feature["id"]
        out_features.append(new_feature)
    fc = {"type": "FeatureCollection", "features": out_features}
    return fc, [f"Smoothed {smoothed} feature(s) with {iterations} iteration(s)"]


def _voronoi(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Build a Voronoi diagram or Delaunay triangulation from a point layer."""
    gpd = _import_geopandas()
    from shapely.geometry import MultiPoint, box  # noqa: PLC0415
    from shapely.ops import triangulate, voronoi_diagram  # noqa: PLC0415

    kind = str(parameters.get("type", "voronoi") or "voronoi")
    if kind not in ("voronoi", "delaunay"):
        raise ValueError(f"Unknown diagram type '{kind}'. Accepted: delaunay, voronoi")
    gdf = _load_gdf(geojson, "Input layer")
    # Collect every point, exploding MultiPoint into its members (mirrors the
    # client's collectPoints), so a MultiPoint layer is handled the same way.
    points = []
    for geom in gdf.geometry:
        if geom is None:
            continue
        if geom.geom_type == "Point":
            points.append(geom)
        elif geom.geom_type == "MultiPoint":
            points.extend(list(geom.geoms))
    if len(points) < 3:
        raise ValueError("Voronoi / Delaunay needs at least 3 points")
    multipoint = MultiPoint(points)
    # Both diagrams are undefined for collinear/coincident points (a zero-area
    # bounding box); bail with a clear message rather than a degenerate result.
    # Mirrors the client guard.
    minx, miny, maxx, maxy = multipoint.bounds
    if minx == maxx or miny == maxy:
        raise ValueError(
            "The points are collinear or coincident; Voronoi / Delaunay needs "
            "points that span an area"
        )
    if kind == "delaunay":
        triangles = triangulate(multipoint)
        # The bbox guard above catches axis-aligned collinearity; diagonally
        # collinear points still yield no triangle with area, so report that.
        if not triangles:
            raise ValueError(
                "Could not triangulate — the points are collinear (no triangle has area)"
            )
        result = gpd.GeoDataFrame(geometry=triangles, crs=WGS84)
        message = f"Delaunay: produced {len(triangles)} triangle(s) from {len(points)} point(s)"
        return _to_feature_collection(result), [message]
    # Clip the (otherwise unbounded outer) cells to the points' bbox expanded by a
    # 10% margin, matching the client, so they get a finite extent.
    dx = maxx - minx
    dy = maxy - miny
    envelope = box(minx - dx * 0.1, miny - dy * 0.1, maxx + dx * 0.1, maxy + dy * 0.1)
    diagram = voronoi_diagram(multipoint, envelope=envelope)
    cells = [cell.intersection(envelope) for cell in diagram.geoms]
    # Clipping a cell whose edge coincides with the envelope can yield a
    # GeometryCollection (polygon + stray line); keep only polygonal parts so a
    # non-Polygon geometry never lands in the output.
    cells = [
        cell
        for cell in cells
        if not cell.is_empty and cell.geom_type in ("Polygon", "MultiPolygon")
    ]
    if not cells:
        raise ValueError("Could not build a Voronoi diagram — the points are collinear")
    result = gpd.GeoDataFrame(geometry=cells, crs=WGS84)
    message = f"Voronoi: produced {len(cells)} cell(s) from {len(points)} point(s)"
    return _to_feature_collection(result), [message]


def _first_coordinate(geom: Any) -> Optional[tuple[float, float]]:
    """Return the first (x, y) coordinate of a geometry, or None if empty.

    Used to anchor a validity-error marker when :func:`explain_validity` does
    not include a problem location. Works on invalid geometry (no GEOS
    operations that require validity).

    Args:
        geom: Any Shapely geometry.

    Returns:
        The first coordinate as ``(x, y)``, or ``None`` for empty geometry.
    """
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type == "Point":
        return (geom.x, geom.y)
    if geom.geom_type in ("LineString", "LinearRing"):
        x, y = geom.coords[0][:2]
        return (x, y)
    if geom.geom_type == "Polygon":
        x, y = geom.exterior.coords[0][:2]
        return (x, y)
    for part in getattr(geom, "geoms", []):
        found = _first_coordinate(part)
        if found is not None:
            return found
    return None


def _validity_anchor(reason: str, geom: Any) -> Optional[tuple[float, float]]:
    """Choose a marker location for an invalid geometry.

    Prefers the ``[x y]`` location embedded in a GEOS
    :func:`~shapely.validation.explain_validity` message (e.g.
    ``"Self-intersection[2 2]"``); falls back to the geometry's first
    coordinate.

    Args:
        reason: The ``explain_validity`` message.
        geom: The invalid Shapely geometry.

    Returns:
        The marker ``(x, y)``, or ``None`` when no coordinate exists at all.
    """
    import re  # noqa: PLC0415 - tiny stdlib import, keep local like the engines

    match = re.search(r"\[([-+0-9.eE]+)\s+([-+0-9.eE]+)\]", reason)
    if match:
        try:
            return (float(match.group(1)), float(match.group(2)))
        except ValueError:
            pass
    return _first_coordinate(geom)


def _check_validity(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Report features with invalid geometry as a marker point layer.

    Mirrors the client tool: each invalid feature produces one point feature
    with ``feature_index`` and a ``detail`` message. Unlike the DuckDB client
    engine (a bare valid/invalid verdict), Shapely's ``explain_validity``
    supplies the reason and, when GEOS embeds one, the problem location.
    """
    from shapely.validation import explain_validity  # noqa: PLC0415

    gdf = _load_gdf(geojson, "Input layer")
    markers: list[dict] = []
    missing = 0
    invalid = 0
    for index, geom in enumerate(gdf.geometry):
        if geom is None or geom.is_empty:
            missing += 1
            continue
        if geom.is_valid:
            continue
        # Count the feature as invalid even when no marker location can be
        # resolved, so the summary never understates the problem.
        invalid += 1
        reason = explain_validity(geom)
        anchor = _validity_anchor(reason, geom)
        if anchor is None:
            continue
        markers.append(
            {
                "type": "Feature",
                "properties": {"feature_index": index, "detail": reason},
                "geometry": {"type": "Point", "coordinates": list(anchor)},
            }
        )
    checked = len(gdf) - missing
    message = f"Checked {checked} feature(s): {invalid} invalid"
    if missing:
        message += f", {missing} without geometry"
    messages = [message]
    if invalid == 0:
        messages.append("No invalid geometries found")
    return {"type": "FeatureCollection", "features": markers}, messages


def _fix_geometries(
    geojson: Optional[dict], overlay: Optional[dict], parameters: dict[str, Any]
) -> tuple[dict, list[str]]:
    """Repair invalid geometries with ``make_valid``; valid features pass through.

    A repair that raises or produces empty geometry leaves the original
    geometry unchanged (and is counted), matching the client tool's behavior.
    """
    from shapely.validation import make_valid  # noqa: PLC0415

    gdf = _load_gdf(geojson, "Input layer")
    fixed = 0
    unfixable = 0

    def _repair(geom: Any) -> Any:
        nonlocal fixed, unfixable
        if geom is None or geom.is_empty or geom.is_valid:
            return geom
        try:
            repaired = make_valid(geom)
        except Exception:  # noqa: BLE001 - keep the original geometry
            unfixable += 1
            return geom
        if repaired is None or repaired.is_empty:
            unfixable += 1
            return geom
        fixed += 1
        return repaired

    gdf["geometry"] = gdf.geometry.apply(_repair)
    if fixed == 0 and unfixable == 0:
        message = "All geometries are already valid — nothing to fix"
    else:
        message = f"Fixed {fixed} invalid geometr{'y' if fixed == 1 else 'ies'}"
        if unfixable:
            message += f"; {unfixable} could not be repaired and were left unchanged"
    return _to_feature_collection(gdf), [message]


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
    "attribute-join": _attribute_join,
    "select-by-value": _select_by_value,
    "select-by-location": _select_by_location,
    "reproject": _reproject,
    "explode": _explode,
    "aggregate": _aggregate,
    "smooth": _smooth,
    "voronoi": _voronoi,
    "check-validity": _check_validity,
    "fix-geometries": _fix_geometries,
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
