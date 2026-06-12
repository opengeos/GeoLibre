"""Tests for the framework-free vector_ops module.

These lock the contract the in-browser Pyodide engine depends on:
:func:`run_vector_tool` returns ``(feature_collection, messages)`` and raises
plain ``ValueError`` / :class:`VectorInputTooLarge` (never ``HTTPException``) on
bad input, and :func:`run_vector_tool_json` round-trips through JSON strings.
"""

import json

import pytest

from geolibre_server import vector_ops
from geolibre_server.vector_ops import (
    VectorInputTooLarge,
    run_vector_tool,
    run_vector_tool_json,
)

try:
    import geopandas  # noqa: F401

    HAS_GEOPANDAS = True
except Exception:  # pragma: no cover - depends on the optional extra
    HAS_GEOPANDAS = False

requires_geopandas = pytest.mark.skipif(
    not HAS_GEOPANDAS, reason="geopandas optional extra not installed"
)


def _square(name: str, x: float = 0.0, y: float = 0.0) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": name},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [x, y],
                            [x, y + 1],
                            [x + 1, y + 1],
                            [x + 1, y],
                            [x, y],
                        ]
                    ],
                },
            }
        ],
    }


SQUARE = _square("a")
OVERLAP = _square("b", x=0.5, y=0.5)
DISJOINT = _square("c", x=10.0, y=10.0)
EMPTY = {"type": "FeatureCollection", "features": []}


def test_unknown_tool_raises_value_error() -> None:
    with pytest.raises(ValueError, match="Unknown vector tool"):
        run_vector_tool("nonsense", SQUARE)


def test_oversized_input_raises_too_large(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vector_ops, "MAX_FEATURES", 2)
    big = {"type": "FeatureCollection", "features": [{}, {}, {}]}
    with pytest.raises(VectorInputTooLarge):
        run_vector_tool("buffer", big)
    # It is a ValueError subclass so generic callers still catch it.
    assert issubclass(VectorInputTooLarge, ValueError)


@requires_geopandas
def test_buffer_returns_feature_collection_and_messages() -> None:
    geojson, messages = run_vector_tool(
        "buffer", SQUARE, parameters={"distance": 1, "units": "kilometers"}
    )
    assert geojson["type"] == "FeatureCollection"
    assert len(geojson["features"]) == 1
    assert messages and "Buffered" in messages[0]


@requires_geopandas
def test_centroids_exercises_pyproj_utm_path() -> None:
    # centroids/buffer call estimate_utm_crs(), which needs pyproj's PROJ data;
    # this guards that path that the Pyodide engine also relies on.
    geojson, _ = run_vector_tool("centroids", SQUARE)
    assert geojson["type"] == "FeatureCollection"
    assert geojson["features"][0]["geometry"]["type"] == "Point"


@requires_geopandas
@pytest.mark.parametrize("tool_id", ["clip", "intersection", "difference", "union"])
def test_overlay_tools(tool_id: str) -> None:
    geojson, _ = run_vector_tool(tool_id, SQUARE, OVERLAP)
    assert geojson["type"] == "FeatureCollection"
    assert len(geojson["features"]) >= 1


@requires_geopandas
def test_spatial_join_attaches_join_attributes() -> None:
    geojson, messages = run_vector_tool(
        "spatial-join",
        SQUARE,
        OVERLAP,
        parameters={"predicate": "intersects", "how": "inner"},
    )
    assert geojson["type"] == "FeatureCollection"
    assert len(geojson["features"]) == 1
    props = geojson["features"][0]["properties"]
    # Both layers carry a "name" column, so gpd.sjoin suffixes the collision.
    assert props.get("name_left") == "a"
    assert props.get("name_right") == "b"
    assert "index_right" not in props
    assert messages and "Spatial join" in messages[0]


@requires_geopandas
def test_spatial_join_left_keeps_unmatched_input() -> None:
    geojson, _ = run_vector_tool(
        "spatial-join", SQUARE, DISJOINT, parameters={"how": "left"}
    )
    assert len(geojson["features"]) == 1


@requires_geopandas
def test_spatial_join_inner_drops_unmatched_input() -> None:
    geojson, _ = run_vector_tool(
        "spatial-join", SQUARE, DISJOINT, parameters={"how": "inner"}
    )
    assert geojson["features"] == []


@requires_geopandas
def test_spatial_join_empty_join_layer_left_keeps_input() -> None:
    geojson, _ = run_vector_tool("spatial-join", SQUARE, EMPTY, parameters={"how": "left"})
    assert len(geojson["features"]) == 1


@requires_geopandas
def test_spatial_join_empty_join_layer_inner_is_empty() -> None:
    geojson, _ = run_vector_tool(
        "spatial-join", SQUARE, EMPTY, parameters={"how": "inner"}
    )
    assert geojson["features"] == []


@requires_geopandas
def test_spatial_join_invalid_predicate_raises_value_error() -> None:
    with pytest.raises(ValueError, match="predicate"):
        run_vector_tool(
            "spatial-join", SQUARE, OVERLAP, parameters={"predicate": "bogus"}
        )


@requires_geopandas
def test_dissolve_unknown_field_raises_value_error() -> None:
    with pytest.raises(ValueError, match="not found"):
        run_vector_tool("dissolve", SQUARE, parameters={"field": "missing"})


@requires_geopandas
def test_json_wrapper_round_trips() -> None:
    payload = json.dumps(
        {
            "tool_id": "buffer",
            "geojson": SQUARE,
            "parameters": {"distance": 1, "units": "kilometers"},
        }
    )
    result = json.loads(run_vector_tool_json(payload))
    assert set(result) == {"geojson", "messages"}
    assert result["geojson"]["type"] == "FeatureCollection"
    assert isinstance(result["messages"], list)
