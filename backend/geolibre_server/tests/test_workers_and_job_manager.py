"""Regression tests for extracted worker modules and shared JobManager."""

from __future__ import annotations

import importlib
import threading
import time

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
