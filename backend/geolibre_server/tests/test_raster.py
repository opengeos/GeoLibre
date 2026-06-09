import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

from geolibre_server.app.conversion import _RESULT_MARKER
from geolibre_server.app.raster import (
    _RASTER_TOOL_SCRIPTS,
    RasterToolRequest,
    raster_run,
)

EXPECTED_TOOL_IDS = {
    "hillshade",
    "slope",
    "aspect",
    "reproject",
    "resample",
    "clip-extent",
    "clip-mask",
    "polygonize",
    "contour",
}

try:
    import numpy  # noqa: F401
    import rasterio  # noqa: F401

    HAS_RASTERIO = True
except ImportError:  # pragma: no cover - depends on the optional extra
    HAS_RASTERIO = False

try:
    import contourpy  # noqa: F401

    HAS_CONTOURPY = True
except ImportError:  # pragma: no cover - depends on the optional extra
    HAS_CONTOURPY = False

requires_rasterio = pytest.mark.skipif(
    not HAS_RASTERIO, reason="rasterio optional extra not installed"
)
requires_contourpy = pytest.mark.skipif(
    not (HAS_RASTERIO and HAS_CONTOURPY),
    reason="contourpy optional extra not installed",
)


def test_dispatch_covers_all_tools() -> None:
    """Every advertised raster tool id must have an embedded script."""
    assert set(_RASTER_TOOL_SCRIPTS) == EXPECTED_TOOL_IDS


def test_embedded_scripts_compile() -> None:
    """Each inline raster script must be valid Python with a result marker."""
    for tool_id, script in _RASTER_TOOL_SCRIPTS.items():
        compile(script, f"<{tool_id}>", "exec")
        assert _RESULT_MARKER in script
        assert "{marker}" not in script


def test_raster_run_rejects_unknown_tool(tmp_path: Path) -> None:
    """An unknown tool id is rejected before any work starts."""
    request = RasterToolRequest(
        tool_id="does-not-exist",
        input_path=str(tmp_path / "in.tif"),
        output_path=str(tmp_path / "out.tif"),
    )
    with pytest.raises(HTTPException) as excinfo:
        raster_run(request)
    assert excinfo.value.status_code == 400


def test_raster_run_rejects_missing_input(tmp_path: Path) -> None:
    """A valid tool with a missing input file is rejected with a 400."""
    request = RasterToolRequest(
        tool_id="hillshade",
        input_path=str(tmp_path / "missing.tif"),
        output_path=str(tmp_path / "out.tif"),
    )
    with pytest.raises(HTTPException) as excinfo:
        raster_run(request)
    assert excinfo.value.status_code == 400


def _run_script(script: str, params: dict) -> str:
    """Execute an embedded tool script with the current interpreter.

    The production path runs scripts in the managed conversion runtime; here we
    drive them directly with ``sys.executable`` (where the optional raster
    extras are installed) so the script logic can be tested without bootstrapping
    a uv venv.
    """
    completed = subprocess.run(
        [sys.executable, "-c", script, json.dumps(params)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert _RESULT_MARKER in completed.stdout
    return completed.stdout


def _write_dem(path: Path) -> Path:
    """Write a small float DEM with a smooth ramp and a projected CRS."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    rows, cols = 16, 16
    yy, xx = np.mgrid[0:rows, 0:cols]
    elevation = (xx + yy).astype("float32")
    transform = from_origin(500000, 4100000, 30, 30)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=rows,
        width=cols,
        count=1,
        dtype="float32",
        crs="EPSG:32633",
        transform=transform,
    ) as dst:
        dst.write(elevation, 1)
    return path


def _write_classes(path: Path) -> Path:
    """Write a small integer raster with two contiguous classes."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    rows, cols = 16, 16
    data = np.zeros((rows, cols), dtype="int32")
    data[:, cols // 2 :] = 1
    transform = from_origin(500000, 4100000, 30, 30)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=rows,
        width=cols,
        count=1,
        dtype="int32",
        crs="EPSG:32633",
        transform=transform,
        nodata=255,
    ) as dst:
        dst.write(data, 1)
    return path


@requires_rasterio
def test_hillshade_writes_single_band_raster(tmp_path: Path) -> None:
    import rasterio

    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "hillshade.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["hillshade"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "azimuth": 315,
            "altitude": 45,
            "z_factor": 1,
        },
    )
    assert out.is_file()
    with rasterio.open(out) as ds:
        assert ds.count == 1
        assert ds.dtypes[0] == "uint8"


@requires_rasterio
def test_slope_writes_raster(tmp_path: Path) -> None:
    import rasterio

    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "slope.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["slope"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "units": "degrees",
            "z_factor": 1,
        },
    )
    with rasterio.open(out) as ds:
        assert ds.count == 1


@requires_rasterio
def test_polygonize_writes_geojson(tmp_path: Path) -> None:
    src = _write_classes(tmp_path / "classes.tif")
    out = tmp_path / "polygons.geojson"
    _run_script(
        _RASTER_TOOL_SCRIPTS["polygonize"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "band": 1,
            "connectivity": 4,
            "field": "value",
        },
    )
    fc = json.loads(out.read_text())
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) >= 1


@requires_contourpy
def test_contour_writes_geojson(tmp_path: Path) -> None:
    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "contours.geojson"
    _run_script(
        _RASTER_TOOL_SCRIPTS["contour"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "band": 1,
            "interval": 5,
            "base": 0,
            "attribute": "elev",
        },
    )
    fc = json.loads(out.read_text())
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) >= 1
    assert all(f["geometry"]["type"] == "LineString" for f in fc["features"])
