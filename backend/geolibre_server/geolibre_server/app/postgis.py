"""PostGIS read/write sidecar endpoints (psycopg).

These endpoints back the second phase of database write-back (issue #1070):
loading a PostGIS table as an editable WGS84 GeoJSON layer and committing the
edits back to the source table with per-row parameterized ``INSERT`` /
``UPDATE`` / ``DELETE`` statements keyed on the table's primary key, all inside
a single transaction.

psycopg (v3) is an optional dependency (the ``postgis`` extra): when it is not
installed, ``/postgis/status`` reports ``available: false`` and the desktop app
hides the editable-layer path, leaving the read-only Martin vector-tile flow.

Security posture:

- All identifiers (schema, table, columns) are resolved against the database
  catalogs and quoted with ``psycopg.sql.Identifier``; all values are bound as
  query parameters. Nothing from the request body is interpolated into SQL.
- Connection strings are used only for the duration of one request and are
  never logged or echoed back; error details are scrubbed of anything that
  looks like a password before they leave the sidecar.
- Writes are transactional: any failure rolls the whole commit back.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geolibre_server import vector_ops

router = APIRouter(prefix="/postgis", tags=["postgis"])
logger = logging.getLogger(__name__)

# Statement timeout applied to every sidecar-issued session so a bad query or
# an unresponsive server cannot pin a FastAPI worker thread indefinitely.
_STATEMENT_TIMEOUT_MS = 60_000

# Username is optional (postgresql://:pw@host relies on PGUSER), so the group
# is zero-or-more: an empty username must not let the password through. The
# password segment matches greedily to the LAST @ in the token so an unescaped
# literal @ inside a pasted password is fully redacted (leaning toward
# over-redaction of the host rather than a partial password leak).
_PASSWORD_URL_RE = re.compile(r"(://[^:/\s@]*:)[^\s]+@")
_PASSWORD_KV_RE = re.compile(r"(password\s*=\s*)('[^']*'|[^\s]+)", re.IGNORECASE)


def psycopg_import_error() -> Optional[str]:
    """Return the psycopg import error message, or None if it imports cleanly.

    Mirrors :func:`geolibre_server.vector_ops.geopandas_import_error` so callers
    can log *why* the PostGIS runtime is unavailable.
    """
    try:
        import psycopg  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - report any import failure
        return str(exc)
    return None


def _import_psycopg() -> Any:
    import psycopg
    import psycopg.types.json  # noqa: F401 - make psycopg.types.json.Json reachable

    return psycopg


def _sanitize_error(message: str) -> str:
    """Scrub password material from an error message before returning it.

    psycopg errors normally do not include credentials, but a malformed
    connection string can be echoed back verbatim by the URL parser, so every
    outbound detail is scrubbed of ``user:password@`` URL segments and
    ``password=...`` keyword pairs.
    """
    scrubbed = _PASSWORD_URL_RE.sub(r"\1****@", message)
    return _PASSWORD_KV_RE.sub(r"\1****", scrubbed)


class PostgisTablesRequest(BaseModel):
    """Request body for listing the editable spatial tables of a database."""

    connection: str


class PostgisReadRequest(BaseModel):
    """Request body for reading one PostGIS table as WGS84 GeoJSON."""

    connection: str
    schema_name: str = "public"
    table: str


class PostgisWriteRequest(BaseModel):
    """Request body for committing edited features back to a PostGIS table."""

    connection: str
    schema_name: str = "public"
    table: str
    geojson: dict
    # Primary-key values the edit session started from (the last read). When
    # provided, deletions are scoped to these keys, so rows inserted by another
    # session between the read and this save survive. When omitted, every row
    # absent from the payload is deleted (full-table diff).
    baseline_keys: Optional[list] = None


def _connect(connection: str) -> Any:
    """Open a psycopg connection with a bounded statement timeout.

    Args:
        connection: A libpq connection string (URI or keyword/value form).

    Returns:
        An open psycopg connection.

    Raises:
        HTTPException: The connection string is empty or the connection fails.
    """
    if not connection or not connection.strip():
        raise HTTPException(status_code=400, detail="connection is required")
    psycopg = _import_psycopg()
    try:
        return psycopg.connect(
            connection.strip(),
            connect_timeout=10,
            options=f"-c statement_timeout={_STATEMENT_TIMEOUT_MS}",
        )
    except Exception as exc:  # noqa: BLE001 - surface a stable, scrubbed error
        raise HTTPException(
            status_code=400,
            detail=f"Could not connect to PostgreSQL: {_sanitize_error(str(exc))}",
        ) from exc


def _table_info(conn: Any, schema: str, table: str) -> dict[str, Any]:
    """Resolve geometry column, SRID, primary key and columns from the catalogs.

    The client only names the schema and table; every identifier used in the
    generated SQL comes from the database's own catalogs, so a request cannot
    smuggle SQL through column names.

    Args:
        conn: An open psycopg connection.
        schema: Schema name as stored in ``geometry_columns``.
        table: Table name as stored in ``geometry_columns``.

    Returns:
        A dict with ``geometry_column``, ``srid``, ``primary_key`` (None when
        the table has no usable single-column key), ``pk_is_generated`` and
        ``columns`` (non-geometry column names, in table order).

    Raises:
        HTTPException: The table is not a registered spatial table.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT f_geometry_column, srid
            FROM geometry_columns
            WHERE f_table_schema = %s AND f_table_name = %s
            ORDER BY f_geometry_column
            """,
            (schema, table),
        )
        geom_rows = cur.fetchall()
        if not geom_rows:
            raise HTTPException(
                status_code=404,
                detail=f"Spatial table not found: {schema}.{table}",
            )
        geometry_column, srid = geom_rows[0][0], int(geom_rows[0][1] or 0)
        # A table can register several geometry columns; the layer edits only
        # the first, and the others must not leak into the attribute list (they
        # would be read as WKB hex and written back as text).
        all_geometry_columns = {row[0] for row in geom_rows}

        # Single-column primary key, if any. Composite keys are unsupported for
        # write-back (reported as no key), matching the issue's MVP scope.
        cur.execute(
            """
            SELECT a.attname,
                   (a.attidentity <> '' OR a.atthasdef) AS has_default,
                   a.attidentity = 'a' AS always_identity
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
            WHERE i.indisprimary AND n.nspname = %s AND c.relname = %s
            """,
            (schema, table),
        )
        pk_rows = cur.fetchall()
        primary_key = pk_rows[0][0] if len(pk_rows) == 1 else None
        pk_is_generated = bool(pk_rows[0][1]) if len(pk_rows) == 1 else False
        pk_always_identity = bool(pk_rows[0][2]) if len(pk_rows) == 1 else False

        cur.execute(
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY ordinal_position
            """,
            (schema, table),
        )
        column_rows = [row for row in cur.fetchall() if row[0] not in all_geometry_columns]
        columns = [name for name, _ in column_rows]
        # data_type distinguishes native arrays ('ARRAY') from json/jsonb, so
        # the write path can bind a Python list correctly for each.
        column_types = dict(column_rows)

    return {
        "geometry_column": geometry_column,
        "srid": srid,
        "primary_key": primary_key,
        "pk_is_generated": pk_is_generated,
        "pk_always_identity": pk_always_identity,
        "columns": columns,
        "column_types": column_types,
    }


@router.get("/status")
def postgis_status() -> dict[str, Any]:
    """Return PostGIS runtime (psycopg) availability."""
    import_error = psycopg_import_error()
    if import_error is None:
        return {
            "available": True,
            "message": "PostGIS runtime (psycopg) is available.",
        }
    logger.info("psycopg runtime unavailable: %s", import_error)
    return {
        "available": False,
        "message": "PostGIS runtime (psycopg) is not installed.",
    }


def _require_psycopg() -> None:
    import_error = psycopg_import_error()
    if import_error is not None:
        logger.info("psycopg runtime unavailable: %s", import_error)
        raise HTTPException(
            status_code=503,
            detail="psycopg is not installed in the sidecar.",
        )


@router.post("/tables")
def postgis_tables(request: PostgisTablesRequest) -> dict[str, Any]:
    """List the spatial tables of a database with their write-back readiness.

    A plain ``def`` (like the vector endpoints): psycopg is synchronous, so
    FastAPI dispatches this to its thread pool.
    """
    _require_psycopg()
    try:
        with _connect(request.connection) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT f_table_schema, f_table_name, f_geometry_column,
                           srid, type
                    FROM geometry_columns
                    ORDER BY f_table_schema, f_table_name, f_geometry_column
                    """
                )
                rows = cur.fetchall()
                cur.execute(
                    """
                    SELECT n.nspname, c.relname, min(a.attname), count(*)
                    FROM pg_index i
                    JOIN pg_class c ON c.oid = i.indrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    JOIN pg_attribute a
                        ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
                    WHERE i.indisprimary
                    GROUP BY n.nspname, c.relname
                    """
                )
                pk_by_table = {
                    (schema, table): pk if count == 1 else None
                    for schema, table, pk, count in cur.fetchall()
                }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface a stable, scrubbed error
        logger.error("PostGIS table listing failed: %s", _sanitize_error(str(exc)))
        raise HTTPException(
            status_code=400,
            detail=f"Could not list tables: {_sanitize_error(str(exc))}",
        ) from exc

    tables = [
        {
            "schema": schema,
            "table": table,
            "geometry_column": geometry_column,
            "srid": int(srid or 0),
            "geometry_type": geometry_type,
            "primary_key": pk_by_table.get((schema, table)),
        }
        for schema, table, geometry_column, srid, geometry_type in rows
    ]
    return {"tables": tables}


def _json_safe(value: Any) -> Any:
    """Convert a database cell to a JSON-serializable value.

    Recurses into containers so e.g. a ``date[]`` array column serializes as a
    list of ISO strings rather than failing JSON encoding.
    """
    if value is None or isinstance(value, (bool, float, str)):
        return value
    if isinstance(value, int):
        # Integers beyond JavaScript's safe range would be silently rounded by
        # the client's JSON.parse — fatal for a bigint primary key, whose
        # rounded value would no longer match any row on write-back. Serialize
        # such values as strings (like uuid/date already are).
        return value if -(2**53) < value < 2**53 else str(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (bytes, memoryview)):
        return bytes(value).hex()
    # datetime/date/time/Decimal/UUID and anything else stringify cleanly.
    return str(value)


@router.post("/read")
def postgis_read(request: PostgisReadRequest) -> dict[str, Any]:
    """Read a PostGIS table as a WGS84 GeoJSON FeatureCollection.

    Geometries are transformed to EPSG:4326 server-side (the app stores and
    edits every vector layer as WGS84 GeoJSON). The primary-key value is kept
    both as ``feature.id`` and as a property so edits round-trip through the
    write endpoint keyed on it.
    """
    _require_psycopg()
    psycopg = _import_psycopg()
    sql = psycopg.sql

    try:
        with _connect(request.connection) as conn:
            info = _table_info(conn, request.schema_name, request.table)
            geom = sql.Identifier(info["geometry_column"])
            # A zero/unknown SRID cannot be transformed; serve the coordinates
            # as stored (the common convention for srid 0 data is lon/lat
            # already).
            geom_expr = (
                sql.SQL("ST_AsGeoJSON(ST_Transform({geom}, 4326))").format(geom=geom)
                if info["srid"] not in (0, 4326)
                else sql.SQL("ST_AsGeoJSON({geom})").format(geom=geom)
            )
            column_list = sql.SQL(", ").join(
                [geom_expr] + [sql.Identifier(column) for column in info["columns"]]
            )
            query = sql.SQL("SELECT {columns} FROM {schema}.{table} LIMIT %s").format(
                columns=column_list,
                schema=sql.Identifier(request.schema_name),
                table=sql.Identifier(request.table),
            )
            with conn.cursor() as cur:
                # Over-fetch by one row to distinguish "exactly at the cap"
                # from "the table is larger than the cap".
                cur.execute(query, (vector_ops.MAX_FEATURES + 1,))
                rows = cur.fetchall()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface a stable, scrubbed error
        logger.error(
            "PostGIS read of %s.%s failed: %s",
            request.schema_name,
            request.table,
            _sanitize_error(str(exc)),
        )
        raise HTTPException(
            status_code=400,
            detail=f"Could not read table: {_sanitize_error(str(exc))}",
        ) from exc

    if len(rows) > vector_ops.MAX_FEATURES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Table exceeds the {vector_ops.MAX_FEATURES}-feature limit for editable layers"
            ),
        )

    pk = info["primary_key"]
    features = []
    for row in rows:
        properties = {column: _json_safe(value) for column, value in zip(info["columns"], row[1:])}
        feature: dict[str, Any] = {
            "type": "Feature",
            "geometry": json.loads(row[0]) if row[0] else None,
            "properties": properties,
        }
        if pk is not None and properties.get(pk) is not None:
            feature["id"] = properties[pk]
        features.append(feature)

    return {
        "geojson": {"type": "FeatureCollection", "features": features},
        "schema": request.schema_name,
        "table": request.table,
        "geometry_column": info["geometry_column"],
        "srid": info["srid"],
        "primary_key": pk,
        "feature_count": len(features),
    }


def _geometry_param(sql: Any, srid: int) -> Any:
    """Build the SQL expression that binds a GeoJSON geometry parameter.

    The bound value is GeoJSON text (WGS84). For a projected table the geometry
    is transformed back into the stored SRID so the source keeps its CRS,
    mirroring the GeoPackage write-back behavior.
    """
    if srid in (0, 4326):
        # ST_GeomFromGeoJSON yields SRID 4326; an srid-0 column needs the
        # geometry re-stamped as "unknown" or the typmod check rejects it.
        return sql.SQL("ST_SetSRID(ST_GeomFromGeoJSON(%s), {srid})").format(srid=sql.Literal(srid))
    return sql.SQL("ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), {srid})").format(
        srid=sql.Literal(srid)
    )


@router.post("/write")
def postgis_write(request: PostgisWriteRequest) -> dict[str, Any]:
    """Commit edited features back to the source PostGIS table.

    Diffs the incoming FeatureCollection against the table by primary key and
    issues parameterized statements in one transaction:

    - features whose primary-key property matches an existing row → ``UPDATE``
      (geometry plus every property that maps to a real column), skipped when
      the payload matches the stored row so untouched features are not
      rewritten (no spurious triggers/replication/MVCC churn);
    - features without a primary-key value → ``INSERT`` (the key comes from the
      column's identity/default);
    - rows whose key is absent from the payload → ``DELETE``, scoped to the
      session's ``baseline_keys`` when provided so concurrently inserted rows
      survive.

    Any failure rolls the entire commit back. Properties that do not match a
    table column are skipped and reported in ``messages`` (adding columns is a
    schema change the editor does not perform).
    """
    _require_psycopg()
    psycopg = _import_psycopg()
    sql = psycopg.sql

    features = request.geojson.get("features") if request.geojson else None
    if not isinstance(features, list) or not features:
        raise HTTPException(status_code=400, detail="No features to write.")
    if len(features) > vector_ops.MAX_FEATURES:
        raise HTTPException(
            status_code=413,
            detail=f"Layer exceeds the {vector_ops.MAX_FEATURES}-feature limit",
        )

    with _connect(request.connection) as conn:
        info = _table_info(conn, request.schema_name, request.table)
        pk = info["primary_key"]
        if pk is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{request.schema_name}.{request.table} has no single-column "
                    "primary key; write-back requires one."
                ),
            )

        writable = [column for column in info["columns"] if column != pk]
        writable_set = set(writable)
        schema_ident = sql.Identifier(request.schema_name)
        table_ident = sql.Identifier(request.table)
        geom_ident = sql.Identifier(info["geometry_column"])
        geom_param = _geometry_param(sql, info["srid"])

        skipped: set[str] = set()
        inserted = updated = 0
        try:
            with conn.cursor() as cur:
                # The diff needs the table's full key set in memory; refuse
                # tables beyond the editable-layer cap (such a table could not
                # have been loaded through /read either), bounding both this
                # query and the set below.
                cur.execute(
                    sql.SQL("SELECT count(*) FROM {schema}.{table}").format(
                        schema=schema_ident, table=table_ident
                    )
                )
                if cur.fetchone()[0] > vector_ops.MAX_FEATURES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"Table exceeds the {vector_ops.MAX_FEATURES}-feature "
                            "limit for editable write-back"
                        ),
                    )
                # Read the current rows (geometry serialized exactly as /read
                # serves it) so unchanged features can be skipped instead of
                # rewritten: the client always sends the whole layer, and
                # blind updates would fire triggers, churn replication, and
                # bloat MVCC for rows the user never touched. Values are
                # normalized the same way /read serializes them, so
                # comparisons against the client's JSON-native payload match.
                geom_expr = (
                    sql.SQL("ST_AsGeoJSON(ST_Transform({geom}, 4326))").format(geom=geom_ident)
                    if info["srid"] not in (0, 4326)
                    else sql.SQL("ST_AsGeoJSON({geom})").format(geom=geom_ident)
                )
                cur.execute(
                    sql.SQL("SELECT {pk}, {geom_expr}, {columns} FROM {schema}.{table}").format(
                        pk=sql.Identifier(pk),
                        geom_expr=geom_expr,
                        columns=sql.SQL(", ").join(
                            sql.Identifier(column) for column in info["columns"]
                        ),
                        schema=schema_ident,
                        table=table_ident,
                    )
                )
                existing_rows: dict[Any, tuple[Any, dict[str, Any]]] = {}
                for row in cur.fetchall():
                    existing_rows[_json_safe(row[0])] = (
                        json.loads(row[1]) if row[1] else None,
                        {
                            column: _json_safe(value)
                            for column, value in zip(info["columns"], row[2:])
                        },
                    )
                existing_keys = set(existing_rows)

                kept_keys: set[Any] = set()
                # Pipeline mode batches the per-feature statements into a few
                # network round trips instead of one per feature. The counters
                # track the taken branch (a keyed UPDATE matches exactly one
                # row by construction) because reading rowcount per statement
                # would force a sync each time. Known gap: a row deleted by
                # another session after the snapshot above makes its UPDATE
                # match zero rows yet still count as updated — detecting that
                # is part of the conflict-detection follow-up (issue #1070).
                with conn.pipeline():
                    for feature in features:
                        properties = feature.get("properties") or {}
                        skipped.update(
                            key for key in properties if key not in writable_set and key != pk
                        )
                        columns = [c for c in writable if c in properties]
                        # dicts and lists bind as json/jsonb — except a list
                        # aimed at a native array column (data_type 'ARRAY'),
                        # which psycopg's array adapter must handle instead.
                        values = [
                            properties[c]
                            if isinstance(properties[c], list)
                            and info["column_types"].get(c) == "ARRAY"
                            else psycopg.types.json.Json(properties[c])
                            if isinstance(properties[c], (dict, list))
                            else properties[c]
                            for c in columns
                        ]
                        geometry = feature.get("geometry")
                        geometry_value = json.dumps(geometry) if geometry else None

                        # A null primary-key property must not shadow feature.id
                        # (the read endpoint sets both, but editors may blank the
                        # property while the feature id survives).
                        key = properties.get(pk)
                        if key is None:
                            key = feature.get("id")
                        if key is None and not info["pk_is_generated"]:
                            raise HTTPException(
                                status_code=400,
                                detail=(
                                    f"Feature without a '{pk}' value cannot be "
                                    f"inserted: {request.schema_name}."
                                    f"{request.table}'s primary key has no "
                                    "default or identity."
                                ),
                            )
                        if key is not None and key in existing_keys:
                            kept_keys.add(key)
                            # Skip rows whose payload matches what is stored:
                            # untouched features must not be rewritten.
                            stored_geometry, stored_values = existing_rows[key]
                            if geometry == stored_geometry and all(
                                properties[column] == stored_values.get(column)
                                for column in columns
                            ):
                                continue
                            assignments = [
                                sql.SQL("{col} = ").format(col=geom_ident)
                                + (geom_param if geometry_value is not None else sql.SQL("NULL"))
                            ]
                            params: list[Any] = (
                                [geometry_value] if geometry_value is not None else []
                            )
                            for column, value in zip(columns, values):
                                assignments.append(
                                    sql.SQL("{col} = %s").format(col=sql.Identifier(column))
                                )
                                params.append(value)
                            params.append(key)
                            cur.execute(
                                sql.SQL(
                                    "UPDATE {schema}.{table} SET {assignments} WHERE {pk} = %s"
                                ).format(
                                    schema=schema_ident,
                                    table=table_ident,
                                    assignments=sql.SQL(", ").join(assignments),
                                    pk=sql.Identifier(pk),
                                ),
                                params,
                            )
                            updated += 1
                        else:
                            # New feature: the key column is left to its identity
                            # / default. A non-null key that is not in the table
                            # is inserted explicitly so client-assigned keys
                            # survive; a GENERATED ALWAYS identity column rejects
                            # explicit values unless the insert overrides it.
                            insert_columns = list(columns)
                            insert_values = list(values)
                            overriding = sql.SQL("")
                            if key is not None:
                                insert_columns.append(pk)
                                insert_values.append(key)
                                kept_keys.add(key)
                                if info["pk_always_identity"]:
                                    overriding = sql.SQL(" OVERRIDING SYSTEM VALUE")
                            column_idents = [geom_ident] + [
                                sql.Identifier(column) for column in insert_columns
                            ]
                            value_exprs = [
                                geom_param if geometry_value is not None else sql.SQL("NULL")
                            ] + [sql.SQL("%s")] * len(insert_values)
                            params = (
                                [geometry_value] if geometry_value is not None else []
                            ) + insert_values
                            cur.execute(
                                sql.SQL(
                                    "INSERT INTO {schema}.{table} ({columns})"
                                    "{overriding} VALUES ({values})"
                                ).format(
                                    schema=schema_ident,
                                    table=table_ident,
                                    columns=sql.SQL(", ").join(column_idents),
                                    overriding=overriding,
                                    values=sql.SQL(", ").join(value_exprs),
                                ),
                                params,
                            )
                            inserted += 1

                # Scope deletions to the edit session's baseline when the
                # client provides one, so rows inserted concurrently by another
                # session are not swept away by an unrelated save.
                deletable = existing_keys
                if request.baseline_keys is not None:
                    deletable = existing_keys & set(request.baseline_keys)
                to_delete = sorted(deletable - kept_keys, key=lambda value: str(value))
                deleted = 0
                if to_delete:
                    # Compare as text so the (JSON-native) keys match uuid /
                    # numeric / date key columns; both sides render the same
                    # canonical form the /read endpoint serialized. Known edge:
                    # timestamp/timestamptz and float/real keys' Python str()
                    # can differ from Postgres's ::text rendering (e.g. '5.0'
                    # vs '5'), so such exotic keys may not match and their
                    # deletes silently no-op (the deleted count comes out
                    # lower than the client expects);
                    # integer/text/uuid/numeric/date keys all round-trip.
                    cur.execute(
                        sql.SQL("DELETE FROM {schema}.{table} WHERE {pk}::text = ANY(%s)").format(
                            schema=schema_ident,
                            table=table_ident,
                            pk=sql.Identifier(pk),
                        ),
                        ([str(value) for value in to_delete],),
                    )
                    deleted = cur.rowcount
            conn.commit()
        except HTTPException:
            conn.rollback()
            raise
        except Exception as exc:  # noqa: BLE001 - surface a stable, scrubbed error
            conn.rollback()
            # No logger.exception here: a traceback could embed the raw DSN
            # (e.g. a connection failure mid-commit), and this module promises
            # credentials never reach the logs. Log the scrubbed message only.
            logger.error(
                "PostGIS write-back to %s.%s failed: %s",
                request.schema_name,
                request.table,
                _sanitize_error(str(exc)),
            )
            raise HTTPException(
                status_code=400,
                detail=f"Write-back failed: {_sanitize_error(str(exc))}",
            ) from exc

    messages = [
        f"Saved {len(features)} feature(s) to {request.schema_name}.{request.table} "
        f"({inserted} inserted, {updated} updated, {deleted} deleted)"
    ]
    if skipped:
        messages.append("Skipped fields without a matching column: " + ", ".join(sorted(skipped)))

    return {
        "schema": request.schema_name,
        "table": request.table,
        "feature_count": len(features),
        "inserted": inserted,
        "updated": updated,
        "deleted": deleted,
        "messages": messages,
        # Structured list of the editor-added fields that had no matching
        # column, so clients can build their own (translated) warning instead
        # of parsing the prose in `messages`.
        "skipped_fields": sorted(skipped),
    }
