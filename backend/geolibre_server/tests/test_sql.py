import pytest
from fastapi import HTTPException

from geolibre_server import sedona_ops
from geolibre_server.app.sql import SqlRunRequest, sql_run, sql_status
from geolibre_server.sedona_ops import SqlTimeout

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


@requires_sedona
def test_run_rejects_oversized_result(monkeypatch: pytest.MonkeyPatch) -> None:
    """Query results that expand past MAX_FEATURES are refused with 413."""
    monkeypatch.setattr(sedona_ops, "MAX_FEATURES", 1)
    limited_to: list[int] = []

    class _FakeFrame:
        def __len__(self) -> int:
            return 2

        @property
        def columns(self):
            return ["n"]

        def to_dict(self, orient: str):  # noqa: ARG002
            return [{"n": 1}, {"n": 2}]

    class _FakeResult:
        def limit(self, n: int) -> "_FakeResult":
            limited_to.append(n)
            return self

        def to_pandas(self):
            return _FakeFrame()

    class _FakeConnection:
        def create_data_frame(self, gdf):  # noqa: ANN001, ARG002
            class _View:
                def to_view(self, name: str) -> None:  # noqa: ARG002
                    return None

            return _View()

        def sql(self, statement: str):  # noqa: ARG002
            return _FakeResult()

        def close(self) -> None:
            return None

    monkeypatch.setattr(
        sedona_ops,
        "_import_sedona",
        lambda: type("M", (), {"connect": staticmethod(lambda: _FakeConnection())})(),
    )
    with pytest.raises(HTTPException) as exc:
        sql_run(SqlRunRequest(sql="SELECT 1 AS n UNION ALL SELECT 2 AS n"))
    assert exc.value.status_code == 413
    assert "Query result exceeds" in str(exc.value.detail)
    assert limited_to == [sedona_ops.MAX_FEATURES + 1]


def test_statement_timeout_constant_exists() -> None:
    """The wall-clock timeout constant must be defined and positive."""
    assert hasattr(sedona_ops, "_STATEMENT_TIMEOUT_MS")
    assert sedona_ops._STATEMENT_TIMEOUT_MS > 0


def test_sql_timeout_maps_to_504(monkeypatch: pytest.MonkeyPatch) -> None:
    """A SqlTimeout from run_sql is surfaced as HTTP 504."""
    monkeypatch.setattr(sedona_ops, "sedonadb_import_error", lambda: None)

    def _boom(*_a, **_kw):
        raise SqlTimeout("Spatial SQL timed out after 60 seconds")

    monkeypatch.setattr(sedona_ops, "run_sql", _boom)
    with pytest.raises(HTTPException) as exc:
        sql_run(SqlRunRequest(sql="SELECT pg_sleep(999)"))
    assert exc.value.status_code == 504
    assert "timed out" in str(exc.value.detail)


def test_run_sql_raises_timeout_on_slow_query(monkeypatch: pytest.MonkeyPatch) -> None:
    """run_sql raises SqlTimeout when the query exceeds the budget."""
    import time

    monkeypatch.setattr(sedona_ops, "_STATEMENT_TIMEOUT_MS", 100)

    class _FakeConnection:
        def sql(self, statement):  # noqa: ARG002
            time.sleep(5)

        def close(self):
            pass

    fake_mod = type("M", (), {"connect": staticmethod(lambda: _FakeConnection())})()
    monkeypatch.setattr(sedona_ops, "_import_sedona", lambda: fake_mod)

    with pytest.raises(SqlTimeout, match="timed out"):
        sedona_ops.run_sql("SELECT 1")
