"""Whitebox router endpoints: timeout config and non-leaky error handling.

These exercise the failure paths directly (calling the route functions) so the
sidecar never echoes internal exception text — including the interpreter path —
back to the client, mirroring conversion.py/raster.py.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from geolibre_server.app import whitebox

_SECRET = "/secret/path/to/python: boom traceback leak"


def test_run_timeout_defaults_to_one_hour(monkeypatch):
    """An unset or invalid override falls back to the 1-hour default."""
    monkeypatch.delenv("GEOLIBRE_WHITEBOX_RUN_TIMEOUT_SECS", raising=False)
    assert whitebox._whitebox_run_timeout_secs() == 3600

    monkeypatch.setenv("GEOLIBRE_WHITEBOX_RUN_TIMEOUT_SECS", "not-a-number")
    assert whitebox._whitebox_run_timeout_secs() == 3600

    monkeypatch.setenv("GEOLIBRE_WHITEBOX_RUN_TIMEOUT_SECS", "0")
    assert whitebox._whitebox_run_timeout_secs() == 3600


def test_run_timeout_reads_positive_override(monkeypatch):
    """A positive override is honoured so long jobs can be tuned per deployment."""
    monkeypatch.setenv("GEOLIBRE_WHITEBOX_RUN_TIMEOUT_SECS", "120")
    assert whitebox._whitebox_run_timeout_secs() == 120


def test_status_does_not_leak_internal_error(monkeypatch):
    """A runtime probe failure reports a generic, non-revealing message."""

    def _boom():
        raise RuntimeError(_SECRET)

    monkeypatch.setattr(whitebox, "_runtime_import_status", _boom)
    result = whitebox.whitebox_status()
    assert result["available"] is False
    assert result["message"] == "Whitebox runtime is unavailable"
    assert _SECRET not in result["message"]


def test_tools_does_not_leak_internal_error(monkeypatch):
    """/tools maps a catalog failure to a stable 503 without the raw exception."""

    def _boom(*args, **kwargs):
        raise RuntimeError(_SECRET)

    monkeypatch.setattr(whitebox, "_load_catalog", _boom)
    with pytest.raises(HTTPException) as excinfo:
        whitebox.whitebox_tools()
    assert excinfo.value.status_code == 503
    assert excinfo.value.detail == "Whitebox tool catalog is unavailable"
    assert _SECRET not in excinfo.value.detail


def test_tool_metadata_does_not_leak_internal_error(monkeypatch):
    """/tools/{id} maps a session failure to a stable 503 without leakage."""

    def _boom(*args, **kwargs):
        raise RuntimeError(_SECRET)

    monkeypatch.setattr(whitebox, "create_runtime_session", _boom)
    with pytest.raises(HTTPException) as excinfo:
        whitebox.whitebox_tool("some-tool")
    assert excinfo.value.status_code == 503
    assert excinfo.value.detail == "Whitebox tool metadata is unavailable"
    assert _SECRET not in excinfo.value.detail
