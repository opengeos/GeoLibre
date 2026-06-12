"""Tests for Map helpers that do not require a running widget/server."""

from __future__ import annotations

import pytest

import geolibre.geolibre as gmod
from geolibre.geolibre import Map


@pytest.fixture
def m(monkeypatch):
    """A Map instance with the static server stubbed out (no bundle needed)."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    return Map()


def _last_layer(widget):
    return widget.project["layers"][-1]


def test_remote_mode_explicit():
    assert Map._resolve_remote_mode(True) == "remote"
    assert Map._resolve_remote_mode(False) == ""


def test_remote_mode_auto_local(monkeypatch):
    monkeypatch.delenv("JUPYTERHUB_SERVICE_PREFIX", raising=False)
    assert Map._resolve_remote_mode("auto") == ""


def test_remote_mode_auto_jupyterhub(monkeypatch):
    monkeypatch.setenv("JUPYTERHUB_SERVICE_PREFIX", "/user/alice/")
    assert Map._resolve_remote_mode("auto") == "remote"


def test_remote_mode_invalid():
    with pytest.raises(ValueError):
        Map._resolve_remote_mode("bogus")


def test_remote_mode_colab_forces_direct(monkeypatch):
    # Colab uses its own port proxy (front-end), which needs the localhost
    # server; an explicit server_proxy=True must not switch it to the remote
    # path.
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: True))
    assert Map._resolve_remote_mode(True) == ""


def test_remote_mode_non_colab_uses_remote(monkeypatch):
    monkeypatch.setattr(Map, "_running_on_colab", staticmethod(lambda: False))
    assert Map._resolve_remote_mode(True) == "remote"


def test_add_wms_appends_record_and_bumps_seq(m):
    seq = m._seq
    layer_id = m.add_wms("https://e/wms", "a,b")
    layer = _last_layer(m)
    assert layer["id"] == layer_id
    assert layer["type"] == "wms"
    assert m._seq == seq + 1


def test_add_wmts(m):
    m.add_wmts("https://t/{z}/{y}/{x}.png")
    assert _last_layer(m)["type"] == "wmts"


def test_add_raster_is_cog(m):
    m.add_raster("https://e/dem.tif", bands=[1, 2, 3])
    layer = _last_layer(m)
    assert layer["type"] == "cog"
    assert layer["metadata"]["rasterState"]["bands"] == [1, 2, 3]


def test_add_vector_url_uses_control(m):
    m.add_vector("https://e/data.fgb", data_format="flatgeobuf")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["metadata"]["sourceKind"] == "maplibre-gl-vector"


def test_add_geoparquet_sets_format(m):
    m.add_geoparquet("https://e/d.parquet")
    assert _last_layer(m)["metadata"]["vectorState"]["format"] == "parquet"


def test_add_flatgeobuf_sets_format(m):
    m.add_flatgeobuf("https://e/d.fgb")
    assert _last_layer(m)["metadata"]["vectorState"]["format"] == "flatgeobuf"


def test_add_vector_tiles(m):
    m.add_vector_tiles("https://e/tiles.json", source_layer="x")
    layer = _last_layer(m)
    assert layer["type"] == "vector-tiles"
    assert layer["source"]["sourceLayer"] == "x"


def test_add_pmtiles(m):
    m.add_pmtiles("https://e/x.pmtiles", source_layers=["roads"])
    layer = _last_layer(m)
    assert layer["type"] == "pmtiles"
    assert layer["metadata"]["sourceLayers"] == ["roads"]


def test_add_3d_tiles(m):
    m.add_3d_tiles("https://e/tileset.json", altitude_offset=5)
    layer = _last_layer(m)
    assert layer["type"] == "3d-tiles"
    assert layer["source"]["altitudeOffset"] == 5


def test_add_video_wraps_single_url(m):
    m.add_video("https://e/a.mp4", [[0, 0], [1, 0], [1, 1], [0, 1]])
    assert _last_layer(m)["source"]["urls"] == ["https://e/a.mp4"]


def test_add_wfs_inlines_geojson(monkeypatch, m):
    fake_fc = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": None}],
    }
    monkeypatch.setattr(gmod._project, "load_featurecollection", lambda _url: fake_fc)
    m.add_wfs("https://e/wfs", "topp:states")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["geojson"] == fake_fc
    assert layer["metadata"]["service"] == "wfs"
    assert layer["metadata"]["sourceKind"] == "wfs-getfeature"
    assert layer["metadata"]["typeName"] == "topp:states"
    assert layer["metadata"]["featureCount"] == 1
    # Protocol fields are persisted on the source for round-trip editing.
    assert layer["source"]["service"] == "wfs"
    assert layer["source"]["typeName"] == "topp:states"
    assert layer["source"]["version"] == "2.0.0"
    assert layer["source"]["outputFormat"] == "application/json"


def test_add_vector_local_file_inlined(monkeypatch, m):
    fake_fc = {"type": "FeatureCollection", "features": []}
    captured = {}

    def fake_read(path, data_format=None):
        captured["path"] = path
        captured["data_format"] = data_format
        return fake_fc

    monkeypatch.setattr(gmod, "_read_local_vector", fake_read)
    # add_geoparquet routes a local path with the parquet hint threaded through.
    m.add_geoparquet("/data/cities.parquet")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["geojson"] == fake_fc
    assert captured["data_format"] == "parquet"


def test_add_vector_local_file_warns_on_ignored_kwargs(monkeypatch, m):
    monkeypatch.setattr(
        gmod, "_read_local_vector", lambda _p, data_format=None: {"type": "x"}
    )
    with pytest.warns(UserWarning, match="ignored for local files"):
        m.add_vector("/data/parcels.shp", source_layer="layer0")


def test_add_vector_geo_interface_inlined(m):
    class Fake:
        __geo_interface__ = {"type": "FeatureCollection", "features": []}

    m.add_vector(Fake(), name="GDF")
    layer = _last_layer(m)
    assert layer["type"] == "geojson"
    assert layer["name"] == "GDF"


def test_add_vector_geo_interface_warns_on_ignored_kwargs(m):
    class Fake:
        __geo_interface__ = {"type": "FeatureCollection", "features": []}

    with pytest.warns(UserWarning, match="__geo_interface__ objects"):
        m.add_vector(Fake(), render_mode="tiles")
