"""Tests for Section 5e sidecar features: multi-tenant, DB bbox/409, and vector write-back."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from geolibre_server.app import conversion, db_common, mssql, postgis, tenant, vector
from geolibre_server.app.job_manager import JobManager
from geolibre_server.app.main import app


def test_tenant_isolation_job_manager_and_workspace_roots(tmp_path, monkeypatch):
    root = tmp_path / "tenants"
    (root / "alice").mkdir(parents=True)
    (root / "bob").mkdir(parents=True)
    monkeypatch.setenv("GEOLIBRE_MULTI_TENANT", "1")
    monkeypatch.setenv("GEOLIBRE_TENANT_WORKSPACES_ROOT", str(root))

    manager = JobManager()

    # Start a job under tenant "alice"
    tok_alice = tenant.set_current_tenant("alice")
    try:
        started = threading.Event()
        release = threading.Event()

        def worker(job_id):
            started.set()
            release.wait(timeout=2)
            with manager.lock:
                manager.jobs[job_id].status = "succeeded"

        job = manager.start_thread_job("demo", worker)
        assert started.wait(timeout=2)
        assert manager.get(job.id) is not None

        # Alice can access her own workspace root, not Bob's
        alice_file = root / "alice" / "data.geojson"
        bob_file = root / "bob" / "data.geojson"
        alice_file.write_text("{}", encoding="utf-8")
        bob_file.write_text("{}", encoding="utf-8")
        assert conversion._is_within_roots(alice_file) is True
        assert conversion._is_within_roots(bob_file) is False
    finally:
        tenant.reset_current_tenant(tok_alice)

    # Bob cannot read or cancel Alice's job
    tok_bob = tenant.set_current_tenant("bob")
    try:
        assert manager.get(job.id) is None
        assert manager.cancel(job.id) is None
    finally:
        tenant.reset_current_tenant(tok_bob)

    release.set()
    tok_alice2 = tenant.set_current_tenant("alice")
    try:
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            cur = manager.get(job.id)
            if cur and cur.status == "succeeded":
                break
            time.sleep(0.02)
        assert manager.get(job.id).status == "succeeded"
    finally:
        tenant.reset_current_tenant(tok_alice2)


def test_multi_tenant_middleware_requires_header_when_enabled(monkeypatch):
    monkeypatch.setenv("GEOLIBRE_MULTI_TENANT", "1")
    client = TestClient(app)

    # Health check stays accessible without tenant header
    health = client.get("/health")
    assert health.status_code == 200

    # Non-health route without tenant header returns 400
    missing = client.get("/api/jobs/nonexistent")
    assert missing.status_code == 400
    assert "X-GeoLibre-Tenant" in missing.json()["detail"]

    # Invalid tenant characters rejected
    bad = client.get("/api/jobs/nonexistent", headers={"X-GeoLibre-Tenant": "../etc"})
    assert bad.status_code == 400

    # Valid tenant passes middleware and reaches handler (404 for unknown job)
    ok = client.get("/api/jobs/nonexistent", headers={"X-GeoLibre-Tenant": "org-123"})
    assert ok.status_code == 404


def test_mssql_session_isolation_across_tenants(monkeypatch):
    monkeypatch.setenv("GEOLIBRE_MULTI_TENANT", "1")
    mssql._SESSIONS.clear()
    tok_a = tenant.set_current_tenant("tenant-a")
    try:
        mssql._SESSIONS["sess-1"] = mssql._Session(
            connection_string="DRIVER={ODBC};SERVER=localhost",
            credential=None,
            static_token=None,
            secrets=(),
            last_used=time.monotonic(),
            tenant_id="tenant-a",
        )
        assert mssql._get_session("sess-1").tenant_id == "tenant-a"
    finally:
        tenant.reset_current_tenant(tok_a)

    tok_b = tenant.set_current_tenant("tenant-b")
    try:
        with pytest.raises(HTTPException) as exc:
            mssql._get_session("sess-1")
        assert exc.value.status_code == 410
    finally:
        tenant.reset_current_tenant(tok_b)
        mssql._SESSIONS.clear()


def test_db_common_validate_bbox_and_optimistic_concurrency():
    assert db_common.validate_bbox([-10, 20, 30, 40]) == (-10.0, 20.0, 30.0, 40.0)
    assert db_common.validate_bbox(None) is None

    with pytest.raises(HTTPException) as exc:
        db_common.validate_bbox([10, 20, 5, 40])
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        db_common.validate_bbox([1, 2, 3])
    assert exc.value.status_code == 400

    existing = {
        1: ({"type": "Point", "coordinates": [0, 0]}, {"name": "A"}),
        2: ({"type": "Point", "coordinates": [1, 1]}, {"name": "B"}),
    }
    hash1 = db_common.row_state_hash(*existing[1])
    hash2 = db_common.row_state_hash(*existing[2])
    assert hash1 != hash2

    # Matching hashes succeed
    db_common.check_optimistic_concurrency(existing, {"1": hash1}, [1])
    # Untouched row with stale hash is ignored
    db_common.check_optimistic_concurrency(existing, {"2": "stale"}, [1])
    # Modified row with stale hash raises 409 Conflict
    with pytest.raises(HTTPException) as conflict:
        db_common.check_optimistic_concurrency(existing, {"1": "stale"}, [1])
    assert conflict.value.status_code == 409
    assert "concurrent modification" in str(conflict.value.detail).lower()

    # MSSQL bbox envelope WKT helper
    wkt, env_srid = mssql._bbox_envelope_wkt((-1.0, 2.0, 3.0, 4.0), 4326, "geometry")
    assert env_srid == 4326
    assert wkt == "POLYGON((-1.0 2.0, 3.0 2.0, 3.0 4.0, -1.0 4.0, -1.0 2.0))"


def test_postgis_and_mssql_request_models_accept_bbox_and_expected_hashes():
    pg_read = postgis.PostgisReadRequest(
        connection="postgresql://localhost/gis",
        schema_name="public",
        table="roads",
        bbox=[-122.5, 37.7, -122.3, 37.8],
    )
    assert pg_read.bbox == [-122.5, 37.7, -122.3, 37.8]

    pg_write = postgis.PostgisWriteRequest(
        connection="postgresql://localhost/gis",
        schema_name="public",
        table="roads",
        geojson={"type": "FeatureCollection", "features": []},
        expected_row_hashes={"1": "abc"},
    )
    assert pg_write.expected_row_hashes == {"1": "abc"}

    ms_read = mssql.MssqlReadRequest(
        session_id="s1",
        schema_name="dbo",
        table="parcels",
        bbox=[-10.0, -10.0, 10.0, 10.0],
    )
    assert ms_read.bbox == [-10.0, -10.0, 10.0, 10.0]

    ms_write = mssql.MssqlWriteRequest(
        session_id="s1",
        schema_name="dbo",
        table="parcels",
        geojson={"type": "FeatureCollection", "features": []},
        expected_row_hashes={"42": "def"},
    )
    assert ms_write.expected_row_hashes == {"42": "def"}


@pytest.mark.parametrize("ext", [".shp", ".fgb", ".parquet"])
def test_vector_write_back_supports_shapefile_flatgeobuf_and_geoparquet(tmp_path, monkeypatch, ext):
    gpd = pytest.importorskip("geopandas")
    from shapely.geometry import Point

    if ext == ".parquet":
        pytest.importorskip("pyarrow")

    monkeypatch.setenv("GEOLIBRE_CONVERSION_ROOTS", str(tmp_path))

    source = tmp_path / f"sample{ext}"
    # Start in EPSG:3857 so we also verify CRS preservation on write-back
    gdf = gpd.GeoDataFrame(
        {"name": ["Original"], "value": [1]},
        geometry=[Point(0.0, 0.0)],
        crs="EPSG:3857",
    )
    if ext == ".parquet":
        gdf.to_parquet(source)
    elif ext == ".fgb":
        gdf.to_file(source, driver="FlatGeobuf")
    else:
        gdf.to_file(source, driver="ESRI Shapefile")

    updated_fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "Updated", "value": 42},
                "geometry": {"type": "Point", "coordinates": [1.0, 2.0]},
            }
        ],
    }

    result = vector.vector_write(vector.WriteVectorRequest(path=str(source), geojson=updated_fc))
    assert result["feature_count"] == 1
    assert Path(result["path"]) == source.resolve()

    reloaded = gpd.read_parquet(source) if ext == ".parquet" else gpd.read_file(source)
    assert len(reloaded) == 1
    assert reloaded["name"].iloc[0] == "Updated"
    assert int(reloaded["value"].iloc[0]) == 42
    assert reloaded.crs is not None
    assert reloaded.crs.to_epsg() == 3857
