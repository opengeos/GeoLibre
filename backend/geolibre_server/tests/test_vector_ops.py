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
    geojson, _ = run_vector_tool("spatial-join", SQUARE, DISJOINT, parameters={"how": "left"})
    assert len(geojson["features"]) == 1


@requires_geopandas
def test_spatial_join_inner_drops_unmatched_input() -> None:
    geojson, _ = run_vector_tool("spatial-join", SQUARE, DISJOINT, parameters={"how": "inner"})
    assert geojson["features"] == []


@requires_geopandas
def test_spatial_join_empty_join_layer_left_keeps_input() -> None:
    geojson, _ = run_vector_tool("spatial-join", SQUARE, EMPTY, parameters={"how": "left"})
    assert len(geojson["features"]) == 1


@requires_geopandas
def test_spatial_join_empty_join_layer_inner_is_empty() -> None:
    geojson, _ = run_vector_tool("spatial-join", SQUARE, EMPTY, parameters={"how": "inner"})
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
        run_vector_tool("spatial-join", SQUARE, OVERLAP, parameters={"predicate": "bogus"})


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
        "select-by-value",
        ATTR_LAYER,
        parameters={"field": "pop", "operator": "is-null"},
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


def test_select_by_value_neq_excludes_null_and_missing() -> None:
    # SQL-like: neq does not match null (gamma) or missing (delta) values.
    geojson, _ = run_vector_tool(
        "select-by-value",
        ATTR_LAYER,
        parameters={"field": "pop", "operator": "neq", "value": "10"},
    )
    assert sorted(f["properties"]["name"] for f in geojson["features"]) == ["beta"]


def test_select_by_value_is_not_null_matches_real_values() -> None:
    geojson, _ = run_vector_tool(
        "select-by-value",
        ATTR_LAYER,
        parameters={"field": "pop", "operator": "is-not-null"},
    )
    names = sorted(f["properties"]["name"] for f in geojson["features"])
    assert names == ["alpha", "beta"]


@pytest.mark.parametrize(
    ("operator", "value", "expected"),
    [
        ("neq", "alpha", ["beta", "delta", "gamma"]),
        ("starts-with", "AL", ["alpha"]),
        ("gte", "20", ["beta"]),
        ("lt", "20", ["alpha"]),
        ("lte", "10", ["alpha"]),
    ],
)
def test_select_by_value_operators(operator, value, expected) -> None:
    field = "name" if operator in ("neq", "starts-with") else "pop"
    geojson, _ = run_vector_tool(
        "select-by-value",
        ATTR_LAYER,
        parameters={"field": field, "operator": operator, "value": value},
    )
    assert sorted(f["properties"]["name"] for f in geojson["features"]) == expected


def test_select_by_value_hexlike_string_compared_as_text() -> None:
    # "0x10" must not be coerced to 16 (Python float() rejects it); the client
    # engine matches via parseFiniteNumber, so both compare it as text.
    layer = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"code": "0x10"},
                "geometry": {"type": "Point", "coordinates": [0.0, 0.0]},
            }
        ],
    }
    miss, _ = run_vector_tool(
        "select-by-value",
        layer,
        parameters={"field": "code", "operator": "eq", "value": "16"},
    )
    assert miss["features"] == []
    hit, _ = run_vector_tool(
        "select-by-value",
        layer,
        parameters={"field": "code", "operator": "eq", "value": "0x10"},
    )
    assert len(hit["features"]) == 1


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


# --- Attribute join (no GeoPandas; pure attribute merge) ---


def _attr_join_feature(props: dict, x: float = 0.0) -> dict:
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": "Point", "coordinates": [x, x]},
    }


# Counties keyed by GEOID; "1003" is stored as a number to exercise the
# string/number key coercion, and "09999" has no matching stats row.
JOIN_COUNTIES = {
    "type": "FeatureCollection",
    "features": [
        _attr_join_feature({"GEOID": "01001"}, 0.0),
        _attr_join_feature({"GEOID": 1003}, 1.0),
        _attr_join_feature({"GEOID": "09999"}, 2.0),
    ],
}
# Stats table: two rows share key "1003" (first wins); geometry is ignored.
JOIN_STATS = {
    "type": "FeatureCollection",
    "features": [
        _attr_join_feature({"code": "01001", "pop": 100, "label": "Autauga"}),
        _attr_join_feature({"code": "1003", "pop": 200, "label": "Barbour"}),
        _attr_join_feature({"code": "1003", "pop": 999, "label": "DUPLICATE"}),
    ],
}


def test_attribute_join_left_keeps_all_and_null_fills_unmatched() -> None:
    geojson, messages = run_vector_tool(
        "attribute-join",
        JOIN_COUNTIES,
        JOIN_STATS,
        parameters={"target_field": "GEOID", "join_field": "code", "how": "left"},
    )
    features = geojson["features"]
    assert len(features) == 3
    by_geoid = {f["properties"]["GEOID"]: f["properties"] for f in features}
    assert by_geoid["01001"]["pop"] == 100
    assert by_geoid["01001"]["label"] == "Autauga"
    # Numeric key 1003 matches the string "1003"; the first duplicate row wins.
    assert by_geoid[1003]["pop"] == 200
    assert by_geoid[1003]["label"] == "Barbour"
    # The default field set excludes the join key, so "code" is not copied over.
    assert "code" not in by_geoid[1003]
    # Unmatched row null-fills the brought-over columns (consistent schema).
    assert by_geoid["09999"]["pop"] is None
    assert by_geoid["09999"]["label"] is None
    assert messages and "2 of 3 feature(s) matched" in messages[-1]


def test_attribute_join_inner_drops_unmatched_and_honours_field_list() -> None:
    geojson, _ = run_vector_tool(
        "attribute-join",
        JOIN_COUNTIES,
        JOIN_STATS,
        parameters={
            "target_field": "GEOID",
            "join_field": "code",
            "how": "inner",
            "fields": "pop",
        },
    )
    features = geojson["features"]
    assert len(features) == 2
    barbour = next(f for f in features if f["properties"]["GEOID"] == 1003)
    assert barbour["properties"]["pop"] == 200
    # Only "pop" was requested, so "label" is not brought over.
    assert "label" not in barbour["properties"]


def test_attribute_join_empty_join_layer_left_keeps_input_unchanged() -> None:
    geojson, _ = run_vector_tool(
        "attribute-join",
        JOIN_COUNTIES,
        EMPTY,
        parameters={"target_field": "GEOID", "join_field": "code", "how": "left"},
    )
    assert len(geojson["features"]) == len(JOIN_COUNTIES["features"])


def test_attribute_join_empty_join_layer_inner_is_empty() -> None:
    geojson, _ = run_vector_tool(
        "attribute-join",
        JOIN_COUNTIES,
        EMPTY,
        parameters={"target_field": "GEOID", "join_field": "code", "how": "inner"},
    )
    assert geojson["features"] == []


def test_attribute_join_unknown_how_raises() -> None:
    with pytest.raises(ValueError, match="Unknown join type"):
        run_vector_tool(
            "attribute-join",
            JOIN_COUNTIES,
            JOIN_STATS,
            parameters={
                "target_field": "GEOID",
                "join_field": "code",
                "how": "outer",
            },
        )


def test_attribute_join_blank_fields_string_brings_over_all() -> None:
    # A fields string that is only separators (e.g. ",") is treated as blank,
    # falling back to the default (every join field except the key) rather than
    # erroring with "none of the requested join fields".
    geojson, _ = run_vector_tool(
        "attribute-join",
        JOIN_COUNTIES,
        JOIN_STATS,
        parameters={
            "target_field": "GEOID",
            "join_field": "code",
            "how": "left",
            "fields": " , ",
        },
    )
    autauga = next(f for f in geojson["features"] if f["properties"]["GEOID"] == "01001")
    assert autauga["properties"]["pop"] == 100
    assert autauga["properties"]["label"] == "Autauga"


def test_attribute_join_missing_requested_fields_raises() -> None:
    with pytest.raises(ValueError, match="None of the requested join fields"):
        run_vector_tool(
            "attribute-join",
            JOIN_COUNTIES,
            JOIN_STATS,
            parameters={
                "target_field": "GEOID",
                "join_field": "code",
                "fields": "nonexistent",
            },
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
def test_select_by_location_within_and_contains() -> None:
    big = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "big"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[-5, -5], [-5, 5], [5, 5], [5, -5], [-5, -5]]],
                },
            }
        ],
    }
    # SQUARE (0..1) is within big; big is not within SQUARE.
    within, _ = run_vector_tool(
        "select-by-location", SQUARE, big, parameters={"predicate": "within"}
    )
    assert len(within["features"]) == 1
    none, _ = run_vector_tool("select-by-location", big, SQUARE, parameters={"predicate": "within"})
    assert none["features"] == []
    # big contains SQUARE.
    contains, _ = run_vector_tool(
        "select-by-location", big, SQUARE, parameters={"predicate": "contains"}
    )
    assert len(contains["features"]) == 1


@requires_geopandas
def test_select_by_location_empty_filter_intersects_selects_none() -> None:
    geojson, _ = run_vector_tool(
        "select-by-location", SQUARE, EMPTY, parameters={"predicate": "intersects"}
    )
    assert geojson["features"] == []


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
        run_vector_tool("select-by-location", SQUARE, OVERLAP, parameters={"predicate": "bogus"})


@requires_geopandas
def test_dissolve_unknown_field_raises_value_error() -> None:
    with pytest.raises(ValueError, match="not found"):
        run_vector_tool("dissolve", SQUARE, parameters={"field": "missing"})


# --- Reproject ---


@requires_geopandas
def test_reproject_web_mercator_to_wgs84() -> None:
    # A point at the eastern edge of Web Mercator (x ≈ 20037508.34) maps to
    # lon ≈ 180, lat ≈ 0 once reinterpreted as EPSG:3857 and sent to WGS84.
    mercator_point = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "edge"},
                "geometry": {
                    "type": "Point",
                    "coordinates": [20037508.342789244, 0.0],
                },
            }
        ],
    }
    geojson, messages = run_vector_tool(
        "reproject", mercator_point, parameters={"source_crs": "EPSG:3857"}
    )
    lon, lat = geojson["features"][0]["geometry"]["coordinates"]
    assert abs(lon - 180.0) < 1e-6
    assert abs(lat) < 1e-6
    assert messages and "Reprojected" in messages[0]


@requires_geopandas
def test_reproject_missing_source_crs_raises() -> None:
    with pytest.raises(ValueError, match="source CRS is required"):
        run_vector_tool("reproject", SQUARE, parameters={})


@requires_geopandas
def test_reproject_invalid_source_crs_raises() -> None:
    with pytest.raises(ValueError, match="Invalid source CRS"):
        run_vector_tool("reproject", SQUARE, parameters={"source_crs": "EPSG:bogus"})


# --- Explode ---


@requires_geopandas
def test_explode_splits_multipart_into_singlepart() -> None:
    multipolygon = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "mp"},
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
                        [[[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]]],
                    ],
                },
            }
        ],
    }
    geojson, messages = run_vector_tool("explode", multipolygon)
    assert len(geojson["features"]) == 2
    assert all(f["geometry"]["type"] == "Polygon" for f in geojson["features"])
    # Each part keeps the parent's attributes.
    assert all(f["properties"]["name"] == "mp" for f in geojson["features"])
    assert messages and "single-part" in messages[0]


# --- Aggregate by attribute ---


def _parcels() -> dict:
    def cell(region: str, pop: int, x: float) -> dict:
        return {
            "type": "Feature",
            "properties": {"region": region, "pop": pop},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[x, 0], [x, 1], [x + 1, 1], [x + 1, 0], [x, 0]]],
            },
        }

    return {
        "type": "FeatureCollection",
        "features": [cell("north", 10, 0), cell("north", 30, 1), cell("south", 5, 5)],
    }


@requires_geopandas
def test_aggregate_count_per_group() -> None:
    geojson, messages = run_vector_tool(
        "aggregate",
        _parcels(),
        parameters={"group_field": "region", "statistic": "count"},
    )
    by_region = {f["properties"]["region"]: f["properties"] for f in geojson["features"]}
    assert by_region["north"]["count"] == 2
    assert by_region["south"]["count"] == 1
    assert messages and "Aggregated" in messages[0]


@requires_geopandas
def test_aggregate_sum_names_column_field_stat() -> None:
    geojson, _ = run_vector_tool(
        "aggregate",
        _parcels(),
        parameters={"group_field": "region", "statistic": "sum", "stat_field": "pop"},
    )
    by_region = {f["properties"]["region"]: f["properties"] for f in geojson["features"]}
    assert by_region["north"]["pop_sum"] == 40
    assert by_region["south"]["pop_sum"] == 5


@requires_geopandas
def test_aggregate_requires_stat_field_for_non_count() -> None:
    with pytest.raises(ValueError, match="statistic field is required"):
        run_vector_tool(
            "aggregate",
            _parcels(),
            parameters={"group_field": "region", "statistic": "sum"},
        )


@requires_geopandas
def test_aggregate_unknown_group_field_raises() -> None:
    with pytest.raises(ValueError, match="Group field"):
        run_vector_tool(
            "aggregate",
            _parcels(),
            parameters={"group_field": "missing", "statistic": "count"},
        )


@requires_geopandas
def test_aggregate_counts_polygons_only_for_mixed_geometry() -> None:
    # A mixed layer (2 polygons + 1 point, all group "a") must count only the
    # polygons, matching the client engine's polygon-only restriction.
    poly = {
        "type": "Feature",
        "properties": {"region": "a", "pop": 10},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
        },
    }
    poly2 = {
        "type": "Feature",
        "properties": {"region": "a", "pop": 20},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[1, 0], [1, 1], [2, 1], [2, 0], [1, 0]]],
        },
    }
    point = {
        "type": "Feature",
        "properties": {"region": "a", "pop": 99},
        "geometry": {"type": "Point", "coordinates": [0.5, 0.5]},
    }
    mixed = {"type": "FeatureCollection", "features": [poly, poly2, point]}
    geojson, _ = run_vector_tool(
        "aggregate", mixed, parameters={"group_field": "region", "statistic": "count"}
    )
    assert len(geojson["features"]) == 1
    # Only the 2 polygons count; the point is excluded.
    assert geojson["features"][0]["properties"]["count"] == 2


@requires_geopandas
def test_aggregate_all_null_group_values_returns_empty_result() -> None:
    # Polygons exist but every group value is null: pandas groupby(dropna=True)
    # yields no groups, so the result is empty (not an error), matching the client.
    all_null = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"region": None, "pop": 1},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
                },
            },
            {
                "type": "Feature",
                "properties": {"region": None, "pop": 2},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[2, 0], [2, 1], [3, 1], [3, 0], [2, 0]]],
                },
            },
        ],
    }
    geojson, messages = run_vector_tool(
        "aggregate",
        all_null,
        parameters={"group_field": "region", "statistic": "count"},
    )
    assert geojson["features"] == []
    assert messages and "0 group(s)" in messages[0]


@requires_geopandas
def test_aggregate_geometry_group_field_raises_clean_error() -> None:
    # "geometry" is in gdf.columns but grouping by it would raise an unhashable
    # TypeError (a 500); it must be rejected as a clean "not found" (400) instead.
    with pytest.raises(ValueError, match="not found"):
        run_vector_tool(
            "aggregate",
            _parcels(),
            parameters={"group_field": "geometry", "statistic": "count"},
        )


# --- Smooth ---


def test_smooth_polygon_chaikin_exact_coordinates() -> None:
    # Smooth is pure coordinate math (no GeoPandas), so it runs unconditionally
    # and must match the client engine bit-for-bit on a known case.
    square = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "s"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]],
                    ],
                },
            }
        ],
    }
    geojson, messages = run_vector_tool("smooth", square, parameters={"iterations": 1})
    ring = geojson["features"][0]["geometry"]["coordinates"][0]
    # One Chaikin pass on the 4-vertex ring -> 8 cut points + the closing vertex.
    assert len(ring) == 9
    assert ring[0] == ring[-1]
    # The first cut point is 1/4 along the first segment ([0,0] -> [0,10]).
    assert ring[0] == [0, 2.5]
    assert geojson["features"][0]["geometry"]["type"] == "Polygon"
    assert geojson["features"][0]["properties"]["name"] == "s"
    assert messages and "Smoothed 1 feature" in messages[0]


def test_smooth_passes_points_through_unchanged() -> None:
    pts = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Point", "coordinates": [1, 2]},
            }
        ],
    }
    geojson, messages = run_vector_tool("smooth", pts, parameters={"iterations": 3})
    assert geojson["features"][0]["geometry"] == {"type": "Point", "coordinates": [1, 2]}
    # No line/polygon features were smoothed.
    assert messages and "Smoothed 0 feature" in messages[0]


def test_smooth_rejects_out_of_range_iterations() -> None:
    line = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            }
        ],
    }
    with pytest.raises(ValueError, match="between 1 and 10"):
        run_vector_tool("smooth", line, parameters={"iterations": 99})


def test_smooth_empty_ring_does_not_crash() -> None:
    # A malformed polygon with an empty ring must not raise (IndexError -> 500);
    # the ring stays empty. Mirrors the client guard.
    malformed = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Polygon", "coordinates": [[]]},
            }
        ],
    }
    geojson, _ = run_vector_tool("smooth", malformed, parameters={"iterations": 2})
    assert geojson["features"][0]["geometry"]["coordinates"] == [[]]


def test_smooth_iterations_round_half_up_matches_js() -> None:
    # 3.5 rounds up to 4 (JS Math.round semantics), not down to 3 like Python's
    # banker's round(), keeping the client and Python engines bit-identical.
    square = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]],
                },
            }
        ],
    }
    _, messages = run_vector_tool("smooth", square, parameters={"iterations": 3.5})
    assert messages and "with 4 iteration(s)" in messages[0]


def test_smooth_iterations_zero_is_rejected() -> None:
    # An explicit 0 must hit the range check, not be silently coerced to 3.
    line = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            }
        ],
    }
    with pytest.raises(ValueError, match="between 1 and 10"):
        run_vector_tool("smooth", line, parameters={"iterations": 0})


def test_smooth_boolean_iterations_falls_back_to_default() -> None:
    # A JSON boolean is not a number on the client (it uses the fallback 3), so
    # the backend must not treat False as 0 (which would error). Keeps parity.
    line = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            }
        ],
    }
    _, messages = run_vector_tool("smooth", line, parameters={"iterations": False})
    assert messages and "with 3 iteration(s)" in messages[0]


def test_smooth_missing_coordinates_does_not_crash() -> None:
    # A malformed geometry with no coordinates key must not raise (TypeError ->
    # 500); the coordinate list is treated as empty.
    malformed = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "LineString"}}],
    }
    geojson, _ = run_vector_tool("smooth", malformed, parameters={"iterations": 2})
    assert geojson["features"][0]["geometry"]["coordinates"] == []


def test_smooth_degenerate_ring_collapses_to_empty() -> None:
    # A 2-vertex (degenerate) ring can't form a valid polygon; it collapses to an
    # empty ring rather than being re-closed into invalid GeoJSON.
    degenerate = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[0, 0], [1, 1], [0, 0]]],
                },
            }
        ],
    }
    geojson, _ = run_vector_tool("smooth", degenerate, parameters={"iterations": 3})
    assert geojson["features"][0]["geometry"]["coordinates"] == [[]]


def test_smooth_null_feature_raises_value_error() -> None:
    # A null/non-object feature is bad input: it must raise ValueError (-> 400),
    # not AttributeError (-> 500).
    bad = {
        "type": "FeatureCollection",
        "features": [
            None,
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            },
        ],
    }
    with pytest.raises(ValueError, match="GeoJSON Feature object"):
        run_vector_tool("smooth", bad, parameters={"iterations": 1})


def test_smooth_preserves_feature_id() -> None:
    line = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "abc",
                "properties": {},
                "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            }
        ],
    }
    geojson, _ = run_vector_tool("smooth", line, parameters={"iterations": 1})
    assert geojson["features"][0]["id"] == "abc"


def test_smooth_preserves_z_coordinates() -> None:
    line3d = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[0, 0, 100], [0, 10, 200]],
                },
            }
        ],
    }
    geojson, _ = run_vector_tool("smooth", line3d, parameters={"iterations": 1})
    coords = geojson["features"][0]["geometry"]["coordinates"]
    # Z is interpolated, not dropped: the 1/4 cut point is 100*0.75 + 200*0.25 = 125.
    assert all(len(c) == 3 for c in coords)
    assert coords[1] == [0, 2.5, 125]


# --- Voronoi / Delaunay ---


def _points(*coords: tuple[float, float]) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Point", "coordinates": [x, y]},
            }
            for x, y in coords
        ],
    }


@requires_geopandas
def test_voronoi_produces_polygon_cells() -> None:
    geojson, messages = run_vector_tool(
        "voronoi",
        _points((0, 0), (10, 0), (0, 10), (10, 10), (5, 5)),
        parameters={"type": "voronoi"},
    )
    assert len(geojson["features"]) > 0
    assert all(f["geometry"]["type"] in ("Polygon", "MultiPolygon") for f in geojson["features"])
    assert messages and "Voronoi" in messages[0]


@requires_geopandas
def test_delaunay_produces_triangles() -> None:
    geojson, messages = run_vector_tool(
        "voronoi",
        _points((0, 0), (10, 0), (0, 10), (10, 10), (5, 5)),
        parameters={"type": "delaunay"},
    )
    assert len(geojson["features"]) > 0
    assert all(f["geometry"]["type"] == "Polygon" for f in geojson["features"])
    assert messages and "Delaunay" in messages[0]


@requires_geopandas
def test_voronoi_requires_three_points() -> None:
    with pytest.raises(ValueError, match="at least 3 points"):
        run_vector_tool("voronoi", _points((0, 0), (1, 1)), parameters={})


@requires_geopandas
def test_voronoi_unknown_type_raises() -> None:
    with pytest.raises(ValueError, match="Unknown diagram type"):
        run_vector_tool(
            "voronoi",
            _points((0, 0), (10, 0), (0, 10)),
            parameters={"type": "bogus"},
        )


@requires_geopandas
def test_voronoi_collinear_points_raise() -> None:
    # Axis-aligned collinear points (zero-area bounds) are rejected before the
    # diagram-type branch, for both Voronoi and Delaunay.
    with pytest.raises(ValueError, match="collinear or coincident"):
        run_vector_tool(
            "voronoi",
            _points((0, 0), (0, 5), (0, 10)),
            parameters={"type": "voronoi"},
        )
    with pytest.raises(ValueError, match="collinear or coincident"):
        run_vector_tool(
            "voronoi",
            _points((0, 0), (0, 5), (0, 10)),
            parameters={"type": "delaunay"},
        )


@requires_geopandas
def test_voronoi_diagonal_collinear_points_raise() -> None:
    # Diagonally collinear points have a non-zero-area bbox, so they slip past the
    # bbox guard but produce no triangle/cell with area; the empty-result guard
    # reports them rather than returning nothing.
    with pytest.raises(ValueError, match="collinear"):
        run_vector_tool(
            "voronoi",
            _points((0, 0), (1, 1), (2, 2)),
            parameters={"type": "delaunay"},
        )


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


BOWTIE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "bowtie"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]],
            },
        },
        {
            "type": "Feature",
            "properties": {"name": "ok"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[10, 0], [14, 0], [14, 4], [10, 4], [10, 0]]],
            },
        },
    ],
}


@requires_geopandas
def test_check_validity_marks_invalid_features() -> None:
    geojson, messages = run_vector_tool("check-validity", BOWTIE)
    assert geojson["type"] == "FeatureCollection"
    assert len(geojson["features"]) == 1
    marker = geojson["features"][0]
    assert marker["geometry"]["type"] == "Point"
    assert marker["properties"]["feature_index"] == 0
    # explain_validity names the problem (e.g. "Self-intersection[...]").
    assert "intersection" in marker["properties"]["detail"].lower()
    assert any("1 invalid" in m for m in messages)


@requires_geopandas
def test_check_validity_reports_clean_layer() -> None:
    geojson, messages = run_vector_tool("check-validity", SQUARE)
    assert geojson["features"] == []
    assert any("No invalid geometries" in m for m in messages)


@requires_geopandas
def test_fix_geometries_repairs_only_invalid() -> None:
    from shapely.geometry import shape

    geojson, messages = run_vector_tool("fix-geometries", BOWTIE)
    assert len(geojson["features"]) == 2
    repaired = shape(geojson["features"][0]["geometry"])
    assert repaired.is_valid
    assert repaired.geom_type == "MultiPolygon"
    assert geojson["features"][0]["properties"]["name"] == "bowtie"
    # The already-valid square keeps its ring untouched.
    untouched = shape(geojson["features"][1]["geometry"])
    assert untouched.equals(shape(BOWTIE["features"][1]["geometry"]))
    assert any("Fixed 1 invalid geometry" in m for m in messages)


@requires_geopandas
def test_fix_geometries_no_op_on_valid_layer() -> None:
    geojson, messages = run_vector_tool("fix-geometries", SQUARE)
    assert len(geojson["features"]) == 1
    assert any("already valid" in m for m in messages)


@requires_geopandas
def test_validity_anchor_parses_scientific_notation() -> None:
    anchor = vector_ops._validity_anchor("Self-intersection[1.5e-10 -2.3e-05]", None)
    assert anchor == (1.5e-10, -2.3e-05)


@requires_geopandas
def test_check_validity_counts_empty_geometry_as_missing() -> None:
    with_empty = {
        "type": "FeatureCollection",
        "features": [
            SQUARE["features"][0],
            {
                "type": "Feature",
                "properties": {"name": "empty"},
                "geometry": {"type": "Polygon", "coordinates": []},
            },
        ],
    }
    _, messages = run_vector_tool("check-validity", with_empty)
    assert any("1 without geometry" in m for m in messages)
    assert any("Checked 1 feature(s)" in m for m in messages)
