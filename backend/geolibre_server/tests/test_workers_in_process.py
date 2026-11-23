"""In-process tests for the conversion, OBIA, point cloud and COG workers.

The sidecar runs each worker in a subprocess, which coverage does not see. These
tests call each worker's ``main()`` directly with ``sys.argv`` patched, so both the
happy paths and the validation errors are measured.
"""

from __future__ import annotations

import base64
import csv
import importlib
import json
import sys
import types
import zipfile
import zlib
from pathlib import Path

import pytest

from geolibre_server.workers import RESULT_MARKER


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


def _write_raster(path: Path, data, crs: str | None = "EPSG:32617", nodata=None, res: float = 10.0):
    """Write a float32 GeoTIFF from a 2D or 3D array.

    Args:
        path: Destination file path.
        data: A 2D (single band) or 3D (bands, rows, cols) array.
        crs: The raster CRS, or None for an ungeoreferenced raster.
        nodata: The nodata value, or None for none.
        res: The square pixel size.

    Returns:
        The path that was written.
    """
    np = pytest.importorskip("numpy")
    rasterio = pytest.importorskip("rasterio")
    from rasterio.transform import from_origin

    arr = np.asarray(data, dtype="float32")
    if arr.ndim == 2:
        arr = arr[None, :, :]
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=arr.shape[2],
        height=arr.shape[1],
        count=arr.shape[0],
        dtype="float32",
        crs=crs,
        transform=from_origin(500000, 4000000, res, res),
        nodata=nodata,
    ) as dst:
        dst.write(arr)
    return path


# --- OBIA -----------------------------------------------------------------------


@pytest.fixture
def obia_deps():
    """Skip unless the OBIA optional extra (scikit-image, SciPy) is installed."""
    pytest.importorskip("numpy")
    pytest.importorskip("rasterio")
    pytest.importorskip("scipy")
    pytest.importorskip("skimage")


def _two_region(path: Path, crs: str = "EPSG:32617", nodata=None):
    """Write a 2-band, 6 x 4 image: a dark left half and a bright right half.

    Args:
        path: Destination file path.
        crs: The image CRS.
        nodata: The nodata value, or None for none.

    Returns:
        The path that was written.
    """
    import numpy as np

    data = np.zeros((2, 4, 6), dtype="float32")
    data[0, :, :3], data[0, :, 3:] = 10, 90
    data[1, :, :3], data[1, :, 3:] = 50, 20
    return _write_raster(path, data, crs=crs, nodata=nodata)


def _seg(path: Path, **extra) -> dict:
    """Build Felzenszwalb segmentation parameters for ``path``."""
    return {
        "input_path": str(path),
        "bands": [1, 2],
        "area": None,
        "method": "felzenszwalb",
        "slic": None,
        "felzenszwalb": {"scale": 1, "sigma": 0, "min_size": 2},
        **extra,
    }


def test_obia_segment_and_measure_in_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], obia_deps
) -> None:
    import numpy as np
    import rasterio

    image = _two_region(tmp_path / "image.tif")
    seg = _seg(image)
    _run_worker(
        monkeypatch,
        "obia_segment",
        {"segmentation": seg, "out_dir": str(tmp_path), "max_pixels": 10**6},
    )
    result = _result(capsys)
    assert result["object_count"] == 2
    assert (result["width"], result["height"], result["pixel_size"]) == (6, 4, 10.0)
    with rasterio.open(tmp_path / "segments.tif") as src:
        labels = src.read(1)
        assert src.nodata == 0
    assert set(np.unique(labels)) == {1, 2}
    objects = json.loads((tmp_path / "objects.geojson").read_text())
    lon, lat = objects["features"][0]["geometry"]["coordinates"][0][0]
    assert abs(lon - -81) < 0.01 and 35 < lat < 37

    _run_worker(
        monkeypatch,
        "obia_measure",
        {
            "segmentation": seg,
            "labels_path": str(tmp_path / "segments.tif"),
            "options": {"spectral": True, "shape": True, "context": True},
            "out_dir": str(tmp_path),
            "max_pixels": 10**6,
        },
    )
    result = _result(capsys)
    assert result["object_count"] == 2
    with open(tmp_path / "features.csv", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    right = {key: float(value) for key, value in rows[1].items()}
    assert right["mean_b1"] == 90 and right["mean_b2"] == 20
    assert right["area_px"] == 12 and right["perimeter_px"] == 14
    assert right["neighbor_count"] == 1 and right["shared_boundary_total"] == 4


def test_obia_slic_in_wgs84_and_measure_resegments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], obia_deps
) -> None:
    image = _two_region(tmp_path / "image.tif", crs="EPSG:4326")
    seg = _seg(image, method="slic", slic={"size": 4, "compactness": 1}, felzenszwalb=None)
    _run_worker(
        monkeypatch,
        "obia_segment",
        {"segmentation": seg, "out_dir": str(tmp_path), "max_pixels": 10**6},
    )
    assert _result(capsys)["object_count"] >= 2
    objects = json.loads((tmp_path / "objects.geojson").read_text())
    # Already WGS84: coordinates are the raster's own, not reprojected.
    x, y = objects["features"][0]["geometry"]["coordinates"][0][0]
    assert x >= 500000 and y <= 4000000

    _run_worker(
        monkeypatch,
        "obia_measure",
        {
            "segmentation": seg,
            "labels_path": None,
            "options": {"spectral": False, "shape": True, "context": False},
            "out_dir": str(tmp_path),
            "max_pixels": 10**6,
        },
    )
    out = capsys.readouterr().out
    assert "Re-segmenting" in out
    fields = json.loads(out.split(RESULT_MARKER, 1)[1])["fields"]
    assert fields == [
        "area_px",
        "perimeter_px",
        "compactness",
        "bbox_width_px",
        "bbox_height_px",
        "elongation",
    ]


def test_obia_measure_rejects_labels_of_another_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, obia_deps
) -> None:
    import numpy as np
    from rasterio.transform import from_origin

    from geolibre_server.workers.obia_common import write_labels

    image = _two_region(tmp_path / "image.tif")
    labels_path = tmp_path / "other.tif"
    write_labels(
        np.ones((3, 3), dtype="int32"), from_origin(0, 0, 1, 1), "EPSG:32617", str(labels_path)
    )
    with pytest.raises(SystemExit, match="no longer match"):
        _run_worker(
            monkeypatch,
            "obia_measure",
            {
                "segmentation": _seg(image),
                "labels_path": str(labels_path),
                "options": {"spectral": True},
                "out_dir": str(tmp_path),
                "max_pixels": 10**6,
            },
        )


def test_obia_read_area_validation(tmp_path: Path, obia_deps) -> None:
    from geolibre_server.workers.obia_common import read_area

    image = _two_region(tmp_path / "image.tif")
    no_crs = _two_region(tmp_path / "nocrs.tif", crs=None)
    cases = [
        (_seg(no_crs), "no coordinate reference system"),
        (_seg(image, bands=[1, 3]), "no band 3"),
        (_seg(image, area={"level": 2, "window": [0, 0, 6, 4]}), "no overview level 2"),
        (_seg(image, area={"level": 0, "window": [10, 10, 20, 20]}), "does not overlap"),
    ]
    for seg, message in cases:
        with pytest.raises(SystemExit, match=message):
            read_area(seg, 10**6)
    with pytest.raises(SystemExit, match="over the native limit of 10 pixels"):
        read_area(_seg(image), 10)

    data, valid, transform, crs = read_area(_seg(image, bands=[2]), 10**6)
    assert data.shape == (1, 4, 6)
    assert bool(valid.all())
    assert crs.to_epsg() == 32617


def test_obia_read_area_masks_nodata_and_segment_clears_it(tmp_path: Path, obia_deps) -> None:
    import numpy as np

    from geolibre_server.workers.obia_common import read_area, segment

    data = np.full((1, 4, 6), 5.0, dtype="float32")
    data[0, 0, 0] = 0.1  # NoData with no exact float32 form
    data[0, 1, 1] = np.nan
    image = _write_raster(tmp_path / "nd.tif", data, nodata=0.1)
    seg = _seg(image, bands=[1])
    arr, valid, _, _ = read_area(seg, 10**6)
    assert not valid[0, 0] and not valid[1, 1]
    assert int(valid.sum()) == 22
    labels = segment(seg, arr, valid)
    assert labels[0, 0] == 0 and labels[1, 1] == 0
    assert int(labels.max()) >= 1


def test_obia_write_labels_tiles_large_rasters(tmp_path: Path, obia_deps) -> None:
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    from geolibre_server.workers.obia_common import write_labels

    labels = np.arange(256 * 512, dtype="int32").reshape(256, 512)
    path = tmp_path / "labels.tif"
    write_labels(labels, from_origin(0, 0, 1, 1), "EPSG:32617", str(path))
    with rasterio.open(path) as src:
        assert src.profile["tiled"] is True
        assert src.block_shapes[0] == (256, 256)
        assert int(src.read(1)[255, 511]) == 256 * 512 - 1


# --- point cloud labels -----------------------------------------------------------

# Encoded by the app's label store (encodeNodeEdits): classes {0: 6, 1: 6, 2: 2}
# and instance ids {0: 1, 5: 300, 70000: 4294967295}.
APP_CLASSES = "Y2ADQiYA"
APP_INSTANCES = "Y2BkWcP0ahHLfyDgBwA="


def _deflate(raw: bytes) -> str:
    """Raw-deflate and base64 ``raw`` the way the app encodes label records."""
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    return base64.b64encode(compressor.compress(raw) + compressor.flush()).decode()


def _write_las(path: Path, count: int = 100, point_format: int = 6) -> None:
    """Write a small LAS file whose points are all class 1.

    Args:
        path: Destination file path.
        count: Number of points.
        point_format: The LAS point format id.
    """
    laspy = pytest.importorskip("laspy")
    import numpy as np

    header = laspy.LasHeader(
        point_format=point_format, version="1.4" if point_format >= 6 else "1.2"
    )
    header.scales = [0.01, 0.01, 0.01]
    las = laspy.LasData(header)
    las.x = np.arange(count, dtype=float)
    las.y = np.zeros(count)
    las.z = np.arange(count, dtype=float) / 10
    las.classification = np.ones(count, dtype=np.uint8)
    las.write(str(path))


def _apply_labels(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
    input_path: Path,
    output_path: Path,
    payload: dict,
) -> dict:
    """Run the point cloud label worker and return its result.

    Args:
        monkeypatch: The pytest monkeypatch fixture.
        capsys: The pytest capture fixture.
        tmp_path: A scratch directory for the payload file.
        input_path: The source point cloud.
        output_path: Where the relabelled point cloud is written.
        payload: The ``labels``/``instances`` payload handed over in a file.

    Returns:
        The worker's result object.
    """
    payload_path = tmp_path / "payload.json"
    payload_path.write_text(json.dumps(payload))
    _run_worker(
        monkeypatch,
        "pointcloud_apply_labels",
        {
            "input_path": str(input_path),
            "output_path": str(output_path),
            "payload_path": str(payload_path),
        },
    )
    assert not payload_path.exists()
    return _result(capsys)


def test_pointcloud_applies_labels_and_instances(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    laspy = pytest.importorskip("laspy")
    _write_las(tmp_path / "in.las")
    result = _apply_labels(
        monkeypatch,
        capsys,
        tmp_path,
        tmp_path / "in.las",
        tmp_path / "out.las",
        {"labels": {"file": APP_CLASSES}, "instances": {"file": APP_INSTANCES}},
    )
    assert result["points"] == 100
    assert (result["relabelled"], result["instanced"]) == (3, 2)
    out = laspy.read(str(tmp_path / "out.las"))
    assert list(out.classification[:4]) == [6, 6, 2, 1]
    assert int(out["instance"][5]) == 300


def test_pointcloud_upgrades_legacy_format_and_skips_bad_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    laspy = pytest.importorskip("laspy")
    _write_las(tmp_path / "legacy.las", point_format=3)
    payload = {
        "labels": {
            "file": _deflate(bytes([0, 64])),
            "1-0-0-0": APP_CLASSES,  # not a node of a non-COPC file: ignored
            "0-0-0-0": 5,  # not a string: ignored
        },
        # A narrow record whose value byte is missing, and a wide record whose
        # varint never ends.
        "instances": {"file": _deflate(bytes([0x80]))},
    }
    result = _apply_labels(
        monkeypatch, capsys, tmp_path, tmp_path / "legacy.las", tmp_path / "out.las", payload
    )
    assert (result["relabelled"], result["instanced"]) == (1, 0)
    out = laspy.read(str(tmp_path / "out.las"))
    # Format 3 carries colour, so the class-64 upgrade lands on format 7.
    assert out.header.point_format.id == 7
    assert int(out.classification[0]) == 64
    assert int(out.classification[1]) == 1


@pytest.mark.parametrize(
    ("record", "wide", "reason"),
    [
        (bytes([0]), False, "truncated label record"),
        (bytes([0xFF] * 6), False, "varint too long"),
        (bytes([0, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F]), True, "instance id out of range"),
    ],
)
def test_pointcloud_reports_each_bad_record(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    record: bytes,
    wide: bool,
    reason: str,
) -> None:
    pytest.importorskip("laspy")
    _write_las(tmp_path / "in.las", count=10)
    key = "instances" if wide else "labels"
    payload_path = tmp_path / "payload.json"
    payload_path.write_text(json.dumps({key: {"file": _deflate(record)}}))
    _run_worker(
        monkeypatch,
        "pointcloud_apply_labels",
        {
            "input_path": str(tmp_path / "in.las"),
            "output_path": str(tmp_path / "out.las"),
            "payload_path": str(payload_path),
        },
    )
    out = capsys.readouterr().out
    assert f"Skipped the labels of node file: {reason}" in out
    assert json.loads(out.split(RESULT_MARKER, 1)[1])["points"] == 10


def test_pointcloud_rejects_a_copc_hierarchy_outside_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import struct

    laspy = pytest.importorskip("laspy")
    import numpy as np

    path = tmp_path / "bad.copc.laz"
    las = laspy.LasData(laspy.LasHeader(point_format=6, version="1.4"))
    las.x = np.arange(10, dtype=float)
    las.y = np.zeros(10)
    las.z = np.zeros(10)
    placeholder = b"\xab" * 160
    las.header.vlrs.append(
        laspy.VLR(user_id="copc", record_id=1, description="", record_data=placeholder)
    )
    las.write(str(path))
    raw = bytearray(path.read_bytes())
    at = raw.index(placeholder)
    struct.pack_into("<QQ", raw, at + 40, len(raw) + 100, 32)
    path.write_bytes(bytes(raw))
    payload_path = tmp_path / "payload.json"
    payload_path.write_text(json.dumps({"labels": {}}))
    with pytest.raises(ValueError, match="outside the file"):
        _run_worker(
            monkeypatch,
            "pointcloud_apply_labels",
            {
                "input_path": str(path),
                "output_path": str(tmp_path / "out.las"),
                "payload_path": str(payload_path),
            },
        )


# --- vector conversion (DuckDB spatial) ------------------------------------------


@pytest.fixture
def duckdb_spatial(monkeypatch: pytest.MonkeyPatch):
    """Return duckdb once its spatial extension loads, else skip.

    Args:
        monkeypatch: Used to clear ``DUCKDB_EXTENSION_DIRECTORY`` for the test.

    Returns:
        The imported duckdb module.
    """
    duckdb = pytest.importorskip("duckdb")
    monkeypatch.delenv("DUCKDB_EXTENSION_DIRECTORY", raising=False)
    try:
        duckdb.connect().execute("LOAD spatial;")
    except Exception:  # pragma: no cover - depends on the local install
        pytest.skip("DuckDB spatial extension is not installed")
    return duckdb


def _points_geojson(path: Path) -> Path:
    """Write three WGS84 points with two long, colliding field names.

    Args:
        path: Destination file path.

    Returns:
        The path that was written.
    """
    features = [
        {
            "type": "Feature",
            "properties": {"name": f"p{i}", "population_total": i, "population_totals": i * 2},
            "geometry": {"type": "Point", "coordinates": [float(i), float(i)]},
        }
        for i in range(1, 4)
    ]
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    return path


def _connect(duckdb):
    """Open a DuckDB connection with spatial loaded."""
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    return con


def test_vector_to_geoparquet_and_flatgeobuf(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    duckdb_spatial,
) -> None:
    src = _points_geojson(tmp_path / "pts.geojson")
    out = tmp_path / "pts.parquet"
    _run_worker(
        monkeypatch,
        "conversion_vector",
        {
            "input_path": str(src),
            "output_path": str(out),
            "compression": "snappy",
            "row_group_size": 2,
        },
    )
    result = _result(capsys)
    assert result["feature_count"] == 3
    assert result["warnings"] == []
    con = _connect(duckdb_spatial)
    names = con.execute(f"SELECT name FROM read_parquet('{out}') ORDER BY name").fetchall()
    assert [n for (n,) in names] == ["p1", "p2", "p3"]

    fgb = tmp_path / "pts.fgb"
    _run_worker(
        monkeypatch,
        "conversion_vector",
        {"input_path": str(out), "output_path": str(fgb), "output_format": "flatgeobuf"},
    )
    assert _result(capsys)["feature_count"] == 3
    assert con.execute(f"SELECT count(*) FROM ST_Read('{fgb}')").fetchone()[0] == 3


def test_vector_to_zipped_shapefile_warns_on_field_truncation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    duckdb_spatial,
) -> None:
    src = _points_geojson(tmp_path / "pts.geojson")
    out = tmp_path / "pts.zip"
    _run_worker(
        monkeypatch,
        "conversion_vector",
        {"input_path": str(src), "output_path": str(out), "output_format": "shapefile"},
    )
    result = _result(capsys)
    assert result["feature_count"] == 3
    assert any("truncates field names" in w for w in result["warnings"])
    assert any("duplicate field names" in w for w in result["warnings"])
    with zipfile.ZipFile(out) as archive:
        members = set(archive.namelist())
    assert {"pts.shp", "pts.shx", "pts.dbf", "pts.prj"} <= members


def test_csv_to_geoparquet_builds_points(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    duckdb_spatial,
) -> None:
    src = tmp_path / "cities.csv"
    src.write_text("city,lon,lat\nA,10.5,20.25\nB,-3,4\n")
    out = tmp_path / "cities.parquet"
    _run_worker(
        monkeypatch,
        "conversion_vector",
        {
            "input_path": str(src),
            "output_path": str(out),
            "source_kind": "csv",
            "lon_column": "lon",
            "lat_column": "lat",
        },
    )
    result = _result(capsys)
    assert (result["feature_count"], result["geometry_column"]) == (2, "geometry")
    con = _connect(duckdb_spatial)
    row = con.execute(
        f"SELECT ST_X(geometry), ST_Y(geometry) FROM read_parquet('{out}') WHERE city = 'A'"
    ).fetchone()
    assert row == (10.5, 20.25)


def _wkb_parquet(duckdb, path: Path, with_geometry: bool = True) -> Path:
    """Write a plain Parquet file holding geometry as a WKB blob (or none).

    Args:
        duckdb: The duckdb module with spatial available.
        path: Destination file path.
        with_geometry: Whether to include the WKB ``geometry`` column.

    Returns:
        The path that was written.
    """
    con = _connect(duckdb)
    geometry = ", ST_AsWKB(ST_Point(i, i))::BLOB AS geometry" if with_geometry else ""
    con.execute(f"COPY (SELECT i AS id{geometry} FROM range(4) t(i)) TO '{path}' (FORMAT PARQUET)")
    return path


def test_vector_conversion_rebuilds_wkb_blobs_and_requires_geometry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    duckdb_spatial,
) -> None:
    wkb = _wkb_parquet(duckdb_spatial, tmp_path / "wkb.parquet")
    out = tmp_path / "out.parquet"
    _run_worker(monkeypatch, "conversion_vector", {"input_path": str(wkb), "output_path": str(out)})
    result = _result(capsys)
    assert (result["feature_count"], result["geometry_column"]) == (4, "geometry")

    _run_worker(
        monkeypatch,
        "conversion_vector_to_vector",
        {
            "input_path": str(wkb),
            "output_path": str(tmp_path / "wkb.gpkg"),
            "output_kind": "gdal",
            "output_driver": "GPKG",
        },
    )
    assert _result(capsys)["feature_count"] == 4

    plain = _wkb_parquet(duckdb_spatial, tmp_path / "plain.parquet", with_geometry=False)
    for worker, extra in (
        ("conversion_vector", {}),
        ("conversion_vector_to_vector", {"output_kind": "parquet"}),
    ):
        with pytest.raises(SystemExit, match="No geometry column"):
            _run_worker(
                monkeypatch,
                worker,
                {"input_path": str(plain), "output_path": str(tmp_path / "x.parquet"), **extra},
            )
    # A WKB blob carries no CRS, so a reprojection has nothing to start from.
    with pytest.raises(SystemExit, match="does not declare a CRS"):
        _run_worker(
            monkeypatch,
            "conversion_vector_to_vector",
            {
                "input_path": str(wkb),
                "output_path": str(tmp_path / "x.parquet"),
                "output_kind": "parquet",
                "target_srs": "EPSG:3857",
            },
        )


def test_vector_to_vector_reprojects_geojson(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    duckdb_spatial,
) -> None:
    src = _points_geojson(tmp_path / "pts.geojson")
    out = tmp_path / "pts.fgb"
    _run_worker(
        monkeypatch,
        "conversion_vector_to_vector",
        {
            "input_path": str(src),
            "output_path": str(out),
            "output_kind": "gdal",
            "output_driver": "FlatGeobuf",
            "target_srs": "EPSG:3857",
        },
    )
    assert _result(capsys)["feature_count"] == 3
    con = _connect(duckdb_spatial)
    x, y = con.execute(
        f"SELECT ST_X(geom), ST_Y(geom) FROM ST_Read('{out}') WHERE name = 'p1'"
    ).fetchone()
    assert x == pytest.approx(111319.49, abs=0.1)
    assert y == pytest.approx(111325.14, abs=0.1)

    # Back to WGS84 GeoParquet with an explicit source CRS.
    back = tmp_path / "back.parquet"
    _run_worker(
        monkeypatch,
        "conversion_vector_to_vector",
        {
            "input_path": str(out),
            "output_path": str(back),
            "output_kind": "parquet",
            "source_srs": "EPSG:3857",
            "target_srs": "EPSG:4326",
        },
    )
    assert _result(capsys)["feature_count"] == 3
    x, y = con.execute(
        f"SELECT ST_X(geom), ST_Y(geom) FROM read_parquet('{back}') WHERE name = 'p1'"
    ).fetchone()
    assert (x, y) == (pytest.approx(1.0), pytest.approx(1.0))


def test_vector_to_vector_shapefile_outputs_and_zip_input(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    duckdb_spatial,
) -> None:
    src = _points_geojson(tmp_path / "pts.geojson")
    shp_dir = tmp_path / "shp"
    shp_dir.mkdir()
    _run_worker(
        monkeypatch,
        "conversion_vector_to_vector",
        {
            "input_path": str(src),
            "output_path": str(shp_dir / "pts.shp"),
            "output_kind": "gdal",
            "output_driver": "ESRI Shapefile",
        },
    )
    result = _result(capsys)
    assert len(result["warnings"]) == 2
    assert {p.suffix for p in shp_dir.iterdir()} >= {".shp", ".shx", ".dbf", ".prj"}

    zipped = tmp_path / "pts.zip"
    _run_worker(
        monkeypatch,
        "conversion_vector_to_vector",
        {
            "input_path": str(src),
            "output_path": str(zipped),
            "output_kind": "gdal",
            "output_driver": "ESRI Shapefile",
            "zip_shapefile": True,
        },
    )
    capsys.readouterr()
    with zipfile.ZipFile(zipped) as archive:
        assert "pts.shp" in archive.namelist()

    # The zipped Shapefile reads back through /vsizip/, here as CSV with WKT.
    csv_out = tmp_path / "pts.csv"
    _run_worker(
        monkeypatch,
        "conversion_vector_to_vector",
        {
            "input_path": str(zipped),
            "output_path": str(csv_out),
            "output_kind": "gdal",
            "output_driver": "CSV",
            "input_layer": "pts",
        },
    )
    assert _result(capsys)["feature_count"] == 3
    text = csv_out.read_text()
    assert text.splitlines()[0].startswith("WKT")
    assert "POINT (1 1)" in text


def test_vector_to_vector_rejects_unknown_driver(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, duckdb_spatial
) -> None:
    src = _points_geojson(tmp_path / "pts.geojson")
    with pytest.raises(SystemExit, match="cannot write the 'NoSuchDriver' driver"):
        _run_worker(
            monkeypatch,
            "conversion_vector_to_vector",
            {
                "input_path": str(src),
                "output_path": str(tmp_path / "x.out"),
                "output_kind": "gdal",
                "output_driver": "NoSuchDriver",
            },
        )


def test_vector_layers_lists_gpkg_zip_and_gdb(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    duckdb_spatial,
) -> None:
    src = _points_geojson(tmp_path / "pts.geojson")
    con = _connect(duckdb_spatial)
    gpkg = tmp_path / "pts.gpkg"
    con.execute(
        # Only real fields: GDAL's GeoPackage writer rejects ST_Read's OGC_FID column.
        f"COPY (SELECT name, geom FROM ST_Read('{src}')) TO '{gpkg}' "
        "(FORMAT GDAL, DRIVER 'GPKG', SRS 'EPSG:4326')"
    )
    _run_worker(monkeypatch, "conversion_vector_layers", {"input_path": str(gpkg)})
    layers = _result(capsys)["layers"]
    assert len(layers) == 1
    # The geometry type is whatever GDAL recorded for the layer ("Unknown (any)"
    # for DuckDB's generic GEOMETRY column), so only its presence is checked.
    assert isinstance(layers[0].pop("geometry_type"), str)
    assert layers == [{"name": "pts", "feature_count": 3, "crs": "EPSG:4326"}]

    shp_dir = tmp_path / "shp"
    shp_dir.mkdir()
    con.execute(
        f"COPY (SELECT name, geom FROM ST_Read('{src}')) TO '{shp_dir / 'pts.shp'}' "
        "(FORMAT GDAL, DRIVER 'ESRI Shapefile', SRS 'EPSG:4326')"
    )
    zipped = tmp_path / "pts.zip"
    with zipfile.ZipFile(zipped, "w") as archive:
        for member in shp_dir.iterdir():
            archive.write(member, member.name)
    _run_worker(monkeypatch, "conversion_vector_layers", {"input_path": str(zipped)})
    assert [layer["name"] for layer in _result(capsys)["layers"]] == ["pts"]

    gdb = tmp_path / "data.gdb"
    try:
        con.execute(
            f"COPY (SELECT name, geom FROM ST_Read('{src}')) TO '{gdb}' "
            "(FORMAT GDAL, DRIVER 'OpenFileGDB', SRS 'EPSG:4326')"
        )
    except duckdb_spatial.Error:  # pragma: no cover - depends on the GDAL build
        return
    _run_worker(monkeypatch, "conversion_vector_layers", {"input_path": str(gdb)})
    names = [layer["name"] for layer in _result(capsys)["layers"]]
    assert names and not any(name.startswith("GDB_") for name in names)


def test_pmtiles_prepares_parquet_for_freestiler(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    duckdb_spatial,
) -> None:
    calls = []

    def freestile_file(source, output, **kwargs):
        """Record the call and check the staged Parquet holds every feature."""
        con = _connect(duckdb_spatial)
        calls.append(
            (con.execute(f"SELECT count(*) FROM read_parquet('{source}')").fetchone()[0], kwargs)
        )
        Path(output).write_bytes(b"PMTiles")

    monkeypatch.setitem(
        sys.modules, "freestiler", types.SimpleNamespace(freestile_file=freestile_file)
    )
    src = _points_geojson(tmp_path / "pts.geojson")
    out = tmp_path / "pts.pmtiles"
    _run_worker(
        monkeypatch,
        "conversion_pmtiles",
        {"input_path": str(src), "output_path": str(out), "min_zoom": 2, "max_zoom": 9},
    )
    assert _result(capsys) == {"output_path": str(out), "layer_name": "data"}
    assert calls == [(3, {"layer_name": "data", "min_zoom": 2, "max_zoom": 9, "quiet": True})]
    assert out.read_bytes() == b"PMTiles"

    # A GeoParquet input is read directly, under a custom layer name.
    parquet = tmp_path / "pts.parquet"
    _connect(duckdb_spatial).execute(
        f"COPY (SELECT * FROM ST_Read('{src}')) TO '{parquet}' (FORMAT PARQUET)"
    )
    _run_worker(
        monkeypatch,
        "conversion_pmtiles",
        {"input_path": str(parquet), "output_path": str(out), "layer_name": "cities"},
    )
    assert _result(capsys)["layer_name"] == "cities"
    assert calls[-1][1]["layer_name"] == "cities"


def test_pmtiles_explains_a_missing_freestiler(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("duckdb")
    monkeypatch.setitem(sys.modules, "freestiler", None)
    with pytest.raises(SystemExit, match="freestiler is not installed"):
        _run_worker(
            monkeypatch,
            "conversion_pmtiles",
            {"input_path": str(tmp_path / "x.geojson"), "output_path": str(tmp_path / "x.pmtiles")},
        )


# --- Cloud Optimized GeoTIFF --------------------------------------------------------


def _striped_raster(path: Path) -> Path:
    """Write a 600 x 600 striped (non-COG) GeoTIFF."""
    np = pytest.importorskip("numpy")
    return _write_raster(path, np.arange(600 * 600, dtype="float32").reshape(600, 600))


def test_raster_to_cog_writes_a_valid_cog(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    pytest.importorskip("rio_cogeo")
    from rio_cogeo.cogeo import cog_validate

    src = _striped_raster(tmp_path / "src.tif")
    out = tmp_path / "cog.tif"
    _run_worker(
        monkeypatch,
        "conversion_raster",
        {"input_path": str(src), "output_path": str(out), "compression": "deflate"},
    )
    result = _result(capsys)
    assert result["valid"] is True
    assert result["output_path"] == str(out)
    assert cog_validate(str(out), quiet=True)[0]


def test_whitebox_ensure_cog_converts_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    pytest.importorskip("rio_cogeo")
    from rio_cogeo.cogeo import cog_validate

    from geolibre_server.workers import whitebox_ensure_cog

    path = _striped_raster(tmp_path / "wbt.tif")
    path.chmod(0o640)
    temporary = tmp_path / "wbt.tmp.tif"
    assert not cog_validate(str(path), quiet=True)[0]
    monkeypatch.setattr(sys, "argv", ["whitebox_ensure_cog", str(path), str(temporary)])
    whitebox_ensure_cog.main()
    assert _result(capsys) == {"converted": True}
    assert cog_validate(str(path), quiet=True)[0]
    assert not temporary.exists()
    assert path.stat().st_mode & 0o777 == 0o640

    # Already a COG: reported as unchanged with a clean exit.
    with pytest.raises(SystemExit) as excinfo:
        whitebox_ensure_cog.main()
    assert excinfo.value.code == 0
    assert _result(capsys) == {"converted": False}
