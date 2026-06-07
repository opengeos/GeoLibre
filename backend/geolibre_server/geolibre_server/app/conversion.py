"""Format conversion sidecar endpoints (GeoParquet and Cloud Optimized GeoTIFF)."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .runtime import (
    RUNTIME_DISCOVERY_TIMEOUT_SECS,
    RUNTIME_SETUP_TIMEOUT_SECS,
    JobState,
    RuntimeBootstrapError,
    _clean_env,
    _runtime_cache_root,
    _runtime_setup_env,
    _subprocess_startup_kwargs,
    _utc_now,
    _uv_executable,
    _venv_python,
)

router = APIRouter(prefix="/conversion", tags=["conversion"])

CONVERSION_RUN_TIMEOUT_SECS = 3600
CONVERSION_PYTHON_VERSION = os.environ.get(
    "GEOLIBRE_CONVERSION_PYTHON_VERSION", "3.12"
)
CONVERSION_RUNTIME_PACKAGES = [
    package.strip()
    for package in os.environ.get(
        "GEOLIBRE_CONVERSION_PACKAGES",
        "duckdb>=1.1.0,rio-cogeo>=5.0.0",
    ).split(",")
    if package.strip()
]

VECTOR_COMPRESSIONS = {"zstd", "snappy", "gzip", "lz4", "uncompressed"}
DEFAULT_VECTOR_COMPRESSION = "zstd"
DEFAULT_ROW_GROUP_SIZE = 30000

COG_COMPRESSIONS = {"deflate", "zstd", "lzw", "webp", "jpeg", "packbits", "raw"}
DEFAULT_COG_COMPRESSION = "deflate"

_RESULT_MARKER = "__GEOLIBRE_CONVERSION_RESULT__"

_JOBS: dict[str, JobState] = {}
_JOBS_LOCK = threading.Lock()
_RUNTIME_SETUP_LOCK = threading.Lock()
MAX_RETAINED_JOBS = 100


class VectorToGeoParquetRequest(BaseModel):
    """Request body for a vector to GeoParquet conversion."""

    input_path: str
    output_path: str
    compression: str = DEFAULT_VECTOR_COMPRESSION
    row_group_size: int = DEFAULT_ROW_GROUP_SIZE


class RasterToCogRequest(BaseModel):
    """Request body for a raster to Cloud Optimized GeoTIFF conversion."""

    input_path: str
    output_path: str
    compression: str = DEFAULT_COG_COMPRESSION


# Hilbert-sorting the rows before writing produces spatially clustered row
# groups so range requests over the GeoParquet output stay local. The geometry
# column is rewritten from WKB when needed so ST_Hilbert and the GeoParquet
# writer both receive a GEOMETRY-typed column.
_VECTOR_SCRIPT = """
import json, sys

import duckdb

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
compression = params["compression"]
row_group_size = int(params["row_group_size"])

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")

if input_path.lower().endswith((".parquet", ".geoparquet")):
    relation = f"read_parquet({quote(input_path)})"
else:
    relation = f"ST_Read({quote(input_path)})"

columns = con.execute(f"DESCRIBE SELECT * FROM {relation}").fetchall()
# DuckDB Spatial reports CRS-annotated geometry types such as
# GEOMETRY('EPSG:4326'), so match on the prefix rather than equality.
def is_geometry_type(column_type):
    return str(column_type).upper().startswith("GEOMETRY")

geometry_column = None
geometry_is_native = True
for name, column_type, *_ in columns:
    if is_geometry_type(column_type):
        geometry_column = name
        break
if geometry_column is None:
    # Plain Parquet may carry geometry as a WKB blob; rebuild it as GEOMETRY.
    for name, column_type, *_ in columns:
        if name.lower() in {"geometry", "geom", "wkb_geometry"}:
            geometry_column, geometry_is_native = name, False
            break
if geometry_column is None:
    raise SystemExit("No geometry column found in the input dataset.")

quoted_geometry = '"' + geometry_column.replace('"', '""') + '"'
if geometry_is_native:
    source = f"SELECT * FROM {relation}"
else:
    source = (
        f"SELECT * REPLACE (ST_GeomFromWKB({quoted_geometry}) AS {quoted_geometry}) "
        f"FROM {relation}"
    )

print(f"Converting {input_path} -> {output_path} ({compression})")

# COPY returns the number of rows written, so the feature count comes for free
# rather than costing a second full scan of the dataset.
copy_result = con.execute(
    f\"\"\"
    COPY (
      WITH src AS ({source}),
      b AS (SELECT ST_Extent(ST_Extent_Agg({quoted_geometry})) AS box FROM src)
      SELECT * FROM src
      ORDER BY ST_Hilbert({quoted_geometry}, (SELECT box FROM b))
    ) TO {quote(output_path)}
    (FORMAT PARQUET, COMPRESSION {quote(compression)}, ROW_GROUP_SIZE {row_group_size});
    \"\"\"
).fetchone()
count = copy_result[0] if copy_result else None
print(f"Wrote {count} Hilbert-sorted features to {output_path}")
print(
    "{marker}"
    + json.dumps(
        {
            "feature_count": count,
            "geometry_column": geometry_column,
            "output_path": output_path,
        }
    )
)
""".replace("{marker}", _RESULT_MARKER)


_RASTER_SCRIPT = """
import json, sys

from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles

params = json.loads(sys.argv[1])
input_path = params["input_path"]
output_path = params["output_path"]
compression = params["compression"]

profile = cog_profiles.get(compression)
print(f"Converting {input_path} using the {compression} COG profile")
cog_translate(
    input_path,
    output_path,
    profile,
    in_memory=False,
    quiet=True,
    use_cog_driver=False,
)
valid, errors, warnings = cog_validate(output_path, quiet=True)
for message in warnings:
    print(f"Warning: {message}")
for message in errors:
    print(f"Error: {message}")
if not valid:
    raise SystemExit("Output failed COG validation: " + "; ".join(errors))
print(f"Wrote valid Cloud Optimized GeoTIFF to {output_path}")
print(
    "{marker}"
    + json.dumps({"valid": valid, "warnings": warnings, "output_path": output_path})
)
""".replace("{marker}", _RESULT_MARKER)


def _managed_runtime_dir() -> Path:
    """Return the managed conversion runtime environment directory."""
    configured = os.environ.get("GEOLIBRE_CONVERSION_ENV")
    if configured:
        return Path(configured).expanduser()
    return _runtime_cache_root() / "conversion-runtime"


def _check_runtime_import(python_executable: str) -> None:
    """Raise if a Python executable cannot import the conversion stack."""
    try:
        completed = subprocess.run(
            [python_executable, "-c", "import duckdb, rio_cogeo"],
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
            f"{python_executable}: import timed out after "
            f"{RUNTIME_DISCOVERY_TIMEOUT_SECS} seconds"
        ) from exc
    if completed.returncode != 0:
        detail = (
            completed.stderr.strip()
            or completed.stdout.strip()
            or "duckdb / rio-cogeo import failed"
        )
        raise RuntimeBootstrapError(f"{python_executable}: {detail}")


def _run_runtime_setup_command(command: list[str]) -> None:
    """Run a uv command used to create or update the conversion runtime."""
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_runtime_setup_env(),
        timeout=RUNTIME_SETUP_TIMEOUT_SECS,
        **_subprocess_startup_kwargs(),
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeBootstrapError(
            f"Conversion runtime setup failed while running {' '.join(command)}. {detail}"
        )


def _ensure_managed_runtime() -> str:
    """Create or update the managed conversion runtime and return its Python."""
    env_dir = _managed_runtime_dir()
    python = _venv_python(env_dir)
    with _RUNTIME_SETUP_LOCK:
        if python.exists():
            try:
                _check_runtime_import(str(python))
                return str(python)
            except RuntimeBootstrapError:
                pass

        uv = _uv_executable()
        env_dir.parent.mkdir(parents=True, exist_ok=True)
        if not python.exists():
            _run_runtime_setup_command(
                [uv, "venv", "--python", CONVERSION_PYTHON_VERSION, str(env_dir)]
            )
        _run_runtime_setup_command(
            [
                uv,
                "pip",
                "install",
                "--python",
                str(python),
                *CONVERSION_RUNTIME_PACKAGES,
            ]
        )
        _check_runtime_import(str(python))
        return str(python)


def _runtime_python() -> str:
    """Return the Python executable used for conversions."""
    configured = os.environ.get("GEOLIBRE_CONVERSION_PYTHON")
    if configured:
        resolved = str(Path(configured).expanduser())
        if os.path.isfile(resolved) and os.access(resolved, os.X_OK):
            _check_runtime_import(resolved)
            return resolved
        raise RuntimeBootstrapError(
            f"Configured conversion Python is not executable: {configured}"
        )
    return _ensure_managed_runtime()


def _validate_paths(input_path: str, output_path: str) -> tuple[str, str]:
    """Validate conversion input/output paths and return them normalized."""
    if not input_path.strip():
        raise HTTPException(status_code=400, detail="input_path is required")
    source = Path(input_path).expanduser()
    if not source.is_file():
        raise HTTPException(
            status_code=400, detail=f"Input file not found: {input_path}"
        )
    if not output_path.strip():
        raise HTTPException(status_code=400, detail="output_path is required")
    target = Path(output_path).expanduser()
    if not target.parent.is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"Output folder does not exist: {target.parent}",
        )
    return str(source), str(target)


def _job_update(job_id: str, **patch: Any) -> None:
    """Update an in-memory conversion job."""
    with _JOBS_LOCK:
        job = _JOBS[job_id]
        data = job.model_dump()
        data.update(patch)
        data["updated_at"] = _utc_now()
        _JOBS[job_id] = JobState(**data)


def _append_job_message(job_id: str, message: str) -> None:
    """Append a progress line to a job message log."""
    with _JOBS_LOCK:
        job = _JOBS[job_id]
        _JOBS[job_id] = job.model_copy(
            update={"messages": [*job.messages, message], "updated_at": _utc_now()}
        )


def _evict_finished_jobs_locked() -> None:
    """Drop the oldest finished jobs once the retention cap is exceeded.

    The caller must hold ``_JOBS_LOCK``. Running and pending jobs are never
    evicted; only ``succeeded``/``failed`` jobs are removed, oldest first.
    """
    excess = len(_JOBS) - MAX_RETAINED_JOBS
    if excess <= 0:
        return
    # Sort by creation time so the genuinely oldest finished jobs are evicted;
    # dict order is UUID-keyed insertion order, not chronological.
    finished = sorted(
        (
            (job.created_at, job_id)
            for job_id, job in _JOBS.items()
            if job.status in {"succeeded", "failed"}
        ),
    )
    for _created_at, job_id in finished[:excess]:
        _JOBS.pop(job_id, None)


def _run_conversion_job(
    job_id: str,
    script: str,
    params: dict[str, Any],
    output_name: str,
) -> None:
    """Run a conversion script in the managed runtime and record the result."""
    process: subprocess.Popen[str] | None = None
    timed_out = threading.Event()
    try:
        _job_update(job_id, status="running")
        python = _runtime_python()
        process = subprocess.Popen(
            [python, "-c", script, json.dumps(params)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_clean_env(),
            bufsize=1,
            **_subprocess_startup_kwargs(),
        )
        # A watchdog kills the subprocess if it exceeds the deadline. Reading
        # process.stdout blocks until the pipe closes, so without this a hung
        # DuckDB or cog_translate call (one that emits no further output) would
        # tie up this background thread indefinitely; process.wait()'s own
        # timeout cannot fire because the loop has already drained stdout.
        watchdog = threading.Timer(
            CONVERSION_RUN_TIMEOUT_SECS,
            lambda: (timed_out.set(), process.kill()),
        )
        watchdog.daemon = True
        watchdog.start()
        result: Any = None
        if process.stdout is None:
            raise RuntimeError("Conversion subprocess stdout is unexpectedly None")
        try:
            for line in process.stdout:
                line = line.rstrip("\r\n")
                if not line:
                    continue
                if line.startswith(_RESULT_MARKER):
                    try:
                        result = json.loads(line[len(_RESULT_MARKER) :])
                    except json.JSONDecodeError:
                        result = line[len(_RESULT_MARKER) :]
                else:
                    _append_job_message(job_id, line)
            returncode = process.wait()
        finally:
            watchdog.cancel()
        if timed_out.is_set():
            raise RuntimeError(
                f"Conversion timed out after {CONVERSION_RUN_TIMEOUT_SECS} seconds"
            )
        if returncode != 0:
            with _JOBS_LOCK:
                messages = list(_JOBS[job_id].messages)
            raise RuntimeError(
                messages[-1] if messages else f"Conversion exited with {returncode}"
            )
        _job_update(
            job_id,
            status="succeeded",
            result=result,
            outputs={output_name: {"path": params["output_path"]}},
        )
    except Exception as exc:
        _job_update(job_id, status="failed", error=str(exc))
    finally:
        # Guard against leaking a still-running subprocess if an exception is
        # raised before it exits (e.g. during streaming or a job-state update).
        if process is not None and process.poll() is None:
            process.kill()


def _start_job(
    tool_id: str,
    script: str,
    params: dict[str, Any],
    output_name: str,
) -> JobState:
    """Register a conversion job and run it in a background thread."""
    job_id = str(uuid.uuid4())
    now = _utc_now()
    with _JOBS_LOCK:
        _JOBS[job_id] = JobState(
            id=job_id,
            status="pending",
            tool_id=tool_id,
            created_at=now,
            updated_at=now,
        )
        _evict_finished_jobs_locked()
    thread = threading.Thread(
        target=_run_conversion_job,
        args=(job_id, script, params, output_name),
        daemon=True,
    )
    thread.start()
    with _JOBS_LOCK:
        return _JOBS[job_id]


@router.get("/status")
def conversion_status():
    """Return conversion runtime availability."""
    try:
        # Resolve the runtime to confirm availability, but do not return the
        # interpreter path — the frontend only needs available/message, and the
        # absolute path is needless filesystem recon for a caller.
        _runtime_python()
        return {
            "available": True,
            "message": "Conversion runtime (DuckDB + rio-cogeo) is available.",
        }
    except Exception as exc:
        return {"available": False, "message": str(exc)}


@router.post("/vector-to-geoparquet")
def vector_to_geoparquet(request: VectorToGeoParquetRequest):
    """Convert a vector dataset to a Hilbert-sorted, compressed GeoParquet."""
    compression = request.compression.strip().lower() or DEFAULT_VECTOR_COMPRESSION
    if compression not in VECTOR_COMPRESSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported Parquet compression: {request.compression}",
        )
    if request.row_group_size <= 0:
        raise HTTPException(
            status_code=400, detail="row_group_size must be a positive integer"
        )
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-geoparquet",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "compression": compression,
            "row_group_size": request.row_group_size,
        },
        "geoparquet",
    )


@router.post("/raster-to-cog")
def raster_to_cog(request: RasterToCogRequest):
    """Convert a raster dataset to a valid, compressed Cloud Optimized GeoTIFF."""
    compression = request.compression.strip().lower() or DEFAULT_COG_COMPRESSION
    if compression not in COG_COMPRESSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported COG compression: {request.compression}",
        )
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "raster-to-cog",
        _RASTER_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "compression": compression,
        },
        "cog",
    )


@router.get("/jobs/{job_id}")
def conversion_job(job_id: str):
    """Return state for a conversion background job."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job
