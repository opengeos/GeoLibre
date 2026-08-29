"""The sidecar's geometry-column detection, against the shared GeoParquet fixtures.

``tests/fixtures/geoparquet`` holds one small Parquet file per GeoParquet
variant the app has to read, plus an ``expectations.json`` the browser suite
(``tests/geoparquet-metadata.test.ts``) asserts against. The detection rules
live in three places — TypeScript, Rust and this sidecar — and drift between
them is silent, so the same fixtures are read here.

These run the sidecar's embedded conversion script in a subprocess with this
environment's Python, the way the managed runtime executes it, and skip when
DuckDB or its spatial extension is unavailable (the extension download needs
network on first run).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from geolibre_server.app.conversion import _RESULT_MARKER, _VECTOR_SCRIPT

duckdb = pytest.importorskip("duckdb", reason="conversion extra not installed")

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "geoparquet"


@pytest.fixture(scope="module")
def spatial_extension() -> None:
    """Skip the module when the DuckDB spatial extension cannot be loaded."""
    try:
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        con.close()
    except Exception as exc:  # pragma: no cover - offline environments
        pytest.skip(f"DuckDB spatial extension unavailable: {exc}")


@pytest.fixture(scope="module")
def expectations() -> dict[str, dict]:
    """The shared expectations, keyed by fixture file name."""
    document = json.loads((FIXTURES / "expectations.json").read_text(encoding="utf-8"))
    return {entry["file"]: entry for entry in document["files"]}


def _convert(fixture: str, output: Path) -> subprocess.CompletedProcess[str]:
    """Run the sidecar's GeoParquet conversion script over one fixture."""
    params = {
        "input_path": str(FIXTURES / fixture),
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


def test_fixtures_are_present() -> None:
    """The committed fixtures exist; regenerate.sh rebuilds them."""
    assert (FIXTURES / "expectations.json").is_file()
    assert (FIXTURES / "no_geo_metadata_wkb.parquet").is_file()
    assert (FIXTURES / "lonlat_columns.parquet").is_file()


def test_detects_a_wkb_blob_named_geom(
    spatial_extension: None, expectations: dict[str, dict], tmp_path: Path
) -> None:
    """A plain Parquet with a `geom` WKB blob and no `geo` key still converts."""
    expected = expectations["no_geo_metadata_wkb.parquet"]
    assert expected["detectionRoute"] == "wkb-column-name"

    result = _result(_convert("no_geo_metadata_wkb.parquet", tmp_path / "out.parquet"))
    assert result["geometry_column"] == expected["geometryColumn"]
    assert result["feature_count"] == 200


def test_detects_the_declared_primary_column(
    spatial_extension: None, expectations: dict[str, dict], tmp_path: Path
) -> None:
    """A projected 1.1 file converts through its declared geometry column."""
    expected = expectations["wkb_1_1_covering.parquet"]
    result = _result(_convert("wkb_1_1_covering.parquet", tmp_path / "out.parquet"))
    assert result["geometry_column"] == expected["geometryColumn"]


def test_lon_lat_columns_are_not_detected_by_the_sidecar(
    spatial_extension: None, expectations: dict[str, dict], tmp_path: Path
) -> None:
    """A lon/lat table has no geometry column for the sidecar to find.

    The browser loader synthesizes points from such a pair (see
    ``detectGeometryColumn``'s ``allowCoordinateColumns``); the sidecar does not,
    and asks the caller to pick the columns explicitly through its CSV path
    instead. This pins the gap so it is a decision rather than a surprise.
    """
    assert expectations["lonlat_columns.parquet"]["detectionRoute"] == "coordinate-columns"

    proc = _convert("lonlat_columns.parquet", tmp_path / "out.parquet")
    assert proc.returncode != 0
    assert "No geometry column found" in (proc.stdout + proc.stderr)
