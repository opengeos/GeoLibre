"""Whitebox Next Gen sidecar endpoints."""

from __future__ import annotations

import base64
import contextlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import conversion
from .runtime import (
    RUNTIME_CATALOG_TIMEOUT_SECS,
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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/whitebox", tags=["whitebox"])
WHITEBOX_RUNTIME_PACKAGE = os.environ.get(
    "GEOLIBRE_WHITEBOX_PACKAGE",
    "whitebox-workflows>=2.0.2",
)
WHITEBOX_PYTHON_VERSION = os.environ.get("GEOLIBRE_WHITEBOX_PYTHON_VERSION", "3.12")


def _whitebox_run_timeout_secs() -> int:
    """Return the wall-clock timeout for a single Whitebox tool run.

    Reads ``GEOLIBRE_WHITEBOX_RUN_TIMEOUT_SECS`` so deployments can tune the
    cap for unusually long jobs; falls back to one hour when unset or invalid.
    """
    raw = os.environ.get("GEOLIBRE_WHITEBOX_RUN_TIMEOUT_SECS")
    if raw:
        try:
            value = int(raw)
            if value > 0:
                return value
        except ValueError:
            pass
    return 3600


def _try_kill(process: subprocess.Popen) -> None:
    """Kill a subprocess, ignoring the error if it has already exited.

    ``Popen.kill`` raises ``ProcessLookupError`` (a subclass of ``OSError``) on
    some platforms when the child is already gone. Swallowing it keeps the
    watchdog Timer callback from leaking an unhandled traceback to stderr.
    """
    with contextlib.suppress(OSError):
        process.kill()


class WhiteboxRunRequest(BaseModel):
    """Request body for a Whitebox tool run."""

    tool_id: str
    parameters: dict[str, Any] = {}
    tool: dict[str, Any] | None = None
    layer_inputs: dict[str, dict[str, Any]] = {}
    include_pro: bool = False
    tier: str = "open"


_JOBS: dict[str, JobState] = {}
_JOBS_LOCK = threading.Lock()
_RUNTIME_SETUP_LOCK = threading.Lock()
MAX_RETAINED_JOBS = 100


def _check_python_import(python_executable: str) -> None:
    """Raise if a Python executable cannot import ``whitebox_workflows``."""
    try:
        completed = subprocess.run(
            [
                python_executable,
                "-c",
                "import whitebox_workflows as wbw; print(getattr(wbw, '__version__', 'unknown'))",
            ],
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
            or "whitebox_workflows import failed"
        )
        raise RuntimeBootstrapError(f"{python_executable}: {detail}")


def _explicit_runtime_python() -> str | None:
    """Return an explicitly configured Whitebox Python executable."""
    path = os.environ.get("WBW_EXTERNAL_PYTHON") or os.environ.get("WBW_PYTHON")
    if not path:
        return None
    resolved = str(Path(path).expanduser())
    if os.path.isfile(resolved) and os.access(resolved, os.X_OK):
        return resolved
    raise RuntimeBootstrapError(f"Configured Whitebox Python is not executable: {path}")


def _managed_runtime_dir() -> Path:
    """Return the managed Whitebox runtime environment directory."""
    configured = os.environ.get("GEOLIBRE_WHITEBOX_ENV")
    if configured:
        return Path(configured).expanduser()
    return _runtime_cache_root() / "whitebox-runtime"


def _run_runtime_setup_command(command: list[str]) -> None:
    """Run a uv command used to create or update the managed runtime."""
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
            f"Whitebox runtime setup failed while running {' '.join(command)}. {detail}"
        )


def _ensure_managed_runtime() -> str:
    """Create or update the managed Whitebox runtime and return its Python."""
    env_dir = _managed_runtime_dir()
    python = _venv_python(env_dir)
    with _RUNTIME_SETUP_LOCK:
        if python.exists():
            try:
                _check_python_import(str(python))
                return str(python)
            except RuntimeBootstrapError:
                pass

        uv = _uv_executable()
        env_dir.parent.mkdir(parents=True, exist_ok=True)
        if not python.exists():
            _run_runtime_setup_command(
                [
                    uv,
                    "venv",
                    "--python",
                    WHITEBOX_PYTHON_VERSION,
                    str(env_dir),
                ]
            )
        _run_runtime_setup_command(
            [uv, "pip", "install", "--python", str(python), WHITEBOX_RUNTIME_PACKAGE]
        )
        _check_python_import(str(python))
        return str(python)


def _runtime_python() -> tuple[str, bool]:
    """Return the Python executable used for Whitebox and whether it is managed."""
    explicit = _explicit_runtime_python()
    if explicit:
        _check_python_import(explicit)
        return explicit, False
    return _ensure_managed_runtime(), True


def _runtime_import_status() -> tuple[str, str]:
    """Return the Whitebox Python executable and availability message."""
    python, managed = _runtime_python()
    if managed:
        return python, "Managed Whitebox runtime is available."
    return python, "Configured Whitebox runtime is available."


def _runtime_session_factory_script() -> str:
    """Return Python source that constructs a Whitebox runtime session."""
    return (
        "import os\n"
        "def _env_first(*names):\n"
        "    for name in names:\n"
        "        value=os.environ.get(name)\n"
        "        if value not in (None, ''):\n"
        "            return str(value)\n"
        "    return ''\n"
        "def _make_session(wbw, include_pro, tier):\n"
        "    if hasattr(wbw, 'RuntimeSession'):\n"
        "        return wbw.RuntimeSession(include_pro=include_pro, tier=tier)\n"
        "    return None\n"
    )


class ExternalRuntimeSession:
    """Whitebox runtime accessed through a Python subprocess."""

    def __init__(self, python_executable: str, include_pro: bool, tier: str):
        """Initialize the subprocess-backed session descriptor.

        Args:
            python_executable: Python executable that can import Whitebox.
            include_pro: Whether Pro tools should be requested.
            tier: Requested Whitebox runtime tier.
        """
        self.python_executable = python_executable
        self.include_pro = bool(include_pro)
        self.tier = str(tier or "open")

    def _invoke(
        self,
        method: str,
        timeout: int = RUNTIME_CATALOG_TIMEOUT_SECS,
        **kwargs: Any,
    ) -> str:
        """Invoke a JSON-oriented Whitebox runtime method."""
        payload = {
            "method": method,
            "include_pro": self.include_pro,
            "tier": self.tier,
            **kwargs,
        }
        runner = (
            "import json, sys\n"
            "try:\n"
            "    sys.stdout.reconfigure(encoding='utf-8')\n"
            "except Exception:\n"
            "    pass\n"
        )
        runner += _runtime_session_factory_script()
        runner += (
            "import whitebox_workflows as wbw\n"
            "p=json.loads(sys.argv[1])\n"
            "include_pro=bool(p.get('include_pro', False)); tier=str(p.get('tier','open'))\n"
            "m=p.get('method')\n"
            "if hasattr(wbw, 'RuntimeSession'):\n"
            "    s=_make_session(wbw, include_pro, tier)\n"
            "    if m=='capabilities': out=s.get_runtime_capabilities_json()\n"
            "    elif m=='catalog': out=s.list_tool_catalog_json()\n"
            "    elif m=='metadata': out=s.get_tool_metadata_json(str(p.get('tool_id','')))\n"
            "    else: raise RuntimeError('unknown method')\n"
            "else:\n"
            "    if m=='capabilities': out=wbw.get_runtime_capabilities_json_with_options(include_pro, tier)\n"
            "    elif m=='catalog': out=wbw.list_tool_catalog_json_with_options(include_pro, tier)\n"
            "    elif m=='metadata': out=wbw.get_tool_metadata_json_with_options(str(p.get('tool_id','')), include_pro, tier)\n"
            "    else: raise RuntimeError('unknown method')\n"
            "sys.stdout.write(out if isinstance(out, str) else json.dumps(out))\n"
        )
        try:
            completed = subprocess.run(
                [self.python_executable, "-c", runner, json.dumps(payload)],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=_clean_env(),
                timeout=timeout,
                **_subprocess_startup_kwargs(),
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeBootstrapError(
                f"{self.python_executable}: Whitebox runtime probe timed out "
                f"after {timeout} seconds"
            ) from exc
        if completed.returncode != 0:
            detail = (
                completed.stderr.strip()
                or completed.stdout.strip()
                or "unknown runtime error"
            )
            raise RuntimeBootstrapError(f"{self.python_executable}: {detail}")
        return completed.stdout

    def get_runtime_capabilities_json(self) -> str:
        """Return Whitebox runtime capability metadata."""
        return self._invoke("capabilities")

    def list_tool_catalog_json(self) -> str:
        """Return the Whitebox tool catalog as JSON text."""
        return self._invoke("catalog")

    def get_tool_metadata_json(self, tool_id: str) -> str:
        """Return metadata for one Whitebox tool as JSON text."""
        return self._invoke("metadata", tool_id=tool_id)

    def run_tool_json_stream(
        self,
        tool_id: str,
        args_json: str,
        callback: Callable[[Any], None] | None = None,
        working_directory: str | None = None,
    ) -> str:
        """Run a Whitebox tool and stream progress events to a callback."""
        payload = {
            "include_pro": self.include_pro,
            "tier": self.tier,
            "tool_id": tool_id,
            "args_json": args_json,
        }
        runner = (
            "import base64, json, sys, traceback\n"
            "try:\n"
            "    sys.stdout.reconfigure(encoding='utf-8')\n"
            "except Exception:\n"
            "    pass\n"
        )
        runner += _runtime_session_factory_script()
        runner += (
            "import whitebox_workflows as wbw\n"
            "p=json.loads(sys.argv[1])\n"
            "def emit(evt):\n"
            "    txt=evt if isinstance(evt,str) else json.dumps(evt)\n"
            "    sys.stdout.write('__WBW_EVENT__'+base64.b64encode(txt.encode()).decode()+'\\n'); sys.stdout.flush()\n"
            "include_pro=bool(p.get('include_pro', False)); tier=str(p.get('tier','open'))\n"
            "tool_id=str(p.get('tool_id','')); args_json=str(p.get('args_json','{}'))\n"
            "try:\n"
            "    if hasattr(wbw, 'RuntimeSession'):\n"
            "        s=_make_session(wbw, include_pro, tier)\n"
            "        method=getattr(s, 'run_tool_json_stream', None)\n"
            "        if callable(method): out=method(tool_id, args_json, emit)\n"
            "        else: out=s.run_tool_json_with_progress(tool_id, args_json)\n"
            "    elif hasattr(wbw, 'run_tool_json_stream_options'):\n"
            "        out=wbw.run_tool_json_stream_options(tool_id, args_json, emit, include_pro, tier)\n"
            "    else:\n"
            "        out=wbw.run_tool_json_with_progress_options(tool_id, args_json, include_pro, tier)\n"
            "    txt=out if isinstance(out,str) else json.dumps(out)\n"
            "    sys.stdout.write('__WBW_RESULT__'+base64.b64encode(txt.encode()).decode()+'\\n')\n"
            "except Exception:\n"
            "    sys.stdout.write('__WBW_ERROR__'+base64.b64encode(traceback.format_exc().encode()).decode()+'\\n')\n"
        )
        completed_result = ""
        errors: list[str] = []
        timeout = _whitebox_run_timeout_secs()
        timed_out = threading.Event()
        process = subprocess.Popen(
            [self.python_executable, "-c", runner, json.dumps(payload)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_clean_env(),
            cwd=working_directory,
            bufsize=1,
            **_subprocess_startup_kwargs(),
        )

        def _on_timeout() -> None:
            # Only flag a timeout if the process is still running: this avoids a
            # false "timed out" when the timer fires in the narrow window after
            # the process already exited (cleanly or with its own error) but
            # before watchdog.cancel() runs. Gating on liveness is correct on
            # every platform, unlike inspecting the sign of the exit code.
            if process.poll() is None:
                timed_out.set()
                _try_kill(process)

        # Drain stderr in a background thread: a subprocess that fills the
        # stderr pipe buffer (~64 KB on Linux) while we are blocked reading
        # stdout would otherwise deadlock both ends until the watchdog fires.
        stderr_chunks: list[str] = []

        def _drain_stderr() -> None:
            if process.stderr is not None:
                # Keep only a bounded prefix for the one-line error message, then
                # drain and discard the rest so a tool that floods stderr can't
                # balloon sidecar memory (and the pipe never fills).
                stderr_chunks.append(process.stderr.read(8192))
                process.stderr.read()

        try:
            if process.stdout is None:
                raise RuntimeBootstrapError(
                    "Whitebox subprocess stdout is unexpectedly None"
                )
            stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
            stderr_thread.start()
            # A watchdog kills the subprocess if it exceeds the deadline.
            # ``for line in process.stdout`` blocks until the pipe closes, so a
            # Whitebox tool that hangs without emitting further output would
            # otherwise tie up this worker thread (and leak a child process)
            # indefinitely; process.wait()'s own timeout cannot fire because the
            # loop has already drained stdout.
            watchdog = threading.Timer(timeout, _on_timeout)
            watchdog.daemon = True
            watchdog.start()
            try:
                for line in process.stdout:
                    line = line.rstrip("\r\n")
                    if line.startswith("__WBW_EVENT__"):
                        if callback:
                            callback(
                                base64.b64decode(
                                    line[len("__WBW_EVENT__") :]
                                ).decode("utf-8", "replace")
                            )
                    elif line.startswith("__WBW_RESULT__"):
                        completed_result = base64.b64decode(
                            line[len("__WBW_RESULT__") :]
                        ).decode("utf-8", "replace")
                    elif line.startswith("__WBW_ERROR__"):
                        errors.append(
                            base64.b64decode(
                                line[len("__WBW_ERROR__") :]
                            ).decode("utf-8", "replace")
                        )
                rc = process.wait()
            finally:
                watchdog.cancel()
                # Join here (not after the block) so the drain thread is always
                # awaited even when the stdout loop raises — the bounded timeout
                # keeps it from blocking before the outer finally kills the
                # process on the callback-exception path.
                stderr_thread.join(timeout=5)
            stderr = (stderr_chunks[0] if stderr_chunks else "").strip()
            # ``timed_out`` is only set when the watchdog killed a still-running
            # process (see _on_timeout), so a set flag reliably means a genuine
            # timeout regardless of the resulting exit code.
            if timed_out.is_set():
                raise RuntimeBootstrapError(
                    f"Whitebox tool run timed out after {timeout} seconds"
                )
            if rc != 0 or errors:
                raise RuntimeBootstrapError(
                    "\n".join(errors)
                    or stderr
                    or "Whitebox runtime execution failed"
                )
            return completed_result or "{}"
        finally:
            # Guard against leaking a still-running subprocess if an exception
            # is raised before it exits (e.g. a callback error mid-stream).
            # Reap the child after killing so it doesn't linger as a zombie.
            if process.poll() is None:
                _try_kill(process)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass


def create_runtime_session(include_pro: bool = False, tier: str = "open"):
    """Create a Whitebox runtime session lazily."""
    python, _managed = _runtime_python()
    return ExternalRuntimeSession(
        python,
        include_pro=include_pro,
        tier=tier,
    )


def _catalog_from_payload(payload: Any) -> list[dict[str, Any]]:
    """Extract a catalog list from a Whitebox JSON payload."""
    if isinstance(payload, str):
        payload = json.loads(payload)
    catalog = payload.get("tools", []) if isinstance(payload, dict) else payload
    if not isinstance(catalog, list):
        return []
    return [item for item in catalog if isinstance(item, dict)]


def _humanize_tool_id(tool_id: str) -> str:
    """Return a human-readable label for a Whitebox tool id."""
    text = re.sub(r"[_\-]+", " ", str(tool_id or "").strip())
    return " ".join(part.capitalize() for part in text.split()) or "Tool"


def _clean_params(params: Any) -> list[dict[str, Any]]:
    """Normalize params and drop values the toolbox UI cannot represent."""
    if not isinstance(params, list):
        return []
    cleaned: list[dict[str, Any]] = []
    for param in params:
        if not isinstance(param, dict):
            continue
        name = str(param.get("name", "")).strip()
        if name in {"args", "kwargs", "*args", "**kwargs"} or name.startswith("*"):
            continue
        cleaned.append(_normalize_param(param))
    return cleaned


def _normalize_param(param: dict[str, Any]) -> dict[str, Any]:
    """Normalize one Whitebox parameter for the frontend schema."""
    fixed = dict(param)
    fixed.setdefault("description", "")
    fixed.setdefault("required", False)
    fixed["kind"] = str(fixed.get("kind") or _infer_param_kind(fixed) or "string")
    fixed.setdefault("type", str(fixed.get("data_kind") or fixed["kind"]))
    options = _param_options(fixed)
    if options:
        fixed["options"] = options
    return fixed


def _infer_param_kind(param: dict[str, Any]) -> str:
    """Infer a GeoLibre parameter kind from Whitebox runtime metadata."""
    schema = param.get("schema")
    schema = schema if isinstance(schema, dict) else {}
    dataset = schema.get("dataset")
    dataset = dataset if isinstance(dataset, dict) else {}
    data_kind = str(
        param.get("data_kind") or dataset.get("kind") or param.get("type") or ""
    ).lower()
    role = str(param.get("io_role") or schema.get("kind") or "").lower()
    scalar = str(schema.get("scalar") or "").lower()

    if role == "output":
        return _dataset_param_kind(data_kind, "out")
    if role == "input":
        return _dataset_param_kind(data_kind, "in")
    if data_kind == "bool" or schema.get("kind") == "bool":
        return "bool"
    if schema.get("kind") == "enum" or _param_options(param):
        return "enum"
    if data_kind == "number" or schema.get("kind") == "scalar":
        if scalar in {"int", "integer", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64"}:
            return "int"
        return "double"
    return "string"


def _dataset_param_kind(data_kind: str, suffix: str) -> str:
    """Return a dataset parameter kind with the requested in/out suffix."""
    if data_kind in {"raster", "vector", "lidar", "file"}:
        return f"{data_kind}_{suffix}"
    return f"file_{suffix}"


def _param_options(param: dict[str, Any]) -> list[str]:
    """Return enum option values from runtime metadata."""
    raw_options = param.get("options")
    if not raw_options:
        schema = param.get("schema")
        if isinstance(schema, dict):
            raw_options = schema.get("options")
    if not isinstance(raw_options, list):
        return []
    options: list[str] = []
    for option in raw_options:
        if isinstance(option, dict):
            value = option.get("value")
        else:
            value = option
        if value is not None:
            options.append(str(value))
    return options


def _normalize_catalog_item(item: dict[str, Any]) -> dict[str, Any]:
    """Normalize a Whitebox tool manifest for the GeoLibre frontend."""
    fixed = dict(item)
    tool_id = str(fixed.get("id", "")).strip()
    fixed.setdefault("display_name", _humanize_tool_id(tool_id))
    fixed.setdefault("summary", "")
    fixed.setdefault("category", "General")
    tier = str(fixed.get("license_tier_name") or fixed.get("license_tier") or "open")
    fixed["license_tier"] = tier.lower()
    fixed["locked"] = bool(
        fixed.get("locked", False) or not fixed.get("available", True)
    )
    fixed["params"] = _clean_params(fixed.get("params", []))
    fixed.setdefault("defaults", {})
    return fixed


def _load_catalog(include_pro: bool = False, tier: str = "open") -> list[dict[str, Any]]:
    """Load the live Whitebox tool catalog."""
    session = create_runtime_session(include_pro=include_pro, tier=tier)
    return [
        _normalize_catalog_item(item)
        for item in _catalog_from_payload(session.list_tool_catalog_json())
    ]


def _parse_json_maybe(value: str) -> Any:
    """Parse a JSON string when possible, otherwise return the original text."""
    try:
        return json.loads(value)
    except Exception:
        return value


def _output_extension(kind: str) -> str:
    """Return the default file extension for a Whitebox parameter kind."""
    return {
        "raster_out": ".tif",
        "vector_out": ".geojson",
        "lidar_out": ".laz",
        "file_out": ".txt",
    }.get(kind, "")


def _safe_output_stem(tool_id: str, parameter_name: str) -> str:
    """Return a filesystem-safe output stem."""
    stem = f"{tool_id}_{parameter_name}".strip("_") or "whitebox_output"
    return re.sub(r"[^A-Za-z0-9_]+", "_", stem).strip("_") or "whitebox_output"


def _default_output_path(tool_id: str, parameter_name: str, kind: str) -> str:
    """Return a temporary output path for a Whitebox output parameter."""
    ext = _output_extension(kind)
    folder = Path(tempfile.gettempdir()) / "geolibre-whitebox"
    folder.mkdir(parents=True, exist_ok=True)
    unique = uuid.uuid4().hex[:8]
    stem = _safe_output_stem(tool_id, parameter_name)
    return str(folder / f"{stem}_{unique}{ext}")


def _coerce_value(value: Any, kind: str) -> Any:
    """Coerce a frontend parameter value using its Whitebox kind."""
    if value in {None, ""}:
        return None
    if kind == "bool":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"true", "1", "yes", "y", "on"}
    if kind == "int":
        return int(float(value))
    if kind == "double":
        return float(value)
    return value


# Catalog wording that marks a dataset input as batch-capable. Whitebox tool
# descriptions read "... If omitted, runs in batch mode over all ... files in
# current directory." If a catalog release rephrases this, directory values
# fall through to normal argument coercion instead of enabling batch mode.
_BATCH_DESCRIPTION_PHRASES = ("batch mode", "current directory", "omitted")


def _is_batch_directory_input(param: dict[str, Any]) -> bool:
    """Return whether a parameter supports directory-backed batch mode.

    Args:
        param: Normalized Whitebox parameter metadata.

    Returns:
        True when the parameter is an input dataset that the catalog documents
        as batch-capable when omitted.
    """
    kind = str(param.get("kind") or "")
    description = str(param.get("description") or "").lower()
    return kind.endswith("_in") and all(
        phrase in description for phrase in _BATCH_DESCRIPTION_PHRASES
    )


def _batch_working_directory(value: Any, param: dict[str, Any]) -> str | None:
    """Return the working directory for a batch-mode input value.

    Args:
        value: Frontend parameter value.
        param: Normalized Whitebox parameter metadata.

    Returns:
        The normalized directory path when the value should trigger batch
        mode, otherwise None.
    """
    if not _is_batch_directory_input(param) or not isinstance(value, str):
        return None
    path = Path(value).expanduser()
    # Require an absolute, non-symlinked directory (matching the symlink
    # policy of whitebox_output) and normalize it so the single-directory
    # comparison in _prepare_arguments is not defeated by lexical variants
    # such as /data/./a.
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        return None
    return str(path.resolve())


def _write_layer_input(param_name: str, layer: dict[str, Any], temp_paths: list[Path]) -> str:
    """Write an embedded layer input to a temporary file.

    Args:
        param_name: Parameter name that receives the temporary file path.
        layer: Layer payload from the frontend.
        temp_paths: Collection of temporary paths to remove after execution.

    Returns:
        Path to the materialized input file.
    """
    geojson = layer.get("geojson")
    if not isinstance(geojson, dict):
        raise ValueError(f"Layer input for {param_name} does not contain GeoJSON.")
    folder = Path(tempfile.mkdtemp(prefix="geolibre-whitebox-input-"))
    temp_paths.append(folder)
    path = folder / f"{_safe_output_stem('input', param_name)}.geojson"
    path.write_text(json.dumps(geojson), encoding="utf-8")
    return str(path)


def _ensure_within_roots(path_value: str) -> None:
    """Reject a Whitebox path argument that escapes the configured roots.

    No-op when ``GEOLIBRE_CONVERSION_ROOTS`` is unset (the desktop default,
    where paths are the user's own filesystem). When it is set (the Docker/web
    build, whose sidecar is reachable same-origin through the nginx proxy),
    attacker-supplied ``*_in``/``*_out`` paths and batch directories are confined
    to those roots so ``/whitebox/run`` cannot read or overwrite arbitrary
    container files — the same confinement the conversion and raster routers
    already enforce via :func:`_is_within_roots`.

    Args:
        path_value: A path string taken from the run request parameters.

    Raises:
        HTTPException: 403 when a root allowlist is configured and the resolved
            path lies outside every allowlisted root.
    """
    # _is_within_roots returns True when no allowlist is configured, so this is a
    # no-op on desktop and only confines paths in the Docker/web build.
    try:
        within_roots = conversion._is_within_roots(Path(path_value).expanduser())
    except ValueError as error:
        # e.g. an embedded NUL byte makes Path.resolve() raise; reject with a 403
        # rather than letting it surface as an uncaught 500.
        raise HTTPException(status_code=403, detail=f"Invalid path: {error}") from error
    if not within_roots:
        raise HTTPException(
            status_code=403,
            detail="Path is outside the allowed processing directories",
        )


def _looks_like_fs_path(value: str) -> bool:
    """Whether a parameter value looks like a filesystem path that could escape.

    A value is "escape-shaped" when it is absolute (POSIX ``/…`` or a Windows
    drive ``C:\\…``) or contains a ``..`` parent-traversal segment. Relative
    paths without ``..`` stay under the working directory and cannot reach
    outside the roots, and plain scalar strings (numbers, enums, CRS codes) are
    ignored. This lets the sandbox check key off the *value shape* rather than
    the client-declared ``kind`` — ``request.tool`` is free-form and untrusted,
    so a caller could mislabel a path parameter's ``kind`` to skip a kind-based
    check while still passing a real path Whitebox will act on.

    Args:
        value: A raw string parameter value from the run request.

    Returns:
        True when the value should be confined to the allowlisted roots.
    """
    text = value.strip()
    if not text:
        return False
    if text.startswith(("/", "\\")):
        return True
    if len(text) >= 2 and text[1] == ":" and text[0].isascii() and text[0].isalpha():
        return True
    return ".." in text.replace("\\", "/").split("/")


def _pinned_working_directory(absolute_paths: list[str]) -> str:
    """Choose the root to pin the non-batch subprocess cwd to.

    Prefer the allowlisted root that already contains one of the run's
    (validated) absolute path arguments, so a relative path argument resolves
    alongside them; fall back to the first configured root. Without this, a
    multi-root ``GEOLIBRE_CONVERSION_ROOTS`` deployment would resolve every
    relative path against root #0 regardless of which root the run's files live
    under.

    Args:
        absolute_paths: Validated absolute path arguments seen in this run.

    Returns:
        An allowlisted root directory to use as the subprocess cwd.
    """
    for path in absolute_paths:
        resolved = Path(path).expanduser().resolve()
        for root in conversion._CONVERSION_ROOTS:
            if resolved == Path(root) or resolved.is_relative_to(root):
                return root
    return conversion._CONVERSION_ROOTS[0]


def _prepare_arguments(
    request: WhiteboxRunRequest,
    temp_paths: list[Path],
) -> tuple[dict[str, Any], str | None]:
    """Prepare a Whitebox JSON argument payload from a run request.

    Args:
        request: Tool run request from the frontend.
        temp_paths: Collection of temporary paths to remove after execution.

    Returns:
        A tuple containing the argument payload and an optional subprocess
        working directory for directory-backed batch tools.
    """
    specs = {
        str(param.get("name")): param
        for param in (request.tool or {}).get("params", [])
        if isinstance(param, dict)
    }
    args: dict[str, Any] = {}
    working_directory: str | None = None
    absolute_paths: list[str] = []
    for name, value in request.parameters.items():
        spec = specs.get(str(name), {})
        kind = str(spec.get("kind") or "")
        if name in request.layer_inputs:
            # Embedded layers are materialized to a server-owned temp file, so
            # the caller never controls this path.
            value = _write_layer_input(name, request.layer_inputs[name], temp_paths)
        elif isinstance(value, str) and _looks_like_fs_path(value):
            # A path-shaped value must stay inside the allowlisted roots,
            # regardless of the client-declared `kind`. `request.tool` is
            # untrusted free-form input, so keying off `kind.endswith("_in"/"_out")`
            # could be bypassed by mislabelling a path parameter; validate by the
            # value's shape instead.
            _ensure_within_roots(value)
            # Remember absolute path args so the cwd pin can target the root they
            # live under in a multi-root deployment.
            if Path(value).expanduser().is_absolute():
                absolute_paths.append(value)
        batch_directory = _batch_working_directory(value, spec)
        if batch_directory:
            _ensure_within_roots(batch_directory)
            if working_directory and working_directory != batch_directory:
                raise ValueError("Only one Whitebox batch input directory is supported.")
            working_directory = batch_directory
            continue
        coerced = _coerce_value(value, kind)
        if coerced is not None:
            args[name] = coerced

    for name, spec in specs.items():
        kind = str(spec.get("kind") or "")
        if kind.endswith("_out") and not args.get(name) and not working_directory:
            args[name] = _default_output_path(request.tool_id, name, kind)

    # When a root allowlist is configured and this is not a batch run, pin the
    # subprocess working directory to an allowlisted root. Whitebox resolves a
    # *relative* path argument (e.g. "out.tif" — not "escape-shaped", so it skips
    # _ensure_within_roots) against its cwd; without this that cwd is the
    # sidecar's own (WORKDIR /app in the Docker image), letting a relative value
    # read or write outside GEOLIBRE_CONVERSION_ROOTS. Pinning cwd to a root
    # keeps relative paths inside the sandbox. Set after default outputs are
    # generated so their `not working_directory` condition still holds. The root
    # is chosen from the run's absolute paths (so multi-root deployments resolve
    # relative paths under the right root), falling back to the first root.
    if working_directory is None and conversion._CONVERSION_ROOTS:
        working_directory = _pinned_working_directory(absolute_paths)

    # Defense in depth: the cwd pin above confines a plain relative arg, but if an
    # allowlisted root contains a symlink pointing outside it, a relative value
    # could still traverse out. Resolve every relative, separator-bearing arg
    # against the pinned working directory (Path.resolve follows symlinks) and
    # reject anything that lands outside the roots. Absolute / `..` values were
    # already validated in the loop above via _ensure_within_roots.
    if working_directory is not None and conversion._CONVERSION_ROOTS:
        base = Path(working_directory)
        for value in args.values():
            # Every non-absolute string arg — including a bare filename like
            # "pwned.tif", which could itself be a symlink planted at the root —
            # is resolved against the pinned cwd and checked. Absolute / `..`
            # values were already validated in the loop above.
            if isinstance(value, str) and not Path(value).is_absolute():
                _ensure_within_roots(str(base / value))
    return args, working_directory


def _extract_outputs(result: Any, args: dict[str, Any], tool: dict[str, Any] | None) -> dict[str, Any]:
    """Extract output paths from runtime result JSON and output parameters."""
    outputs: dict[str, Any] = {}
    output_param_names: set[str] = set()
    for param in (tool or {}).get("params", []):
        if not isinstance(param, dict):
            continue
        name = str(param.get("name") or "")
        if name and str(param.get("kind") or "").endswith("_out"):
            output_param_names.add(name)

    if isinstance(result, dict):
        raw_outputs = result.get("outputs")
        if isinstance(raw_outputs, dict):
            for name, value in raw_outputs.items():
                if not output_param_names or name in output_param_names:
                    outputs[str(name)] = value
        elif not output_param_names:
            outputs.update(result)

    for param in (tool or {}).get("params", []):
        if not isinstance(param, dict):
            continue
        name = str(param.get("name") or "")
        if str(param.get("kind") or "").endswith("_out") and name in args:
            outputs.setdefault(name, {"path": args[name]})
    return outputs


def _job_update(job_id: str, **patch: Any) -> None:
    """Update an in-memory Whitebox job."""
    with _JOBS_LOCK:
        job = _JOBS[job_id]
        data = job.model_dump()
        data.update(patch)
        data["updated_at"] = _utc_now()
        _JOBS[job_id] = JobState(**data)


def _append_job_message(job_id: str, event: Any) -> None:
    """Append a runtime event to a job message log."""
    parsed = _parse_json_maybe(event) if isinstance(event, str) else event
    if isinstance(parsed, dict):
        message = parsed.get("message") or parsed.get("type") or json.dumps(parsed)
    else:
        message = str(parsed)
    with _JOBS_LOCK:
        job = _JOBS[job_id]
        messages = [*job.messages, message]
        _JOBS[job_id] = job.model_copy(
            update={"messages": messages, "updated_at": _utc_now()}
        )


def _run_job(job_id: str, request: WhiteboxRunRequest) -> None:
    """Run a Whitebox job in a background thread."""
    temp_paths: list[Path] = []
    try:
        _job_update(job_id, status="running")
        args, working_directory = _prepare_arguments(request, temp_paths)
        session = create_runtime_session(
            include_pro=request.include_pro,
            tier=request.tier or "open",
        )
        raw_result = session.run_tool_json_stream(
            request.tool_id,
            json.dumps(args),
            lambda event: _append_job_message(job_id, event),
            working_directory=working_directory,
        )
        result = _parse_json_maybe(raw_result)
        _job_update(
            job_id,
            status="succeeded",
            result=result,
            outputs=_extract_outputs(result, args, request.tool),
        )
    except Exception:
        # The exception (a RuntimeBootstrapError) carries the subprocess's full
        # traceback and interpreter path; log it server-side and surface only a
        # generic message so /run and /jobs/{id} don't leak internals to clients
        # (the sidecar is proxied to the browser build). Streamed progress
        # messages are preserved untouched. Matches /status, /tools, /tools/{id}.
        logger.warning("Whitebox job %s failed", job_id, exc_info=True)
        _job_update(
            job_id,
            status="failed",
            error="Tool execution failed. See the sidecar logs for details.",
        )
    finally:
        for path in temp_paths:
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)


@router.get("/status")
def whitebox_status():
    """Return Whitebox runtime availability."""
    try:
        python, message = _runtime_import_status()
        return {
            "available": True,
            "message": message,
            "capabilities": None,
            "python": python,
        }
    except Exception:
        logger.warning("Whitebox runtime unavailable", exc_info=True)
        return {
            "available": False,
            "message": "Whitebox runtime is unavailable",
            "capabilities": None,
            "python": None,
        }


@router.get("/tools")
def whitebox_tools(include_pro: bool = False, tier: str = "open"):
    """Return the Whitebox toolbox catalog."""
    try:
        tools = _load_catalog(include_pro=include_pro, tier=tier)
    except Exception as exc:
        logger.warning("Failed to load Whitebox tool catalog", exc_info=True)
        raise HTTPException(
            status_code=503, detail="Whitebox tool catalog is unavailable"
        ) from exc
    return {"tools": tools, "tool_count": len(tools)}


@router.get("/tools/{tool_id}")
def whitebox_tool(tool_id: str, include_pro: bool = False, tier: str = "open"):
    """Return metadata for one Whitebox tool."""
    try:
        session = create_runtime_session(include_pro=include_pro, tier=tier)
        metadata = _parse_json_maybe(session.get_tool_metadata_json(tool_id))
    except Exception as exc:
        logger.warning(
            "Failed to load metadata for Whitebox tool %s", tool_id, exc_info=True
        )
        raise HTTPException(
            status_code=503, detail="Whitebox tool metadata is unavailable"
        ) from exc
    return metadata


def _evict_finished_jobs_locked() -> None:
    """Drop the oldest finished jobs once the retention cap is exceeded.

    The caller must hold ``_JOBS_LOCK``. Running and pending jobs are never
    evicted; only ``succeeded``/``failed`` jobs are removed, oldest first.
    """
    excess = len(_JOBS) - MAX_RETAINED_JOBS
    if excess <= 0:
        return
    finished = [
        job_id
        for job_id, job in _JOBS.items()
        if job.status in {"succeeded", "failed"}
    ]
    for job_id in finished[:excess]:
        _JOBS.pop(job_id, None)


@router.post("/run")
def whitebox_run(request: WhiteboxRunRequest):
    """Start a background Whitebox tool run."""
    tool_id = request.tool_id.strip()
    if not tool_id:
        raise HTTPException(status_code=400, detail="tool_id is required")
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
    thread = threading.Thread(target=_run_job, args=(job_id, request), daemon=True)
    thread.start()
    with _JOBS_LOCK:
        return _JOBS[job_id]


@router.get("/jobs/{job_id}")
def whitebox_job(job_id: str):
    """Return state for a Whitebox background job."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _normalize_output_path(path: str) -> str:
    """Return an absolute, lexically normalized path without following symlinks.

    Symlinks are deliberately not resolved: resolving them would let a symlink
    that points at an allowlisted target masquerade as that target during the
    /output allowlist check. Lexical normalization still collapses ``..`` and
    redundant separators so the comparison is robust.
    """
    expanded = os.path.expanduser(path)
    return os.path.normpath(os.path.abspath(expanded))


def _known_output_paths() -> set[str]:
    """Return the set of output paths produced by recorded jobs."""
    paths: set[str] = set()
    with _JOBS_LOCK:
        jobs = list(_JOBS.values())
    for job in jobs:
        for value in job.outputs.values():
            candidate = value.get("path") if isinstance(value, dict) else value
            if isinstance(candidate, str) and candidate.strip():
                try:
                    paths.add(_normalize_output_path(candidate))
                except OSError:
                    continue
    return paths


def _read_text_no_symlink(output_path: str) -> str:
    """Read a file's text while rejecting a symlinked final path component.

    The path must be the literal (unresolved) output path so that opening with
    ``O_NOFOLLOW`` rejects a final component that was swapped for a symlink
    between the allowlist check and the read. On platforms without
    ``O_NOFOLLOW`` (Windows) the flag degrades to 0 and the upfront
    ``is_symlink`` check is the only mitigation.
    """
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(output_path, flags), "r", encoding="utf-8") as handle:
        return handle.read()


@router.get("/output")
def whitebox_output(path: str):
    """Read a JSON or GeoJSON Whitebox output file."""
    output_path = _normalize_output_path(path)
    if Path(output_path).suffix.lower() not in {".json", ".geojson"}:
        raise HTTPException(status_code=400, detail="Only JSON outputs can be read")
    if output_path not in _known_output_paths():
        raise HTTPException(
            status_code=403, detail="Path is not a known Whitebox output"
        )
    # Reject a symlinked final component before reading. Combined with the
    # O_NOFOLLOW open this closes the symlink-swap TOCTOU on POSIX; on Windows
    # it is the sole mitigation. A swapped intermediate directory is out of
    # scope (it requires write access to the output's parent directory).
    if os.path.islink(output_path):
        raise HTTPException(
            status_code=403, detail="Output path must not be a symbolic link"
        )
    try:
        return json.loads(_read_text_no_symlink(output_path))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Output file not found") from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
