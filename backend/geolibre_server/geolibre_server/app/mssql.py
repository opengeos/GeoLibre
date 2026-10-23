"""SQL Server and Azure SQL editable-layer sidecar endpoints."""

from __future__ import annotations

import datetime
import json
import logging
import os
import re
import secrets
import socket
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterator, Literal, Optional, Union

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .db_common import (
    allowlist_from_env,
    host_port_allowed,
    json_safe,
    normalize_host,
    plan_feature_diff,
    require_features,
    scrub_secrets,
)

router = APIRouter(prefix="/mssql", tags=["mssql"])
logger = logging.getLogger(__name__)
_MSSQL_HOSTS_ENV = "GEOLIBRE_MSSQL_HOSTS"
_DESKTOP_AUTH_ENV = "GEOLIBRE_MSSQL_DESKTOP_AUTH"
# Managed identity signs in as the *sidecar host's* Azure identity, not the
# caller's. Behind a shared proxy every browser user holds the same sidecar
# token, so allowing it there would hand any user the server's database
# rights. It is therefore desktop-only unless an operator opts in explicitly.
_ALLOW_MSI_ENV = "GEOLIBRE_MSSQL_ALLOW_MANAGED_IDENTITY"
_DEFAULT_PORT = 1433
_LOGIN_TIMEOUT_S = 10
_QUERY_TIMEOUT_S = 60
_REACHABILITY_TIMEOUT_S = 3
_GEOMETRY_SAMPLE_ROWS = 1000
# getaddrinfo cannot be cancelled, so a lookup the resolver never answers keeps
# its thread until the OS gives up. A small shared pool caps how many such
# threads failed connects can pile up; lookups queued behind them time out.
_DNS_PROBE_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mssql-dns-probe")
_INTERACTIVE_TIMEOUT_S = 300
_SESSION_IDLE_S = 8 * 3600
_MAX_SESSIONS = 32
_TOKEN_SCOPE = "https://database.windows.net/.default"
_SQL_COPT_SS_ACCESS_TOKEN = 1256
_SQL_SS_TIMESTAMPOFFSET = -155
_SQL_SS_TIME2 = -154
_SQL_TYPE_TIMESTAMP = 93
_PREFERRED_DRIVERS = ("ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server")
# `json_safe` stringifies these, but SQL Server will not implicitly cast the
# string back (nvarchar -> varbinary is error 257, and the six-digit microsecond
# form is error 241), so the write path rebinds them as native Python values.
_BINARY_COLUMN_TYPES = frozenset({"binary", "varbinary", "image"})
_TEMPORAL_COLUMN_TYPES = frozenset({"datetime", "smalldatetime", "date", "time"})
# pyproj Transformer objects are not documented as thread-safe, and FastAPI
# runs these sync endpoints in a thread pool, so serialize their use.
_TRANSFORM_LOCK = threading.Lock()


def pyodbc_import_error() -> Optional[str]:
    try:
        import pyodbc  # noqa: F401
    except Exception as exc:
        return str(exc)
    return None


def azure_identity_import_error() -> Optional[str]:
    try:
        import azure.identity  # noqa: F401
    except Exception as exc:
        return str(exc)
    return None


def _import_pyodbc() -> Any:
    import pyodbc

    return pyodbc


def _select_driver(pyodbc: Any) -> Optional[str]:
    available = set(pyodbc.drivers())
    return next((driver for driver in _PREFERRED_DRIVERS if driver in available), None)


def _managed_identity_allowed() -> bool:
    return os.environ.get(_DESKTOP_AUTH_ENV) == "1" or os.environ.get(_ALLOW_MSI_ENV) == "1"


def available_auth_methods() -> list[str]:
    methods = ["sql", "entra_password", "token"]
    azure = azure_identity_import_error() is None
    if azure:
        methods.append("entra_sp")
        if _managed_identity_allowed():
            methods.append("msi")
    if os.environ.get(_DESKTOP_AUTH_ENV) == "1":
        if azure:
            methods.append("entra_interactive")
        if sys.platform == "win32":
            methods.append("windows")
    return methods


@router.get("/status")
def mssql_status() -> dict[str, Any]:
    error = pyodbc_import_error()
    if error is not None:
        logger.info("pyodbc runtime unavailable: %s", error)
        return {
            "available": False,
            "message": "SQL Server runtime (pyodbc) is not installed.",
            "driver": None,
            "auth_methods": available_auth_methods(),
        }
    try:
        driver = _select_driver(_import_pyodbc())
    except Exception as exc:
        logger.info("SQL Server ODBC driver discovery failed: %s", exc)
        driver = None
    if driver is None:
        return {
            "available": False,
            "message": "Microsoft ODBC Driver 18 for SQL Server is not installed.",
            "driver": None,
            "auth_methods": available_auth_methods(),
        }
    return {
        "available": True,
        "message": f"SQL Server runtime is available ({driver}).",
        "driver": driver,
        "auth_methods": available_auth_methods(),
    }


def _require_runtime() -> tuple[Any, str]:
    if pyodbc_import_error() is not None:
        raise HTTPException(503, "pyodbc is not installed in the sidecar.")
    pyodbc = _import_pyodbc()
    driver = _select_driver(pyodbc)
    if driver is None:
        raise HTTPException(503, "Microsoft ODBC Driver for SQL Server is not installed.")
    return pyodbc, driver


def _odbc_value(value: Any) -> str:
    return "{" + str(value).replace("}", "}}") + "}"


def _parse_server(server: str) -> tuple[str, Optional[str]]:
    value = server.strip()
    if not value:
        raise HTTPException(400, "server is required")
    if any(c in value for c in ",;{}= ") or any(c.isspace() for c in value):
        raise HTTPException(
            400, "Server must be a hostname or IP address, optionally followed by \\\\instance"
        )
    parts = value.split("\\", 1)
    if len(parts) == 2 and (not parts[0] or not parts[1]):
        raise HTTPException(
            400, "Server must be a hostname or IP address, optionally followed by \\\\instance"
        )
    try:
        host = normalize_host(parts[0])
    except (ValueError, TypeError):
        raise HTTPException(
            400, "Server must be a hostname or IP address, optionally followed by \\\\instance"
        ) from None
    return host, parts[1] if len(parts) == 2 else None


AuthMethod = Literal[
    "sql", "windows", "entra_password", "entra_sp", "entra_interactive", "msi", "token"
]


class MssqlAuth(BaseModel):
    method: AuthMethod
    username: Optional[str] = None
    password: Optional[str] = None
    tenant_id: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    access_token: Optional[str] = None


class MssqlConnectRequest(BaseModel):
    server: str
    port: int = _DEFAULT_PORT
    database: str
    encrypt: bool = True
    trust_server_certificate: bool = False
    auth: MssqlAuth


class MssqlSessionRequest(BaseModel):
    session_id: str


class MssqlReadRequest(BaseModel):
    session_id: str
    schema_name: str = "dbo"
    table: str
    geometry_column: Optional[str] = None
    excluded_fields: list[str] = []


class MssqlChangedColumns(BaseModel):
    """Columns the client edited since load for one existing row."""

    key: Union[int, str]
    columns: list[str]


class MssqlWriteRequest(BaseModel):
    session_id: str
    schema_name: str = "dbo"
    table: str
    geometry_column: Optional[str] = None
    geojson: dict
    baseline_keys: Optional[list] = None
    capabilities: Optional[dict[str, bool]] = None
    unchanged_geometry_keys: Optional[list] = None
    changed_columns: Optional[list[MssqlChangedColumns]] = None


def _build_connection_string(
    driver: str,
    host: str,
    instance: Optional[str],
    port: int,
    database: str,
    encrypt: bool,
    trust: bool,
    auth: MssqlAuth,
) -> str:
    server = _odbc_value(f"{host}\\{instance}") if instance else f"tcp:{host},{port}"
    pieces = [
        f"DRIVER={_odbc_value(driver)}",
        f"SERVER={server}",
        f"DATABASE={_odbc_value(database)}",
        f"Encrypt={'yes' if encrypt else 'no'}",
        f"TrustServerCertificate={'yes' if trust else 'no'}",
        f"Connection Timeout={_LOGIN_TIMEOUT_S}",
        "APP=GeoLibre",
    ]
    if auth.method == "sql":
        pieces.extend((f"UID={_odbc_value(auth.username)}", f"PWD={_odbc_value(auth.password)}"))
    elif auth.method == "entra_password":
        pieces.extend(
            (
                "Authentication=ActiveDirectoryPassword",
                f"UID={_odbc_value(auth.username)}",
                f"PWD={_odbc_value(auth.password)}",
            )
        )
    elif auth.method == "windows":
        pieces.append("Trusted_Connection=yes")
    return ";".join(pieces)


@dataclass
class _Session:
    connection_string: str
    credential: Any
    static_token: Optional[str]
    secrets: tuple[str, ...]
    last_used: float
    # Most recent access token fetched for this session, so later error
    # scrubbers cover it too (connect-time secrets alone would not).
    live_token: Optional[str] = None
    host: str = ""
    instance: Optional[str] = None
    port: int = _DEFAULT_PORT

    def sensitive(self) -> tuple[str, ...]:
        """Session secrets plus the most recently fetched access token."""
        return (*self.secrets, self.live_token) if self.live_token else self.secrets


_SESSIONS: dict[str, _Session] = {}
_SESSIONS_LOCK = threading.Lock()


def _datetimeoffset_to_str(raw: Any) -> Any:
    """Decode SQL_SS_TIMESTAMPOFFSET_STRUCT, which pyodbc cannot read natively."""
    if not isinstance(raw, (bytes, bytearray)):
        return raw
    year, month, day, hour, minute, second, nanos, tz_h, tz_m = struct.unpack("<6hI2h", raw)
    sign = "-" if tz_h < 0 or tz_m < 0 else "+"
    return (
        f"{year:04d}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}:{second:02d}."
        f"{nanos:09d} {sign}{abs(tz_h):02d}:{abs(tz_m):02d}"
    )


def _time2_to_str(raw: bytes) -> str:
    """Decode SQL_SS_TIME2_STRUCT keeping all seven fractional digits.

    pyodbc's default time path divides the nanosecond fraction down to
    microseconds, so an untouched time(7) column would be rewritten with its
    last digit lost whenever another column on the row is edited.
    """
    hour, minute, second, nanos = struct.unpack("@3HI", raw)
    return f"{hour:02d}:{minute:02d}:{second:02d}.{nanos // 100:07d}"


def _timestamp_to_str(raw: bytes) -> str:
    """Decode TIMESTAMP_STRUCT (datetime2/datetime/smalldatetime) to 7 digits."""
    year, month, day, hour, minute, second, nanos = struct.unpack("@h5HI", raw)
    return (
        f"{year:04d}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}:{second:02d}.{nanos // 100:07d}"
    )


def _trim_fraction(value: str) -> str:
    """Cut fractional seconds to microseconds so fromisoformat accepts them (3.10)."""
    return re.sub(r"(\.\d{6})\d+", r"\1", value)


def _unreachable_reason(host: str, instance: Optional[str], port: int) -> Optional[str]:
    # getaddrinfo has no timeout of its own; a hung resolver must not hold the
    # request thread, so an unanswered lookup leaves the driver message alone.
    lookup = _DNS_PROBE_EXECUTOR.submit(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    try:
        lookup.result(timeout=_REACHABILITY_TIMEOUT_S)
    except FutureTimeoutError:
        lookup.cancel()
        return None
    except (socket.gaierror, UnicodeError):
        # IDNA rejects empty or over-long labels before any DNS lookup.
        return f"The host name '{host}' could not be resolved"
    if instance is not None:
        return None
    try:
        with socket.create_connection((host, port), timeout=_REACHABILITY_TIMEOUT_S):
            return None
    except OSError:
        return f"Nothing is accepting connections at {host}:{port}"


def _open_connection(session: _Session) -> Any:
    pyodbc = _import_pyodbc()
    attrs = None
    if session.static_token is not None or session.credential is not None:
        try:
            token = session.static_token or session.credential.get_token(_TOKEN_SCOPE).token
            session.live_token = token
            raw = token.encode("utf-16-le")
            attrs = {_SQL_COPT_SS_ACCESS_TOKEN: struct.pack(f"<I{len(raw)}s", len(raw), raw)}
        except Exception as exc:
            raise HTTPException(
                400,
                f"Microsoft Entra sign-in failed: {scrub_secrets(str(exc), session.sensitive())}",
            ) from exc
    connected = False
    try:
        conn = pyodbc.connect(
            session.connection_string,
            timeout=_LOGIN_TIMEOUT_S,
            autocommit=False,
            **({"attrs_before": attrs} if attrs is not None else {}),
        )
        connected = True
        conn.timeout = _QUERY_TIMEOUT_S
        conn.add_output_converter(_SQL_SS_TIMESTAMPOFFSET, _datetimeoffset_to_str)
        conn.add_output_converter(_SQL_SS_TIME2, _time2_to_str)
        conn.add_output_converter(_SQL_TYPE_TIMESTAMP, _timestamp_to_str)
        return conn
    except Exception as exc:
        driver_message = scrub_secrets(str(exc), session.sensitive())
        reason = (
            _unreachable_reason(session.host, session.instance, session.port)
            if session.host and not connected
            else None
        )
        detail = (
            f"Could not connect to SQL Server: {reason}. Driver message: {driver_message}"
            if reason
            else f"Could not connect to SQL Server: {driver_message}"
        )
        raise HTTPException(400, detail) from exc


class MssqlWriteRolledBack(HTTPException):
    """Write-back failed before commit and rollback succeeded; the table is unchanged."""


async def mssql_write_rolled_back_handler(
    request: Request, exc: MssqlWriteRolledBack
) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "rolled_back": True},
    )


def _safe_rollback(conn: Any, secrets: tuple[str, ...]) -> bool:
    """Roll back without masking the write error that triggered the rollback.

    A broken connection (lost network, query timeout) raises from rollback()
    too; swallowing that keeps the original, scrubbed error and the 400 intact.
    """
    try:
        conn.rollback()
        return True
    except Exception as exc:
        logger.warning("SQL Server rollback failed: %s", scrub_secrets(str(exc), secrets))
        return False


@contextmanager
def _connection(session: _Session) -> Iterator[Any]:
    """Open an ODBC connection and always close it.

    pyodbc's connection context manager only wraps commit/rollback, so code
    that relies on ``with conn`` leaks the socket whenever an endpoint raises
    (notably on the 4xx paths, which are common).
    """
    conn = _open_connection(session)
    try:
        yield conn
    finally:
        conn.close()


def _get_session(session_id: str) -> _Session:
    now = time.monotonic()
    with _SESSIONS_LOCK:
        for key in [
            key for key, value in _SESSIONS.items() if now - value.last_used > _SESSION_IDLE_S
        ]:
            del _SESSIONS[key]
        session = _SESSIONS.get(session_id)
        if session is None:
            raise HTTPException(410, "Unknown or expired SQL Server session; reconnect.")
        session.last_used = now
        return session


def _credential(auth: MssqlAuth) -> Any:
    if auth.method == "token":
        return None
    if auth.method not in {"entra_sp", "entra_interactive", "msi"}:
        return None
    try:
        from azure.identity import (
            ClientSecretCredential,
            InteractiveBrowserCredential,
            ManagedIdentityCredential,
        )

        if auth.method == "entra_sp":
            return ClientSecretCredential(auth.tenant_id, auth.client_id, auth.client_secret)
        if auth.method == "entra_interactive":
            kwargs = {
                k: v for k, v in (("tenant_id", auth.tenant_id), ("client_id", auth.client_id)) if v
            }
            return InteractiveBrowserCredential(timeout=_INTERACTIVE_TIMEOUT_S, **kwargs)
        return ManagedIdentityCredential(
            **({"client_id": auth.client_id} if auth.client_id else {})
        )
    except Exception as exc:
        secrets_to_scrub = tuple(
            secret for secret in (auth.client_secret, auth.password, auth.access_token) if secret
        )
        detail = scrub_secrets(str(exc), secrets_to_scrub)
        raise HTTPException(400, f"Microsoft Entra sign-in failed: {detail}") from exc


def _validate_target(request: MssqlConnectRequest) -> tuple[str, Optional[str]]:
    host, instance = _parse_server(request.server)
    if not request.database.strip():
        raise HTTPException(400, "database is required")
    if not 1 <= request.port <= 65535:
        raise HTTPException(400, "Invalid SQL Server port")
    allowed = allowlist_from_env(
        _MSSQL_HOSTS_ENV, "SQL Server access is disabled; configure GEOLIBRE_MSSQL_HOSTS"
    )
    if allowed is not None and not host_port_allowed(
        allowed, host, None if instance else request.port
    ):
        raise HTTPException(403, "SQL Server host or port is not allowed")
    return host, instance


@router.post("/connect")
def mssql_connect(request: MssqlConnectRequest) -> dict[str, str]:
    pyodbc, driver = _require_runtime()
    host, instance = _validate_target(request)
    method = request.auth.method
    if method == "msi" and not _managed_identity_allowed():
        raise HTTPException(
            403,
            f"Managed identity authentication is disabled; set {_ALLOW_MSI_ENV}=1 to allow it",
        )
    if method not in available_auth_methods():
        if method in {"windows", "entra_interactive"} and os.environ.get(_DESKTOP_AUTH_ENV) != "1":
            raise HTTPException(
                403, "This authentication method is only available in GeoLibre Desktop"
            )
        if method == "windows" and sys.platform != "win32":
            raise HTTPException(
                400, "Windows authentication requires the sidecar to run on Windows"
            )
        raise HTTPException(503, "azure-identity is not installed in the sidecar.")
    required = {
        "sql": ("username", "password"),
        "entra_password": ("username", "password"),
        "entra_sp": ("tenant_id", "client_id", "client_secret"),
        "token": ("access_token",),
    }
    for field in required.get(method, ()):
        if not getattr(request.auth, field):
            raise HTTPException(400, f"{field} is required for {method} authentication")
    cs = _build_connection_string(
        driver,
        host,
        instance,
        request.port,
        request.database,
        request.encrypt,
        request.trust_server_certificate,
        request.auth,
    )
    credential = _credential(request.auth)
    static_token = request.auth.access_token if method == "token" else None
    secret_values = tuple(
        x
        for x in (request.auth.password, request.auth.client_secret, request.auth.access_token)
        if x
    )
    session = _Session(
        connection_string=cs,
        credential=credential,
        static_token=static_token,
        secrets=secret_values,
        last_used=time.monotonic(),
        host=host,
        instance=instance,
        port=request.port,
    )
    # The token is fetched once, inside the probe below: _open_connection signs
    # in and surfaces any credential error with the same scrubbed message.
    with _connection(session) as conn:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        except Exception as exc:
            raise HTTPException(
                400,
                f"Could not connect to SQL Server: {scrub_secrets(str(exc), session.sensitive())}",
            ) from exc
    sid = secrets.token_urlsafe(32)
    with _SESSIONS_LOCK:
        if len(_SESSIONS) >= _MAX_SESSIONS:
            oldest = min(_SESSIONS, key=lambda key: _SESSIONS[key].last_used)
            del _SESSIONS[oldest]
        _SESSIONS[sid] = session
    return {"session_id": sid}


@router.post("/disconnect")
def mssql_disconnect(request: MssqlSessionRequest) -> dict[str, bool]:
    with _SESSIONS_LOCK:
        _SESSIONS.pop(request.session_id, None)
    return {"ok": True}


def _q(name: str) -> str:
    return "[" + name.replace("]", "]]") + "]"


def _bind_value(value: Any, sql_type: str) -> Any:
    """Turn a client value back into a type SQL Server can bind.

    Reads run every column through ``json_safe``, so binary columns arrive as
    hex strings and temporal columns as ISO-ish strings. The unchanged values
    are copied into the diff, so both paths must restore the native type or the
    statement fails to bind (errors 257 and 241 respectively).
    """
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    if value is None or not isinstance(value, str):
        return value
    if sql_type in _BINARY_COLUMN_TYPES:
        try:
            return bytes.fromhex(value)
        except ValueError:
            raise HTTPException(400, f"Value for {sql_type} column is not valid hex") from None
    # Python 3.10's fromisoformat rejects a trailing "Z", which JavaScript's
    # Date.toISOString() emits, so normalize it before parsing.
    if sql_type == "date":
        try:
            return datetime.date.fromisoformat(value.removesuffix("Z"))
        except ValueError:
            raise HTTPException(400, "Value for date column is not a valid date") from None
    if sql_type == "time":
        try:
            # Validate only: pyodbc sends datetime.time as TIME_STRUCT, which
            # drops fractional seconds, so bind the string instead.
            datetime.time.fromisoformat(_trim_fraction(value.removesuffix("Z")))
            return value.removesuffix("Z")
        except ValueError:
            raise HTTPException(400, "Value for time column is not a valid time") from None
    if sql_type == "datetimeoffset":
        # Read back by _datetimeoffset_to_str in a form SQL Server parses.
        return value
    if sql_type == "datetime2":
        # Validate, but bind the string: a datetime object would cut the seventh
        # fractional digit that the read path preserved.
        try:
            datetime.datetime.fromisoformat(_trim_fraction(value.removesuffix("Z")))
            return value.removesuffix("Z")
        except ValueError:
            raise HTTPException(
                400, "Value for datetime2 column is not a valid timestamp"
            ) from None
    if sql_type in _TEMPORAL_COLUMN_TYPES:
        try:
            return datetime.datetime.fromisoformat(
                _trim_fraction(value[:-1] + "+00:00" if value.endswith("Z") else value)
            )
        except ValueError:
            raise HTTPException(
                400, f"Value for {sql_type} column is not a valid timestamp"
            ) from None
    return value


def _probe_geometry(
    cur: Any, schema: str, table: str, geometry_column: str
) -> tuple[Optional[int], list[str], bool]:
    geom = _q(geometry_column)
    cur.execute(
        f"SELECT sampled.srid, sampled.geometry_type, COUNT(*) FROM "
        f"(SELECT TOP ({_GEOMETRY_SAMPLE_ROWS}) {geom}.STSrid AS srid, "
        f"{geom}.STGeometryType() AS geometry_type FROM {_q(schema)}.{_q(table)} "
        f"WHERE {geom} IS NOT NULL) AS sampled "
        "GROUP BY sampled.srid, sampled.geometry_type ORDER BY COUNT(*) DESC"
    )
    rows = cur.fetchall()
    if not rows:
        return None, [], False
    srids = {int(row[0]) for row in rows}
    geometry_types = list(dict.fromkeys(row[1] for row in rows))
    return int(rows[0][0]), geometry_types, len(srids) > 1


def _table_info(
    cur: Any, schema: str, table: str, geometry_column: Optional[str] = None
) -> dict[str, Any]:
    cur.execute(
        """
        SELECT t.object_id
        FROM sys.tables t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = ? AND t.name = ?
        """,
        (schema, table),
    )
    obj = cur.fetchone()
    if obj is None:
        raise HTTPException(404, f"Spatial table not found: {schema}.{table}")
    object_id = obj[0]
    cur.execute(
        """
        SELECT c.name, ty.name, c.is_identity, c.default_object_id, c.is_computed
        FROM sys.columns c
        JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE c.object_id = ?
        ORDER BY c.column_id
        """,
        (object_id,),
    )
    rows = cur.fetchall()
    spatial = [r for r in rows if r[1] in ("geometry", "geography")]
    if not spatial:
        raise HTTPException(404, f"Spatial table not found: {schema}.{table}")
    if geometry_column is not None and not any(r[0] == geometry_column for r in spatial):
        raise HTTPException(
            400, f"Geometry column not found on {schema}.{table}: {geometry_column}"
        )
    selected = next(
        (r for r in spatial if r[0] == geometry_column), sorted(spatial, key=lambda r: r[0])[0]
    )
    geom, column_type = selected[0], selected[1]
    # A spatial column can contain several SRIDs and geometry types. Keep a
    # representative SRID for the layer while exposing mixed data explicitly.
    # Probe a bounded sample; empty spatial columns have no native SRID yet.
    probed_srid, geometry_types, mixed_srid = _probe_geometry(cur, schema, table, geom)
    srid = probed_srid if probed_srid is not None else 4326
    cur.execute(
        """
        SELECT c.name
        FROM sys.indexes i
        JOIN sys.index_columns ic
          ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c
          ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.is_primary_key = 1 AND i.object_id = ? AND ic.key_ordinal > 0
        ORDER BY ic.key_ordinal
        """,
        (object_id,),
    )
    primary_key_columns = [row[0] for row in cur.fetchall()]
    pk = primary_key_columns[0] if len(primary_key_columns) == 1 else None
    columns = [
        r[0]
        for r in rows
        if r[1] not in ("geometry", "geography", "hierarchyid", "sql_variant", "timestamp")
    ]
    by_name = {r[0]: r for r in rows}
    writable = [c for c in columns if c != pk and not by_name[c][2] and not by_name[c][4]]
    pkrow = by_name.get(pk) if pk else None
    return {
        "geometry_column": geom,
        "column_type": column_type,
        "srid": srid,
        "geometry_type": geometry_types[0] if geometry_types else "Unknown",
        "geometry_types": geometry_types,
        "mixed_geometry": len(geometry_types) > 1,
        "mixed_srid": mixed_srid,
        "primary_key": pk,
        "primary_key_columns": primary_key_columns,
        "pk_is_generated": bool(pkrow and (pkrow[2] or pkrow[3] != 0)),
        "pk_is_identity": bool(pkrow and pkrow[2]),
        "columns": columns,
        "writable": writable,
        "column_types": {r[0]: r[1] for r in rows},
    }


@router.post("/tables")
def mssql_tables(request: MssqlSessionRequest) -> dict[str, Any]:
    session = _get_session(request.session_id)
    pyodbc = _import_pyodbc()
    try:
        with _connection(session) as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT s.name, t.name, c.name, ty.name
                FROM sys.columns c
                JOIN sys.tables t ON t.object_id = c.object_id
                JOIN sys.schemas s ON s.schema_id = t.schema_id
                JOIN sys.types ty ON ty.user_type_id = c.user_type_id
                WHERE ty.name IN ('geometry', 'geography')
                  AND t.is_ms_shipped = 0
                ORDER BY s.name, t.name, c.name
                """
            )
            rows = cur.fetchall()
            cur.execute(
                """
                SELECT s.name, t.name, c.name, ic.key_ordinal
                FROM sys.indexes i
                JOIN sys.index_columns ic
                  ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                JOIN sys.columns c
                  ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                JOIN sys.tables t ON t.object_id = i.object_id
                JOIN sys.schemas s ON s.schema_id = t.schema_id
                WHERE i.is_primary_key = 1 AND ic.key_ordinal > 0
                ORDER BY s.name, t.name, ic.key_ordinal
                """
            )
            pks: dict[tuple[str, str], list[str]] = {}
            for row in cur.fetchall():
                pks.setdefault((row[0], row[1]), []).append(row[2])
            tables = []
            for schema, table, geom, coltype in rows:
                # A table the login cannot SELECT from must not hide the rest
                # of the catalog; its SRID and geometry type remain unknown.
                try:
                    probed_srid, geometry_types, mixed_srid = _probe_geometry(
                        cur, schema, table, geom
                    )
                except pyodbc.Error as exc:
                    logger.info(
                        "SQL Server geometry probe of %s.%s failed: %s",
                        schema,
                        table,
                        scrub_secrets(str(exc), session.sensitive()),
                    )
                    probed_srid, geometry_types, mixed_srid = 0, [], False
                primary_key_columns = pks.get((schema, table), [])
                tables.append(
                    {
                        "schema": schema,
                        "table": table,
                        "geometry_column": geom,
                        "column_type": coltype,
                        "srid": probed_srid if probed_srid is not None else 4326,
                        "geometry_type": geometry_types[0] if geometry_types else "Unknown",
                        "geometry_types": geometry_types,
                        "mixed_geometry": len(geometry_types) > 1,
                        "mixed_srid": mixed_srid,
                        "primary_key": (
                            primary_key_columns[0] if len(primary_key_columns) == 1 else None
                        ),
                        "primary_key_columns": primary_key_columns,
                    }
                )
            return {"tables": tables}
    except HTTPException:
        raise
    except Exception as exc:
        msg = scrub_secrets(str(exc), session.sensitive())
        logger.error("SQL Server table listing failed: %s", msg)
        raise HTTPException(400, f"Could not list tables: {msg}") from exc


@lru_cache(maxsize=64)
def _transformer(src: int, dst: int) -> Any:
    try:
        from pyproj import Transformer

        return Transformer.from_crs(f"EPSG:{src}", f"EPSG:{dst}", always_xy=True)
    except Exception:
        raise HTTPException(400, f"Unsupported SRID {src}") from None


def _wkb_to_geojson(wkb: Optional[bytes], srid: int, column_type: str) -> Optional[dict]:
    if wkb is None:
        return None
    try:
        import shapely
        from shapely.ops import transform

        geometry = shapely.from_wkb(bytes(wkb))
        if srid not in (0, 4326):
            transformer = _transformer(srid, 4326)
            with _TRANSFORM_LOCK:
                geometry = transform(transformer.transform, geometry)
        return json.loads(shapely.to_geojson(geometry))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Could not decode SQL Server geometry: {exc}") from exc


def _orient_for_geography(geometry: Any) -> Any:
    from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
    from shapely.geometry.polygon import orient

    if isinstance(geometry, Polygon):
        return orient(geometry, sign=1.0)
    if isinstance(geometry, MultiPolygon):
        return MultiPolygon([orient(p, sign=1.0) for p in geometry.geoms])
    if isinstance(geometry, GeometryCollection):
        return GeometryCollection([_orient_for_geography(g) for g in geometry.geoms])
    return geometry


def _geojson_to_wkb(geometry: dict, srid: int, column_type: str) -> bytes:
    try:
        import shapely
        from shapely.geometry import shape
        from shapely.ops import transform

        value = shape(geometry)
        # Both column types may carry a non-WGS84 SRID (geography allows other
        # geodetic ones such as 4269), so reproject whenever the SRID differs.
        if srid not in (0, 4326):
            transformer = _transformer(4326, srid)
            with _TRANSFORM_LOCK:
                value = transform(transformer.transform, value)
        if column_type == "geography":
            value = _orient_for_geography(value)
        return shapely.to_wkb(value, output_dimension=2)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Could not encode SQL Server geometry: {exc}") from exc


def _features_limit_error(write: bool = False) -> HTTPException:
    from geolibre_server import vector_ops

    if write:
        detail = (
            f"Table exceeds the {vector_ops.MAX_FEATURES}-feature limit for editable write-back"
        )
    else:
        detail = f"Layer exceeds the {vector_ops.MAX_FEATURES}-feature limit"
    return HTTPException(413, detail)


@router.post("/read")
def mssql_read(request: MssqlReadRequest) -> dict[str, Any]:
    from geolibre_server import vector_ops

    session = _get_session(request.session_id)
    try:
        with _connection(session) as conn:
            cur = conn.cursor()
            info = _table_info(cur, request.schema_name, request.table, request.geometry_column)
            pk = info["primary_key"]
            read_columns = [
                c for c in info["columns"] if c not in request.excluded_fields or c == pk
            ]
            selected_columns = (
                (", " + ", ".join(_q(c) for c in read_columns)) if read_columns else ""
            )
            geom = _q(info["geometry_column"])
            sql = (
                f"SELECT TOP (?) {geom}.STAsBinary(), {geom}.STSrid"
                f"{selected_columns} FROM {_q(request.schema_name)}.{_q(request.table)}"
            )
            cur.execute(sql, (vector_ops.MAX_FEATURES + 1,))
            rows = cur.fetchall()
        if len(rows) > vector_ops.MAX_FEATURES:
            raise _features_limit_error()
        features = []
        for row in rows:
            raw = {col: json_safe(val) for col, val in zip(read_columns, row[2:], strict=True)}
            props = {k: v for k, v in raw.items() if k not in request.excluded_fields}
            feature = {
                "type": "Feature",
                "geometry": _wkb_to_geojson(
                    row[0], int(row[1]) if row[1] is not None else 0, info["column_type"]
                ),
                "properties": props,
            }
            if pk is not None and raw.get(pk) is not None:
                feature["id"] = raw[pk]
            features.append(feature)
        return {
            "geojson": {"type": "FeatureCollection", "features": features},
            "schema": request.schema_name,
            "table": request.table,
            "geometry_column": info["geometry_column"],
            "column_type": info["column_type"],
            "srid": info["srid"],
            "primary_key": pk,
            "primary_key_columns": info.get("primary_key_columns", []),
            "mixed_geometry": info.get("mixed_geometry", False),
            "mixed_srid": info.get("mixed_srid", False),
            "feature_count": len(features),
        }
    except HTTPException:
        raise
    except Exception as exc:
        msg = scrub_secrets(str(exc), session.sensitive())
        logger.error("SQL Server read failed: %s", msg)
        raise HTTPException(400, f"Could not read table: {msg}") from exc


@router.post("/write")
def mssql_write(request: MssqlWriteRequest) -> dict[str, Any]:
    from geolibre_server import vector_ops

    submitted = request.geojson.get("features")
    # Deleting every loaded feature is a valid save: with a non-empty baseline the
    # diff deletes exactly those rows. Without one, an empty payload stays an error.
    features = (
        []
        if request.baseline_keys and isinstance(submitted, list) and not submitted
        else require_features(request.geojson)
    )
    session = _get_session(request.session_id)
    inserted = updated = deleted = 0
    with _connection(session) as conn:
        commit_attempted = False
        try:
            cur = conn.cursor()
            info = _table_info(cur, request.schema_name, request.table, request.geometry_column)
            pk = info["primary_key"]
            if pk is None:
                primary_key_columns = info.get("primary_key_columns", [])
                reason = (
                    f"composite primary key ({', '.join(primary_key_columns)})"
                    if len(primary_key_columns) > 1
                    else "no single-column primary key"
                )
                raise HTTPException(
                    400,
                    f"{request.schema_name}.{request.table} has {reason}; write-back requires one.",
                )
            table_sql = f"{_q(request.schema_name)}.{_q(request.table)}"
            cur.execute(f"SELECT COUNT_BIG(*) FROM {table_sql}")
            if cur.fetchone()[0] > vector_ops.MAX_FEATURES:
                raise _features_limit_error(True)
            cols = info["columns"]
            query = (
                f"SELECT {_q(pk)}, {_q(info['geometry_column'])}.STAsBinary(), "
                f"{_q(info['geometry_column'])}.STSrid, "
                f"{', '.join(_q(column) for column in cols)} FROM {table_sql}"
            )
            cur.execute(query)
            existing = {}
            for row in cur.fetchall():
                values = {c: json_safe(v) for c, v in zip(cols, row[3:], strict=True)}
                existing[json_safe(row[0])] = (
                    _wkb_to_geojson(
                        row[1], int(row[2]) if row[2] is not None else 0, info["column_type"]
                    ),
                    values,
                )
            diff = plan_feature_diff(
                features,
                primary_key=pk,
                writable_columns=info["writable"],
                existing_rows=existing,
                pk_is_generated=info["pk_is_generated"],
                insert_explicit_key=not info["pk_is_identity"],
                baseline_keys=request.baseline_keys,
                capabilities=request.capabilities,
                table_label=f"{request.schema_name}.{request.table}",
                unchanged_geometry_keys=request.unchanged_geometry_keys,
                changed_columns=(
                    {item.key: item.columns for item in request.changed_columns}
                    if request.changed_columns is not None
                    else None
                ),
            )
            # Only updates that actually write geometry, and inserts, can store
            # coordinates under an unsafe SRID; the UPDATE below emits the
            # geometry SET under the same `geometry_changed` condition.
            needs_geometry_write = any(
                change.geometry_changed and change.geometry is not None for change in diff.updates
            ) or any(change.geometry is not None for change in diff.inserts)
            if needs_geometry_write and info.get("mixed_srid", False):
                raise HTTPException(
                    400,
                    f"Cannot write geometry to {request.schema_name}.{request.table}: "
                    "rows use mixed SRIDs.",
                )
            if needs_geometry_write and info["srid"] == 0:
                raise HTTPException(
                    400,
                    f"Cannot write geometry to {request.schema_name}.{request.table}: "
                    "the native SRID is unknown (0). Set a known SRID before inserting "
                    "or editing geometries.",
                )
            geom = _q(info["geometry_column"])
            table = f"{_q(request.schema_name)}.{_q(request.table)}"
            expr = f"{info['column_type']}::STGeomFromWKB(?, {int(info['srid'])})"
            types = info["column_types"]
            for change in diff.updates:
                sets = []
                params = []
                if change.geometry_changed:
                    sets.append(f"{geom} = " + (expr if change.geometry is not None else "NULL"))
                    if change.geometry is not None:
                        params.append(
                            _geojson_to_wkb(change.geometry, info["srid"], info["column_type"])
                        )
                for c, v in change.values.items():
                    sets.append(f"{_q(c)} = ?")
                    params.append(_bind_value(v, types[c]))
                params.append(_bind_value(change.key, types[pk]))
                cur.execute(f"UPDATE {table} SET {', '.join(sets)} WHERE {_q(pk)} = ?", params)
                updated += 1
            for change in diff.inserts:
                insert_cols = list(change.values)
                params = []
                geom_expr = expr if change.geometry is not None else "NULL"
                if change.geometry is not None:
                    params.append(
                        _geojson_to_wkb(change.geometry, info["srid"], info["column_type"])
                    )
                params.extend(_bind_value(v, types[c]) for c, v in change.values.items())
                if change.key is not None:
                    insert_cols.append(pk)
                    params.append(_bind_value(change.key, types[pk]))
                cols_sql = ", ".join([geom] + [_q(c) for c in insert_cols])
                vals_sql = ", ".join(
                    [geom_expr] + ["?"] * (len(params) - (1 if change.geometry is not None else 0))
                )
                cur.execute(f"INSERT INTO {table} ({cols_sql}) VALUES ({vals_sql})", params)
                inserted += 1
            for start in range(0, len(diff.deletes), 1000):
                keys = [_bind_value(k, types[pk]) for k in diff.deletes[start : start + 1000]]
                cur.execute(
                    f"DELETE FROM {table} WHERE {_q(pk)} IN ({','.join('?' for _ in keys)})", keys
                )
                deleted += max(cur.rowcount, 0)
            commit_attempted = True
            conn.commit()
        except HTTPException as exc:
            rolled_back = _safe_rollback(conn, session.sensitive())
            if rolled_back and not commit_attempted:
                raise MssqlWriteRolledBack(exc.status_code, exc.detail) from exc
            raise
        except Exception as exc:
            rolled_back = _safe_rollback(conn, session.sensitive())
            msg = scrub_secrets(str(exc), session.sensitive())
            logger.error("SQL Server write-back failed: %s", msg)
            if rolled_back and not commit_attempted:
                raise MssqlWriteRolledBack(400, f"Write-back failed: {msg}") from exc
            raise HTTPException(400, f"Write-back failed: {msg}") from exc
    messages = [
        f"Saved {len(features)} feature(s) to {request.schema_name}.{request.table} "
        f"({inserted} inserted, {updated} updated, {deleted} deleted)"
    ]
    if diff.skipped_fields:
        messages.append(
            "Skipped fields without a matching column: " + ", ".join(diff.skipped_fields)
        )
    return {
        "schema": request.schema_name,
        "table": request.table,
        "feature_count": len(features),
        "inserted": inserted,
        "updated": updated,
        "deleted": deleted,
        "messages": messages,
        "skipped_fields": diff.skipped_fields,
    }
