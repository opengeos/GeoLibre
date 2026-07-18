import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

from geolibre_server.app import conversion
from geolibre_server.app.conversion import (
    _PMTILES_SCRIPT,
    _RASTER_SCRIPT,
    _RESULT_MARKER,
    _VECTOR_LAYERS_SCRIPT,
    _VECTOR_SCRIPT,
    _VECTOR_TO_VECTOR_SCRIPT,
    CsvToGeoParquetRequest,
    RasterToCogRequest,
    VectorLayersRequest,
    VectorToGeoPackageRequest,
    VectorToGeoParquetRequest,
    VectorToPmtilesRequest,
    VectorToShapefileRequest,
    VectorToVectorRequest,
    _evict_finished_jobs_locked,
    _output_extension,
    _validate_input_path,
    _validate_paths,
    csv_to_geoparquet,
    raster_to_cog,
    vector_layers,
    vector_to_geopackage,
    vector_to_geoparquet,
    vector_to_pmtiles,
    vector_to_shapefile,
    vector_to_vector,
)
from geolibre_server.app.runtime import JobState


def test_embedded_scripts_compile() -> None:
    """The inline conversion scripts must be valid Python with a result marker."""
    for script in (
        _VECTOR_SCRIPT,
        _VECTOR_TO_VECTOR_SCRIPT,
        _VECTOR_LAYERS_SCRIPT,
        _RASTER_SCRIPT,
        _PMTILES_SCRIPT,
    ):
        compile(script, "<script>", "exec")
        assert _RESULT_MARKER in script
        assert "{marker}" not in script


def test_validate_paths_accepts_existing_input_and_folder(tmp_path: Path) -> None:
    """Existing input files and writable output folders pass validation."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    input_path, output_path = _validate_paths(str(source), str(tmp_path / "out.parquet"))
    assert input_path == str(source)
    assert output_path == str(tmp_path / "out.parquet")


def test_validate_input_path_accepts_gdb_directory(tmp_path: Path) -> None:
    """A File Geodatabase directory is a valid input despite not being a file."""
    gdb = tmp_path / "sample.gdb"
    gdb.mkdir()
    assert _validate_input_path(str(gdb)) == str(gdb.resolve())
    # And it flows through the full input/output validation unchanged.
    input_path, _ = _validate_paths(str(gdb), str(tmp_path / "out.geojson"))
    assert input_path == str(gdb.resolve())


def test_validate_input_path_rejects_plain_directory(tmp_path: Path) -> None:
    """Directories without a .gdb suffix stay rejected — only FileGDB is a
    directory-based input format."""
    plain = tmp_path / "not-a-geodatabase"
    plain.mkdir()
    with pytest.raises(HTTPException) as excinfo:
        _validate_input_path(str(plain))
    assert excinfo.value.status_code == 400


def test_validate_input_path_rejects_gdb_outside_allowed_roots(tmp_path: Path, monkeypatch) -> None:
    """The allowlist confinement applies to .gdb directory inputs too."""
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside.gdb"
    outside.mkdir()
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(allowed.resolve())])
    with pytest.raises(HTTPException) as excinfo:
        _validate_input_path(str(outside))
    assert excinfo.value.status_code == 403


def test_vector_layers_rejects_missing_input(tmp_path: Path) -> None:
    """A missing dataset is rejected before a layer-listing job starts."""
    with pytest.raises(HTTPException) as excinfo:
        vector_layers(VectorLayersRequest(input_path=str(tmp_path / "missing.gdb")))
    assert excinfo.value.status_code == 400


def test_vector_layers_starts_job_for_gdb_directory(tmp_path: Path, monkeypatch) -> None:
    """A .gdb directory input starts a layer-listing job with the resolved path."""
    gdb = tmp_path / "sample.gdb"
    gdb.mkdir()
    captured: dict[str, object] = {}

    def fake_start_job(tool_id, script, params, output_name) -> JobState:  # noqa: ANN001
        captured["tool_id"] = tool_id
        captured["script"] = script
        captured["params"] = params
        captured["output_name"] = output_name
        return _job("job", "pending", "2026-01-01T00:00:00+00:00")

    monkeypatch.setattr(conversion, "_start_job", fake_start_job)
    vector_layers(VectorLayersRequest(input_path=str(gdb)))

    assert captured["tool_id"] == "vector-layers"
    assert captured["script"] is _VECTOR_LAYERS_SCRIPT
    assert captured["params"] == {"input_path": str(gdb.resolve())}


def test_vector_to_vector_passes_layer_and_target_srs(tmp_path: Path, monkeypatch) -> None:
    """input_layer, target_srs, and source_srs flow through to the job params."""
    gdb = tmp_path / "sample.gdb"
    gdb.mkdir()
    captured: dict[str, object] = {}

    def fake_start_job(_tool_id, _script, params, _output_name) -> JobState:  # noqa: ANN001
        captured["params"] = params
        return _job("job", "pending", "2026-01-01T00:00:00+00:00")

    monkeypatch.setattr(conversion, "_start_job", fake_start_job)
    vector_to_vector(
        VectorToVectorRequest(
            input_path=str(gdb),
            output_path=str(tmp_path / "out.geojson"),
            input_layer="cities",
            target_srs="EPSG:4326",
            source_srs="ESRI:102039",
        )
    )
    params = captured["params"]
    assert params["input_layer"] == "cities"
    assert params["target_srs"] == "EPSG:4326"
    assert params["source_srs"] == "ESRI:102039"


def test_validate_paths_rejects_missing_input(tmp_path: Path) -> None:
    """A missing input file is reported as a 400 error."""
    with pytest.raises(HTTPException) as excinfo:
        _validate_paths(str(tmp_path / "missing.tif"), str(tmp_path / "out.tif"))
    assert excinfo.value.status_code == 400


def test_validate_paths_rejects_missing_output_folder(tmp_path: Path) -> None:
    """An output folder that does not exist is reported as a 400 error."""
    source = tmp_path / "input.tif"
    source.write_bytes(b"")
    with pytest.raises(HTTPException) as excinfo:
        _validate_paths(str(source), str(tmp_path / "nope" / "out.tif"))
    assert excinfo.value.status_code == 400


def test_validate_paths_rejects_outside_allowed_roots(tmp_path: Path, monkeypatch) -> None:
    """With an allowlist set, paths outside the roots are rejected (403)."""
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside.geojson"
    outside.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(allowed.resolve())])
    with pytest.raises(HTTPException) as excinfo:
        _validate_paths(str(outside), str(allowed / "out.parquet"))
    assert excinfo.value.status_code == 403


def test_validate_paths_rejects_output_outside_allowed_roots(tmp_path: Path, monkeypatch) -> None:
    """An allowlisted input but out-of-root output is rejected (403)."""
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    source = allowed / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(allowed.resolve())])
    with pytest.raises(HTTPException) as excinfo:
        _validate_paths(str(source), str(outside_dir / "out.parquet"))
    assert excinfo.value.status_code == 403


def test_validate_paths_allows_within_allowed_roots(tmp_path: Path, monkeypatch) -> None:
    """Paths under an allowlisted root pass validation."""
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    source = allowed / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(allowed.resolve())])
    input_path, output_path = _validate_paths(str(source), str(allowed / "out.parquet"))
    assert input_path == str(source.resolve())
    assert output_path == str((allowed / "out.parquet").resolve())


def test_runtime_python_caches_after_first_call(monkeypatch) -> None:
    """The import check runs at most once across repeated _runtime_python calls."""
    import_calls = 0

    def fake_check(python_executable: str) -> None:
        nonlocal import_calls
        import_calls += 1

    monkeypatch.setattr(conversion, "_CHECKED_RUNTIME_PYTHON", None)
    monkeypatch.setenv("GEOLIBRE_CONVERSION_PYTHON", sys.executable)
    monkeypatch.setattr(conversion, "_check_runtime_import", fake_check)

    assert conversion._runtime_python() == sys.executable
    conversion._runtime_python()
    assert import_calls == 1


def test_vector_to_geoparquet_rejects_unknown_compression(tmp_path: Path) -> None:
    """Unsupported Parquet compressions are rejected before starting a job."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    request = VectorToGeoParquetRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.parquet"),
        compression="brotli9000",
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_geoparquet(request)
    assert excinfo.value.status_code == 400


def test_vector_to_geoparquet_rejects_nonpositive_row_group_size(
    tmp_path: Path,
) -> None:
    """A non-positive row group size is rejected before starting a job."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    request = VectorToGeoParquetRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.parquet"),
        row_group_size=0,
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_geoparquet(request)
    assert excinfo.value.status_code == 400


def test_raster_to_cog_rejects_unknown_compression(tmp_path: Path) -> None:
    """Unsupported COG compressions are rejected before starting a job."""
    source = tmp_path / "input.tif"
    source.write_bytes(b"")
    request = RasterToCogRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.tif"),
        compression="zip",
    )
    with pytest.raises(HTTPException) as excinfo:
        raster_to_cog(request)
    assert excinfo.value.status_code == 400


def test_csv_to_geoparquet_requires_lon_lat(tmp_path: Path) -> None:
    """Missing lon/lat column names are rejected before starting a job."""
    source = tmp_path / "points.csv"
    source.write_text("name,x,y\n", encoding="utf-8")
    request = CsvToGeoParquetRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.parquet"),
        lon_column=" ",
        lat_column="y",
    )
    with pytest.raises(HTTPException) as excinfo:
        csv_to_geoparquet(request)
    assert excinfo.value.status_code == 400


def test_csv_to_geoparquet_rejects_unknown_compression(tmp_path: Path) -> None:
    """Unsupported Parquet compressions are rejected for CSV conversion too."""
    source = tmp_path / "points.csv"
    source.write_text("name,x,y\n", encoding="utf-8")
    request = CsvToGeoParquetRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.parquet"),
        lon_column="x",
        lat_column="y",
        compression="brotli",
    )
    with pytest.raises(HTTPException) as excinfo:
        csv_to_geoparquet(request)
    assert excinfo.value.status_code == 400


def test_vector_to_pmtiles_rejects_bad_zoom_range(tmp_path: Path) -> None:
    """min_zoom greater than max_zoom is rejected before starting a job."""
    source = tmp_path / "in.parquet"
    source.write_bytes(b"")
    request = VectorToPmtilesRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.pmtiles"),
        min_zoom=10,
        max_zoom=4,
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_pmtiles(request)
    assert excinfo.value.status_code == 400


def test_vector_to_shapefile_rejects_missing_input(tmp_path: Path) -> None:
    """A missing input file is rejected before a Shapefile job starts."""
    request = VectorToShapefileRequest(
        input_path=str(tmp_path / "missing.geojson"),
        output_path=str(tmp_path / "out.zip"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_shapefile(request)
    assert excinfo.value.status_code == 400


def test_vector_to_geopackage_rejects_missing_input(tmp_path: Path) -> None:
    """A missing input file is rejected before a GeoPackage job starts."""
    request = VectorToGeoPackageRequest(
        input_path=str(tmp_path / "missing.geojson"),
        output_path=str(tmp_path / "out.gpkg"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_geopackage(request)
    assert excinfo.value.status_code == 400


def test_output_extension_parsing() -> None:
    """The output extension is parsed case-insensitively, ignoring directories."""
    assert _output_extension("/a/b/cities.GPKG") == "gpkg"
    assert _output_extension("cities.tar.gz") == "gz"
    assert _output_extension("/no/extension/here") == ""


def test_vector_to_vector_rejects_unsupported_extension(tmp_path: Path) -> None:
    """An output extension with no known driver is rejected before a job starts."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    request = VectorToVectorRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.docx"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_vector(request)
    assert excinfo.value.status_code == 400
    assert "docx" in excinfo.value.detail


def test_vector_to_vector_requires_output_extension(tmp_path: Path) -> None:
    """An output path without an extension cannot select a format."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    request = VectorToVectorRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_vector(request)
    assert excinfo.value.status_code == 400


def test_vector_to_vector_rejects_missing_input(tmp_path: Path) -> None:
    """A missing input file is rejected before a conversion job starts."""
    request = VectorToVectorRequest(
        input_path=str(tmp_path / "missing.geojson"),
        output_path=str(tmp_path / "out.gpkg"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_vector(request)
    assert excinfo.value.status_code == 400


@pytest.mark.parametrize(
    ("output_name", "expected_kind", "expected_driver", "expected_zip"),
    [
        ("out.gpkg", "gdal", "GPKG", False),
        ("out.fgb", "gdal", "FlatGeobuf", False),
        ("out.geojson", "gdal", "GeoJSON", False),
        ("out.kml", "gdal", "KML", False),
        ("out.shp", "gdal", "ESRI Shapefile", False),
        ("out.zip", "gdal", "ESRI Shapefile", True),
        ("out.csv", "gdal", "CSV", False),
        ("out.parquet", "parquet", "", False),
        ("out.geoparquet", "parquet", "", False),
    ],
)
def test_vector_to_vector_routes_extension_to_driver(
    tmp_path: Path,
    monkeypatch,
    output_name: str,
    expected_kind: str,
    expected_driver: str,
    expected_zip: bool,
) -> None:
    """The output extension is mapped to the right writer params for the job."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_start_job(tool_id, script, params, output_name):  # noqa: ANN001
        captured["tool_id"] = tool_id
        captured["script"] = script
        captured["params"] = params
        return _job("job", "pending", "2026-01-01T00:00:00+00:00")

    monkeypatch.setattr(conversion, "_start_job", fake_start_job)
    request = VectorToVectorRequest(
        input_path=str(source),
        output_path=str(tmp_path / output_name),
    )
    vector_to_vector(request)

    assert captured["tool_id"] == "vector-to-vector"
    assert captured["script"] is _VECTOR_TO_VECTOR_SCRIPT
    params = captured["params"]
    assert params["output_kind"] == expected_kind
    assert params["output_driver"] == expected_driver
    assert params["zip_shapefile"] is expected_zip


def _job(job_id: str, status: str, created_at: str) -> JobState:
    """Build a JobState fixture with a controllable creation timestamp."""
    return JobState(
        id=job_id,
        status=status,
        tool_id="vector-to-geoparquet",
        created_at=created_at,
        updated_at=created_at,
    )


def test_evict_finished_jobs_drops_oldest_first(monkeypatch) -> None:
    """Eviction removes the oldest finished jobs, regardless of insert order."""
    monkeypatch.setattr(conversion, "MAX_RETAINED_JOBS", 2)
    # Insertion order deliberately does not match chronological order.
    jobs = {
        "c": _job("c", "succeeded", "2026-01-03T00:00:00+00:00"),
        "a": _job("a", "succeeded", "2026-01-01T00:00:00+00:00"),
        "b": _job("b", "failed", "2026-01-02T00:00:00+00:00"),
    }
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    _evict_finished_jobs_locked()
    # Only the single oldest finished job (created 01-01) should be evicted.
    assert set(jobs) == {"b", "c"}


def test_evict_finished_jobs_never_drops_running(monkeypatch) -> None:
    """Running and pending jobs are retained even when over the cap."""
    monkeypatch.setattr(conversion, "MAX_RETAINED_JOBS", 1)
    jobs = {
        "old_running": _job("old_running", "running", "2026-01-01T00:00:00+00:00"),
        "pending": _job("pending", "pending", "2026-01-02T00:00:00+00:00"),
        "done": _job("done", "succeeded", "2026-01-03T00:00:00+00:00"),
    }
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    _evict_finished_jobs_locked()
    # Excess is 2, but only the one finished job is eligible for eviction.
    assert set(jobs) == {"old_running", "pending"}
