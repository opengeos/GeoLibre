"""Run the shared vector-tool golden fixtures against the Python engine.

The fixtures in ``tests/fixtures/vector/cases`` are a language-neutral contract
shared with the TypeScript/Turf.js client engine (driven by
``tests/vector-golden.test.ts``). Both engines must satisfy the same cases, so
divergence between the two hand-synced implementations is caught here in CI.

See ``tests/fixtures/vector/SPEC.md`` for the case schema and the two tiers of
agreement (exact vs structural). The matcher below mirrors the one in the TS
harness; keep the two in sync.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Optional

import pytest

from geolibre_server.vector_ops import run_vector_tool

try:
    import geopandas  # noqa: F401

    HAS_GEOPANDAS = True
except Exception:  # pragma: no cover - depends on the optional extra
    HAS_GEOPANDAS = False


# tests/fixtures/vector/cases relative to the repo root (…/backend/
# geolibre_server/tests/test_vector_golden.py -> parents[3] is the repo root).
_CASES_DIR = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "vector" / "cases"


# Fail loudly if the repo layout changes and the parents[3] path no longer
# resolves, rather than silently skipping the whole suite (green CI, nothing
# exercised). When the `tests` tree exists but the fixtures dir does not, the
# path calculation is wrong; when neither exists (e.g. the package is tested in
# isolation, unpacked away from the JS repo) the suite skips cleanly below.
assert _CASES_DIR.is_dir() or not _CASES_DIR.parents[2].is_dir(), (
    f"Expected fixture directory not found: {_CASES_DIR}. "
    "Check the parents[3] path calculation if this test file was moved."
)


def _load_cases() -> list[dict]:
    if not _CASES_DIR.is_dir():
        return []
    cases = []
    for path in sorted(_CASES_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as fh:
            case = json.load(fh)
        case.setdefault("name", path.stem)
        cases.append(case)
    return cases


_CASES = _load_cases()


# --- matcher (mirror of the TS harness) -----------------------------------


def _almost_equal(a: Any, b: Any, tol: float) -> bool:
    """Numbers compare within ``tol``; everything else compares structurally."""
    # Treat booleans strictly so this matches the TS harness, where `true === 1`
    # is `false`. (In Python `bool` subclasses `int`, so a naive `True == 1`
    # would diverge.) A bool only equals another bool of the same value.
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if math.isnan(a) and math.isnan(b):
            return True
        return abs(a - b) <= tol
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            return False
        return all(_almost_equal(a[k], b[k], tol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_almost_equal(x, y, tol) for x, y in zip(a, b))
    return a == b


def _multiset_equal(actual: list, expected: list, tol: float) -> bool:
    """Compare two lists ignoring order, matching each element within ``tol``."""
    if len(actual) != len(expected):
        return False
    remaining = list(actual)
    for want in expected:
        for i, have in enumerate(remaining):
            if _almost_equal(have, want, tol):
                del remaining[i]
                break
        else:
            return False
    return True


def _geometries_equal(a: Optional[dict], b: Optional[dict], tol: float) -> bool:
    if a is None or b is None:
        return a == b
    if a.get("type") != b.get("type"):
        return False
    # A GeometryCollection has no `coordinates` — recurse into its `geometries`
    # so nested parts are compared with tolerance too (and two collections are
    # not silently accepted as equal). Mirrors the TS harness.
    if a.get("type") == "GeometryCollection":
        sub_a = a.get("geometries") or []
        sub_b = b.get("geometries") or []
        return len(sub_a) == len(sub_b) and all(
            _geometries_equal(ga, gb, tol) for ga, gb in zip(sub_a, sub_b)
        )
    return _almost_equal(a.get("coordinates"), b.get("coordinates"), tol)


def _bbox(features: list[dict]) -> Optional[list[float]]:
    xs: list[float] = []
    ys: list[float] = []

    def walk(coords: Any) -> None:
        if (
            isinstance(coords, list)
            and len(coords) >= 2
            and isinstance(coords[0], (int, float))
            and isinstance(coords[1], (int, float))
        ):
            xs.append(float(coords[0]))
            ys.append(float(coords[1]))
        elif isinstance(coords, list):
            for c in coords:
                walk(c)

    for feat in features:
        geom = feat.get("geometry")
        if geom:
            walk(geom.get("coordinates"))
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def _assert_match(name: str, result: dict, expect: dict) -> None:
    tol = float(expect.get("tolerance") or 1e-9)
    features = result.get("features") or []

    if expect.get("featureCount") is not None:
        assert len(features) == expect["featureCount"], (
            f"{name}: featureCount {len(features)} != {expect['featureCount']}"
        )

    if expect.get("geometryTypes") is not None:
        actual_types = sorted((f.get("geometry") or {}).get("type", "null") for f in features)
        assert actual_types == sorted(expect["geometryTypes"]), (
            f"{name}: geometryTypes {actual_types} != {sorted(expect['geometryTypes'])}"
        )

    if expect.get("properties") is not None:
        actual_props = [f.get("properties") or {} for f in features]
        assert _multiset_equal(actual_props, expect["properties"], tol), (
            f"{name}: properties mismatch\n  actual:   {actual_props}\n"
            f"  expected: {expect['properties']}"
        )

    if expect.get("geometry") is not None:
        want = expect["geometry"]
        assert len(features) == len(want), f"{name}: geometry length {len(features)} != {len(want)}"
        for i, (feat, geom) in enumerate(zip(features, want)):
            assert _geometries_equal(feat.get("geometry"), geom, tol), (
                f"{name}: geometry[{i}] mismatch\n  actual:   {feat.get('geometry')}\n"
                f"  expected: {geom}"
            )

    if expect.get("bbox") is not None:
        actual_bbox = _bbox(features)
        assert actual_bbox is not None, f"{name}: expected a bbox but output is empty"
        assert all(abs(a - b) <= tol for a, b in zip(actual_bbox, expect["bbox"])), (
            f"{name}: bbox {actual_bbox} != {expect['bbox']} (tol {tol})"
        )


# --- the test -------------------------------------------------------------


@pytest.mark.skipif(not _CASES, reason="shared vector fixtures not found")
@pytest.mark.skipif(not HAS_GEOPANDAS, reason="geopandas optional extra not installed")
@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["name"])
def test_vector_golden(case: dict) -> None:
    name = case["name"]
    expect = case.get("expect") or {}
    args = (
        case["tool"],
        case.get("input"),
        case.get("overlay"),
        case.get("parameters") or {},
    )

    if expect.get("error"):
        # VectorInputTooLarge subclasses ValueError, so ValueError covers both.
        with pytest.raises(ValueError):
            run_vector_tool(*args)
        return

    result, _messages = run_vector_tool(*args)
    _assert_match(name, result, expect)
