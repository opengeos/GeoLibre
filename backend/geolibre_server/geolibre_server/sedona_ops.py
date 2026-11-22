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

import concurrent.futures
import json
import logging
import math
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

WGS84 = "EPSG:4326"

# Wall-clock budget for a single SQL statement (execute + materialise). Mirrors
# the PostGIS ``_STATEMENT_TIMEOUT_MS`` so both engines expose a consistent cap.
# Uses ``concurrent.futures`` rather than SedonaDB/DataFusion session config
# because the Rust engine exposes no timeout knob to Python today.
_STATEMENT_TIMEOUT_MS = 60_000

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


class SqlTimeout(Exception):
    """Raised when a SQL statement exceeds :data:`_STATEMENT_TIMEOUT_MS`."""


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


_FORBIDDEN_FILE_TABLE_FUNCTIONS = re.compile(
    r"\b(?:read_parquet|read_csv|read_json|read_avro|read_arrow|parquet_scan|csv_scan)\s*\(",
    re.IGNORECASE,
)
_ALLOWED_LEADING_KEYWORDS = frozenset({"SELECT", "WITH", "VALUES", "EXPLAIN"})


def _strip_sql_comments_and_strings(sql: str) -> tuple[str, bool]:
    """Return SQL with comments stripped and string literals blanked, plus multi-stmt flag."""
    out: list[str] = []
    i = 0
    n = len(sql)
    saw_semicolon = False
    has_trailing_after_semicolon = False
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        # Single-line comment
        if ch == "-" and nxt == "-":
            i += 2
            while i < n and sql[i] != "\n":
                i += 1
            out.append(" ")
            continue
        # Block comment
        if ch == "/" and nxt == "*":
            i += 2
            depth = 1
            while i < n and depth > 0:
                if sql[i] == "/" and i + 1 < n and sql[i + 1] == "*":
                    depth += 1
                    i += 2
                elif sql[i] == "*" and i + 1 < n and sql[i + 1] == "/":
                    depth -= 1
                    i += 2
                else:
                    i += 1
            out.append(" ")
            continue
        # Single-quoted string literal
        if ch == "'":
            if saw_semicolon:
                has_trailing_after_semicolon = True
            i += 1
            while i < n:
                if sql[i] == "'" and i + 1 < n and sql[i + 1] == "'":
                    i += 2
                elif sql[i] == "'":
                    i += 1
                    break
                else:
                    i += 1
            out.append("''")
            continue
        # Double-quoted or backtick-quoted identifier
        if ch in {'"', "`"}:
            quote = ch
            if saw_semicolon:
                has_trailing_after_semicolon = True
            i += 1
            start = i
            while i < n:
                if sql[i] == quote and i + 1 < n and sql[i + 1] == quote:
                    i += 2
                elif sql[i] == quote:
                    end = i
                    i += 1
                    break
                else:
                    i += 1
            else:
                end = n
            ident = sql[start:end]
            # Mark path-like quoted identifiers (containing /, \, or .) so
            # FROM/JOIN checks reject file table references like "/etc/passwd",
            # `/tmp/private.parquet`, or "data.parquet" while still allowing
            # ordinary quoted layer names.
            if "/" in ident or "\\" in ident or "." in ident:
                out.append('"/"')
            else:
                out.append('""')
            continue
        if ch == ";":
            if saw_semicolon:
                has_trailing_after_semicolon = True
            saw_semicolon = True
            out.append(";")
            i += 1
            continue
        if saw_semicolon and not ch.isspace():
            has_trailing_after_semicolon = True
        out.append(ch)
        i += 1
    return "".join(out), has_trailing_after_semicolon


_CLAUSE_END_KEYWORDS = frozenset(
    {
        "WHERE",
        "GROUP",
        "HAVING",
        "ORDER",
        "LIMIT",
        "OFFSET",
        "FETCH",
        "UNION",
        "INTERSECT",
        "EXCEPT",
        "WINDOW",
        "QUALIFY",
        "SET",
        "VALUES",
        "SELECT",
        "WITH",
    }
)


def _has_string_table_reference(stripped_sql: str) -> bool:
    """Return True if a quoted file-path literal/identifier appears as a table ref in FROM/JOIN."""
    # Tokenize words (including `$` allowed by DataFusion identifiers), blanked
    # single-quoted strings (''), path-like quoted identifiers ("/"), commas,
    # dots (for qualified names like parquet.`/path`), and parentheses.
    tokens = re.findall(r"''|\"/\"|[A-Za-z_][A-Za-z0-9_$]*|[(),.]", stripped_sql)
    depth = 0
    # Maps paren depth -> state of the FROM/JOIN clause active at that depth:
    # - "expect": expecting a table reference next
    # - "after_table": just read a table identifier (a following `.` continues it)
    # - "rest": inside alias or ON/USING clause until `,` or clause end
    from_depths: dict[int, str] = {}
    for tok in tokens:
        upper = tok.upper()
        if tok == "(":
            was_expecting = from_depths.get(depth) == "expect"
            if depth in from_depths:
                from_depths[depth] = "rest"
            depth += 1
            if was_expecting:
                # Could be a parenthesized table/join (e.g. FROM ('/etc/passwd'))
                # or a derived subquery (FROM (SELECT ...)). If SELECT/WITH/VALUES
                # follows, _CLAUSE_END_KEYWORDS clears this inner depth while
                # keeping the outer FROM depth active.
                from_depths[depth] = "expect"
            continue
        if tok == ")":
            from_depths.pop(depth, None)
            depth = max(0, depth - 1)
            continue
        if upper in {"FROM", "JOIN"}:
            from_depths[depth] = "expect"
            continue
        if depth not in from_depths:
            continue
        if tok == ",":
            from_depths[depth] = "expect"
            continue
        if tok == ".":
            if from_depths[depth] == "after_table":
                from_depths[depth] = "expect"
            continue
        if upper in _CLAUSE_END_KEYWORDS:
            from_depths.pop(depth, None)
            continue
        if tok in {"''", '"/"'} and from_depths[depth] == "expect":
            return True
        if upper in {"ONLY", "LATERAL"} and from_depths[depth] == "expect":
            continue
        from_depths[depth] = "after_table" if from_depths[depth] == "expect" else "rest"
    return False


def _validate_read_only_sql(sql: str) -> None:
    """Ensure only a single read-only query statement is executed on SedonaDB."""
    stripped, has_multiple = _strip_sql_comments_and_strings(sql)
    if has_multiple:
        raise ValueError("Only a single SQL statement is allowed.")
    tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", stripped)
    if not tokens:
        raise ValueError("A SQL statement is required.")
    first = tokens[0].upper()
    if first not in _ALLOWED_LEADING_KEYWORDS:
        raise ValueError("Only read-only SELECT, WITH, VALUES, or EXPLAIN queries are supported.")
    if first == "EXPLAIN":
        idx = 1
        while idx < len(tokens) and tokens[idx].upper() in {"ANALYZE", "VERBOSE", "FORMAT"}:
            idx += 2 if tokens[idx].upper() == "FORMAT" else 1
        if idx >= len(tokens) or tokens[idx].upper() not in {"SELECT", "WITH", "VALUES"}:
            raise ValueError(
                "EXPLAIN is only allowed for read-only SELECT, WITH, or VALUES queries."
            )
    if _FORBIDDEN_FILE_TABLE_FUNCTIONS.search(stripped):
        raise ValueError("Direct filesystem table functions are not allowed in Sedona SQL.")
    if _has_string_table_reference(stripped):
        raise ValueError("Direct file paths in FROM/JOIN clauses are not allowed in Sedona SQL.")


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
        SqlInputTooLarge: A layer or the query result exceeds :data:`MAX_FEATURES`.
        ValueError: Invalid input.
        Exception: Whatever SedonaDB raises for an invalid SQL statement.
    """
    _validate_read_only_sql(sql)
    sedona_db = _import_sedona()
    import geopandas as gpd  # noqa: PLC0415

    connection = sedona_db.connect()
    future = None
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

        timeout_secs = _STATEMENT_TIMEOUT_MS / 1000

        def _execute():
            r = connection.sql(sql)
            r = r.limit(MAX_FEATURES + 1)
            return r.to_pandas()

        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            future = pool.submit(_execute)
            try:
                frame = future.result(timeout=timeout_secs)
            except concurrent.futures.TimeoutError:
                # No cancellation attempt: the pool has a single worker and a
                # single task, so by the time this fires ``_execute`` is already
                # running and ``future.cancel()`` would return False. The Rust
                # engine exposes no way to interrupt an in-flight query, so the
                # statement runs to completion and the ``finally`` block below
                # defers closing the connection until it does.
                raise SqlTimeout(
                    f"Spatial SQL timed out after {int(timeout_secs)} seconds"
                ) from None
        finally:
            pool.shutdown(wait=False)
        if len(frame) > MAX_FEATURES:
            # Input registration already caps each layer, but a query can still
            # expand rows (cross joins, generate_series, etc.). Bound the
            # response the same way vector/PostGIS paths bound payloads.
            raise SqlInputTooLarge(f"Query result exceeds the {MAX_FEATURES}-feature limit")
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
        def _close_connection(*_args: object) -> None:
            close = getattr(connection, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:  # noqa: BLE001 - best-effort cleanup
                    # A failed close can strand Rust-backed resources, so give
                    # operators a signal. The SQL text is deliberately omitted.
                    logger.warning("Failed to close the SedonaDB connection", exc_info=True)

        if future is not None and not future.done():
            future.add_done_callback(_close_connection)
        else:
            _close_connection()
