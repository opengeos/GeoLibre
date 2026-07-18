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

    monkeypatch.setenv("GEOLIBRE_WHITEBOX_RUN_TIMEOUT_SECS", "-1")
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
    # The interpreter path must not leak through the python field either.
    assert result["python"] is None


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


def test_run_job_does_not_leak_error(monkeypatch):
    """The background job runner stores only a generic, non-revealing error.

    Exercises the main /run and /jobs/{id} security fix: a failing run must not
    persist the raw exception (subprocess traceback + interpreter path) into the
    job's ``error`` or ``messages`` fields.
    """
    job_id = "test-leak-job"
    now = whitebox._utc_now()
    with whitebox._JOBS_LOCK:
        whitebox._JOBS[job_id] = whitebox.JobState(
            id=job_id,
            status="pending",
            tool_id="noop",
            created_at=now,
            updated_at=now,
        )

    def _boom(*args, **kwargs):
        raise RuntimeError(_SECRET)

    monkeypatch.setattr(whitebox, "create_runtime_session", _boom)
    try:
        whitebox._run_job(job_id, whitebox.WhiteboxRunRequest(tool_id="noop"))
        job = whitebox._JOBS[job_id]
        assert job.status == "failed"
        assert job.error == "Tool execution failed. See the sidecar logs for details."
        assert _SECRET not in (job.error or "")
        assert all(_SECRET not in message for message in job.messages)
    finally:
        with whitebox._JOBS_LOCK:
            whitebox._JOBS.pop(job_id, None)
