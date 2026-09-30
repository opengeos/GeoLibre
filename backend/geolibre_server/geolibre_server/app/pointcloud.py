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
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .conversion import (
    _RESULT_MARKER,
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


_APPLY_LABELS_SCRIPT = r"""
import base64, json, os, struct, sys, zlib

import laspy
import numpy as np

params = json.loads(sys.argv[1])
with open(params["payload_path"], encoding="utf-8") as f:
    payload = json.load(f)
os.unlink(params["payload_path"])
input_path = params["input_path"]
output_path = params["output_path"]

# The same caps as geolibre.project's reader: inflated bytes per node and in
# total, and decoded entries (each costs far more than its inflated bytes).
NODE_LIMIT = 16 * 1024 * 1024
budget = [256 * 1024 * 1024, 20_000_000]


def decode(text, wide):
    inflater = zlib.decompressobj(-15)
    limit = min(NODE_LIMIT, budget[0])
    data = inflater.decompress(base64.b64decode(text), limit + 1)
    budget[0] -= len(data)
    if len(data) > limit or inflater.unconsumed_tail:
        raise ValueError("label record too large")
    edits, previous, at = {}, -1, 0
    def varint(at, max_shift):
        value = shift = 0
        while True:
            if at >= len(data):
                raise ValueError("truncated label record")
            byte = data[at]; at += 1
            value += (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                return value, at
            if shift > max_shift:
                raise ValueError("varint too long")
    while at < len(data):
        delta, at = varint(at, 28)
        index = previous + 1 + delta
        previous = index
        if wide:
            value, at = varint(at, 28)
            if value > 0xFFFFFFFF:
                raise ValueError("instance id out of range")
        else:
            if at >= len(data):
                raise ValueError("truncated label record")
            value = data[at]; at += 1
        edits[index] = value
    if len(edits) > budget[1]:
        raise ValueError("too many label entries")
    budget[1] -= len(edits)
    return edits


def node_ranges(path, header):
    info = next(
        (v for v in header.vlrs if v.user_id.strip("\0").lower() == "copc" and v.record_id == 1),
        None,
    )
    total = int(header.point_count)
    if info is None:
        return [("file", 0, total)]
    if hasattr(info, "hierarchy_root_offset"):
        root = (info.hierarchy_root_offset, info.hierarchy_root_size)
    else:
        root = struct.unpack_from("<QQ", bytes(info.record_data), 40)
    entry = struct.Struct("<4iQii")
    nodes = []
    with open(path, "rb") as f:
        def page(offset, size, depth=0):
            if depth > 64:
                raise ValueError("COPC hierarchy too deep")
            f.seek(offset)
            raw = f.read(size)
            for at in range(0, len(raw) - entry.size + 1, entry.size):
                d, x, y, z, off, nbytes, count = entry.unpack_from(raw, at)
                if count == -1:
                    page(off, nbytes, depth + 1)
                elif count > 0:
                    nodes.append((off, f"{d}-{x}-{y}-{z}", count))
        page(*root)
    nodes.sort()
    out, start = [], 0
    for _, key, count in nodes:
        out.append((key, start, count))
        start += count
    if start != total:
        raise ValueError(f"COPC hierarchy holds {start} points but the header says {total}")
    return out


def flatten(encoded, ranges, wide):
    lookup = {key: (start, count) for key, start, count in ranges}
    idx, val = [], []
    for key, text in encoded.items():
        span = lookup.get(key)
        if span is None or not isinstance(text, str) or budget[0] <= 0 or budget[1] <= 0:
            continue
        cap = min(NODE_LIMIT, budget[0])
        before = budget[0]
        try:
            edits = decode(text, wide)
        except (ValueError, zlib.error) as error:
            # Skip one bad record, as the Python reader does, not the job, and
            # charge its full cap: bad records cannot bypass the budget.
            budget[0] = before - cap
            print(f"Skipped the labels of node {key}: {error}")
            continue
        for offset, value in edits.items():
            if 0 <= offset < span[1]:
                idx.append(span[0] + offset)
                val.append(value)
    order = np.argsort(np.asarray(idx, dtype=np.int64), kind="stable")
    return np.asarray(idx, dtype=np.int64)[order], np.asarray(val, dtype=np.int64)[order]


def not_copc(vlr):
    user = vlr.user_id.strip("\0").lower()
    return user not in ("copc", "laszip encoded")


with laspy.open(input_path) as reader:
    source = reader.header
    ranges = node_ranges(input_path, source)
    li, lv = flatten(payload.get("labels") or {}, ranges, False)
    ii, iv = flatten(payload.get("instances") or {}, ranges, True)
    total = int(source.point_count)
    print(f"Applying {len(li)} labels and {len(ii)} instance ids to {total} points")
    fmt = source.point_format.id
    if fmt < 6 and len(lv) and int(lv.max()) > 31:
        # LAS 1.4 format 6/7 for classes above 31, keeping the metadata, the
        # extra-bytes dimensions and the CRS (as WKT, which 6-10 require).
        header = laspy.LasHeader(point_format=7 if fmt in (2, 3, 5) else 6, version="1.4")
        header.scales = source.scales
        header.offsets = source.offsets
        for name in ("system_identifier", "generating_software", "creation_date"):
            try:
                setattr(header, name, getattr(source, name))
            except (AttributeError, ValueError):
                pass
        extra = [
            laspy.ExtraBytesParams(
                name=d.name,
                type=d.type_str() if callable(d.type_str) else d.type_str,
                description=d.description or "",
                offsets=d.offsets,
                scales=d.scales,
                no_data=d.no_data,
            )
            for d in source.point_format.extra_dimensions
        ]
        if extra:
            header.add_extra_dims(extra)
        try:
            crs = source.parse_crs()
        except Exception:
            crs = None
        geotiff = {34735, 34736, 34737}

        def keep(v):
            user = v.user_id.strip("\0")
            if not not_copc(v) or (user == "LASF_Spec" and v.record_id == 4):
                return False
            return not (crs is not None and user == "LASF_Projection" and v.record_id in geotiff)

        header.vlrs.extend(v for v in source.vlrs if keep(v))
        if crs is not None:
            header.add_crs(crs)
    else:
        import copy
        header = copy.deepcopy(source)
        header.vlrs = [v for v in header.vlrs if not_copc(v)]
        if getattr(header, "evlrs", None) is not None:
            header.evlrs = [v for v in header.evlrs if not_copc(v)]
    if len(ii) and "instance" not in header.point_format.dimension_names:
        header.add_extra_dims([
            laspy.ExtraBytesParams(
                name="instance", type=np.uint32, description="Object (instance) id, 0 = none"
            )
        ])
    written = 0
    with laspy.open(output_path, mode="w", header=header) as writer:
        for chunk in reader.chunk_iterator(1_000_000):
            n = len(chunk)
            points = laspy.ScaleAwarePointRecord.zeros(n, header=writer.header)
            names = set(points.point_format.dimension_names)
            for name in chunk.point_format.dimension_names:
                if name in names:
                    points[name] = chunk[name]
            if "scan_angle_rank" in chunk.point_format.dimension_names and "scan_angle" in names:
                rank = np.asarray(chunk["scan_angle_rank"], dtype=np.float64)
                points["scan_angle"] = np.round(rank / 0.006).astype(np.int16)
            end = written + n
            for index, value, name in ((li, lv, "classification"), (ii, iv, "instance")):
                if not len(index) or name not in names:
                    continue
                lo, hi = np.searchsorted(index, [written, end])
                if hi > lo:
                    column = np.asarray(points[name]).copy()
                    column[index[lo:hi] - written] = value[lo:hi]
                    points[name] = column
            writer.write_points(points)
            written = end
            print(f"Wrote {written} points")

result = {
    "output_path": output_path,
    "points": written,
    "relabelled": int(len(li)),
    "instanced": int(len(ii)),
}
print("{marker}" + json.dumps(result))
""".replace("{marker}", _RESULT_MARKER)


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
    handle, payload_path = tempfile.mkstemp(prefix="geolibre-labels-", suffix=".json")
    with os.fdopen(handle, "w", encoding="utf-8") as payload:
        json.dump({"labels": request.labels, "instances": request.instances}, payload)
    params = {"input_path": input_path, "output_path": output_path, "payload_path": payload_path}
    try:
        return _start_job("pointcloud-apply-labels", _APPLY_LABELS_SCRIPT, params, "point cloud")
    except BaseException:
        # A job that never starts never reads (and removes) the payload.
        Path(payload_path).unlink(missing_ok=True)
        raise
