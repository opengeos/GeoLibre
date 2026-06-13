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
    "interpolate",
    "zonal",
    "raster-calc",
    "reclassify",
    "mosaic",
    "focal",
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


def _write_points(path: Path) -> Path:
    """Write a GeoJSON point layer sampling a planar trend z = x + 2y."""
    import numpy as np

    rng = np.random.default_rng(0)
    features = []
    for _ in range(40):
        x = float(rng.uniform(0, 10))
        y = float(rng.uniform(0, 10))
        features.append(
            {
                "type": "Feature",
                "properties": {"z": x + 2 * y},
                "geometry": {"type": "Point", "coordinates": [x, y]},
            }
        )
    fc = {"type": "FeatureCollection", "features": features}
    path.write_text(json.dumps(fc))
    return path


@requires_rasterio
def test_interpolate_idw_writes_raster(tmp_path: Path) -> None:
    import rasterio

    src = _write_points(tmp_path / "points.geojson")
    out = tmp_path / "idw.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["interpolate"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "field": "z",
            "method": "idw",
            "resolution": 0.5,
            "power": 2,
        },
    )
    with rasterio.open(out) as ds:
        assert ds.count == 1
        assert ds.dtypes[0] == "float32"
        assert ds.crs == rasterio.crs.CRS.from_epsg(4326)
        data = ds.read(1, masked=True)
        # The surface must stay within the sampled value range [0, 30].
        assert float(data.min()) >= 0.0
        assert float(data.max()) <= 30.0


@requires_rasterio
def test_interpolate_kriging_recovers_trend(tmp_path: Path) -> None:
    import numpy as np
    import rasterio

    src = _write_points(tmp_path / "points.geojson")
    out = tmp_path / "kriging.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["interpolate"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "field": "z",
            "method": "kriging",
            "resolution": 0.5,
            "variogram_model": "spherical",
        },
    )
    with rasterio.open(out) as ds:
        assert ds.count == 1
        data = ds.read(1).astype("float64")
        # The centre of the grid should approximate z = x + 2y ~= 5 + 10 = 15.
        centre = data[data.shape[0] // 2, data.shape[1] // 2]
        assert abs(centre - 15.0) < 5.0


@requires_rasterio
def test_interpolate_skips_non_numeric_values(tmp_path: Path) -> None:
    """Features whose field value is non-numeric are skipped; if too few remain
    the run fails with the minimum-count error rather than crashing."""
    src = tmp_path / "points.geojson"
    src.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"z": "n/a"},
                        "geometry": {"type": "Point", "coordinates": [float(i), 0]},
                    }
                    for i in range(4)
                ],
            }
        )
    )
    out = tmp_path / "out.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["interpolate"],
            json.dumps(
                {
                    "input_path": str(src),
                    "output_path": str(out),
                    "field": "z",
                    "method": "idw",
                    "resolution": 1.0,
                }
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "at least 3 point" in (completed.stdout + completed.stderr)
    assert not out.exists()


@requires_rasterio
def test_interpolate_honors_geojson_crs(tmp_path: Path) -> None:
    """An explicit GeoJSON CRS member is parsed onto the output raster.

    Guards the doubly-escaped ``r"(\\\\d+)$"`` regex in the embedded script,
    which resolves to ``r"(\\d+)$"`` in the emitted script text.
    """
    import rasterio

    src = tmp_path / "points.geojson"
    src.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "crs": {
                    "type": "name",
                    "properties": {"name": "urn:ogc:def:crs:EPSG::32611"},
                },
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"z": float(i)},
                        "geometry": {
                            "type": "Point",
                            "coordinates": [500000 + 1000 * i, 4000000 + 1000 * i],
                        },
                    }
                    for i in range(6)
                ],
            }
        )
    )
    out = tmp_path / "out.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["interpolate"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "field": "z",
            "method": "idw",
            "resolution": 1000,
        },
    )
    with rasterio.open(out) as ds:
        assert ds.crs == rasterio.crs.CRS.from_epsg(32611)


@requires_rasterio
def test_interpolate_rejects_zero_power(tmp_path: Path) -> None:
    """An explicit ``power=0`` errors instead of being coerced to the default."""
    src = _write_points(tmp_path / "points.geojson")
    out = tmp_path / "out.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["interpolate"],
            json.dumps(
                {
                    "input_path": str(src),
                    "output_path": str(out),
                    "field": "z",
                    "method": "idw",
                    "resolution": 0.5,
                    "power": 0,
                }
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "power must be > 0" in (completed.stdout + completed.stderr)
    assert not out.exists()


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


def _square(minx: float, miny: float, maxx: float, maxy: float) -> dict:
    """Build a GeoJSON polygon ring for the given bounding box."""
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [minx, miny],
                [maxx, miny],
                [maxx, maxy],
                [minx, maxy],
                [minx, miny],
            ]
        ],
    }


@requires_rasterio
def test_zonal_statistics_summarizes_each_zone(tmp_path: Path) -> None:
    """Zonal stats over the two-class raster: one zone all 0s, one all 1s."""
    src = _write_classes(tmp_path / "classes.tif")
    # Two zones in the raster's CRS (EPSG:32633): the left half (value 0) and
    # the right half (value 1). The raster spans 480 m at 30 m / 16 px from the
    # 500000 / 4100000 top-left origin.
    zones = tmp_path / "zones.geojson"
    zones.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "crs": {
                    "type": "name",
                    "properties": {"name": "urn:ogc:def:crs:EPSG::32633"},
                },
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "left"},
                        "geometry": _square(500010, 4099610, 500230, 4099990),
                    },
                    {
                        "type": "Feature",
                        "properties": {"name": "right"},
                        "geometry": _square(500250, 4099610, 500470, 4099990),
                    },
                ],
            }
        )
    )
    out = tmp_path / "zonal.geojson"
    _run_script(
        _RASTER_TOOL_SCRIPTS["zonal"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "zones_path": str(zones),
            "band": 1,
        },
    )
    fc = json.loads(out.read_text())
    by_name = {f["properties"]["name"]: f["properties"] for f in fc["features"]}
    assert by_name["left"]["count"] > 0
    assert by_name["left"]["mean"] == 0.0
    assert by_name["right"]["mean"] == 1.0
    assert by_name["right"]["max"] == 1.0


@requires_rasterio
def test_zonal_statistics_reprojects_wgs84_zones(tmp_path: Path) -> None:
    """A WGS84 zone layer (no crs member) over a projected raster is reprojected.

    Exercises the ``zone_crs != src.crs`` -> ``transform_geom`` branch, the most
    common real-world case, which same-CRS fixtures never hit.
    """
    # Use rasterio's own warp.transform (no extra pyproj dependency) to convert
    # the left/right halves from the raster CRS to WGS84, so the zone file carries
    # lon/lat coordinates with no explicit crs member.
    from rasterio.warp import transform as warp_transform

    src = _write_classes(tmp_path / "classes.tif")  # EPSG:32633

    def wgs_square(minx, miny, maxx, maxy):
        xs = [minx, maxx, maxx, minx, minx]
        ys = [miny, miny, maxy, maxy, miny]
        lons, lats = warp_transform("EPSG:32633", "EPSG:4326", xs, ys)
        return {
            "type": "Polygon",
            "coordinates": [[[lon, lat] for lon, lat in zip(lons, lats)]],
        }

    zones = tmp_path / "zones_wgs84.geojson"
    zones.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "left"},
                        "geometry": wgs_square(500010, 4099610, 500230, 4099990),
                    },
                    {
                        "type": "Feature",
                        "properties": {"name": "right"},
                        "geometry": wgs_square(500250, 4099610, 500470, 4099990),
                    },
                ],
            }
        )
    )
    out = tmp_path / "zonal.geojson"
    _run_script(
        _RASTER_TOOL_SCRIPTS["zonal"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "zones_path": str(zones),
            "band": 1,
        },
    )
    by_name = {
        f["properties"]["name"]: f["properties"]
        for f in json.loads(out.read_text())["features"]
    }
    assert by_name["left"]["count"] > 0
    assert by_name["left"]["mean"] == 0.0
    assert by_name["right"]["mean"] == 1.0


@requires_rasterio
def test_raster_calculator_rejects_crs_mismatch(tmp_path: Path) -> None:
    """B with A's dimensions but a different CRS is rejected, not silently mixed."""
    import rasterio
    from rasterio.transform import from_origin

    a = _write_dem(tmp_path / "a.tif")  # EPSG:32633
    with rasterio.open(a) as ds:
        arr = ds.read(1)
    b = tmp_path / "b.tif"
    with rasterio.open(
        b,
        "w",
        driver="GTiff",
        height=arr.shape[0],
        width=arr.shape[1],
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(0, 10, 0.1, 0.1),
    ) as dst:
        dst.write(arr, 1)
    out = tmp_path / "calc.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["raster-calc"],
            json.dumps(
                {
                    "input_path": str(a),
                    "output_path": str(out),
                    "expression": "A + B",
                    "b_path": str(b),
                }
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "does not match raster A" in (completed.stdout + completed.stderr)
    assert not out.exists()


@requires_rasterio
def test_raster_calculator_blocks_numpy_io(tmp_path: Path) -> None:
    """The bare ``np`` module is not exposed, so np.* I/O cannot be reached."""
    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "calc.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["raster-calc"],
            json.dumps(
                {
                    "input_path": str(src),
                    "output_path": str(out),
                    "expression": "np.where(A > 0, 1, 0)",
                }
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "Failed to evaluate expression" in (completed.stdout + completed.stderr)
    assert not out.exists()


@requires_rasterio
def test_raster_calculator_reports_missing_referenced_raster(tmp_path: Path) -> None:
    """Referencing B without supplying a B path gives a clear message, not NameError."""
    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "calc.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["raster-calc"],
            json.dumps(
                {
                    "input_path": str(src),
                    "output_path": str(out),
                    "expression": "A + B",
                }
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "no Raster B path was provided" in (completed.stdout + completed.stderr)
    assert not out.exists()


@requires_rasterio
def test_raster_calculator_allows_funcs_named_like_bands(tmp_path: Path) -> None:
    """A function whose name contains 'b' (abs) must not trip the missing-B guard."""
    import rasterio

    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "calc.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["raster-calc"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "expression": "abs(A - 10)",
        },
    )
    with rasterio.open(out) as ds:
        assert ds.count == 1


@requires_rasterio
def test_raster_calculator_evaluates_expression(tmp_path: Path) -> None:
    import rasterio

    src = _write_dem(tmp_path / "dem.tif")  # band 1 = x + y
    out = tmp_path / "calc.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["raster-calc"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "expression": "A * 2 + 1",
        },
    )
    with rasterio.open(src) as ds:
        a = ds.read(1).astype("float64")
    with rasterio.open(out) as ds:
        assert ds.count == 1
        assert ds.dtypes[0] == "float32"
        result = ds.read(1).astype("float64")
    assert result == pytest.approx(a * 2 + 1, rel=1e-5)


@requires_rasterio
def test_raster_calculator_rejects_bad_expression(tmp_path: Path) -> None:
    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "calc.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["raster-calc"],
            json.dumps(
                {
                    "input_path": str(src),
                    "output_path": str(out),
                    "expression": "A +",
                }
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "Failed to evaluate expression" in (completed.stdout + completed.stderr)
    assert not out.exists()


@requires_rasterio
def test_raster_calculator_rejects_dunder_expression(tmp_path: Path) -> None:
    """A dunder-bearing expression is rejected before evaluation (sandbox guard)."""
    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "calc.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["raster-calc"],
            json.dumps(
                {
                    "input_path": str(src),
                    "output_path": str(out),
                    "expression": "A.__class__",
                }
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "__" in (completed.stdout + completed.stderr)
    assert not out.exists()


@requires_rasterio
def test_reclassify_remaps_ranges(tmp_path: Path) -> None:
    import numpy as np
    import rasterio

    src = _write_dem(tmp_path / "dem.tif")  # values 0..30
    out = tmp_path / "reclass.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["reclassify"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "band": 1,
            "table": "0:15:10, 15:max:20",
            "unmatched": "nodata",
        },
    )
    with rasterio.open(out) as ds:
        data = ds.read(1, masked=True)
    uniq = set(np.unique(data.compressed()).tolist())
    assert uniq == {10.0, 20.0}


@requires_rasterio
def test_mosaic_merges_two_rasters(tmp_path: Path) -> None:
    import rasterio

    a = _write_dem(tmp_path / "a.tif")
    # A second tile shifted east by its full width so the mosaic is wider.
    from rasterio.transform import from_origin

    b = tmp_path / "b.tif"
    with rasterio.open(a) as ds:
        arr = ds.read(1)
        width = ds.width
    transform = from_origin(500000 + width * 30, 4100000, 30, 30)
    with rasterio.open(
        b,
        "w",
        driver="GTiff",
        height=arr.shape[0],
        width=arr.shape[1],
        count=1,
        dtype="float32",
        crs="EPSG:32633",
        transform=transform,
    ) as dst:
        dst.write(arr, 1)
    out = tmp_path / "mosaic.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["mosaic"],
        {
            "input_path": str(a),
            "output_path": str(out),
            "raster_2": str(b),
            "method": "first",
        },
    )
    with rasterio.open(a) as ds:
        single_width = ds.width
    with rasterio.open(out) as ds:
        assert ds.width >= single_width * 2 - 1


@requires_rasterio
def test_mosaic_rejects_mismatched_crs(tmp_path: Path) -> None:
    import rasterio
    from rasterio.transform import from_origin

    a = _write_dem(tmp_path / "a.tif")
    b = tmp_path / "b.tif"
    with rasterio.open(a) as ds:
        arr = ds.read(1)
    with rasterio.open(
        b,
        "w",
        driver="GTiff",
        height=arr.shape[0],
        width=arr.shape[1],
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(0, 10, 0.1, 0.1),
    ) as dst:
        dst.write(arr, 1)
    out = tmp_path / "mosaic.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["mosaic"],
            json.dumps(
                {
                    "input_path": str(a),
                    "output_path": str(out),
                    "raster_2": str(b),
                }
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "same CRS" in (completed.stdout + completed.stderr)


@requires_rasterio
def test_mosaic_rejects_mismatched_band_count(tmp_path: Path) -> None:
    """A 1-band raster mixed with a 3-band raster fails with a clear message."""
    import rasterio
    from rasterio.transform import from_origin

    a = _write_dem(tmp_path / "a.tif")  # 1 band, EPSG:32633
    with rasterio.open(a) as ds:
        arr = ds.read(1)
        transform = ds.transform
    b = tmp_path / "b.tif"
    with rasterio.open(
        b,
        "w",
        driver="GTiff",
        height=arr.shape[0],
        width=arr.shape[1],
        count=3,
        dtype="float32",
        crs="EPSG:32633",
        transform=from_origin(transform.c, transform.f, 30, 30),
    ) as dst:
        for band in range(1, 4):
            dst.write(arr, band)
    out = tmp_path / "mosaic.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["mosaic"],
            json.dumps(
                {"input_path": str(a), "output_path": str(out), "raster_2": str(b)}
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "same band count" in (completed.stdout + completed.stderr)


@requires_rasterio
def test_focal_mean_preserves_shape(tmp_path: Path) -> None:
    import numpy as np
    import rasterio

    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "focal.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["focal"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "band": 1,
            "statistic": "mean",
            "size": 3,
        },
    )
    with rasterio.open(src) as ds:
        in_shape = (ds.height, ds.width)
        original = ds.read(1).astype("float64")
    with rasterio.open(out) as ds:
        assert (ds.height, ds.width) == in_shape
        smoothed = ds.read(1).astype("float64")
    # A smoothing mean over a planar ramp leaves interior values ~unchanged but
    # never exceeds the input's global range.
    assert smoothed.min() >= original.min() - 1e-3
    assert smoothed.max() <= original.max() + 1e-3
    assert np.isfinite(smoothed).all()


@requires_rasterio
def test_focal_rejects_even_window(tmp_path: Path) -> None:
    src = _write_dem(tmp_path / "dem.tif")
    out = tmp_path / "focal.tif"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            _RASTER_TOOL_SCRIPTS["focal"],
            json.dumps(
                {
                    "input_path": str(src),
                    "output_path": str(out),
                    "statistic": "mean",
                    "size": 4,
                }
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert "odd integer" in (completed.stdout + completed.stderr)
    assert not out.exists()


@requires_rasterio
def test_focal_median_matches_numpy(tmp_path: Path) -> None:
    """The median (stack) path agrees with a direct NumPy windowed median."""
    import numpy as np
    import rasterio

    src = _write_dem(tmp_path / "dem.tif")  # 16x16 ramp z = x + y
    out = tmp_path / "focal.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["focal"],
        {
            "input_path": str(src),
            "output_path": str(out),
            "statistic": "median",
            "size": 3,
        },
    )
    with rasterio.open(src) as ds:
        data = ds.read(1).astype("float64")
    with rasterio.open(out) as ds:
        got = ds.read(1).astype("float64")
    # Reference 3x3 median over an interior cell (no edge truncation there).
    i = j = 8
    expected = float(np.median(data[i - 1 : i + 2, j - 1 : j + 2]))
    assert got[i, j] == pytest.approx(expected, rel=1e-5)


@requires_rasterio
def test_focal_std_zero_on_flat_input(tmp_path: Path) -> None:
    """The streaming std accumulator is ~0 where every neighbour is equal."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    flat = tmp_path / "flat.tif"
    with rasterio.open(
        flat,
        "w",
        driver="GTiff",
        height=12,
        width=12,
        count=1,
        dtype="float32",
        crs="EPSG:32633",
        transform=from_origin(500000, 4100000, 30, 30),
    ) as dst:
        dst.write(np.full((12, 12), 7.0, dtype="float32"), 1)
    out = tmp_path / "focal.tif"
    _run_script(
        _RASTER_TOOL_SCRIPTS["focal"],
        {
            "input_path": str(flat),
            "output_path": str(out),
            "statistic": "std",
            "size": 3,
        },
    )
    with rasterio.open(out) as ds:
        got = ds.read(1)
    assert np.allclose(got, 0.0, atol=1e-4)
