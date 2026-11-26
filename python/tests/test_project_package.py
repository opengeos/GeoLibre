"""The geolibre.project package re-exports every name its submodules define."""

from __future__ import annotations

import ast
import importlib
import pkgutil
from pathlib import Path

import pytest

from geolibre import project

SUBMODULES = sorted(info.name for info in pkgutil.iter_modules(project.__path__))


def _defined_names(module_name: str) -> list[str]:
    """Return the top-level names a submodule defines (not imports).

    Args:
        module_name: Name of a submodule of ``geolibre.project``.

    Returns:
        The names bound by top-level ``def``, ``class`` and assignments.
    """
    path = Path(project.__file__).with_name(f"{module_name}.py")
    names = []
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                elts = target.elts if isinstance(target, ast.Tuple) else [target]
                names.extend(t.id for t in elts if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.append(node.target.id)
    return names


def test_the_package_has_submodules():
    """Guard the parity test against an empty module list."""
    assert "layers" in SUBMODULES and "services" in SUBMODULES


@pytest.mark.parametrize("module_name", SUBMODULES)
def test_every_submodule_name_is_reexported(module_name):
    """``geolibre.project.<name>`` keeps resolving for every submodule name.

    Args:
        module_name: Name of a submodule of ``geolibre.project``.
    """
    module = importlib.import_module(f"geolibre.project.{module_name}")
    missing = [
        name
        for name in _defined_names(module_name)
        if getattr(project, name, None) is not getattr(module, name)
    ]
    assert not missing, f"geolibre.project does not re-export {missing} from {module_name}"
