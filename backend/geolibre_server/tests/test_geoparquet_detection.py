"""The sidecar's geometry-column detection, over GeoParquet variants built here.

The detection rules are implemented three times over — in TypeScript for the
browser loader (``tests/geoparquet-metadata.test.ts``), in Rust for the desktop
native-DuckDB loader (``native_duckdb.rs``) and here in the sidecar — and drift
between them is silent, so each suite pins the same variants. Nothing is
committed as a binary fixture: every input below is written into ``tmp_path`` by
DuckDB itself at test time, which also keeps the expectations honest about what
a real writer emits. The sidecar deliberately does *not* synthesize points from
lon/lat columns; that gap is pinned below.

One test reads a remote sample instead — the SQL Workspace's own sample dataset
— so the HTTP path through ``read_parquet`` is covered too. It skips when
``data.source.coop`` cannot be reached.

These run the sidecar's embedded conversion script in a subprocess with this
environment's Python, the way the managed runtime executes it, and skip when
DuckDB or its spatial extension is unavailable (the extension download needs
network on first run).
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from geolibre_server.app.conversion import _RESULT_MARKER, _VECTOR_SCRIPT

duckdb = pytest.importorskip("duckdb", reason="conversion extra not installed")

# The GeoParquet sample the SQL Workspace ships as its starting query
# (``SAMPLE_DATASET_URL`` in ``apps/geolibre-desktop/src/lib/sql-workspace.ts``).
# ~200 kB, a `geom` column declared through the file's own `geo` block.
SAMPLE_DATASET_URL = "https://data.source.coop/giswqs/opengeos/countries.parquet"
SAMPLE_DATASET_HOST = "data.source.coop"


def _sample_dataset_is_reachable() -> bool:
    """Whether the remote sample's host answers on 443 within two seconds."""
    try:
        with socket.create_connection((SAMPLE_DATASET_HOST, 443), timeout=2):
            return True
    except OSError:  # pragma: no cover - offline environments
        return False


@pytest.fixture
def sample_dataset_url() -> str:
    """The remote sample's URL, or a skip when its host cannot be reached.

    Probed here rather than in a module-level marker so that importing and
    collecting this file opens no connection; only the one test that reads
    the sample pays for the probe.
    """
    if not _sample_dataset_is_reachable():
        pytest.skip(f"{SAMPLE_DATASET_HOST} is unreachable (offline)")
    return SAMPLE_DATASET_URL


@pytest.fixture(scope="module")
def spatial_extension() -> None:
    """Skip the module when the DuckDB spatial extension cannot be loaded."""
    try:
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        con.close()
    except Exception as exc:  # pragma: no cover - offline environments
        pytest.skip(f"DuckDB spatial extension unavailable: {exc}")


def _write(sql: str, target: Path) -> Path:
    """Run one ``COPY ... TO`` against a fresh DuckDB and return the target."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(sql.format(target=f"'{target}'"))
    con.close()
    return target


def _wkb_blob_parquet(target: Path) -> Path:
    """Plain Parquet: a WKB blob named ``geom``, and no ``geo`` key at all.

    DuckDB writes no ``geo`` metadata for a BLOB column, so the file really does
    reach the sidecar's name-based fallback rather than its GEOMETRY path.
    """
    return _write(
        """
        COPY (
          SELECT ST_AsWKB(ST_Point(-71.2 + 0.4 * (i % 20) / 20.0,
                                   42.2 + 0.3 * (i % 17) / 17.0)) AS geom,
                 i AS id
          FROM range(200) t(i)
        ) TO {target} (FORMAT PARQUET);
        """,
        target,
    )


def _projected_geoparquet(target: Path) -> Path:
    """GeoParquet whose ``geo`` block declares a projected geometry column."""
    return _write(
        """
        COPY (
          SELECT ST_Point(220000 + 40 * (i % 45),
                          890000 + 40 * (i // 45))::GEOMETRY('EPSG:26986') AS geometry,
                 i AS id,
                 'parcel_' || i AS loc_id
          FROM range(300) t(i)
        ) TO {target} (FORMAT PARQUET);
        """,
        target,
    )


def _lon_lat_parquet(target: Path) -> Path:
    """No geometry at all: a lon/lat pair of doubles."""
    return _write(
        """
        COPY (
          SELECT (-71.2 + 0.4 * (i % 20) / 20.0)::DOUBLE AS lon,
                 (42.2 + 0.3 * (i % 17) / 17.0)::DOUBLE AS lat,
                 i AS id,
                 'station_' || i AS name
          FROM range(200) t(i)
        ) TO {target} (FORMAT PARQUET);
        """,
        target,
    )


def _convert(source: str | Path, output: Path) -> subprocess.CompletedProcess[str]:
    """Run the sidecar's GeoParquet conversion script over one input."""
    params = {
        "input_path": str(source),
        "output_path": str(output),
        "output_format": "parquet",
        "source_kind": "auto",
    }
    return subprocess.run(
        [sys.executable, "-c", _VECTOR_SCRIPT, json.dumps(params)],
        capture_output=True,
        text=True,
        timeout=300,
    )


def _result(proc: subprocess.CompletedProcess[str]) -> dict:
    assert proc.returncode == 0, f"script failed:\n{proc.stdout}\n{proc.stderr}"
    for line in proc.stdout.splitlines():
        if line.startswith(_RESULT_MARKER):
            return json.loads(line[len(_RESULT_MARKER) :])
    raise AssertionError(f"no result marker in output:\n{proc.stdout}")


def test_detects_a_wkb_blob_named_geom(spatial_extension: None, tmp_path: Path) -> None:
    """A plain Parquet with a `geom` WKB blob and no `geo` key still converts."""
    source = _wkb_blob_parquet(tmp_path / "no_geo_metadata_wkb.parquet")

    result = _result(_convert(source, tmp_path / "out.parquet"))
    assert result["geometry_column"] == "geom"
    assert result["feature_count"] == 200


def test_detects_the_declared_geometry_column(spatial_extension: None, tmp_path: Path) -> None:
    """A projected GeoParquet converts through its declared geometry column."""
    source = _projected_geoparquet(tmp_path / "projected.parquet")

    result = _result(_convert(source, tmp_path / "out.parquet"))
    assert result["geometry_column"] == "geometry"
    assert result["feature_count"] == 300


def test_lon_lat_columns_are_not_detected_by_the_sidecar(
    spatial_extension: None, tmp_path: Path
) -> None:
    """A lon/lat table has no geometry column for the sidecar to find.

    The browser loader synthesizes points from such a pair (see
    ``detectGeometryColumn``'s ``allowCoordinateColumns``); the sidecar does not,
    and asks the caller to pick the columns explicitly through its CSV path
    instead. This pins the gap so it is a decision rather than a surprise.
    """
    source = _lon_lat_parquet(tmp_path / "lonlat_columns.parquet")

    proc = _convert(source, tmp_path / "out.parquet")
    assert proc.returncode != 0
    assert "No geometry column found" in (proc.stdout + proc.stderr)


def test_detects_the_geometry_column_of_the_remote_sample(
    spatial_extension: None, sample_dataset_url: str, tmp_path: Path
) -> None:
    """The SQL Workspace's sample dataset is read straight over HTTPS.

    A real published GeoParquet, read through ``read_parquet`` on an https URL
    (DuckDB autoloads httpfs), names its geometry column `geom` — the fallback
    name list is not what finds it here, the file's own `geo` block is.
    """
    result = _result(_convert(sample_dataset_url, tmp_path / "out.parquet"))
    assert result["geometry_column"] == "geom"
    assert result["feature_count"] > 0
