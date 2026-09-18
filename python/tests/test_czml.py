"""CZML dynamic 3D scene layers (issue #2290): builders, the Map API, and the MCP tool."""

from __future__ import annotations

import pytest

from geolibre import project


def test_czml_layer_url_shape():
    layer = project.czml_layer("Satellites", url="https://example.com/sat.czml")
    assert layer["type"] == "3d-tiles"
    assert layer["source"] == {
        "type": "3d-tiles",
        "url": "https://example.com/sat.czml",
        "sourceId": layer["id"],
    }
    md = layer["metadata"]
    assert md["sourceKind"] == "czml"
    assert md["externalNativeLayer"] is True
    assert md["identifiable"] is False
    # No customLayerType, like createCzmlLayer: the globe sync renders it, so
    # the Layer Library needs no restore pass to re-add it.
    assert "customLayerType" not in md
    assert md["nativeLayerIds"] == [layer["id"]]
    assert "sourcePath" not in layer


def test_czml_layer_data_shape():
    packets = [
        {"id": "document", "name": "Dynamic", "version": "1.0"},
        {"id": "orbit", "point": {"pixelSize": 10}},
    ]
    layer = project.czml_layer("Inline Orbit", data=packets, source_path="/local/orbit.czml")
    assert layer["type"] == "3d-tiles"
    assert layer["source"]["czmlData"] == packets
    assert layer["source"]["sourcePath"] == "/local/orbit.czml"
    assert layer["sourcePath"] == "/local/orbit.czml"
    assert layer["metadata"]["sourceKind"] == "czml"


@pytest.mark.parametrize("kwargs", [{}, {"data": []}, {"data": {}}])
def test_czml_layer_requires_url_or_packets(kwargs):
    """An empty document has nothing to render, so it is rejected like a missing one."""
    with pytest.raises(ValueError, match="url or non-empty data"):
        project.czml_layer("Missing", **kwargs)
