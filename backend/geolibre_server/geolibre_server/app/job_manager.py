"""Shared in-memory background job registry, concurrency cap, and cancellation."""

from __future__ import annotations

import subprocess
import threading
import uuid
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException

from geolibre_server.app.runtime import JobState, _utc_now


class JobManager:
    """Thread-safe job state store with in-flight limits, eviction, and cancellation.

    Modules that preserve legacy module-level globals (such as ``_JOBS``,
    ``MAX_RETAINED_JOBS``, or ``MAX_IN_FLIGHT_JOBS`` for existing tests that
    monkeypatch them) can supply dynamic accessors so every update and eviction
    honors those overrides.
    """

    def __init__(
        self,
        *,
        busy_detail: str = "Too many jobs in progress; try again shortly.",
        max_retained: int = 100,
        max_in_flight: int = 8,
        max_messages: int = 500,
        get_jobs: Callable[[], dict[str, JobState]] | None = None,
        get_max_retained: Callable[[], int] | None = None,
        get_max_in_flight: Callable[[], int] | None = None,
    ) -> None:
        self.jobs: dict[str, JobState] = {}
        self.lock = threading.Lock()
        self.processes: dict[str, subprocess.Popen[str]] = {}
        self.cancelled: set[str] = set()
        self.busy_detail = busy_detail
        self._max_retained = max_retained
        self._max_in_flight = max_in_flight
        self.max_messages = max_messages
        self._get_jobs = get_jobs
        self._get_max_retained = get_max_retained
        self._get_max_in_flight = get_max_in_flight

    def _store(self) -> dict[str, JobState]:
        return self._get_jobs() if self._get_jobs is not None else self.jobs

    def _retained_limit(self) -> int:
        if self._get_max_retained is not None:
            return self._get_max_retained()
        return self._max_retained

    def _in_flight_limit(self) -> int:
        if self._get_max_in_flight is not None:
            return self._get_max_in_flight()
        return self._max_in_flight

    def get(self, job_id: str) -> JobState | None:
        """Return a job's current state, or ``None`` if unknown."""
        with self.lock:
            return self._store().get(job_id)

    def snapshot_messages(self, job_id: str) -> list[str]:
        """Return a shallow copy of a job's current messages, or an empty list."""
        with self.lock:
            job = self._store().get(job_id)
            return list(job.messages) if job is not None else []

    def update(self, job_id: str, **patch: Any) -> None:
        """Merge *patch* into an existing job entry and refresh ``updated_at``."""
        with self.lock:
            store = self._store()
            job = store[job_id]
            store[job_id] = job.model_copy(update={**patch, "updated_at": _utc_now()})

    def append_message(self, job_id: str, message: str) -> None:
        """Append a progress line to a job's bounded message log."""
        with self.lock:
            store = self._store()
            job = store[job_id]
            messages = [*job.messages, message]
            if len(messages) > self.max_messages:
                messages = messages[-self.max_messages :]
            store[job_id] = job.model_copy(update={"messages": messages, "updated_at": _utc_now()})

    def is_cancelled(self, job_id: str) -> bool:
        """Return True if *job_id* has been marked for cancellation."""
        with self.lock:
            return job_id in self.cancelled

    def register_process(self, job_id: str, process: subprocess.Popen[str]) -> bool:
        """Track a running subprocess and return True if already cancelled."""
        with self.lock:
            self.processes[job_id] = process
            return job_id in self.cancelled

    def clear_process(self, job_id: str) -> None:
        """Remove subprocess and cancellation tracking for a completed job."""
        with self.lock:
            self.processes.pop(job_id, None)
            self.cancelled.discard(job_id)

    def cancel(self, job_id: str) -> None:
        """Mark a pending or running job as cancelled and kill its subprocess."""
        with self.lock:
            job = self._store().get(job_id)
            if job is None or job.status not in {"pending", "running"}:
                return
            self.cancelled.add(job_id)
            process = self.processes.get(job_id)
        if process is not None and process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass

    def count_in_flight_locked(self) -> int:
        """Return how many jobs are pending or running. Caller must hold ``self.lock``."""
        return sum(1 for job in self._store().values() if job.status in {"pending", "running"})

    def evict_finished_locked(self) -> None:
        """Evict the oldest finished jobs once the retention cap is exceeded.

        Caller must hold ``self.lock``. Running and pending jobs are never evicted.
        """
        store = self._store()
        excess = len(store) - self._retained_limit()
        if excess <= 0:
            return
        finished = sorted(
            (job.created_at, job_id)
            for job_id, job in store.items()
            if job.status in {"succeeded", "failed", "cancelled"}
        )
        for _created_at, job_id in finished[:excess]:
            store.pop(job_id, None)

    def start_thread_job(
        self,
        tool_id: str,
        target: Callable[..., Any],
        args: tuple[Any, ...] = (),
    ) -> JobState:
        """Reserve an in-flight slot, launch *target(job_id, *args)*, and return state."""
        job_id = str(uuid.uuid4())
        now = _utc_now()
        job = JobState(
            id=job_id,
            status="pending",
            tool_id=tool_id,
            created_at=now,
            updated_at=now,
        )
        with self.lock:
            if self.count_in_flight_locked() >= self._in_flight_limit():
                raise HTTPException(status_code=429, detail=self.busy_detail)
            store = self._store()
            store[job_id] = job
            self.evict_finished_locked()
        thread = threading.Thread(target=target, args=(job_id, *args), daemon=True)
        try:
            thread.start()
        except RuntimeError:
            with self.lock:
                self._store().pop(job_id, None)
            raise
        # Return the captured reserved JobState rather than re-reading the
        # registry: if the worker finishes and another submission evicts it
        # before the lock is re-acquired, looking up job_id would KeyError.
        return job
