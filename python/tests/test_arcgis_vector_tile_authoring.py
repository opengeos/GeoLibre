"""Styled ArcGIS VectorTileServer authoring across the project, Map and MCP APIs."""

import asyncio
import copy
import io
import json
from unittest import mock

import pytest

import geolibre.geolibre as gmod
from geolibre import Map
from geolibre import project as project_api

SERVICE = (
    "https://vectortileservices3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/"
    "Santa_Monica_parcels_VTL/VectorTileServer"
)


def _documents():
    """Build the service description and style the public service serves.

    Returns:
        The service JSON and its default style JSON, trimmed to two layers.
    """
    info = {
        "name": "Santa_Monica_parcels_VTL",
        "defaultStyles": "resources/styles",
        "tiles": ["tile/{z}/{y}/{x}.pbf"],
        "fullExtent": {
            "xmin": -13193261.092669973,
            "ymin": 4028181.640355066,
            "xmax": -13185072.883365816,
            "ymax": 4035576.6410953267,
            "spatialReference": {"wkid": 102100, "latestWkid": 3857},
        },
    }
    style = {
        "version": 8,
        "sprite": "../sprites/sprite",
        "glyphs": "../fonts/{fontstack}/{range}.pbf",
        "sources": {
            "Santa_Monica_parcels_VTL": {
                "type": "vector",
                "bounds": [-118.517, 33.9954, -118.444, 34.0504],
                "minzoom": 0,
                "maxzoom": 23,
                "scheme": "xyz",
                "url": "../../",
            }
        },
        "layers": [
            {
                "id": "Santa_Monica_ClientSide_Parcels/Residential",
                "type": "fill",
                "source": "Santa_Monica_parcels_VTL",
                "source-layer": "Santa_Monica_ClientSide_Parcels",
                "filter": ["==", "_symbol", 0],
                "minzoom": 11,
                "maxzoom": 18,
                "layout": {},
                "paint": {"fill-color": "rgba(255,222,62,0.7)"},
            },
            {
                "id": "Parcel labels",
                "type": "symbol",
                "source": "Santa_Monica_parcels_VTL",
                "source-layer": "Santa_Monica_ClientSide_Parcels",
                "layout": {"text-field": "{APN}", "text-font": ["Arial Regular"]},
                "paint": {},
            },
        ],
    }
    return info, style


@pytest.fixture
def vts(monkeypatch):
    """Serve a VectorTileServer's description and style without network access.

    Args:
        monkeypatch: Pytest fixture for replacing the public metadata transport.

    Returns:
        The mutable service JSON, style JSON and the list of requested URLs.
    """
    info, style = _documents()
    requested = []
    monkeypatch.setattr(project_api, "_assert_public_url", lambda _url: None)

    def open_metadata(url, timeout):
        """Return the document a URL names as a binary response.

        Args:
            url: The requested metadata URL.
            timeout: The request timeout passed by the reader.

        Returns:
            A binary response with the service or style JSON.
        """
        assert 0 < timeout <= 30
        requested.append(url)
        document = style if "/resources/" in url or "/custom/" in url else info
        return io.BytesIO(json.dumps(document).encode())

    monkeypatch.setattr(project_api._GEOJSON_OPENER, "open", open_metadata)
    return info, style, requested


def _build(url=SERVICE, **kwargs):
    """Build a layer whose id is fixed, as ``createArcGISLayerId`` would give.

    Args:
        url: The VectorTileServer URL.
        **kwargs: Options for the builder.

    Returns:
        The layer dict.
    """
    with mock.patch.object(project_api.uuid, "uuid4", lambda: "arcgis-layer-1"):
        return project_api.arcgis_vector_tile_layer(url, **kwargs)


def test_layer_matches_the_record_the_app_saves(vts):
    """Write the record ``addArcGISLayer`` stores for the same public service.

    The expected values were captured from the app's own plugin adding this
    service (``createArcGISStoreLayer`` plus the resolved SDK style).

    Args:
        vts: The metadata transport fixture.
    """
    _, _, requested = vts
    layer = _build()
    assert requested == [SERVICE + "?f=json", SERVICE + "/resources/styles/?f=json"]
    source_id = "arcgis-layer-1-source-0-Santa_Monica_parcels_VTL"
    bounds = [-118.517, 33.9954, -118.444, 34.0504]
    assert layer["name"] == "Santa Monica parcels VTL"
    assert layer["type"] == "arcgis"
    assert layer["sourcePath"] == SERVICE
    assert (layer["style"]["fillColor"], layer["style"]["fillOpacity"]) == ("#2563eb", 0.45)
    assert layer["style"]["strokeColor"] == "#1d4ed8"
    assert layer["metadata"] == {
        "arcgisLayerType": "vector-tile",
        "arcgisSourceType": "url",
        "bounds": bounds,
        "externalNativeLayer": True,
        "hasAccessToken": False,
        "nativeLayerIds": [
            "arcgis-layer-1-layer-0-Santa_Monica_ClientSide_Parcels-Residential",
            "arcgis-layer-1-layer-1-Parcel-labels",
        ],
        "sourceId": source_id,
        "sourceIds": [source_id],
        "sourceKind": "arcgis-vector-tile-url",
    }
    source = layer["source"]
    assert {key: value for key, value in source.items() if not key.startswith("arcgis")} == {
        "bounds": bounds,
        "layerType": "vector-tile",
        "sourceId": source_id,
        "sourceIds": [source_id],
        "type": "vector",
        "url": SERVICE,
    }
    assert source["arcgisSources"] == {
        source_id: {
            "type": "vector",
            "bounds": bounds,
            "minzoom": 0,
            "maxzoom": 23,
            "scheme": "xyz",
            "url": SERVICE + "/",
            "tiles": [SERVICE + "/tile/{z}/{y}/{x}.pbf"],
            "attribution": "",
        }
    }
    first, label = source["arcgisLayers"]
    assert first["source"] == label["source"] == source_id
    assert first["filter"] == ["==", "_symbol", 0]
    assert label["layout"]["text-font"] == ["Arial Regular"]


def test_service_extent_credit_and_custom_style_path(vts):
    """Fall back to the service extent and credit, and follow ``defaultStyles``.

    Args:
        vts: The mutable metadata transport fixture.
    """
    info, style, requested = vts
    info["defaultStyles"] = "custom/root"
    info["copyrightText"] = '<a href="x" onclick="y">City</a> of <b>Santa Monica'
    info["tiles"] = ["tiles/{z}/{y}/{x}.mvt"]
    del style["sources"]["Santa_Monica_parcels_VTL"]["bounds"]
    layer = _build()
    assert requested[-1] == SERVICE + "/custom/root/?f=json"
    west, south, east, north = layer["metadata"]["bounds"]
    assert west == pytest.approx(-118.517, abs=1e-3)
    assert north == pytest.approx(34.0504, abs=1e-3)
    assert layer["source"]["bounds"] == layer["metadata"]["bounds"]
    (spec,) = layer["source"]["arcgisSources"].values()
    # "../../" is resolved against the custom style URL, as the SDK does.
    assert spec["url"] == SERVICE + "/"
    assert spec["tiles"] == [SERVICE + "/tiles/{z}/{y}/{x}.mvt"]
    assert spec["attribution"] == "City of Santa Monica"


def test_overrides_and_missing_default_styles(vts):
    """Honor caller name, bounds and attribution; default the style path.

    Args:
        vts: The mutable metadata transport fixture.
    """
    info, _, requested = vts
    del info["defaultStyles"]
    layer = _build(name="Parcels", bounds=[-119, 33, -118, 35], attribution="Mine")
    assert requested[-1] == SERVICE + "/resources/styles/?f=json"
    assert layer["name"] == "Parcels"
    assert layer["metadata"]["bounds"] == [-119, 33, -118, 35]
    assert all(s["attribution"] == "Mine" for s in layer["source"]["arcgisSources"].values())


def test_background_layer_is_kept_without_a_source(vts):
    """Keep a style's sourceless background, which ``arcgisVectorStyle`` accepts.

    Args:
        vts: The mutable metadata transport fixture.
    """
    _, style, _ = vts
    style["layers"].insert(0, {"id": "bg", "type": "background", "paint": {}})
    layer = _build()
    assert layer["source"]["arcgisLayers"][0] == {
        "id": "arcgis-layer-1-layer-0-bg",
        "type": "background",
        "paint": {},
    }


@pytest.mark.parametrize(
    "url",
    [
        SERVICE + "?token=abc",
        "ftp://example.org/A/VectorTileServer",
        "https://example.org/A/MapServer",
        "https://user:pw@example.org/A/VectorTileServer",
    ],
)
def test_bad_urls_are_refused_before_any_request(vts, url):
    """Refuse tokens, credentials, other schemes and other service types.

    Args:
        vts: The metadata transport fixture.
        url: The invalid service URL.
    """
    with pytest.raises(ValueError):
        _build(url)
    assert vts[2] == []


def test_encoded_token_and_lowercase_service_name(vts):
    """Refuse a percent-encoded token; accept a lowercase service segment.

    Args:
        vts: The metadata transport fixture.
    """
    with pytest.raises(ValueError, match="token"):
        _build(SERVICE + "?%74oken=abc")
    layer = _build(SERVICE.replace("VectorTileServer", "vectortileserver"))
    assert layer["type"] == "arcgis"


def test_tile_hosts_must_be_public(vts, monkeypatch):
    """Keep a remote style from aiming saved tile URLs at a private host.

    Args:
        vts: The mutable metadata transport fixture.
        monkeypatch: Pytest fixture for the public-address guard.
    """
    _, style, _ = vts
    checked = []

    def guard(url):
        """Refuse loopback hosts the way the real guard would.

        Args:
            url: The URL being checked.

        Raises:
            ValueError: For a loopback host.
        """
        checked.append(url)
        if "127.0.0.1" in url:
            raise ValueError("non-public address")

    monkeypatch.setattr(project_api, "_assert_public_url", guard)
    _build()
    assert SERVICE + "/tile/0/0/0.pbf" in checked
    style["sources"]["Santa_Monica_parcels_VTL"]["tiles"] = ["http://127.0.0.1:8765/{z}/{y}/{x}"]
    with pytest.raises(ValueError, match="public"):
        _build()


def test_absolute_tile_template_and_malformed_wkid(vts):
    """Keep an absolute service tile template and ignore a non-numeric WKID.

    Args:
        vts: The mutable metadata transport fixture.
    """
    info, style, _ = vts
    info["tiles"] = ["https://tiles.example.org/vt/{z}/{y}/{x}.pbf"]
    info["fullExtent"]["spatialReference"] = {"latestWkid": [3857]}
    del style["sources"]["Santa_Monica_parcels_VTL"]["bounds"]
    layer = _build()
    (spec,) = layer["source"]["arcgisSources"].values()
    assert spec["tiles"] == ["https://tiles.example.org/vt/{z}/{y}/{x}.pbf"]
    assert "bounds" not in layer["metadata"]


@pytest.mark.parametrize("where", ["wkid", "paint"])
def test_non_json_numbers_are_refused(vts, where):
    """Refuse NaN/Infinity, which the project file could not store.

    Args:
        vts: The mutable metadata transport fixture.
        where: Which document carries the non-finite number.
    """
    info, style, _ = vts
    if where == "wkid":
        info["fullExtent"]["spatialReference"] = {"wkid": float("inf")}
    else:
        style["layers"][0]["paint"]["fill-opacity"] = float("nan")
    with pytest.raises(ValueError, match="not valid JSON"):
        _build()


def test_null_latest_wkid_falls_back_to_wkid(vts):
    """Read ``latestWkid ?? wkid`` like the app.

    Args:
        vts: The mutable metadata transport fixture.
    """
    info, style, _ = vts
    del style["sources"]["Santa_Monica_parcels_VTL"]["bounds"]
    info["fullExtent"]["spatialReference"] = {"latestWkid": None, "wkid": 102100}
    assert _build()["metadata"]["bounds"][0] == pytest.approx(-118.517, abs=1e-3)


def test_overflowing_float_is_refused(vts, monkeypatch):
    """Refuse a numeric literal that decodes to infinity.

    Args:
        vts: The metadata transport fixture.
        monkeypatch: Pytest fixture for the response body.
    """
    _, style, _ = vts
    body = json.dumps(style).replace('"fill-color"', '"fill-opacity": 1e400, "fill-color"', 1)
    real_open = project_api._GEOJSON_OPENER.open

    def open_metadata(url, timeout):
        """Serve the style with an overflowing number.

        Args:
            url: The requested URL.
            timeout: The request timeout.

        Returns:
            The binary response.
        """
        if "/resources/" in url:
            return io.BytesIO(body.encode())
        return real_open(url, timeout)

    monkeypatch.setattr(project_api._GEOJSON_OPENER, "open", open_metadata)
    with pytest.raises(ValueError, match="not valid JSON"):
        _build()


def test_empty_attribution_clears_the_credit(vts):
    """Treat an empty attribution as an explicit override.

    Args:
        vts: The mutable metadata transport fixture.
    """
    vts[0]["copyrightText"] = "Service credit"
    (spec,) = _build(attribution="")["source"]["arcgisSources"].values()
    assert spec["attribution"] == ""


def test_attribution_must_be_a_string(vts):
    """Refuse a non-string attribution before any request.

    Args:
        vts: The metadata transport fixture.
    """
    with pytest.raises(ValueError, match="attribution"):
        _build(attribution=5)
    assert vts[2] == []


def test_style_attribution_is_the_fallback_credit(vts):
    """Use the style source's attribution when the service has no credit.

    Args:
        vts: The mutable metadata transport fixture.
    """
    _, style, _ = vts
    style["sources"]["Santa_Monica_parcels_VTL"]["attribution"] = "Style credit"
    (spec,) = _build()["source"]["arcgisSources"].values()
    assert spec["attribution"] == "Style credit"


def test_query_strings_are_not_saved(vts):
    """Store the normalized service URL, never a caller's query string.

    Args:
        vts: The metadata transport fixture.
    """
    layer = _build(SERVICE + "/?apiKey=abc#frag")
    assert layer["source"]["url"] == SERVICE
    assert layer["sourcePath"] == SERVICE


@pytest.mark.parametrize("ymax", [4.5e9, 1e300])
def test_out_of_range_service_extent_has_no_bounds(vts, ymax):
    """Treat an extent outside the Web Mercator square as unknown.

    Args:
        vts: The mutable metadata transport fixture.
        ymax: An absurd northern edge.
    """
    info, style, _ = vts
    del style["sources"]["Santa_Monica_parcels_VTL"]["bounds"]
    info["fullExtent"]["ymax"] = ymax
    layer = _build()
    assert "bounds" not in layer["metadata"]
    assert "bounds" not in layer["source"]


def test_private_hosts_are_refused():
    """Keep the kernel-side SSRF guard on the metadata reads."""
    with pytest.raises(ValueError):
        project_api.arcgis_vector_tile_layer("http://127.0.0.1/A/VectorTileServer")


def _damage(info, style, damage):
    """Break one part of the service documents.

    Args:
        info: The service JSON.
        style: The style JSON.
        damage: Which part to break.
    """
    source = style["sources"]["Santa_Monica_parcels_VTL"]
    layer = style["layers"][0]
    if damage == "raster_source":
        source["type"] = "raster"
    elif damage == "raster_layer":
        layer["type"] = "raster"
    elif damage == "unknown_source":
        layer["source"] = "elsewhere"
    elif damage == "no_source_layer":
        del layer["source-layer"]
    elif damage == "no_tiles":
        del source["url"]
    elif damage == "template":
        info["tiles"] = ["tile/{z}/{x}.pbf"]
    elif damage == "absolute_styles":
        info["defaultStyles"] = "https://evil.example/styles"
    elif damage == "error":
        info.clear()
        info["error"] = {"code": 499, "message": "Token Required"}
    elif damage == "no_layers":
        style["layers"] = []
    elif damage == "too_many_layers":
        style["layers"] = [copy.deepcopy(layer) for _ in range(5001)]
    elif damage == "tokened_tiles":
        source["tiles"] = ["https://example.org/t/{z}/{y}/{x}.pbf?token=abc"]
    elif damage == "not_object":
        style.clear()
    elif damage == "list_type":
        layer["type"] = ["fill"]
    elif damage == "list_source":
        layer["source"] = ["Santa_Monica_parcels_VTL"]
    elif damage == "userinfo_tiles":
        source["tiles"] = ["https://user:pw@example.org/t/{z}/{y}/{x}.pbf"]
    elif damage == "encoded_token_tiles":
        source["tiles"] = ["https://example.org/t/{z}/{y}/{x}.pbf?%74oken=abc"]


@pytest.mark.parametrize(
    "damage",
    [
        "raster_source",
        "raster_layer",
        "unknown_source",
        "no_source_layer",
        "no_tiles",
        "template",
        "absolute_styles",
        "error",
        "no_layers",
        "too_many_layers",
        "tokened_tiles",
        "not_object",
        "list_type",
        "list_source",
        "userinfo_tiles",
        "encoded_token_tiles",
    ],
)
def test_styles_the_app_cannot_draw_never_reach_the_map(vts, monkeypatch, damage):
    """Refuse a style ``arcgisVectorStyle`` would reject, leaving the map unchanged.

    Args:
        vts: The mutable metadata transport fixture.
        monkeypatch: Pytest fixture for preventing the widget server startup.
        damage: The part of the documents to break.
    """
    info, style, _ = vts
    _damage(info, style, damage)
    monkeypatch.setattr(gmod, "serve_app", lambda *_args, **_kwargs: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    view = Map()
    before = copy.deepcopy(view.project)
    with pytest.raises(ValueError):
        view.add_arcgis_vector_tile_layer(SERVICE)
    assert view.project == before


def test_style_size_is_bounded(vts, monkeypatch):
    """Stop reading a style larger than its size limit.

    Args:
        vts: The metadata transport fixture.
        monkeypatch: Pytest fixture for lowering the limit.
    """
    monkeypatch.setattr(project_api, "_ARCGIS_STYLE_LIMIT", 64)
    with pytest.raises(ValueError, match="size limit"):
        _build()


def test_invalid_json_uses_the_documented_error(vts, monkeypatch):
    """Report a non-JSON response as a ValueError naming the document.

    Args:
        vts: The metadata transport fixture.
        monkeypatch: Pytest fixture for replacing the response body.
    """
    monkeypatch.setattr(
        project_api._GEOJSON_OPENER, "open", lambda *_a, **_k: io.BytesIO(b"<html>")
    )
    with pytest.raises(ValueError, match="service metadata is not valid JSON"):
        _build()


def test_map_method_adds_the_layer(vts, monkeypatch):
    """Add the styled layer through the widget API.

    Args:
        vts: The metadata transport fixture.
        monkeypatch: Pytest fixture for preventing the widget server startup.
    """
    monkeypatch.setattr(gmod, "serve_app", lambda *_args, **_kwargs: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    view = Map()
    layer_id = view.add_arcgis_vector_tile_layer(SERVICE)
    (layer,) = [item for item in view.project["layers"] if item["id"] == layer_id]
    assert layer["type"] == "arcgis"
    assert all(spec.startswith(layer_id) for spec in layer["metadata"]["nativeLayerIds"])


def test_mcp_tool_writes_the_layer_and_preserves_the_file_on_refusal(vts, tmp_path):
    """Publish only a drawable style and keep the file intact on a refusal.

    Args:
        vts: The mutable metadata transport fixture.
        tmp_path: Temporary workspace root for the MCP tools.
    """
    pytest.importorskip("mcp", reason="the mcp SDK is an optional extra")
    from mcp.server.mcpserver.exceptions import ToolError

    from geolibre.mcp.server import build_server
    from geolibre.mcp.workspace import Workspace

    server = build_server(Workspace([tmp_path]))
    path = str(tmp_path / "vts.geolibre.json")
    asyncio.run(server.call_tool("create_project", {"path": path, "name": "VTS"}))
    kwargs = {"path": path, "url": SERVICE}
    asyncio.run(server.call_tool("add_arcgis_vector_tile_layer", kwargs))
    saved = (tmp_path / "vts.geolibre.json").read_bytes()
    (layer,) = json.loads(saved)["layers"]
    assert layer["type"] == "arcgis"
    assert layer["metadata"]["sourceKind"] == "arcgis-vector-tile-url"
    vts[1]["layers"][0]["type"] = "raster"
    with pytest.raises(ToolError):
        asyncio.run(server.call_tool("add_arcgis_vector_tile_layer", kwargs))
    assert (tmp_path / "vts.geolibre.json").read_bytes() == saved
