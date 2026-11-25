"""Regression tests for sidecar job reliability and cancellation locking."""

from __future__ import annotations

from geolibre_server.app import conversion, whitebox


def test_conversion_append_job_message_bounds_ring_buffer():
    job_id = "test-conv-ring-buffer"
    job = conversion.JobState(
        id=job_id,
        tool_id="convert",
        status="running",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )
    with conversion._JOBS_LOCK:
        conversion._JOBS[job_id] = job
    try:
        total = conversion.MAX_JOB_MESSAGES + 42
        for index in range(total):
            conversion._append_job_message(job_id, f"line-{index}")
        state = conversion._job_state(job_id)
        assert state is not None
        assert len(state.messages) == conversion.MAX_JOB_MESSAGES
        assert state.messages[0] == "line-42"
        assert state.messages[-1] == f"line-{total - 1}"
    finally:
        with conversion._JOBS_LOCK:
            conversion._JOBS.pop(job_id, None)


def test_conversion_is_cancelled_helper():
    job_id = "test-conv-cancelled-flag"
    try:
        assert conversion._is_cancelled(job_id) is False
        with conversion._JOBS_LOCK:
            conversion._CANCELLED.add(job_id)
        assert conversion._is_cancelled(job_id) is True
    finally:
        with conversion._JOBS_LOCK:
            conversion._CANCELLED.discard(job_id)


def test_whitebox_append_job_message_bounds_ring_buffer():
    job_id = "test-wbt-ring-buffer"
    job = whitebox.JobState(
        id=job_id,
        tool_id="Slope",
        status="running",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )
    with whitebox._JOBS_LOCK:
        whitebox._JOBS[job_id] = job
    try:
        total = whitebox.MAX_JOB_MESSAGES + 25
        for index in range(total):
            whitebox._append_job_message(job_id, f"event-{index}")
        with whitebox._JOBS_LOCK:
            messages = list(whitebox._JOBS[job_id].messages)
        assert len(messages) == whitebox.MAX_JOB_MESSAGES
        assert messages[0] == "event-25"
        assert messages[-1] == f"event-{total - 1}"
    finally:
        with whitebox._JOBS_LOCK:
            whitebox._JOBS.pop(job_id, None)
