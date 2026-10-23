"""Unit and opt-in live integration tests for SQL Server editable layers."""

from __future__ import annotations

import datetime
import os
import struct
import threading
import time

import pytest
from fastapi import HTTPException

from geolibre_server.app import mssql

try:
    import pyodbc

    HAS_PYODBC = True
except Exception:
    pyodbc = None
    HAS_PYODBC = False

HAS_DRIVER = False
if HAS_PYODBC:
    try:
        HAS_DRIVER = bool(mssql._select_driver(pyodbc))
    except Exception:
        pass
LIVE = HAS_PYODBC and HAS_DRIVER and bool(os.environ.get("GEOLIBRE_TEST_MSSQL_SERVER"))
requires_live_mssql = pytest.mark.skipif(
    not LIVE, reason="GEOLIBRE_TEST_MSSQL_SERVER not set or ODBC driver missing"
)
if os.environ.get("GEOLIBRE_TEST_MSSQL_REQUIRED") == "1" and not LIVE:
    raise RuntimeError("SQL Server integration prerequisites missing")


def test_connection_string_escapes_credentials():
    auth = mssql.MssqlAuth(method="sql", username="alice", password="a}b")
    value = mssql._build_connection_string(
        "ODBC Driver 18 for SQL Server", "db.example", None, 1433, "gis", True, False, auth
    )
    assert "PWD={a}}b}" in value
    assert "SERVER=tcp:db.example,1433" in value


def test_server_target_and_allowlist(monkeypatch):
    monkeypatch.setenv("GEOLIBRE_MSSQL_HOSTS", "db.example:1433")
    req = mssql.MssqlConnectRequest(
        server="db.example",
        database="gis",
        auth={"method": "sql", "username": "u", "password": "p"},
    )
    assert mssql._validate_target(req) == ("db.example", None)
    with pytest.raises(HTTPException) as exc:
        mssql._validate_target(req.model_copy(update={"server": "db.example\\instance"}))
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc:
        mssql._parse_server("a;b")
    assert exc.value.status_code == 400
    monkeypatch.setenv("GEOLIBRE_MSSQL_HOSTS", "db.example")
    assert mssql._validate_target(req.model_copy(update={"server": "db.example\\instance"})) == (
        "db.example",
        "instance",
    )
    monkeypatch.delenv("GEOLIBRE_MSSQL_HOSTS")
    with pytest.raises(HTTPException) as exc:
        mssql._validate_target(req)
    assert exc.value.status_code == 403


def test_auth_methods_desktop_gate(monkeypatch):
    monkeypatch.setattr(mssql, "azure_identity_import_error", lambda: None)
    monkeypatch.delenv("GEOLIBRE_MSSQL_DESKTOP_AUTH", raising=False)
    assert "windows" not in mssql.available_auth_methods()
    assert "entra_interactive" not in mssql.available_auth_methods()
    monkeypatch.setenv("GEOLIBRE_MSSQL_DESKTOP_AUTH", "1")
    monkeypatch.setattr(mssql.sys, "platform", "win32")
    methods = mssql.available_auth_methods()
    assert "windows" in methods and "entra_interactive" in methods


def test_status_driver_missing(monkeypatch):
    class Fake:
        @staticmethod
        def drivers():
            return []

    monkeypatch.setattr(mssql, "pyodbc_import_error", lambda: None)
    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: Fake)
    result = mssql.mssql_status()
    assert not result["available"]
    assert result["message"] == "Microsoft ODBC Driver 18 for SQL Server is not installed."


def test_token_refreshed_each_connection(monkeypatch):
    class Credential:
        def __init__(self):
            self.count = 0

        def get_token(self, scope):
            self.count += 1
            return type("Token", (), {"token": f"t{self.count}"})()

    calls = []

    class Conn:
        def add_output_converter(self, sql_type, handler):
            pass

        def __setattr__(self, key, value):
            object.__setattr__(self, key, value)

    class Fake:
        @staticmethod
        def connect(cs, **kwargs):
            calls.append(kwargs)
            return Conn()

    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: Fake)
    cred = Credential()
    session = mssql._Session("cs", cred, None, (), time.monotonic())
    mssql._open_connection(session)
    mssql._open_connection(session)

    def packed(token):
        raw = token.encode("utf-16-le")
        return struct.pack(f"<I{len(raw)}s", len(raw), raw)

    assert calls[0]["attrs_before"][1256] == packed("t1")
    assert calls[1]["attrs_before"][1256] == packed("t2")


def test_connect_failure_scrubs_secret(monkeypatch):
    monkeypatch.setattr(
        mssql, "_require_runtime", lambda: (object(), "ODBC Driver 18 for SQL Server")
    )
    monkeypatch.setattr(mssql, "_validate_target", lambda req: ("db.example", None))
    monkeypatch.setattr(mssql, "available_auth_methods", lambda: ["sql"])

    class Fake:
        @staticmethod
        def connect(*a, **kw):
            raise Exception("Login failed PWD={sekret}; token sekret")

    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: Fake)
    req = mssql.MssqlConnectRequest(
        server="db.example",
        database="gis",
        auth={"method": "sql", "username": "u", "password": "sekret"},
    )
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_connect(req)
    assert "sekret" not in exc.value.detail
    assert "****" in exc.value.detail


def test_connect_success_returns_only_session_id(monkeypatch):
    monkeypatch.setattr(
        mssql, "_require_runtime", lambda: (object(), "ODBC Driver 18 for SQL Server")
    )
    monkeypatch.setattr(mssql, "_validate_target", lambda req: ("db.example", None))
    monkeypatch.setattr(mssql, "available_auth_methods", lambda: ["sql"])

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def execute(self, query):
            assert query == "SELECT 1"

    class Connection:
        timeout = None

        def add_output_converter(self, sql_type, handler):
            pass

        def cursor(self):
            return Cursor()

        def close(self):
            pass

    class Fake:
        @staticmethod
        def connect(*args, **kwargs):
            return Connection()

    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: Fake)
    with mssql._SESSIONS_LOCK:
        mssql._SESSIONS.clear()
    req = mssql.MssqlConnectRequest(
        server="db.example",
        database="gis",
        auth={"method": "sql", "username": "u", "password": "p"},
    )
    result = mssql.mssql_connect(req)
    assert set(result) == {"session_id"}
    mssql.mssql_disconnect(mssql.MssqlSessionRequest(session_id=result["session_id"]))


def test_session_unknown_and_idle_expiry(monkeypatch):
    with mssql._SESSIONS_LOCK:
        mssql._SESSIONS.clear()
    with pytest.raises(HTTPException) as exc:
        mssql._get_session("missing")
    assert exc.value.status_code == 410
    mssql._SESSIONS["old"] = mssql._Session("", None, None, (), 0)
    monkeypatch.setattr(mssql.time, "monotonic", lambda: mssql._SESSION_IDLE_S + 1)
    with pytest.raises(HTTPException) as exc:
        mssql._get_session("old")
    assert exc.value.status_code == 410
    with mssql._SESSIONS_LOCK:
        mssql._SESSIONS.clear()


def test_write_empty_features_requires_baseline(monkeypatch):
    monkeypatch.setattr(mssql, "_SESSIONS", {})
    empty = {"type": "FeatureCollection", "features": []}
    for baseline_keys in (None, []):
        with pytest.raises(HTTPException) as exc:
            mssql.mssql_write(
                mssql.MssqlWriteRequest(
                    session_id="missing", table="t", geojson=empty, baseline_keys=baseline_keys
                )
            )
        assert (exc.value.status_code, exc.value.detail) == (400, "No features to write.")
    # A baseline lets the empty save past validation, to the session lookup.
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_write(
            mssql.MssqlWriteRequest(
                session_id="missing", table="t", geojson=empty, baseline_keys=[1]
            )
        )
    assert exc.value.status_code == 410


def test_optional_imports_and_runtime_errors(monkeypatch):
    monkeypatch.setattr(mssql, "pyodbc_import_error", lambda: "missing")
    with pytest.raises(HTTPException) as exc:
        mssql._require_runtime()
    assert exc.value.status_code == 503


class FakePyodbcError(Exception):
    pass


def _fail(sql, params):
    raise FakePyodbcError("boom")


class FakeCursor:
    def __init__(self, connection):
        self._connection = connection

    def execute(self, sql, *params):
        if self._connection.execute_hook is not None:
            self._connection.execute_hook(sql, params)

    def fetchall(self):
        results = self._connection.fetchall_results
        return results.pop(0) if results else []

    def fetchone(self):
        results = self._connection.fetchone_results
        return results.pop(0) if results else None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def close(self):
        pass


class FakeConnection:
    def add_output_converter(self, sql_type, handler):
        pass

    def __init__(self):
        self.closed = False
        self.rolled_back = False
        self.committed = False
        self.execute_hook = None
        self.fetchall_results = []
        self.fetchone_results = []

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


class FakePyodbc:
    Error = FakePyodbcError

    def __init__(self, connection):
        self._connection = connection

    def connect(self, *args, **kwargs):
        return self._connection


def _install_session(monkeypatch, connection):
    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: FakePyodbc(connection))
    with mssql._SESSIONS_LOCK:
        mssql._SESSIONS.clear()
        mssql._SESSIONS["sid"] = mssql._Session("cs", None, None, (), time.monotonic())
    return mssql.MssqlSessionRequest(session_id="sid")


def _sidecar_client():
    """The sidecar app under Starlette's test client.

    The SQL Server integration job installs only the `dev,mssql` extras, which
    lack the HTTP client Starlette's test client needs; route-level tests skip
    there and run in the backend job, which installs the `test` extra.
    """
    try:
        from fastapi.testclient import TestClient
    except (ImportError, RuntimeError) as exc:
        pytest.skip(f"Starlette test client unavailable: {exc}")
    from geolibre_server.app.main import app

    return TestClient(app)


def test_tables_closes_connection_and_tolerates_probe_error(monkeypatch):
    conn = FakeConnection()
    conn.fetchall_results = [
        [
            ("dbo", "listed", "geom", "geometry"),
            ("dbo", "composite", "geom", "geometry"),
            ("dbo", "blocked", "geom", "geometry"),
            ("dbo", "empty", "geog", "geography"),
            ("dbo", "srid_zero", "geom", "geometry"),
        ],
        [
            ("dbo", "listed", "gid", 1),
            ("dbo", "composite", "tenant_id", 1),
            ("dbo", "composite", "parcel_id", 2),
        ],
        [(3857, "Point", 2), (4326, "MultiPolygon", 1), (3857, "Point", 1)],
        [(4326, "MultiPolygon", 1)],
        [],
        [(0, "Point", 1)],
    ]

    def hook(sql, params):
        if "[blocked]" in sql:
            raise FakePyodbcError("SELECT permission was denied")

    conn.execute_hook = hook
    tables = mssql.mssql_tables(_install_session(monkeypatch, conn))["tables"]
    by_table = {table["table"]: table for table in tables}
    assert conn.closed
    assert by_table["listed"]["primary_key"] == "gid"
    assert by_table["listed"]["primary_key_columns"] == ["gid"]
    assert by_table["listed"]["srid"] == 3857
    assert by_table["listed"]["mixed_srid"] is True
    assert by_table["listed"]["mixed_geometry"] is True
    assert by_table["listed"]["geometry_types"] == ["Point", "MultiPolygon"]
    assert by_table["composite"]["primary_key"] is None
    assert by_table["composite"]["primary_key_columns"] == ["tenant_id", "parcel_id"]
    assert by_table["composite"]["geometry_types"] == ["MultiPolygon"]
    # Failed probes stay unknown; successful empty probes default to WGS84.
    assert (by_table["blocked"]["srid"], by_table["blocked"]["geometry_type"]) == (0, "Unknown")
    assert (by_table["empty"]["srid"], by_table["empty"]["geometry_type"]) == (4326, "Unknown")
    assert by_table["srid_zero"]["srid"] == 0


def test_table_info_reports_composite_key_and_defaults_empty_srid():
    conn = FakeConnection()
    conn.fetchone_results = [(41,)]
    conn.fetchall_results = [
        [
            ("tenant_id", "int", False, 0, False),
            ("parcel_id", "int", False, 0, False),
            ("shape", "geometry", False, 0, False),
        ],
        [],
        [("tenant_id",), ("parcel_id",)],
    ]

    info = mssql._table_info(conn.cursor(), "dbo", "parcels")

    assert info["primary_key"] is None
    assert info["primary_key_columns"] == ["tenant_id", "parcel_id"]
    assert info["srid"] == 4326
    assert info["geometry_type"] == "Unknown"
    assert info["geometry_types"] == []


def test_read_decodes_each_geometry_with_its_own_srid(monkeypatch):
    conn = FakeConnection()
    request = _install_session(monkeypatch, conn)
    conn.fetchall_results = [[(b"first", 4326, 1), (b"second", 3857, 2)]]
    decoded_srids = []
    monkeypatch.setattr(
        mssql,
        "_table_info",
        lambda *args: {
            "primary_key": "id",
            "primary_key_columns": ["id"],
            "geometry_column": "geom",
            "column_type": "geometry",
            "srid": 4326,
            "mixed_geometry": False,
            "mixed_srid": True,
            "columns": ["id"],
        },
    )
    monkeypatch.setattr(
        mssql,
        "_wkb_to_geojson",
        lambda _wkb, srid, _column_type: (
            decoded_srids.append(srid) or {"type": "Point", "coordinates": [0, 0]}
        ),
    )

    result = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=request.session_id, table="parcels")
    )

    assert decoded_srids == [4326, 3857]
    assert result["mixed_srid"] is True
    assert [feature["id"] for feature in result["geojson"]["features"]] == [1, 2]


def test_read_closes_connection_on_error(monkeypatch):
    conn = FakeConnection()
    conn.execute_hook = _fail
    request = _install_session(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_read(mssql.MssqlReadRequest(session_id=request.session_id, table="t"))
    assert exc.value.status_code == 400
    assert conn.closed


def test_write_rolls_back_and_closes_on_error(monkeypatch):
    conn = FakeConnection()
    conn.execute_hook = _fail
    request = _install_session(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_write(
            mssql.MssqlWriteRequest(
                session_id=request.session_id,
                table="t",
                geojson={
                    "type": "FeatureCollection",
                    "features": [{"type": "Feature", "properties": {}, "geometry": None}],
                },
            )
        )
    assert exc.value.status_code == 400
    assert isinstance(exc.value, mssql.MssqlWriteRolledBack)
    assert conn.rolled_back and conn.closed


def test_write_allows_attribute_edit_on_srid_zero_table(monkeypatch):
    conn = FakeConnection()
    request = _install_session(monkeypatch, conn)
    geometry = {"type": "Point", "coordinates": [0, 0]}
    conn.fetchone_results = [(1,)]
    conn.fetchall_results = [[(1, b"wkb", 0, 1, "North", 10)]]
    statements = []
    conn.execute_hook = lambda sql, params: statements.append(sql)
    monkeypatch.setattr(mssql, "_wkb_to_geojson", lambda *args: geometry)
    monkeypatch.setattr(
        mssql,
        "_table_info",
        lambda *args: {
            "primary_key": "gid",
            "primary_key_columns": ["gid"],
            "geometry_column": "geom",
            "column_type": "geometry",
            "srid": 0,
            "mixed_srid": False,
            "pk_is_generated": True,
            "pk_is_identity": True,
            "columns": ["gid", "name", "population"],
            "writable": ["name", "population"],
            "column_types": {"gid": "int", "name": "nvarchar", "population": "int"},
        },
    )

    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=request.session_id,
            table="parcels",
            baseline_keys=[1],
            geojson={
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "id": 1,
                        "geometry": geometry,
                        "properties": {"gid": 1, "name": "North", "population": 11},
                    }
                ],
            },
        )
    )

    assert result["updated"] == 1
    assert conn.committed
    update_sql = next(sql for sql in statements if sql.startswith("UPDATE"))
    # The unchanged geometry is left alone, so its stored SRID is not rewritten.
    assert "[geom] =" not in update_sql


def test_write_http_response_marks_confirmed_rollback(monkeypatch):
    conn = FakeConnection()
    _install_session(monkeypatch, conn)
    conn.execute_hook = _fail
    response = _sidecar_client().post(
        "/mssql/write",
        json={
            "session_id": "sid",
            "table": "t",
            "geojson": {
                "type": "FeatureCollection",
                "features": [{"type": "Feature", "properties": {}, "geometry": None}],
            },
        },
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Write-back failed: boom", "rolled_back": True}


def test_write_http_response_omits_rollback_marker_when_rollback_fails(monkeypatch):
    conn = FakeConnection()
    _install_session(monkeypatch, conn)
    conn.execute_hook = _fail

    def fail_rollback():
        raise FakePyodbcError("rollback failed")

    conn.rollback = fail_rollback
    response = _sidecar_client().post(
        "/mssql/write",
        json={
            "session_id": "sid",
            "table": "t",
            "geojson": {
                "type": "FeatureCollection",
                "features": [{"type": "Feature", "properties": {}, "geometry": None}],
            },
        },
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Write-back failed: boom"}


def test_write_http_response_omits_rollback_marker_when_commit_fails(monkeypatch):
    conn = FakeConnection()
    _install_session(monkeypatch, conn)
    geometry = {"type": "Point", "coordinates": [0, 0]}
    conn.fetchone_results = [(1,)]
    conn.fetchall_results = [[(1, b"wkb", 3857, 1, "North", 10)]]
    monkeypatch.setattr(mssql, "_wkb_to_geojson", lambda *args: geometry)
    monkeypatch.setattr(
        mssql,
        "_table_info",
        lambda *args: {
            "primary_key": "gid",
            "geometry_column": "geom",
            "column_type": "geometry",
            "srid": 3857,
            "pk_is_generated": True,
            "pk_is_identity": True,
            "columns": ["gid", "name", "population"],
            "writable": ["name", "population"],
            "column_types": {"gid": "int", "name": "nvarchar", "population": "int"},
        },
    )

    def fail_commit():
        raise FakePyodbcError("commit response lost")

    conn.commit = fail_commit
    response = _sidecar_client().post(
        "/mssql/write",
        json={
            "session_id": "sid",
            "table": "parcels",
            "baseline_keys": [1],
            "geojson": {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "id": 1,
                        "geometry": geometry,
                        "properties": {"gid": 1, "name": "North", "population": 10},
                    }
                ],
            },
        },
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "Write-back failed: commit response lost"}


def test_write_updates_only_changed_values_without_rewriting_geometry(monkeypatch):
    conn = FakeConnection()
    request = _install_session(monkeypatch, conn)
    geometry = {"type": "Point", "coordinates": [0, 0]}
    conn.fetchone_results = [(1,)]
    # Another client renamed the row after load; the app only edited population.
    conn.fetchall_results = [[(1, b"wkb", 3857, 1, "North (changed externally)", 10)]]
    statements = []
    conn.execute_hook = lambda sql, params: statements.append((sql, params))
    monkeypatch.setattr(mssql, "_wkb_to_geojson", lambda *args: geometry)
    monkeypatch.setattr(
        mssql,
        "_table_info",
        lambda *args: {
            "primary_key": "gid",
            "geometry_column": "geom",
            "column_type": "geometry",
            "srid": 3857,
            "pk_is_generated": True,
            "pk_is_identity": True,
            "columns": ["gid", "name", "population"],
            "writable": ["name", "population"],
            "column_types": {"gid": "int", "name": "nvarchar", "population": "int"},
        },
    )

    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=request.session_id,
            table="parcels",
            baseline_keys=[1],
            changed_columns=[{"key": 1, "columns": ["population"]}],
            geojson={
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "id": 1,
                        "geometry": geometry,
                        "properties": {"gid": 1, "name": "North", "population": 11},
                    }
                ],
            },
        )
    )

    update_sql, update_params = next(
        (sql, params) for sql, params in statements if sql.startswith("UPDATE")
    )
    assert "SET [population] = ?" in update_sql
    assert "[geom] =" not in update_sql and "[name] =" not in update_sql
    assert update_params == ([11, 1],)
    assert result["updated"] == 1


@pytest.mark.parametrize(
    ("srid", "mixed_srid", "detail"),
    [
        (0, False, "native SRID is unknown"),
        (4326, True, "rows use mixed SRIDs"),
    ],
)
def test_write_rejects_geometry_insert_with_unsafe_srid(monkeypatch, srid, mixed_srid, detail):
    conn = FakeConnection()
    request = _install_session(monkeypatch, conn)
    conn.fetchone_results = [(0,)]
    conn.fetchall_results = [[]]
    statements = []
    conn.execute_hook = lambda sql, params: statements.append(sql)
    monkeypatch.setattr(
        mssql,
        "_table_info",
        lambda *args: {
            "primary_key": "gid",
            "primary_key_columns": ["gid"],
            "geometry_column": "geom",
            "column_type": "geometry",
            "srid": srid,
            "mixed_srid": mixed_srid,
            "pk_is_generated": False,
            "pk_is_identity": False,
            "columns": ["gid"],
            "writable": [],
            "column_types": {"gid": "int"},
        },
    )

    with pytest.raises(HTTPException) as exc:
        mssql.mssql_write(
            mssql.MssqlWriteRequest(
                session_id=request.session_id,
                schema_name="dbo",
                table="parcels",
                geojson={
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "id": 1,
                            "geometry": {"type": "Point", "coordinates": [0, 0]},
                            "properties": {"gid": 1},
                        }
                    ],
                },
            )
        )

    assert exc.value.status_code == 400
    assert detail in exc.value.detail
    assert conn.rolled_back and not conn.committed and conn.closed
    assert not any(sql.startswith("INSERT") for sql in statements)


def test_write_rejects_composite_primary_key(monkeypatch):
    conn = FakeConnection()
    request = _install_session(monkeypatch, conn)
    monkeypatch.setattr(
        mssql,
        "_table_info",
        lambda *args: {
            "primary_key": None,
            "primary_key_columns": ["tenant_id", "parcel_id"],
        },
    )

    with pytest.raises(HTTPException) as exc:
        mssql.mssql_write(
            mssql.MssqlWriteRequest(
                session_id=request.session_id,
                schema_name="dbo",
                table="parcels",
                geojson={
                    "type": "FeatureCollection",
                    "features": [{"type": "Feature", "properties": {}, "geometry": None}],
                },
            )
        )

    assert exc.value.status_code == 400
    assert "composite primary key (tenant_id, parcel_id)" in exc.value.detail
    assert conn.rolled_back and not conn.committed and conn.closed


def test_connect_closes_connection_when_probe_fails(monkeypatch):
    conn = FakeConnection()
    conn.execute_hook = _fail
    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: FakePyodbc(conn))
    monkeypatch.setattr(
        mssql, "_require_runtime", lambda: (FakePyodbc(conn), "ODBC Driver 18 for SQL Server")
    )
    monkeypatch.setattr(mssql, "_validate_target", lambda req: ("db.example", None))
    monkeypatch.setattr(mssql, "available_auth_methods", lambda: ["sql"])
    req = mssql.MssqlConnectRequest(
        server="db.example",
        database="gis",
        auth={"method": "sql", "username": "u", "password": "p"},
    )
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_connect(req)
    assert exc.value.status_code == 400
    assert conn.closed


@pytest.mark.parametrize(
    ("failure", "host", "expected"),
    [
        (
            "dns",
            "no-such-host.invalid",
            "The host name 'no-such-host.invalid' could not be resolved",
        ),
        ("port", "127.0.0.1", "Nothing is accepting connections at 127.0.0.1:1433"),
    ],
)
def test_open_connection_distinguishes_dns_and_port_failures(monkeypatch, failure, host, expected):
    class FailedDriver:
        @staticmethod
        def connect(*args, **kwargs):
            raise RuntimeError("ODBC driver connect failed")

    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: FailedDriver)
    if failure == "dns":

        def fail_resolution(*args, **kwargs):
            raise mssql.socket.gaierror("name not found")

        monkeypatch.setattr(mssql.socket, "getaddrinfo", fail_resolution)
        monkeypatch.setattr(
            mssql.socket,
            "create_connection",
            lambda *args, **kwargs: pytest.fail("TCP probe must not follow a DNS failure"),
        )
    else:
        monkeypatch.setattr(mssql.socket, "getaddrinfo", lambda *args, **kwargs: [])

        def refuse_connection(*args, **kwargs):
            raise ConnectionRefusedError("connection refused")

        monkeypatch.setattr(mssql.socket, "create_connection", refuse_connection)

    session = mssql._Session("cs", None, None, (), time.monotonic(), host=host, port=1433)
    with pytest.raises(HTTPException) as exc:
        mssql._open_connection(session)
    assert expected in exc.value.detail
    assert "Driver message: ODBC driver connect failed" in exc.value.detail


def test_open_connection_reports_malformed_host_label_as_unresolvable(monkeypatch):
    class FailedDriver:
        @staticmethod
        def connect(*args, **kwargs):
            raise RuntimeError("ODBC driver connect failed")

    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: FailedDriver)
    # Real IDNA encoding rejects the empty label before any DNS traffic.
    session = mssql._Session(
        "cs", None, None, (), time.monotonic(), host="db..example.com", port=1433
    )
    with pytest.raises(HTTPException) as exc:
        mssql._open_connection(session)
    assert exc.value.status_code == 400
    assert "The host name 'db..example.com' could not be resolved" in exc.value.detail


def test_unanswered_dns_lookup_falls_back_to_driver_message(monkeypatch):
    release = threading.Event()

    def hang(*args, **kwargs):
        release.wait(5)
        return []

    monkeypatch.setattr(mssql, "_REACHABILITY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(mssql.socket, "getaddrinfo", hang)
    monkeypatch.setattr(
        mssql.socket,
        "create_connection",
        lambda *args, **kwargs: pytest.fail("no TCP probe after an unanswered lookup"),
    )

    def probe_threads():
        return [t for t in threading.enumerate() if t.name.startswith("mssql-dns-probe")]

    try:
        started = time.monotonic()
        # Repeated failed connects against a hung resolver each fall back fast
        # and never hold more than the pool's two probe threads.
        for _ in range(4):
            assert mssql._unreachable_reason("slow-dns.example", None, 1433) is None
        assert time.monotonic() - started < 2
        assert len(probe_threads()) <= 2
    finally:
        release.set()


def test_named_instance_skips_fixed_tcp_port_probe(monkeypatch):
    monkeypatch.setattr(mssql.socket, "getaddrinfo", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        mssql.socket,
        "create_connection",
        lambda *args, **kwargs: pytest.fail("named instances use SQL Browser port discovery"),
    )

    assert mssql._unreachable_reason("db.example", "SQLEXPRESS", 1433) is None


def test_write_rollback_failure_keeps_original_error(monkeypatch):
    conn = FakeConnection()
    conn.execute_hook = _fail

    def failing_rollback():
        raise FakePyodbcError("rollback also failed")

    conn.rollback = failing_rollback
    request = _install_session(monkeypatch, conn)
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_write(
            mssql.MssqlWriteRequest(
                session_id=request.session_id,
                table="t",
                geojson={
                    "type": "FeatureCollection",
                    "features": [{"type": "Feature", "properties": {}, "geometry": None}],
                },
            )
        )
    assert exc.value.status_code == 400
    assert "Write-back failed" in exc.value.detail
    assert conn.closed


def test_open_connection_scrubs_fresh_token(monkeypatch):
    class Credential:
        def get_token(self, scope):
            return type("Token", (), {"token": "fresh-secret-token"})()

    class Fake:
        @staticmethod
        def connect(*args, **kwargs):
            raise Exception("driver echoed fresh-secret-token")

    monkeypatch.setattr(mssql, "_import_pyodbc", lambda: Fake)
    session = mssql._Session("cs", Credential(), None, (), time.monotonic())
    with pytest.raises(HTTPException) as exc:
        mssql._open_connection(session)
    assert "fresh-secret-token" not in exc.value.detail
    assert "****" in exc.value.detail
    # The fetched token is retained so later handlers scrub it too.
    assert session.live_token == "fresh-secret-token"
    assert "fresh-secret-token" in session.sensitive()


def test_read_scrubs_live_token(monkeypatch):
    conn = FakeConnection()

    def hook(sql, params):
        raise FakePyodbcError("driver echoed fresh-secret-token")

    conn.execute_hook = hook
    request = _install_session(monkeypatch, conn)
    with mssql._SESSIONS_LOCK:
        mssql._SESSIONS[request.session_id].live_token = "fresh-secret-token"
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_read(mssql.MssqlReadRequest(session_id=request.session_id, table="t"))
    assert "fresh-secret-token" not in exc.value.detail
    assert "****" in exc.value.detail


def test_session_sensitive_includes_live_token():
    session = mssql._Session("cs", None, None, ("pw",), 0.0)
    assert session.sensitive() == ("pw",)
    session.live_token = "token"
    assert session.sensitive() == ("pw", "token")


def test_bind_value_restores_column_types():
    # json_safe stringifies these, but SQL Server cannot implicitly cast them back.
    assert mssql._bind_value("00ff", "varbinary") == b"\x00\xff"
    # datetime2/time are bound as strings so all seven fractional digits survive.
    assert mssql._bind_value("2024-01-01 12:00:00.1234567", "datetime2") == (
        "2024-01-01 12:00:00.1234567"
    )
    assert mssql._bind_value("2024-01-01 12:00:00.123456", "datetime") == datetime.datetime(
        2024, 1, 1, 12, 0, 0, 123456
    )
    assert mssql._bind_value("2024-01-01", "date") == datetime.date(2024, 1, 1)
    assert mssql._bind_value("12:00:00.5", "time") == "12:00:00.5"
    assert mssql._bind_value("2024-01-15T10:30:00Z", "smalldatetime") == datetime.datetime(
        2024, 1, 15, 10, 30, tzinfo=datetime.timezone.utc
    )
    assert mssql._bind_value("12:00:00.1234567", "time") == "12:00:00.1234567"
    assert mssql._bind_value("2024-01-01 10:00:00.5 +01:00", "datetimeoffset") == (
        "2024-01-01 10:00:00.5 +01:00"
    )
    assert mssql._bind_value({"a": 1}, "nvarchar") == '{"a": 1}'
    assert mssql._bind_value(5, "int") == 5
    assert mssql._bind_value(None, "int") is None
    assert mssql._bind_value("plain", "nvarchar") == "plain"
    with pytest.raises(HTTPException):
        mssql._bind_value("zz", "varbinary")
    with pytest.raises(HTTPException):
        mssql._bind_value("not-a-date", "datetime2")


def test_managed_identity_requires_explicit_opt_in(monkeypatch):
    monkeypatch.setattr(mssql, "azure_identity_import_error", lambda: None)
    monkeypatch.delenv("GEOLIBRE_MSSQL_DESKTOP_AUTH", raising=False)
    monkeypatch.delenv("GEOLIBRE_MSSQL_ALLOW_MANAGED_IDENTITY", raising=False)
    assert "entra_sp" in mssql.available_auth_methods()
    assert "msi" not in mssql.available_auth_methods()
    monkeypatch.setenv("GEOLIBRE_MSSQL_ALLOW_MANAGED_IDENTITY", "1")
    assert "msi" in mssql.available_auth_methods()


def test_connect_rejects_managed_identity_without_opt_in(monkeypatch):
    monkeypatch.setattr(
        mssql, "_require_runtime", lambda: (object(), "ODBC Driver 18 for SQL Server")
    )
    monkeypatch.setattr(mssql, "_validate_target", lambda req: ("db.example", None))
    monkeypatch.delenv("GEOLIBRE_MSSQL_DESKTOP_AUTH", raising=False)
    monkeypatch.delenv("GEOLIBRE_MSSQL_ALLOW_MANAGED_IDENTITY", raising=False)
    req = mssql.MssqlConnectRequest(server="db.example", database="gis", auth={"method": "msi"})
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_connect(req)
    assert exc.value.status_code == 403


@pytest.fixture
def live_db(monkeypatch):
    server = os.environ["GEOLIBRE_TEST_MSSQL_SERVER"]
    database = os.environ.get("GEOLIBRE_TEST_MSSQL_DATABASE", "master")
    user = os.environ["GEOLIBRE_TEST_MSSQL_USER"]
    password = os.environ["GEOLIBRE_TEST_MSSQL_PASSWORD"]
    mssql._SESSIONS.clear()
    auth = mssql.MssqlAuth(method="sql", username=user, password=password)
    req = mssql.MssqlConnectRequest(
        server=server, database=database, auth=auth, trust_server_certificate=True
    )
    monkeypatch.setenv("GEOLIBRE_MSSQL_HOSTS", os.environ.get("GEOLIBRE_MSSQL_HOSTS", server))
    sid = mssql.mssql_connect(req)["session_id"]
    session = mssql._get_session(sid)
    conn = mssql._open_connection(session)
    cur = conn.cursor()
    cur.execute(
        "IF OBJECT_ID('dbo.geolibre_writeback_test','U') IS NOT NULL "
        "DROP TABLE dbo.geolibre_writeback_test"
    )
    cur.execute(
        "IF OBJECT_ID('dbo.geolibre_writeback_geog','U') IS NOT NULL "
        "DROP TABLE dbo.geolibre_writeback_geog"
    )
    cur.execute(
        "IF OBJECT_ID('dbo.geolibre_writeback_nopk','U') IS NOT NULL "
        "DROP TABLE dbo.geolibre_writeback_nopk"
    )
    for name in (
        "geolibre_writeback_composite",
        "geolibre_writeback_mixed",
        "geolibre_writeback_empty",
    ):
        cur.execute(f"IF OBJECT_ID('dbo.{name}','U') IS NOT NULL DROP TABLE dbo.{name}")
    # `seen`/`blob` guard the write path against re-binding json_safe strings:
    # SQL Server rejects a hex string into varbinary (257) and a six-digit
    # microsecond string into datetime2 (241), so an unchanged save must fail
    # without the type-aware binding.
    cur.execute(
        "CREATE TABLE dbo.geolibre_writeback_test (gid int IDENTITY PRIMARY KEY, "
        "name nvarchar(100) NOT NULL, population int, "
        "seen datetime2(7), seen_tz datetimeoffset, at_time time(7), "
        "blob varbinary(8), geom geometry)"
    )
    cur.execute(
        "INSERT INTO dbo.geolibre_writeback_test"
        "(name,population,seen,seen_tz,at_time,blob,geom) VALUES "
        "('Knoxville',190000,CAST('2024-01-01T12:00:00.1234567' AS datetime2(7)),"
        "'2024-01-01 12:00:00.5 +01:00','12:00:00.1234567',0x0102,"
        "geometry::Point(-9342009.589714656,4295201.3456280865,3857)),"
        "('Second',2,NULL,NULL,NULL,NULL,geometry::Point(-9000000,4000000,3857)),"
        "('Third',3,NULL,NULL,NULL,NULL,geometry::Point(-8000000,3500000,3857))"
    )
    cur.execute(
        "CREATE TABLE dbo.geolibre_writeback_geog (id uniqueidentifier DEFAULT NEWID() "
        "PRIMARY KEY, name nvarchar(100), geog geography)"
    )
    cur.execute(
        "INSERT INTO dbo.geolibre_writeback_geog(name,geog) VALUES "
        "('Knoxville',geography::Point(35.9606,-83.9207,4326))"
    )
    cur.execute("CREATE TABLE dbo.geolibre_writeback_nopk (name nvarchar(20), geom geometry)")
    cur.execute(
        "CREATE TABLE dbo.geolibre_writeback_composite (tenant_id int, parcel_id int, "
        "geom geometry, PRIMARY KEY (tenant_id, parcel_id))"
    )
    cur.execute(
        "INSERT INTO dbo.geolibre_writeback_composite VALUES (1, 7, geometry::Point(1, 2, 4326))"
    )
    cur.execute(
        "CREATE TABLE dbo.geolibre_writeback_mixed (id int IDENTITY PRIMARY KEY, geom geometry)"
    )
    cur.execute(
        "INSERT INTO dbo.geolibre_writeback_mixed(geom) VALUES "
        "(geometry::Point(-83, 35, 4326)), "
        "(geometry::Point(-7000000, 4000000, 3857)), "
        "(geometry::STGeomFromText('POLYGON ((0 0, 0 1, 1 1, 0 0))', 4326))"
    )
    cur.execute(
        "CREATE TABLE dbo.geolibre_writeback_empty (id int IDENTITY PRIMARY KEY, geom geometry)"
    )
    conn.commit()
    conn.close()
    try:
        yield sid
    finally:
        conn = mssql._open_connection(mssql._get_session(sid))
        cur = conn.cursor()
        for name in (
            "geolibre_writeback_test",
            "geolibre_writeback_geog",
            "geolibre_writeback_nopk",
            "geolibre_writeback_composite",
            "geolibre_writeback_mixed",
            "geolibre_writeback_empty",
        ):
            cur.execute(f"DROP TABLE dbo.{name}")
        conn.commit()
        conn.close()
        mssql.mssql_disconnect(mssql.MssqlSessionRequest(session_id=sid))


@requires_live_mssql
def test_live_tables_read_and_geography_axis_order(live_db):
    tables = mssql.mssql_tables(mssql.MssqlSessionRequest(session_id=live_db))["tables"]
    table = next(t for t in tables if t["table"] == "geolibre_writeback_test")
    assert (table["primary_key"], table["srid"], table["column_type"]) == ("gid", 3857, "geometry")
    assert table["primary_key_columns"] == ["gid"]
    no_pk = next(t for t in tables if t["table"] == "geolibre_writeback_nopk")
    assert no_pk["primary_key"] is None and no_pk["primary_key_columns"] == []
    composite = next(t for t in tables if t["table"] == "geolibre_writeback_composite")
    assert composite["primary_key"] is None
    assert composite["primary_key_columns"] == ["tenant_id", "parcel_id"]
    mixed = next(t for t in tables if t["table"] == "geolibre_writeback_mixed")
    assert mixed["mixed_srid"] is True and mixed["mixed_geometry"] is True
    mixed_read = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_mixed")
    )
    assert mixed_read["mixed_srid"] is True and mixed_read["mixed_geometry"] is True
    empty = next(t for t in tables if t["table"] == "geolibre_writeback_empty")
    assert (empty["srid"], empty["geometry_type"]) == (4326, "Unknown")
    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=live_db,
            table="geolibre_writeback_empty",
            geojson={
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [0, 0]},
                        "properties": {},
                    }
                ],
            },
        )
    )
    assert result["inserted"] == 1
    conn = mssql._open_connection(mssql._get_session(live_db))
    cur = conn.cursor()
    cur.execute("SELECT geom.STSrid FROM dbo.geolibre_writeback_empty")
    assert cur.fetchone()[0] == 4326
    conn.close()
    result = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    )
    feature = next(
        f for f in result["geojson"]["features"] if f["properties"]["name"] == "Knoxville"
    )
    assert feature["id"] == feature["properties"]["gid"]
    x, y = feature["geometry"]["coordinates"]
    assert abs(x + 83.9207) < 1e-4 and abs(y - 35.9606) < 1e-4
    geog = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_geog")
    )
    coords = geog["geojson"]["features"][0]["geometry"]["coordinates"]
    assert coords == pytest.approx([-83.9207, 35.9606], abs=1e-5)


@requires_live_mssql
def test_live_write_roundtrip_and_unchanged_save(live_db):
    request = mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    read = mssql.mssql_read(request)
    original = read["geojson"]
    baseline_keys = [feature["id"] for feature in original["features"]]
    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=live_db, table="geolibre_writeback_test", geojson=original
        )
    )
    assert (result["updated"], result["inserted"], result["deleted"]) == (0, 0, 0)
    features = original["features"]
    features[0]["properties"]["name"] = "Changed"
    features.pop(1)
    features.append(
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [-83.9, 35.9]},
            "properties": {"name": "New", "population": 5},
        }
    )
    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=live_db,
            table="geolibre_writeback_test",
            geojson=original,
            baseline_keys=baseline_keys,
        )
    )
    assert (result["updated"], result["inserted"], result["deleted"]) == (1, 1, 1)
    # The edit rewrote the row, so check the stored value, not a re-read: a read
    # and a write that truncate identically would still compare equal.
    conn = mssql._open_connection(mssql._get_session(live_db))
    cur = conn.cursor()
    cur.execute(
        "SELECT CONVERT(varchar(33), seen, 121), CONVERT(varchar(16), at_time, 121), "
        "CONVERT(varchar(40), seen_tz, 121) FROM dbo.geolibre_writeback_test "
        "WHERE name = 'Changed'"
    )
    seen, at_time, seen_tz = cur.fetchone()
    conn.close()
    assert seen == "2024-01-01 12:00:00.1234567"
    assert at_time == "12:00:00.1234567"
    assert seen_tz.startswith("2024-01-01 12:00:00.5") and seen_tz.endswith("+01:00")
    row = next(
        f
        for f in mssql.mssql_read(request)["geojson"]["features"]
        if f["properties"]["name"] == "Changed"
    )
    assert row["properties"]["seen_tz"].endswith("+01:00")


@requires_live_mssql
def test_live_write_empty_with_baseline_deletes_rows(live_db):
    read = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    )
    baseline_keys = [feature["id"] for feature in read["geojson"]["features"]]
    assert len(baseline_keys) == 3
    # A row added after the read is outside the baseline, so the empty save must keep it.
    conn = mssql._open_connection(mssql._get_session(live_db))
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO dbo.geolibre_writeback_test(name,population,geom) VALUES "
        "('Outside',4,geometry::Point(-7000000,3000000,3857))"
    )
    conn.commit()
    conn.close()
    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=live_db,
            table="geolibre_writeback_test",
            geojson={"type": "FeatureCollection", "features": []},
            baseline_keys=baseline_keys,
        )
    )
    assert (result["inserted"], result["updated"], result["deleted"]) == (0, 0, 3)
    conn = mssql._open_connection(mssql._get_session(live_db))
    cur = conn.cursor()
    cur.execute("SELECT gid, name FROM dbo.geolibre_writeback_test")
    rows = [tuple(row) for row in cur.fetchall()]
    conn.close()
    assert [name for _, name in rows] == ["Outside"]
    assert rows[0][0] not in baseline_keys


@requires_live_mssql
def test_live_write_rolls_back_capabilities_and_identity_key(live_db):
    read = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    )
    features = read["geojson"]["features"]
    original = features[0]["properties"]["name"]
    features[0]["properties"]["name"] = "Transient"
    features[1]["properties"]["name"] = None
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_write(
            mssql.MssqlWriteRequest(
                session_id=live_db,
                table="geolibre_writeback_test",
                geojson={"type": "FeatureCollection", "features": features},
            )
        )
    assert exc.value.status_code == 400
    fresh = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    )
    assert fresh["geojson"]["features"][0]["properties"]["name"] == original
    with pytest.raises(HTTPException) as exc:
        mssql.mssql_write(
            mssql.MssqlWriteRequest(
                session_id=live_db,
                table="geolibre_writeback_test",
                geojson={
                    "type": "FeatureCollection",
                    "features": fresh["geojson"]["features"][:-1],
                },
                capabilities={"delete": False},
            )
        )
    assert exc.value.status_code == 403
    fresh = mssql.mssql_read(
        mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
    )
    fresh["geojson"]["features"].append(
        {
            "type": "Feature",
            "id": 9999,
            "geometry": None,
            "properties": {"gid": 9999, "name": "Explicit"},
        }
    )
    result = mssql.mssql_write(
        mssql.MssqlWriteRequest(
            session_id=live_db, table="geolibre_writeback_test", geojson=fresh["geojson"]
        )
    )
    assert result["inserted"] == 1
    assert all(
        f["properties"]["gid"] != 9999
        for f in mssql.mssql_read(
            mssql.MssqlReadRequest(session_id=live_db, table="geolibre_writeback_test")
        )["geojson"]["features"]
    )


@requires_live_mssql
def test_live_geography_polygon_is_oriented(live_db):
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [[-83.9, 35.9], [-83.9, 36.0], [-84.0, 36.0], [-84.0, 35.9], [-83.9, 35.9]]
        ],
    }
    conn = mssql._open_connection(mssql._get_session(live_db))
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO dbo.geolibre_writeback_geog(name,geog) "
        "VALUES (?, geography::STGeomFromWKB(?,4326))",
        ("Polygon", mssql._geojson_to_wkb(polygon, 4326, "geography")),
    )
    conn.commit()
    cur.execute("SELECT geog.STArea() FROM dbo.geolibre_writeback_geog WHERE name='Polygon'")
    assert cur.fetchone()[0] < 1e10
    conn.close()


def test_geography_with_non_wgs84_srid_is_reprojected():
    shapely = pytest.importorskip("shapely")
    pytest.importorskip("pyproj")
    point = {"type": "Point", "coordinates": [-83.9, 35.9]}
    wkb = mssql._geojson_to_wkb(point, 3857, "geography")
    # Written in the column's SRID units, not raw degrees.
    assert abs(shapely.from_wkb(wkb).x) > 1000
    back = mssql._wkb_to_geojson(wkb, 3857, "geography")
    assert back["coordinates"] == pytest.approx([-83.9, 35.9], abs=1e-6)


def test_datetimeoffset_output_converter_decodes_struct():
    raw = struct.pack("<6hI2h", 2024, 1, 2, 3, 4, 5, 123456700, -5, -30)
    assert mssql._datetimeoffset_to_str(raw) == "2024-01-02 03:04:05.123456700 -05:30"


def test_time_and_timestamp_decoders_keep_seven_digits():
    assert mssql._time2_to_str(struct.pack("@3HI", 12, 0, 1, 123456700)) == "12:00:01.1234567"
    raw = struct.pack("@h5HI", 2024, 1, 2, 3, 4, 5, 123456700)
    assert mssql._timestamp_to_str(raw) == "2024-01-02 03:04:05.1234567"


def test_datetimeoffset_converter_passes_non_bytes_through():
    assert mssql._datetimeoffset_to_str("already text") == "already text"


def test_primary_key_is_rebound_by_column_type():
    assert mssql._bind_value("0a0b", "varbinary") == b"\x0a\x0b"
    assert mssql._bind_value(7, "int") == 7
