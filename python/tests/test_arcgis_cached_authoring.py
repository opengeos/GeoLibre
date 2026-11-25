"""Cached ArcGIS service authoring across the project, Map and MCP APIs."""

import asyncio
import copy
import io
import json

import pytest

import geolibre.geolibre as gmod
from geolibre import Map
from geolibre import project as project_api

_PUBLIC_URL_GUARD = project_api._assert_public_url


@pytest.fixture
def cache_metadata(monkeypatch):
    """Serve a standard 512-pixel Web Mercator cache without network access.

    Args:
        monkeypatch: Pytest fixture for replacing the public metadata transport.

    Returns:
        The mutable service document and the list of requested metadata URLs.
    """
    info = {
        "singleFusedMapCache": True,
        "copyrightText": "Public imagery provider",
        "tileInfo": {
            "rows": 512,
            "cols": 512,
            "format": "JPEG",
            "spatialReference": {"wkid": 102100, "latestWkid": 3857},
            "origin": {"x": -20037508.342787, "y": 20037508.342787},
            "lods": [
                {"level": level, "resolution": 78271.51696400007 / 2**level} for level in [9, 10]
            ],
        },
    }
    requested = []
    monkeypatch.setattr(project_api, "_assert_public_url", lambda _url: None)

    def open_metadata(url, timeout):
        """Return the current service document as a bounded binary response.

        Args:
            url: The requested metadata URL.
            timeout: The request timeout passed by the builder.

        Returns:
            A binary response containing the current service JSON.
        """
        assert 0 < timeout <= 30
        requested.append(url)
        return io.BytesIO(json.dumps(info).encode())

    monkeypatch.setattr(project_api._GEOJSON_OPENER, "open", open_metadata)
    return info, requested


@pytest.mark.parametrize("service,endpoint", [("map", "MapServer"), ("image", "ImageServer")])
def test_cached_service_uses_the_validated_grid(cache_metadata, service, endpoint):
    """Preserve the real cache grid, row/column order and provider attribution.

    Args:
        cache_metadata: The metadata transport fixture.
        service: The image-producing service kind.
        endpoint: The matching ArcGIS REST endpoint.
    """
    _, requested = cache_metadata
    url = f"https://example.org/rest/services/Imagery/{endpoint}"
    layer = project_api.arcgis_layer("Imagery", url, service=service, tiled=True)
    assert requested == [url + "?f=json"]
    assert layer["source"]["tiles"] == [url + "/tile/{z}/{y}/{x}"]
    assert layer["source"]["tileSize"] == 512
    assert (layer["source"]["minzoom"], layer["source"]["maxzoom"]) == (9, 10)
    assert layer["source"]["attribution"] == "Public imagery provider"
    assert layer["metadata"]["arcgisTiled"] is True
    assert layer["metadata"]["hasAccessToken"] is False
    assert "tiled" not in layer["style"]


@pytest.mark.parametrize(
    "damage",
    ["projection", "origin", "size", "resolution", "gap", "lerc", "not_fused"],
)
def test_incompatible_cache_is_rejected_before_map_mutation(cache_metadata, monkeypatch, damage):
    """Refuse cache layouts that an XYZ raster source cannot draw correctly.

    Args:
        cache_metadata: The mutable service metadata fixture.
        monkeypatch: Pytest fixture for preventing the widget server startup.
        damage: The incompatible part of the cache description.
    """
    info, _ = cache_metadata
    if damage == "projection":
        info["tileInfo"]["spatialReference"] = {"wkid": 4326}
    elif damage == "origin":
        info["tileInfo"]["origin"]["y"] -= 1000
    elif damage == "size":
        info["tileInfo"]["rows"] = 256
    elif damage == "resolution":
        info["tileInfo"]["lods"][0]["resolution"] *= 2
    elif damage == "gap":
        info["tileInfo"]["lods"].append({"level": 12, "resolution": 78271.51696400007 / 2**12})
    elif damage == "lerc":
        info["tileInfo"]["format"] = "LERC"
    else:
        info["singleFusedMapCache"] = False
    monkeypatch.setattr(gmod, "serve_app", lambda *_args, **_kwargs: "http://127.0.0.1:0/")
    monkeypatch.setattr(gmod, "app_port", lambda: 0)
    view = Map()
    before = copy.deepcopy(view.project)
    with pytest.raises(ValueError, match="cache|Cache"):
        view.add_arcgis_layer("https://example.org/rest/services/A/MapServer", tiled=True)
    assert view.project == before


def test_mcp_cached_service_preserves_project_on_refusal(cache_metadata, tmp_path):
    """Publish only a validated cache and preserve the file on later refusal.

    Args:
        cache_metadata: The service metadata transport fixture.
        tmp_path: Temporary workspace root for the actual MCP tools.
    """
    from mcp.server.mcpserver.exceptions import ToolError

    from geolibre.mcp.server import build_server
    from geolibre.mcp.workspace import Workspace

    server = build_server(Workspace([tmp_path]))
    path = str(tmp_path / "cached.geolibre.json")
    asyncio.run(server.call_tool("create_project", {"path": path, "name": "Cached"}))
    kwargs = {
        "path": path,
        "name": "Imagery",
        "url": "https://example.org/rest/services/A/MapServer",
        "tiled": True,
    }
    asyncio.run(server.call_tool("add_arcgis_layer", kwargs))
    saved = (tmp_path / "cached.geolibre.json").read_bytes()
    assert json.loads(saved)["layers"][0]["source"]["tiles"][0].endswith("/tile/{z}/{y}/{x}")
    cache_metadata[0]["singleFusedMapCache"] = False
    with pytest.raises(ToolError, match="cache|Cache"):
        asyncio.run(server.call_tool("add_arcgis_layer", kwargs))
    assert (tmp_path / "cached.geolibre.json").read_bytes() == saved


@pytest.mark.parametrize(
    "options",
    [
        {"tiled": "yes"},
        {"tiled": True, "service": "feature"},
        {"tiled": True, "sublayers": "0"},
        {"tiled": True, "service": "image", "rendering_rule": {}},
    ],
)
def test_cache_options_are_refused_before_fetch(cache_metadata, options):
    """Refuse dynamic-only options without fetching or silently ignoring them.

    Args:
        cache_metadata: The fixture recording service metadata requests.
        options: An incompatible authoring configuration.
    """
    with pytest.raises(ValueError, match="tiled"):
        project_api.arcgis_layer("Invalid", "https://example.org/A/MapServer", **options)
    assert cache_metadata[1] == []


def test_cached_service_uses_the_public_url_guard(cache_metadata, monkeypatch):
    """Reject private metadata targets before the opener sees them.

    Args:
        cache_metadata: The fixture recording service metadata requests.
        monkeypatch: Pytest fixture for restoring the real public URL check.
    """
    # Restore the real guard replaced by the metadata fixture.
    monkeypatch.setattr(project_api, "_assert_public_url", _PUBLIC_URL_GUARD)
    with pytest.raises(ValueError, match="non-public"):
        project_api.arcgis_layer("Private", "http://127.0.0.1/A/MapServer", tiled=True)
    assert cache_metadata[1] == []


@pytest.mark.parametrize("body", [b"x" * (2 * 1024 * 1024 + 1), b"not JSON", b'{"error":{}}'])
def test_bad_metadata_never_creates_a_project_layer(cache_metadata, monkeypatch, body):
    """Bound metadata reads and refuse error or malformed service responses.

    Args:
        cache_metadata: The fixture disabling actual network access.
        monkeypatch: Pytest fixture for replacing the response body.
        body: An oversized or invalid service response.
    """
    monkeypatch.setattr(
        project_api._GEOJSON_OPENER, "open", lambda *_args, **_kwargs: io.BytesIO(body)
    )
    with pytest.raises(ValueError):
        project_api.arcgis_layer("Invalid", "https://example.org/A/MapServer", tiled=True)
