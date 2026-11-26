"""Translate an ArcGIS VectorTileServer style into the app's ``arcgis`` layer shape.

The app adds a VectorTileServer through ``@esri/maplibre-arcgis``'s
``VectorTileLayer.fromUrl`` and stores the resolved style on the layer
(``createArcGISStoreLayer`` plus ``arcgisSources``/``arcgisLayers`` in
``packages/plugins/src/plugins/arcgis-layer.ts``). Every renderer then redraws
the service from that stored style (``arcgisVectorStyle`` in
``packages/map/src/vector-style.ts``), so a layer built here opens exactly like
one added through the Add Data dialog. Nothing in this module touches the
network: the caller reads the service and style JSON and hands them in.
"""

from __future__ import annotations

import math
import re
from typing import Any
from urllib.parse import unquote, urljoin, urlsplit

#: Style layer kinds ``arcgisVectorStyle`` draws from a vector source. A
#: ``background`` needs no source and is also accepted.
DRAWABLE_LAYER_TYPES = frozenset({"fill", "line", "circle", "symbol", "fill-extrusion", "heatmap"})

#: Style layers accepted from one service; Esri's World Basemap has about 900.
MAX_STYLE_LAYERS = 5000

#: Web Mercator WKIDs ``arcgisExtentToBounds`` converts from metres.
_WEB_MERCATOR_WKIDS = frozenset({102100, 102113, 3857})

#: Geographic CRSs outside the ranges :func:`_is_geographic_wkid` covers
#: (``ARCGIS_GEOGRAPHIC_WKIDS`` in arcgis-layer.ts).
_EXTRA_GEOGRAPHIC_WKIDS = frozenset({6668, 7844, 6318, 6322, 6325})


def _sanitize_id_part(value: str) -> str:
    """Make a style id safe inside a layer-scoped id, as ``sanitizeIdPart``.

    Args:
        value: A source or style layer id from the service style.

    Returns:
        The id with runs of other characters replaced by ``-``.
    """
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-zA-Z0-9_-]+", "-", value)) or "id"


def _is_geo_bounds(value: Any) -> bool:
    """Whether a value is a valid ``[west, south, east, north]`` in degrees.

    Args:
        value: A candidate bounds array.

    Returns:
        True when it has four finite numbers in longitude/latitude order.
    """
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return False
    if any(
        isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item)
        for item in value
    ):
        return False
    west, south, east, north = value
    return -180 <= west < east <= 180 and -90 <= south < north <= 90


def _is_geographic_wkid(wkid: int) -> bool:
    """Whether a WKID names a geographic CRS, as ``isGeographicWkid``.

    Args:
        wkid: The extent's well-known id.

    Returns:
        True for the EPSG and Esri geographic ranges.
    """
    return (
        4000 <= wkid <= 4999
        or 37001 <= wkid <= 37299
        or 104000 <= wkid <= 104999
        or wkid in _EXTRA_GEOGRAPHIC_WKIDS
    )


def _extent_bounds(extent: Any) -> list[float] | None:
    """Convert a service extent to WGS84 bounds, as ``arcgisExtentToBounds``.

    Args:
        extent: An ArcGIS extent object with a spatial reference.

    Returns:
        ``[west, south, east, north]`` degrees, or None when unusable.
    """
    if not isinstance(extent, dict):
        return None
    reference = extent.get("spatialReference")
    wkid = (
        reference.get("latestWkid", reference.get("wkid")) if isinstance(reference, dict) else None
    )
    values = [extent.get(key) for key in ("xmin", "ymin", "xmax", "ymax")]
    if any(
        isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item)
        for item in values
    ):
        return None
    xmin, ymin, xmax, ymax = (float(item) for item in values)
    if isinstance(wkid, bool) or not isinstance(wkid, (int, float)):
        wkid = None
    if wkid in _WEB_MERCATOR_WKIDS:
        # Beyond the Web Mercator square the conversion is meaningless (and
        # math.exp overflows for absurd values), so such an extent has no bounds.
        limit = 20037508.342789244 * 1.0001
        if any(abs(value) > limit for value in (xmin, ymin, xmax, ymax)):
            return None

        def lat(y: float) -> float:
            degrees = (y / 20037508.34) * 180
            return (180 / math.pi) * (
                2 * math.atan(math.exp(degrees * math.pi / 180)) - math.pi / 2
            )

        bounds = [
            max(-180.0, (xmin / 20037508.34) * 180),
            lat(ymin),
            min(180.0, (xmax / 20037508.34) * 180),
            lat(ymax),
        ]
        return bounds if _is_geo_bounds(bounds) else None
    if wkid is not None and not _is_geographic_wkid(int(wkid)):
        return None
    bounds = [xmin, ymin, xmax, ymax]
    return bounds if _is_geo_bounds(bounds) else None


def _remote_text(value: Any) -> str:
    """Reduce a remote credit to plain text, as ``cached_arcgis_source`` does.

    Args:
        value: The service's ``copyrightText``.

    Returns:
        The credit without markup, or an empty string.
    """
    if not isinstance(value, str):
        return ""
    return " ".join(re.sub(r"<[^>]*>?", "", value).replace("<", "").split())


def layer_name_from_service_url(url: str) -> str:
    """Name a layer after its service, as ``layerNameFromArcGISInput``.

    Args:
        url: The VectorTileServer URL.

    Returns:
        The path segment before ``VectorTileServer``, underscores as spaces.
    """
    parts = [part for part in urlsplit(url).path.split("/") if part]
    index = next(
        (
            i
            for i, part in enumerate(parts)
            if re.fullmatch(r"(FeatureServer|VectorTileServer|MapServer|ImageServer)", part, re.I)
        ),
        -1,
    )
    part = parts[index - 1] if index > 0 else (parts[-1] if parts else "")
    return unquote(part).replace("_", " ") or "ArcGIS Vector Tiles"


def style_endpoint(info: Any) -> str:
    """The relative style resource the SDK reads (``defaultStyles``).

    Args:
        info: The VectorTileServer's REST JSON description.

    Returns:
        The style path with a trailing slash, ``resources/styles/`` by default.

    Raises:
        ValueError: If the description is not a JSON object.
    """
    if not isinstance(info, dict):
        raise ValueError("ArcGIS vector tile service metadata must be a JSON object")
    endpoint = info.get("defaultStyles")
    if not isinstance(endpoint, str) or not endpoint.strip():
        endpoint = "resources/styles"
    endpoint = endpoint.strip()
    if re.match(r"^[a-z][a-z0-9+.-]*:", endpoint, re.I) or endpoint.startswith("/"):
        raise ValueError("ArcGIS vector tile defaultStyles must be a relative resource path")
    return endpoint if endpoint.endswith("/") else endpoint + "/"


def build_arcgis_vector_tile_style(
    info: Any, style: Any, service_url: str, layer_id: str
) -> dict[str, Any]:
    """Resolve a VectorTileServer style the way ``VectorTileLayer`` does, then scope it.

    Mirrors ``VectorTileLayer._cleanStyle`` (relative source URLs resolved
    against the style URL, ``tiles`` built from the service's tile template,
    the service credit as each source's attribution) and then the app's
    ``prefixArcGISSourceIds``/``snapshotArcGISStyle`` id scoping. The result is
    validated against the rules ``arcgisVectorStyle`` applies on load, so a
    style the app could not draw is refused instead of saved.

    Args:
        info: The service's REST JSON description (``?f=json``).
        style: The style JSON read from the service's ``defaultStyles``.
        service_url: The normalized service URL, without a trailing slash.
        layer_id: The GeoLibre layer id the ids are scoped to.

    Returns:
        ``sources``, ``layers``, ``sourceIds``, ``nativeLayerIds`` and
        ``bounds`` (or None) for the layer record.

    Raises:
        ValueError: If the description or style is malformed or uses sources
            or layer kinds the app cannot draw.
    """
    base = service_url.rstrip("/") + "/"
    style_url = base + style_endpoint(info)
    if not isinstance(style, dict):
        raise ValueError("ArcGIS vector tile style must be a JSON object")
    raw_sources = style.get("sources")
    raw_layers = style.get("layers")
    if not isinstance(raw_sources, dict) or not raw_sources:
        raise ValueError("ArcGIS vector tile style must define its sources")
    if not isinstance(raw_layers, list) or not raw_layers:
        raise ValueError("ArcGIS vector tile style must list its layers")
    if len(raw_layers) > MAX_STYLE_LAYERS:
        raise ValueError(f"ArcGIS vector tile style has more than {MAX_STYLE_LAYERS} layers")
    service_tiles = info.get("tiles")
    tile_template = (
        service_tiles[0]
        if isinstance(service_tiles, list) and service_tiles and isinstance(service_tiles[0], str)
        else None
    )
    attribution = _remote_text(info.get("copyrightText"))

    sources: dict[str, Any] = {}
    renamed: dict[str, str] = {}
    for index, (original_id, raw) in enumerate(raw_sources.items()):
        if not isinstance(raw, dict) or raw.get("type") != "vector":
            raise ValueError("ArcGIS vector tile style sources must be vector sources")
        source = dict(raw)
        url = source.get("url")
        if url is not None:
            if not isinstance(url, str) or not url.strip():
                raise ValueError("ArcGIS vector tile source url must be a string")
            url = urljoin(style_url, url.strip())
            url = url if url.endswith("/") else url + "/"
            source["url"] = url
        tiles = source.get("tiles")
        if tiles is None:
            if url is None:
                raise ValueError("ArcGIS vector tile source has neither a url nor tiles")
            # urljoin keeps an absolute service template intact and appends a
            # relative one to the source URL, as the SDK's concatenation does.
            tiles = [urljoin(url, tile_template or "tile/{z}/{y}/{x}.pbf")]
        if (
            not isinstance(tiles, list)
            or not tiles
            or not all(isinstance(tile, str) for tile in tiles)
        ):
            raise ValueError("ArcGIS vector tile source tiles must be a list of URLs")
        tiles = [urljoin(url or style_url, tile) for tile in tiles]
        for tile in [*tiles, *([url] if url else [])]:
            if not tile.lower().startswith(("https://", "http://")):
                raise ValueError("ArcGIS vector tile sources must resolve to http(s) URLs")
            if "token=" in unquote(tile).lower():
                raise ValueError("ArcGIS vector tile sources must not carry a token")
            parts = urlsplit(tile)
            if parts.username is not None or parts.password is not None:
                raise ValueError("ArcGIS vector tile sources must not embed credentials")
        if not all(all(f"{{{part}}}" in tile for part in "zxy") for tile in tiles):
            raise ValueError("ArcGIS vector tile URLs must contain {z}, {x} and {y}")
        source["tiles"] = tiles
        # The SDK replaces any style attribution with the service credit, or
        # an empty string when the service has none.
        source["attribution"] = attribution or _remote_text(raw.get("attribution"))
        scoped = f"{layer_id}-source-{index}-{_sanitize_id_part(str(original_id))}"
        renamed[str(original_id)] = scoped
        sources[scoped] = source

    layers: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_layers):
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            raise ValueError("ArcGIS vector tile style layers must be objects with string ids")
        layer = dict(raw)
        kind = layer.get("type")
        if kind != "background":
            if not isinstance(kind, str) or kind not in DRAWABLE_LAYER_TYPES:
                raise ValueError(
                    f"ArcGIS vector tile style layer {raw['id']!r} has unsupported type {kind!r}"
                )
            source_layer = layer.get("source-layer")
            source_key = layer.get("source")
            if (
                not isinstance(source_key, str)
                or source_key not in renamed
                or not (isinstance(source_layer, str) and source_layer)
            ):
                raise ValueError(
                    f"ArcGIS vector tile style layer {raw['id']!r} must name one of the "
                    "style's sources and a source-layer"
                )
            layer["source"] = renamed[source_key]
        layer["id"] = f"{layer_id}-layer-{index}-{_sanitize_id_part(raw['id'])}"
        layers.append(layer)

    bounds = next(
        (
            [float(item) for item in source["bounds"]]
            for source in sources.values()
            if _is_geo_bounds(source.get("bounds"))
        ),
        None,
    )
    if bounds is None:
        extent = info.get("fullExtent") or info.get("initialExtent") or info.get("extent")
        bounds = _extent_bounds(extent)
    return {
        "sources": sources,
        "layers": layers,
        "sourceIds": list(sources),
        "nativeLayerIds": [layer["id"] for layer in layers],
        "bounds": bounds,
    }
