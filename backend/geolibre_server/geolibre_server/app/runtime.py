"""Shared managed-runtime infrastructure for sidecar tool integrations.

These helpers bootstrap a uv-managed Python environment and provide the common
job-state model used by the Whitebox and conversion routers. They live here so
neither router has to import private symbols from the other.
"""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
import threading
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel

RUNTIME_DISCOVERY_TIMEOUT_SECS = 5
RUNTIME_CATALOG_TIMEOUT_SECS = 120
RUNTIME_SETUP_TIMEOUT_SECS = 600
# The managed uv is a pinned release archive verified against the SHA-256
# digests below, never a remote install script. To bump it, copy the digests
# from the release's official ``<archive>.sha256`` assets
# (https://github.com/astral-sh/uv/releases/download/<version>/<archive>.sha256).
# This is the source of truth: the desktop app mirrors it in
# apps/geolibre-desktop/src-tauri/src/uv_bootstrap.rs, and
# tests/test_runtime_uv_bootstrap.py fails if the two differ.
UV_VERSION = "0.13.9"
UV_RELEASE_SHA256 = {
    "uv-aarch64-apple-darwin.tar.gz": (
        "5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca"
    ),
    "uv-x86_64-apple-darwin.tar.gz": (
        "617a3211261b0fc739562f0071aa34e9739797c510208ede8e2977c30903d041"
    ),
    "uv-aarch64-unknown-linux-musl.tar.gz": (
        "37fbb7c5bc66cf99c12aa881949d216181e201dec449772c4329e56487d61179"
    ),
    "uv-x86_64-unknown-linux-musl.tar.gz": (
        "58ccf5f1792b8a5a88d01bc910ea131a8b3db4a319a17ad5fad75e0845a3e271"
    ),
    "uv-aarch64-pc-windows-msvc.zip": (
        "72eed595983a4d7d22d79f21065b0f4479cc7e5c7a89104bb410c8f47559a878"
    ),
    "uv-x86_64-pc-windows-msvc.zip": (
        "edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb"
    ),
}


# A mirror of the GitHub release layout (``<base>/<version>/<archive>``) may be
# configured; the pinned digests still decide what is installed.
def _uv_download_base_url() -> str:
    """Read the archive mirror setting and flag the removed installer setting.

    Returns:
        The release-archive base URL, without a trailing slash.
    """
    if os.environ.get("GEOLIBRE_UV_INSTALL_BASE_URL"):
        logging.getLogger(__name__).warning(
            "GEOLIBRE_UV_INSTALL_BASE_URL is no longer used. Set "
            "GEOLIBRE_UV_DOWNLOAD_BASE_URL to a mirror with the release-archive "
            "layout <base>/<version>/<archive>; no install script is executed."
        )
    return os.environ.get(
        "GEOLIBRE_UV_DOWNLOAD_BASE_URL",
        "https://github.com/astral-sh/uv/releases/download",
    ).rstrip("/")


UV_DOWNLOAD_BASE_URL = _uv_download_base_url()
UV_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

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
    # PyPI geospatial wheels bundle a matching PROJ database. Inherited search
    # paths can redirect them to an absent or incompatible system installation.
    env.pop("PROJ_DATA", None)
    env.pop("PROJ_LIB", None)
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


def _uv_release_archive(system: str | None = None, machine: str | None = None) -> str:
    """Return the uv release archive name for a platform.

    Linux uses the statically linked musl build so one archive works on both
    glibc and musl distributions.

    Args:
        system: ``platform.system()`` value; defaults to the running platform.
        machine: ``platform.machine()`` value; defaults to the running platform.

    Returns:
        The archive file name, a key of ``UV_RELEASE_SHA256``.

    Raises:
        RuntimeBootstrapError: If no pinned archive exists for the platform.
    """
    system = (system or platform.system()).lower()
    machine = (machine or platform.machine()).lower()
    arch = {
        "x86_64": "x86_64",
        "amd64": "x86_64",
        "aarch64": "aarch64",
        "arm64": "aarch64",
    }.get(machine)
    target = {
        "darwin": "apple-darwin.tar.gz",
        "linux": "unknown-linux-musl.tar.gz",
        "windows": "pc-windows-msvc.zip",
    }.get(system)
    archive = f"uv-{arch}-{target}" if arch and target else None
    if archive not in UV_RELEASE_SHA256:
        raise RuntimeBootstrapError(
            f"No pinned uv {UV_VERSION} build for {system}/{machine}. Install uv "
            "yourself and put it on PATH, or set GEOLIBRE_UV to its path."
        )
    return archive


def _download_verified(url: str, expected_sha256: str, target: Path) -> None:
    """Stream a URL to ``target`` and verify its SHA-256 digest.

    Args:
        url: The archive URL.
        expected_sha256: The pinned lowercase hex digest.
        target: Where to write the download.

    Raises:
        RuntimeBootstrapError: If the download fails, is too large, or its
            digest does not match the pinned value.
    """
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "GeoLibre uv-bootstrap"},
    )
    digest = hashlib.sha256()
    size = 0
    try:
        with urllib.request.urlopen(request, timeout=60) as response, target.open("wb") as out:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > UV_MAX_ARCHIVE_BYTES:
                    raise RuntimeBootstrapError(
                        f"uv download from {url} exceeds {UV_MAX_ARCHIVE_BYTES} bytes"
                    )
                digest.update(chunk)
                out.write(chunk)
    except RuntimeBootstrapError:
        raise
    except Exception as exc:
        raise RuntimeBootstrapError(f"Could not download uv from {url}: {exc}") from exc
    actual = digest.hexdigest()
    if actual != expected_sha256:
        raise RuntimeBootstrapError(
            f"uv download from {url} failed SHA-256 verification "
            f"(expected {expected_sha256}, got {actual}); refusing to install it"
        )


def _uv_binary_names() -> tuple[str, ...]:
    """Return the executables the managed uv install provides, uv first."""
    if os.name == "nt":
        return ("uv.exe", "uvx.exe", "uvw.exe")
    return ("uv", "uvx")


def _extract_uv_binaries(archive: Path, install_dir: Path) -> None:
    """Copy uv's executables out of a verified release archive.

    Only regular files whose base name is a known uv executable are read, so
    archive paths never decide where anything is written.

    Args:
        archive: The verified ``.tar.gz`` or ``.zip`` release archive.
        install_dir: The managed uv directory.

    Raises:
        RuntimeBootstrapError: If the archive is unreadable or lacks uv.
    """
    wanted = set(_uv_binary_names())
    found: dict[str, bytes] = {}
    try:
        if archive.name.endswith(".zip"):
            with zipfile.ZipFile(archive) as bundle:
                for info in bundle.infolist():
                    name = Path(info.filename).name
                    if not info.is_dir() and name in wanted:
                        found[name] = bundle.read(info)
        else:
            with tarfile.open(archive, "r:gz") as bundle:
                for member in bundle.getmembers():
                    name = Path(member.name).name
                    if member.isfile() and name in wanted:
                        extracted = bundle.extractfile(member)
                        if extracted is not None:
                            found[name] = extracted.read()
    except (OSError, tarfile.TarError, zipfile.BadZipFile) as exc:
        raise RuntimeBootstrapError(f"Could not read the uv archive: {exc}") from exc
    primary = _uv_binary_names()[0]
    if primary not in found:
        raise RuntimeBootstrapError(f"The uv archive does not contain {primary}")
    for name, data in found.items():
        staging = install_dir / f".{name}.tmp"
        staging.write_bytes(data)
        staging.chmod(0o755)
        os.replace(staging, install_dir / name)


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
    """Download, verify, and install uv. The caller must hold ``_UV_INSTALL_LOCK``.

    Fetches the pinned ``UV_VERSION`` release archive for this platform,
    checks it against ``UV_RELEASE_SHA256``, and extracts only uv's
    executables. Nothing downloaded is executed or unpacked before the digest
    matches.
    """
    install_dir = _managed_uv_dir()
    install_dir.mkdir(parents=True, exist_ok=True)
    archive_name = _uv_release_archive()
    url = f"{UV_DOWNLOAD_BASE_URL}/{UV_VERSION}/{archive_name}"
    workdir = Path(tempfile.mkdtemp(prefix="geolibre-uv-download-"))
    try:
        archive = workdir / archive_name
        _download_verified(url, UV_RELEASE_SHA256[archive_name], archive)
        _extract_uv_binaries(archive, install_dir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    if not _is_valid_managed_uv(uv):
        raise RuntimeBootstrapError(f"uv install did not create a runnable binary at {uv}")
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
