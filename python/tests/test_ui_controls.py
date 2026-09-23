"""Tests for Identify, map-control, and projection settings on Map."""

from __future__ import annotations

import pathlib
import re

import pytest

import geolibre.geolibre as gmod
from geolibre.geolibre import MAP_CONTROLS, MAP_PANELS, Map


@pytest.fixture
def m(monkeypatch):
    """A Map instance with the static server stubbed out (no bundle needed)."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    return Map()


def test_ui_starts_empty(m):
    assert m._ui == {}


def test_set_identify_defaults_to_all_layers(m):
    m.set_identify()
    assert m._ui == {"identify": "all"}


def test_set_identify_resolves_name_and_handle(m):
    layer_id = m.add_marker(-100, 40, name="Cities")
    m.set_identify("Cities")
    assert m._ui["identify"] == layer_id
    m.set_identify(None)
    assert m._ui["identify"] is None
    m.set_identify(m.get_layer(layer_id))
    assert m._ui["identify"] == layer_id


def test_set_identify_rejects_unknown_layer(m):
    with pytest.raises(ValueError):
        m.set_identify("missing")
    assert "identify" not in m._ui


def test_set_identify_reassigns_trait_for_sync(m):
    before = m._ui
    m.set_identify()
    assert m._ui is not before


def test_removing_identify_layer_clears_it(m):
    keep = m.add_marker(-100, 40, name="Keep")
    drop = m.add_marker(-90, 35, name="Drop")
    m.set_identify(drop)
    m.remove_layer(keep)
    assert m._ui["identify"] == drop
    m.remove_layer(drop)
    assert m._ui["identify"] is None


def test_clear_layers_clears_layer_identify_but_keeps_all(m):
    m.add_marker(-100, 40, name="A")
    m.set_identify("A")
    m.clear_layers()
    assert m._ui["identify"] is None
    m.set_identify("all")
    m.clear_layers()
    assert m._ui["identify"] == "all"


def test_show_and_hide_controls_accumulate(m):
    m.show_control("bookmark")
    m.show_control("search")
    m.hide_control("globe")
    assert m._ui["controls"] == {"bookmark": True, "search": True, "globe": False}
    m.hide_control("bookmark")
    assert m._ui["controls"]["bookmark"] is False


def test_show_control_keeps_identify(m):
    m.set_identify()
    m.show_control("search")
    assert m._ui == {"identify": "all", "controls": {"search": True}}


def test_show_control_rejects_unknown_name(m):
    with pytest.raises(ValueError, match="Unknown control"):
        m.show_control("terrain")


def test_set_projection_writes_project_preferences(m):
    assert m.projection == "globe"
    m.set_projection("mercator")
    assert m.project["preferences"]["map"]["projection"] == "mercator"
    assert m.projection == "mercator"
    m.set_projection("globe")
    assert m.projection == "globe"


def test_set_projection_rejects_unknown(m):
    with pytest.raises(ValueError):
        m.set_projection("albers")


def test_load_project_drops_identify_for_a_missing_layer(m):
    """A pinned Identify target that the incoming project lacks is cleared."""
    layer_id = m.add_marker(-100, 40, name="Cities")
    m.set_identify("Cities")
    assert m._ui["identify"] == layer_id
    m.load_project({"version": m.project["version"], "name": "Other", "mapView": {}})
    assert m._ui["identify"] is None


def test_load_project_keeps_identify_when_the_layer_survives(m):
    """Reloading a project that still carries the layer leaves Identify armed."""
    layer_id = m.add_marker(-100, 40, name="Cities")
    m.set_identify("Cities")
    m.load_project(m.project)
    assert m._ui["identify"] == layer_id


def test_load_project_keeps_identify_all(m):
    """ "all" is not tied to any layer, so it survives a project replacement."""
    m.add_marker(-100, 40, name="Cities")
    m.set_identify()
    m.load_project({"version": m.project["version"], "name": "Other", "mapView": {}})
    assert m._ui["identify"] == "all"


def test_remove_layer_disarms_identify_before_the_project_sync(m):
    """Removing the armed layer clears Identify rather than leaving it stale."""
    m.add_marker(-100, 40, name="Cities")
    m.set_identify("Cities")
    m.remove_layer("Cities")
    assert m._ui["identify"] is None


def _ts_string_set(source: str, name: str) -> set[str]:
    """Pull the string literals out of an exported TS array constant.

    Args:
        source: Contents of the TypeScript module.
        name: The exported constant to read.

    Returns:
        The quoted strings in that array.

    Raises:
        AssertionError: If the constant is not found.
    """
    match = re.search(rf"export const {name} = \[(.*?)\]", source, re.DOTALL)
    assert match, f"{name} not found in ui-controls.ts"
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def test_control_lists_match_the_typescript_source():
    """MAP_PANELS/MAP_CONTROLS mirror the TS lists by hand; catch the drift.

    Adding a control on one side only would otherwise pass CI on both and
    silently accept a name the app rejects (or the reverse).
    """
    ts_path = (
        pathlib.Path(__file__).resolve().parents[2]
        / "apps/geolibre-desktop/src/lib/scripting/ui-controls.ts"
    )
    if not ts_path.exists():
        pytest.skip("frontend source not present in this checkout")
    source = ts_path.read_text(encoding="utf-8")
    assert _ts_string_set(source, "SCRIPTABLE_PANELS") == set(MAP_PANELS)
    assert _ts_string_set(source, "SCRIPTABLE_MAP_CONTROLS") == set(MAP_CONTROLS)
