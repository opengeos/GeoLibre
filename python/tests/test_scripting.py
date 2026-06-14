"""Tests for the scripting API: request/reply RPC, events, Layer, Feature."""

from __future__ import annotations

import base64
import contextlib

import pytest

import geolibre.geolibre as gmod
from geolibre.geolibre import Feature, Layer, Map


@pytest.fixture
def m(monkeypatch):
    """A Map instance with the static server stubbed out (no bundle needed)."""
    monkeypatch.setattr(gmod, "serve_app", lambda *_a, **_k: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    return Map()


def _reply_immediately(widget, *, ok=True, value=None, error=None):
    """Return a fake ``send`` that synchronously delivers a matching result."""

    def fake_send(message, *_a, **_k):
        widget._on_custom_msg(
            widget,
            {
                "type": "geolibre:result",
                "requestId": message["requestId"],
                "ok": ok,
                "value": value,
                "error": error,
            },
            None,
        )

    return fake_send


# -- request() / reply ---------------------------------------------------


def test_request_sends_command_and_resolves(m, monkeypatch):
    sent = []

    def fake_send(message, *_a, **_k):
        sent.append(message)
        m._on_custom_msg(
            m,
            {
                "type": "geolibre:result",
                "requestId": message["requestId"],
                "ok": True,
                "value": [1.0, 2.0],
            },
            None,
        )

    monkeypatch.setattr(m, "send", fake_send)
    # The reply lands synchronously inside send(), so the kernel pump is a no-op.
    monkeypatch.setattr(Map, "_wait_for_result", staticmethod(lambda *_a, **_k: None))

    result = m.get_center()
    assert result == [1.0, 2.0]
    assert sent[0]["type"] == "geolibre:command"
    assert sent[0]["method"] == "getCenter"
    assert "requestId" in sent[0]
    # The slot is cleaned up once resolved.
    assert m._pending == {}


def test_request_raises_on_error_reply(m, monkeypatch):
    monkeypatch.setattr(m, "send", _reply_immediately(m, ok=False, error="boom"))
    monkeypatch.setattr(Map, "_wait_for_result", staticmethod(lambda *_a, **_k: None))
    with pytest.raises(RuntimeError, match="boom"):
        m.request("whatever")
    assert m._pending == {}


def test_wait_for_result_times_out(monkeypatch):
    # Replace the kernel pump with a no-op poll so the timeout path runs without a
    # live kernel; the slot never resolves, so it must raise TimeoutError.
    @contextlib.contextmanager
    def fake_ui_events():
        yield lambda _n=1: None

    monkeypatch.setattr("jupyter_ui_poll.ui_events", fake_ui_events)
    slot = {"done": False, "ok": False, "value": None, "error": None}
    with pytest.raises(TimeoutError, match="timed out"):
        Map._wait_for_result(slot, "getCenter", 0.05)


def test_result_for_unknown_request_is_ignored(m):
    # A late reply for a request that already timed out must not crash.
    m._on_custom_msg(
        m,
        {"type": "geolibre:result", "requestId": "gone", "ok": True, "value": 1},
        None,
    )


# -- events --------------------------------------------------------------


def test_on_dispatches_event_and_unsubscribes(m):
    seen = []
    off = m.on("click", lambda payload: seen.append(payload))
    m._on_custom_msg(
        m,
        {"type": "geolibre:event", "event": "click", "payload": {"lngLat": [1, 2]}},
        None,
    )
    assert seen == [{"lngLat": [1, 2]}]
    off()
    m._on_custom_msg(
        m,
        {"type": "geolibre:event", "event": "click", "payload": {"lngLat": [3, 4]}},
        None,
    )
    assert len(seen) == 1


def test_event_handler_exception_is_isolated(m):
    seen = []

    def boom(_payload):
        raise ValueError("nope")

    m.on("click", boom)
    m.on("click", lambda payload: seen.append(payload))
    with pytest.warns(UserWarning, match="event handler"):
        m._on_custom_msg(
            m,
            {"type": "geolibre:event", "event": "click", "payload": {"x": 1}},
            None,
        )
    # The second handler still ran despite the first raising.
    assert seen == [{"x": 1}]


def test_on_click_convenience(m):
    seen = []
    m.on_click(lambda payload: seen.append(payload))
    m._on_custom_msg(
        m,
        {"type": "geolibre:event", "event": "click", "payload": "hit"},
        None,
    )
    assert seen == ["hit"]


# -- high-level method param shaping (request stubbed) -------------------


def test_fly_to_builds_params(m, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        m,
        "request",
        lambda method, params=None, **_k: captured.update(method=method, params=params),
    )
    m.fly_to(1, 2, zoom=5, duration=1000)
    assert captured["method"] == "flyTo"
    assert captured["params"]["center"] == [1.0, 2.0]
    assert captured["params"]["zoom"] == 5.0
    assert captured["params"]["duration"] == 1000.0
    assert "bearing" not in captured["params"]


def test_identify_builds_params(m, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        m,
        "request",
        lambda method, params=None, **_k: captured.update(method=method, params=params)
        or [],
    )
    m.identify(-100, 40, layer_id="layer-1")
    assert captured["method"] == "identify"
    assert captured["params"] == {"lngLat": [-100.0, 40.0], "layerId": "layer-1"}


def test_run_algorithm_builds_params(m, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        m,
        "request",
        lambda method, params=None, **_k: captured.update(method=method, params=params),
    )
    m.run_algorithm("buffer", {"distance": 100})
    assert captured["method"] == "runAlgorithm"
    assert captured["params"] == {"id": "buffer", "params": {"distance": 100}}


def test_get_features_wraps_in_feature(m, monkeypatch):
    monkeypatch.setattr(
        m,
        "request",
        lambda *_a, **_k: [
            {"type": "Feature", "properties": {"a": 1}, "geometry": None}
        ],
    )
    feats = m.get_features("layer-1")
    assert isinstance(feats[0], Feature)
    assert feats[0].properties == {"a": 1}


def test_to_image_decodes_base64(m, monkeypatch):
    png = b"\x89PNG\r\n\x1a\n fake"
    data_url = "data:image/png;base64," + base64.b64encode(png).decode()
    monkeypatch.setattr(m, "request", lambda *_a, **_k: data_url)
    assert m.to_image() == png


def test_to_image_writes_path(m, monkeypatch, tmp_path):
    png = b"\x89PNG fake"
    data_url = "data:image/png;base64," + base64.b64encode(png).decode()
    monkeypatch.setattr(m, "request", lambda *_a, **_k: data_url)
    out = tmp_path / "nested" / "map.png"
    assert m.to_image(str(out)) is None
    assert out.read_bytes() == png


# -- Layer / Feature object model ---------------------------------------


def test_feature_accessors():
    f = Feature(
        {
            "type": "Feature",
            "id": 7,
            "geometry": {"type": "Point", "coordinates": [1, 2]},
            "properties": {"a": 1},
        }
    )
    assert isinstance(f, dict)
    assert f.id == 7
    assert f.geometry["type"] == "Point"
    assert f.properties == {"a": 1}
    assert f.__geo_interface__["id"] == 7


def test_layers_property_returns_layer_objects(m):
    m.add_geojson({"type": "FeatureCollection", "features": []}, name="A")
    layers = m.layers
    assert len(layers) == 1
    assert isinstance(layers[0], Layer)
    assert layers[0].name == "A"


def test_get_layer_unknown_raises(m):
    with pytest.raises(ValueError, match="No layer with id"):
        m.get_layer("missing")


def test_layer_setters_mutate_project_and_bump_seq(m):
    layer_id = m.add_geojson({"type": "FeatureCollection", "features": []}, name="A")
    layer = m.get_layer(layer_id)
    assert layer.name == "A"
    assert layer.visible is True

    seq = m._seq
    layer.opacity = 0.5
    assert m._seq == seq + 1
    assert layer.opacity == 0.5

    layer.visible = False
    assert layer.visible is False

    layer.name = "Renamed"
    assert layer.name == "Renamed"

    layer.set_style(fillColor="#ff0000")
    assert layer.style["fillColor"] == "#ff0000"


def test_layer_remove(m):
    layer_id = m.add_geojson({"type": "FeatureCollection", "features": []}, name="A")
    m.get_layer(layer_id).remove()
    assert m.project["layers"] == []


def test_layer_zoom_to_sends_command(m, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        m,
        "request",
        lambda method, params=None, **_k: captured.update(method=method, params=params),
    )
    layer_id = m.add_geojson({"type": "FeatureCollection", "features": []}, name="A")
    m.get_layer(layer_id).zoom_to()
    assert captured["method"] == "zoomToLayer"
    assert captured["params"] == {"layerId": layer_id}


def test_stale_layer_access_raises(m):
    layer_id = m.add_geojson({"type": "FeatureCollection", "features": []}, name="A")
    layer = m.get_layer(layer_id)
    m.remove_layer(layer_id)
    with pytest.raises(ValueError, match="no longer exists"):
        _ = layer.name
