"""Filesystem confinement for the MCP server.

An MCP client hands the server paths chosen by a model, so every path the server
touches is resolved against an explicit allowlist of root directories first. This
mirrors ``GEOLIBRE_CONVERSION_ROOTS`` in the FastAPI sidecar
(``backend/geolibre_server``): the server can only read and write inside roots
the operator named, and a symlink out of one is not an escape hatch.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

#: Environment variable naming the allowed roots, ``os.pathsep``-separated
#: (``:`` on Linux/macOS, ``;`` on Windows).
ROOTS_ENV_VAR = "GEOLIBRE_MCP_ROOTS"

#: Extensions the server will write a project to. Anything else is refused, so a
#: mistaken path cannot overwrite source code or a dotfile. ``.geolibre.json`` is
#: a subset of ``.json`` and so never widens the check — it is listed to name the
#: conventional extension in the error message a client sees.
PROJECT_SUFFIXES = (".json", ".geolibre.json")

#: Extensions the server will write an export to.
EXPORT_SUFFIXES = (".html", ".htm")


class WorkspaceError(ValueError):
    """A path was outside the workspace, or otherwise not writable."""


class Workspace:
    """A set of directories the server is allowed to read and write within."""

    def __init__(self, roots: Iterable[str | Path] | None = None) -> None:
        """Bind the workspace to its roots.

        Args:
            roots: Directories to allow. Falls back to
                :data:`ROOTS_ENV_VAR` and then to the current working
                directory.

        Raises:
            WorkspaceError: If no root is configured, or a named root does not
                exist or is not a directory. Failing at startup is better than
                accepting every later call and refusing it for a reason the
                client cannot see.
        """
        candidates = list(roots) if roots else _roots_from_env()
        resolved: list[Path] = []
        for candidate in candidates:
            root = Path(candidate).expanduser().resolve()
            if not root.is_dir():
                raise WorkspaceError(f"Workspace root is not a directory: {root}")
            resolved.append(root)
        # A separators-only `GEOLIBRE_MCP_ROOTS` (":") survives the emptiness
        # check in `_roots_from_env` and filters down to nothing here. Without
        # this, `resolve` would raise IndexError on the first relative path.
        if not resolved:
            raise WorkspaceError(
                f"No workspace roots configured. Pass --root or set {ROOTS_ENV_VAR}."
            )
        self.roots = tuple(resolved)

    def __repr__(self) -> str:
        return f"Workspace({', '.join(str(root) for root in self.roots)})"

    def resolve(self, path: str | Path, *, must_exist: bool = False) -> Path:
        """Resolve a client-supplied path, confining it to the workspace.

        A relative path is interpreted against the first root, so a client that
        knows nothing about the host's layout can still say ``"maps/city.json"``.

        Args:
            path: The path from the tool call.
            must_exist: Require the resolved path to be an existing file.

        Returns:
            The absolute, symlink-resolved path.

        Raises:
            WorkspaceError: If the path escapes every root, or ``must_exist`` is
                set and it is not a file.
        """
        raw = Path(str(path)).expanduser()
        if not raw.is_absolute():
            raw = self.roots[0] / raw
        # resolve() follows symlinks, so a link planted inside a root that points
        # outside it resolves to its target and fails the containment check
        # below. strict=False keeps a not-yet-created output path resolvable.
        target = raw.resolve()
        if not any(target == root or root in target.parents for root in self.roots):
            allowed = ", ".join(str(root) for root in self.roots)
            raise WorkspaceError(
                f"Path {target} is outside this server's workspace. Allowed roots: {allowed}. "
                f"Set {ROOTS_ENV_VAR} to widen it."
            )
        if must_exist and not target.is_file():
            raise WorkspaceError(f"File not found: {target}")
        return target

    def resolve_output(
        self, path: str | Path, *, suffixes: tuple[str, ...], overwrite: bool = False
    ) -> Path:
        """Resolve a path the server is about to write, checking its extension.

        Args:
            path: The destination path from the tool call.
            suffixes: Allowed file extensions.
            overwrite: Permit replacing an existing file.

        Returns:
            The absolute, symlink-resolved destination.

        Raises:
            WorkspaceError: If the path escapes the workspace, has an
                unsupported extension, or exists while ``overwrite`` is False.
        """
        target = self.resolve(path)
        # `len(name) > len(suffix)` requires a non-empty stem, so a bare dotfile
        # named exactly `.json` or `.html` is refused rather than accepted.
        if not any(
            target.name.endswith(suffix) and len(target.name) > len(suffix) for suffix in suffixes
        ):
            raise WorkspaceError(
                f"Refusing to write {target.name}: expected a file ending in "
                f"{' or '.join(suffixes)}."
            )
        if target.exists() and not overwrite:
            raise WorkspaceError(f"{target} already exists. Pass overwrite=true to replace it.")
        return target


def _roots_from_env() -> list[str]:
    """Read the configured roots, defaulting to the current directory."""
    configured = os.environ.get(ROOTS_ENV_VAR, "").strip()
    if not configured:
        return [os.getcwd()]
    return [part for part in configured.split(os.pathsep) if part.strip()]
