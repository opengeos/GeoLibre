"""Builders for GeoLibre project (`.geolibre.json`) dicts and their layers.

The shapes here mirror the TypeScript interfaces in
``packages/core/src/types.ts`` and ``packages/core/src/project.ts``. Keeping the
Python builders faithful to those interfaces is what lets the embedded app load
a project produced entirely from Python.
"""

from __future__ import annotations

import copy
import ipaddress
import json
import socket
import uuid
import warnings
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

from .basemaps import DEFAULT_BASEMAP

PROJECT_VERSION = "0.1.0"

# Characters JavaScript's encodeURIComponent leaves unescaped on top of the
# always-unreserved set (alphanumerics and ``-_.~``), so _append_query produces
# byte-identical query strings to the app's appendQuery helper.
_ENCODE_URI_SAFE = "!*'()"

# Cap GeoJSON inputs (URL fetches and local files alike) so a huge source cannot
# silently exhaust kernel memory when inlined into the project.
_MAX_GEOJSON_BYTES = 50 * 1024 * 1024  # 50 MB


def _assert_public_url(url: str) -> None:
    """Reject a URL whose host resolves to a non-public address.

    Guards the kernel-side fetch against SSRF: without this a redirect (or a
    crafted URL) could reach a private/loopback/link-local address such as a
    cloud metadata endpoint (``169.254.169.254``) and inline the response into
    the project. Every address the host resolves to must be globally routable.

    Args:
        url: The URL about to be fetched (or a redirect target).

    Raises:
        ValueError: If the host is missing, unresolvable, or maps to any
            non-public address.
    """
    host = urlsplit(url).hostname
    if not host:
        raise ValueError(f"URL has no host: {url}")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve host for URL: {url}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError(f"Refusing to fetch from a non-public address ({ip}): {url}")


class _PublicOnlyRedirectHandler(HTTPRedirectHandler):
    """Redirect handler that re-validates every hop against ``_assert_public_url``."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        _assert_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# Opener used for all remote GeoJSON fetches: follows redirects but rejects any
# hop that points at a non-public address (SSRF defence).
_GEOJSON_OPENER = build_opener(_PublicOnlyRedirectHandler)

# Mirror of DEFAULT_LAYER_STYLE in packages/core/src/types.ts. The app fills in
# any missing fields on load, so layers only need to override what differs, but
# carrying the full default keeps round-tripped projects stable.
DEFAULT_LAYER_STYLE: dict[str, Any] = {
    "minZoom": 0,
    "maxZoom": 24,
    "fillColor": "#3b82f6",
    "strokeColor": "#1e40af",
    "strokeWidth": 2,
    "fillOpacity": 0.6,
    "circleRadius": 6,
    "textColor": "#111827",
    "textHaloColor": "#ffffff",
    "textHaloWidth": 2,
    "textSize": 16,
    "extrusionEnabled": False,
    "extrusionColor": "#3b82f6",
    "extrusionOpacity": 0.8,
    "extrusionHeightProperty": "height",
    "extrusionHeightScale": 1,
    "extrusionBase": 0,
    "extrusionAdvancedStyleEnabled": False,
    "extrusionColorExpression": "",
    "extrusionHeightExpression": "",
    "vectorStyleMode": "single",
    "vectorStyleProperty": "",
    "vectorStyleClassCount": 5,
    "vectorStyleColorRamp": "viridis",
    "vectorStyleClassificationScheme": "equal-interval",
    "vectorStyleStops": [
        {"value": 0, "color": "#dbeafe"},
        {"value": 1, "color": "#2563eb"},
    ],
    "vectorStyleExpression": "",
    "pointRenderer": "single",
    "heatmapRadius": 30,
    "heatmapIntensity": 1,
    "clusterRadius": 50,
    "clusterMaxZoom": 14,
    "rasterBrightnessMin": 0,
    "rasterBrightnessMax": 1,
    "rasterSaturation": 0,
    "rasterContrast": 0,
    "rasterHueRotate": 0,
}

# Mirror of DEFAULT_PROJECT_PREFERENCES in packages/core/src/types.ts.
DEFAULT_PROJECT_PREFERENCES: dict[str, Any] = {
    "map": {
        "restrictBounds": False,
        "bounds": [-180, -85, 180, 85],
        "minZoom": 0,
        "maxZoom": 24,
        "maxPitch": 85,
        "renderWorldCopies": True,
    },
    "environmentVariables": [],
}


def default_map_view() -> dict[str, Any]:
    """Return the app's default camera (createDefaultMapView in project.ts)."""
    return {"center": [-100, 40], "zoom": 2, "bearing": 0, "pitch": 0}


def build_empty_project(
    name: str = "Untitled Project",
    *,
    center: list[float] | tuple[float, float] | None = None,
    zoom: float | None = None,
    basemap_url: str | None = None,
) -> dict[str, Any]:
    """Build an empty GeoLibre project dict.

    Args:
        name: Project display name.
        center: Optional ``[lng, lat]`` map center.
        zoom: Optional initial zoom level.
        basemap_url: Optional MapLibre style URL; defaults to the app default.

    Returns:
        A project dict ready to be assigned to the widget's ``project`` trait.
    """
    map_view = default_map_view()
    if center is not None:
        if len(center) != 2:
            raise ValueError("center must be a [lng, lat] sequence with exactly 2 elements")
        map_view["center"] = [float(center[0]), float(center[1])]
    if zoom is not None:
        map_view["zoom"] = float(zoom)
    return {
        "version": PROJECT_VERSION,
        "name": name,
        "mapView": map_view,
        "basemapStyleUrl": basemap_url or DEFAULT_BASEMAP,
        "basemapVisible": True,
        "basemapOpacity": 1,
        "layers": [],
        "styles": {},
        "preferences": copy.deepcopy(DEFAULT_PROJECT_PREFERENCES),
        "metadata": {},
    }


def _layer_base(name: str, layer_type: str, **style: Any) -> dict[str, Any]:
    # Deep-copy the defaults so nested values (e.g. the vectorStyleStops list)
    # are not shared with the module constant; a caller mutating a returned
    # layer's style must not corrupt DEFAULT_LAYER_STYLE for later layers.
    merged_style = {**copy.deepcopy(DEFAULT_LAYER_STYLE), **style}
    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "type": layer_type,
        "visible": True,
        "opacity": 1,
        "style": merged_style,
        "metadata": {},
    }


def geojson_layer(
    name: str,
    data: dict[str, Any],
    *,
    source_url: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a GeoJSON layer with an inlined FeatureCollection.

    Args:
        name: Layer display name.
        data: A GeoJSON FeatureCollection dict.
        source_url: Optional URL the data originated from (recorded on the
            source for restore/refresh).
        **style: Style overrides merged into the default layer style
            (e.g. ``fillColor="#ff0000"``).

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "geojson", **style)
    source: dict[str, Any] = {"type": "geojson"}
    if source_url:
        source["url"] = source_url
        layer["sourcePath"] = source_url
    layer["source"] = source
    layer["geojson"] = data
    return layer


def tile_layer(
    name: str,
    url: str,
    *,
    tile_size: int = 256,
    attribution: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a raster XYZ tile layer (e.g. an ``{z}/{x}/{y}`` template).

    Args:
        name: Layer display name.
        url: The XYZ tile URL template.
        tile_size: Tile size in pixels (typically 256).
        attribution: Optional attribution string.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "xyz", **style)
    source: dict[str, Any] = {
        "type": "raster",
        "tiles": [url],
        "tileSize": tile_size,
        "url": url,
    }
    if attribution:
        source["attribution"] = attribution
    layer["source"] = source
    layer["metadata"] = {"sourceKind": "xyz-url"}
    return layer


def cog_layer(
    name: str,
    url: str,
    *,
    bands: list[int] | None = None,
    colormap: str | None = None,
    rescale: list[list[float]] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a Cloud Optimized GeoTIFF (COG) layer.

    The shape matches what ``restoreRasterLayers`` replays from a saved project
    (see packages/plugins/src/plugins/raster-layer-sync.ts), so the app rebuilds
    the deck.gl raster overlay on load.

    Args:
        name: Layer display name.
        url: URL of the COG / GeoTIFF.
        bands: Optional 1-based band indices to render (e.g. ``[1, 2, 3]``).
        colormap: Optional colormap name for single-band rendering.
        rescale: Optional list of ``[min, max]`` ranges, one per rendered band.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "cog", **style)
    raster_state: dict[str, Any] = {}
    if rescale is not None:
        raster_state["rescale"] = rescale
    if bands is not None:
        raster_state["bands"] = bands
        raster_state["mode"] = "rgb" if len(bands) >= 3 else "single"
    if colormap is not None:
        raster_state["colormap"] = colormap
    layer["source"] = {"type": "raster", "url": url}
    layer["metadata"] = {
        "customLayerType": "raster",
        "externalDeckLayer": True,
        "externalNativeLayer": True,
        "identifiable": False,
        "nativeLayerIds": [layer["id"]],
        "panelCollapsed": True,
        "rasterOverlayMode": "interleaved",
        "rasterSource": "url",
        "rasterState": raster_state,
        "sourceIds": [],
        "sourceKind": "maplibre-gl-raster",
    }
    layer["sourcePath"] = url
    return layer


def _append_query(endpoint: str, params: list[tuple[str, str]]) -> str:
    """Append query params to a URL, mirroring ``appendQuery`` in the app.

    Matches ``AddDataDialog.tsx``/``layer-refresh.ts``: an existing ``?`` or
    ``&`` is respected, values are URL-encoded the way ``encodeURIComponent``
    does (so ``!*'()`` and the unreserved ``-_.~`` stay literal), and the
    ``{bbox-epsg-3857}`` placeholder is preserved verbatim so the raster source
    can substitute the tile bounding box at request time.

    Args:
        endpoint: Base service URL (may already carry a query string).
        params: Ordered ``(key, value)`` pairs to append.

    Returns:
        The endpoint with the encoded query string appended.
    """
    # Split off any fragment first: a query string must precede the "#", so
    # appending after it would push the params past the fragment where the
    # server never sees them. (Service endpoints rarely carry one, but this is
    # cheap to handle correctly.)
    base, sep, fragment = endpoint.partition("#")
    if "?" in base:
        separator = "" if base.endswith(("?", "&")) else "&"
    else:
        separator = "?"
    query = "&".join(
        f"{quote(key, safe=_ENCODE_URI_SAFE)}="
        + (value if value == "{bbox-epsg-3857}" else quote(value, safe=_ENCODE_URI_SAFE))
        for key, value in params
    )
    return f"{base}{separator}{query}{sep}{fragment}"


def _normalize_wms_version(version: str | None) -> str:
    """Normalize a WMS version to the "1.1.1"/"1.3.0" pair the builder emits.

    Args:
        version: The requested WMS protocol version, or None.

    Returns:
        ``"1.3.0"`` for any version in the 1.3 line, ``"1.1.1"`` otherwise
        (including None or a non-string value).
    """
    if not isinstance(version, str):
        return "1.1.1"
    return "1.3.0" if version.strip().startswith("1.3") else "1.1.1"


def wms_layer(
    name: str,
    endpoint: str,
    layers: str,
    *,
    styles: str = "",
    image_format: str = "image/png",
    transparent: bool = True,
    tile_size: int = 256,
    version: str | None = "1.1.1",
    **style: Any,
) -> dict[str, Any]:
    """Build a WMS layer rendered as tiled raster (a WMS GetMap request).

    The GetMap tile template is built exactly as ``createWmsTileUrl`` in the Add
    Data dialog, so the core raster sync renders it identically to a layer added
    through the UI. The ``{bbox-epsg-3857}`` placeholder is substituted per tile.

    Args:
        name: Layer display name.
        endpoint: WMS service endpoint (the GetMap base URL).
        layers: Comma-separated WMS layer name(s).
        styles: Comma-separated WMS style name(s) (empty for the default).
        image_format: WMS image format (e.g. ``"image/png"``).
        transparent: Whether to request transparent tiles.
        tile_size: Tile size in pixels.
        version: WMS protocol version, ``"1.1.1"`` (default) or ``"1.3.0"``.
            Version 1.3.0 sends ``CRS`` instead of ``SRS``; some servers accept
            only one version. EPSG:3857 keeps its axis order in both, so the
            BBOX template is unchanged. None falls back to ``"1.1.1"``.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    wms_version = _normalize_wms_version(version)
    tile_url = _append_query(
        endpoint,
        [
            ("SERVICE", "WMS"),
            ("REQUEST", "GetMap"),
            ("VERSION", wms_version),
            ("LAYERS", layers),
            ("STYLES", styles),
            ("FORMAT", image_format),
            ("TRANSPARENT", "TRUE" if transparent else "FALSE"),
            ("CRS" if wms_version == "1.3.0" else "SRS", "EPSG:3857"),
            ("BBOX", "{bbox-epsg-3857}"),
            ("WIDTH", str(tile_size)),
            ("HEIGHT", str(tile_size)),
        ],
    )
    layer = _layer_base(name, "wms", **style)
    layer["source"] = {
        "type": "raster",
        "tiles": [tile_url],
        "tileSize": tile_size,
        "url": endpoint,
        "layers": layers,
        "styles": styles,
        "format": image_format,
        "transparent": transparent,
        "version": wms_version,
    }
    layer["metadata"] = {"service": "wms"}
    return layer


def wmts_layer(
    name: str,
    url: str,
    *,
    tile_size: int = 256,
    **style: Any,
) -> dict[str, Any]:
    """Build a WMTS layer from a tile URL template.

    Args:
        name: Layer display name.
        url: A WMTS tile URL template in WMTS REST ``{z}/{y}/{x}`` order (row
            before column — unlike XYZ templates in ``tile_layer``/``add_tile_layer``,
            which use ``{z}/{x}/{y}``).
        tile_size: Tile size in pixels.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "wmts", **style)
    layer["source"] = {
        "type": "raster",
        "tiles": [url],
        "tileSize": tile_size,
        "url": url,
    }
    layer["metadata"] = {"service": "wmts"}
    return layer


def wfs_getfeature_url(
    endpoint: str,
    type_name: str,
    *,
    version: str = "2.0.0",
    output_format: str = "application/json",
    srs_name: str = "EPSG:4326",
    max_features: int | None = None,
) -> str:
    """Build a WFS GetFeature URL, mirroring ``createWfsGetFeatureUrl``.

    WFS 2.x uses ``typeNames``/``count`` while WFS 1.x uses
    ``typeName``/``maxFeatures``. The endpoint is expected to return GeoJSON when
    ``output_format`` is ``application/json`` so the result can be inlined as a
    GeoJSON layer.

    Args:
        endpoint: WFS service endpoint.
        type_name: WFS feature type name (e.g. ``"topp:states"``).
        version: WFS protocol version (e.g. ``"2.0.0"`` or ``"1.1.0"``).
        output_format: Requested output format.
        srs_name: Spatial reference of the response.
        max_features: Optional cap on the number of returned features.

    Returns:
        The fully-formed GetFeature request URL.
    """
    is_wfs2 = version.startswith("2")
    params: list[tuple[str, str]] = [
        ("service", "WFS"),
        ("request", "GetFeature"),
        ("version", version),
        ("typeNames" if is_wfs2 else "typeName", type_name),
        ("outputFormat", output_format),
    ]
    if srs_name:
        params.append(("srsName", srs_name))
    if max_features is not None:
        params.append(("count" if is_wfs2 else "maxFeatures", str(max_features)))
    return _append_query(endpoint, params)


def vector_layer(
    name: str,
    url: str,
    *,
    render_mode: str = "geojson",
    data_format: str | None = None,
    source_layer: str | None = None,
    picker: bool | None = None,
    ingest_mode: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a vector layer backed by the maplibre-gl-vector control.

    Covers any GDAL-readable vector served from a URL (GeoParquet, FlatGeobuf,
    zipped Shapefile, GeoJSON, ...). The shape matches what ``restoreVectorLayers``
    replays from a saved project: it reads ``source.url`` and the persisted
    ``metadata.vectorState`` and re-runs ``VectorControl.addData`` on load, so the
    in-browser DuckDB-backed control fetches and renders the data.

    Args:
        name: Layer display name.
        url: URL of the vector dataset.
        render_mode: ``"geojson"`` (load into a GeoJSON source) or ``"tiles"``
            (stream as vector tiles).
        data_format: Optional GDAL format hint (e.g. ``"parquet"``,
            ``"flatgeobuf"``); the control auto-detects when omitted.
        source_layer: Optional source/container layer name for multi-layer files.
        picker: Optional toggle for the control's feature-inspection popup.
        ingest_mode: Optional ingest strategy, ``"table"`` or ``"stream"``.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``render_mode`` or ``ingest_mode`` is not a valid value.
    """
    if render_mode not in ("geojson", "tiles"):
        raise ValueError("render_mode must be 'geojson' or 'tiles'")
    if ingest_mode is not None and ingest_mode not in ("table", "stream"):
        raise ValueError("ingest_mode must be 'table' or 'stream'")
    is_tiles = render_mode == "tiles"
    layer = _layer_base(name, "vector-tiles" if is_tiles else "geojson", **style)
    layer["source"] = {"type": "vector" if is_tiles else "geojson", "url": url}
    vector_state: dict[str, Any] = {"renderMode": render_mode}
    if data_format:
        vector_state["format"] = data_format
    if source_layer:
        vector_state["sourceLayer"] = source_layer
    if picker is not None:
        vector_state["picker"] = picker
    if ingest_mode is not None:
        vector_state["ingestMode"] = ingest_mode
    layer["metadata"] = {
        "sourceKind": "maplibre-gl-vector",
        "externalNativeLayer": True,
        # The control owns its layers' paint; the core sync must not re-apply it.
        "controlOwnsPaint": True,
        "identifiable": False,
        # Empty is safe here (unlike pmtiles_layer): restoreVectorLayers detects
        # the layer via isVectorControlStoreLayer (sourceKind + externalNativeLayer,
        # not list length) and loads it through the control's async addData;
        # syncVectorLayersToStore then fills in the real nativeLayerIds.
        # Caveat: render_mode="tiles" yields a type:"vector-tiles" layer that,
        # before the control loads, briefly falls through to syncVectorTileLayer
        # until that store sync replaces these ids.
        "nativeLayerIds": [],
        "sourceIds": [f"{layer['id']}-source"],
        "vectorSource": "url",
        "vectorState": vector_state,
    }
    layer["sourcePath"] = url
    return layer


def vector_tiles_layer(
    name: str,
    url: str,
    *,
    source_layers: list[str] | None = None,
    source_layer: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a vector tile layer from a TileJSON endpoint.

    Rendered directly by the core layer sync (no control), which reads
    ``source.url`` as a TileJSON URL and styles each named source layer.

    Args:
        name: Layer display name.
        url: TileJSON endpoint for the vector tileset.
        source_layers: Source-layer names to render (for multi-layer tilesets).
        source_layer: A single source-layer name (convenience for the common
            single-layer case).
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "vector-tiles", **style)
    source: dict[str, Any] = {"type": "vector", "url": url}
    if source_layers:
        if source_layer is not None:
            warnings.warn(
                "source_layer is ignored when source_layers is provided; pass one or the other.",
                stacklevel=2,
            )
        source["sourceLayers"] = list(source_layers)
    elif source_layer:
        source["sourceLayer"] = source_layer
    layer["source"] = source
    return layer


def pmtiles_layer(
    name: str,
    url: str,
    *,
    tile_type: str = "vector",
    source_layers: list[str] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a PMTiles layer from a ``.pmtiles`` URL.

    The core sync registers the ``pmtiles://`` protocol and prepends it to the
    URL automatically, so a plain ``https://`` URL is accepted here.

    Args:
        name: Layer display name.
        url: URL of the ``.pmtiles`` archive.
        tile_type: ``"vector"`` or ``"raster"``.
        source_layers: Vector source-layer names to render (vector tiles only).
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``tile_type`` is not ``"vector"`` or ``"raster"``.
    """
    if tile_type not in ("vector", "raster"):
        raise ValueError("tile_type must be 'vector' or 'raster'")
    source_layers = list(source_layers or [])
    layer = _layer_base(name, "pmtiles", **style)
    source_id = layer["id"]
    layer["source"] = {
        "type": "raster" if tile_type == "raster" else "vector",
        "url": url,
        "sourceId": source_id,
        "sourceLayers": source_layers,
        "tileType": tile_type,
    }
    # nativeLayerIds must be non-empty: isExternalNativeLayer() in layer-sync.ts
    # gates on its length, and a "pmtiles" layer has no fallback dispatch in
    # syncLayer, so an empty list means the source/layers are never added.
    # ensurePMTilesExternalLayer tolerates these placeholders — for raster it
    # matches the `${sourceId}-raster` fallback it would otherwise compute; for
    # vector getPMTilesNativeLayerId derives the real per-source-layer ids.
    native_layer_ids = [f"{source_id}-raster"] if tile_type == "raster" else [source_id]
    layer["metadata"] = {
        "sourceKind": "pmtiles-url",
        "externalNativeLayer": True,
        "sourceId": source_id,
        "tileType": tile_type,
        "sourceLayers": source_layers,
        "nativeLayerIds": native_layer_ids,
    }
    layer["sourcePath"] = url
    return layer


def three_d_tiles_layer(
    name: str,
    url: str,
    *,
    altitude_offset: float = 0,
    request_headers: dict[str, str] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a 3D Tiles layer from a ``tileset.json`` URL.

    The shape matches what ``restoreThreeDTilesLayers`` replays from a saved
    project, so the deck.gl 3D-tiles overlay is rebuilt on load.

    Args:
        name: Layer display name.
        url: URL of the 3D Tiles ``tileset.json``.
        altitude_offset: Vertical offset applied to the tileset, in meters.
        request_headers: Optional request headers (e.g. an auth token). Stored in
            the project file, so avoid persisting secrets you do not want saved.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.
    """
    layer = _layer_base(name, "3d-tiles", **style)
    source_id = layer["id"]
    source: dict[str, Any] = {
        "type": "3d-tiles",
        "url": url,
        "sourceId": source_id,
        "altitudeOffset": altitude_offset,
    }
    if request_headers:
        source["requestHeaders"] = request_headers
    layer["source"] = source
    layer["metadata"] = {
        "sourceKind": "3d-tiles-url",
        "externalNativeLayer": True,
        "customLayerType": "3d-tiles",
        "identifiable": False,
        "sourceId": source_id,
        "nativeLayerIds": [source_id],
        "altitudeOffset": altitude_offset,
        "panelCollapsed": True,
        "status": "loading",
    }
    layer["sourcePath"] = url
    return layer


def video_layer(
    name: str,
    urls: list[str],
    coordinates: list[list[float]],
    **style: Any,
) -> dict[str, Any]:
    """Build a georeferenced video layer.

    Args:
        name: Layer display name.
        urls: One or more video URLs (format fallbacks, e.g. MP4 then WebM).
        coordinates: Four ``[lng, lat]`` corners in top-left, top-right,
            bottom-right, bottom-left order.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``urls`` is empty, any URL is not ``https://`` (the
            browser's ``media-src`` CSP blocks ``http://``), or ``coordinates``
            is not four ``[lng, lat]`` pairs.
    """
    if not urls:
        raise ValueError("video_layer requires at least one non-empty URL")
    # Validate strictly rather than silently dropping a None/non-string entry,
    # which would mask a malformed call and build a layer with fewer URLs.
    invalid = [u for u in urls if not (isinstance(u, str) and u)]
    if invalid:
        raise ValueError(f"video_layer: every URL must be a non-empty string; got {invalid!r}")
    clean_urls = list(urls)
    if any(not u.lower().startswith("https://") for u in clean_urls):
        raise ValueError("Video URLs must start with https:// (the browser CSP blocks http://)")
    if len(coordinates) != 4 or any(len(corner) != 2 for corner in coordinates):
        raise ValueError(
            "coordinates must be four [lng, lat] corners (top-left, top-right, "
            "bottom-right, bottom-left)"
        )
    lngs = [float(c[0]) for c in coordinates]
    lats = [float(c[1]) for c in coordinates]
    layer = _layer_base(name, "video", **style)
    layer["source"] = {
        "type": "video",
        "urls": clean_urls,
        "coordinates": [[lng, lat] for lng, lat in zip(lngs, lats)],
    }
    # Persist the corner bbox ([west, south, east, north]) so "Zoom to layer"
    # works — a video source exposes no bounds for fitLayer to fall back on.
    layer["metadata"] = {
        "sourceKind": "video-url",
        "bounds": [min(lngs), min(lats), max(lngs), max(lats)],
    }
    layer["sourcePath"] = clean_urls[0]
    return layer


def load_featurecollection(data: Any) -> dict[str, Any]:
    """Coerce assorted inputs into a GeoJSON FeatureCollection dict.

    Accepts a FeatureCollection/Feature/geometry dict, a file path or URL to a
    GeoJSON file, a JSON string, or any object exposing ``__geo_interface__``
    (e.g. a GeoPandas GeoDataFrame/GeoSeries or a Shapely geometry).

    Args:
        data: The input geometry/collection in one of the supported forms.

    Returns:
        A GeoJSON FeatureCollection dict.

    Raises:
        ValueError: If the input cannot be interpreted as GeoJSON.
    """
    if hasattr(data, "__geo_interface__"):
        data = data.__geo_interface__

    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8")

    if isinstance(data, str):
        text = data.strip()
        if text.startswith(("http://", "https://")):
            # Reject non-public hosts up front, then fetch through an opener that
            # re-checks every redirect hop, so a redirect to a private/metadata
            # address cannot be followed (SSRF defence).
            _assert_public_url(text)
            # Bound the request so a slow or oversized response cannot hang the
            # kernel or exhaust memory. read(limit + 1) detects an over-limit
            # body without buffering the whole thing.
            try:
                with _GEOJSON_OPENER.open(text, timeout=30) as response:  # noqa: S310 - user URL
                    raw = response.read(_MAX_GEOJSON_BYTES + 1)
            except (URLError, TimeoutError) as exc:
                # Normalize transport failures to the documented ValueError
                # contract (decode/JSON errors are already ValueError-derived).
                raise ValueError(f"Could not load GeoJSON from URL: {text}") from exc
            if len(raw) > _MAX_GEOJSON_BYTES:
                raise ValueError("GeoJSON response exceeds the 50 MB size limit")
            data = json.loads(raw.decode("utf-8"))
        elif text.startswith(("{", "[")):
            data = json.loads(text)
        else:
            path = Path(text).expanduser()
            if not path.is_file():
                raise ValueError(f"GeoJSON file not found: {text}")
            if path.stat().st_size > _MAX_GEOJSON_BYTES:
                raise ValueError(f"GeoJSON file exceeds the 50 MB size limit: {text}")
            data = json.loads(path.read_text(encoding="utf-8"))

    if not isinstance(data, dict) or "type" not in data:
        raise ValueError("Could not interpret input as GeoJSON")

    geom_type = data["type"]
    if geom_type == "FeatureCollection":
        if not isinstance(data.get("features"), list):
            raise ValueError("FeatureCollection must have a 'features' list")
        return data
    if geom_type == "Feature":
        return {"type": "FeatureCollection", "features": [data]}
    # A bare geometry: wrap it in a feature.
    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": data}],
    }


# -- plugin (map control) state -----------------------------------------------
# The split-map (swipe), legend, and colorbar helpers are thin wrappers over the
# app's built-in map-control plugins, configured through the project's `plugins`
# block. The shapes here mirror the plugin project-state interfaces in
# packages/plugins/src/plugins/* (maplibre-swipe.ts, maplibre-components.ts), so
# the app replays them via PluginManager.restoreProjectState on load.

# The four corners every map control accepts (CONTROL_POSITIONS in
# maplibre-components.ts; PROJECT_PLUGIN_CONTROL_POSITIONS in core).
CONTROL_POSITIONS = frozenset({"top-left", "top-right", "bottom-left", "bottom-right"})

# Plugin ids registered in apps/geolibre-desktop/src/hooks/usePlugins.ts.
SWIPE_PLUGIN_ID = "maplibre-gl-swipe"
COMPONENTS_PLUGIN_ID = "maplibre-gl-components"

# Plugins the app activates by default (``activeByDefault: true`` in
# packages/plugins/src/plugins/*). When a project carries a `plugins` block,
# PluginManager.restoreProjectState deactivates any active plugin missing from
# `activePluginIds`, so a block built from Python must seed these or it would
# tear down the layer control and the deck.gl overlay that backs raster
# rendering. Kept in sync with EFFECTS_PLUGIN_ID / DECK_VIZ_PLUGIN_ID and
# layer-control.ts.
DEFAULT_ACTIVE_PLUGIN_IDS = (
    "maplibre-layer-control",
    "maplibre-deckgl-viz",
    "maplibre-atmosphere-effects",
)


def ensure_plugins_block(project: dict[str, Any]) -> dict[str, Any]:
    """Return the project's ``plugins`` block, creating it if absent.

    Mirrors ``normalizeProjectPlugins`` in ``packages/core/src/project.ts``: the
    block always carries ``manifestUrls``, ``activePluginIds``,
    ``mapControlPositions``, and ``settings``. A freshly created block is seeded
    with :data:`DEFAULT_ACTIVE_PLUGIN_IDS` so adding a control from Python does
    not deactivate the app's default plugins (an existing block is left as-is,
    honouring whatever the user/app already chose).

    Args:
        project: The project dict to read/extend in place.

    Returns:
        The (possibly newly created) ``plugins`` block dict.
    """
    if "plugins" not in project:
        project["plugins"] = {
            "manifestUrls": [],
            "activePluginIds": list(DEFAULT_ACTIVE_PLUGIN_IDS),
            "mapControlPositions": {},
            "settings": {},
        }
    plugins = project["plugins"]
    plugins.setdefault("manifestUrls", [])
    plugins.setdefault("activePluginIds", [])
    plugins.setdefault("mapControlPositions", {})
    plugins.setdefault("settings", {})
    return plugins


def set_plugin_state(
    project: dict[str, Any],
    plugin_id: str,
    settings: dict[str, Any],
    *,
    position: str | None = None,
    activate: bool = True,
) -> None:
    """Store a map-control plugin's project state in place, optionally activating.

    Writes the settings blob and records the control corner; with
    ``activate=True`` it also adds ``plugin_id`` to ``activePluginIds``. The
    Components plugin (legend/colorbar) restores from its settings alone, so it
    passes ``activate=False`` to avoid mounting the full Components toolbar.

    Args:
        project: The project dict to mutate.
        plugin_id: The plugin id (e.g. ``"maplibre-gl-swipe"``).
        settings: The plugin's project-state settings blob.
        position: Optional control corner; one of :data:`CONTROL_POSITIONS`.
        activate: Whether to add ``plugin_id`` to ``activePluginIds``.
    """
    plugins = ensure_plugins_block(project)
    if activate and plugin_id not in plugins["activePluginIds"]:
        plugins["activePluginIds"].append(plugin_id)
    if position is not None:
        plugins["mapControlPositions"][plugin_id] = position
    plugins["settings"][plugin_id] = settings


def swipe_state(
    *,
    left_layers: list[str],
    right_layers: list[str],
    orientation: str = "vertical",
    position: float = 50,
) -> dict[str, Any]:
    """Build the Layer Swipe plugin state (``SwipeState`` in maplibre-swipe.ts).

    Args:
        left_layers: Layer ids shown on the left/top of the slider. The string
            ``"__basemap__"`` selects the basemap.
        right_layers: Layer ids shown on the right/bottom of the slider.
        orientation: ``"vertical"`` or ``"horizontal"``.
        position: Slider position as a percentage in ``[0, 100]``.

    Returns:
        A swipe-state dict for the project's plugin settings.
    """
    return {
        "orientation": orientation,
        "position": position,
        "collapsed": False,
        "active": True,
        "leftLayers": list(left_layers),
        "rightLayers": list(right_layers),
        "isDragging": False,
    }


def legend_gui_entry(
    title: str,
    items: list[dict[str, Any]],
    position: str,
) -> dict[str, Any]:
    """Build one legend entry (``ComponentLegendGuiEntryState``)."""
    return {"title": title, "items": items, "legendPosition": position}


def legend_gui_state(
    entry: dict[str, Any],
    *,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the Legend control state, appending ``entry`` to any existing one.

    The control renders one on-map legend per item in its ``legends`` array
    (see ``LegendGuiControl.setState`` in maplibre-gl-components), so each call
    appends rather than replaces, and the top-level fields mirror the latest
    entry for the editing form.

    Args:
        entry: A legend entry from :func:`legend_gui_entry`.
        existing: The current ``legend`` state to append to, if any.

    Returns:
        A ``ComponentLegendGuiState`` dict.
    """
    prior = existing.get("legends", []) if isinstance(existing, dict) else []
    legends = [*prior, entry]
    return {
        **entry,
        "visible": True,
        "collapsed": False,
        "hasLegend": True,
        "selectedLegendIndex": len(legends) - 1,
        "legends": legends,
    }


def colorbar_gui_entry(
    *,
    mode: str,
    colormap: str,
    custom_colors: str,
    vmin: float,
    vmax: float,
    label: str,
    units: str,
    orientation: str,
    position: str,
) -> dict[str, Any]:
    """Build one colorbar entry (``ComponentColorbarGuiEntryState``)."""
    return {
        "mode": mode,
        "colormap": colormap,
        "customColors": custom_colors,
        "vmin": vmin,
        "vmax": vmax,
        "label": label,
        "units": units,
        "orientation": orientation,
        "colorbarPosition": position,
    }


def colorbar_gui_state(
    entry: dict[str, Any],
    *,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the Colorbar control state, appending ``entry`` to any existing one.

    Like :func:`legend_gui_state`, the control renders one colorbar per item in
    its ``colorbars`` array, so calls accumulate.

    Args:
        entry: A colorbar entry from :func:`colorbar_gui_entry`.
        existing: The current ``colorbar`` state to append to, if any.

    Returns:
        A ``ComponentColorbarGuiState`` dict.
    """
    prior = existing.get("colorbars", []) if isinstance(existing, dict) else []
    colorbars = [*prior, entry]
    return {
        **entry,
        "visible": True,
        "collapsed": False,
        "hasColorbar": True,
        "selectedColorbarIndex": len(colorbars) - 1,
        "colorbars": colorbars,
    }
