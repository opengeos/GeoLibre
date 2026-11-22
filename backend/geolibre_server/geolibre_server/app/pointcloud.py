"""Point cloud label rewrites (laspy + lazrs) for the point cloud annotator.

The annotator saves labels in the project keyed by each point's source node (a
COPC octree key, or ``"file"`` for a LAS/LAZ loaded whole) and its index in
that node. The browser can only export the points a session has loaded; this
endpoint writes a *whole* local LAS/LAZ/COPC file with those labels applied,
streaming chunk by chunk so files larger than memory work.

The job runs on the managed conversion runtime like the raster tools, and
``laspy[lazrs]`` is installed into it on first use (the optional
``pointcloud`` extra of this package lists the same requirement). The script
mirrors ``geolibre.pointcloud`` in the Python package, which cannot be
imported by the runtime; both are tested against the app's encoding.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geolibre_server.workers import load_worker_source

from .conversion import (
    _RUNTIME_SETUP_LOCK,
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

router = APIRouter(prefix="/pointcloud", tags=["pointcloud"])
logger = logging.getLogger(__name__)

POINTCLOUD_PACKAGES = os.environ.get(
    "GEOLIBRE_POINTCLOUD_PACKAGES", "laspy[lazrs]>=2.5 numpy>=1.24"
).split()
_POINTCLOUD_EXTENSIONS = {".las", ".laz"}


class ApplyLabelsRequest(BaseModel):
    """A labelled rewrite of one point cloud file."""

    input_path: str
    output_path: str
    # The annotator's saved labels for this source: node key -> base64 edits.
    labels: dict[str, str] = {}
    # Its instance ids, same layout with varint values.
    instances: dict[str, str] = {}


_APPLY_LABELS_SCRIPT = load_worker_source("pointcloud_apply_labels")


def _check_pointcloud_import(python: str) -> bool:
    """Whether the runtime can import laspy with a LAZ backend.

    Args:
        python: The runtime interpreter.

    Returns:
        True when ``laspy`` and ``lazrs`` import.
    """
    try:
        completed = subprocess.run(
            [python, "-c", "import laspy, lazrs, numpy"],
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


def _ensure_pointcloud_runtime() -> str:
    """Return the runtime Python, installing laspy[lazrs] into it if missing.

    Returns:
        The runtime interpreter path.

    Raises:
        RuntimeBootstrapError: When the runtime or the install is unavailable.
    """
    python = _runtime_python()
    if _check_pointcloud_import(python):
        return python
    # The conversion runtime's own setup lock: this install mutates the same
    # venv its bootstrap creates and repopulates.
    with _RUNTIME_SETUP_LOCK:
        if _check_pointcloud_import(python):
            return python
        # Local import: runtime.py owns uv discovery for every router.
        from .runtime import _uv_executable

        completed = subprocess.run(
            [_uv_executable(), "pip", "install", "--python", python, *POINTCLOUD_PACKAGES],
            check=False,
            capture_output=True,
            text=True,
            env=_clean_env(),
            timeout=600,
            **_subprocess_startup_kwargs(),
        )
        if completed.returncode != 0 or not _check_pointcloud_import(python):
            detail = (completed.stderr or completed.stdout or "").strip()[-500:]
            raise RuntimeBootstrapError(f"Could not install point cloud support: {detail}")
    return python


PAYLOAD_MAX_AGE_SECS = 3600
_PRIVATE_PAYLOAD_DIR: str | None = None


def _payload_dir() -> str:
    """The folder for job label payloads, cleared of stale ones.

    A job removes its payload as soon as it starts; one that never got that
    far (killed, or its runtime broke) would leave the file behind, so files
    older than an hour are removed whenever a new job is prepared.

    Returns:
        The folder path.
    """
    global _PRIVATE_PAYLOAD_DIR
    folder = Path(tempfile.gettempdir()) / "geolibre-pointcloud-payloads"
    folder.mkdir(mode=0o700, exist_ok=True)
    # A folder another user pre-created (or can write to) in a shared temp
    # directory could have a payload swapped before the job reads it; use a
    # fresh private folder instead.
    info = folder.stat()
    if hasattr(os, "getuid") and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        if _PRIVATE_PAYLOAD_DIR is None or not Path(_PRIVATE_PAYLOAD_DIR).is_dir():
            _PRIVATE_PAYLOAD_DIR = tempfile.mkdtemp(prefix="geolibre-pointcloud-")
        folder = Path(_PRIVATE_PAYLOAD_DIR)
    cutoff = time.time() - PAYLOAD_MAX_AGE_SECS
    for stale in folder.glob("labels-*.json"):
        try:
            if stale.stat().st_mtime < cutoff:
                stale.unlink()
        except OSError:
            pass
    return str(folder)


@router.get("/status")
def pointcloud_status():
    """Report whether labelled point cloud rewrites are available."""
    try:
        _ensure_pointcloud_runtime()
        return {"available": True, "message": "Point cloud runtime (laspy + lazrs) is available."}
    except RuntimeBootstrapError as exc:
        logger.warning("Point cloud runtime unavailable: %s", exc)
        return {
            "available": False,
            "message": "Point cloud runtime is unavailable. Check the sidecar logs.",
        }
    except Exception:
        logger.exception("Unexpected error while checking the point cloud runtime")
        return {"available": False, "message": "Point cloud runtime status check failed."}


@router.post("/apply-labels")
def pointcloud_apply_labels(request: ApplyLabelsRequest):
    """Write a LAS/LAZ/COPC file with the annotator's labels applied.

    Runs as a background job on the conversion runtime; poll it with
    ``GET /conversion/jobs/{job_id}``.
    """
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    for path, label in ((input_path, "input"), (output_path, "output")):
        if Path(path).suffix.lower() not in _POINTCLOUD_EXTENSIONS:
            raise HTTPException(status_code=400, detail=f"The {label} must be a .las or .laz file")
    try:
        _ensure_pointcloud_runtime()
    except RuntimeBootstrapError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # Labels can run to megabytes, past the per-argument limit of a command
    # line, so the job reads them from a private temporary file.
    payload_dir = _payload_dir()
    handle, payload_path = tempfile.mkstemp(prefix="labels-", suffix=".json", dir=payload_dir)
    with os.fdopen(handle, "w", encoding="utf-8") as payload:
        json.dump({"labels": request.labels, "instances": request.instances}, payload)
    params = {"input_path": input_path, "output_path": output_path, "payload_path": payload_path}
    try:
        return _start_job("pointcloud-apply-labels", _APPLY_LABELS_SCRIPT, params, "point cloud")
    except BaseException:
        # A job that never starts never reads (and removes) the payload.
        Path(payload_path).unlink(missing_ok=True)
        raise
