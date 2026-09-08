"""Cesium Ion asset layers (issue #2290): builders, the Map API, and the MCP tool."""

from __future__ import annotations

import pytest

from geolibre import project


def test_cesium_ion_tileset_shape():
    layer = project.cesium_ion_layer("Buildings", 96188, altitude_offset=4)
    assert layer["type"] == "3d-tiles"
    assert layer["source"] == {
        "type": "3d-tiles",
        "ionAssetId": 96188,
        "sourceId": layer["id"],
        "altitudeOffset": 4,
    }
    md = layer["metadata"]
    assert md["sourceKind"] == "cesium-ion"
    assert md["externalNativeLayer"] is True
    assert md["identifiable"] is False
    assert md["customLayerType"] == "3d-tiles"
    assert md["altitudeOffset"] == 4
    assert md["nativeLayerIds"] == [layer["id"]]
    assert "sourcePath" not in layer


def test_cesium_ion_imagery_shape():
    layer = project.cesium_ion_layer("Aerial", 2, kind="imagery")
    assert layer["type"] == "raster"
    assert layer["source"] == {"type": "raster", "ionAssetId": 2, "sourceId": layer["id"]}
    assert "altitudeOffset" not in layer["source"]
    assert "customLayerType" not in layer["metadata"]
    assert layer["metadata"]["externalNativeLayer"] is True


@pytest.mark.parametrize("bad", [0, -1, True, "96188", 1.5])
def test_cesium_ion_rejects_bad_asset_ids(bad):
    with pytest.raises(ValueError):
        project.cesium_ion_layer("x", bad)


def test_cesium_ion_rejects_unknown_kind():
    with pytest.raises(ValueError):
        project.cesium_ion_layer("x", 1, kind="terrain")


def test_three_d_tiles_layer_accepts_ion_asset():
    layer = project.three_d_tiles_layer("B", ion_asset_id=96188, altitude_offset=2)
    assert layer["metadata"]["sourceKind"] == "cesium-ion"
    assert layer["source"]["ionAssetId"] == 96188
    assert layer["source"]["altitudeOffset"] == 2


@pytest.mark.parametrize(
    "kwargs",
    [{}, {"url": "https://e/tileset.json", "ion_asset_id": 1}],
)
def test_three_d_tiles_layer_needs_exactly_one_source(kwargs):
    with pytest.raises(ValueError):
        project.three_d_tiles_layer("T", **kwargs)


def test_three_d_tiles_layer_rejects_headers_on_an_ion_asset():
    with pytest.raises(ValueError, match="request_headers"):
        project.three_d_tiles_layer("T", ion_asset_id=1, request_headers={"k": "v"})
