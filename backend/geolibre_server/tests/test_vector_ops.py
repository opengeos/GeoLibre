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
POINT_IN_SQUARE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "p"},
            "geometry": {"type": "Point", "coordinates": [0.5, 0.5]},
        }
    ],
}


def _attr_point(name: str, pop, x: float) -> dict:
    return {
        "type": "Feature",
        "properties": {"name": name, "pop": pop},
        "geometry": {"type": "Point", "coordinates": [x, 0.0]},
    }


# Attribute layer for Select by value: numeric "pop" with both a null (gamma) and
# a feature that omits the key entirely (delta), plus a string "name".
ATTR_LAYER = {
    "type": "FeatureCollection",
    "features": [
        _attr_point("alpha", 10, 0.0),
        _attr_point("beta", 20, 1.0),
        _attr_point("gamma", None, 2.0),
        {
            "type": "Feature",
            "properties": {"name": "delta"},  # no "pop" key at all
            "geometry": {"type": "Point", "coordinates": [3.0, 0.0]},
        },
    ],
}


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
def test_spatial_join_within_predicate_matches() -> None:
    # The point lies within the square, so a within-join (point -> square) matches.
    geojson, _ = run_vector_tool(
        "spatial-join", POINT_IN_SQUARE, SQUARE, parameters={"predicate": "within"}
    )
    assert len(geojson["features"]) == 1
    assert geojson["features"][0]["properties"].get("name_right") == "a"


@requires_geopandas
def test_spatial_join_contains_predicate_matches() -> None:
    # The square contains the point, so a contains-join (square -> point) matches.
    geojson, _ = run_vector_tool(
        "spatial-join", SQUARE, POINT_IN_SQUARE, parameters={"predicate": "contains"}
    )
    assert len(geojson["features"]) == 1
    assert geojson["features"][0]["properties"].get("name_left") == "a"


@requires_geopandas
def test_spatial_join_invalid_predicate_raises_value_error() -> None:
    with pytest.raises(ValueError, match="predicate"):
        run_vector_tool(
            "spatial-join", SQUARE, OVERLAP, parameters={"predicate": "bogus"}
        )


@requires_geopandas
def test_spatial_join_invalid_how_raises_value_error() -> None:
    with pytest.raises(ValueError, match="join type"):
        run_vector_tool("spatial-join", SQUARE, OVERLAP, parameters={"how": "outer"})


# --- Select by value (pure attribute filter; no GeoPandas required) ---


def test_select_by_value_numeric_comparison() -> None:
    geojson, messages = run_vector_tool(
        "select-by-value",
        ATTR_LAYER,
        parameters={"field": "pop", "operator": "gt", "value": "15"},
    )
    names = [f["properties"]["name"] for f in geojson["features"]]
    assert names == ["beta"]
    assert messages and "1 of 4" in messages[0]


def test_select_by_value_string_equals() -> None:
    geojson, _ = run_vector_tool(
        "select-by-value",
        ATTR_LAYER,
        parameters={"field": "name", "operator": "eq", "value": "alpha"},
    )
    assert [f["properties"]["name"] for f in geojson["features"]] == ["alpha"]


def test_select_by_value_contains_is_case_insensitive() -> None:
    geojson, _ = run_vector_tool(
        "select-by-value",
        ATTR_LAYER,
        parameters={"field": "name", "operator": "contains", "value": "ET"},
    )
    assert [f["properties"]["name"] for f in geojson["features"]] == ["beta"]


def test_select_by_value_is_null_matches_null_and_missing() -> None:
    # gamma has pop=None and delta omits the key entirely; both are "empty".
    geojson, _ = run_vector_tool(
        "select-by-value", ATTR_LAYER, parameters={"field": "pop", "operator": "is-null"}
    )
    names = sorted(f["properties"]["name"] for f in geojson["features"])
    assert names == ["delta", "gamma"]


def test_select_by_value_is_null_matches_empty_string() -> None:
    layer = {
        "type": "FeatureCollection",
        "features": [_attr_point("", 1, 0.0), _attr_point("named", 1, 1.0)],
    }
    geojson, _ = run_vector_tool(
        "select-by-value", layer, parameters={"field": "name", "operator": "is-null"}
    )
    assert [f["properties"]["name"] for f in geojson["features"]] == [""]


def test_select_by_value_unknown_operator_raises() -> None:
    with pytest.raises(ValueError, match="operator"):
        run_vector_tool(
            "select-by-value",
            ATTR_LAYER,
            parameters={"field": "pop", "operator": "bogus", "value": "1"},
        )


def test_select_by_value_absent_field_runs_schemaless() -> None:
    # A field absent from every feature is all-empty, not an error: eq matches
    # nothing while is-null matches every feature.
    none_geojson, _ = run_vector_tool(
        "select-by-value",
        ATTR_LAYER,
        parameters={"field": "missing", "operator": "eq", "value": "x"},
    )
    assert none_geojson["features"] == []
    all_geojson, _ = run_vector_tool(
        "select-by-value",
        ATTR_LAYER,
        parameters={"field": "missing", "operator": "is-null"},
    )
    assert len(all_geojson["features"]) == len(ATTR_LAYER["features"])


def test_select_by_value_missing_value_raises() -> None:
    with pytest.raises(ValueError, match="value is required"):
        run_vector_tool(
            "select-by-value", ATTR_LAYER, parameters={"field": "pop", "operator": "eq"}
        )


# --- Select by location ---


@requires_geopandas
def test_select_by_location_intersects() -> None:
    geojson, messages = run_vector_tool(
        "select-by-location", SQUARE, OVERLAP, parameters={"predicate": "intersects"}
    )
    assert len(geojson["features"]) == 1
    assert messages and "1 of 1" in messages[0]


@requires_geopandas
def test_select_by_location_disjoint_selects_non_overlapping() -> None:
    geojson, _ = run_vector_tool(
        "select-by-location", SQUARE, DISJOINT, parameters={"predicate": "disjoint"}
    )
    assert len(geojson["features"]) == 1


@requires_geopandas
def test_select_by_location_intersects_disjoint_layer_selects_none() -> None:
    geojson, _ = run_vector_tool(
        "select-by-location", SQUARE, DISJOINT, parameters={"predicate": "intersects"}
    )
    assert geojson["features"] == []


@requires_geopandas
def test_select_by_location_empty_filter_disjoint_keeps_all() -> None:
    geojson, _ = run_vector_tool(
        "select-by-location", SQUARE, EMPTY, parameters={"predicate": "disjoint"}
    )
    assert len(geojson["features"]) == 1


@requires_geopandas
def test_select_by_location_unknown_predicate_raises() -> None:
    with pytest.raises(ValueError, match="predicate"):
        run_vector_tool(
            "select-by-location", SQUARE, OVERLAP, parameters={"predicate": "bogus"}
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
