"""Tests for the scripting API: request/reply RPC, events, Layer, Feature."""

from __future__ import annotations

import base64
import contextlib
import json
import sys
import types

import pytest

import geolibre.geolibre as gmod
from geolibre.geolibre import Feature, Layer, Map
from geolibre.project import redact_credentials


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
    # live kernel; the slot never resolves, so it must raise TimeoutError. Inject
    # a fake jupyter_ui_poll into sys.modules so the test runs even where the
    # optional package isn't installed (e.g. the package-publish CI job).
    @contextlib.contextmanager
    def fake_ui_events():
        yield lambda _n=1: None

    monkeypatch.setitem(
        sys.modules, "jupyter_ui_poll", types.SimpleNamespace(ui_events=fake_ui_events)
    )
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
        lambda method, params=None, **_k: captured.update(method=method, params=params) or [],
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


def test_list_whitebox_tools_builds_request(m, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        m,
        "request",
        lambda method, params=None, **kwargs: (
            captured.update(method=method, params=params, kwargs=kwargs) or []
        ),
    )

    assert m.list_whitebox_tools(timeout=12) == []
    assert captured == {
        "method": "listWhiteboxTools",
        "params": None,
        "kwargs": {"timeout": 12},
    }


def test_run_whitebox_tool_resolves_layer_handles(m, monkeypatch):
    layer = m.get_layer(m.add_geojson({"type": "FeatureCollection", "features": []}, name="Input"))
    captured = {}
    monkeypatch.setattr(
        m,
        "request",
        lambda method, params=None, **kwargs: (
            captured.update(method=method, params=params, kwargs=kwargs)
            or {"logs": [], "resultLayerIds": []}
        ),
    )

    m.run_whitebox_tool("centroids", {"input": layer, "text_output": False}, timeout=45)

    assert captured["method"] == "runWhiteboxTool"
    assert captured["params"] == {
        "id": "centroids",
        "params": {"input": layer.id, "text_output": False},
    }
    assert captured["kwargs"] == {"timeout": 45}


def test_get_features_wraps_in_feature(m, monkeypatch):
    monkeypatch.setattr(
        m,
        "request",
        lambda *_a, **_k: [{"type": "Feature", "properties": {"a": 1}, "geometry": None}],
    )
    feats = m.get_features("layer-1")
    assert isinstance(feats[0], Feature)
    assert feats[0].properties == {"a": 1}


def test_get_selected_features_wraps_in_feature(m, monkeypatch):
    monkeypatch.setattr(
        m,
        "request",
        lambda method, params=None, **_k: (
            [{"type": "Feature", "properties": {"sel": 1}, "geometry": None}]
            if method == "getSelectedFeatures"
            else []
        ),
    )
    feats = m.get_selected_features()
    assert isinstance(feats[0], Feature)
    assert feats[0].properties == {"sel": 1}


def test_get_selected_features_as_gdf(m, monkeypatch):
    geopandas = pytest.importorskip("geopandas")
    monkeypatch.setattr(
        m,
        "request",
        lambda *_a, **_k: [
            {
                "type": "Feature",
                "properties": {"sel": 1},
                "geometry": {"type": "Point", "coordinates": [0, 0]},
            }
        ],
    )
    gdf = m.get_selected_features(as_gdf=True)
    assert isinstance(gdf, geopandas.GeoDataFrame)
    assert len(gdf) == 1


def test_get_drawn_features_wraps_in_feature(m, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        m,
        "request",
        lambda method, params=None, **_k: (
            captured.update(method=method)
            or [{"type": "Feature", "properties": {"roi": 1}, "geometry": None}]
        ),
    )
    feats = m.get_drawn_features()
    assert captured["method"] == "getDrawnFeatures"
    assert isinstance(feats[0], Feature)
    assert feats[0].properties == {"roi": 1}


def test_user_rois_returns_featurecollection(m, monkeypatch):
    monkeypatch.setattr(
        m,
        "request",
        lambda *_a, **_k: [{"type": "Feature", "properties": {}, "geometry": None}],
    )
    fc = m.user_rois
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 1
    # Plain dicts, not Feature instances, so the result is a clean GeoJSON value.
    assert type(fc["features"][0]) is dict


def test_get_drawn_features_as_gdf(m, monkeypatch):
    geopandas = pytest.importorskip("geopandas")
    monkeypatch.setattr(
        m,
        "request",
        lambda *_a, **_k: [
            {
                "type": "Feature",
                "properties": {"roi": 1},
                "geometry": {"type": "Point", "coordinates": [1, 2]},
            }
        ],
    )
    gdf = m.get_drawn_features(as_gdf=True)
    assert isinstance(gdf, geopandas.GeoDataFrame)
    assert len(gdf) == 1
    assert gdf.crs is not None


def test_to_html_returns_string_with_project(m):
    html = m.to_html()
    assert "<iframe" in html
    assert "embed=1" in html
    assert "geolibre:load-project" in html
    # The project rides inside the JSON <script> block.
    assert '"mapView"' in html


def test_python_project_egress_redacts_credentials(m, tmp_path):
    m.project["basemapStyleUrl"] = (
        "https://styles.example.com/map.json?api-key=python-basemap-secret"
    )
    m.project["preferences"]["environmentVariables"] = [
        {"key": "SERVICE_TOKEN", "value": "python-env-secret", "enabled": True}
    ]
    m.project["preferences"]["geocoding"] = {
        "providerId": "mapbox",
        "apiKeys": {"mapbox": "python-geocoder-secret"},
        "forwardEndpoint": "https://geocode.example.com?key=python-endpoint-secret",
    }
    m.project["layers"] = [
        {
            "id": "auth",
            "name": "Authenticated tiles",
            "type": "3d-tiles",
            "source": {
                "url": "https://user:p@ssword@example.com/tiles?token=python-url-secret&subscription%2Dkey=python-subscription-secret",
                "requestHeaders": {"Authorization": "Bearer python-header-secret"},
            },
            "visible": True,
            "opacity": 1,
            "style": {},
            "metadata": {},
            "sourcePath": "https://files.example.com/data?token=python-path-secret",
        }
    ]
    m.project["plugins"] = {
        "manifestUrls": ["https://example.com/plugin.json?sasToken=python-manifest-secret"],
        "activePluginIds": ["external"],
        "mapControlPositions": {},
        "settings": {"external": {"arbitrary": "python-plugin-secret"}},
    }

    safe = m.to_project()
    serialized = str(safe)
    html = m.to_html()
    out = tmp_path / "safe.geolibre.json"
    m.save_project(str(out))
    saved = out.read_text(encoding="utf-8")
    for secret in (
        "python-env-secret",
        "python-geocoder-secret",
        "python-endpoint-secret",
        "password",
        "python-url-secret",
        "python-subscription-secret",
        "python-header-secret",
        "python-path-secret",
        "python-plugin-secret",
        "python-basemap-secret",
        "python-manifest-secret",
        "ssword",
    ):
        assert secret not in serialized
        assert secret not in html
        assert secret not in saved

    assert m.to_project(keep_credentials=True)["plugins"]["settings"]


def test_redact_credentials_keeps_the_first_party_map_controls():
    """Wiping these stripped the legend/colorbar/swipe from every export."""
    safe = redact_credentials(
        {
            "plugins": {
                "settings": {
                    "maplibre-gl-components": {"legend": {"A": "#111"}},
                    "maplibre-gl-swipe": {"position": 50},
                    "some-third-party-plugin": {"apiKey": "third-party-secret"},
                }
            }
        }
    )
    settings = safe["plugins"]["settings"]
    assert settings["maplibre-gl-components"] == {"legend": {"A": "#111"}}
    assert settings["maplibre-gl-swipe"] == {"position": 50}
    # An unknown plugin's blob is free-form and can hold a key, so it still goes.
    assert "some-third-party-plugin" not in settings


def test_redact_credentials_drops_the_custom_html_panel():
    """The HTML panel is hand-authored, so it can carry a credentialed URL."""
    safe = redact_credentials(
        {
            "plugins": {
                "settings": {
                    "maplibre-gl-components": {
                        "legend": {"A": "#111"},
                        "html": {
                            "htmls": [{"html": '<img src="https://x/y?api_key=html-secret">'}]
                        },
                    }
                }
            }
        }
    )
    components = safe["plugins"]["settings"]["maplibre-gl-components"]
    assert components == {"legend": {"A": "#111"}}
    assert "html-secret" not in json.dumps(safe)


def test_redact_credentials_still_sweeps_a_kept_plugin_blob():
    """A kept blob gets the same scrub layer configuration gets, not a free pass."""
    safe = redact_credentials(
        {"plugins": {"settings": {"maplibre-gl-swipe": {"position": 50, "apiKey": "swipe-secret"}}}}
    )
    assert "swipe-secret" not in json.dumps(safe)
    assert safe["plugins"]["settings"]["maplibre-gl-swipe"]["position"] == 50


def test_to_html_keeps_the_composed_map_controls(m):
    """The documented compose-then-export flow must not lose what it composed."""
    m.add_legend(legend_dict={"A": "#112233"})
    assert "#112233" in m.to_html()


def test_python_credential_field_registry_matches_js():
    """Every object-key spelling the JS registry strips must be stripped here too."""
    safe = redact_credentials(
        {
            "layers": [
                {
                    "source": {
                        "sasToken": "py-sas-secret",
                        "bearer": "py-bearer-secret",
                        "auth": {"user": "u", "pass": "py-auth-secret"},
                        "subscription-key": "py-subscription-secret",
                        "api_key": "py-underscore-secret",
                        "pwd": "py-pwd-secret",
                        # Credentials only inside a query string; as field names
                        # they are ordinary configuration.
                        "sr": 4326,
                        "key": "layer-identifier",
                    }
                }
            ]
        }
    )
    serialized = str(safe)
    for secret in (
        "py-sas-secret",
        "py-bearer-secret",
        "py-auth-secret",
        "py-subscription-secret",
        "py-underscore-secret",
        "py-pwd-secret",
    ):
        assert secret not in serialized
    assert safe["layers"][0]["source"] == {"sr": 4326, "key": "layer-identifier"}


def test_python_redaction_sweeps_layer_connection():
    """`connection.lastError` is free-form error text and must be swept too."""
    safe = redact_credentials(
        {
            "layers": [
                {
                    "source": {"url": "https://example.com/tiles"},
                    "connection": {
                        "layerId": "auth",
                        "interval": 300,
                        "lastSyncedAt": "2026-01-01T00:00:00.000Z",
                        "lastError": "Failed to fetch https://example.com/tiles?token=py-connection-secret",
                        "onFailure": "keep-last",
                    },
                }
            ]
        }
    )
    connection = safe["layers"][0]["connection"]
    assert "py-connection-secret" not in str(safe)
    assert connection["lastError"] == "Failed to fetch https://example.com/tiles"
    assert connection["interval"] == 300


def test_python_redaction_fails_closed_at_depth_limit():
    nested = {"password": "too-deep-secret"}
    for _ in range(12):
        nested = {"child": nested}
    safe = redact_credentials({"layers": [{"source": nested}]})
    assert "too-deep-secret" not in str(safe)


def test_to_html_writes_path(m, tmp_path):
    out = tmp_path / "nested" / "map.html"
    assert m.to_html(str(out)) is None
    text = out.read_text(encoding="utf-8")
    assert "<iframe" in text


def test_to_html_app_url_query_separator(m):
    # An app_url that already carries a query string must keep parsing, so the
    # embed flag is appended with "&", not a second "?".
    html = m.to_html(app_url="https://example.com/app?foo=bar")
    assert "https://example.com/app?foo=bar&amp;embed=1" in html


def test_to_html_inserts_embed_before_fragment(m):
    # embed=1 must land in the query string, before any "#fragment", or the
    # browser folds it into the fragment and the iframe never sees the flag.
    html = m.to_html(app_url="https://example.com/app#section")
    assert "https://example.com/app?embed=1#section" in html


def test_to_html_posts_the_project_to_the_app_origin_only(m):
    # The project is posted into the frame, so a wildcard targetOrigin would
    # hand it to whatever the app URL redirected to.
    html = m.to_html(app_url="https://example.com/app?foo=bar")
    assert '"https://example.com"' in html
    assert '"*"' not in html


def test_to_html_rejects_a_non_http_app_url(m):
    for bad in ("javascript:alert(1)", "file:///etc/passwd", "not a url"):
        with pytest.raises(ValueError, match="must be an http\\(s\\) URL"):
            m.to_html(app_url=bad)


def test_to_html_rejects_css_injection_dimensions(m):
    with pytest.raises(ValueError, match="invalid CSS width"):
        m.to_html(width="100%; } body { background: red; }")


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


def test_layer_lookup_and_map_mutators(m):
    first_id = m.add_geojson({"type": "FeatureCollection", "features": []}, name="A")
    m.add_geojson({"type": "FeatureCollection", "features": []}, name="B")
    assert m.layer_names == ["A", "B"]
    assert m.find_layer("A").id == first_id
    assert m.find_layer("missing") is None
    assert m.find_layer_index("B") == 1
    assert m.find_layer_index("missing") == -1

    m.set_layer_visibility("A", visible=False)
    m.set_layer_opacity(first_id, 0.25)
    assert m.get_layer(first_id).visible is False
    assert m.get_layer(first_id).opacity == 0.25


def test_layer_opacity_validation(m):
    layer_id = m.add_geojson({"type": "FeatureCollection", "features": []})
    with pytest.raises(ValueError, match="between 0 and 1"):
        m.get_layer(layer_id).opacity = 2
    with pytest.raises(ValueError, match="between 0 and 1"):
        m.get_layer(layer_id).opacity = -0.1


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


def test_map_layer_management_and_introspection(m):
    first = m.add_geojson(
        {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "geometry": None, "properties": {"kind": "a", "value": 2}},
                {"type": "Feature", "geometry": None, "properties": {"kind": "b", "value": 3}},
            ],
        },
        name="First",
    )
    second = m.add_geojson({"type": "FeatureCollection", "features": []}, name="Second")

    m.rename_layer(first, "Renamed")
    m.hide_layer("Renamed")
    assert m.get_layer(first).name == "Renamed"
    assert m.get_layer(first).visible is False
    assert m.layer_properties(first)["kind"] == ["a", "b"]
    assert m.column_values(first, "value") == [2, 3]

    m.move_layer(second, 0)
    assert [layer.id for layer in m.layers] == [second, first]
    copy_id = m.duplicate_layer(first, name="Clone")
    assert m.get_layer(copy_id).name == "Clone"
    assert m.get_layer(copy_id).data["geojson"] == m.get_layer(first).data["geojson"]
    assert m.describe()["layerCount"] == 3

    m.remove_layer("Clone")
    assert m.find_layer("Clone") is None


def test_layer_handle_expanded_helpers(m):
    layer_id = m.add_geojson(
        {
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "geometry": None, "properties": {"x": 1}}],
        },
        name="Data",
    )
    layer = m.get_layer(layer_id)
    assert layer.index == 0
    assert layer.source == {"type": "geojson"}
    assert layer.properties() == {"x": [1]}
    assert layer.column("x") == [1]
    duplicate = layer.duplicate()
    assert duplicate.name == "Data copy"
    duplicate.move(0)
    assert duplicate.index == 0

    duplicate.remove()
    with pytest.raises(ValueError, match="no longer exists"):
        _ = duplicate.index


def test_layer_reference_matching_is_shared_with_authoring(m):
    first = m.add_geojson({"type": "FeatureCollection", "features": []}, name="Rivers")
    m.add_geojson({"type": "FeatureCollection", "features": []}, name="Roads")

    # Case-insensitive name matching, as `authoring.find_layer` defines it.
    m.set_layer_opacity("rivers", 0.25)
    assert m.get_layer(first).opacity == 0.25

    # A name several layers share is an error, not an arbitrary pick.
    m.add_geojson({"type": "FeatureCollection", "features": []}, name="Roads")
    with pytest.raises(ValueError, match="2 layers are named"):
        m.remove_layer("Roads")
    with pytest.raises(ValueError, match="No layer matches"):
        m.remove_layer("Nothing")


def test_duplicate_layer_rejects_the_reserved_basemap_name(m):
    layer_id = m.add_geojson({"type": "FeatureCollection", "features": []}, name="Data")
    with pytest.raises(ValueError, match="reserved for the basemap"):
        m.duplicate_layer(layer_id, name="__basemap__")
    with pytest.raises(ValueError, match="non-empty"):
        m.duplicate_layer(layer_id, name="  ")
    assert len(m.layers) == 1

    padded = m.duplicate_layer(layer_id, name="  Clone  ")
    assert m.get_layer(padded).name == "Clone"


def test_rename_layer_strips_and_rejects_a_blank_name(m):
    layer = m.get_layer(m.add_geojson({"type": "FeatureCollection", "features": []}, name="Data"))
    layer.name = "  Renamed  "
    assert layer.name == "Renamed"
    for blank in ("", "   "):
        with pytest.raises(ValueError, match="non-empty"):
            m.rename_layer(layer, blank)
    assert layer.name == "Renamed"


def test_layer_data_and_source_redact_credentials(m):
    layer_id = m.add_3d_tiles(
        "https://example.com/tileset.json?token=secret",
        name="Secured",
        request_headers={"Authorization": "Bearer hunter2"},
    )
    layer = m.get_layer(layer_id)

    # The stored record keeps the headers; the reads that hand one back do not.
    assert "requestHeaders" in m.project["layers"][0]["source"]
    assert "requestHeaders" not in layer.source
    assert "requestHeaders" not in layer.data["source"]
    assert "hunter2" not in json.dumps(layer.data)
    assert "secret" not in json.dumps(layer.data)


def test_basemap_property_redacts_an_embedded_key(m):
    m.project = {**m.project, "basemapStyleUrl": "https://api.example.com/style.json?key=secret"}
    assert m.basemap == "https://api.example.com/style.json"
    assert m.project["basemapStyleUrl"].endswith("key=secret")


def test_describe_redacts_credentials_like_its_sibling_accessors(m):
    m.project = {**m.project, "basemapStyleUrl": "https://api.example.com/style.json?key=secret"}
    m.add_tile_layer("https://api.example.com/{z}/{x}/{y}.png?key=secret", name="Tiles")

    summary = m.describe()
    assert summary["basemapStyleUrl"] == "https://api.example.com/style.json"
    assert "secret" not in json.dumps(summary)


def test_move_layer_negative_index_counts_from_the_end(m):
    ids = [
        m.add_geojson({"type": "FeatureCollection", "features": []}, name=name)
        for name in ("A", "B", "C")
    ]

    # -1 lands the layer last, unlike `list.insert(-1, ...)` which would leave
    # it second to last.
    m.move_layer(ids[0], -1)
    assert [layer.id for layer in m.layers] == [ids[1], ids[2], ids[0]]

    m.move_layer(ids[0], -2)
    assert [layer.id for layer in m.layers] == [ids[1], ids[0], ids[2]]

    # Out-of-range negatives clamp to the front rather than wrapping.
    m.move_layer(ids[2], -99)
    assert [layer.id for layer in m.layers] == [ids[2], ids[1], ids[0]]


def test_persisted_camera_and_project_metadata_helpers(m):
    m.name = "My analysis"
    m.set_center(-80, 35, zoom=4)
    m.set_zoom(6)
    m.set_bearing(370)
    m.set_pitch(100)
    assert m.name == "My analysis"
    assert m.center == (-80.0, 35.0)
    assert m.zoom == 6
    assert m.bearing == 370
    assert m.pitch == 85
    with pytest.raises(ValueError, match="non-empty"):
        m.name = "  "


def test_fit_project_bounds_is_browser_independent(m):
    m.fit_project_bounds([-10, -5, 10, 5])
    assert m.center == (0.0, 0.0)
    assert m.zoom > 0
    assert "bbox" in m.project["mapView"]

    # Recentering by hand leaves the fitted bbox describing a different extent.
    m.set_center(20, 10)
    assert "bbox" not in m.project["mapView"]


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


def test_zoom_aliases_send_commands(m, monkeypatch):
    calls = []
    monkeypatch.setattr(
        m,
        "request",
        lambda method, params=None, **_k: calls.append((method, params)),
    )
    layer_id = m.add_geojson({"type": "FeatureCollection", "features": []}, name="A")
    m.zoom_to_bounds([-10, -5, 10, 5])
    m.zoom_to_layer("A")
    assert calls == [
        ("fitBounds", {"bounds": [-10.0, -5.0, 10.0, 5.0]}),
        ("zoomToLayer", {"layerId": layer_id}),
    ]


def test_fit_bounds_validates_shape_and_order(m):
    with pytest.raises(ValueError, match="contain"):
        m.fit_bounds([0, 1])
    with pytest.raises(ValueError, match="west <= east"):
        m.fit_bounds([10, 0, -10, 1])
    with pytest.raises(ValueError, match="south <= north"):
        m.fit_bounds([-10, 5, 10, -5])
    with pytest.raises(ValueError, match="finite"):
        m.fit_bounds([-10, -5, float("nan"), 5])


def test_stale_layer_access_raises(m):
    layer_id = m.add_geojson({"type": "FeatureCollection", "features": []}, name="A")
    layer = m.get_layer(layer_id)
    m.remove_layer(layer_id)
    with pytest.raises(ValueError, match="no longer exists"):
        _ = layer.name
