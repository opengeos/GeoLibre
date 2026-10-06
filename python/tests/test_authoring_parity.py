"""Tests for layer filters, labels, plugin state, and story map authoring.

The authoring functions are shared by :class:`geolibre.Map` and the MCP server,
so both surfaces are exercised here on top of the functions themselves.

Two kinds of drift check guard the shapes against the TypeScript app:

* the mirrored defaults and vocabularies are compared with
  ``packages/core/src/types.ts`` and the plugin sources; and
* a project built by these functions is pinned as
  ``tests/fixtures/python-authoring.geolibre.json`` at the repo root, which
  ``tests/python-authoring-roundtrip.test.ts`` loads through the app's own
  ``parseProject`` and checks nothing was dropped or rewritten.

Both skip when the repo sources are absent (an sdist or wheel install).
Regenerate the fixture with ``GEOLIBRE_REGEN_FIXTURES=1``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

import pytest

import geolibre.geolibre as gmod
from geolibre import Map, authoring, project

REPO = Path(__file__).resolve().parents[2]
TYPES_TS = REPO / "packages" / "core" / "src" / "types.ts"
PLUGINS_SRC = REPO / "packages" / "plugins" / "src"
FIXTURE = REPO / "tests" / "fixtures" / "python-authoring.geolibre.json"

POINT_FC = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "A", "pop": 10},
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        },
        {
            "type": "Feature",
            "properties": {"name": "B", "pop": 90},
            "geometry": {"type": "Point", "coordinates": [1, 1]},
        },
    ],
}


@pytest.fixture
def proj():
    """A project with one inlined GeoJSON layer named "Cities"."""
    p = project.build_empty_project("Test")
    authoring.add_layer(p, project.geojson_layer("Cities", POINT_FC))
    return p


# -- layer filters ------------------------------------------------------------


def test_set_layer_filter_accepts_a_list_or_json_and_clears(proj):
    """A list and its JSON string store the same expression; None clears it."""
    summary = authoring.set_layer_filter(proj, "Cities", [">=", ["get", "pop"], 50])
    assert summary["filterExpression"] == [">=", ["get", "pop"], 50]
    layer = authoring.find_layer(proj, "Cities")
    assert layer["filterExpression"] == [">=", ["get", "pop"], 50]

    authoring.set_layer_filter(proj, "Cities", '["==", ["get", "name"], "A"]')
    assert layer["filterExpression"] == ["==", ["get", "name"], "A"]

    authoring.set_layer_filter(proj, "Cities", None)
    assert "filterExpression" not in layer


@pytest.mark.parametrize(
    "expression",
    [
        ["case", ["has", "pop"], [">", ["get", "pop"], 5], False],
        ["match", ["get", "k"], ["a", "b"], True, False],
        ["coalesce", ["boolean", ["get", "flag"]], False],
        ["let", "x", 5, [">", ["get", "pop"], ["var", "x"]]],
    ],
)
def test_set_layer_filter_accepts_boolean_branching_operators(proj, expression):
    """case/match/coalesce/let pass when every branch they can return is boolean."""
    authoring.set_layer_filter(proj, "Cities", expression)
    assert authoring.find_layer(proj, "Cities")["filterExpression"] == expression


@pytest.mark.parametrize(
    ("expression", "message"),
    [
        ("pop", "not valid JSON"),
        ([], None),
        ({"op": "=="}, "expression array"),
        ([1, 2], "operator string"),
        (["get", "pop"], "true/false"),
        (["+", 1, 2], "true/false"),
        (["case", ["has", "pop"], 1, 0], "true/false"),
        (["let", "x", 5, ["var", "x"]], "true/false"),
        (["match", ["get", "k"], "a", True, "nope"], "true/false"),
    ],
)
def test_set_layer_filter_rejects_non_boolean_expressions(proj, expression, message):
    """Expressions the app would silently drop on load are refused up front."""
    if message is None:
        # An empty list is the clear form, not an error.
        authoring.set_layer_filter(proj, "Cities", expression)
        return
    with pytest.raises(ValueError, match=message):
        authoring.set_layer_filter(proj, "Cities", expression)


# -- labels -------------------------------------------------------------------


def test_set_labels_writes_a_complete_labels_object(proj):
    """The written object carries every LabelStyle key, with options mapped."""
    labels = authoring.set_labels(
        proj,
        "Cities",
        "name",
        size=14,
        halo_width=2,
        anchor="top",
        transform="uppercase",
        color_expression=["match", ["get", "name"], "A", "#ff0000", "#000000"],
    )
    assert set(labels) == set(project.DEFAULT_LABEL_STYLE)
    assert labels["enabled"] is True
    assert labels["field"] == "name"
    assert labels["size"] == 14
    assert labels["haloWidth"] == 2
    assert labels["anchor"] == "top"
    assert labels["transform"] == "uppercase"
    # Data-defined expressions are stored as JSON strings, like the app does.
    assert json.loads(labels["colorExpression"])[0] == "match"
    assert authoring.find_layer(proj, "Cities")["style"]["labels"] == labels


def test_set_labels_keeps_unspecified_settings(proj):
    """A second call restyles without restating the field."""
    authoring.set_labels(proj, "Cities", "name", size=20)
    labels = authoring.set_labels(proj, "Cities", color="#ff0000")
    assert labels["field"] == "name"
    assert labels["size"] == 20
    assert labels["color"] == "#ff0000"
    hidden = authoring.set_labels(proj, "Cities", enabled=False)
    assert hidden["enabled"] is False
    assert hidden["field"] == "name"
    # A restyle that does not mention `enabled` leaves hidden labels hidden.
    restyled = authoring.set_labels(proj, "Cities", size=11)
    assert restyled["enabled"] is False
    assert authoring.set_labels(proj, "Cities", enabled=True)["enabled"] is True


def test_set_labels_treats_a_stored_empty_labels_object_as_on(proj):
    """A hand-edited `labels: {}` does not make new labels invisible."""
    authoring.find_layer(proj, "Cities")["style"]["labels"] = {}
    assert authoring.set_labels(proj, "Cities", "name")["enabled"] is True


def test_deeply_nested_expressions_are_a_value_error(proj):
    """Recursion limits surface as the documented ValueError."""
    deep: list = [">", ["get", "pop"], 0]
    for _ in range(5000):
        deep = ["coalesce", deep]
    with pytest.raises(ValueError, match="nested too deeply"):
        authoring.set_layer_filter(proj, "Cities", deep)


def test_set_labels_expression_overrides_field(proj):
    """A label-text expression is stored compactly and can be cleared."""
    labels = authoring.set_labels(proj, "Cities", expression=["concat", ["get", "name"], "!"])
    assert labels["expression"] == '["concat",["get","name"],"!"]'
    cleared = authoring.set_labels(proj, "Cities", "name", expression="")
    assert cleared["expression"] == ""


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"anchor": "middle"}, "anchor must be one of"),
        ({"placement": "curve"}, "placement must be one of"),
        ({"size": 0}, "greater than 0"),
        ({"min_zoom": 30}, "between 0 and 24"),
        ({"min_zoom": 10, "max_zoom": 5}, "must not exceed"),
        ({"number_decimals": 2.5}, "whole number"),
        ({"allow_overlap": "yes"}, "true or false"),
        ({"font": "Arial"}, "unknown label option"),
        ({"size_expression": "nope"}, "not valid JSON"),
    ],
)
def test_set_labels_rejects_bad_options(proj, kwargs, message):
    """Invalid options raise with a message naming the problem."""
    with pytest.raises(ValueError, match=message):
        authoring.set_labels(proj, "Cities", "name", **kwargs)


def test_set_labels_needs_something_to_draw(proj):
    """Enabling labels with no field and no expression is refused."""
    with pytest.raises(ValueError, match="field or an expression"):
        authoring.set_labels(proj, "Cities")


# -- plugin state -------------------------------------------------------------


def test_set_plugin_state_stores_and_activates(proj):
    """The blob, corner, and activation land where the app restores them."""
    stored = authoring.set_plugin_state(
        proj, "maplibre-h3-grid", {"resolution": 5}, position="top-left"
    )
    assert stored == {
        "pluginId": "maplibre-h3-grid",
        "active": True,
        "position": "top-left",
        "state": {"resolution": 5},
    }
    plugins = proj["plugins"]
    assert plugins["settings"]["maplibre-h3-grid"] == {"resolution": 5}
    assert plugins["mapControlPositions"]["maplibre-h3-grid"] == "top-left"
    # The default plugins are seeded so the app does not tear them down.
    for default in project.DEFAULT_ACTIVE_PLUGIN_IDS:
        assert default in plugins["activePluginIds"]


def test_set_plugin_state_without_state_keeps_settings(proj):
    """Omitting the state repositions without wiping the stored settings."""
    authoring.set_plugin_state(proj, "maplibre-h3-grid", {"resolution": 5})
    moved = authoring.set_plugin_state(proj, "maplibre-h3-grid", position="bottom-left")
    assert moved["state"] == {"resolution": 5}
    assert moved["position"] == "bottom-left"


def test_set_plugin_state_clear_removes_settings_only(proj):
    """clear=True drops the blob and never switches the plugin on."""
    authoring.set_plugin_state(proj, "maplibre-h3-grid", {"resolution": 5})
    authoring.set_plugin_state(proj, "maplibre-h3-grid", clear=True)
    assert "maplibre-h3-grid" not in proj["plugins"]["settings"]
    authoring.set_plugin_state(proj, "maplibre-olc", clear=True)
    assert "maplibre-olc" not in proj["plugins"]["activePluginIds"]
    with pytest.raises(ValueError, match="not both"):
        authoring.set_plugin_state(proj, "maplibre-olc", {"a": 1}, clear=True)


def test_set_plugin_state_refuses_unknown_ids_unless_allowed(proj):
    """An id no built-in plugin restores is refused unless explicitly allowed."""
    with pytest.raises(ValueError, match="allow_unknown"):
        authoring.set_plugin_state(proj, "my-plugin", {"a": 1})
    stored = authoring.set_plugin_state(proj, "my-plugin", {"a": 1}, allow_unknown=True)
    assert stored["state"] == {"a": 1}


def test_set_plugin_state_rejects_non_json_and_bad_corners(proj):
    """State the app would drop on load, and unknown corners, are refused."""
    with pytest.raises(ValueError, match="plain JSON"):
        authoring.set_plugin_state(proj, "maplibre-h3-grid", {"x": float("nan")})
    with pytest.raises(ValueError, match="position must be one of"):
        authoring.set_plugin_state(proj, "maplibre-h3-grid", {}, position="middle")


# -- story maps ---------------------------------------------------------------


def test_add_story_chapter_defaults_to_the_saved_view(proj):
    """A chapter with no camera captures the project's saved view."""
    authoring.set_view(proj, center=[-84, 36], zoom=7, bearing=-30, pitch=40)
    chapter = authoring.add_story_chapter(proj, "Intro")
    assert chapter["location"] == {"center": [-84, 36], "zoom": 7, "pitch": 40, "bearing": 330}
    assert chapter["alignment"] == "left"
    assert chapter["mapAnimation"] == "flyTo"
    assert "image" not in chapter
    assert proj["storymap"]["chapters"] == [chapter]
    # A new story carries every StoryMap key.
    assert set(proj["storymap"]) == set(project.DEFAULT_STORY_MAP)


def test_add_story_chapter_resolves_layer_names_in_opacity_changes(proj):
    """Opacity changes accept layer names and store the layer id."""
    layer_id = authoring.find_layer(proj, "Cities")["id"]
    chapter = authoring.add_story_chapter(
        proj,
        "Cities fade in",
        center=[0, 0],
        zoom=3,
        on_enter=[{"layer": "Cities", "opacity": 1, "duration": 500}],
        on_exit=[{"layer": layer_id, "opacity": 0}],
    )
    assert chapter["onChapterEnter"][0]["layerId"] == layer_id
    assert chapter["onChapterEnter"][0]["duration"] == 500
    assert chapter["onChapterExit"][0]["opacity"] == 0
    assert "duration" not in chapter["onChapterExit"][0]


def test_story_chapter_ordering(proj):
    """Chapters insert at an index, move, and are removed by title or id."""
    first = authoring.add_story_chapter(proj, "One", center=[0, 0], zoom=1)
    authoring.add_story_chapter(proj, "Three", center=[0, 0], zoom=1)
    authoring.add_story_chapter(proj, "Two", center=[0, 0], zoom=1, index=1)

    def titles():
        return [chapter["title"] for chapter in proj["storymap"]["chapters"]]

    assert titles() == ["One", "Two", "Three"]
    authoring.move_story_chapter(proj, "three", 0)
    assert titles() == ["Three", "One", "Two"]
    authoring.move_story_chapter(proj, 0, 99)
    assert titles() == ["One", "Two", "Three"]
    summary = authoring.remove_story_chapter(proj, first["id"])
    assert [chapter["title"] for chapter in summary["chapters"]] == ["Two", "Three"]
    authoring.remove_story_chapter(proj, -1)
    assert titles() == ["Two"]


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"center": [200, 0]}, "longitude"),
        ({"center": [0, 95]}, "latitude"),
        ({"zoom": 30}, "zoom"),
        ({"pitch": 90}, "pitch"),
        ({"alignment": "top"}, "alignment"),
        ({"map_animation": "warp"}, "map_animation"),
        ({"on_enter": [{"layer": "Cities", "opacity": 2}]}, "between 0 and 1"),
        ({"on_enter": [{"layer": "Nope"}]}, "No layer matches"),
    ],
)
def test_add_story_chapter_rejects_bad_values(proj, kwargs, message):
    """Values the app would clamp or drop are refused instead."""
    with pytest.raises(ValueError, match=message):
        authoring.add_story_chapter(proj, "Bad", **{"center": [0, 0], "zoom": 1, **kwargs})


def test_story_chapter_lookup_errors(proj):
    """Unknown and ambiguous references are explained."""
    authoring.add_story_chapter(proj, "Same", center=[0, 0], zoom=1)
    authoring.add_story_chapter(proj, "Same", center=[0, 0], zoom=1)
    with pytest.raises(ValueError, match="2 chapters are titled"):
        authoring.remove_story_chapter(proj, "Same")
    with pytest.raises(ValueError, match="No chapter matches"):
        authoring.remove_story_chapter(proj, "Other")
    with pytest.raises(ValueError, match="No chapter at index"):
        authoring.move_story_chapter(proj, 5, 0)
    with pytest.raises(ValueError, match="already exists"):
        chapter_id = proj["storymap"]["chapters"][0]["id"]
        authoring.add_story_chapter(proj, "Dup", center=[0, 0], zoom=1, chapter_id=chapter_id)


def test_set_story_map_settings(proj):
    """Settings map to StoryMap keys and are validated."""
    summary = authoring.set_story_map(
        proj, title="Tour", theme="light", show_markers=True, start_slide="global"
    )
    assert summary["title"] == "Tour"
    assert proj["storymap"]["showMarkers"] is True
    assert proj["storymap"]["startSlide"] == "global"
    assert proj["storymap"]["chapters"] == []
    with pytest.raises(ValueError, match="theme must be one of"):
        authoring.set_story_map(proj, theme="sepia")
    with pytest.raises(ValueError, match="unknown story map setting"):
        authoring.set_story_map(proj, colour="red")


# -- Map wrappers -------------------------------------------------------------


def test_map_methods_delegate_to_authoring(monkeypatch):
    """The widget methods write the same project shapes as the functions."""
    # Stub the static server so no bundled app is needed (as in test_map.py).
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    m = Map()
    layer_id = m.add_geojson(POINT_FC, name="Cities")
    m.set_layer_filter("Cities", ["==", ["get", "name"], "A"])
    labels = m.set_labels(m.get_layer(layer_id), "name", size=12)
    m.set_plugin_state("maplibre-gl-graticule", {"interval": 10})
    chapter = m.add_story_chapter(
        "Start", center=(1, 2), zoom=4, on_enter=[{"layer": m.get_layer(layer_id)}]
    )
    m.add_story_chapter("Next", center=(3, 4), zoom=5)
    m.move_story_chapter("Next", 0)
    m.set_story_map(title="Tour")
    layer = next(item for item in m.project["layers"] if item["id"] == layer_id)
    assert layer["filterExpression"] == ["==", ["get", "name"], "A"]
    assert layer["style"]["labels"] == labels
    assert m.project["plugins"]["settings"]["maplibre-gl-graticule"] == {"interval": 10}
    assert chapter["onChapterEnter"][0]["layerId"] == layer_id
    assert [c["title"] for c in m.project["storymap"]["chapters"]] == ["Next", "Start"]
    m.remove_story_chapter("Next")
    assert [c["title"] for c in m.project["storymap"]["chapters"]] == ["Start"]
    assert m.project["storymap"]["title"] == "Tour"


# -- MCP tools ----------------------------------------------------------------


@pytest.fixture
def mcp_server(tmp_path):
    """An MCP server confined to a temporary workspace (needs the SDK)."""
    pytest.importorskip("mcp", reason="the mcp SDK is an optional extra")
    from geolibre.mcp.server import build_server
    from geolibre.mcp.workspace import Workspace

    return build_server(Workspace([tmp_path]))


def _call(server, tool, /, **arguments):
    """Invoke an MCP tool and return its structured result."""
    result = asyncio.run(server.call_tool(tool, arguments))
    if result.is_error:
        raise AssertionError(f"{tool} failed: {result.content[0].text}")
    return result.structured_content


def test_mcp_tools_author_filters_labels_plugins_and_stories(mcp_server, tmp_path):
    """The MCP tools write through authoring.py and save the file."""
    _call(mcp_server, "create_project", path="map.geolibre.json")
    _call(
        mcp_server,
        "add_geojson_layer",
        path="map.geolibre.json",
        data=json.dumps(POINT_FC),
        name="Cities",
    )
    _call(
        mcp_server,
        "set_layer_filter",
        path="map.geolibre.json",
        layer="Cities",
        expression='[">", ["get", "pop"], 20]',
    )
    labels = _call(
        mcp_server,
        "set_labels",
        path="map.geolibre.json",
        layer="Cities",
        field="name",
        size=15,
        options={"transform": "uppercase"},
    )["labels"]
    assert labels["size"] == 15 and labels["transform"] == "uppercase"
    _call(
        mcp_server,
        "set_plugin_state",
        path="map.geolibre.json",
        plugin_id="maplibre-gl-graticule",
        state={"interval": 5},
    )
    _call(mcp_server, "set_story_map", path="map.geolibre.json", title="Tour")
    added = _call(
        mcp_server,
        "add_story_chapter",
        path="map.geolibre.json",
        title="A",
        center=[0, 0],
        zoom=3,
        on_enter=[{"layer": "Cities", "opacity": 1}],
    )["chapter"]
    _call(mcp_server, "add_story_chapter", path="map.geolibre.json", title="B", index=0)
    moved = _call(mcp_server, "move_story_chapter", path="map.geolibre.json", chapter="A", index=0)
    assert [c["title"] for c in moved["storymap"]["chapters"]] == ["A", "B"]
    _call(mcp_server, "remove_story_chapter", path="map.geolibre.json", chapter=1)

    saved = json.loads((tmp_path / "map.geolibre.json").read_text(encoding="utf-8"))
    layer = saved["layers"][0]
    assert layer["filterExpression"] == [">", ["get", "pop"], 20]
    assert layer["style"]["labels"]["field"] == "name"
    assert saved["plugins"]["settings"]["maplibre-gl-graticule"] == {"interval": 5}
    assert saved["storymap"]["title"] == "Tour"
    assert [c["id"] for c in saved["storymap"]["chapters"]] == [added["id"]]
    assert "maplibre-gl-graticule" in _call(mcp_server, "list_catalog")["pluginStateIds"]


@pytest.mark.parametrize("key", ["size", "enabled", "field", "expression"])
def test_mcp_set_labels_refuses_named_options_inside_options(mcp_server, key):
    """A setting passed both ways is an error rather than a silent pick."""
    from mcp.server.mcpserver.exceptions import ToolError

    _call(mcp_server, "create_project", path="map.geolibre.json")
    _call(
        mcp_server,
        "add_geojson_layer",
        path="map.geolibre.json",
        data=json.dumps(POINT_FC),
        name="Cities",
    )
    with pytest.raises(ToolError, match="as arguments"):
        asyncio.run(
            mcp_server.call_tool(
                "set_labels",
                {
                    "path": "map.geolibre.json",
                    "layer": "Cities",
                    "field": "name",
                    "options": {key: 3},
                },
            )
        )


# -- drift checks against the TypeScript app ----------------------------------

needs_repo = pytest.mark.skipif(
    not TYPES_TS.is_file(), reason="the TypeScript sources ship in the repo, not in the package"
)


def _ts_object_literal(source: str, start: str) -> str:
    """Return the brace-balanced object literal that follows ``start``.

    Args:
        source: TypeScript source text.
        start: Text immediately before the opening brace.

    Returns:
        The literal's body, without the outer braces.
    """
    index = source.index(start) + len(start)
    index = source.index("{", index)
    depth = 0
    for end in range(index, len(source)):
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            depth -= 1
            if depth == 0:
                return source[index + 1 : end]
    raise AssertionError(f"unbalanced object literal after {start!r}")


def _ts_literal_values(body: str) -> dict[str, object]:
    """Parse ``key: value,`` lines of a flat TS object literal into Python.

    Args:
        body: An object literal body with one scalar property per line.

    Returns:
        The properties, with JSON-compatible values decoded.
    """
    values: dict[str, object] = {}
    for match in re.finditer(r"^\s*(\w+):\s*(.+?),?\s*$", body, re.M):
        key, raw = match.groups()
        raw = raw.rstrip(",")
        values[key] = [] if raw == "[]" else json.loads(raw)
    return values


def _ts_union(name: str) -> set[str]:
    """Return the string members of an exported TS union type in types.ts.

    Args:
        name: The type name.

    Returns:
        The quoted members.
    """
    source = TYPES_TS.read_text(encoding="utf-8")
    match = re.search(rf"export type {name} =(.*?);", source, re.S)
    assert match, f"{name} not found in types.ts"
    return set(re.findall(r'"([^"]+)"', match.group(1)))


@needs_repo
def test_label_defaults_match_types_ts():
    """DEFAULT_LABEL_STYLE mirrors DEFAULT_LAYER_STYLE.labels exactly."""
    source = TYPES_TS.read_text(encoding="utf-8")
    style = _ts_object_literal(source, "export const DEFAULT_LAYER_STYLE: LayerStyle =")
    labels = _ts_literal_values(_ts_object_literal(style, "labels:"))
    assert labels == project.DEFAULT_LABEL_STYLE


@needs_repo
def test_label_and_story_vocabularies_match_types_ts():
    """The enum sets the builders validate against are the app's own."""
    assert _ts_union("LabelAnchor") == project.LABEL_ANCHORS
    assert _ts_union("LabelTransform") == project.LABEL_TRANSFORMS
    assert _ts_union("LabelDedupe") == project.LABEL_DEDUPE_MODES
    assert _ts_union("StoryChapterAlignment") == project.STORY_ALIGNMENTS
    assert _ts_union("StoryChapterAnimation") == project.STORY_ANIMATIONS
    assert _ts_union("StoryInsetPosition") == project.STORY_INSET_POSITIONS
    assert _ts_union("StorySlideMode") == project.STORY_SLIDE_MODES


@needs_repo
def test_story_defaults_match_types_ts():
    """DEFAULT_STORY_MAP mirrors the app's DEFAULT_STORY_MAP."""
    source = TYPES_TS.read_text(encoding="utf-8")
    body = _ts_object_literal(source, "export const DEFAULT_STORY_MAP: StoryMap =")
    assert _ts_literal_values(body) == project.DEFAULT_STORY_MAP


@needs_repo
def test_plugin_state_ids_exist_in_the_plugin_sources():
    """Every id set_plugin_state accepts is still a plugin id in the app."""
    text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in PLUGINS_SRC.rglob("*.ts")
        if ".test." not in path.name
    )
    missing = sorted(i for i in project.PLUGIN_STATE_IDS if f'"{i}"' not in text)
    assert not missing, f"plugin ids no longer in packages/plugins/src: {missing}"


# -- round-trip fixture -------------------------------------------------------


def build_round_trip_project() -> dict:
    """Build the pinned project the TypeScript round-trip test loads.

    Every id is fixed so the output is deterministic.

    Returns:
        A project exercising each authoring function in this module.
    """
    p = project.build_empty_project("Python authoring round trip", center=[-84, 36], zoom=6)
    p.pop("id", None)
    layer = project.geojson_layer("Cities", POINT_FC)
    layer["id"] = "cities"
    authoring.add_layer(p, layer)
    authoring.set_layer_filter(p, "cities", ["all", [">=", ["get", "pop"], 20], ["has", "name"]])
    authoring.set_labels(
        p,
        "cities",
        "name",
        size=14,
        anchor="top",
        offset_y=0.8,
        halo_width=2,
        transform="uppercase",
        dedupe="unique",
        number_format=True,
        number_decimals=1,
        number_locale="de-DE",
        size_expression=["interpolate", ["linear"], ["get", "pop"], 0, 10, 100, 20],
        visibility_expression=[">", ["get", "pop"], 0],
    )
    authoring.set_layer_metadata(
        p,
        "cities",
        title="Cities of Tennessee",
        abstract="Two sample cities.",
        keywords="cities, sample",
        license="CC-BY-4.0",
        attribution="GeoLibre",
        contact={"name": "Ada", "email": "ada@example.org", "organization": "GeoLibre"},
        lineage="Hand-made for the round-trip test.",
        temporal_extent=("2019-01-01", "2019-12-31T12:00:00Z"),
        links=["https://example.org", {"href": "https://example.org/l", "rel": "license"}],
    )
    authoring.set_plugin_state(
        p, "maplibre-gl-graticule", {"interval": 10, "color": "#888888"}, position="top-left"
    )
    authoring.set_story_map(
        p,
        title="A tour",
        subtitle="Two stops",
        byline="GeoLibre",
        theme="light",
        show_markers=True,
        inset=True,
        inset_position="top-right",
        start_slide="global",
        end_slide="black",
    )
    authoring.add_story_chapter(
        p,
        "Overview",
        description="Every city.",
        zoom=4,
        bearing=-45,
        chapter_id="overview",
        on_enter=[{"id": "fade-in", "layer": "Cities", "opacity": 1, "duration": 800}],
    )
    authoring.add_story_chapter(
        p,
        "Close up",
        center=[-83.5, 35.5],
        zoom=11.5,
        pitch=45,
        image="https://example.com/photo.jpg",
        alignment="right",
        map_animation="easeTo",
        rotate_animation=True,
        chapter_id="close-up",
        on_exit=[{"id": "fade-out", "layer": "cities", "opacity": 0.25}],
    )
    p["bookmarkGroups"] = [project.bookmark_folder("Neighborhoods", folder_id="hoods")]
    authoring.add_bookmark(
        p,
        "Downtown",
        center=[-83.92, 35.96],
        zoom=14,
        pitch=30,
        bearing=-20,
        folder="hoods",
        visible_layers=["Cities"],
        bookmark_id="downtown",
        created_at=1_700_000_000_000,
    )
    authoring.add_bookmark(p, "Region", zoom=6, bookmark_id="region", created_at=1_700_000_000_001)
    return p


@pytest.mark.skipif(
    not FIXTURE.parent.is_dir(), reason="the round-trip fixture ships in the repo only"
)
def test_round_trip_fixture_is_current():
    """The pinned fixture is exactly what the authoring functions produce now.

    The TypeScript side (tests/python-authoring-roundtrip.test.ts) proves the
    fixture survives the app's parseProject; this proves the fixture is still
    what Python writes, so the two together cover the round trip.
    """
    built = build_round_trip_project()
    text = json.dumps(built, indent=2) + "\n"
    if os.environ.get("GEOLIBRE_REGEN_FIXTURES") == "1":
        FIXTURE.write_text(text, encoding="utf-8")
    assert FIXTURE.is_file(), "run with GEOLIBRE_REGEN_FIXTURES=1 to create the fixture"
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == built


# -- bookmarks ------------------------------------------------------------------


def test_add_bookmark_defaults_to_the_saved_view(proj):
    proj["mapView"] = {"center": [-83.9, 35.9], "zoom": 9, "pitch": 10, "bearing": 350}
    bookmark = authoring.add_bookmark(proj, "Home")
    assert (bookmark["lng"], bookmark["lat"], bookmark["zoom"]) == (-83.9, 35.9, 9)
    assert (bookmark["pitch"], bookmark["bearing"]) == (10, 350)
    assert "groupId" not in bookmark and "extra" not in bookmark
    assert proj["bookmarks"] == [bookmark]
    # No folder was asked for, so the project carries no empty folder list.
    assert "bookmarkGroups" not in proj


def test_add_bookmark_files_it_in_a_folder_next_to_its_members(proj):
    first = authoring.add_bookmark(proj, "A", zoom=1, folder="Parks")
    authoring.add_bookmark(proj, "Loose", zoom=1)
    third = authoring.add_bookmark(proj, "B", zoom=1, folder="parks-missing-name-match")
    fourth = authoring.add_bookmark(proj, "C", zoom=1, folder="Parks")
    folders = {f["name"]: f["id"] for f in proj["bookmarkGroups"]}
    assert first["groupId"] == fourth["groupId"] == folders["Parks"]
    assert third["groupId"] == folders["parks-missing-name-match"]
    # "C" lands right after "A", keeping the Parks folder contiguous.
    assert [b["name"] for b in proj["bookmarks"]] == ["A", "C", "Loose", "B"]


def test_add_bookmark_resolves_visible_layers(proj):
    bookmark = authoring.add_bookmark(proj, "Cities only", zoom=3, visible_layers=["cities"])
    layer_id = authoring.find_layer(proj, "Cities")["id"]
    assert bookmark["extra"] == {"visibleLayerIds": [layer_id]}
    with pytest.raises(ValueError):
        authoring.add_bookmark(proj, "Bad", zoom=3, visible_layers=["no such layer"])


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"center": [200, 0]}, "longitude"),
        ({"center": [0, 95]}, "latitude"),
        ({"zoom": 30}, "zoom"),
        ({"pitch": 90}, "pitch"),
    ],
)
def test_add_bookmark_rejects_bad_values(proj, kwargs, message):
    with pytest.raises(ValueError, match=message):
        authoring.add_bookmark(proj, "Bad", **{"center": [0, 0], "zoom": 1, **kwargs})
    # A refused bookmark leaves no empty lists behind.
    assert "bookmarks" not in proj


def test_remove_bookmark_by_name_id_or_index(proj):
    a = authoring.add_bookmark(proj, "Alpha", zoom=1)
    authoring.add_bookmark(proj, "Beta", zoom=1)
    authoring.add_bookmark(proj, "Gamma", zoom=1)
    assert [b["name"] for b in authoring.remove_bookmark(proj, "beta")] == ["Alpha", "Gamma"]
    authoring.remove_bookmark(proj, a["id"])
    authoring.remove_bookmark(proj, 0)
    assert "bookmarks" not in proj
    with pytest.raises(ValueError, match="no bookmark"):
        authoring.remove_bookmark(proj, "Alpha")


def test_describe_project_lists_bookmarks(proj):
    assert "bookmarks" not in authoring.describe_project(proj)
    authoring.add_bookmark(proj, "Home", zoom=2, folder="Mine")
    assert authoring.describe_project(proj)["bookmarks"] == [
        {"id": proj["bookmarks"][0]["id"], "name": "Home", "folder": "Mine"}
    ]


def test_map_add_bookmark_accepts_layer_handles(monkeypatch):
    # No server: the bundled app is not needed to author a project.
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    m = Map()
    layer = m.get_layer(m.add_geojson(POINT_FC, name="Cities"))
    bookmark = m.add_bookmark("Here", center=(1, 2), zoom=5, visible_layers=[layer])
    assert bookmark["extra"] == {"visibleLayerIds": [layer.id]}
    assert m.project["bookmarks"] == [bookmark]
    m.remove_bookmark("Here")
    assert "bookmarks" not in m.project
