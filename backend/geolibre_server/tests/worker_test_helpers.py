"""Shared in-process worker execution and result parsing for sidecar tests."""

import importlib
import json
import sys

import pytest

from geolibre_server.workers import RESULT_MARKER


def run_worker(monkeypatch: pytest.MonkeyPatch, module_name: str, params: dict) -> None:
    """Run a worker's ``main()`` in this process with JSON params on ``sys.argv``.

    Args:
        monkeypatch: The pytest monkeypatch fixture used to patch ``sys.argv``.
        module_name: The dotted worker name under ``geolibre_server.workers``.
        params: The parameters the worker reads from ``sys.argv[1]``.
    """
    mod = importlib.import_module(f"geolibre_server.workers.{module_name}")
    monkeypatch.setattr(sys, "argv", [module_name, json.dumps(params)])
    mod.main()


def worker_result(capsys: pytest.CaptureFixture[str]) -> dict:
    """Parse the JSON payload a worker printed after the result marker.

    Args:
        capsys: The pytest capture fixture holding the worker's stdout.

    Returns:
        The decoded result object.
    """
    out = capsys.readouterr().out
    line = next(x for x in out.splitlines() if x.startswith(RESULT_MARKER))
    return json.loads(line[len(RESULT_MARKER) :])
