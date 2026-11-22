"""Native object-based image analysis (OBIA) for the Object-Based Analysis workbench.

The workbench segments and measures images in the browser on the geolibre-wasm
engine, which a 32-bit WebAssembly memory ceiling limits to scenes of tens of
millions of pixels. These endpoints run the same two steps natively, on the
managed conversion runtime, for local GeoTIFFs too large for that:

- ``POST /obia/segment`` segments a window of the image, at full resolution or
  an overview, with scikit-image (SLIC superpixels or Felzenszwalb's graph
  method), writes the label raster, and polygonizes it to WGS84 objects.
- ``POST /obia/measure`` measures each object (spectral statistics, shape and
  neighbor context) into a CSV whose columns match the browser engine's, so
  rules and classifiers work the same on either.

Both run as background jobs polled with ``GET /conversion/jobs/{job_id}``. A
job writes into its own private folder, never a client-chosen path, and the
client downloads the results with ``GET /obia/jobs/{job_id}/files/{name}``.
``scikit-image`` is installed into the runtime on first use (the optional
``obia`` extra of this package lists the same requirement).
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from geolibre_server.workers import load_worker_source

from .conversion import (
    _RUNTIME_SETUP_LOCK,
    _cancel_job,
    _job_state,
    _runtime_python,
    _start_job,
    _validate_input_path,
)
from .runtime import (
    RUNTIME_DISCOVERY_TIMEOUT_SECS,
    RuntimeBootstrapError,
    _clean_env,
    _subprocess_startup_kwargs,
)

router = APIRouter(prefix="/obia", tags=["obia"])
logger = logging.getLogger(__name__)

OBIA_PACKAGES = os.environ.get(
    "GEOLIBRE_OBIA_PACKAGES", "scikit-image>=0.22 scipy>=1.10 numpy>=1.24"
).split()
_GEOTIFF_EXTENSIONS = {".tif", ".tiff"}
# Pixels a native run may read: well past the browser engine's limit, within a
# desktop's memory (SLIC holds the bands as float64 alongside its distance
# grids, about 60 bytes per pixel for four bands), and small enough for the
# browser to decode the label raster (as Float32, under 512 MB) to export it.
# Felzenszwalb builds a graph of every pixel's edges, about 360 bytes per pixel
# (a 47-million-pixel scene peaked at 17 GB), so it gets a lower limit.
NATIVE_MAX_PIXELS = {"slic": 120_000_000, "felzenszwalb": 25_000_000}
# The files a job may write, and so the only names the download serves.
_JOB_FILES = {"segments.tif", "objects.geojson", "features.csv"}
JOB_DIR_MAX_AGE_SECS = 24 * 3600
MAX_JOB_DIRS = 8


class ReadArea(BaseModel):
    """A full-resolution pixel window and the resolution level to read it at."""

    level: int = Field(ge=0, le=32)
    window: list[int] = Field(min_length=4, max_length=4)


class SlicParams(BaseModel):
    """SLIC superpixels: about ``size`` pixels per object, ``compactness`` trades
    color similarity for square shapes."""

    size: int = Field(ge=4, le=1_000_000)
    compactness: float = Field(gt=0, le=1000)


class FelzenszwalbParams(BaseModel):
    """Felzenszwalb's graph method: larger ``scale`` gives larger objects."""

    scale: float = Field(gt=0, le=100_000)
    sigma: float = Field(ge=0, le=20)
    min_size: int = Field(ge=1, le=1_000_000)


class Segmentation(BaseModel):
    """How to segment: the image, its bands and area, and the method."""

    input_path: str
    bands: list[int] = Field(min_length=1, max_length=64)
    area: ReadArea | None = None
    method: Literal["slic", "felzenszwalb"]
    slic: SlicParams | None = None
    felzenszwalb: FelzenszwalbParams | None = None


class MeasureOptions(BaseModel):
    """Which object features to compute."""

    spectral: bool = True
    shape: bool = True
    context: bool = False


class MeasureRequest(BaseModel):
    """Measure the objects of a segmentation (re-run when its files are gone)."""

    segmentation: Segmentation
    segment_job_id: str | None = None
    options: MeasureOptions = MeasureOptions()


# --- Worker modules ----------------------------------------------------------
#
# Worker scripts live as real Python modules under ``geolibre_server.workers``
# (``obia_common.py``, ``obia_segment.py``, ``obia_measure.py``) so ruff, type
# checks, and pytest inspect them directly.

_SEGMENT_SCRIPT = load_worker_source("obia_segment")
_MEASURE_SCRIPT = load_worker_source("obia_measure")


# --- Runtime and job folders --------------------------------------------------


def _check_obia_import(python: str) -> bool:
    """Whether the runtime can import the native OBIA stack.

    Args:
        python: The runtime interpreter.

    Returns:
        True when scikit-image, scipy and rasterio import.
    """
    try:
        completed = subprocess.run(
            [python, "-c", "import skimage, scipy, rasterio, numpy"],
            check=False,
            capture_output=True,
            text=True,
            env=_clean_env(),
            timeout=RUNTIME_DISCOVERY_TIMEOUT_SECS,
            **_subprocess_startup_kwargs(),
        )
    except subprocess.TimeoutExpired:
        return False
    return completed.returncode == 0


def _ensure_obia_runtime() -> str:
    """Return the runtime Python, installing scikit-image into it if missing.

    Returns:
        The runtime interpreter path.

    Raises:
        RuntimeBootstrapError: When the runtime or the install is unavailable.
    """
    python = _runtime_python()
    if _check_obia_import(python):
        return python
    # The conversion runtime's own setup lock: this install mutates the same
    # venv its bootstrap creates and repopulates.
    with _RUNTIME_SETUP_LOCK:
        if _check_obia_import(python):
            return python
        from .runtime import _uv_executable

        completed = subprocess.run(
            [_uv_executable(), "pip", "install", "--python", python, *OBIA_PACKAGES],
            check=False,
            capture_output=True,
            text=True,
            env=_clean_env(),
            timeout=900,
            **_subprocess_startup_kwargs(),
        )
        if completed.returncode != 0 or not _check_obia_import(python):
            detail = (completed.stderr or completed.stdout or "").strip()[-500:]
            raise RuntimeBootstrapError(f"Could not install OBIA support: {detail}")
    return python


# Job id -> its private output folder. Only jobs started here are listed, so the
# download endpoint never serves another router's job or a client path.
_JOB_DIRS: dict[str, str] = {}
# Segment job id -> the segmentation it ran, so a measure job reuses its labels
# only for the same segmentation.
_JOB_SPECS: dict[str, dict] = {}
# Measure job id -> the segmentation folder whose labels it reads.
_JOB_USES: dict[str, str] = {}
_JOB_DIRS_LOCK = threading.Lock()
# Folders created for jobs that are still starting (not yet in _JOB_DIRS).
_RESERVED: set[str] = set()
_BASE_DIR: str | None = None


def _base_dir() -> Path:
    """The private parent folder of the job folders, created on first use."""
    global _BASE_DIR
    if _BASE_DIR is None or not Path(_BASE_DIR).is_dir():
        _BASE_DIR = tempfile.mkdtemp(prefix="geolibre-obia-")
    return Path(_BASE_DIR)


def _new_job_dir(protect: str | None = None) -> str:
    """A fresh private folder for one job, pruning old ones.

    Keeps the newest ``MAX_JOB_DIRS`` folders and any younger than a day, so a
    measure job can reuse its segmentation's labels without the folders
    growing without bound.

    Args:
        protect: A folder a job about to start reads from, kept as well.

    Returns:
        The folder path.
    """
    base = _base_dir()
    # Never prune a pending or running job's folder, however old, nor the
    # folder whose labels such a job (or the one about to start) reads.
    with _JOB_DIRS_LOCK:
        jobs = list(_JOB_DIRS.items())
        uses = dict(_JOB_USES)
        reserved = set(_RESERVED)
    busy = {Path(protect)} if protect else set()
    busy |= {Path(folder) for folder in reserved}
    for job_id, folder in jobs:
        state = _job_state(job_id)
        if state is not None and state.status in {"pending", "running"}:
            busy.add(Path(folder))
            if job_id in uses:
                busy.add(Path(uses[job_id]))

    # Another request may prune at the same time: a folder that vanished
    # meanwhile is simply skipped.
    def mtime(folder: Path) -> float | None:
        try:
            return folder.stat().st_mtime
        except OSError:
            return None

    candidates = [(mtime(p), p) for p in base.iterdir() if p.is_dir() and p not in busy]
    folders = sorted(
        ((t, p) for t, p in candidates if t is not None), key=lambda item: item[0], reverse=True
    )
    cutoff = time.time() - JOB_DIR_MAX_AGE_SECS
    # Always keep the newest finished folder: a measure job usually follows
    # its segmentation, and re-segmenting a large scene is slow.
    keep = max(1, MAX_JOB_DIRS - 1 - len(busy))
    for index, (modified, folder) in enumerate(folders):
        if index >= keep or modified < cutoff:
            shutil.rmtree(folder, ignore_errors=True)
    with _JOB_DIRS_LOCK:
        for job_id, folder in list(_JOB_DIRS.items()):
            if not Path(folder).is_dir():
                del _JOB_DIRS[job_id]
                _JOB_SPECS.pop(job_id, None)
                _JOB_USES.pop(job_id, None)
        folder = tempfile.mkdtemp(prefix="job-", dir=base)
        # Reserved until its job is registered, so a concurrent prune spares it.
        _RESERVED.add(folder)
    return folder


def _validated_segmentation(seg: Segmentation) -> dict:
    """Check a segmentation request and return it as job parameters.

    Args:
        seg: The requested segmentation.

    Returns:
        The parameters, with the input path resolved within the allowed roots.

    Raises:
        HTTPException: For a bad path, band, area or method setting.
    """
    path = _validate_input_path(seg.input_path)
    if Path(path).suffix.lower() not in _GEOTIFF_EXTENSIONS:
        raise HTTPException(status_code=400, detail="The image must be a GeoTIFF (.tif)")
    if any(band < 1 for band in seg.bands):
        raise HTTPException(status_code=400, detail="Bands are numbered from 1")
    if seg.area is not None:
        x0, y0, x1, y1 = seg.area.window
        if min(x0, y0) < 0 or x1 <= x0 or y1 <= y0:
            raise HTTPException(status_code=400, detail="The area's window is empty")
    if seg.method == "slic" and seg.slic is None:
        raise HTTPException(status_code=400, detail="SLIC needs its parameters")
    if seg.method == "felzenszwalb" and seg.felzenszwalb is None:
        raise HTTPException(status_code=400, detail="Felzenszwalb needs its parameters")
    data = seg.model_dump()
    data["input_path"] = path
    return data


def _pixel_limit(segmentation: dict) -> int:
    """The pixel limit of a run: its method's, lowered for more than 4 bands.

    The limits are sized for 4 bands; memory grows with the band count.

    Args:
        segmentation: The validated segmentation parameters.

    Returns:
        The number of pixels the run may read.
    """
    limit = NATIVE_MAX_PIXELS[segmentation["method"]]
    return limit * 4 // max(4, len(segmentation["bands"]))


def _start(tool_id: str, script: str, params: dict, uses: str | None = None):
    try:
        _ensure_obia_runtime()
    except RuntimeBootstrapError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    out_dir = _new_job_dir(protect=uses)
    try:
        job = _start_job(
            tool_id,
            script,
            {
                **params,
                "out_dir": out_dir,
                "max_pixels": _pixel_limit(params["segmentation"]),
            },
            "objects",
        )
    except BaseException:
        with _JOB_DIRS_LOCK:
            _RESERVED.discard(out_dir)
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    with _JOB_DIRS_LOCK:
        _RESERVED.discard(out_dir)
        _JOB_DIRS[job.id] = out_dir
        if tool_id == "obia-segment":
            _JOB_SPECS[job.id] = params["segmentation"]
        if uses:
            _JOB_USES[job.id] = uses
    return job


# --- Endpoints ---------------------------------------------------------------


_INSTALL_LOCK = threading.Lock()
_INSTALL_THREAD: threading.Thread | None = None
_INSTALL_ERROR: str | None = None
_INSTALL_FAILED_AT = 0.0
INSTALL_RETRY_SECS = 300


def _start_install() -> None:
    """Install scikit-image into the runtime in the background, once at a time."""
    global _INSTALL_THREAD, _INSTALL_ERROR

    def install() -> None:
        global _INSTALL_ERROR, _INSTALL_FAILED_AT
        try:
            _ensure_obia_runtime()
            _INSTALL_ERROR = None
        except Exception as exc:  # noqa: BLE001 - reported through /status
            logger.warning("OBIA runtime install failed: %s", exc)
            _INSTALL_ERROR = "Native OBIA runtime is unavailable. Check the sidecar logs."
            _INSTALL_FAILED_AT = time.time()

    with _INSTALL_LOCK:
        if _INSTALL_THREAD is not None and _INSTALL_THREAD.is_alive():
            return
        _INSTALL_THREAD = threading.Thread(target=install, daemon=True)
        _INSTALL_THREAD.start()


@router.get("/status")
def obia_status():
    """Report whether native segmentation is available.

    Checks only that the runtime imports scikit-image, which is quick. When it
    does not, the install starts in the background and the status reports
    ``installing``; ask again later.
    """
    try:
        python = _runtime_python()
        if _check_obia_import(python):
            return {
                "available": True,
                "message": "Native OBIA runtime (scikit-image) is available.",
                "max_pixels": NATIVE_MAX_PIXELS,
            }
    except RuntimeBootstrapError as exc:
        logger.warning("OBIA runtime unavailable: %s", exc)
        return {
            "available": False,
            "message": "Native OBIA runtime is unavailable. Check the sidecar logs.",
        }
    except Exception:
        logger.exception("Unexpected error while checking the OBIA runtime")
        return {"available": False, "message": "Native OBIA runtime status check failed."}
    # After a failed install, say so for a while rather than retrying on
    # every check; then try again (reported as installing, so the client
    # keeps asking).
    running = _INSTALL_THREAD is not None and _INSTALL_THREAD.is_alive()
    if _INSTALL_ERROR and not running and time.time() - _INSTALL_FAILED_AT < INSTALL_RETRY_SECS:
        return {"available": False, "message": _INSTALL_ERROR}
    _start_install()
    return {
        "available": False,
        "installing": True,
        "message": "Installing the native OBIA runtime (scikit-image); this takes a minute.",
    }


@router.post("/segment")
def obia_segment(request: Segmentation):
    """Segment and polygonize a local GeoTIFF as a background job.

    Poll it with ``GET /conversion/jobs/{job_id}``; on success download
    ``segments.tif`` and ``objects.geojson`` from ``/obia/jobs/{job_id}/files``.
    """
    params = {"segmentation": _validated_segmentation(request)}
    return _start("obia-segment", _SEGMENT_SCRIPT, params)


@router.post("/measure")
def obia_measure(request: MeasureRequest):
    """Measure a segmentation's objects as a background job.

    Reuses the label raster of ``segment_job_id`` while its files are kept,
    and re-runs the (deterministic) segmentation otherwise. On success
    download ``features.csv``.
    """
    params: dict = {
        "segmentation": _validated_segmentation(request.segmentation),
        "options": request.options.model_dump(),
    }
    folder = None
    if request.segment_job_id:
        with _JOB_DIRS_LOCK:
            # Reuse the labels only of a job that ran this very segmentation.
            if _JOB_SPECS.get(request.segment_job_id) == params["segmentation"]:
                folder = _JOB_DIRS.get(request.segment_job_id)
        if folder:
            params["labels_path"] = str(Path(folder) / "segments.tif")
    return _start("obia-measure", _MEASURE_SCRIPT, params, uses=folder)


@router.get("/jobs/{job_id}/files/{name}")
def obia_job_file(job_id: str, name: str):
    """Download one result file of an OBIA job."""
    if name not in _JOB_FILES:
        raise HTTPException(status_code=404, detail="No such result file")
    with _JOB_DIRS_LOCK:
        folder = _JOB_DIRS.get(job_id)
    path = Path(folder) / name if folder else None
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Result not found")
    media = {
        ".tif": "image/tiff",
        ".geojson": "application/geo+json",
        ".csv": "text/csv",
    }[path.suffix]
    return FileResponse(path, media_type=media)


@router.post("/jobs/{job_id}/cancel")
def obia_cancel(job_id: str):
    """Stop a running OBIA job."""
    with _JOB_DIRS_LOCK:
        known = job_id in _JOB_DIRS
    if not known or _job_state(job_id) is None:
        raise HTTPException(status_code=404, detail="Job not found")
    _cancel_job(job_id)
    return _job_state(job_id)
