"""Format conversion sidecar endpoints (GeoParquet and Cloud Optimized GeoTIFF)."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geolibre_server.workers import (
    ERROR_MARKER as _ERROR_MARKER,
)
from geolibre_server.workers import (
    RESULT_MARKER as _RESULT_MARKER,
)
from geolibre_server.workers import (
    load_worker_source,
)

from .job_manager import JobManager
from .runtime import (
    RUNTIME_DISCOVERY_TIMEOUT_SECS,
    RUNTIME_SETUP_TIMEOUT_SECS,
    JobState,
    RuntimeBootstrapError,
    _clean_env,
    _runtime_cache_root,
    _runtime_setup_env,
    _subprocess_startup_kwargs,
    _uv_executable,
    _venv_python,
)
from .runtime import (
    _utc_now as _utc_now,
)

router = APIRouter(prefix="/conversion", tags=["conversion"])
logger = logging.getLogger(__name__)

CONVERSION_RUN_TIMEOUT_SECS = 3600
CONVERSION_PYTHON_VERSION = os.environ.get("GEOLIBRE_CONVERSION_PYTHON_VERSION", "3.12")
# Whitespace-separated so a single requirement may carry a comma-joined version
# range (e.g. "duckdb>=1.1.0,<2.0.0") without being split into two tokens.
# rasterio + numpy already arrive transitively via rio-cogeo; they are listed
# explicitly so the Raster processing tools' dependency is intentional, and
# contourpy is added for the Contour tool.
CONVERSION_RUNTIME_PACKAGES = os.environ.get(
    "GEOLIBRE_CONVERSION_PACKAGES",
    "duckdb>=1.1.0 rio-cogeo>=5.0.0 freestiler>=0.1.0 rasterio>=1.3.0 numpy>=1.24 contourpy>=1.2.0",
).split()

VECTOR_COMPRESSIONS = {"zstd", "snappy", "gzip", "lz4", "uncompressed"}
DEFAULT_VECTOR_COMPRESSION = "zstd"
DEFAULT_ROW_GROUP_SIZE = 30000

# Output extensions written through DuckDB's native Parquet writer (FORMAT
# PARQUET) rather than a GDAL driver.
PARQUET_OUTPUT_EXTENSIONS = {"parquet", "geoparquet"}

# Map an output file extension to the canonical GDAL driver that writes it. The
# *set* of usable drivers is not hardcoded here: the conversion script validates
# the chosen driver against ``ST_Drivers()`` at runtime, so whatever the
# installed DuckDB spatial build can create is supported. This map only resolves
# an extension to its driver name, since extensions and driver names differ.
VECTOR_OUTPUT_DRIVERS = {
    "geojson": "GeoJSON",
    "json": "GeoJSON",
    "geojsonl": "GeoJSONSeq",
    "geojsons": "GeoJSONSeq",
    "ndjson": "GeoJSONSeq",
    "fgb": "FlatGeobuf",
    "gpkg": "GPKG",
    "shp": "ESRI Shapefile",
    "zip": "ESRI Shapefile",
    "gml": "GML",
    "kml": "KML",
    "csv": "CSV",
    "sqlite": "SQLite",
    "db": "SQLite",
    "gmt": "OGR_GMT",
    "dxf": "DXF",
    "tab": "MapInfo File",
    "mif": "MapInfo File",
    "jml": "JML",
    "gpx": "GPX",
    # NOTE: directory-based formats (e.g. FileGDB `.gdb/`) are intentionally
    # excluded — `_validate_paths` treats inputs/outputs as files, and the
    # failure cleanup unlinks a single file, so a `.gdb` directory would break
    # both validation and cleanup. They need dedicated directory handling.
}


def _output_extension(path: str) -> str:
    """Return the lowercased file extension (without the dot) of a path."""
    name = Path(path).name
    index = name.rfind(".")
    return name[index + 1 :].lower() if index >= 0 else ""


COG_COMPRESSIONS = {"deflate", "zstd", "lzw", "webp", "jpeg", "packbits", "raw"}
DEFAULT_COG_COMPRESSION = "deflate"

# Conversion and raster scripts report input mistakes the user can act on with
# ``raise SystemExit("...")`` — curated text such as "Expression may not use
# Attribute ...", "Exponent may not exceed 64 ...", or "Raster B must match the
# dimensions of raster A". Every other failure surfaces as a traceback whose
# frames embed absolute interpreter and data paths that must not reach the
# browser-proxied /jobs/{id} response. Running each script through this driver
# keeps the two apart: a curated message is re-emitted on a marker line and can
# be shown verbatim, while anything else stays a generic failure. ``sys.argv``
# is untouched, so scripts still read their params from ``sys.argv[1]``.
_SCRIPT_DRIVER = """
import sys

try:
    exec(compile({source}, "<geolibre-conversion>", "exec"), {"__name__": "__main__"})
except SystemExit as exc:
    message = exc.code if isinstance(exc.code, str) else ""
    if not message:
        raise
    # Collapse to one line: the runner reads stdout line by line, and a
    # multi-line message would strand every line after the first as untagged
    # output that the failure handler then scrubs.
    print("{marker}" + " ".join(message.split()), flush=True)
    raise SystemExit(1) from None
""".replace("{marker}", _ERROR_MARKER)

# Optional allowlist of directories that conversion inputs/outputs must live
# under, set via GEOLIBRE_CONVERSION_ROOTS (os.pathsep-separated). Unset means
# no restriction (the default for the desktop app, where paths are the user's
# own filesystem). The bundled Docker image sets this so the sidecar — which is
# reachable same-origin through the nginx proxy — cannot read or overwrite
# arbitrary container paths.
_CONVERSION_ROOTS = [
    str(Path(root).expanduser().resolve())
    for root in os.environ.get("GEOLIBRE_CONVERSION_ROOTS", "").split(os.pathsep)
    if root.strip()
]

MAX_RETAINED_JOBS = 100
# Concurrent pending/running conversion (and raster) jobs. Finished jobs are
# retained up to MAX_RETAINED_JOBS; in-flight work is refused with HTTP 429 once
# this cap is hit so a burst of /run calls cannot spawn unbounded subprocesses.
MAX_IN_FLIGHT_JOBS = 8
MAX_JOB_MESSAGES = 500

_JOB_MANAGER = JobManager(
    busy_detail="Too many conversion jobs in progress; try again shortly.",
    max_retained=MAX_RETAINED_JOBS,
    max_in_flight=MAX_IN_FLIGHT_JOBS,
    max_messages=MAX_JOB_MESSAGES,
    get_jobs=lambda: _JOBS,
    get_max_retained=lambda: MAX_RETAINED_JOBS,
    get_max_in_flight=lambda: MAX_IN_FLIGHT_JOBS,
)
_JOBS: dict[str, JobState] = _JOB_MANAGER.jobs
_JOBS_LOCK = _JOB_MANAGER.lock
_PROCESSES: dict[str, subprocess.Popen[str]] = _JOB_MANAGER.processes
_CANCELLED: set[str] = _JOB_MANAGER.cancelled
_RUNTIME_SETUP_LOCK = threading.Lock()


class VectorToVectorRequest(BaseModel):
    """Request body for a generic vector-to-vector conversion.

    The input and output formats are inferred from the file extensions, so a
    single endpoint covers every vector format DuckDB's spatial extension can
    read and write — no per-format request type or hardcoded format list.

    ``input_layer`` selects one layer of a multi-layer dataset (a File
    Geodatabase or GeoPackage); ``target_srs`` reprojects the geometry to the
    given CRS (e.g. ``EPSG:4326``) before writing. ``source_srs`` declares the
    CRS to reproject *from* when set, overriding (or standing in for) the CRS
    the dataset itself declares — for layers whose spatial reference GDAL
    cannot resolve to an authority code.
    """

    input_path: str
    output_path: str
    input_layer: str | None = None
    target_srs: str | None = None
    source_srs: str | None = None


class VectorLayersRequest(BaseModel):
    """Request body for listing the layers of a multi-layer vector dataset."""

    input_path: str


class VectorToGeoParquetRequest(BaseModel):
    """Request body for a vector to GeoParquet conversion."""

    input_path: str
    output_path: str
    compression: str = DEFAULT_VECTOR_COMPRESSION
    row_group_size: int = DEFAULT_ROW_GROUP_SIZE


class VectorToFlatGeobufRequest(BaseModel):
    """Request body for a vector to FlatGeobuf conversion."""

    input_path: str
    output_path: str


class VectorToShapefileRequest(BaseModel):
    """Request body for a vector to zipped Shapefile conversion."""

    input_path: str
    output_path: str


class VectorToGeoPackageRequest(BaseModel):
    """Request body for a vector to GeoPackage conversion."""

    input_path: str
    output_path: str


class CsvToGeoParquetRequest(BaseModel):
    """Request body for a CSV (with lon/lat columns) to GeoParquet conversion."""

    input_path: str
    output_path: str
    lon_column: str
    lat_column: str
    compression: str = DEFAULT_VECTOR_COMPRESSION
    row_group_size: int = DEFAULT_ROW_GROUP_SIZE


class VectorToPmtilesRequest(BaseModel):
    """Request body for a vector to PMTiles conversion."""

    input_path: str
    output_path: str
    layer_name: str = "data"
    min_zoom: int = 0
    max_zoom: int = 14


class RasterToCogRequest(BaseModel):
    """Request body for a raster to Cloud Optimized GeoTIFF conversion."""

    input_path: str
    output_path: str
    compression: str = DEFAULT_COG_COMPRESSION


# Worker scripts live as real Python modules under ``geolibre_server.workers``
# so ruff, type checks, and pytest inspect them directly.
_VECTOR_SCRIPT = load_worker_source("conversion_vector")
_VECTOR_TO_VECTOR_SCRIPT = load_worker_source("conversion_vector_to_vector")
_VECTOR_LAYERS_SCRIPT = load_worker_source("conversion_vector_layers")
_PMTILES_SCRIPT = load_worker_source("conversion_pmtiles")
_RASTER_SCRIPT = load_worker_source("conversion_raster")


def _managed_runtime_dir() -> Path:
    """Return the managed conversion runtime environment directory."""
    configured = os.environ.get("GEOLIBRE_CONVERSION_ENV")
    if configured:
        return Path(configured).expanduser()
    return _runtime_cache_root() / "conversion-runtime"


def _check_runtime_import(python_executable: str) -> None:
    """Raise if a Python executable cannot import the core conversion stack.

    Only ``duckdb`` and ``rio_cogeo`` are required for the runtime to be
    "available" (both ship linux/arm64 wheels). ``freestiler`` powers PMTiles
    only and is checked when that job runs, so an arm64 container without it can
    still serve the GeoParquet/FlatGeobuf/COG conversions.
    """
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
            f"{python_executable}: import timed out after {RUNTIME_DISCOVERY_TIMEOUT_SECS} seconds"
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


_CHECKED_RUNTIME_PYTHON: str | None = None
_CHECKED_RUNTIME_PYTHON_LOCK = threading.Lock()


def _runtime_python() -> str:
    """Return the Python executable used for conversions.

    The import check spawns a subprocess, so the verified interpreter is cached
    to avoid that cost on every status poll and job start. Double-checked
    locking keeps concurrent cold-start callers (FastAPI runs sync handlers in
    a thread pool) from each spawning that subprocess.
    """
    global _CHECKED_RUNTIME_PYTHON
    cached = _CHECKED_RUNTIME_PYTHON
    # Drop a cached interpreter whose file has since disappeared (e.g. the
    # managed venv was wiped) so the next call re-bootstraps cleanly.
    if cached is not None and os.path.isfile(cached):
        return cached
    with _CHECKED_RUNTIME_PYTHON_LOCK:
        cached = _CHECKED_RUNTIME_PYTHON
        if cached is not None and os.path.isfile(cached):
            return cached
        _CHECKED_RUNTIME_PYTHON = None
        configured = os.environ.get("GEOLIBRE_CONVERSION_PYTHON")
        if configured:
            resolved = str(Path(configured).expanduser())
            if os.path.isfile(resolved) and os.access(resolved, os.X_OK):
                _check_runtime_import(resolved)
                _CHECKED_RUNTIME_PYTHON = resolved
                return resolved
            raise RuntimeBootstrapError(
                f"Configured conversion Python is not executable: {configured}"
            )
        resolved = _ensure_managed_runtime()
        _CHECKED_RUNTIME_PYTHON = resolved
        return resolved


def _is_within_roots(path: Path) -> bool:
    """Return whether a resolved path lives under an allowlisted root.

    Uses ``Path.is_relative_to`` so filesystem roots (``/``, a Windows drive)
    work — naive ``startswith(root + sep)`` would produce ``//`` and reject
    valid descendants.
    """
    if not _CONVERSION_ROOTS:
        return True
    resolved = path.resolve()
    return any(
        resolved == Path(root) or resolved.is_relative_to(root) for root in _CONVERSION_ROOTS
    )


def _validate_input_path(input_path: str) -> str:
    """Validate a conversion input path and return it resolved.

    Accepts a regular file or an Esri File Geodatabase, which is a directory
    with a ``.gdb`` suffix rather than a single file. Other directories are
    rejected — no other supported input format is directory-based.
    """
    if not input_path.strip():
        raise HTTPException(status_code=400, detail="input_path is required")
    source = Path(input_path).expanduser()
    # When an allowlist is configured, confine reads to those roots so a
    # same-origin caller cannot probe arbitrary files. Checked BEFORE the
    # existence test so out-of-root paths always get the same 403 — a 400/403
    # split would otherwise leak whether a path outside the sandbox exists.
    if not _is_within_roots(source):
        raise HTTPException(
            status_code=403,
            detail="Path is outside the allowed conversion directories",
        )
    is_gdb_directory = source.is_dir() and source.suffix.lower() == ".gdb"
    if not source.is_file() and not is_gdb_directory:
        raise HTTPException(status_code=400, detail=f"Input file not found: {input_path}")
    return str(source.resolve())


def _validate_paths(input_path: str, output_path: str) -> tuple[str, str]:
    """Validate conversion input/output paths and return them normalized."""
    resolved_input = _validate_input_path(input_path)
    source = Path(resolved_input)
    if not output_path.strip():
        raise HTTPException(status_code=400, detail="output_path is required")
    target = Path(output_path).expanduser()
    # The input was already confined by _validate_input_path; the output (and
    # the failure-cleanup unlink) must live under the same allowlisted roots.
    # Checked BEFORE the existence test for the same reason as the input: a
    # 400/403 split would leak whether a directory outside the sandbox exists.
    if not _is_within_roots(target):
        raise HTTPException(
            status_code=403,
            detail="Path is outside the allowed conversion directories",
        )
    if not target.parent.is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"Output folder does not exist: {target.parent}",
        )
    # Reading from and writing to the same file would truncate the input.
    if source.resolve() == target.resolve():
        raise HTTPException(
            status_code=400,
            detail="input_path and output_path must be different files",
        )
    # Return canonical paths so the subprocess and the failure-cleanup unlink
    # operate on the same resolved paths the allowlist check approved.
    return str(source.resolve()), str(target.resolve())


def _job_update(job_id: str, **patch: Any) -> None:
    """Update an in-memory conversion job."""
    _JOB_MANAGER.update(job_id, **patch)


def _append_job_message(job_id: str, message: str) -> None:
    """Append a progress line to a job message log."""
    _JOB_MANAGER.append_message(job_id, message)


def _is_cancelled(job_id: str) -> bool:
    """Return True if *job_id* has been marked for cancellation."""
    return _JOB_MANAGER.is_cancelled(job_id)


def _job_state(job_id: str) -> JobState | None:
    """Return a job's current state, or None when it is unknown."""
    return _JOB_MANAGER.get(job_id)


def _cancel_job(job_id: str) -> None:
    """Stop a pending or running job; it then reports ``cancelled``."""
    _JOB_MANAGER.cancel(job_id)


def _count_in_flight_jobs_locked() -> int:
    """Return how many jobs are pending or running. Caller must hold ``_JOBS_LOCK``."""
    return _JOB_MANAGER.count_in_flight_locked()


def _evict_finished_jobs_locked() -> None:
    """Drop the oldest finished jobs once the retention cap is exceeded."""
    _JOB_MANAGER.evict_finished_locked()


def _remove_partial_output(params: dict[str, Any]) -> None:
    """Remove a failed or cancelled job's partial output.

    So a retry starts clean and stale bytes do not confuse downstream tools.

    Args:
        params: The job's parameters (``output_path``, when it writes one).
    """
    output_path = params.get("output_path")
    if output_path:
        try:
            Path(output_path).unlink(missing_ok=True)
        except OSError:
            pass


def _run_conversion_job(
    job_id: str,
    script: str,
    params: dict[str, Any],
    output_name: str,
) -> None:
    """Run a conversion script in the managed runtime and record the result."""
    process: subprocess.Popen[str] | None = None
    timed_out = threading.Event()
    # Set from a marker line when the script rejects the user's input; see
    # _SCRIPT_DRIVER. Anything else stays a generic failure.
    validation_error: str | None = None
    # Failed or cancelled cleanup skips unlinking output_path when a file
    # already existed there before the job started, preventing cleanup from
    # deleting a user's existing file on pre-write failures (trade-off: if a tool
    # overwrote the file in place before failing, that partial write stays on disk).
    output_existed = bool(params.get("output_path")) and Path(params["output_path"]).exists()
    try:
        _job_update(job_id, status="running")
        python = _runtime_python()
        process = subprocess.Popen(
            [python, "-c", _SCRIPT_DRIVER.replace("{source}", repr(script)), json.dumps(params)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_clean_env(),
            bufsize=1,
            **_subprocess_startup_kwargs(),
        )
        cancelled_early = _JOB_MANAGER.register_process(job_id, process)
        if cancelled_early:
            process.kill()
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
                elif line.startswith(_ERROR_MARKER):
                    validation_error = line[len(_ERROR_MARKER) :]
                else:
                    _append_job_message(job_id, line)
            returncode = process.wait()
        finally:
            watchdog.cancel()
        if timed_out.is_set():
            raise RuntimeError(f"Conversion timed out after {CONVERSION_RUN_TIMEOUT_SECS} seconds")
        if _is_cancelled(job_id):
            _job_update(job_id, status="cancelled", error="Cancelled.", messages=[])
            if not output_existed:
                _remove_partial_output(params)
            return
        if returncode != 0:
            if validation_error:
                raise RuntimeError(validation_error)
            messages = _JOB_MANAGER.snapshot_messages(job_id)
            raise RuntimeError(messages[-1] if messages else f"Conversion exited with {returncode}")
        # Metadata-only jobs (layer listing) have no output file to report.
        output_path = params.get("output_path")
        _job_update(
            job_id,
            status="succeeded",
            result=result,
            outputs={output_name: {"path": output_path}} if output_path else {},
        )
    except Exception as exc:
        if _is_cancelled(job_id):
            _job_update(job_id, status="cancelled", error="Cancelled.", messages=[])
            if not output_existed:
                _remove_partial_output(params)
            return
        # Mirror Whitebox: log the raw failure server-side and surface only a
        # generic message. DuckDB/GDAL stderr often embeds absolute paths that
        # must not reach the browser-proxied /jobs/{id} response — including
        # via ``messages``, which accumulates every subprocess stdout line. The
        # exception is a curated validation message (see _SCRIPT_DRIVER): the
        # dialogs render ``error`` as the only failure feedback, so scrubbing
        # those too would leave a user who mistyped a band-math expression or
        # picked mismatched rasters with nothing actionable and no way to read
        # the sidecar log (desktop and Docker builds both hide it).
        leaked = _JOB_MANAGER.snapshot_messages(job_id)
        logger.warning(
            "Conversion job %s failed: %s; subprocess output=%r",
            job_id,
            exc,
            leaked,
            exc_info=True,
        )
        _job_update(
            job_id,
            status="failed",
            error=validation_error or "Conversion failed. See the sidecar logs for details.",
            messages=[],
        )
        if not output_existed:
            _remove_partial_output(params)
    finally:
        # Guard against leaking a still-running subprocess if an exception is
        # raised before it exits (e.g. during streaming or a job-state update).
        if process is not None and process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        _JOB_MANAGER.clear_process(job_id)


def _start_job(
    tool_id: str,
    script: str,
    params: dict[str, Any],
    output_name: str,
) -> JobState:
    """Register a conversion job and run it in a background thread."""
    return _JOB_MANAGER.start_thread_job(
        tool_id,
        _run_conversion_job,
        (script, params, output_name),
    )


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
    except RuntimeBootstrapError as exc:
        # Log the detailed bootstrap error server-side but return a stable
        # message rather than leaking local runtime/setup specifics.
        logger.warning("Conversion runtime unavailable: %s", exc)
        return {
            "available": False,
            "message": "Conversion runtime is unavailable. Check the sidecar logs.",
        }
    except Exception:
        logger.exception("Unexpected error while checking conversion runtime")
        return {
            "available": False,
            "message": "Conversion runtime status check failed.",
        }


@router.post("/vector-layers")
def vector_layers(request: VectorLayersRequest):
    """List the layers of a multi-layer vector dataset without reading features.

    Supports every input ``ST_Read`` understands, including a File Geodatabase
    (a ``.gdb`` directory or a zipped one). Returns a job whose result carries
    ``layers``: name, feature count, geometry type, and CRS per layer.

    The feature counts come from ``st_read_meta``, i.e. whatever the GDAL
    driver reports. FileGDB stores row counts in its catalog so the primary
    ``.gdb`` case is metadata-only, but a driver without a fast feature count
    (e.g. a GeoPackage with stale ``gpkg_ogr_contents``) may scan the layer to
    produce it, making this probe slower than "metadata-only" suggests.
    """
    input_path = _validate_input_path(request.input_path)
    return _start_job("vector-layers", _VECTOR_LAYERS_SCRIPT, {"input_path": input_path}, "layers")


@router.post("/vector-to-vector")
def vector_to_vector(request: VectorToVectorRequest):
    """Convert any vector format to another, inferring both from file extensions.

    The output format is resolved from the output file's extension: Parquet
    extensions use DuckDB's native writer, everything else maps to a GDAL driver
    validated against ``ST_Drivers()`` inside the job. Input format detection is
    handled entirely by ``ST_Read`` (or ``read_parquet``), so no input format
    needs to be declared.
    """
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    extension = _output_extension(output_path)
    if not extension:
        raise HTTPException(
            status_code=400,
            detail="Output path needs a file extension to select the format.",
        )

    if extension in PARQUET_OUTPUT_EXTENSIONS:
        params = {
            "input_path": input_path,
            "output_path": output_path,
            "output_kind": "parquet",
            "output_driver": "",
            "zip_shapefile": False,
            "input_layer": request.input_layer,
            "target_srs": request.target_srs,
            "source_srs": request.source_srs,
        }
        output_name = "geoparquet"
    else:
        driver = VECTOR_OUTPUT_DRIVERS.get(extension)
        if not driver:
            supported = ", ".join(sorted(set(VECTOR_OUTPUT_DRIVERS) | PARQUET_OUTPUT_EXTENSIONS))
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unsupported output extension '.{extension}'. "
                    f"Supported extensions: {supported}"
                ),
            )
        params = {
            "input_path": input_path,
            "output_path": output_path,
            "output_kind": "gdal",
            "output_driver": driver,
            # A .zip output is delivered as a zipped Shapefile bundle; a bare
            # .shp writes the .shp plus its sidecars in place.
            "zip_shapefile": extension == "zip",
            "input_layer": request.input_layer,
            "target_srs": request.target_srs,
            "source_srs": request.source_srs,
        }
        output_name = extension

    return _start_job("vector-to-vector", _VECTOR_TO_VECTOR_SCRIPT, params, output_name)


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
        raise HTTPException(status_code=400, detail="row_group_size must be a positive integer")
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-geoparquet",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "parquet",
            "source_kind": "auto",
            "compression": compression,
            "row_group_size": request.row_group_size,
        },
        "geoparquet",
    )


@router.post("/vector-to-flatgeobuf")
def vector_to_flatgeobuf(request: VectorToFlatGeobufRequest):
    """Convert a vector dataset to a Hilbert-sorted FlatGeobuf."""
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-flatgeobuf",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "flatgeobuf",
            "source_kind": "auto",
        },
        "flatgeobuf",
    )


@router.post("/vector-to-shapefile")
def vector_to_shapefile(request: VectorToShapefileRequest):
    """Convert a vector dataset to a Hilbert-sorted, zipped ESRI Shapefile."""
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-shapefile",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "shapefile",
            "source_kind": "auto",
        },
        "shapefile",
    )


@router.post("/vector-to-geopackage")
def vector_to_geopackage(request: VectorToGeoPackageRequest):
    """Convert a vector dataset to a Hilbert-sorted GeoPackage."""
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-geopackage",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "geopackage",
            "source_kind": "auto",
        },
        "geopackage",
    )


@router.post("/csv-to-geoparquet")
def csv_to_geoparquet(request: CsvToGeoParquetRequest):
    """Convert a CSV with lon/lat columns to a Hilbert-sorted GeoParquet."""
    compression = request.compression.strip().lower() or DEFAULT_VECTOR_COMPRESSION
    if compression not in VECTOR_COMPRESSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported Parquet compression: {request.compression}",
        )
    if request.row_group_size <= 0:
        raise HTTPException(status_code=400, detail="row_group_size must be a positive integer")
    if not request.lon_column.strip() or not request.lat_column.strip():
        raise HTTPException(status_code=400, detail="lon_column and lat_column are required")
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "csv-to-geoparquet",
        _VECTOR_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "output_format": "parquet",
            "source_kind": "csv",
            "lon_column": request.lon_column.strip(),
            "lat_column": request.lat_column.strip(),
            "compression": compression,
            "row_group_size": request.row_group_size,
        },
        "geoparquet",
    )


@router.post("/vector-to-pmtiles")
def vector_to_pmtiles(request: VectorToPmtilesRequest):
    """Convert a vector dataset to PMTiles vector tiles via freestiler."""
    if not 0 <= request.min_zoom <= request.max_zoom <= 24:
        raise HTTPException(
            status_code=400,
            detail="Zoom levels must satisfy 0 <= min_zoom <= max_zoom <= 24",
        )
    input_path, output_path = _validate_paths(request.input_path, request.output_path)
    return _start_job(
        "vector-to-pmtiles",
        _PMTILES_SCRIPT,
        {
            "input_path": input_path,
            "output_path": output_path,
            "layer_name": request.layer_name.strip() or "data",
            "min_zoom": request.min_zoom,
            "max_zoom": request.max_zoom,
        },
        "pmtiles",
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
