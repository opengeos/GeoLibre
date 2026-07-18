import pytest
from fastapi import HTTPException

from geolibre_server import sedona_ops
from geolibre_server.app.sql import SqlRunRequest, sql_run, sql_status

try:
    import sedona.db  # noqa: F401

    HAS_SEDONA = True
except Exception:  # pragma: no cover - depends on the optional extra
    HAS_SEDONA = False

requires_sedona = pytest.mark.skipif(
    not HAS_SEDONA, reason="apache-sedona[db] optional extra not installed"
)


def _points(name: str) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": name, "value": 1},
                "geometry": {"type": "Point", "coordinates": [0.0, 0.0]},
            },
            {
                "type": "Feature",
                "properties": {"name": name, "value": 2},
                "geometry": {"type": "Point", "coordinates": [1.0, 1.0]},
            },
        ],
    }


POINTS = _points("cities")


def test_status_returns_availability_shape() -> None:
    status = sql_status()
    assert set(status) == {"available", "message"}
    assert isinstance(status["available"], bool)
    assert isinstance(status["message"], str)


def test_run_without_sedona_raises_503(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sedona_ops, "sedonadb_import_error", lambda: "No module named 'sedona'")
    with pytest.raises(HTTPException) as exc:
        sql_run(SqlRunRequest(sql="SELECT 1"))
    assert exc.value.status_code == 503


def test_blank_sql_raises_400(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sedona_ops, "sedonadb_import_error", lambda: None)
    monkeypatch.setattr(sedona_ops, "run_sql", lambda *a, **k: {})
    with pytest.raises(HTTPException) as exc:
        sql_run(SqlRunRequest(sql="   "))
    assert exc.value.status_code == 400


@requires_sedona
def test_scalar_query_returns_rows() -> None:
    result = sql_run(SqlRunRequest(sql="SELECT 1 AS hello"))
    assert result["columns"] == ["hello"]
    assert result["rows"] == [{"hello": 1}]
    assert result["geometry_column"] is None
    assert result["geojson"] is None


@requires_sedona
def test_geometry_query_returns_geojson() -> None:
    result = sql_run(SqlRunRequest(sql="SELECT ST_Point(1.0, 2.0) AS geometry"))
    assert result["geometry_column"] == "geometry"
    assert result["geojson"]["type"] == "FeatureCollection"
    assert len(result["geojson"]["features"]) == 1
    # Geometry is rendered as WKT in the results grid.
    assert "POINT" in result["rows"][0]["geometry"].upper()


@requires_sedona
def test_registered_layer_is_queryable() -> None:
    result = sql_run(
        SqlRunRequest(
            sql="SELECT COUNT(*) AS n FROM cities",
            layers=[{"name": "cities", "geojson": POINTS}],
        )
    )
    assert result["rows"][0]["n"] == 2


@requires_sedona
def test_invalid_view_name_returns_400() -> None:
    with pytest.raises(HTTPException) as exc:
        sql_run(
            SqlRunRequest(
                sql="SELECT 1",
                layers=[{"name": 'bad"; DROP TABLE x; --', "geojson": POINTS}],
            )
        )
    assert exc.value.status_code == 400


@requires_sedona
def test_invalid_sql_returns_400() -> None:
    with pytest.raises(HTTPException) as exc:
        sql_run(SqlRunRequest(sql="SELECT * FROM no_such_table"))
    assert exc.value.status_code == 400


@requires_sedona
def test_run_rejects_oversized_layer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sedona_ops, "MAX_FEATURES", 1)
    big = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {}, "geometry": None},
            {"type": "Feature", "properties": {}, "geometry": None},
        ],
    }
    with pytest.raises(HTTPException) as exc:
        sql_run(SqlRunRequest(sql="SELECT 1", layers=[{"name": "big", "geojson": big}]))
    assert exc.value.status_code == 413
