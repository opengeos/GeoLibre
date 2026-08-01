"""Tests for the kernel-side ``geolibre`` client's transport choice (issue #1442).

``notebook_client.py`` has to reach the live map from three very different
kernels: the desktop Notebook panel, an external frontend attached to the same
Jupyter server (VS Code), and JupyterLite in the browser. What it must never do
again is quietly do nothing, so every path here is checked for *which* transport
it used and whether it warned.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

pytest.importorskip("IPython", reason="the notebook client renders IPython displays")

import notebook_client  # noqa: E402


class FakeResponse(io.BytesIO):
    """Minimal ``urlopen`` result: a context manager exposing ``read()``."""

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()


@pytest.fixture
def relay(monkeypatch):
    """Point the client at a relay and record what it posts."""
    monkeypatch.setenv(notebook_client._RELAY_URL_ENV, "http://127.0.0.1:8766/geolibre/relay")
    monkeypatch.setenv(notebook_client._RELAY_TOKEN_ENV, "s3cret")

    class Relay:
        listeners = 1
        error: Exception | None = None
        calls: list[object] = []

    def fake_urlopen(request, timeout=None):  # noqa: ARG001 - signature parity
        Relay.calls.append(request)
        if Relay.error is not None:
            raise Relay.error
        body = (
            {"listeners": Relay.listeners}
            if request.full_url.endswith("/status")
            else _command_response(request, Relay.listeners)
        )
        return FakeResponse(json.dumps(body).encode())

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    return Relay


def _command_response(request, listeners):
    message = json.loads(request.data)
    response = {"delivered": listeners}
    if message.get("requestId"):
        response.update({"ok": True, "value": f"result-for-{message['method']}"})
    return response


@pytest.fixture
def displays(monkeypatch):
    """Capture the ``display(Javascript(...))`` fallback transport."""
    captured: list[object] = []
    monkeypatch.setattr(notebook_client, "display", captured.append)
    return captured


# -- the relay transport (any Jupyter frontend, including VS Code) -----------


def test_uses_the_relay_and_stays_quiet_when_a_window_receives_it(relay, displays, recwarn):
    notebook_client.HostMap().fly_to(-122.4, 37.8, zoom=11)

    assert len(relay.calls) == 1
    request = relay.calls[0]
    assert request.full_url == "http://127.0.0.1:8766/geolibre/relay/command"
    assert json.loads(request.data) == {
        "type": "geolibre:command",
        "requestId": "",
        "method": "flyTo",
        "params": {"center": [-122.4, 37.8], "zoom": 11.0},
    }
    # Delivered, so no postMessage output and nothing to warn about.
    assert displays == []
    assert [w for w in recwarn if issubclass(w.category, UserWarning)] == []


def test_authenticates_with_the_server_token(relay, displays):
    notebook_client.HostMap().fly_to(0, 0)

    assert relay.calls[0].get_header("Authorization") == "token s3cret"


def test_warns_when_no_window_is_listening(relay, displays):
    relay.listeners = 0

    with pytest.warns(notebook_client.GeoLibreNotConnectedWarning, match="no GeoLibre window"):
        notebook_client.HostMap().fly_to(0, 0)

    # Still tries the embedded-panel transport rather than dropping the command.
    assert len(displays) == 1


def test_warns_when_the_relay_cannot_be_reached(relay, displays):
    relay.error = urllib.error.URLError("connection refused")

    with pytest.warns(notebook_client.GeoLibreNotConnectedWarning, match="could not be reached"):
        notebook_client.HostMap().fly_to(0, 0)

    assert len(displays) == 1


def test_connect_warns_up_front_when_nothing_is_listening(relay):
    relay.listeners = 0

    with pytest.warns(notebook_client.GeoLibreNotConnectedWarning):
        notebook_client.connect()


def test_connect_is_quiet_when_a_window_is_listening(relay, recwarn):
    notebook_client.connect()

    assert [w for w in recwarn if issubclass(w.category, UserWarning)] == []


def test_is_connected_reports_the_relay_status(relay):
    assert notebook_client.is_connected() is True
    relay.listeners = 0
    assert notebook_client.is_connected() is False


def test_is_connected_is_false_when_the_relay_is_unreachable(relay):
    relay.error = OSError("boom")

    assert notebook_client.is_connected() is False


# -- the postMessage transport (embedded panel / JupyterLite) ----------------


def test_falls_back_to_post_message_without_a_relay(monkeypatch, displays):
    monkeypatch.delenv(notebook_client._RELAY_URL_ENV, raising=False)
    monkeypatch.setattr(notebook_client.sys, "platform", "emscripten")

    notebook_client.HostMap().fly_to(0, 0)

    # JupyterLite: the notebook page IS the app's iframe, so this is the right
    # transport and there is nothing to warn about.
    assert len(displays) == 1


def test_warns_on_a_plain_kernel_with_no_relay(monkeypatch, displays):
    monkeypatch.delenv(notebook_client._RELAY_URL_ENV, raising=False)
    monkeypatch.setattr(notebook_client.sys, "platform", "linux")

    with pytest.warns(
        notebook_client.GeoLibreNotConnectedWarning, match="not running on a GeoLibre Jupyter"
    ):
        notebook_client.HostMap().fly_to(0, 0)

    assert len(displays) == 1


def test_is_connected_without_a_relay_follows_the_kernel_kind(monkeypatch):
    monkeypatch.delenv(notebook_client._RELAY_URL_ENV, raising=False)
    monkeypatch.setattr(notebook_client.sys, "platform", "emscripten")
    assert notebook_client.is_connected() is True

    monkeypatch.setattr(notebook_client.sys, "platform", "linux")
    assert notebook_client.is_connected() is False


# -- payloads ----------------------------------------------------------------


def test_add_geojson_wraps_a_bare_geometry(relay, displays):
    layer_id = notebook_client.HostMap().add_geojson(
        {"type": "Point", "coordinates": [1, 2]}, name="Pin"
    )

    params = json.loads(relay.calls[0].data)["params"]
    assert json.loads(relay.calls[0].data)["requestId"]
    assert layer_id == "result-for-addGeoJsonLayer"
    assert params["name"] == "Pin"
    assert params["geojson"]["features"][0]["geometry"]["coordinates"] == [1, 2]
    assert params["style"] == {}


def test_add_geojson_sends_inline_style_overrides(relay, displays):
    notebook_client.HostMap().add_geojson(
        {"type": "FeatureCollection", "features": []},
        name="Major Cities",
        fillColor="#facc15",
        strokeColor="#d97706",
    )

    params = json.loads(relay.calls[0].data)["params"]
    assert params["style"] == {
        "fillColor": "#facc15",
        "strokeColor": "#d97706",
    }


def test_add_markers_builds_a_point_collection(relay, displays):
    notebook_client.HostMap().add_markers([(-122.4, 37.8), {"lng": 1, "lat": 2, "kind": "x"}])

    features = json.loads(relay.calls[0].data)["params"]["geojson"]["features"]
    assert [f["geometry"]["coordinates"] for f in features] == [[-122.4, 37.8], [1.0, 2.0]]
    assert features[1]["properties"] == {"kind": "x"}


def test_list_layers_returns_live_metadata(relay, monkeypatch):
    layers = [{"id": "cities", "name": "Cities", "type": "geojson"}]
    monkeypatch.setattr(
        notebook_client,
        "_request",
        lambda method, params=None: layers if method == "listLayers" else None,
    )

    assert notebook_client.HostMap().list_layers() == layers


def test_get_layer_returns_a_matching_layer(monkeypatch):
    layers = [
        {"id": "roads", "name": "Roads", "type": "geojson"},
        {"id": "cities", "name": "Cities", "type": "geojson"},
    ]
    monkeypatch.setattr(notebook_client.HostMap, "list_layers", lambda self: layers)

    assert notebook_client.HostMap().get_layer("cities") == layers[1]


def test_get_layer_raises_for_an_unknown_id(monkeypatch):
    monkeypatch.setattr(notebook_client.HostMap, "list_layers", lambda self: [])

    with pytest.raises(ValueError, match="missing"):
        notebook_client.HostMap().get_layer("missing")


def test_list_layers_raises_on_a_non_list_result(relay, monkeypatch):
    # An empty list would read as "the map has no layers" and hide the bug.
    monkeypatch.setattr(notebook_client, "_request", lambda method, params=None: {"oops": True})

    with pytest.raises(RuntimeError, match="unexpected layer list"):
        notebook_client.HostMap().list_layers()


def test_add_geojson_falls_back_when_no_window_is_connected(relay, displays):
    # Every other mutation degrades to the display transport (which still reaches
    # the embedded Notebook panel) rather than failing, so this must too.
    relay.listeners = 0

    with pytest.warns(notebook_client.GeoLibreNotConnectedWarning):
        layer_id = notebook_client.HostMap().add_geojson(
            {"type": "FeatureCollection", "features": []}
        )

    assert layer_id is None
    assert len(displays) == 1


def test_add_geojson_still_raises_when_the_handler_fails(relay, monkeypatch):
    # Only the not-connected case degrades; a real handler error must surface.
    def fail(url, method, params=None):
        raise RuntimeError("layerId must be a non-empty string")

    monkeypatch.setattr(notebook_client, "_request_from_relay", fail)

    with pytest.raises(RuntimeError, match="layerId"):
        notebook_client.HostMap().add_geojson({"type": "FeatureCollection", "features": []})


def test_add_geojson_raises_on_a_missing_layer_id(relay, monkeypatch):
    # str(None) would hand back "None", an id no later call could ever resolve.
    monkeypatch.setattr(
        notebook_client, "_request_from_relay", lambda url, method, params=None: None
    )

    with pytest.raises(RuntimeError, match="unexpected layer id"):
        notebook_client.HostMap().add_geojson({"type": "FeatureCollection", "features": []})


# -- relay failures ----------------------------------------------------------


def test_read_back_reports_an_answered_error_status_as_such(relay):
    # The relay answered (504 = the app did not return a result in time), so the
    # message must not send the reader looking for an unreachable server.
    relay.error = urllib.error.HTTPError(
        "http://127.0.0.1:8766/geolibre/relay/command",
        504,
        "Gateway Timeout",
        {},
        io.BytesIO(json.dumps({"message": "GeoLibre did not return a result in time."}).encode()),
    )

    with pytest.raises(RuntimeError, match="returned HTTP 504") as excinfo:
        notebook_client.HostMap().list_layers()

    assert "did not return a result in time" in str(excinfo.value)
    assert "could not be reached" not in str(excinfo.value)


def test_read_back_reports_an_unreachable_relay_as_such(relay):
    relay.error = urllib.error.URLError("connection refused")

    with pytest.raises(RuntimeError, match="could not be reached"):
        notebook_client.HostMap().list_layers()
