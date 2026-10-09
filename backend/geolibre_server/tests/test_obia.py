"""Native OBIA endpoints: segmentation, measurement, job files and cancellation."""

import csv
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

from geolibre_server.app import conversion
from geolibre_server.app.conversion import _RESULT_MARKER
from geolibre_server.app.obia import (
    _MEASURE_SCRIPT,
    _SEGMENT_SCRIPT,
    FelzenszwalbParams,
    ReadArea,
    Segmentation,
    SlicParams,
    _validated_segmentation,
)

try:
    import numpy as np
    import rasterio
    import scipy  # noqa: F401
    import skimage  # noqa: F401

    HAS_OBIA = True
except ImportError:  # pragma: no cover - depends on the optional extra
    HAS_OBIA = False

requires_obia = pytest.mark.skipif(not HAS_OBIA, reason="obia optional extra not installed")


def _run(script: str, params: dict) -> dict:
    """Run an embedded script with this interpreter and return its result."""
    completed = subprocess.run(
        [sys.executable, "-c", script, json.dumps(params)],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    line = next(x for x in completed.stdout.splitlines() if x.startswith(_RESULT_MARKER))
    return json.loads(line[len(_RESULT_MARKER) :])


def _two_region_tif(path: Path, overviews: bool = False) -> Path:
    """A 2-band, 6 x 4 image: a dark left half and a bright right half."""
    from rasterio.transform import from_origin

    data = np.zeros((2, 4, 6), dtype="float32")
    data[0, :, :3], data[0, :, 3:] = 10, 90
    data[1, :, :3], data[1, :, 3:] = 50, 20
    if overviews:
        data = np.repeat(np.repeat(data, 8, axis=1), 8, axis=2)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=data.shape[2],
        height=data.shape[1],
        count=2,
        dtype="float32",
        crs="EPSG:32617",
        transform=from_origin(500000, 4000000, 10, 10),
    ) as dst:
        dst.write(data)
        if overviews:
            dst.build_overviews([2, 4])
    return path


def _felzenszwalb(path: Path, **extra) -> dict:
    return {
        "input_path": str(path),
        "bands": [1, 2],
        "area": None,
        "method": "felzenszwalb",
        "slic": None,
        "felzenszwalb": {"scale": 1, "sigma": 0, "min_size": 2},
        **extra,
    }


@requires_obia
def test_segment_writes_labels_and_wgs84_objects(tmp_path: Path) -> None:
    image = _two_region_tif(tmp_path / "image.tif")
    result = _run(
        _SEGMENT_SCRIPT,
        {"segmentation": _felzenszwalb(image), "out_dir": str(tmp_path), "max_pixels": 10**6},
    )
    assert result["object_count"] == 2
    assert (result["width"], result["height"]) == (6, 4)
    with rasterio.open(tmp_path / "segments.tif") as src:
        labels = src.read(1)
        assert src.crs.to_epsg() == 32617
    assert set(np.unique(labels)) == {1, 2}
    assert len(set(labels[:, :3].ravel())) == 1
    objects = json.loads((tmp_path / "objects.geojson").read_text())
    assert [f["properties"]["segment_id"] for f in objects["features"]] == [1, 2]
    assert [f["id"] for f in objects["features"]] == [1, 2]
    lon, lat = objects["features"][0]["geometry"]["coordinates"][0][0]
    # UTM 17N at 500 km easting is on the zone's central meridian, 81 W.
    assert abs(lon - -81) < 0.01 and 35 < lat < 37


@requires_obia
def test_measure_matches_the_browser_engines_columns(tmp_path: Path) -> None:
    image = _two_region_tif(tmp_path / "image.tif")
    seg = _felzenszwalb(image)
    _run(_SEGMENT_SCRIPT, {"segmentation": seg, "out_dir": str(tmp_path), "max_pixels": 10**6})
    result = _run(
        _MEASURE_SCRIPT,
        {
            "segmentation": seg,
            "labels_path": str(tmp_path / "segments.tif"),
            "options": {"spectral": True, "shape": True, "context": True},
            "out_dir": str(tmp_path),
            "max_pixels": 10**6,
        },
    )
    assert result["object_count"] == 2
    with open(tmp_path / "features.csv", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    # The same columns, and for these two 3 x 4 objects the same values, as
    # geolibre-wasm's spectral, shape and context tools.
    assert list(rows[0]) == [
        "segment_id",
        "mean_b1",
        "std_b1",
        "min_b1",
        "max_b1",
        "mean_b2",
        "std_b2",
        "min_b2",
        "max_b2",
        "area_px",
        "perimeter_px",
        "compactness",
        "bbox_width_px",
        "bbox_height_px",
        "elongation",
        "neighbor_count",
        "shared_boundary_total",
        "mean_shared_boundary",
    ]
    left = {key: float(value) for key, value in rows[0].items()}
    assert left["mean_b1"] == 10 and left["std_b1"] == 0 and left["mean_b2"] == 50
    assert left["area_px"] == 12 and left["perimeter_px"] == 14
    assert abs(left["compactness"] - 0.769370) < 1e-6
    assert (left["bbox_width_px"], left["bbox_height_px"]) == (3, 4)
    assert left["elongation"] == pytest.approx(4 / 3)
    assert (left["neighbor_count"], left["shared_boundary_total"]) == (1, 4)
    assert left["mean_shared_boundary"] == 4


@requires_obia
def test_measure_resegments_when_the_labels_are_gone(tmp_path: Path) -> None:
    image = _two_region_tif(tmp_path / "image.tif")
    result = _run(
        _MEASURE_SCRIPT,
        {
            "segmentation": _felzenszwalb(image),
            "labels_path": str(tmp_path / "missing.tif"),
            "options": {"spectral": True, "shape": False, "context": False},
            "out_dir": str(tmp_path),
            "max_pixels": 10**6,
        },
    )
    assert result["object_count"] == 2
    # Without shape, the object size still comes along as area_px.
    assert result["fields"][-1] == "area_px"


@requires_obia
def test_reads_a_window_from_an_overview(tmp_path: Path) -> None:
    image = _two_region_tif(tmp_path / "image.tif", overviews=True)  # 48 x 32
    seg = {
        **_felzenszwalb(image),
        "method": "slic",
        "slic": {"size": 16, "compactness": 1},
        "felzenszwalb": None,
        # The left half at overview 1 (half resolution): 12 x 16 pixels.
        "area": {"level": 1, "window": [0, 0, 24, 32]},
    }
    result = _run(
        _SEGMENT_SCRIPT, {"segmentation": seg, "out_dir": str(tmp_path), "max_pixels": 10**6}
    )
    assert (result["width"], result["height"]) == (12, 16)
    assert result["pixel_size"] == 20
    with rasterio.open(tmp_path / "segments.tif") as src:
        assert src.transform.c == 500000 and src.transform.a == 20


@requires_obia
def test_refuses_an_area_over_the_pixel_limit(tmp_path: Path) -> None:
    image = _two_region_tif(tmp_path / "image.tif")
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            conversion._SCRIPT_DRIVER.replace("{source}", repr(_SEGMENT_SCRIPT)),
            json.dumps(
                {"segmentation": _felzenszwalb(image), "out_dir": str(tmp_path), "max_pixels": 10}
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 1
    assert "over the native limit" in completed.stdout


def test_validation_rejects_bad_requests(tmp_path: Path) -> None:
    text = tmp_path / "image.txt"
    text.write_text("x")
    with pytest.raises(HTTPException) as excinfo:
        _validated_segmentation(
            Segmentation(
                input_path=str(text),
                bands=[1],
                method="slic",
                slic=SlicParams(size=10, compactness=1),
            )
        )
    assert excinfo.value.status_code == 400
    tif = tmp_path / "image.tif"
    tif.write_bytes(b"II*\x00")
    with pytest.raises(HTTPException):
        _validated_segmentation(Segmentation(input_path=str(tif), bands=[1], method="slic"))
    with pytest.raises(HTTPException):
        _validated_segmentation(
            Segmentation(
                input_path=str(tif),
                bands=[1],
                area=ReadArea(level=0, window=[5, 0, 5, 10]),
                method="felzenszwalb",
                felzenszwalb=FelzenszwalbParams(scale=1, sigma=0, min_size=1),
            )
        )
    ok = _validated_segmentation(
        Segmentation(
            input_path=str(tif),
            bands=[2, 1],
            method="slic",
            slic=SlicParams(size=10, compactness=1),
        )
    )
    assert ok["input_path"] == str(tif.resolve()) and ok["bands"] == [2, 1]


def test_a_running_job_can_be_cancelled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(conversion, "_runtime_python", lambda: sys.executable)
    job = conversion._start_job("obia-test", "import time\ntime.sleep(30)\n", {}, "objects")
    for _ in range(100):
        if conversion._PROCESSES.get(job.id) is not None:
            break
        time.sleep(0.05)
    conversion._cancel_job(job.id)
    for _ in range(100):
        state = conversion._job_state(job.id)
        if state.status not in {"pending", "running"}:
            break
        time.sleep(0.05)
    assert state.status == "cancelled"
    assert state.error == "Cancelled."
    assert job.id not in conversion._PROCESSES
