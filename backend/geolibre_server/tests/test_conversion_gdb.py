"""Integration tests for Esri File Geodatabase conversion support.

These run the embedded conversion scripts in a subprocess with this
environment's Python — the same way the sidecar's managed runtime executes
them — against a real ``.gdb`` written by GeoPandas/pyogrio. They skip when
the ``vector``/``conversion`` extras or the DuckDB spatial extension are
unavailable (the extension download needs network on first run).
"""

from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from geolibre_server.app.conversion import (
    _RESULT_MARKER,
    _VECTOR_LAYERS_SCRIPT,
    _VECTOR_TO_VECTOR_SCRIPT,
)

gpd = pytest.importorskip("geopandas", reason="vector extra not installed")
duckdb = pytest.importorskip("duckdb", reason="conversion extra not installed")

from shapely.geometry import LineString, Point  # noqa: E402


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
def sample_gdb(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A three-layer File Geodatabase: two WGS84 layers plus a projected one."""
    gdb = tmp_path_factory.mktemp("gdb") / "sample.gdb"
    cities = gpd.GeoDataFrame(
        {"name": ["Knoxville", "Nashville", "Memphis"]},
        geometry=[
            Point(-83.92, 35.96),
            Point(-86.78, 36.16),
            Point(-90.05, 35.15),
        ],
        crs="EPSG:4326",
    )
    routes = gpd.GeoDataFrame(
        {"route": ["I-40 segment"]},
        geometry=[LineString([(-90.05, 35.15), (-86.78, 36.16)])],
        crs="EPSG:4326",
    )
    try:
        cities.to_file(gdb, layer="cities", driver="OpenFileGDB")
    except Exception as exc:  # pragma: no cover - needs GDAL >= 3.6
        pytest.skip(f"OpenFileGDB write unavailable: {exc}")
    routes.to_file(gdb, layer="routes", driver="OpenFileGDB")
    cities.to_crs("EPSG:3857").to_file(gdb, layer="cities_mercator", driver="OpenFileGDB")
    return gdb


def _run_script(script: str, params: dict) -> dict:
    """Run an embedded conversion script exactly like the managed runtime does."""
    proc = subprocess.run(
        [sys.executable, "-c", script, json.dumps(params)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == 0, f"script failed:\n{proc.stdout}\n{proc.stderr}"
    for line in proc.stdout.splitlines():
        if line.startswith(_RESULT_MARKER):
            return json.loads(line[len(_RESULT_MARKER) :])
    raise AssertionError(f"no result marker in output:\n{proc.stdout}")


def test_layers_script_lists_gdb_directory(spatial_extension: None, sample_gdb: Path) -> None:
    """Layer listing on a .gdb directory reports user layers, never GDB_* ones."""
    result = _run_script(_VECTOR_LAYERS_SCRIPT, {"input_path": str(sample_gdb)})
    by_name = {layer["name"]: layer for layer in result["layers"]}
    assert set(by_name) == {"cities", "routes", "cities_mercator"}
    assert by_name["cities"]["feature_count"] == 3
    assert by_name["cities"]["geometry_type"] == "Point"
    assert by_name["cities"]["crs"] == "EPSG:4326"
    assert by_name["cities_mercator"]["crs"] == "EPSG:3857"


def test_layers_script_lists_zipped_gdb(
    spatial_extension: None, sample_gdb: Path, tmp_path: Path
) -> None:
    """Layer listing works on a zipped .gdb through /vsizip/."""
    archive = tmp_path / "sample_gdb.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for member in sample_gdb.iterdir():
            zf.write(member, f"{sample_gdb.name}/{member.name}")
    result = _run_script(_VECTOR_LAYERS_SCRIPT, {"input_path": str(archive)})
    names = {layer["name"] for layer in result["layers"]}
    assert names == {"cities", "routes", "cities_mercator"}


def test_vector_to_vector_converts_one_gdb_layer(
    spatial_extension: None, sample_gdb: Path, tmp_path: Path
) -> None:
    """A single layer of a .gdb converts to GeoJSON with its attributes."""
    output = tmp_path / "cities.geojson"
    result = _run_script(
        _VECTOR_TO_VECTOR_SCRIPT,
        {
            "input_path": str(sample_gdb),
            "output_path": str(output),
            "output_kind": "gdal",
            "output_driver": "GeoJSON",
            "zip_shapefile": False,
            "input_layer": "cities",
            "target_srs": "EPSG:4326",
        },
    )
    assert result["feature_count"] == 3
    collection = json.loads(output.read_text(encoding="utf-8"))
    names = {feature["properties"]["name"] for feature in collection["features"]}
    assert names == {"Knoxville", "Nashville", "Memphis"}


def test_vector_to_vector_reprojects_to_target_srs(
    spatial_extension: None, sample_gdb: Path, tmp_path: Path
) -> None:
    """A projected layer lands in WGS84 lon/lat when target_srs is EPSG:4326."""
    output = tmp_path / "mercator.geojson"
    _run_script(
        _VECTOR_TO_VECTOR_SCRIPT,
        {
            "input_path": str(sample_gdb),
            "output_path": str(output),
            "output_kind": "gdal",
            "output_driver": "GeoJSON",
            "zip_shapefile": False,
            "input_layer": "cities_mercator",
            "target_srs": "EPSG:4326",
        },
    )
    collection = json.loads(output.read_text(encoding="utf-8"))
    lon, lat = collection["features"][0]["geometry"]["coordinates"]
    # Stored coordinates are Web Mercator metres (~1e6); reprojected output
    # must be lon/lat degrees near Tennessee.
    assert -91 < lon < -83
    assert 35 < lat < 37
