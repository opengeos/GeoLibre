"""MCP server for authoring GeoLibre projects.

Install the optional dependency and run it over stdio::

    pip install "geolibre[mcp]"
    geolibre-mcp --root ~/maps

:mod:`geolibre.mcp.workspace` needs nothing beyond the standard library, so it
imports cleanly without the SDK; :mod:`geolibre.mcp.server` requires ``mcp``.
"""

from __future__ import annotations

from typing import Any

from .workspace import Workspace, WorkspaceError

__all__ = ["Workspace", "WorkspaceError", "build_server", "main"]


def __getattr__(name: str) -> Any:
    """Load the SDK-dependent server lazily.

    Keeps ``import geolibre.mcp`` (and the workspace tests) working when the
    optional ``mcp`` dependency is not installed, while still exposing
    ``build_server``/``main`` as attributes of this package.
    """
    if name in ("build_server", "main"):
        from . import server

        return getattr(server, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
