"""Tests for the PostGIS editable-layer endpoints (issue #1070 phase 2).

Two tiers:

- Validation and status tests that need only psycopg installed (no server).
- Live round-trip tests against a real PostGIS database, enabled by setting
  ``GEOLIBRE_TEST_POSTGIS_DSN`` to a connection string with rights to create
  and drop tables. Without it they skip, mirroring how the other optional
  engines (geopandas/rasterio/sedona) gate their suites.
"""

from __future__ import annotations

import os

import pytest
from fastapi import HTTPException

from geolibre_server.app.postgis import (
    PostgisReadRequest,
    PostgisTablesRequest,
    PostgisWriteRequest,
    _sanitize_error,
    postgis_read,
    postgis_status,
    postgis_tables,
    postgis_write,
)

try:
    import psycopg

    HAS_PSYCOPG = True
except Exception:  # pragma: no cover - depends on the optional extra
    HAS_PSYCOPG = False

requires_psycopg = pytest.mark.skipif(
    not HAS_PSYCOPG, reason="psycopg optional extra not installed"
)

LIVE_DSN = os.environ.get("GEOLIBRE_TEST_POSTGIS_DSN", "")

requires_live_postgis = pytest.mark.skipif(
    not (HAS_PSYCOPG and LIVE_DSN),
    reason="GEOLIBRE_TEST_POSTGIS_DSN not set",
)

TABLE = "geolibre_writeback_test"
NO_PK_TABLE = "geolibre_writeback_nopk"


def _collection(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def _point(lon: float, lat: float) -> dict:
    return {"type": "Point", "coordinates": [lon, lat]}


def test_status_reports_availability() -> None:
    result = postgis_status()
    assert result["available"] is HAS_PSYCOPG
    assert "message" in result


def test_sanitize_error_scrubs_passwords() -> None:
    url = "connection to postgresql://alice:hunter2@db.example.com/gis failed"
    assert "hunter2" not in _sanitize_error(url)
    kv = "invalid dsn: host=db user=alice password=hunter2 dbname=gis"
    assert "hunter2" not in _sanitize_error(kv)


@requires_psycopg
def test_empty_connection_rejected() -> None:
    with pytest.raises(HTTPException) as exc:
        postgis_tables(PostgisTablesRequest(connection="   "))
    assert exc.value.status_code == 400


@requires_psycopg
def test_connect_failure_does_not_leak_password() -> None:
    request = PostgisReadRequest(
        connection="postgresql://alice:sekretpw@127.0.0.1:1/nope",
        table="whatever",
    )
    with pytest.raises(HTTPException) as exc:
        postgis_read(request)
    assert exc.value.status_code == 400
    assert "sekretpw" not in str(exc.value.detail)


@requires_psycopg
def test_write_requires_features() -> None:
    request = PostgisWriteRequest(
        connection="postgresql://localhost/ignored",
        table=TABLE,
        geojson=_collection([]),
    )
    with pytest.raises(HTTPException) as exc:
        postgis_write(request)
    assert exc.value.status_code == 400


@requires_psycopg
def test_write_rejects_oversized_payloads() -> None:
    from geolibre_server import vector_ops

    feature = {"type": "Feature", "properties": {}, "geometry": _point(0, 0)}
    request = PostgisWriteRequest(
        connection="postgresql://localhost/ignored",
        table=TABLE,
        geojson=_collection([feature] * (vector_ops.MAX_FEATURES + 1)),
    )
    with pytest.raises(HTTPException) as exc:
        postgis_write(request)
    assert exc.value.status_code == 413


# --- Live round-trip tests ---------------------------------------------------


@pytest.fixture()
def live_table():
    """(Re)create the test tables with real city rows in EPSG:3857."""
    with psycopg.connect(LIVE_DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS {TABLE}")
            cur.execute(f"DROP TABLE IF EXISTS {NO_PK_TABLE}")
            cur.execute(
                f"""
                CREATE TABLE {TABLE} (
                    gid integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    name text NOT NULL,
                    population integer,
                    geom geometry(Point, 3857)
                )
                """
            )
            # Knoxville, Memphis, Nashville (lon/lat), stored projected.
            for name, population, lon, lat in [
                ("Knoxville", 190740, -83.9207, 35.9606),
                ("Memphis", 633104, -90.0490, 35.1495),
                ("Nashville", 689447, -86.7816, 36.1627),
            ]:
                cur.execute(
                    f"""
                    INSERT INTO {TABLE} (name, population, geom)
                    VALUES (%s, %s,
                            ST_Transform(ST_SetSRID(ST_MakePoint(%s, %s), 4326), 3857))
                    """,
                    (name, population, lon, lat),
                )
            cur.execute(
                f"""
                CREATE TABLE {NO_PK_TABLE} (
                    name text,
                    geom geometry(Point, 4326)
                )
                """
            )
            cur.execute(
                f"INSERT INTO {NO_PK_TABLE} (name, geom) "
                "VALUES ('x', ST_SetSRID(ST_MakePoint(0, 0), 4326))"
            )
        conn.commit()
    yield
    with psycopg.connect(LIVE_DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS {TABLE}")
            cur.execute(f"DROP TABLE IF EXISTS {NO_PK_TABLE}")
        conn.commit()


def _rows(query: str, params: tuple = ()) -> list[tuple]:
    with psycopg.connect(LIVE_DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            return cur.fetchall()


@requires_live_postgis
def test_tables_lists_spatial_tables(live_table) -> None:
    result = postgis_tables(PostgisTablesRequest(connection=LIVE_DSN))
    by_name = {entry["table"]: entry for entry in result["tables"]}
    assert by_name[TABLE]["primary_key"] == "gid"
    assert by_name[TABLE]["srid"] == 3857
    assert by_name[TABLE]["geometry_column"] == "geom"
    assert by_name[NO_PK_TABLE]["primary_key"] is None


@requires_live_postgis
def test_read_returns_wgs84_with_primary_key(live_table) -> None:
    result = postgis_read(PostgisReadRequest(connection=LIVE_DSN, table=TABLE))
    assert result["srid"] == 3857
    assert result["primary_key"] == "gid"
    assert result["feature_count"] == 3
    features = result["geojson"]["features"]
    knox = next(f for f in features if f["properties"]["name"] == "Knoxville")
    lon, lat = knox["geometry"]["coordinates"]
    # Transformed back to lon/lat despite the projected source table.
    assert lon == pytest.approx(-83.9207, abs=1e-4)
    assert lat == pytest.approx(35.9606, abs=1e-4)
    assert knox["id"] == knox["properties"]["gid"]


@requires_live_postgis
def test_read_unknown_table_404(live_table) -> None:
    with pytest.raises(HTTPException) as exc:
        postgis_read(PostgisReadRequest(connection=LIVE_DSN, table="no_such"))
    assert exc.value.status_code == 404


@requires_live_postgis
def test_write_updates_inserts_and_deletes(live_table) -> None:
    read = postgis_read(PostgisReadRequest(connection=LIVE_DSN, table=TABLE))
    features = read["geojson"]["features"]
    knox = next(f for f in features if f["properties"]["name"] == "Knoxville")
    memphis = next(f for f in features if f["properties"]["name"] == "Memphis")

    # Update Knoxville's attributes and move its point; drop Memphis; add a new
    # city without a primary key (exercises the identity default).
    knox["properties"]["population"] = 200000
    knox["geometry"] = _point(-84.0, 36.0)
    chattanooga = {
        "type": "Feature",
        "properties": {"name": "Chattanooga", "population": 181099},
        "geometry": _point(-85.3097, 35.0456),
    }
    edited = [f for f in features if f is not memphis] + [chattanooga]

    result = postgis_write(
        PostgisWriteRequest(
            connection=LIVE_DSN, table=TABLE, geojson=_collection(edited)
        )
    )
    assert result["updated"] == 2
    assert result["inserted"] == 1
    assert result["deleted"] == 1

    rows = _rows(
        f"SELECT name, population, ST_SRID(geom), "
        f"ST_X(ST_Transform(geom, 4326)) FROM {TABLE} ORDER BY name"
    )
    names = [row[0] for row in rows]
    assert names == ["Chattanooga", "Knoxville", "Nashville"]
    by_name = {row[0]: row for row in rows}
    assert by_name["Knoxville"][1] == 200000
    # The source table keeps its projected SRID and gets the moved point back.
    assert by_name["Knoxville"][2] == 3857
    assert by_name["Knoxville"][3] == pytest.approx(-84.0, abs=1e-6)
    # The identity key survived the update and advanced for the insert.
    knox_gid = _rows(f"SELECT gid FROM {TABLE} WHERE name = 'Knoxville'")[0][0]
    assert knox_gid == knox["properties"]["gid"]


@requires_live_postgis
def test_write_reports_skipped_columns(live_table) -> None:
    read = postgis_read(PostgisReadRequest(connection=LIVE_DSN, table=TABLE))
    features = read["geojson"]["features"]
    features[0]["properties"]["added_in_editor"] = "not a column"
    result = postgis_write(
        PostgisWriteRequest(
            connection=LIVE_DSN, table=TABLE, geojson=_collection(features)
        )
    )
    assert any("added_in_editor" in message for message in result["messages"])


@requires_live_postgis
def test_write_rolls_back_on_failure(live_table) -> None:
    read = postgis_read(PostgisReadRequest(connection=LIVE_DSN, table=TABLE))
    features = read["geojson"]["features"]
    # First feature is a valid update, second violates NOT NULL on name: the
    # whole commit must roll back, leaving all three original rows intact.
    features[0]["properties"]["population"] = 1
    features[1]["properties"]["name"] = None
    with pytest.raises(HTTPException) as exc:
        postgis_write(
            PostgisWriteRequest(
                connection=LIVE_DSN, table=TABLE, geojson=_collection(features)
            )
        )
    assert exc.value.status_code == 400
    rows = _rows(f"SELECT name, population FROM {TABLE} ORDER BY name")
    assert [row[0] for row in rows] == ["Knoxville", "Memphis", "Nashville"]
    assert all(row[1] not in (1, None) for row in rows)


@requires_live_postgis
def test_write_requires_single_column_primary_key(live_table) -> None:
    feature = {
        "type": "Feature",
        "properties": {"name": "y"},
        "geometry": _point(1, 1),
    }
    with pytest.raises(HTTPException) as exc:
        postgis_write(
            PostgisWriteRequest(
                connection=LIVE_DSN,
                table=NO_PK_TABLE,
                geojson=_collection([feature]),
            )
        )
    assert exc.value.status_code == 400
    assert "primary key" in str(exc.value.detail)
