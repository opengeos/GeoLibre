"""Standalone Python worker modules executed in managed sidecar runtimes.

Worker scripts live as real Python modules under ``geolibre_server.workers`` so
ruff, type checkers, and pytest can inspect and import them directly instead of
keeping thousands of lines inside triple-quoted string literals.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

RESULT_MARKER = "__GEOLIBRE_CONVERSION_RESULT__"
ERROR_MARKER = "__GEOLIBRE_CONVERSION_ERROR__"

_WORKERS_DIR = Path(__file__).resolve().parent
_PACKAGE_ROOT = str(_WORKERS_DIR.parents[1])


def worker_path(module_name: str) -> Path:
    """Resolve a dotted worker name (e.g. ``'raster_tools.hillshade'``) to its file."""
    rel = Path(*module_name.split(".")).with_suffix(".py")
    path = (_WORKERS_DIR / rel).resolve()
    if not path.is_file() or _WORKERS_DIR not in path.parents:
        raise ValueError(f"Unknown worker module: {module_name}")
    return path


@lru_cache(maxsize=64)
def load_worker_source(module_name: str) -> str:
    """Read a worker module's Python source from disk.

    When a worker imports sibling helpers under ``geolibre_server.workers``,
    prepend a tiny ``sys.path`` bootstrap so the source still executes cleanly
    when passed directly to ``python -c`` inside a managed runtime or test
    subprocess without ``PYTHONPATH`` configured.
    """
    source = worker_path(module_name).read_text(encoding="utf-8")
    if "geolibre_server.workers" in source:
        bootstrap = (
            "import sys as _geolibre_sys\n"
            f"if {_PACKAGE_ROOT!r} not in _geolibre_sys.path:\n"
            f"    _geolibre_sys.path.insert(0, {_PACKAGE_ROOT!r})\n"
        )
        return bootstrap + source
    return source
