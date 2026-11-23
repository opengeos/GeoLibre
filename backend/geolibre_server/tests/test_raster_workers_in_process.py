"""In-process tests for the raster tool workers.

The sidecar runs each worker in a subprocess, which coverage does not see. These
tests call each worker's ``main()`` directly with ``sys.argv`` patched, so both the
happy paths and the validation errors are measured.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

from geolibre_server.workers import RESULT_MARKER

np = pytest.importorskip("numpy")
rasterio = pytest.importorskip("rasterio")

from rasterio.transform import from_origin  # noqa: E402

CUSTOM_TMERC = "+proj=tmerc +lat_0=0 +lon_0=0 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"


def _run_worker(monkeypatch: pytest.MonkeyPatch, module_name: str, params: dict) -> None:
    """Run a worker's ``main()`` in this process with JSON params on ``sys.argv``.

    Args:
        monkeypatch: The pytest monkeypatch fixture used to patch ``sys.argv``.
        module_name: The dotted worker name under ``geolibre_server.workers``.
        params: The parameters the worker reads from ``sys.argv[1]``.
    """
    mod = importlib.import_module(f"geolibre_server.workers.{module_name}")
    monkeypatch.setattr(sys, "argv", [module_name, json.dumps(params)])
    mod.main()


def _result(capsys: pytest.CaptureFixture[str]) -> dict:
    """Parse the JSON payload a worker printed after the result marker.

    Args:
        capsys: The pytest capture fixture holding the worker's stdout.

    Returns:
        The decoded result object.
    """
    out = capsys.readouterr().out
    line = next(x for x in out.splitlines() if x.startswith(RESULT_MARKER))
    return json.loads(line[len(RESULT_MARKER) :])


def _write_raster(
    path: Path,
    data,
    crs: str | None = "EPSG:3857",
    nodata: float | None = -9999.0,
    origin: tuple[float, float] = (0.0, 100.0),
    res: float = 10.0,
    dtype: str = "float32",
) -> Path:
    """Write a small GeoTIFF for a worker to read.

    Args:
        path: Destination file path.
        data: A 2D (single band) or 3D (bands, rows, cols) array.
        crs: The raster CRS, or None for an ungeoreferenced raster.
        nodata: The nodata value, or None for none.
        origin: The (x, y) of the top-left corner.
        res: The square pixel size.
        dtype: The output data type.

    Returns:
        The path that was written.
    """
    arr = np.asarray(data)
    if arr.ndim == 2:
        arr = arr[None, :, :]
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=arr.shape[1],
        width=arr.shape[2],
        count=arr.shape[0],
        dtype=dtype,
        crs=crs,
        transform=from_origin(origin[0], origin[1], res, res),
        nodata=nodata,
    ) as dst:
        dst.write(arr.astype(dtype))
    return path


def _write_geojson(path: Path, obj: dict) -> Path:
    """Write a GeoJSON object to ``path`` and return the path.

    Args:
        path: Destination file path.
        obj: The GeoJSON object.

    Returns:
        The path that was written.
    """
    path.write_text(json.dumps(obj))
    return path


def _box(x0: float, y0: float, x1: float, y1: float) -> dict:
    """Build a GeoJSON Polygon for an axis-aligned box.

    Args:
        x0: Minimum x.
        y0: Minimum y.
        x1: Maximum x.
        y1: Maximum y.

    Returns:
        The Polygon geometry.
    """
    return {
        "type": "Polygon",
        "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
    }


def _crs_member(name: str) -> dict:
    """Build a legacy GeoJSON ``crs`` member naming ``name``."""
    return {"type": "name", "properties": {"name": name}}


def _point(x: float, y: float, **props) -> dict:
    """Build a GeoJSON Point feature with the given properties."""
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": "Point", "coordinates": [x, y]},
    }


@pytest.fixture
def ramp(tmp_path: Path) -> Path:
    """A 6 x 6 EPSG:3857 raster holding 1..36 row by row."""
    return _write_raster(tmp_path / "ramp.tif", np.arange(1, 37, dtype="float32").reshape(6, 6))


# --- interpolate -------------------------------------------------------------


def test_interpolate_idw_honours_samples_and_skips_bad_features(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    points = _write_geojson(
        tmp_path / "pts.geojson",
        {
            "type": "FeatureCollection",
            "crs": _crs_member("urn:ogc:def:crs:EPSG::3857"),
            "features": [
                _point(5, 95, v=7),  # the centre of the top-left output cell
                _point(0, 0, v=0),
                _point(100, 0, v=10),
                _point(100, 100, v="30"),  # numeric strings are accepted
                _point(50, 50, v="abc"),  # not numeric: skipped
                _point(60, 60),  # no value: skipped
                {"type": "Feature", "properties": {"v": 1}, "geometry": _box(0, 0, 1, 1)},
                {
                    "type": "Feature",
                    "properties": {"v": 1},
                    "geometry": {"type": "Point", "coordinates": [1]},
                },
                None,
            ],
        },
    )
    out = tmp_path / "idw.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.interpolate",
        {
            "input_path": str(points),
            "output_path": str(out),
            "field": "v",
            "method": "idw",
            "resolution": 10,
            "power": 2,
        },
    )
    captured = capsys.readouterr().out
    assert "Skipped 5 feature(s)" in captured
    assert json.loads(captured.split(RESULT_MARKER, 1)[1]) == {"output_path": str(out)}
    with rasterio.open(out) as ds:
        assert ds.crs.to_epsg() == 3857
        assert (ds.width, ds.height) == (10, 10)
        arr = ds.read(1)
    assert arr[0, 0] == pytest.approx(7.0)
    assert float(arr.min()) >= 0.0 and float(arr.max()) <= 30.0


@pytest.mark.parametrize("model", ["spherical", "exponential", "gaussian", "linear"])
def test_interpolate_kriging_is_exact_at_samples(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    model: str,
) -> None:
    # A 4 x 4 lattice of samples, each on an output cell centre, with z = x + y.
    feats = [_point(x, y, z=x + y) for x in (5, 15, 25, 35) for y in (5, 15, 25, 35)]
    points = _write_geojson(
        tmp_path / "pts.geojson", {"type": "FeatureCollection", "features": feats}
    )
    out = tmp_path / f"krige_{model}.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.interpolate",
        {
            "input_path": str(points),
            "output_path": str(out),
            "field": "z",
            "method": "kriging",
            "resolution": 10,
            "variogram_model": model,
            # power is irrelevant for kriging and must not be validated.
            "power": 0,
        },
    )
    assert f"Variogram ({model})" in capsys.readouterr().out
    with rasterio.open(out) as ds:
        assert ds.crs.to_epsg() == 4326
        arr = ds.read(1)
        transform = ds.transform
    # Ordinary kriging honours the samples, so the cell holding (15, 25) is exact.
    row, col = rasterio.transform.rowcol(transform, 15, 25)
    assert arr[row, col] == pytest.approx(40.0, abs=1e-3)
    assert np.isfinite(arr).all()


def test_interpolate_degenerate_extent_and_crs_fallbacks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # All points share x, so the grid still gets a one-cell-wide span.
    feats = [_point(10, y, v=float(y)) for y in (0, 10, 20)]
    for name, warning in (
        ("not a crs", "could not parse CRS"),
        ("urn:ogc:def:crs:EPSG::999999", "could not use EPSG:999999"),
    ):
        points = _write_geojson(
            tmp_path / "pts.geojson",
            {"type": "FeatureCollection", "crs": _crs_member(name), "features": feats},
        )
        out = tmp_path / "degenerate.tif"
        _run_worker(
            monkeypatch,
            "raster_tools.interpolate",
            {"input_path": str(points), "output_path": str(out), "field": "v", "resolution": 10},
        )
        assert warning in capsys.readouterr().err
        with rasterio.open(out) as ds:
            assert ds.width == 1
            assert ds.height == 2
            assert ds.crs.to_epsg() == 4326


def test_interpolate_accepts_a_single_feature_but_needs_three_points(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    points = _write_geojson(tmp_path / "one.geojson", _point(0, 0, v=1))
    with pytest.raises(SystemExit, match="at least 3 point features"):
        _run_worker(
            monkeypatch,
            "raster_tools.interpolate",
            {
                "input_path": str(points),
                "output_path": str(tmp_path / "o.tif"),
                "field": "v",
                "resolution": 1,
            },
        )


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"field": ""}, "Value field is required"),
        ({"resolution": 0}, "resolution"),
        ({"power": 0}, "IDW power must be > 0"),
        ({"method": "spline"}, "Unknown interpolation method"),
        ({"resolution": 0.001}, "Increase the pixel size"),
        ({"resolution": 0.01, "method": "kriging"}, "above the 1000000 limit for kriging"),
    ],
)
def test_interpolate_rejects_bad_parameters(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, overrides: dict, message: str
) -> None:
    feats = [_point(0, 0, v=1), _point(100, 0, v=2), _point(0, 100, v=3)]
    points = _write_geojson(
        tmp_path / "pts.geojson", {"type": "FeatureCollection", "features": feats}
    )
    params = {
        "input_path": str(points),
        "output_path": str(tmp_path / "o.tif"),
        "field": "v",
        "resolution": 10,
        **overrides,
    }
    with pytest.raises(SystemExit, match=message):
        _run_worker(monkeypatch, "raster_tools.interpolate", params)


def test_interpolate_rejects_bad_inputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bare = _write_geojson(tmp_path / "bare.geojson", {"type": "Point", "coordinates": [0, 0]})
    with pytest.raises(SystemExit, match="Feature or FeatureCollection"):
        _run_worker(
            monkeypatch,
            "raster_tools.interpolate",
            {
                "input_path": str(bare),
                "output_path": str(tmp_path / "o.tif"),
                "field": "v",
                "resolution": 1,
            },
        )

    same = _write_geojson(
        tmp_path / "same.geojson",
        {"type": "FeatureCollection", "features": [_point(1, 1, v=i) for i in range(3)]},
    )
    with pytest.raises(SystemExit, match="coincident"):
        _run_worker(
            monkeypatch,
            "raster_tools.interpolate",
            {
                "input_path": str(same),
                "output_path": str(tmp_path / "o.tif"),
                "field": "v",
                "resolution": 1,
                "method": "kriging",
            },
        )


# --- zonal statistics ---------------------------------------------------------


def test_zonal_statistics_reports_stats_and_empty_zones(
    tmp_path: Path, ramp: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    zones = _write_geojson(
        tmp_path / "zones.geojson",
        {
            "type": "FeatureCollection",
            "crs": _crs_member("EPSG:3857"),
            "features": [
                # The top-left 2 x 2 block: 1, 2, 7, 8.
                {"type": "Feature", "properties": {"name": "a"}, "geometry": _box(0, 80, 20, 100)},
                {
                    "type": "Feature",
                    "properties": {"name": "far"},
                    "geometry": _box(1000, 1000, 1100, 1100),
                },
                {"type": "Feature", "properties": {"name": "none"}, "geometry": None},
            ],
        },
    )
    out = tmp_path / "zonal.geojson"
    _run_worker(
        monkeypatch,
        "raster_tools.zonal_stats",
        {
            "input_path": str(ramp),
            "output_path": str(out),
            "zones_path": str(zones),
            "prefix": "z_",
        },
    )
    assert "(1 with data)" in capsys.readouterr().out
    fc = json.loads(out.read_text())
    assert fc["crs"]["properties"]["name"] == "urn:ogc:def:crs:EPSG::3857"
    a, far, none = (f["properties"] for f in fc["features"])
    assert a["name"] == "a"
    assert a["z_count"] == 4
    assert (a["z_min"], a["z_max"], a["z_sum"]) == (1.0, 8.0, 18.0)
    assert a["z_mean"] == pytest.approx(4.5)
    assert a["z_median"] == pytest.approx(4.5)
    assert a["z_std"] == pytest.approx(np.std([1, 2, 7, 8]))
    for empty in (far, none):
        assert empty["z_count"] == 0
        assert empty["z_mean"] is None


def test_zonal_statistics_reprojects_wgs84_geometry(
    tmp_path: Path, ramp: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A bare geometry (no Feature wrapper) in the WGS84 default, covering the
    # whole 60 m x 100 m raster near the origin.
    zones = _write_geojson(tmp_path / "zones.geojson", _box(-0.001, -0.001, 0.001, 0.002))
    out = tmp_path / "zonal.geojson"
    _run_worker(
        monkeypatch,
        "raster_tools.zonal_stats",
        {"input_path": str(ramp), "output_path": str(out), "zones_path": str(zones)},
    )
    fc = json.loads(out.read_text())
    assert "crs" not in fc
    props = fc["features"][0]["properties"]
    assert props["count"] == 36
    assert props["sum"] == pytest.approx(666.0)


@pytest.mark.parametrize(
    ("crs_name", "warning"),
    [
        ("Custom zone 999999", "could not parse zones CRS 'Custom zone 999999' ("),
        ("garbage name", "could not parse zones CRS 'garbage name'"),
    ],
)
def test_zonal_statistics_warns_on_unparseable_crs(
    tmp_path: Path,
    ramp: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    crs_name: str,
    warning: str,
) -> None:
    zones = _write_geojson(
        tmp_path / "zones.geojson",
        {
            "type": "Feature",
            "crs": _crs_member(crs_name),
            "properties": {},
            "geometry": _box(-0.001, -0.001, 0.001, 0.002),
        },
    )
    out = tmp_path / "zonal.geojson"
    _run_worker(
        monkeypatch,
        "raster_tools.zonal_stats",
        {"input_path": str(ramp), "output_path": str(out), "zones_path": str(zones)},
    )
    assert warning in capsys.readouterr().err
    # The fallback is WGS84, so the zone still lands on the raster.
    assert json.loads(out.read_text())["features"][0]["properties"]["count"] == 36


def test_zonal_statistics_embeds_wkt_for_a_crs_without_epsg(
    tmp_path: Path, ramp: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    zones = _write_geojson(
        tmp_path / "zones.geojson",
        {
            "type": "FeatureCollection",
            "crs": _crs_member(CUSTOM_TMERC),
            "features": [{"type": "Feature", "properties": {}, "geometry": _box(0, 0, 60, 100)}],
        },
    )
    out = tmp_path / "zonal.geojson"
    _run_worker(
        monkeypatch,
        "raster_tools.zonal_stats",
        {"input_path": str(ramp), "output_path": str(out), "zones_path": str(zones)},
    )
    fc = json.loads(out.read_text())
    assert "TRANSVERSE" in fc["crs"]["properties"]["name"].upper()
    assert fc["features"][0]["properties"]["count"] > 0


def test_zonal_statistics_rejects_bad_inputs(
    tmp_path: Path, ramp: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty = _write_geojson(
        tmp_path / "empty.geojson", {"type": "FeatureCollection", "features": []}
    )
    zones = _write_geojson(tmp_path / "zones.geojson", _box(0, 0, 1, 1))
    no_crs = _write_raster(tmp_path / "nocrs.tif", np.ones((3, 3)), crs=None)
    cases = [
        ({"input_path": str(ramp), "zones_path": str(empty)}, "no features"),
        ({"input_path": str(ramp), "zones_path": str(zones), "band": 2}, "Band 2 out of range"),
        ({"input_path": str(no_crs), "zones_path": str(zones)}, "has no CRS"),
    ]
    for params, message in cases:
        with pytest.raises(SystemExit, match=message):
            _run_worker(
                monkeypatch,
                "raster_tools.zonal_stats",
                {**params, "output_path": str(tmp_path / "z.geojson")},
            )


# --- clip by mask ---------------------------------------------------------------


def test_clip_mask_crops_to_a_projected_mask(
    tmp_path: Path, ramp: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    mask = _write_geojson(
        tmp_path / "mask.geojson",
        {
            "type": "FeatureCollection",
            "crs": _crs_member("urn:ogc:def:crs:EPSG::3857"),
            "features": [
                {"type": "Feature", "properties": {}, "geometry": _box(0, 70, 30, 100)},
                {"type": "Feature", "properties": {}, "geometry": None},
            ],
        },
    )
    out = tmp_path / "clip.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.clip_mask",
        {"input_path": str(ramp), "output_path": str(out), "mask_path": str(mask)},
    )
    assert _result(capsys) == {"output_path": str(out)}
    with rasterio.open(out) as ds:
        assert (ds.width, ds.height) == (3, 3)
        assert ds.nodata == -9999.0
        np.testing.assert_array_equal(ds.read(1), [[1, 2, 3], [7, 8, 9], [13, 14, 15]])


def test_clip_mask_without_nodata_writes_a_validity_mask(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = _write_raster(tmp_path / "src.tif", np.full((6, 6), 5.0), nodata=None)
    # A WGS84 Feature (the GeoJSON default) over the left half of the raster.
    mask = _write_geojson(
        tmp_path / "mask.geojson",
        {"type": "Feature", "properties": {}, "geometry": _box(-0.001, -0.001, 0.00027, 0.002)},
    )
    out = tmp_path / "clip.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.clip_mask",
        {
            "input_path": str(src),
            "output_path": str(out),
            "mask_path": str(mask),
            "crop": False,
            "all_touched": True,
        },
    )
    with rasterio.open(out) as ds:
        assert (ds.width, ds.height) == (6, 6)
        valid = ds.dataset_mask()
    assert valid[0, 0] == 255
    assert valid[0, 5] == 0


@pytest.mark.parametrize(
    ("crs_name", "warning"),
    [
        ("bogus", "could not parse mask CRS 'bogus';"),
        ("EPSG:999999", "could not parse mask CRS 'EPSG:999999' ("),
    ],
)
def test_clip_mask_warns_on_unparseable_crs(
    tmp_path: Path,
    ramp: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    crs_name: str,
    warning: str,
) -> None:
    mask = _write_geojson(
        tmp_path / "mask.geojson",
        {**_box(-0.001, -0.001, 0.001, 0.002), "crs": _crs_member(crs_name)},
    )
    out = tmp_path / "clip.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.clip_mask",
        {"input_path": str(ramp), "output_path": str(out), "mask_path": str(mask)},
    )
    assert warning in capsys.readouterr().err
    assert out.is_file()


def test_clip_mask_rejects_bad_inputs(
    tmp_path: Path, ramp: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty = _write_geojson(
        tmp_path / "empty.geojson", {"type": "Feature", "properties": {}, "geometry": None}
    )
    mask = _write_geojson(tmp_path / "mask.geojson", _box(0, 0, 1, 1))
    no_crs = _write_raster(tmp_path / "nocrs.tif", np.ones((3, 3)), crs=None)
    for raster, mask_path, message in (
        (ramp, empty, "no geometries"),
        (no_crs, mask, "has no CRS"),
    ):
        with pytest.raises(SystemExit, match=message):
            _run_worker(
                monkeypatch,
                "raster_tools.clip_mask",
                {
                    "input_path": str(raster),
                    "output_path": str(tmp_path / "c.tif"),
                    "mask_path": str(mask_path),
                },
            )


# --- mosaic ---------------------------------------------------------------------


def test_mosaic_unions_footprints_and_warns_on_mixed_nodata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    a = _write_raster(tmp_path / "a.tif", np.full((6, 6), 1.0))
    # Shifted 30 m east (3 pixels) with larger values and a different nodata.
    b = _write_raster(tmp_path / "b.tif", np.full((6, 6), 5.0), origin=(30.0, 100.0), nodata=-1.0)
    out = tmp_path / "mosaic.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.mosaic",
        {
            "input_path": str(a),
            "raster_2": str(b),
            "raster_3": "  ",
            "output_path": str(out),
            "method": "MAX",
        },
    )
    captured = capsys.readouterr().out
    assert "different nodata values" in captured
    assert "Merged 2 rasters (method=max)" in captured
    with rasterio.open(out) as ds:
        assert (ds.width, ds.height) == (9, 6)
        assert ds.nodata == -9999.0
        arr = ds.read(1)
    assert arr[0, 0] == 1.0
    assert arr[0, 4] == 5.0  # the overlap takes the max
    assert arr[0, 8] == 5.0


def test_mosaic_rejects_bad_inputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    a = _write_raster(tmp_path / "a.tif", np.ones((3, 3)))
    wgs = _write_raster(tmp_path / "wgs.tif", np.ones((3, 3)), crs="EPSG:4326")
    two = _write_raster(tmp_path / "two.tif", np.ones((2, 3, 3)))
    no_crs = _write_raster(tmp_path / "nocrs.tif", np.ones((3, 3)), crs=None)
    cases = [
        ({"input_path": str(a), "raster_2": str(a), "method": "mean"}, "Unsupported merge method"),
        ({"input_path": str(a)}, "at least two rasters"),
        ({"input_path": str(a), "raster_2": str(wgs)}, "same CRS"),
        ({"input_path": str(a), "raster_2": str(two)}, "same band count"),
        ({"input_path": str(no_crs), "raster_2": str(a)}, "First raster has no CRS"),
    ]
    for params, message in cases:
        with pytest.raises(SystemExit, match=message):
            _run_worker(
                monkeypatch,
                "raster_tools.mosaic",
                {**params, "output_path": str(tmp_path / "m.tif")},
            )


# --- contour --------------------------------------------------------------------


def test_contour_lines_carry_levels_and_projected_crs(
    tmp_path: Path, ramp: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    pytest.importorskip("contourpy")
    out = tmp_path / "contours.geojson"
    _run_worker(
        monkeypatch,
        "raster_tools.contour",
        {
            "input_path": str(ramp),
            "output_path": str(out),
            "interval": 10,
            "base": 5,
            "attribute": "z",
        },
    )
    assert _result(capsys) == {"output_path": str(out)}
    fc = json.loads(out.read_text())
    assert fc["crs"]["properties"]["name"] == "urn:ogc:def:crs:EPSG::3857"
    levels = sorted({f["properties"]["z"] for f in fc["features"]})
    assert levels == [5.0, 15.0, 25.0, 35.0]
    for feature in fc["features"]:
        assert feature["geometry"]["type"] == "LineString"
        for x, y in feature["geometry"]["coordinates"]:
            # Pixel centres span 5..55 in x and 45..95 in y.
            assert 5 <= x <= 55 and 45 <= y <= 95


@pytest.mark.parametrize(("crs", "expect_member"), [("EPSG:4326", None), (CUSTOM_TMERC, "wkt")])
def test_contour_crs_member_by_raster_crs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, crs: str, expect_member: str | None
) -> None:
    pytest.importorskip("contourpy")
    src = _write_raster(
        tmp_path / "src.tif",
        np.arange(16, dtype="float32").reshape(4, 4),
        crs=crs,
        origin=(0, 1),
        res=0.1,
    )
    out = tmp_path / "contours.geojson"
    _run_worker(
        monkeypatch,
        "raster_tools.contour",
        {"input_path": str(src), "output_path": str(out), "interval": 4},
    )
    fc = json.loads(out.read_text())
    assert fc["features"]
    if expect_member is None:
        assert "crs" not in fc
    else:
        assert "TRANSVERSE" in fc["crs"]["properties"]["name"].upper()


def test_contour_rejects_bad_inputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("contourpy")
    ramp_path = _write_raster(tmp_path / "r.tif", np.arange(9, dtype="float32").reshape(3, 3))
    empty = _write_raster(tmp_path / "empty.tif", np.full((3, 3), -9999.0))
    flat = _write_raster(tmp_path / "flat.tif", np.full((3, 3), 5.0))
    cases = [
        ({"input_path": str(ramp_path), "interval": 0}, "interval must be > 0"),
        ({"input_path": str(empty), "interval": 1}, "no valid data"),
        ({"input_path": str(flat), "interval": 10}, "No contour levels"),
    ]
    for params, message in cases:
        with pytest.raises(SystemExit, match=message):
            _run_worker(
                monkeypatch,
                "raster_tools.contour",
                {**params, "output_path": str(tmp_path / "c.geojson")},
            )


# --- polygonize -----------------------------------------------------------------


def test_polygonize_integer_classes_largest_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    grid = np.ones((4, 6), dtype="int32")
    grid[:, 4:] = 2  # a smaller class on the right
    src = _write_raster(tmp_path / "classes.tif", grid, dtype="int32", nodata=None)
    out = tmp_path / "polys.geojson"
    _run_worker(
        monkeypatch,
        "raster_tools.polygonize",
        {"input_path": str(src), "output_path": str(out), "field": "cls", "connectivity": 8},
    )
    captured = capsys.readouterr().out
    assert "floor-truncates" not in captured
    fc = json.loads(out.read_text())
    assert fc["crs"]["properties"]["name"] == "urn:ogc:def:crs:EPSG::3857"
    assert [f["properties"]["cls"] for f in fc["features"]] == [1, 2]


@pytest.mark.parametrize(("crs", "has_wkt"), [("EPSG:4326", False), (CUSTOM_TMERC, True)])
def test_polygonize_float_band_with_nan_nodata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    crs: str,
    has_wkt: bool,
) -> None:
    grid = np.full((3, 3), 4.0, dtype="float32")
    grid[0, 0] = np.nan
    src = _write_raster(
        tmp_path / "float.tif", grid, crs=crs, nodata=float("nan"), origin=(0, 1), res=0.1
    )
    out = tmp_path / "polys.geojson"
    _run_worker(
        monkeypatch, "raster_tools.polygonize", {"input_path": str(src), "output_path": str(out)}
    )
    assert "floor-truncates" in capsys.readouterr().out
    fc = json.loads(out.read_text())
    assert [f["properties"]["value"] for f in fc["features"]] == [4.0]
    assert ("crs" in fc) is has_wkt
