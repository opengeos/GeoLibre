"""Regression tests for extracted worker modules and shared JobManager."""

from __future__ import annotations

import importlib
import json
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

from geolibre_server.app.job_manager import JobManager
from geolibre_server.app.runtime import JobState
from geolibre_server.workers import (
    RESULT_MARKER,
    load_worker_source,
    worker_path,
)
from geolibre_server.workers.conversion_helpers import shapefile_field_warnings

ALL_WORKERS = [
    "conversion_vector",
    "conversion_vector_to_vector",
    "conversion_vector_layers",
    "conversion_pmtiles",
    "conversion_raster",
    "obia_segment",
    "obia_measure",
    "pointcloud_apply_labels",
    "whitebox_ensure_cog",
    "whitebox_runner",
    "raster_tools.hillshade",
    "raster_tools.slope",
    "raster_tools.aspect",
    "raster_tools.reproject",
    "raster_tools.resample",
    "raster_tools.clip_extent",
    "raster_tools.clip_mask",
    "raster_tools.polygonize",
    "raster_tools.contour",
    "raster_tools.interpolate",
    "raster_tools.zonal_stats",
    "raster_tools.raster_calc",
    "raster_tools.reclassify",
    "raster_tools.mosaic",
    "raster_tools.focal",
]


@pytest.mark.parametrize("worker_name", ALL_WORKERS)
def test_worker_module_is_importable_and_compiles(worker_name: str) -> None:
    path = worker_path(worker_name)
    assert path.is_file()
    module = importlib.import_module(f"geolibre_server.workers.{worker_name}")
    assert callable(module.main)
    source = load_worker_source(worker_name)
    compile(source, str(path), "exec")
    if worker_name != "whitebox_runner":
        assert RESULT_MARKER in source


def test_worker_path_rejects_traversal() -> None:
    with pytest.raises(ValueError):
        worker_path("..app.main")


def test_helper_worker_loader_does_not_mutate_sys_path() -> None:
    """Loaded worker scripts with sibling helpers must not prepend site-packages to sys.path."""
    for name in ("conversion_vector", "obia_segment"):
        source = load_worker_source(name)
        assert "sys.path" not in source
        assert "spec_from_file_location" in source


def test_shapefile_field_warnings_reports_truncation_and_collisions() -> None:
    assert shapefile_field_warnings(["short", "id"]) == []
    warnings = shapefile_field_warnings(["population_2020", "population_2025", "ok"])
    assert len(warnings) == 2
    assert "population_2020" in warnings[0]
    assert "duplicate field names" in warnings[1]


def test_job_manager_enforces_in_flight_cap_chronological_eviction_and_message_bound() -> None:
    manager = JobManager(
        busy_detail="busy",
        max_retained=2,
        max_in_flight=1,
        max_messages=3,
    )
    release = threading.Event()
    started = threading.Event()

    def worker(job_id: str) -> None:
        manager.update(job_id, status="running")
        started.set()
        for i in range(5):
            manager.append_message(job_id, f"line-{i}")
        release.wait(timeout=5)
        manager.update(job_id, status="succeeded")

    first = manager.start_thread_job("tool-a", worker)
    assert started.wait(timeout=5)
    with pytest.raises(HTTPException) as exc:
        manager.start_thread_job("tool-b", worker)
    assert exc.value.status_code == 429

    release.set()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = manager.get(first.id)
        if state and state.status == "succeeded":
            break
        time.sleep(0.02)
    final_first = manager.get(first.id)
    assert final_first is not None
    assert final_first.status == "succeeded"
    assert final_first.messages == ["line-2", "line-3", "line-4"]

    # Seed older finished jobs and verify oldest created_at is evicted first.
    with manager.lock:
        manager.jobs["old"] = JobState(
            id="old",
            status="succeeded",
            tool_id="t",
            created_at="2020-01-01T00:00:00+00:00",
            updated_at="2020-01-01T00:00:00+00:00",
        )
        manager.jobs["mid"] = JobState(
            id="mid",
            status="failed",
            tool_id="t",
            created_at="2021-01-01T00:00:00+00:00",
            updated_at="2021-01-01T00:00:00+00:00",
        )
        manager.evict_finished_locked()
        assert "old" not in manager.jobs
        assert len(manager.jobs) == 2


def test_job_manager_process_lifecycle_and_snapshot() -> None:
    manager = JobManager()
    state = JobState(
        id="job-1",
        status="running",
        tool_id="tool-x",
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    )
    with manager.lock:
        manager.jobs[state.id] = state
    manager.append_message(state.id, "step 1")
    assert manager.snapshot_messages(state.id) == ["step 1"]
    assert manager.snapshot_messages("missing") == []

    killed = False

    class FakeProc:
        def poll(self):
            return None

        def kill(self):
            nonlocal killed
            killed = True

    proc = FakeProc()
    assert manager.register_process(state.id, proc) is False  # type: ignore[arg-type]
    manager.cancel(state.id)
    assert killed is True
    assert manager.is_cancelled(state.id) is True
    manager.clear_process(state.id)
    assert manager.is_cancelled(state.id) is False


def _write_test_dem(path: Path, data) -> Path:
    rasterio = pytest.importorskip("rasterio")
    from rasterio.transform import from_origin

    arr = data
    if arr.ndim == 2:
        arr = arr[None, :, :]
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=arr.shape[1],
        width=arr.shape[2],
        count=arr.shape[0],
        dtype="float32",
        crs="EPSG:3857",
        transform=from_origin(0.0, 100.0, 10.0, 10.0),
        nodata=-9999.0,
    ) as dst:
        dst.write(arr.astype("float32"))
    return path


def _run_worker(monkeypatch: pytest.MonkeyPatch, module_name: str, params: dict) -> None:
    mod = importlib.import_module(f"geolibre_server.workers.{module_name}")
    monkeypatch.setattr(sys, "argv", [module_name, json.dumps(params)])
    mod.main()


def test_raster_workers_in_process_terrain_and_masking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    np = pytest.importorskip("numpy")
    rasterio = pytest.importorskip("rasterio")

    # Ramp with a steep shadow face and one explicit nodata pixel.
    grid = np.array(
        [
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [0.0, 10.0, 20.0, 30.0, 40.0, 50.0],
            [0.0, 20.0, 40.0, 60.0, 80.0, 100.0],
            [0.0, 30.0, 60.0, -9999.0, 120.0, 150.0],
            [0.0, 40.0, 80.0, 120.0, 160.0, 200.0],
            [0.0, 50.0, 100.0, 150.0, 200.0, 250.0],
        ],
        dtype="float32",
    )
    dem = _write_test_dem(tmp_path / "dem.tif", grid)

    hs_out = tmp_path / "hillshade.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.hillshade",
        {"input_path": str(dem), "output_path": str(hs_out), "azimuth": 315, "altitude": 45},
    )
    with rasterio.open(hs_out) as ds:
        assert ds.nodata is None
        mask = ds.dataset_mask()
        assert mask[3, 3] == 0
        assert mask[1, 1] == 255

    for units in ("degrees", "percent"):
        slope_out = tmp_path / f"slope_{units}.tif"
        _run_worker(
            monkeypatch,
            "raster_tools.slope",
            {"input_path": str(dem), "output_path": str(slope_out), "units": units},
        )
        with rasterio.open(slope_out) as ds:
            arr = ds.read(1)
            assert arr[3, 3] == -9999.0
            assert arr[1, 1] > 0

    aspect_out = tmp_path / "aspect.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.aspect",
        {"input_path": str(dem), "output_path": str(aspect_out)},
    )
    with rasterio.open(aspect_out) as ds:
        arr = ds.read(1)
        assert arr[3, 3] == -9999.0
        assert 0.0 <= arr[1, 1] <= 360.0


def test_raster_workers_in_process_analysis_and_geometry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    np = pytest.importorskip("numpy")
    rasterio = pytest.importorskip("rasterio")

    base = np.arange(1, 37, dtype="float32").reshape((6, 6))
    a_path = _write_test_dem(tmp_path / "a.tif", base)
    b_path = _write_test_dem(tmp_path / "b.tif", base * 2.0)

    # Reclassify
    reclass_out = tmp_path / "reclass.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.reclassify",
        {
            "input_path": str(a_path),
            "output_path": str(reclass_out),
            "band": 1,
            "table": "0:10:1, 10:25:2",
            "unmatched": "original",
        },
    )
    with rasterio.open(reclass_out) as ds:
        arr = ds.read(1)
        assert arr[0, 0] == 1.0
        assert arr[0, 1] == 1.0  # input 2 -> mapped to class 1
        assert arr[2, 0] == 2.0  # input 13 -> mapped to class 2
        assert arr[5, 5] == 36.0  # unmatched -> kept original

    # Focal (streaming + median)
    for stat in ("mean", "median", "min", "max", "sum", "std", "range"):
        focal_out = tmp_path / f"focal_{stat}.tif"
        _run_worker(
            monkeypatch,
            "raster_tools.focal",
            {
                "input_path": str(a_path),
                "output_path": str(focal_out),
                "size": 3,
                "statistic": stat,
            },
        )
        assert focal_out.is_file()

    # Raster calculator (multi-raster + functions)
    calc_out = tmp_path / "calc.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.raster_calc",
        {
            "input_path": str(a_path),
            "b_path": str(b_path),
            "output_path": str(calc_out),
            "expression": "where(A > 10, B - A, abs(A) * 2)",
        },
    )
    with rasterio.open(calc_out) as ds:
        arr = ds.read(1)
        assert arr[0, 0] == pytest.approx(2.0)
        assert arr[5, 5] == pytest.approx(36.0)

    # Clip extent
    clip_out = tmp_path / "clip.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.clip_extent",
        {
            "input_path": str(a_path),
            "output_path": str(clip_out),
            "minx": 10.0,
            "miny": 60.0,
            "maxx": 40.0,
            "maxy": 90.0,
        },
    )
    with rasterio.open(clip_out) as ds:
        assert ds.width == 3
        assert ds.height == 3

    # Resample + Reproject
    resample_out = tmp_path / "resample.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.resample",
        {"input_path": str(a_path), "output_path": str(resample_out), "resolution": 20.0},
    )
    with rasterio.open(resample_out) as ds:
        assert ds.width == 3
        assert ds.height == 3

    # Resample with nodata=None and outward-rounded border marks uncovered edge invalid
    from rasterio.transform import from_origin

    no_nd_path = tmp_path / "no_nodata.tif"
    with rasterio.open(
        no_nd_path,
        "w",
        driver="GTiff",
        height=3,
        width=3,
        count=1,
        dtype="float32",
        crs="EPSG:3857",
        transform=from_origin(0.0, 9.0, 3.0, 3.0),
        nodata=None,
    ) as dst:
        dst.write(np.zeros((1, 3, 3), dtype="float32"))
    border_out = tmp_path / "resample_border.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.resample",
        {
            "input_path": str(no_nd_path),
            "output_path": str(border_out),
            "resolution": 4.0,
            "resampling": "nearest",
        },
    )
    with rasterio.open(border_out) as ds:
        assert ds.nodata is None
        assert ds.width == 3
        mask = ds.dataset_mask()
        assert mask[0, 0] == 255  # valid zero sample stays valid
        assert mask[0, 2] == 0  # uncovered outward-rounded border marked invalid

    # Average resampling over a 4x4 grid with one masked cell keeps output valid
    # when valid contributing pixels exist, while nearest at the masked cell masks it.
    avg_src = tmp_path / "avg_mask.tif"
    with rasterio.open(
        avg_src,
        "w",
        driver="GTiff",
        height=4,
        width=4,
        count=1,
        dtype="float32",
        crs="EPSG:3857",
        transform=from_origin(0.0, 4.0, 1.0, 1.0),
        nodata=None,
    ) as dst:
        dst.write(np.full((1, 4, 4), 7.0, dtype="float32"))
        src_mask = np.full((4, 4), 255, dtype="uint8")
        src_mask[2, 2] = 0
        dst.write_mask(src_mask)
    avg_out = tmp_path / "resample_avg.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.resample",
        {
            "input_path": str(avg_src),
            "output_path": str(avg_out),
            "resolution": 4.0,
            "resampling": "average",
        },
    )
    with rasterio.open(avg_out) as ds:
        assert ds.read(1)[0, 0] == pytest.approx(7.0)
        assert ds.dataset_mask()[0, 0] == 255

    reproj_out = tmp_path / "reproj.tif"
    _run_worker(
        monkeypatch,
        "raster_tools.reproject",
        {"input_path": str(a_path), "output_path": str(reproj_out), "dst_crs": "EPSG:4326"},
    )
    with rasterio.open(reproj_out) as ds:
        assert ds.crs.to_epsg() == 4326


def test_worker_modules_match_canonical_markers() -> None:
    """Every marker literal emitted by extracted workers must match canonical markers."""
    import re

    import geolibre_server.workers as workers_pkg
    from geolibre_server.workers import ERROR_MARKER, RESULT_MARKER

    workers_root = Path(workers_pkg.__file__).resolve().parent
    worker_files = [p for p in sorted(workers_root.rglob("*.py")) if p.name != "__init__.py"]
    assert len(worker_files) >= 15

    marker_re = re.compile(r"""["'](__GEOLIBRE_[A-Z0-9_]+__:?[^"']*)["']""")
    matched_any_result = False
    for path in worker_files:
        text = path.read_text(encoding="utf-8")
        for candidate in marker_re.findall(text):
            if "ERROR" in candidate:
                assert candidate == ERROR_MARKER, (
                    f"{path} emitted marker {candidate!r} != {ERROR_MARKER!r}"
                )
            elif "RESULT" in candidate:
                assert candidate == RESULT_MARKER, (
                    f"{path} emitted marker {candidate!r} != {RESULT_MARKER!r}"
                )
                matched_any_result = True
    assert matched_any_result
