"""MCP server for authoring GeoLibre projects.

Install the optional dependency and run it over stdio::

    pip install "geolibre[mcp]"
    geolibre-mcp --root ~/maps

:mod:`geolibre.mcp.workspace` needs nothing beyond the standard library, so it
imports cleanly without the SDK; :mod:`geolibre.mcp.server` requires ``mcp``.
"""

from __future__ import annotations

import sys
from typing import Any

from .workspace import Workspace, WorkspaceError

__all__ = ["Workspace", "WorkspaceError", "build_server", "main"]

MISSING_SDK_MESSAGE = (
    'The GeoLibre MCP server needs the "mcp" SDK, which is an optional extra.\n'
    'Install it with:  pip install "geolibre[mcp]"'
)


def main(argv: list[str] | None = None) -> int:
    """Run the MCP server, reporting a missing SDK as an actionable message.

    This is what the ``geolibre-mcp`` console script points at, so a user who
    installed plain ``geolibre`` gets the one line that tells them what to do
    rather than a ``ModuleNotFoundError`` traceback.

    Args:
        argv: Command-line arguments; ``sys.argv[1:]`` when omitted.

    Returns:
        A process exit code.
    """
    try:
        from .server import main as _main
    except ModuleNotFoundError as exc:
        # Only the SDK's own absence is translated. A dependency missing from
        # underneath an installed `mcp` is a broken environment, not a missing
        # extra, and its traceback is the useful thing to show.
        if (exc.name or "").split(".")[0] != "mcp":
            raise
        print(MISSING_SDK_MESSAGE, file=sys.stderr)
        return 1
    return _main(argv)


def __getattr__(name: str) -> Any:
    """Load the SDK-dependent server lazily.

    Keeps ``import geolibre.mcp`` (and the workspace tests) working when the
    optional ``mcp`` dependency is not installed, while still exposing
    ``build_server`` as an attribute of this package.
    """
    if name == "build_server":
        from . import server

        return server.build_server
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
