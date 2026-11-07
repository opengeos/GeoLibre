"""Griffe extension that renders Sphinx roles in docstrings as inline code.

The ``geolibre`` package's docstrings are Google style, but many of them
reference other objects with Sphinx roles (``:meth:`to_project```,
``:func:`~geolibre.authoring.load_project```). mkdocstrings renders Markdown, so
those roles would otherwise show up verbatim in the Python API reference. This
extension rewrites each role to its target in backticks, honouring the ``~``
prefix (show only the last component), and turns a reST ``::`` literal-block
marker (a line ending in ``word::`` followed by a blank line, outside a fenced
code block) into a plain colon.

Roles become inline code rather than mkdocstrings cross-reference links on
purpose: many targets are relative (``:meth:`to_project```) and would need
resolving against the object's scope, and any target autorefs cannot resolve
fails ``zensical build --strict``.

It is loaded by the mkdocstrings handler in ``mkdocs.yml``; the package source
is left untouched.
"""

from __future__ import annotations

import re
from typing import Any

import griffe

_ROLE = re.compile(r":(?:py:)?(?:attr|class|data|exc|func|meth|mod|obj):`(~?)([^`\n]+)`")
_LITERAL_MARKER = re.compile(r"(?<=[A-Za-z])::$")
_FENCE = re.compile(r"^\s*(```|~~~)")


def _replace_role(match: re.Match[str]) -> str:
    """Render one Sphinx role as inline code.

    Args:
        match: A match of ``_ROLE``.

    Returns:
        The role's target in backticks, shortened to its last dotted component
        when the role used the ``~`` prefix.
    """
    short, target = match.group(1), match.group(2).strip()
    if short:
        target = target.rsplit(".", 1)[-1]
    return f"`{target}`"


def convert(text: str) -> str:
    """Rewrite the Sphinx markup in one docstring as Markdown.

    Args:
        text: The raw docstring.

    Returns:
        The docstring with roles as inline code and ``::`` markers as colons.
    """
    lines = _ROLE.sub(_replace_role, text).split("\n")
    in_fence = False
    for index, line in enumerate(lines):
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        next_blank = index + 1 < len(lines) and not lines[index + 1].strip()
        if not in_fence and next_blank:
            lines[index] = _LITERAL_MARKER.sub(":", line)
    return "\n".join(lines)


class SphinxRoles(griffe.Extension):
    """Convert Sphinx roles in every loaded docstring to inline code."""

    def on_instance(self, *, obj: griffe.Object, **kwargs: Any) -> None:
        """Rewrite the docstring of each object griffe loads.

        Args:
            obj: The object griffe just loaded.
            **kwargs: Other hook arguments, unused.
        """
        if obj.docstring is not None:
            obj.docstring.value = convert(obj.docstring.value)
