"""Raster processing sidecar endpoints (rasterio / numpy / contourpy).

QGIS-inspired raster tools that run on the managed conversion runtime with a
file path in and a file path out, mirroring the ``/conversion`` jobs. They reuse
the conversion job store and background runner, so the client polls results with
the same ``GET /conversion/jobs/{id}`` endpoint.

rasterio and numpy already ship in the managed runtime (pulled in transitively
by ``rio-cogeo``); ``contourpy`` is added for the Contour tool. When the runtime
cannot be resolved, ``/raster/status`` reports ``available: false`` and the
desktop app disables the Run button.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# These helpers are reused as-is from the conversion module so raster jobs share
# the same job store, runtime, and path-allowlist behavior. They are treated as a
# stable internal interface; a future refactor could lift them into a shared
# `_job_helpers` module.
from geolibre_server.workers import load_worker_source

from .conversion import (
    _is_within_roots,
    _runtime_python,
    _start_job,
    _validate_paths,
)
from .runtime import (
    RUNTIME_DISCOVERY_TIMEOUT_SECS,
    RuntimeBootstrapError,
    _clean_env,
    _subprocess_startup_kwargs,
)

router = APIRouter(prefix="/raster", tags=["raster"])
logger = logging.getLogger(__name__)


class RasterToolRequest(BaseModel):
    tool_id: str
    input_path: str
    output_path: str
    parameters: dict[str, Any] = {}


# --- Worker modules --------------------------------------------------------
#
# Each raster tool runs from a real Python module under
# ``geolibre_server.workers.raster_tools`` instead of an inline string literal.

_RASTER_TOOL_MODULES: dict[str, str] = {
    "hillshade": "raster_tools.hillshade",
    "slope": "raster_tools.slope",
    "aspect": "raster_tools.aspect",
    "reproject": "raster_tools.reproject",
    "resample": "raster_tools.resample",
    "clip-extent": "raster_tools.clip_extent",
    "clip-mask": "raster_tools.clip_mask",
    "polygonize": "raster_tools.polygonize",
    "contour": "raster_tools.contour",
    "interpolate": "raster_tools.interpolate",
    "zonal": "raster_tools.zonal_stats",
    "raster-calc": "raster_tools.raster_calc",
    # Spectral indices (NDVI, NDWI, ...) reuse the raster calculator worker.
    "spectral-index": "raster_tools.raster_calc",
    "reclassify": "raster_tools.reclassify",
    "mosaic": "raster_tools.mosaic",
    "focal": "raster_tools.focal",
}

_RASTER_TOOL_SCRIPTS: dict[str, str] = {
    tool_id: load_worker_source(module_name)
    for tool_id, module_name in _RASTER_TOOL_MODULES.items()
}

# Output kind per tool, used only as the key under ``JobState.outputs``.
_OUTPUT_NAMES: dict[str, str] = {
    "polygonize": "vector",
    "contour": "vector",
    "zonal": "vector",
}

_GEOJSON_EXTS = {".geojson", ".json"}
_GEOTIFF_EXTS = {".tif", ".tiff"}

# Secondary file-path parameters per tool, validated (path + allowlist +
# extension) before the job starts. Each entry is
# ``(param_name, label, allowed_extensions, required)``; an empty optional value
# is passed through to the script as ``""``.
_EXTRA_INPUTS: dict[str, list[tuple[str, str, set[str], bool]]] = {
    "clip-mask": [("mask_path", "Mask layer", _GEOJSON_EXTS, True)],
    "zonal": [("zones_path", "Zones layer", _GEOJSON_EXTS, True)],
    "raster-calc": [
        ("b_path", "Raster B", _GEOTIFF_EXTS, False),
        ("c_path", "Raster C", _GEOTIFF_EXTS, False),
    ],
    # Spectral index is single-input in the UI (the compiled expression only
    # references A<n> bands), but it reuses _RASTER_CALC_SCRIPT, which opens
    # b_path/c_path whenever they are present in the request. These entries are a
    # defense-in-depth guard: a hand-crafted request to the local sidecar that
    # smuggles in b_path/c_path still has those paths checked against the
    # allowlist/extensions, rather than opened unvalidated. Not multi-raster.
    "spectral-index": [
        ("b_path", "Raster B", _GEOTIFF_EXTS, False),
        ("c_path", "Raster C", _GEOTIFF_EXTS, False),
    ],
    "mosaic": [
        ("raster_2", "Second raster", _GEOTIFF_EXTS, True),
        ("raster_3", "Third raster", _GEOTIFF_EXTS, False),
        ("raster_4", "Fourth raster", _GEOTIFF_EXTS, False),
        ("raster_5", "Fifth raster", _GEOTIFF_EXTS, False),
    ],
}


def _validate_extra_input(path: str, label: str, allowed_extensions: set[str] | None = None) -> str:
    """Validate a secondary input file path (e.g. a clip mask)."""
    if not path.strip():
        raise HTTPException(status_code=400, detail=f"{label} is required")
    source = Path(path).expanduser()
    resolved = source.resolve()
    # Confine to allowed roots BEFORE probing existence so callers cannot use
    # 400 vs 403 as a filesystem existence oracle, and check extensions on the
    # resolved path so symlinks cannot bypass the format filter.
    if not _is_within_roots(resolved):
        raise HTTPException(
            status_code=403,
            detail="Path is outside the allowed conversion directories",
        )
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail=f"{label} not found: {path}")
    if allowed_extensions and resolved.suffix.lower() not in allowed_extensions:
        # Catch a wrong file type here with a clear 400 rather than letting
        # json.load fail inside the job with an opaque error.
        raise HTTPException(
            status_code=400,
            detail=(
                f"{label} must be one of {sorted(allowed_extensions)}, got '{resolved.suffix}'"
            ),
        )
    return str(resolved)


def _check_raster_import(python_executable: str) -> None:
    """Raise if the runtime cannot import the raster processing stack."""
    try:
        completed = subprocess.run(
            [python_executable, "-c", "import rasterio, numpy, contourpy"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_clean_env(),
            timeout=RUNTIME_DISCOVERY_TIMEOUT_SECS,
            **_subprocess_startup_kwargs(),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeBootstrapError(
            f"{python_executable}: import timed out after {RUNTIME_DISCOVERY_TIMEOUT_SECS} seconds"
        ) from exc
    if completed.returncode != 0:
        detail = (
            completed.stderr.strip()
            or completed.stdout.strip()
            or "rasterio / contourpy import failed"
        )
        raise RuntimeBootstrapError(f"{python_executable}: {detail}")


@router.get("/status")
def raster_status():
    """Return raster (rasterio + contourpy) runtime availability."""
    try:
        python = _runtime_python()
        _check_raster_import(python)
        return {
            "available": True,
            "message": "Raster runtime (rasterio + contourpy) is available.",
        }
    except RuntimeBootstrapError as exc:
        logger.warning("Raster runtime unavailable: %s", exc)
        return {
            "available": False,
            "message": "Raster runtime is unavailable. Check the sidecar logs.",
        }
    except Exception:
        logger.exception("Unexpected error while checking raster runtime")
        return {
            "available": False,
            "message": "Raster runtime status check failed.",
        }


@router.post("/run")
def raster_run(request: RasterToolRequest):
    """Run a single raster processing tool as a background job.

    Reuses the conversion job store and runner, so the result is polled via
    ``GET /conversion/jobs/{job_id}``.
    """
    script = _RASTER_TOOL_SCRIPTS.get(request.tool_id)
    if script is None:
        raise HTTPException(status_code=400, detail=f"Unknown raster tool: {request.tool_id}")

    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    params: dict[str, Any] = {
        **request.parameters,
        "input_path": input_path,
        "output_path": output_path,
    }

    # Validate any secondary file-path parameters (clip mask, zonal zones,
    # raster-calc operands, mosaic inputs) against the path allowlist and the
    # expected extension. An empty optional value is passed through as "".
    for name, label, exts, required in _EXTRA_INPUTS.get(request.tool_id, []):
        raw = str(request.parameters.get(name, "") or "").strip()
        if not raw:
            if required:
                raise HTTPException(status_code=400, detail=f"{label} is required")
            params[name] = ""
            continue
        params[name] = _validate_extra_input(raw, label, allowed_extensions=exts)

    # Interpolation reads a point GeoJSON (every other raster tool takes a
    # GeoTIFF). Reject a non-JSON primary input here with a clear 400 instead of
    # letting json.load fail with an opaque JSONDecodeError inside the job.
    if request.tool_id == "interpolate" and Path(input_path).suffix.lower() not in {
        ".geojson",
        ".json",
    }:
        raise HTTPException(
            status_code=400,
            detail="Interpolation input must be a GeoJSON (.geojson/.json) file",
        )

    output_name = _OUTPUT_NAMES.get(request.tool_id, "raster")
    return _start_job(request.tool_id, script, params, output_name)
