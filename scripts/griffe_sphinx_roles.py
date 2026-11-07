"""Griffe extension that renders Sphinx roles in docstrings as inline code.

The ``geolibre`` package's docstrings are Google style, but many of them
reference other objects with Sphinx roles (``:meth:`to_project```,
``:func:`~geolibre.authoring.load_project```). mkdocstrings renders Markdown, so
those roles would otherwise show up verbatim in the Python API reference. This
extension rewrites each role to its target in backticks, honouring the ``~``
prefix (show only the last component), and turns a reST ``::`` literal-block
marker at the end of a line into a plain colon.

It is loaded by the mkdocstrings handler in ``mkdocs.yml``; the package source
is left untouched.
"""

from __future__ import annotations

import re
from typing import Any

import griffe

_ROLE = re.compile(r":(?:py:)?(?:attr|class|data|exc|func|meth|mod|obj):`(~?)([^`]+)`")
_LITERAL_MARKER = re.compile(r"(?<=\S)::$", re.MULTILINE)


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
    text = _ROLE.sub(_replace_role, text)
    return _LITERAL_MARKER.sub(":", text)


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
