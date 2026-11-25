"""Verify saved SQL results across Python builders, Map, MCP and the app fixture."""

from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path

import pytest

import geolibre.geolibre as gmod
from geolibre import Map, authoring, project

SQL = "SELECT name, geom FROM cities WHERE pop >= 50"
SOURCE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": name, "pop": pop},
            "geometry": {"type": "Point", "coordinates": coords},
        }
        for name, pop, coords in [("A", 10, [-84, 36]), ("B", 90, [-83, 35])]
    ],
}
SNAPSHOT = {"type": "FeatureCollection", "features": [SOURCE["features"][1]]}
REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "tests/fixtures/python-sql-query.geolibre.json"


def query_project():
    """Build the deterministic project consumed by the app round-trip test.

    Returns:
        A project with source features and a separately styled result snapshot.
    """
    result = project.build_empty_project(name="Python SQL query", center=(-83, 35), zoom=4)
    source = project.geojson_layer("cities", copy.deepcopy(SOURCE))
    source["id"] = "cities"
    query = project.sql_query_layer("Populated cities", SNAPSHOT, SQL, circleRadius=9)
    query["id"] = "query"
    result["layers"] = [source, query]
    return result


def test_snapshot_is_independent_and_refresh_uses_sql():
    """Keep an owned result snapshot and the app's exact refresh metadata."""
    data = copy.deepcopy(SNAPSHOT)
    layer = project.sql_query_layer("Result", data, SQL, circleRadius=9)
    assert layer["type"] == "geojson"
    assert layer["source"] == {"type": "geojson"}
    assert "sourcePath" not in layer
    assert layer["metadata"] == {
        "sourceKind": "sql-query",
        "sqlQuery": {"engine": "duckdb", "sql": SQL},
    }
    assert layer["geojson"] == SNAPSHOT
    assert layer["style"]["circleRadius"] == 9
    data["features"][0]["properties"]["name"] = "Changed outside the layer"
    assert layer["geojson"]["features"][0]["properties"]["name"] == "B"


def test_style_keys_do_not_bind_snapshot_source_parameters():
    """Keep style overrides from introducing an independent source URL."""
    layer = project.sql_query_layer("Result", SNAPSHOT, SQL, source_url="https://example.com/data")
    assert layer["source"] == {"type": "geojson"}
    assert "sourcePath" not in layer


@pytest.mark.parametrize(
    "feature",
    [
        None,
        42,
        "Feature",
        [],
        {},
        {"type": "FeatureCollection", "features": []},
        {"type": "Feature"},
        {"type": "Feature", "geometry": None, "properties": "invalid"},
        {"type": "Feature", "geometry": 42, "properties": {}},
    ],
)
def test_snapshot_rejects_malformed_feature_entries(feature):
    """Reject malformed result entries before returning a query layer.

    Args:
        feature: Invalid snapshot entry under test.
    """
    with pytest.raises(ValueError, match="GeoJSON Feature"):
        project.sql_query_layer("Result", {"type": "FeatureCollection", "features": [feature]}, SQL)


@pytest.mark.parametrize(
    "features", [[], [{"type": "Feature", "geometry": None, "properties": None}]]
)
def test_snapshot_accepts_empty_results_and_null_geometry(features):
    """Preserve valid empty and nonspatial query results.

    Args:
        features: Valid result entries under test.
    """
    data = {"type": "FeatureCollection", "features": features}
    assert project.sql_query_layer("Result", data, SQL)["geojson"] == data


@pytest.mark.parametrize("sql", [None, 42, True, [], "", " \n\t"])
def test_invalid_sql_does_not_read_result(sql, monkeypatch):
    """Reject invalid query definitions before loading any result input.

    Args:
        sql: Invalid query definition under test.
        monkeypatch: Fixture replacing the input loader with an observed failure.
    """

    def unexpected_read(_data):
        """Fail if validation incorrectly reaches the GeoJSON loader.

        Args:
            _data: Result input that must remain unread.
        """
        pytest.fail("invalid SQL must not load result data")

    monkeypatch.setattr(project, "load_featurecollection", unexpected_read)
    with pytest.raises(ValueError, match="non-empty DuckDB SQL"):
        project.sql_query_layer("Result", "unread.geojson", sql)


def test_map_saves_a_refreshable_query_snapshot(tmp_path, monkeypatch):
    """Exercise the public Map API and persisted result without a web server.

    Args:
        tmp_path: Temporary project destination.
        monkeypatch: Fixture preventing widget app-server startup.
    """
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    model = Map()
    model.add_geojson(SOURCE, name="cities")
    layer_id = model.add_sql_query_layer(json.dumps(SNAPSHOT), SQL, name="Result", circleRadius=9)
    before = copy.deepcopy(model.project)
    with pytest.raises(ValueError, match="non-empty DuckDB SQL"):
        model.add_sql_query_layer(SNAPSHOT, " ")
    with pytest.raises(ValueError, match="GeoJSON Feature"):
        model.add_sql_query_layer({"type": "FeatureCollection", "features": [None]}, SQL)
    assert model.project == before
    destination = tmp_path / "query.geolibre.json"
    model.save_project(destination)
    saved = authoring.load_project(destination)
    query = next(layer for layer in saved["layers"] if layer["id"] == layer_id)
    assert query["geojson"] == SNAPSHOT
    assert query["metadata"]["sqlQuery"]["sql"] == SQL
    assert query["style"]["circleRadius"] == 9


def test_python_query_fixture_matches_the_app_input():
    """Detect drift between the Python builder and the app's persisted fixture."""
    if not (REPO / "packages/core/src/project.ts").is_file():
        pytest.skip("the app fixture lives in the repository, not the Python package")
    if not FIXTURE.exists():
        pytest.fail(f"missing app fixture: {FIXTURE}")
    assert json.loads(FIXTURE.read_text()) == query_project()


def test_mcp_query_snapshot_and_workspace_boundaries(tmp_path):
    """Verify MCP saves the result atomically and confines snapshot reads.

    Args:
        tmp_path: Root of the temporary MCP workspace.
    """
    pytest.importorskip("mcp")
    from mcp.server.mcpserver.exceptions import ToolError

    from geolibre.mcp.server import build_server
    from geolibre.mcp.workspace import Workspace

    root = tmp_path / "workspace"
    root.mkdir()
    destination = root / "query.geolibre.json"
    authoring.save_project(destination, project.build_empty_project())
    data = root / "snapshot.geojson"
    data.write_text(json.dumps(SNAPSHOT))
    outside = tmp_path / "outside.geojson"
    outside.write_text(json.dumps(SNAPSHOT))
    server = build_server(Workspace([root]))
    arguments = {"path": str(destination), "name": "Result", "data": str(data), "sql": SQL}
    result = asyncio.run(
        server.call_tool("add_sql_query_layer", {**arguments, "style": {"circleRadius": 9}})
    )
    assert not result.is_error
    query = authoring.load_project(destination)["layers"][0]
    assert query["geojson"] == SNAPSHOT
    assert query["metadata"]["sqlQuery"]["sql"] == SQL
    assert query["style"]["circleRadius"] == 9
    assert "sourcePath" not in query
    before = destination.read_bytes()
    for invalid in [
        {"sql": " "},
        {"data": str(outside)},
        {"style": {"sql": "SELECT 1"}},
        {"data": json.dumps({"type": "FeatureCollection", "features": [None]})},
    ]:
        with pytest.raises(ToolError):
            asyncio.run(server.call_tool("add_sql_query_layer", {**arguments, **invalid}))
        assert destination.read_bytes() == before
