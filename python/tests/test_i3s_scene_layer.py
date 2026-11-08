"""ArcGIS I3S scene layers from ``add_3d_tiles`` (issue #3377)."""

import pytest

import geolibre.geolibre as gmod
from geolibre import Map, project

SF = (
    "https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/"
    "SanFrancisco_Bldgs/SceneServer/layers/0"
)


@pytest.mark.parametrize(
    "url",
    [
        SF,
        "https://host/arcgis/rest/services/City/SceneServer",
        "https://host/arcgis/rest/services/City/sceneserver?token=x",
        f"  {SF}  ",
    ],
)
def test_scene_server_urls_are_recognised(url):
    assert project.is_i3s_scene_layer_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/tileset.json",
        "https://host/SceneServerish/tileset.json",
        "https://host/arcgis/rest/services/City/MapServer",
        "https://host/tileset.json?ref=/SceneServer/x",
    ],
)
def test_other_urls_are_not_scene_layers(url):
    assert not project.is_i3s_scene_layer_url(url)


def test_scene_layer_url_is_filed_as_an_i3s_layer():
    layer = project.three_d_tiles_layer("SF", SF, altitude_offset=-5)
    layer_id = layer["id"]
    assert layer["type"] == "3d-tiles"
    assert layer["source"] == {
        "type": "arcgis-i3s",
        "url": SF,
        "sourceId": layer_id,
        "altitudeOffset": -5,
    }
    meta = layer["metadata"]
    assert meta["sourceKind"] == "arcgis-i3s"
    assert meta["customLayerType"] == "arcgis-i3s"
    assert meta["externalDeckLayer"] is True
    assert meta["externalNativeLayer"] is True
    assert meta["identifiable"] is False
    assert meta["nativeLayerIds"] == [f"{layer_id}-deck"]
    assert layer["sourcePath"] == SF


def test_scene_layer_keeps_request_headers():
    layer = project.three_d_tiles_layer("SF", SF, request_headers={"X-Key": "v"})
    assert layer["source"]["requestHeaders"] == {"X-Key": "v"}


def test_a_tileset_url_stays_a_plain_tileset():
    layer = project.three_d_tiles_layer("T", "https://example.com/tileset.json")
    assert layer["source"]["type"] == "3d-tiles"
    assert layer["metadata"]["sourceKind"] == "3d-tiles-url"


def test_map_add_3d_tiles_writes_the_scene_layer_to_the_project(monkeypatch):
    # Stub the static server so the test needs no bundled web app.
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    m = Map()
    layer_id = m.add_3d_tiles(SF, name="SF buildings")
    saved = next(layer for layer in m.to_project()["layers"] if layer["id"] == layer_id)
    assert saved["metadata"]["sourceKind"] == "arcgis-i3s"
    assert saved["name"] == "SF buildings"
