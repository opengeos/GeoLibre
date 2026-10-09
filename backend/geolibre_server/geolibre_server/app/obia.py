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

from .conversion import (
    _RESULT_MARKER,
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


# --- Embedded scripts --------------------------------------------------------
#
# Shared by both jobs: read the bands over the area, and segment them. The
# script reads ``json.loads(sys.argv[1])``; curated input errors exit with
# ``SystemExit("...")`` (see conversion._SCRIPT_DRIVER).

_COMMON = r"""
import json
import os
import sys
import time

import numpy as np
import rasterio
from rasterio.windows import Window

params = json.loads(sys.argv[1])
seg = params["segmentation"]
out_dir = params["out_dir"]
MAX_PIXELS = params["max_pixels"]


def read_area():
    path = seg["input_path"]
    bands = seg["bands"]
    with rasterio.open(path) as full:
        width, height, count = full.width, full.height, full.count
        nodata = full.nodata
    missing = [b for b in bands if b < 1 or b > count]
    if missing:
        raise SystemExit(f"The image has no band {missing[0]}.")
    area = seg.get("area") or {"level": 0, "window": [0, 0, width, height]}
    level = area["level"]
    x0, y0, x1, y1 = area["window"]
    # Overview n of the file is level n; GDAL numbers overviews from 0.
    opener = {"overview_level": level - 1} if level > 0 else {}
    try:
        src = rasterio.open(path, **opener)
    except Exception:
        raise SystemExit(f"The image has no overview level {level}.")
    with src:
        sx = width / src.width
        sy = height / src.height
        wx0 = max(0, int(np.floor(x0 / sx)))
        wy0 = max(0, int(np.floor(y0 / sy)))
        wx1 = min(src.width, int(np.ceil(x1 / sx)))
        wy1 = min(src.height, int(np.ceil(y1 / sy)))
        if wx1 <= wx0 or wy1 <= wy0:
            raise SystemExit("The area to read does not overlap the image.")
        if (wx1 - wx0) * (wy1 - wy0) > MAX_PIXELS:
            raise SystemExit(
                f"The area has {wx1 - wx0} x {wy1 - wy0} pixels, over the native limit "
                f"of {MAX_PIXELS:,} pixels. Zoom in or use a coarser overview."
            )
        window = Window(wx0, wy0, wx1 - wx0, wy1 - wy0)
        data = src.read(bands, window=window, out_dtype="float32")
        transform = src.window_transform(window)
        crs = src.crs
    if crs is None:
        # Objects are written in WGS84: without a CRS they cannot be placed.
        raise SystemExit("The image has no coordinate reference system.")
    valid = np.all(np.isfinite(data), axis=0)
    if nodata is not None:
        valid &= np.all(data != nodata, axis=0)
    return data, valid, transform, crs


def segment(data, valid):
    from skimage.segmentation import felzenszwalb, relabel_sequential, slic

    # Standardize each band over the valid pixels, so no band dominates.
    image = np.empty(data.shape[1:] + (data.shape[0],), dtype="float32")
    for i, band in enumerate(data):
        values = band[valid]
        mean = float(values.mean()) if values.size else 0.0
        std = float(values.std()) if values.size else 1.0
        image[..., i] = (band - mean) / (std or 1.0)
    image[~valid] = 0
    if seg["method"] == "slic":
        p = seg["slic"]
        n = max(1, int(valid.sum() / p["size"]))
        # No mask: with one, SLIC seeds by k-means over every masked pixel,
        # which takes hours at this size even for a handful of NoData pixels.
        # NoData is zero after standardizing, and its labels are cleared below.
        labels = slic(
            image,
            n_segments=n,
            compactness=p["compactness"],
            channel_axis=-1,
            start_label=1,
            convert2lab=False,
            enforce_connectivity=True,
        )
    else:
        p = seg["felzenszwalb"]
        labels = felzenszwalb(
            image, scale=p["scale"], sigma=p["sigma"], min_size=p["min_size"], channel_axis=-1
        ) + 1
    labels = labels.astype("int32")
    labels[~valid] = 0
    labels, _, _ = relabel_sequential(labels)
    return labels.astype("int32")


def write_labels(labels, transform, crs, path):
    profile = {
        "driver": "GTiff",
        "width": labels.shape[1],
        "height": labels.shape[0],
        "count": 1,
        "dtype": "int32",
        "crs": crs,
        "transform": transform,
        "nodata": 0,
        "compress": "deflate",
        "tiled": labels.shape[1] >= 256 and labels.shape[0] >= 256,
    }
    if profile["tiled"]:
        profile.update(blockxsize=256, blockysize=256)
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(labels, 1)
"""

_SEGMENT_SCRIPT = (
    _COMMON
    + r"""
from rasterio.features import shapes
from rasterio.warp import transform as warp_transform

started = time.time()
data, valid, transform, crs = read_area()
print(f"Read {data.shape[2]} x {data.shape[1]} pixels, {data.shape[0]} bands", flush=True)
labels = segment(data, valid)
count = int(labels.max())
print(f"Segmented into {count} objects in {time.time() - started:.1f} s", flush=True)
write_labels(labels, transform, crs, os.path.join(out_dir, "segments.tif"))

# One feature per object: the pieces of a label (an object can touch itself
# only diagonally) gathered into one geometry, in WGS84 like the browser's.
pieces = {}
for geometry, value in shapes(labels, mask=labels > 0, connectivity=4, transform=transform):
    pieces.setdefault(int(value), []).append(geometry["coordinates"])
print(f"Polygonized {len(pieces)} objects", flush=True)

# Reproject every vertex in one call: per-geometry reprojection rebuilds the
# transformation each time and dominates the run for tens of thousands of
# objects.
if crs is not None and crs.to_epsg() != 4326:
    xs, ys = [], []
    for polygons in pieces.values():
        for polygon in polygons:
            for ring in polygon:
                for x, y in ring:
                    xs.append(x)
                    ys.append(y)
    lons, lats = warp_transform(crs, "EPSG:4326", xs, ys)
    position = 0
    for polygons in pieces.values():
        for polygon in polygons:
            for r, ring in enumerate(polygon):
                n = len(ring)
                polygon[r] = list(zip(lons[position : position + n], lats[position : position + n]))
                position += n


def rounded(coords):
    return [[[round(x, 7), round(y, 7)] for x, y in ring] for ring in coords]


with open(os.path.join(out_dir, "objects.geojson"), "w", encoding="utf-8") as out:
    out.write('{"type":"FeatureCollection","features":[')
    first = True
    for label in sorted(pieces):
        polygons = pieces[label]
        geometry = (
            {"type": "Polygon", "coordinates": rounded(polygons[0])}
            if len(polygons) == 1
            else {"type": "MultiPolygon", "coordinates": [rounded(p) for p in polygons]}
        )
        feature = {
            "type": "Feature",
            "id": label,
            "properties": {"segment_id": label},
            "geometry": geometry,
        }
        out.write(("" if first else ",") + json.dumps(feature, separators=(",", ":")))
        first = False
    out.write("]}")

result = {
    "object_count": count,
    "width": int(labels.shape[1]),
    "height": int(labels.shape[0]),
    "pixel_size": abs(float(transform.a)),
    "seconds": round(time.time() - started, 1),
}
print("{marker}" + json.dumps(result))
"""
).replace("{marker}", _RESULT_MARKER)

_MEASURE_SCRIPT = (
    _COMMON
    + r"""
from scipy import ndimage

started = time.time()
data, valid, transform, crs = read_area()
labels_path = params.get("labels_path")
if labels_path and os.path.exists(labels_path):
    with rasterio.open(labels_path) as src:
        labels = src.read(1)
    if labels.shape != data.shape[1:]:
        raise SystemExit("The objects no longer match the image. Segment again.")
else:
    print("Re-segmenting: the segmentation's files are gone", flush=True)
    labels = segment(data, valid)
n = int(labels.max())
ids = np.arange(1, n + 1)
flat = labels.ravel()
count = np.bincount(flat, minlength=n + 1).astype("float64")
present = count[1:] > 0
columns = {}
options = params["options"]
band_names = seg["bands"]

if options.get("spectral"):
    for b, band in zip(band_names, data):
        values = band.ravel().astype("float64")
        total = np.bincount(flat, weights=values, minlength=n + 1)
        squares = np.bincount(flat, weights=values * values, minlength=n + 1)
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = total / count
            std = np.sqrt(np.maximum(squares / count - mean * mean, 0))
        columns[f"mean_b{b}"] = mean[1:]
        columns[f"std_b{b}"] = std[1:]
        columns[f"min_b{b}"] = np.asarray(ndimage.minimum(band, labels, ids))
        columns[f"max_b{b}"] = np.asarray(ndimage.maximum(band, labels, ids))
    if not options.get("shape"):
        columns["area_px"] = count[1:]

# Pixel edges between differing labels, both ways, for perimeter and context.
pairs = []
for a, c in ((labels[:, :-1], labels[:, 1:]), (labels[:-1, :], labels[1:, :])):
    differ = a != c
    pairs.append((a[differ], c[differ]))

if options.get("shape"):
    # Perimeter in pixel edges: edges to another label or to the image border.
    perimeter = np.zeros(n + 1)
    for a, c in pairs:
        perimeter += np.bincount(a, minlength=n + 1) + np.bincount(c, minlength=n + 1)
    for edge in (labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]):
        perimeter += np.bincount(edge, minlength=n + 1)
    width = np.zeros(n)
    height = np.zeros(n)
    for i, box in enumerate(ndimage.find_objects(labels, max_label=n)):
        if box is not None:
            height[i] = box[0].stop - box[0].start
            width[i] = box[1].stop - box[1].start
    area = count[1:]
    with np.errstate(invalid="ignore", divide="ignore"):
        columns["area_px"] = area
        columns["perimeter_px"] = perimeter[1:]
        columns["compactness"] = 4 * np.pi * area / (perimeter[1:] ** 2)
        columns["bbox_width_px"] = width
        columns["bbox_height_px"] = height
        columns["elongation"] = np.maximum(width, height) / np.minimum(width, height)

if options.get("context"):
    # Shared edges between two objects (not with NoData).
    a = np.concatenate([p[0] for p in pairs])
    c = np.concatenate([p[1] for p in pairs])
    keep = (a > 0) & (c > 0)
    a, c = a[keep].astype("int64"), c[keep].astype("int64")
    shared = np.bincount(a, minlength=n + 1) + np.bincount(c, minlength=n + 1)
    lo, hi = np.minimum(a, c), np.maximum(a, c)
    unique = np.unique(lo * (n + 1) + hi)
    neighbors = np.bincount(unique // (n + 1), minlength=n + 1) + np.bincount(
        unique % (n + 1), minlength=n + 1
    )
    with np.errstate(invalid="ignore", divide="ignore"):
        columns["neighbor_count"] = neighbors[1:].astype("float64")
        columns["shared_boundary_total"] = shared[1:].astype("float64")
        columns["mean_shared_boundary"] = np.where(
            neighbors[1:] > 0, shared[1:] / np.maximum(neighbors[1:], 1), 0.0
        )

names = list(columns)
with open(os.path.join(out_dir, "features.csv"), "w", encoding="utf-8") as out:
    out.write(",".join(["segment_id", *names]) + "\n")
    for i in np.flatnonzero(present):
        cells = []
        for name in names:
            value = float(columns[name][i])
            cells.append("" if not np.isfinite(value) else format(value, ".10g"))
        out.write(f"{i + 1}," + ",".join(cells) + "\n")

result = {
    "object_count": int(present.sum()),
    "fields": names,
    "seconds": round(time.time() - started, 1),
}
print(f"Measured {len(names)} features for {int(present.sum())} objects", flush=True)
print("{marker}" + json.dumps(result))
"""
).replace("{marker}", _RESULT_MARKER)


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
_JOB_DIRS_LOCK = threading.Lock()
_BASE_DIR: str | None = None


def _base_dir() -> Path:
    """The private parent folder of the job folders, created on first use."""
    global _BASE_DIR
    if _BASE_DIR is None or not Path(_BASE_DIR).is_dir():
        _BASE_DIR = tempfile.mkdtemp(prefix="geolibre-obia-")
    return Path(_BASE_DIR)


def _new_job_dir() -> str:
    """A fresh private folder for one job, pruning old ones.

    Keeps the newest ``MAX_JOB_DIRS`` folders and any younger than a day, so a
    measure job can reuse its segmentation's labels without the folders
    growing without bound.

    Returns:
        The folder path.
    """
    base = _base_dir()
    # A pending or running job's folder is never pruned, however old.
    with _JOB_DIRS_LOCK:
        jobs = list(_JOB_DIRS.items())
    busy = {
        Path(folder)
        for job_id, folder in jobs
        if (state := _job_state(job_id)) is not None and state.status in {"pending", "running"}
    }
    folders = sorted(
        (p for p in base.iterdir() if p.is_dir() and p not in busy),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    cutoff = time.time() - JOB_DIR_MAX_AGE_SECS
    keep = MAX_JOB_DIRS - 1 - len(busy)
    for index, folder in enumerate(folders):
        if index >= keep or folder.stat().st_mtime < cutoff:
            shutil.rmtree(folder, ignore_errors=True)
    with _JOB_DIRS_LOCK:
        for job_id, folder in list(_JOB_DIRS.items()):
            if not Path(folder).is_dir():
                del _JOB_DIRS[job_id]
    return tempfile.mkdtemp(prefix="job-", dir=base)


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


def _start(tool_id: str, script: str, params: dict):
    try:
        _ensure_obia_runtime()
    except RuntimeBootstrapError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    out_dir = _new_job_dir()
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
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    with _JOB_DIRS_LOCK:
        _JOB_DIRS[job.id] = out_dir
    return job


# --- Endpoints ---------------------------------------------------------------


@router.get("/status")
def obia_status():
    """Report whether native segmentation is available (installing it if not)."""
    try:
        _ensure_obia_runtime()
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
    if request.segment_job_id:
        with _JOB_DIRS_LOCK:
            folder = _JOB_DIRS.get(request.segment_job_id)
        if folder:
            params["labels_path"] = str(Path(folder) / "segments.tif")
    return _start("obia-measure", _MEASURE_SCRIPT, params)


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
