"""Tests for the pinned, checksum-verified managed uv bootstrap."""

from __future__ import annotations

import hashlib
import io
import os
import tarfile
import zipfile
from pathlib import Path

import pytest

from geolibre_server.app import runtime
from geolibre_server.app.runtime import RuntimeBootstrapError


def _tar_gz(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755
            bundle.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def _zip(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for name, data in members.items():
            bundle.writestr(name, data)
    return buffer.getvalue()


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


@pytest.fixture
def fake_release(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Serve a fake uv archive and pin its digest for the current platform."""
    monkeypatch.setenv("GEOLIBRE_UV_DIR", str(tmp_path / "uv-bin"))
    requested: list[str] = []
    state: dict[str, object] = {}

    def serve(archive_name: str, payload: bytes, pinned: str | None = None) -> None:
        monkeypatch.setattr(runtime, "_uv_release_archive", lambda: archive_name)
        digest = pinned or hashlib.sha256(payload).hexdigest()
        monkeypatch.setitem(runtime.UV_RELEASE_SHA256, archive_name, digest)
        state["payload"] = payload

    def fake_urlopen(request, timeout=None):
        requested.append(request.full_url)
        return _FakeResponse(state["payload"])

    monkeypatch.setattr(runtime.urllib.request, "urlopen", fake_urlopen)
    serve.requested = requested  # type: ignore[attr-defined]
    return serve


def _binary_names() -> tuple[str, str]:
    return ("uv.exe", "uvx.exe") if os.name == "nt" else ("uv", "uvx")


def _archive_for_platform() -> tuple[str, bytes]:
    uv_name, uvx_name = _binary_names()
    if os.name == "nt":
        name = "uv-x86_64-pc-windows-msvc.zip"
        return name, _zip({uv_name: b"uv-binary", uvx_name: b"uvx-binary", "README": b"x"})
    name = "uv-x86_64-unknown-linux-musl.tar.gz"
    payload = _tar_gz(
        {
            f"uv-x86_64-unknown-linux-musl/{uv_name}": b"uv-binary",
            f"uv-x86_64-unknown-linux-musl/{uvx_name}": b"uvx-binary",
            "uv-x86_64-unknown-linux-musl/README": b"x",
        }
    )
    return name, payload


def test_pinned_checksums_cover_supported_platforms() -> None:
    for system, machine in (
        ("Linux", "x86_64"),
        ("Linux", "aarch64"),
        ("Darwin", "arm64"),
        ("Darwin", "x86_64"),
        ("Windows", "AMD64"),
        ("Windows", "ARM64"),
    ):
        archive = runtime._uv_release_archive(system, machine)
        assert len(runtime.UV_RELEASE_SHA256[archive]) == 64
    with pytest.raises(RuntimeBootstrapError, match="GEOLIBRE_UV"):
        runtime._uv_release_archive("Linux", "riscv64")


def test_install_downloads_pinned_archive_and_extracts_binaries(fake_release, tmp_path: Path):
    archive_name, payload = _archive_for_platform()
    fake_release(archive_name, payload)

    installed = runtime._install_managed_uv_locked(runtime._managed_uv_executable())

    uv_name, uvx_name = _binary_names()
    install_dir = tmp_path / "uv-bin"
    assert installed == str(install_dir / uv_name)
    assert (install_dir / uv_name).read_bytes() == b"uv-binary"
    assert (install_dir / uvx_name).read_bytes() == b"uvx-binary"
    assert not (install_dir / "README").exists()
    assert fake_release.requested == [
        f"{runtime.UV_DOWNLOAD_BASE_URL}/{runtime.UV_VERSION}/{archive_name}"
    ]
    if os.name != "nt":
        assert os.access(install_dir / uv_name, os.X_OK)


def test_checksum_mismatch_is_rejected_before_extraction(fake_release, tmp_path: Path):
    archive_name, payload = _archive_for_platform()
    fake_release(archive_name, payload, pinned="0" * 64)

    with pytest.raises(RuntimeBootstrapError, match="SHA-256 verification"):
        runtime._install_managed_uv_locked(runtime._managed_uv_executable())

    install_dir = tmp_path / "uv-bin"
    assert not any(install_dir.iterdir())


def test_archive_without_uv_is_rejected(fake_release):
    uv_name, _ = _binary_names()
    if os.name == "nt":
        archive_name, payload = "uv-x86_64-pc-windows-msvc.zip", _zip({"other.exe": b"x"})
    else:
        archive_name, payload = "uv-x86_64-unknown-linux-musl.tar.gz", _tar_gz({"d/other": b"x"})
    fake_release(archive_name, payload)

    with pytest.raises(RuntimeBootstrapError, match=f"does not contain {uv_name}"):
        runtime._install_managed_uv_locked(runtime._managed_uv_executable())


def test_download_failure_is_reported(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    def broken(request, timeout=None):
        raise OSError("network down")

    monkeypatch.setattr(runtime.urllib.request, "urlopen", broken)
    with pytest.raises(RuntimeBootstrapError, match="Could not download uv"):
        runtime._download_verified("https://example.invalid/uv.tar.gz", "0" * 64, tmp_path / "a")


def test_install_never_runs_a_subprocess(fake_release, monkeypatch: pytest.MonkeyPatch):
    archive_name, payload = _archive_for_platform()
    fake_release(archive_name, payload)

    def forbidden(*args, **kwargs):
        raise AssertionError("the uv bootstrap must not execute downloaded code")

    monkeypatch.setattr(runtime.subprocess, "run", forbidden)
    runtime._install_managed_uv_locked(runtime._managed_uv_executable())


def test_desktop_rust_pins_match_python_pins():
    """The desktop app mirrors the uv pin; runtime.py is the source of truth."""
    import re

    rust = (
        Path(__file__).resolve().parents[3]
        / "apps"
        / "geolibre-desktop"
        / "src-tauri"
        / "src"
        / "uv_bootstrap.rs"
    )
    if not rust.is_file():
        pytest.skip("desktop sources are not part of this checkout")
    source = rust.read_text(encoding="utf-8")
    version = re.search(r'pub const UV_VERSION: &str = "([^"]+)";', source)
    assert version is not None
    assert version.group(1) == runtime.UV_VERSION
    pins = dict(re.findall(r'\(\s*"(uv-[^"]+)",\s*"([0-9a-f]{64})",?\s*\)', source))
    assert pins == runtime.UV_RELEASE_SHA256


def test_removed_installer_mirror_setting_warns(monkeypatch, caplog):
    """The removed installer mirror setting produces actionable migration guidance.

    Args:
        monkeypatch: The pytest patch fixture.
        caplog: Captured log records.
    """
    monkeypatch.setenv("GEOLIBRE_UV_INSTALL_BASE_URL", "https://old.example")
    monkeypatch.setenv("GEOLIBRE_UV_DOWNLOAD_BASE_URL", "https://archives.example/")
    assert runtime._uv_download_base_url() == "https://archives.example"
    assert "GEOLIBRE_UV_INSTALL_BASE_URL is no longer used" in caplog.text
    assert "GEOLIBRE_UV_DOWNLOAD_BASE_URL" in caplog.text
    assert "<base>/<version>/<archive>" in caplog.text


def test_concurrent_extractors_have_distinct_staging_files(tmp_path, monkeypatch):
    """Independent installers can replace the same binaries without sharing staging.

    Args:
        tmp_path: An isolated temporary directory.
        monkeypatch: The pytest patch fixture.
    """
    import threading
    from concurrent.futures import ThreadPoolExecutor

    archive_name, payload = _archive_for_platform()
    archive = tmp_path / archive_name
    archive.write_bytes(payload)
    install_dir = tmp_path / "uv-bin"
    install_dir.mkdir()
    barrier = threading.Barrier(2)
    paths = []
    replace = runtime.os.replace

    def replace_together(source, destination):
        """Overlap independent installs immediately before atomic replacement.

        Args:
            source: The installer's staging file.
            destination: The shared installed executable.
        """
        paths.append(source)
        barrier.wait(timeout=10)
        replace(source, destination)

    monkeypatch.setattr(runtime.os, "replace", replace_together)
    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(lambda _: runtime._extract_uv_binaries(archive, install_dir), range(2)))
    uv, uvx = _binary_names()
    assert (install_dir / uv).read_bytes() == b"uv-binary"
    assert (install_dir / uvx).read_bytes() == b"uvx-binary"
    assert len(paths) == len(set(paths)) == 4
    assert not list(install_dir.glob(".*.tmp"))


def test_uv_replace_errors_are_wrapped_and_staging_is_cleaned(tmp_path, monkeypatch):
    """A busy Windows executable produces an actionable bootstrap error.

    Args:
        tmp_path: An isolated temporary directory.
        monkeypatch: The pytest patch fixture.
    """
    archive_name, payload = _archive_for_platform()
    archive = tmp_path / archive_name
    archive.write_bytes(payload)
    install_dir = tmp_path / "uv-bin"
    install_dir.mkdir()

    def busy_executable(source, destination):
        """Simulate replacement being refused while an executable is running.

        Args:
            source: The installer's staging file.
            destination: The installed executable.
        """
        raise PermissionError("executable is in use")

    monkeypatch.setattr(runtime.os, "replace", busy_executable)
    with pytest.raises(RuntimeBootstrapError, match="Could not install.*executable is in use"):
        runtime._extract_uv_binaries(archive, install_dir)
    assert not list(install_dir.iterdir())
