"""Shared managed-runtime infrastructure for sidecar tool integrations.

These helpers bootstrap a uv-managed Python environment and provide the common
job-state model used by the Whitebox and conversion routers. They live here so
neither router has to import private symbols from the other.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel

RUNTIME_DISCOVERY_TIMEOUT_SECS = 5
RUNTIME_CATALOG_TIMEOUT_SECS = 120
RUNTIME_SETUP_TIMEOUT_SECS = 600
UV_INSTALL_BASE_URL = os.environ.get(
    "GEOLIBRE_UV_INSTALL_BASE_URL",
    "https://astral.sh/uv",
).rstrip("/")

# The Whitebox and conversion routers each guard their own runtime setup with
# their own lock, but both call _install_managed_uv; this shared lock prevents
# two concurrent cold-start bootstraps from racing on the same uv binary.
_UV_INSTALL_LOCK = threading.Lock()


class RuntimeBootstrapError(RuntimeError):
    """Raised when a usable managed runtime cannot be initialized."""


class JobState(BaseModel):
    """Serializable state for a background sidecar job."""

    id: str
    status: str
    tool_id: str
    created_at: str
    updated_at: str
    messages: list[str] = []
    outputs: dict[str, Any] = {}
    result: Any = None
    error: str | None = None


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
    target = Path(tempfile.mkdtemp(prefix="geolibre-uv-installer-")) / f"install{suffix}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "GeoLibre/0.7 uv-bootstrap"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            target.write_bytes(response.read())
    except Exception as exc:
        raise RuntimeBootstrapError(f"Could not download uv installer from {url}: {exc}") from exc
    return target


def _is_valid_managed_uv(path: Path) -> bool:
    """Return whether the managed uv binary is present and runnable."""
    if not path.is_file():
        return False
    # Windows executability is extension-based; POSIX needs the execute bit.
    return os.name == "nt" or os.access(path, os.X_OK)


def _install_managed_uv() -> str:
    """Download and install uv into GeoLibre's managed runtime directory."""
    uv = _managed_uv_executable()
    if _is_valid_managed_uv(uv):
        return str(uv)

    with _UV_INSTALL_LOCK:
        # Re-check inside the lock: another router may have installed uv while
        # this caller was waiting.
        if _is_valid_managed_uv(uv):
            return str(uv)
        return _install_managed_uv_locked(uv)


def _install_managed_uv_locked(uv: Path) -> str:
    """Download and install uv. The caller must hold ``_UV_INSTALL_LOCK``."""
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
    if not _is_valid_managed_uv(uv):
        raise RuntimeBootstrapError(f"uv installer did not create a runnable binary at {uv}")
    return str(uv)


def _uv_executable() -> str:
    """Return the configured or discovered uv executable."""
    configured = os.environ.get("GEOLIBRE_UV")
    if configured:
        resolved = str(Path(configured).expanduser())
        if os.path.isfile(resolved) and os.access(resolved, os.X_OK):
            return resolved
        raise RuntimeBootstrapError(f"Configured uv executable is not valid: {configured}")
    uv = shutil.which("uv")
    if uv:
        return uv
    return _install_managed_uv()
