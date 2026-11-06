"""Tests for the floor picker link (``levelFilter``, issue #3341).

``project.level_filter`` mirrors ``packages/core/src/level-filter.ts``: the same
level parsing and the same resolved values, so a project written here opens on
the same floor in the app. The cases below repeat ``tests/level-filter.test.ts``.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import pytest

import geolibre.geolibre as gmod
from geolibre import Map, authoring, project

REPO = Path(__file__).resolve().parents[2]
TYPES_TS = REPO / "packages" / "core" / "src" / "types.ts"


def _fc(*levels):
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"level": level, "name": f"room {level}"},
                "geometry": {"type": "Point", "coordinates": [0, 0]},
            }
            for level in levels
        ],
    }


#: OSM-style indoor rooms: text levels, one spanning two floors, one a range.
ROOMS = _fc("-1", "-1", "0", "0;1", "1", "-1-0")


def test_parse_level_value_reads_numbers_lists_spans_and_names():
    assert [label for label, _ in project.parse_level_value("0;1")] == ["0", "1"]
    assert [o for _, o in project.parse_level_value("-2--1")] == [-2, -1]
    assert [o for _, o in project.parse_level_value("-1-1")] == [-1, 0, 1]
    assert project.parse_level_value(3) == [("3", 3)]
    assert project.parse_level_value("01") == [("1", 1)]
    assert project.parse_level_value(" G ") == [("G", None)]
    assert project.parse_level_value(None) == []
    assert project.parse_level_value(True) == []


def test_level_matching_mirrors_the_app():
    assert project.level_value_matches("0;1", "1", "only")
    assert project.level_value_matches("-1-0", "0", "only")
    assert not project.level_value_matches("-1", "0", "only")
    assert project.level_value_matches(0, "0", "only")
    assert project.level_value_matches("-1", "0", "below")
    assert not project.level_value_matches("1", "0", "below")
    assert not project.level_value_matches("B", "G", "below")


def test_level_filter_resolves_matching_values():
    only = project.level_filter("level", "0", features=ROOMS["features"])
    assert only == {"field": "level", "mode": "only", "level": "0", "values": ["0", "0;1", "-1-0"]}
    below = project.level_filter("level", 0, mode="below", features=ROOMS["features"])
    assert below["level"] == "0"
    assert below["values"] == ["-1", "0", "0;1", "-1-0"]
    numeric = project.level_filter("level", "1", mode="below", features=_fc(0, 1, 2)["features"])
    assert numeric["values"] == [0, 1]
    assert project.level_filter("level") == {"field": "level", "mode": "all", "level": None}
    # Without features the app resolves the values on open.
    assert "values" not in project.level_filter("level", "0")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"field": ""},
        {"field": "level", "level": "0", "mode": "sideways"},
        {"field": "level", "mode": "below"},
        {"field": "level", "level": True},
        {"field": "level", "level": " "},
        {"field": "level", "level": float("nan")},
        {"field": "level", "level": float("inf")},
    ],
)
def test_level_filter_rejects_bad_input(kwargs):
    field = kwargs.pop("field")
    with pytest.raises(ValueError):
        project.level_filter(field, **kwargs)


@pytest.mark.skipif(
    not TYPES_TS.is_file(), reason="the TypeScript sources ship in the repo, not in the package"
)
def test_level_filter_modes_mirror_types_ts():
    source = TYPES_TS.read_text(encoding="utf-8")
    match = re.search(r"export type LevelFilterMode = ([^;]+);", source)
    assert match, "LevelFilterMode not found in types.ts"
    modes = tuple(re.findall(r'"([^"]+)"', match.group(1)))
    assert modes == project.LEVEL_FILTER_MODES


def _two_layer_project():
    p = project.build_empty_project("Indoor")
    authoring.add_layer(p, project.geojson_layer("Rooms", ROOMS))
    authoring.add_layer(p, project.geojson_layer("Doors", _fc(0, 1)))
    return p


def test_set_floor_picker_shares_the_floor_across_linked_layers():
    p = _two_layer_project()
    authoring.set_floor_picker(p, "Rooms", "level")
    summary = authoring.set_floor_picker(p, "Doors", "level", "1")
    rooms, doors = p["layers"]
    assert summary["levelFilter"] == doors["levelFilter"]
    assert doors["levelFilter"]["values"] == [1]
    assert rooms["levelFilter"]["values"] == ["0;1", "1"]
    authoring.set_floor_picker(p, "Rooms", "level", None, mode="all")
    assert rooms["levelFilter"] == {"field": "level", "mode": "all", "level": None}
    assert doors["levelFilter"]["mode"] == "all"
    authoring.set_floor_picker(p, "Rooms", None)
    assert "levelFilter" not in p["layers"][0]


def test_set_floor_picker_validates_before_linking():
    p = _two_layer_project()
    with pytest.raises(ValueError):
        authoring.set_floor_picker(p, "Rooms", "level", "0", mode="sideways")
    assert "levelFilter" not in p["layers"][0]


def test_map_set_floor_picker(monkeypatch):
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    m = Map()
    layer_id = m.add_geojson(ROOMS, name="Rooms")
    m.set_floor_picker("Rooms", level="0", mode="below")
    layer = next(item for item in m.project["layers"] if item["id"] == layer_id)
    assert layer["levelFilter"]["values"] == ["-1", "0", "0;1", "-1-0"]


def test_mcp_set_floor_picker(tmp_path):
    pytest.importorskip("mcp", reason="the mcp SDK is an optional extra")
    from geolibre.mcp.server import build_server
    from geolibre.mcp.workspace import Workspace

    server = build_server(Workspace([tmp_path]))

    def call(tool, **arguments):
        result = asyncio.run(server.call_tool(tool, arguments))
        return result

    asyncio.run(server.call_tool("create_project", {"path": "map.geolibre.json"}))
    asyncio.run(
        server.call_tool(
            "add_geojson_layer",
            {"path": "map.geolibre.json", "data": json.dumps(ROOMS), "name": "Rooms"},
        )
    )
    call("set_floor_picker", path="map.geolibre.json", layer="Rooms", level="1")
    saved = json.loads((tmp_path / "map.geolibre.json").read_text(encoding="utf-8"))
    assert saved["layers"][0]["levelFilter"] == {
        "field": "level",
        "mode": "only",
        "level": "1",
        "values": ["0;1", "1"],
    }


@pytest.mark.parametrize(
    ("value", "label"),
    [
        (0.0000001, "1e-7"),
        (0.00001, "0.00001"),
        (1e16, "10000000000000000"),
        (1e21, "1e+21"),
        (2.5e-8, "2.5e-8"),
        (-0.0, "0"),
        (3.0, "3"),
    ],
)
def test_level_labels_match_javascript_string(value, label):
    """Labels match the app's ``String(number)``, or the saved floor would match nothing."""
    assert project.level_filter("level", value)["level"] == label


def test_set_floor_picker_is_atomic():
    p = _two_layer_project()
    authoring.set_floor_picker(p, "Rooms", "level")
    p["layers"][0]["levelFilter"]["field"] = ""  # a corrupt sibling link
    before = json.dumps(p, sort_keys=True)
    with pytest.raises(ValueError):
        authoring.set_floor_picker(p, "Doors", "level", "1")
    assert json.dumps(p, sort_keys=True) == before


def test_non_ascii_digits_are_named_floors_like_the_app():
    assert project.parse_level_value("\u0663") == [("\u0663", None)]


def test_set_floor_picker_keeps_the_floor_in_view_when_level_is_omitted():
    p = _two_layer_project()
    authoring.set_floor_picker(p, "Rooms", "level", "1", mode="below")
    authoring.set_floor_picker(p, "Doors", "level")
    rooms, doors = p["layers"]
    assert rooms["levelFilter"]["level"] == doors["levelFilter"]["level"] == "1"
    assert doors["levelFilter"]["mode"] == "below"
    assert doors["levelFilter"]["values"] == [0, 1]


def test_level_label_for_a_value_too_long_for_a_double():
    assert project.parse_level_value("9" * 400) == [("Infinity", float("inf"))]


def test_set_floor_picker_mode_without_level_applies_to_the_shown_floor():
    p = _two_layer_project()
    authoring.set_floor_picker(p, "Rooms", "level", "0")
    authoring.set_floor_picker(p, "Doors", "level", mode="below")
    rooms, doors = p["layers"]
    assert rooms["levelFilter"]["level"] == doors["levelFilter"]["level"] == "0"
    assert rooms["levelFilter"]["mode"] == doors["levelFilter"]["mode"] == "below"


def test_set_floor_picker_skips_malformed_layer_entries():
    p = _two_layer_project()
    p["layers"].append("not a layer")
    authoring.set_floor_picker(p, "Rooms", "level", "0")
    assert p["layers"][0]["levelFilter"]["level"] == "0"


def test_mode_all_with_a_level_shows_every_floor():
    assert project.level_filter("level", "0", mode="all") == {
        "field": "level",
        "mode": "all",
        "level": None,
    }


def test_integers_too_large_for_a_double():
    huge = int("9" * 400)
    assert project.parse_level_value(huge) == []
    with pytest.raises(ValueError):
        project.level_filter("level", huge)
    link = project.level_filter("level", "0", features=_fc(huge, "0")["features"])
    assert link["values"] == ["0"]
