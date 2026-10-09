"""Unit coverage for container sidecar capability enforcement."""

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "sidecar_policy", ROOT / "docker" / "sidecar_policy.py"
)
sp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sp)

PROCESSING = {"whitebox", "raster", "vector", "pointcloud", "obia", "ml", "sql"}


def test_route_ownership_contract():
    assert sp.ROUTE_CAPABILITIES == {
        **{prefix: frozenset({"processing:run"}) for prefix in PROCESSING},
        "postgis": frozenset({"data:add"}),
        "mssql": frozenset({"data:add"}),
        "conversion": frozenset({"processing:run", "data:add"}),
    }


@pytest.mark.parametrize(
    "capabilities,denied,start",
    [
        (None, set(), True),
        ([], PROCESSING | {"postgis", "mssql", "conversion"}, False),
        (["export:data"], PROCESSING | {"postgis", "mssql", "conversion"}, False),
        (["data:add"], PROCESSING, True),
        (["processing:run"], {"postgis", "mssql"}, True),
        (["processing:run", "data:add"], set(), True),
        (["project:edit", "sharing:embed"], PROCESSING | {"postgis", "mssql", "conversion"}, False),
    ],
)
def test_capability_matrix(capabilities, denied, start):
    policy = {"version": 1}
    if capabilities is not None:
        policy["capabilities"] = capabilities
    guards, off, should_start = sp.generate_snippets(policy)
    assert should_start is start
    for prefix in sp.ROUTE_CAPABILITIES:
        assert (f"location ^~ /sidecar/{prefix} {{" in guards) == (prefix in denied)
    assert guards.count("return 403") == len(denied)
    assert ("return 403" in off) == (not start)
    for snippet in (guards, off):
        if "return 403" in snippet:
            assert "default_type application/json;" in snippet
            assert '"detail":' in snippet
    for prefix in sp.UNGUARDED_PREFIXES:
        assert f"location ^~ /sidecar/{prefix} {{" not in guards


@pytest.mark.parametrize(
    "policy", [{"version": 1}, {"version": 1, "capabilities": ["processing:run", "data:add"]}]
)
def test_disable_override_turns_unrestricted_sidecar_off(policy):
    _, off, start = sp.generate_snippets(policy, disabled=True)
    assert start is False
    assert "return 403" in off
    assert "default_type application/json;" in off
