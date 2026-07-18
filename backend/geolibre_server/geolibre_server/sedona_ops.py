"""Spatial SQL via SedonaDB (``apache-sedona[db]``), framework-free.

SedonaDB is the single-node, Rust (Apache DataFusion + Arrow) engine of the
Apache Sedona project, exposed to Python by ``pip install "apache-sedona[db]"``.
This module is the sidecar twin of the browser CereusDB engine (a WebAssembly
build of the same SedonaDB core): both register each loaded layer as a named
view, run one SQL statement, and return rows (geometry rendered as WKT) plus a
GeoJSON FeatureCollection when the result carries a geometry column.

Like :mod:`geolibre_server.vector_ops`, it has **no FastAPI dependency** so the
HTTP boundary (``app/sql.py``) stays a thin wrapper that maps the exceptions
below to status codes. SedonaDB is imported lazily so ``/sql/status`` can report
``available: false`` when the optional ``sedona`` extra is not installed.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Optional

WGS84 = "EPSG:4326"

# Layer/view names must be plain SQL identifiers. The frontend already sanitises
# them, but `/sql/run` is an HTTP boundary that can be called directly, so the
# name is validated again here before it reaches ``to_view`` (defence in depth).
_SAFE_VIEW_NAME = re.compile(r"^[a-z_][a-z0-9_]*$")

# Cap the per-layer input size so a very large layer cannot exhaust memory while
# being materialised into a SedonaDB view. The sidecar maps SqlInputTooLarge to
# HTTP 413. Mirrors vector_ops.MAX_FEATURES.
MAX_FEATURES = 50_000


class SqlInputTooLarge(ValueError):
    """Raised when a registered layer exceeds :data:`MAX_FEATURES`.

    A :class:`ValueError` subclass so generic callers treat it as bad input,
    while the sidecar can catch it specifically to return HTTP 413.
    """


def _import_sedona() -> Any:
    """Import the SedonaDB Python module, raising ImportError if it is missing."""
    import sedona.db  # noqa: PLC0415

    return sedona.db


def sedonadb_import_error() -> Optional[str]:
    """Return the SedonaDB import error message, or None if it imports cleanly.

    Lets ``/sql/status`` log *why* the runtime is unavailable (a missing package
    vs. a subtler failure such as a compiled-extension ABI mismatch) instead of
    a generic "unavailable".
    """
    try:
        _import_sedona()
        return None
    except Exception as exc:  # noqa: BLE001 - report any import failure
        return str(exc)


def _json_safe(value: Any) -> Any:
    """Coerce a pandas/numpy cell value into a JSON-serialisable scalar.

    Mirrors the browser engine's ``normalizeValue``: NaN/inf become ``None``,
    numpy scalars unwrap to Python scalars, and date-like values serialise to
    ISO strings. Anything else falls back to ``str`` so the response always
    encodes cleanly.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (str, int)):
        return value
    # numpy scalar (np.int64, np.float64, ...): unwrap to a native Python scalar.
    item = getattr(value, "item", None)
    if callable(item):
        try:
            unwrapped = value.item()
        except Exception:  # noqa: BLE001 - fall through to the generic paths
            unwrapped = None
        if isinstance(unwrapped, float):
            return unwrapped if math.isfinite(unwrapped) else None
        if isinstance(unwrapped, (str, int, bool)) or unwrapped is None:
            return unwrapped
    # pandas Timestamp / datetime / date.
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        return value.isoformat()
    return str(value)


def _is_missing(value: Any) -> bool:
    """True for None or a NaN float (a missing geometry or attribute cell)."""
    return value is None or (isinstance(value, float) and math.isnan(value))


def run_sql(sql: str, layers: Optional[list[dict]] = None) -> dict:
    """Run a single spatial SQL statement against the registered layers.

    Each entry in ``layers`` is ``{"name": <view name>, "geojson": <FeatureCollection>}``.
    The ``name`` is used verbatim as the SedonaDB view name, so the caller is
    responsible for sending SQL-safe identifiers (the frontend reuses the same
    sanitised table names it shows the user).

    Args:
        sql: The SQL statement to execute (a single statement).
        layers: Layers to expose as named views; entries without features are
            skipped.

    Returns:
        A dict matching the frontend ``SqlQueryResult`` shape:
        ``{"columns": [...], "rows": [...], "geometry_column": str | None,
        "geojson": FeatureCollection | None}``. Geometry is rendered as WKT in
        ``rows`` and as GeoJSON in ``geojson``.

    Raises:
        SqlInputTooLarge: A layer exceeds :data:`MAX_FEATURES`.
        ValueError: Invalid input.
        Exception: Whatever SedonaDB raises for an invalid SQL statement.
    """
    sedona_db = _import_sedona()
    import geopandas as gpd  # noqa: PLC0415

    connection = sedona_db.connect()
    try:
        for layer in layers or []:
            name = str(layer.get("name") or "").strip()
            geojson = layer.get("geojson")
            if not name or not geojson:
                continue
            if not _SAFE_VIEW_NAME.match(name):
                raise ValueError(f"Invalid layer name: {name!r}")
            features = geojson.get("features") or []
            if len(features) > MAX_FEATURES:
                raise SqlInputTooLarge(f"Layer '{name}' exceeds the {MAX_FEATURES}-feature limit")
            if not features:
                # An empty layer registers no usable view; skip it rather than
                # fail the whole query (from_features rejects an empty list).
                continue
            gdf = gpd.GeoDataFrame.from_features(features, crs=WGS84)
            connection.create_data_frame(gdf).to_view(name)

        result = connection.sql(sql)
        # to_pandas() returns a GeoDataFrame when the result has a geometry
        # column, otherwise a plain DataFrame.
        frame = result.to_pandas()
        columns = [str(column) for column in frame.columns]

        geometry_column: Optional[str] = None
        if isinstance(frame, gpd.GeoDataFrame):
            try:
                geometry_column = frame.geometry.name
            except Exception:  # noqa: BLE001 - no active geometry column
                geometry_column = None

        geojson_out: Optional[dict] = None
        if geometry_column is not None:
            # GeoPandas only emits valid GeoJSON in WGS84; reproject if needed.
            gdf_out = frame
            if gdf_out.crs is not None and gdf_out.crs.to_epsg() != 4326:
                gdf_out = gdf_out.to_crs(WGS84)
            geojson_out = json.loads(gdf_out.to_json())

        rows: list[dict] = []
        for record in frame.to_dict(orient="records"):
            row: dict[str, Any] = {}
            for column in columns:
                value = record.get(column)
                if column == geometry_column:
                    # Render geometry as WKT for the grid (the GeoJSON path
                    # carries the real geometry); a null geometry stays null.
                    row[column] = None if _is_missing(value) else value.wkt
                else:
                    row[column] = _json_safe(value)
            rows.append(row)

        return {
            "columns": columns,
            "rows": rows,
            "geometry_column": geometry_column,
            "geojson": geojson_out,
        }
    finally:
        # SedonaDB connections are Rust-backed; release promptly rather than
        # waiting on GC. Tolerate bindings that expose no close().
        close = getattr(connection, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001 - best-effort cleanup
                pass
