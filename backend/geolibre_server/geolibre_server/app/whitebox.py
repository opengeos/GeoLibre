"""Whitebox Next Gen sidecar endpoints."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import traceback
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/whitebox", tags=["whitebox"])
RUNTIME_DISCOVERY_TIMEOUT_SECS = 5
RUNTIME_CATALOG_TIMEOUT_SECS = 120
RUNTIME_SETUP_TIMEOUT_SECS = 600
WHITEBOX_RUNTIME_PACKAGE = os.environ.get(
    "GEOLIBRE_WHITEBOX_PACKAGE",
    "whitebox-workflows>=2.0.2",
)
WHITEBOX_PYTHON_VERSION = os.environ.get("GEOLIBRE_WHITEBOX_PYTHON_VERSION", "3.12")
UV_INSTALL_BASE_URL = os.environ.get(
    "GEOLIBRE_UV_INSTALL_BASE_URL",
    "https://astral.sh/uv",
).rstrip("/")


class RuntimeBootstrapError(RuntimeError):
    """Raised when a usable Whitebox runtime cannot be initialized."""


class WhiteboxRunRequest(BaseModel):
    """Request body for a Whitebox tool run."""

    tool_id: str
    parameters: dict[str, Any] = {}
    tool: dict[str, Any] | None = None
    layer_inputs: dict[str, dict[str, Any]] = {}
    include_pro: bool = False
    tier: str = "open"


class JobState(BaseModel):
    """Serializable state for a background Whitebox job."""

    id: str
    status: str
    tool_id: str
    created_at: str
    updated_at: str
    messages: list[str] = []
    outputs: dict[str, Any] = {}
    result: Any = None
    error: str | None = None


_JOBS: dict[str, JobState] = {}
_JOBS_LOCK = threading.Lock()
_RUNTIME_SETUP_LOCK = threading.Lock()
MAX_RETAINED_JOBS = 100


def _utc_now() -> str:
    """Return the current UTC timestamp as an ISO string."""
    return datetime.now(timezone.utc).isoformat()


def _clean_env() -> dict[str, str]:
    """Return a Python subprocess environment suitable for extension imports."""
    env = dict(os.environ)
    env.pop("PYTHONHOME", None)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def _runtime_setup_env(**overrides: str) -> dict[str, str]:
    """Return an environment for managed runtime setup commands."""
    root = _runtime_cache_root()
    env = _clean_env()
    env.setdefault("UV_CACHE_DIR", str(root / "uv-cache"))
    env.setdefault("UV_PYTHON_INSTALL_DIR", str(root / "uv-python"))
    env.update(overrides)
    return env


def _subprocess_startup_kwargs() -> dict[str, Any]:
    """Return platform-specific subprocess startup options."""
    if os.name != "nt":
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}


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


def _runtime_cache_root() -> Path:
    """Return the cache root for managed GeoLibre runtime environments."""
    configured = os.environ.get("GEOLIBRE_RUNTIME_DIR")
    if configured:
        return Path(configured).expanduser()
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "GeoLibre"
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "geolibre"


def _managed_runtime_dir() -> Path:
    """Return the managed Whitebox runtime environment directory."""
    configured = os.environ.get("GEOLIBRE_WHITEBOX_ENV")
    if configured:
        return Path(configured).expanduser()
    return _runtime_cache_root() / "whitebox-runtime"


def _managed_uv_dir() -> Path:
    """Return the directory for GeoLibre's managed uv binary."""
    configured = os.environ.get("GEOLIBRE_UV_DIR")
    if configured:
        return Path(configured).expanduser()
    return _runtime_cache_root() / "uv-bin"


def _managed_uv_executable() -> Path:
    """Return the managed uv executable path."""
    suffix = ".exe" if os.name == "nt" else ""
    return _managed_uv_dir() / f"uv{suffix}"


def _venv_python(env_dir: Path) -> Path:
    """Return the Python executable path inside a virtual environment."""
    if os.name == "nt":
        return env_dir / "Scripts" / "python.exe"
    return env_dir / "bin" / "python"


def _download_to_temp(url: str, suffix: str) -> Path:
    """Download a URL to a temporary file and return its path."""
    target = (
        Path(tempfile.mkdtemp(prefix="geolibre-uv-installer-"))
        / f"install{suffix}"
    )
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "GeoLibre/0.6 uv-bootstrap"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            target.write_bytes(response.read())
    except Exception as exc:
        raise RuntimeBootstrapError(
            f"Could not download uv installer from {url}: {exc}"
        ) from exc
    return target


def _install_managed_uv() -> str:
    """Download and install uv into GeoLibre's managed runtime directory."""
    uv = _managed_uv_executable()
    if uv.exists():
        return str(uv)

    install_dir = _managed_uv_dir()
    install_dir.mkdir(parents=True, exist_ok=True)
    script_url = (
        f"{UV_INSTALL_BASE_URL}/install.ps1"
        if os.name == "nt"
        else f"{UV_INSTALL_BASE_URL}/install.sh"
    )
    script = _download_to_temp(script_url, ".ps1" if os.name == "nt" else ".sh")
    env = _runtime_setup_env(UV_UNMANAGED_INSTALL=str(install_dir))
    try:
        if os.name == "nt":
            command = [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script),
            ]
        else:
            command = ["sh", str(script)]
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=RUNTIME_SETUP_TIMEOUT_SECS,
            **_subprocess_startup_kwargs(),
        )
    finally:
        shutil.rmtree(script.parent, ignore_errors=True)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeBootstrapError(f"uv installer failed. {detail}")
    if not uv.exists():
        raise RuntimeBootstrapError(f"uv installer did not create {uv}")
    return str(uv)


def _uv_executable() -> str:
    """Return the configured or discovered uv executable."""
    configured = os.environ.get("GEOLIBRE_UV")
    if configured:
        resolved = str(Path(configured).expanduser())
        if os.path.isfile(resolved) and os.access(resolved, os.X_OK):
            return resolved
        raise RuntimeBootstrapError(
            f"Configured uv executable is not valid: {configured}"
        )
    uv = shutil.which("uv")
    if uv:
        return uv
    return _install_managed_uv()


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
        process = subprocess.Popen(
            [self.python_executable, "-c", runner, json.dumps(payload)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_clean_env(),
            bufsize=1,
            **_subprocess_startup_kwargs(),
        )
        if process.stdout is None:
            raise RuntimeBootstrapError(
                "Whitebox subprocess stdout is unexpectedly None"
            )
        for line in process.stdout:
            line = line.rstrip("\r\n")
            if line.startswith("__WBW_EVENT__"):
                if callback:
                    callback(
                        base64.b64decode(line[len("__WBW_EVENT__") :]).decode(
                            "utf-8", "replace"
                        )
                    )
            elif line.startswith("__WBW_RESULT__"):
                completed_result = base64.b64decode(
                    line[len("__WBW_RESULT__") :]
                ).decode("utf-8", "replace")
            elif line.startswith("__WBW_ERROR__"):
                errors.append(
                    base64.b64decode(line[len("__WBW_ERROR__") :]).decode(
                        "utf-8", "replace"
                    )
                )
        stderr = process.stderr.read().strip() if process.stderr else ""
        rc = process.wait()
        if rc != 0 or errors:
            raise RuntimeBootstrapError(
                "\n".join(errors) or stderr or "Whitebox runtime execution failed"
            )
        return completed_result or "{}"


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


def _prepare_arguments(request: WhiteboxRunRequest, temp_paths: list[Path]) -> dict[str, Any]:
    """Prepare a Whitebox JSON argument payload from a run request."""
    specs = {
        str(param.get("name")): param
        for param in (request.tool or {}).get("params", [])
        if isinstance(param, dict)
    }
    args: dict[str, Any] = {}
    for name, value in request.parameters.items():
        spec = specs.get(str(name), {})
        kind = str(spec.get("kind") or "")
        if name in request.layer_inputs:
            value = _write_layer_input(name, request.layer_inputs[name], temp_paths)
        coerced = _coerce_value(value, kind)
        if coerced is not None:
            args[name] = coerced

    for name, spec in specs.items():
        kind = str(spec.get("kind") or "")
        if kind.endswith("_out") and not args.get(name):
            args[name] = _default_output_path(request.tool_id, name, kind)
    return args


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
        args = _prepare_arguments(request, temp_paths)
        session = create_runtime_session(
            include_pro=request.include_pro,
            tier=request.tier or "open",
        )
        raw_result = session.run_tool_json_stream(
            request.tool_id,
            json.dumps(args),
            lambda event: _append_job_message(job_id, event),
        )
        result = _parse_json_maybe(raw_result)
        _job_update(
            job_id,
            status="succeeded",
            result=result,
            outputs=_extract_outputs(result, args, request.tool),
        )
    except Exception as exc:
        with _JOBS_LOCK:
            current_messages = list(_JOBS[job_id].messages)
        _job_update(
            job_id,
            status="failed",
            error=str(exc),
            messages=[
                *current_messages,
                traceback.format_exc(limit=8),
            ],
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
    except Exception as exc:
        return {
            "available": False,
            "message": str(exc),
            "capabilities": None,
            "python": None,
        }


@router.get("/tools")
def whitebox_tools(include_pro: bool = False, tier: str = "open"):
    """Return the Whitebox toolbox catalog."""
    try:
        tools = _load_catalog(include_pro=include_pro, tier=tier)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"tools": tools, "tool_count": len(tools)}


@router.get("/tools/{tool_id}")
def whitebox_tool(tool_id: str, include_pro: bool = False, tier: str = "open"):
    """Return metadata for one Whitebox tool."""
    try:
        session = create_runtime_session(include_pro=include_pro, tier=tier)
        metadata = _parse_json_maybe(session.get_tool_metadata_json(tool_id))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
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
