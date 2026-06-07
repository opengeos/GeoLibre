from pathlib import Path

import pytest
from fastapi import HTTPException

from geolibre_server.app.conversion import (
    _RASTER_SCRIPT,
    _RESULT_MARKER,
    _VECTOR_SCRIPT,
    _validate_paths,
    raster_to_cog,
    vector_to_geoparquet,
    RasterToCogRequest,
    VectorToGeoParquetRequest,
)


def test_embedded_scripts_compile() -> None:
    """The inline conversion scripts must be valid Python with a result marker."""
    compile(_VECTOR_SCRIPT, "<vector>", "exec")
    compile(_RASTER_SCRIPT, "<raster>", "exec")
    assert _RESULT_MARKER in _VECTOR_SCRIPT
    assert _RESULT_MARKER in _RASTER_SCRIPT
    assert "{marker}" not in _VECTOR_SCRIPT
    assert "{marker}" not in _RASTER_SCRIPT


def test_validate_paths_accepts_existing_input_and_folder(tmp_path: Path) -> None:
    """Existing input files and writable output folders pass validation."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    input_path, output_path = _validate_paths(
        str(source), str(tmp_path / "out.parquet")
    )
    assert input_path == str(source)
    assert output_path == str(tmp_path / "out.parquet")


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
