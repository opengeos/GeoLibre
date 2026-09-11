"""Native KML documents survive Python project construction and serialization."""

import json

import pytest

from geolibre import Map, project


@pytest.mark.parametrize(
    "data", ["<kml><Document/></kml>", "data:application/vnd.google-earth.kmz;base64,UEs="]
)
def test_native_kml_roundtrip(data):
    m = Map()
    layer_id = m.add_cesium_kml(data=data, source_path="landmarks.kmz")
    layer = json.loads(json.dumps(m.to_project()))["layers"][-1]
    assert layer["id"] == layer_id
    assert layer["source"]["kmlData"] == data
    assert layer["metadata"]["sourceKind"] == "cesium-kml"
    assert layer["sourcePath"] == "landmarks.kmz"


@pytest.mark.parametrize("kwargs", [{}, {"url": "  "}, {"data": "\n"}])
def test_empty_document_rejected(kwargs):
    with pytest.raises(ValueError, match="document or URL"):
        project.cesium_kml_layer("Empty", **kwargs)
