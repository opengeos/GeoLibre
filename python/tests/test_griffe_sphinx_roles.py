"""Tests for the docs build's griffe extension (scripts/griffe_sphinx_roles.py).

The extension lives outside the package, so it is loaded from its file. griffe
is only a docs-build dependency, so a stub stands in when it is not installed:
only :func:`convert` is under test.
"""

import importlib.util
import sys
import types
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "griffe_sphinx_roles.py"


@pytest.fixture(scope="module")
def convert():
    """Load the extension module and return its ``convert`` function.

    Returns:
        The module's ``convert`` function.
    """
    if importlib.util.find_spec("griffe") is None:
        stub = types.ModuleType("griffe")
        stub.Extension = object
        stub.Object = object
        sys.modules.setdefault("griffe", stub)
    spec = importlib.util.spec_from_file_location("griffe_sphinx_roles", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.convert


def test_roles_become_inline_code(convert):
    """Each Sphinx role renders as its target in backticks."""
    text = "Call :meth:`to_project` or :func:`geolibre.authoring.load_project`."
    assert convert(text) == "Call `to_project` or `geolibre.authoring.load_project`."


def test_tilde_keeps_the_last_component(convert):
    """The ``~`` prefix shortens the target to its last dotted component."""
    assert convert(":class:`~geolibre.geolibre.Map`") == "`Map`"


def test_py_domain_prefix(convert):
    """``:py:``-prefixed roles are handled like bare ones."""
    assert convert(":py:attr:`Layer.id`") == "`Layer.id`"


def test_role_does_not_span_lines(convert):
    """An unterminated role is left alone instead of swallowing the next line."""
    text = "a :meth:`broken\nnext `line`"
    assert convert(text) == text


def test_literal_block_marker(convert):
    """A reST ``::`` marker before a blank line becomes a colon."""
    text = "Run it over stdio::\n\n    geolibre-mcp --root ~/maps"
    assert convert(text) == "Run it over stdio:\n\n    geolibre-mcp --root ~/maps"


def test_double_colon_left_alone_elsewhere(convert):
    """``::`` mid-paragraph or inside a fenced block is not rewritten."""
    assert convert("uses std::\nvector") == "uses std::\nvector"
    fenced = "```\nExample::\n\n```"
    assert convert(fenced) == fenced


def test_idempotent(convert):
    """Converting twice gives the same result as converting once."""
    text = "See :meth:`~a.b.c` here::\n\n    code"
    assert convert(convert(text)) == convert(text)
