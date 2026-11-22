"""Standalone Python worker modules executed in managed sidecar runtimes.

Worker scripts live as real Python modules under ``geolibre_server.workers`` so
ruff, type checkers, and pytest can inspect and import them directly instead of
keeping thousands of lines inside triple-quoted string literals.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

RESULT_MARKER = "__GEOLIBRE_CONVERSION_RESULT__"
ERROR_MARKER = "__GEOLIBRE_CONVERSION_ERROR__"

_WORKERS_DIR = Path(__file__).resolve().parent
_HELPER_IMPORT_RE = re.compile(r"from\s+geolibre_server\.workers\.([A-Za-z0-9_]+)\s+import\b")


def worker_path(module_name: str) -> Path:
    """Resolve a dotted worker name (e.g. ``'raster_tools.hillshade'``) to its file."""
    rel = Path(*module_name.split(".")).with_suffix(".py")
    path = (_WORKERS_DIR / rel).resolve()
    if not path.is_file() or _WORKERS_DIR not in path.parents:
        raise ValueError(f"Unknown worker module: {module_name}")
    return path


def _build_helper_loader(helper_names: list[str]) -> str:
    """Build a minimal bootstrap that loads sibling helpers by exact file path.

    Deliberately avoids adding the sidecar's ``site-packages`` directory to
    ``sys.path`` so a managed conversion interpreter using a different Python
    build never imports compiled extensions (such as NumPy) from the sidecar.
    """
    entries = {name: str(worker_path(name)) for name in helper_names}
    return (
        "import importlib.util as _gl_ilu, sys as _gl_sys, types as _gl_types\n"
        f"_gl_helpers = {entries!r}\n"
        "for _gl_pkg in ('geolibre_server', 'geolibre_server.workers'):\n"
        "    if _gl_pkg not in _gl_sys.modules:\n"
        "        _gl_m = _gl_types.ModuleType(_gl_pkg)\n"
        "        _gl_m.__path__ = []\n"
        "        _gl_sys.modules[_gl_pkg] = _gl_m\n"
        "for _gl_name, _gl_path in _gl_helpers.items():\n"
        "    _gl_fq = 'geolibre_server.workers.' + _gl_name\n"
        "    _gl_spec = _gl_ilu.spec_from_file_location(_gl_fq, _gl_path)\n"
        "    _gl_mod = _gl_ilu.module_from_spec(_gl_spec)\n"
        "    _gl_sys.modules[_gl_fq] = _gl_mod\n"
        "    _gl_spec.loader.exec_module(_gl_mod)\n"
    )


@lru_cache(maxsize=64)
def load_worker_source(module_name: str) -> str:
    """Read a worker module's Python source from disk.

    When a worker imports sibling helpers under ``geolibre_server.workers``,
    prepend a file-path loader that registers only those helpers without
    mutating ``sys.path``.
    """
    source = worker_path(module_name).read_text(encoding="utf-8")
    helpers = sorted(set(_HELPER_IMPORT_RE.findall(source)))
    if helpers:
        return _build_helper_loader(helpers) + source
    return source
