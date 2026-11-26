"""OGC and ArcGIS service layer builders: WMS, WMTS, WFS and ArcGIS services."""

from __future__ import annotations

import json
import math
import re
import time
from http.client import HTTPException
from typing import Any
from urllib.parse import quote, unquote, unquote_plus, urlsplit

from .._arcgis_cache import cached_arcgis_source
from .._arcgis_vector_tiles import (
    build_arcgis_vector_tile_style,
    layer_name_from_service_url,
    style_endpoint,
)
from .fetch import _GEOJSON_OPENER, _assert_public_url
from .layers import _assert_no_url_userinfo, _layer_base
from .raster import _resolve_bounds

# Characters JavaScript's encodeURIComponent leaves unescaped on top of the
# always-unreserved set (alphanumerics and ``-_.~``), so _append_query produces
# byte-identical query strings to the app's appendQuery helper.
_ENCODE_URI_SAFE = "!*'()"


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


#: The GetMap parameters `wms_layer` writes itself, lower-cased.
_WMS_GETMAP_KEYS = frozenset(
    {
        "service",
        "request",
        "version",
        "layers",
        "styles",
        "format",
        "transparent",
        "srs",
        "crs",
        "bbox",
        "width",
        "height",
    }
)


def _drop_query_keys(endpoint: str, keys: frozenset[str]) -> str:
    """Remove query parameters named in ``keys`` (case-insensitive) from a URL.

    The other parameters are kept byte for byte, in order, so a vendor option
    such as ``map=...`` reaches the server exactly as the caller wrote it.

    Args:
        endpoint: A URL that may carry a query string.
        keys: Lower-case parameter names to drop.

    Returns:
        The endpoint without those parameters.
    """
    base, sep, fragment = endpoint.partition("#")
    path, qmark, query = base.partition("?")
    if not qmark:
        return endpoint
    # Names are compared decoded, as a server or `URLSearchParams` reads them,
    # so `%73RS=` counts as `SRS=`; kept parameters stay as written.
    kept = [
        part for part in query.split("&") if unquote_plus(part.split("=", 1)[0]).lower() not in keys
    ]
    return f"{path}?{'&'.join(kept)}{sep}{fragment}"


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


#: Web Mercator and the geographic CRSs a WMS layer can be requested in.
#: MapLibre tiles are Web Mercator; the geographic ones are for servers without
#: EPSG:3857, which the desktop app requests per tile in that CRS and redraws
#: into Web Mercator strip by strip. Keep in step with `GEOGRAPHIC_WMS_CRS` in
#: `apps/geolibre-desktop/src/lib/wms-geographic.ts`: a geographic CRS accepted
#: here but missing there takes the projected path, and
#: `tests/wms-geographic.test.ts` fails when the two drift. Any other
#: ``EPSG:<code>`` is accepted too, projected or geographic, and warped by the
#: desktop app (see `_normalize_wms_crs`).
WMS_CRS = frozenset({"EPSG:3857", "EPSG:4326", "EPSG:4258", "EPSG:6706", "CRS:84"})


_EPSG_CODE = re.compile(r"EPSG:\d{4,6}")


def _normalize_wms_crs(crs: str | None) -> str:
    """Normalize the CRS a WMS layer requests its tiles in.

    Args:
        crs: The requested CRS code, or None for Web Mercator.

    Returns:
        The upper-cased code, ``"EPSG:3857"`` for None.

    Raises:
        ValueError: If ``crs`` is neither one of :data:`WMS_CRS` nor an
            ``EPSG:<code>``.
    """
    if crs is None:
        return "EPSG:3857"
    code = str(crs).strip().upper()
    # Any other EPSG CRS (UTM, a national grid, another geographic datum) is
    # resolved by the desktop app from its EPSG tables; a code it does not know
    # is sent to the server as is.
    if code not in WMS_CRS and not _EPSG_CODE.fullmatch(code):
        raise ValueError(
            f"crs must be one of {sorted(WMS_CRS)} or an EPSG code such as 'EPSG:25832', "
            f"got {crs!r}"
        )
    return code


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
    crs: str | None = None,
    bounds: list[float] | None = None,
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
        crs: The CRS tiles are requested in: ``"EPSG:3857"`` (None, the
            default) or, for a server that does not offer Web Mercator, a CRS
            it does list in its capabilities: a geographic one
            (``"EPSG:4326"``, ``"EPSG:4258"``, ``"EPSG:6706"``, ``"CRS:84"``)
            or a projected ``"EPSG:<code>"`` such as ``"EPSG:25832"``. The
            desktop app requests each tile's extent in that CRS and redraws
            or warps it into Web Mercator; the web build still sends the Web
            Mercator BBOX, which such a server rejects.
        bounds: Optional ``[west, south, east, north]`` request bounds, in
            WGS84. Take them from the service's ``EX_GeographicBoundingBox``,
            which is always lon/lat, rather than a 1.3.0 ``BoundingBox
            CRS="EPSG:4326"``, whose axis order servers often get wrong.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``bounds`` is not four finite numbers with valid latitudes,
            ``crs`` is neither one of :data:`WMS_CRS` nor an ``EPSG:<code>``,
            or ``crs`` is ``"CRS:84"`` with a version other than 1.3.0.
    """
    wms_version = _normalize_wms_version(version)
    wms_crs = _normalize_wms_crs(crs)
    if wms_crs == "CRS:84" and wms_version != "1.3.0":
        # CRS:84 is defined by WMS 1.3.0; a 1.1.1 server rejects it as an SRS.
        raise ValueError("crs='CRS:84' needs version='1.3.0'; use EPSG:4326 with WMS 1.1.1")
    # An endpoint copied from a capabilities OnlineResource or a GetMap URL
    # may already carry VERSION, CRS or BBOX. A duplicate would leave the
    # server and the desktop tile protocol (which reads the first VERSION to
    # pick the axis order) disagreeing, so every key written here replaces
    # the endpoint's own; vendor parameters such as `map=` are kept.
    tile_url = _append_query(
        _drop_query_keys(endpoint, _WMS_GETMAP_KEYS),
        [
            ("SERVICE", "WMS"),
            ("REQUEST", "GetMap"),
            ("VERSION", wms_version),
            ("LAYERS", layers),
            ("STYLES", styles),
            ("FORMAT", image_format),
            ("TRANSPARENT", "TRUE" if transparent else "FALSE"),
            ("CRS" if wms_version == "1.3.0" else "SRS", wms_crs),
            ("BBOX", "{bbox-epsg-3857}"),
            ("WIDTH", str(tile_size)),
            ("HEIGHT", str(tile_size)),
        ],
    )
    layer = _layer_base(name, "wms", **style)
    source: dict[str, Any] = {
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
    resolved_bounds = _resolve_bounds(bounds)
    if resolved_bounds is not None:
        source["bounds"] = resolved_bounds
    layer["source"] = source
    layer["metadata"] = {"service": "wms"}
    return layer


def wmts_layer(
    name: str,
    url: str,
    *,
    tile_size: int = 256,
    bounds: list[float] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a WMTS layer from a tile URL template.

    Args:
        name: Layer display name.
        url: A WMTS tile URL template in WMTS REST ``{z}/{y}/{x}`` order (row
            before column — unlike XYZ templates in ``tile_layer``/``add_tile_layer``,
            which use ``{z}/{x}/{y}``).
        tile_size: Tile size in pixels.
        bounds: Optional ``[west, south, east, north]`` request bounds, in
            WGS84. WMTS capabilities carry it as ``ows:WGS84BoundingBox``
            (``EX_GeographicBoundingBox`` is a WMS element and is absent here).
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``bounds`` is not four finite numbers with valid latitudes.
    """
    layer = _layer_base(name, "wmts", **style)
    source: dict[str, Any] = {
        "type": "raster",
        "tiles": [url],
        "tileSize": tile_size,
        "url": url,
    }
    resolved_bounds = _resolve_bounds(bounds)
    if resolved_bounds is not None:
        source["bounds"] = resolved_bounds
    layer["source"] = source
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


def wfs_layer(
    name: str,
    endpoint: str,
    type_name: str,
    *,
    version: str = "2.0.0",
    output_format: str = "application/json",
    srs_name: str | None = "EPSG:4326",
    max_features: int | None = 1000,
    data: dict[str, Any] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a WFS layer, mirroring ``buildWfsGeoJsonLayer`` in the Add Data dialog.

    Without ``data`` the layer is a reference only: the app fetches the
    GetFeature URL when the project opens (``useLayerRefresh``'s bootstrap for a
    ``wfs-getfeature`` layer with no inlined features), which is also how it
    saves an unedited WFS layer. Pass ``data`` to inline a response you already
    fetched.

    Args:
        name: Layer display name.
        endpoint: WFS service endpoint.
        type_name: WFS feature type name (e.g. ``"topp:states"``).
        version: WFS protocol version (e.g. ``"2.0.0"`` or ``"1.1.0"``).
        output_format: Requested output format; it must yield GeoJSON.
        srs_name: Spatial reference of the response, or None to omit it.
        max_features: Cap on the number of returned features, or None for all.
        data: Optional GeoJSON FeatureCollection to inline.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``endpoint`` or ``type_name`` is blank, or the endpoint
            embeds username/password credentials.
    """
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise ValueError("wfs_layer: endpoint must be a non-empty URL")
    if not isinstance(type_name, str) or not type_name.strip():
        raise ValueError("wfs_layer: type_name must be a non-empty string")
    _assert_no_url_userinfo(endpoint.strip())
    url = wfs_getfeature_url(
        endpoint.strip(),
        type_name.strip(),
        version=version,
        output_format=output_format,
        srs_name=srs_name or "",
        max_features=max_features,
    )
    layer = _layer_base(name, "geojson", **style)
    source: dict[str, Any] = {
        "type": "geojson",
        "url": url,
        "service": "wfs",
        "typeName": type_name.strip(),
        "version": version,
        "outputFormat": output_format,
    }
    if srs_name:
        source["srsName"] = srs_name
    layer["source"] = source
    layer["sourcePath"] = url
    layer["metadata"] = {
        "service": "wfs",
        "sourceKind": "wfs-getfeature",
        "typeName": type_name.strip(),
    }
    if data is not None:
        layer["geojson"] = data
        features = data.get("features") if isinstance(data, dict) else None
        layer["metadata"]["featureCount"] = len(features) if isinstance(features, list) else 0
    return layer


#: ArcGIS service kinds :func:`arcgis_layer` builds, keyed by the ``service``
#: argument, with the app's ``arcgisLayerType`` and ``sourceKind`` for each
#: (``ArcGISLayerType`` and the source-kind constants in arcgis-layer.ts).
ARCGIS_SERVICES: dict[str, tuple[str, str]] = {
    "map": ("map-service", "arcgis-map-service"),
    "image": ("image-service", "arcgis-image-service"),
    "feature": ("feature", "arcgis-feature-query"),
}


_ARCGIS_EXPORT_TILE_SIZE = 256


def _refuse_non_json_number(token: str) -> Any:
    """Refuse the ``NaN``/``Infinity`` literals Python's decoder accepts.

    Args:
        token: The non-standard literal.

    Raises:
        json.JSONDecodeError: Always, so the reader reports invalid JSON.
    """
    raise json.JSONDecodeError(f"non-JSON number {token}", token, 0)


def _finite_float(token: str) -> float:
    """Decode a JSON float, refusing one that overflows to infinity.

    Args:
        token: The numeric literal, e.g. ``1e400``.

    Returns:
        The finite value.

    Raises:
        json.JSONDecodeError: When the literal is out of float range.
    """
    value = float(token)
    if not math.isfinite(value):
        raise json.JSONDecodeError(f"non-JSON number {token}", token, 0)
    return value


def _read_public_arcgis_json(url: str, label: str, limit: int = 2 * 1024 * 1024) -> Any:
    """Read one bounded public ArcGIS REST JSON document.

    Args:
        url: The public URL to read, including its ``f=json`` query.
        label: What the document is, for error messages (e.g. ``"ArcGIS cache
            metadata"``).
        limit: Maximum response size in bytes.

    Returns:
        The decoded JSON value.

    Raises:
        ValueError: If the request is unsafe, fails, exceeds the size limit,
            takes longer than 30 seconds or is not valid JSON.
    """
    _assert_public_url(url)
    deadline = time.monotonic() + 30
    chunks: list[bytes] = []
    size = 0
    try:
        with _GEOJSON_OPENER.open(url, timeout=30) as response:  # noqa: S310 - public URL checked
            # The socket timeout bounds each read, not the whole response, so
            # read one buffer at a time and enforce a total deadline as well.
            read = getattr(response, "read1", response.read)
            while size <= limit:
                if time.monotonic() > deadline:
                    raise ValueError(f"{label} took longer than 30 seconds to load")
                chunk = read(min(65536, limit + 1 - size))
                if time.monotonic() > deadline:
                    raise ValueError(f"{label} took longer than 30 seconds to load")
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
    except (OSError, HTTPException) as exc:
        raise ValueError(f"Could not load {label}") from exc
    raw = b"".join(chunks)
    if len(raw) > limit:
        raise ValueError(f"{label} exceeds the {limit // (1024 * 1024)} MiB size limit")
    try:
        return json.loads(
            raw.decode("utf-8"),
            parse_constant=_refuse_non_json_number,
            parse_float=_finite_float,
        )
    except RecursionError as exc:
        raise ValueError(f"{label} is too deeply nested") from exc
    except ValueError as exc:
        # Decoding errors, JSONDecodeError and int() digit-limit errors.
        raise ValueError(f"{label} is not valid JSON") from exc


def _load_arcgis_cached_source(service_url: str) -> dict[str, Any]:
    """Read bounded public service metadata and validate its image tile cache.

    Args:
        service_url: The normalized MapServer or ImageServer URL.

    Returns:
        The validated raster source shape.

    Raises:
        ValueError: If the request is unsafe, fails, exceeds the size limit or
            describes an incompatible cache.
    """
    info = _read_public_arcgis_json(f"{service_url}?f=json", "ArcGIS cache metadata")
    return cached_arcgis_source(info, service_url)


def _arcgis_export_tile_url(
    service_url: str, *, image: bool, sublayers: str | None, rendering_rule: str | None
) -> str:
    """Build the ``/export`` or ``/exportImage`` tile template, as ``arcgisExportTileUrl``.

    Args:
        service_url: The MapServer or ImageServer URL.
        image: True for an ImageServer.
        sublayers: Comma-separated MapServer sublayer ids to show, or None.
        rendering_rule: ImageServer rendering rule JSON, or None.

    Returns:
        The tile template, with ``{bbox-epsg-3857}`` left literal for MapLibre.
    """
    size = f"{_ARCGIS_EXPORT_TILE_SIZE},{_ARCGIS_EXPORT_TILE_SIZE}"
    params: list[tuple[str, str]] = [
        ("bbox", "{bbox-epsg-3857}"),
        ("bboxSR", "3857"),
        ("imageSR", "3857"),
        ("size", size),
        ("format", "png32"),
        ("transparent", "true"),
    ]
    if not image:
        params.append(("dpi", "96"))
        if sublayers:
            params.append(("layers", f"show:{sublayers}"))
    elif rendering_rule:
        params.append(("renderingRule", rendering_rule))
    params.append(("f", "image"))
    query = "&".join(
        f"{key}={value if value == '{bbox-epsg-3857}' else quote(value, safe=_ENCODE_URI_SAFE)}"
        for key, value in params
    )
    return f"{service_url}/{'exportImage' if image else 'export'}?{query}"


def arcgis_layer(
    name: str,
    url: str,
    *,
    service: str = "map",
    tiled: bool = False,
    sublayers: str | list[int] | None = None,
    rendering_rule: str | dict[str, Any] | None = None,
    max_features: int | None = None,
    bounds: list[float] | None = None,
    attribution: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build an ArcGIS REST service layer the way the ArcGIS plugin saves one.

    - ``service="map"`` (MapServer) and ``service="image"`` (ImageServer) build a
      ``raster`` layer drawing the service's ``/export`` or ``/exportImage``
      endpoint per tile, which the core raster sync renders on every engine.
    - ``service="feature"`` (a FeatureServer or MapServer *layer* URL ending in
      ``/<id>``) builds a ``geojson`` layer that the app's viewport loader fills
      from the service's ``/query`` endpoint when the project opens on the
      MapLibre map. Other renderers show it empty until it is refreshed.

    Credentials are not supported: a token would be written into the project.
    With ``tiled=True``, map/image services use their existing image cache.
    Public service metadata is fetched to verify the Web Mercator XYZ grid;
    incompatible caches are refused rather than saved with misplaced tiles.

    Args:
        name: Layer display name.
        url: The service URL, e.g. ``.../MapServer``, ``.../ImageServer``, or
            ``.../FeatureServer/0``.
        service: ``"map"``, ``"image"``, or ``"feature"``.
        tiled: Use a validated public map/image cache instead of dynamic export.
            Cannot be combined with sublayers or a rendering rule. Raw LERC
            caches are not supported by this raster authoring path. Metadata
            reads have a 2 MiB size limit and a 30-second deadline checked
            before and after each read. An in-flight socket read can delay
            reporting a deadline error until that read finishes or times out.
            Connect, redirect and header processing use the socket inactivity
            timeout; the elapsed-time checks only run around body reads.
        sublayers: MapServer sublayer ids to show (``"0,2"`` or ``[0, 2]``).
        rendering_rule: ImageServer rendering rule, as a dict or JSON string
            (e.g. ``{"rasterFunction": "Hillshade"}``).
        max_features: Feature service cap on features loaded per view.
        bounds: Optional ``[west, south, east, north]`` extent in WGS84, so
            "Zoom to layer" can reach a service layer.
        attribution: Optional attribution text (the service's copyright).
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``service`` is unknown, ``url`` is not an http(s) URL,
            carries credentials or a ``token``, an option does not apply to
            ``service``, or a requested cache cannot be read or is incompatible.
    """
    if service not in ARCGIS_SERVICES:
        raise ValueError(f"service must be one of {sorted(ARCGIS_SERVICES)}, got {service!r}")
    if not isinstance(tiled, bool):
        raise ValueError("tiled must be a boolean")
    if tiled and (service == "feature" or sublayers is not None or rendering_rule is not None):
        raise ValueError("tiled requires a map/image service without sublayers or a rendering_rule")
    if not isinstance(url, str) or not url.strip().lower().startswith(("https://", "http://")):
        raise ValueError("url must be an http(s) ArcGIS REST service URL")
    service_url = url.strip().split("?", 1)[0].split("#", 1)[0].rstrip("/")
    _assert_no_url_userinfo(service_url)
    if "token=" in url.lower():
        raise ValueError("url must not carry a token: it would be saved into the project")
    layer_type, source_kind = ARCGIS_SERVICES[service]
    if sublayers is not None and service != "map":
        raise ValueError("sublayers applies only to service='map'")
    if rendering_rule is not None and service != "image":
        raise ValueError("rendering_rule applies only to service='image'")
    if max_features is not None and service != "feature":
        raise ValueError("max_features applies only to service='feature'")
    resolved_bounds = _resolve_bounds(bounds)

    if service == "feature":
        if max_features is not None and (
            not isinstance(max_features, int) or isinstance(max_features, bool) or max_features < 1
        ):
            raise ValueError(f"max_features must be a positive integer, got {max_features!r}")
        query_url = f"{service_url}/query"
        refresh_url = _append_query(
            query_url,
            [("f", "geojson"), ("outFields", "*"), ("returnGeometry", "true"), ("where", "1=1")],
        )
        layer = _layer_base(name, "geojson", **style)
        source: dict[str, Any] = {"type": "geojson", "arcgisQueryUrl": query_url}
        if max_features is not None:
            source["maxFeatures"] = max_features
        if attribution:
            source["attribution"] = attribution
        layer["source"] = source
        # Filled by the viewport loader on open; empty until then.
        layer["geojson"] = {"type": "FeatureCollection", "features": []}
        layer["sourcePath"] = refresh_url
        metadata: dict[str, Any] = {"sourceKind": source_kind, "viewportLoading": True}
        if resolved_bounds is not None:
            metadata["bounds"] = resolved_bounds
        layer["metadata"] = metadata
        return layer

    if sublayers is not None:
        if isinstance(sublayers, (list, tuple)):
            if any(
                not isinstance(value, int) or isinstance(value, bool) or value < 0
                for value in sublayers
            ):
                raise ValueError("sublayers must contain nonnegative integer layer ids")
            sublayer_text = ",".join(str(value) for value in sublayers)
        else:
            sublayer_text = str(sublayers).strip()
        if not re.fullmatch(r"\d+(,\d+)*", sublayer_text):
            raise ValueError(f"sublayers must be layer ids such as '0,2', got {sublayers!r}")
    else:
        sublayer_text = None
    rule_text: str | None = None
    if rendering_rule is not None:
        rule_text = (
            json.dumps(rendering_rule, separators=(",", ":"))
            if isinstance(rendering_rule, dict)
            else str(rendering_rule).strip()
        )
        try:
            parsed_rule = json.loads(rule_text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"rendering_rule must be JSON, got {rendering_rule!r}") from exc
        if not isinstance(parsed_rule, dict):
            raise ValueError("rendering_rule must be a JSON object")
    image = service == "image"
    layer = _layer_base(name, "raster", **style)
    if tiled:
        raster_source = _load_arcgis_cached_source(service_url)
    else:
        raster_source = {
            "type": "raster",
            "tiles": [
                _arcgis_export_tile_url(
                    service_url, image=image, sublayers=sublayer_text, rendering_rule=rule_text
                )
            ],
            "tileSize": _ARCGIS_EXPORT_TILE_SIZE,
        }
    if resolved_bounds is not None:
        raster_source["bounds"] = resolved_bounds
    if attribution:
        raster_source["attribution"] = attribution
    layer["source"] = raster_source
    raster_metadata: dict[str, Any] = {
        "arcgisLayerType": layer_type,
        "arcgisSourceType": "url",
        "arcgisTiled": tiled,
        "hasAccessToken": False,
        "sourceKind": source_kind,
    }
    if resolved_bounds is not None:
        raster_metadata["bounds"] = resolved_bounds
    if rule_text is not None:
        raster_metadata["arcgisRenderingRule"] = rule_text
    if sublayer_text is not None:
        raster_metadata["arcgisSublayers"] = sublayer_text
    layer["metadata"] = raster_metadata
    layer["sourcePath"] = service_url
    return layer


#: Style JSON size cap; Esri's World Basemap style is about 0.8 MiB.
_ARCGIS_STYLE_LIMIT = 8 * 1024 * 1024


def arcgis_vector_tile_layer(
    url: str,
    name: str | None = None,
    *,
    bounds: list[float] | None = None,
    attribution: str | None = None,
) -> dict[str, Any]:
    """Build a styled ArcGIS VectorTileServer layer the way the ArcGIS plugin saves one.

    The app adds a VectorTileServer through ``@esri/maplibre-arcgis`` and
    stores the service's resolved default style on an ``arcgis`` layer
    (``createArcGISStoreLayer`` with ``arcgisSources``/``arcgisLayers``), which
    every renderer redraws on open. This builder reads the same two public
    documents, the service description and its ``defaultStyles`` style, and
    writes the same record, so the project opens with the service's own
    cartography. Credentials and portal item ids are not supported.

    Both reads are limited in size (2 MiB for the description, 8 MiB for the
    style) and each has a 30-second deadline checked around body reads and a
    socket inactivity timeout. The style is validated against what the app can
    draw (vector sources, drawable layer kinds naming those sources) and is
    refused rather than saved when it would not render.

    Args:
        url: The ``.../VectorTileServer`` URL.
        name: Layer display name; defaults to the service name, as the app does.
        bounds: ``[west, south, east, north]`` to use for "Zoom to layer"
            instead of the style's or service's extent.
        attribution: Attribution text to use instead of the service credit.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``url`` is not a public http(s) VectorTileServer URL,
            carries credentials or a token, or the metadata cannot be read or
            describes a style the app cannot draw.
    """
    if not isinstance(url, str) or not url.strip().lower().startswith(("https://", "http://")):
        raise ValueError("url must be an http(s) ArcGIS VectorTileServer URL")
    if "token=" in unquote(url).lower():
        raise ValueError("url must not carry a token: it would be saved into the project")
    input_url = url.strip()
    service_url = input_url.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    _assert_no_url_userinfo(service_url)
    if not re.search(r"/VectorTileServer$", service_url, re.IGNORECASE):
        raise ValueError("url must end in /VectorTileServer")
    resolved_bounds = _resolve_bounds(bounds)
    if attribution is not None and not isinstance(attribution, str):
        raise ValueError("attribution must be a string")
    info = _read_public_arcgis_json(f"{service_url}?f=json", "ArcGIS vector tile service metadata")
    if isinstance(info, dict) and isinstance(info.get("error"), dict):
        raise ValueError("ArcGIS vector tile service returned an error")
    endpoint = style_endpoint(info)
    style = _read_public_arcgis_json(
        f"{service_url}/{endpoint}?f=json", "ArcGIS vector tile style", _ARCGIS_STYLE_LIMIT
    )
    layer = _layer_base(
        name or layer_name_from_service_url(service_url),
        "arcgis",
        fillColor="#2563eb",
        fillOpacity=0.45,
        strokeColor="#1d4ed8",
    )
    resolved = build_arcgis_vector_tile_style(info, style, service_url, layer["id"])
    # The app fetches these templates whenever the project opens, so a remote
    # style must not aim them at loopback or private hosts.
    # Each distinct host is resolved once; the style is capped at
    # MAX_STYLE_SOURCES sources, which bounds the lookups.
    checked_hosts: set[tuple[str, str]] = set()
    for spec in resolved["sources"].values():
        for target in [*spec["tiles"], *([spec["url"]] if spec.get("url") else [])]:
            probe = re.sub(r"\{[^{}]*\}", "0", target)
            parts = urlsplit(probe)
            host_key = (parts.scheme.lower(), (parts.hostname or "").lower())
            if host_key in checked_hosts:
                continue
            checked_hosts.add(host_key)
            try:
                _assert_public_url(probe)
            except ValueError as exc:
                raise ValueError(
                    f"ArcGIS vector tile sources must point at public http(s) hosts ({exc})"
                ) from exc
    if attribution is not None:
        for source in resolved["sources"].values():
            source["attribution"] = attribution
    layer_bounds = resolved_bounds if resolved_bounds is not None else resolved["bounds"]
    source_ids = resolved["sourceIds"]
    source: dict[str, Any] = {
        "layerType": "vector-tile",
        "sourceId": source_ids[0],
        "sourceIds": source_ids,
        "type": "vector",
        "url": service_url,
        "arcgisSources": resolved["sources"],
        "arcgisLayers": resolved["layers"],
    }
    metadata: dict[str, Any] = {
        "arcgisLayerType": "vector-tile",
        "arcgisSourceType": "url",
        "externalNativeLayer": True,
        "hasAccessToken": False,
        "nativeLayerIds": resolved["nativeLayerIds"],
        "sourceId": source_ids[0],
        "sourceIds": source_ids,
        "sourceKind": "arcgis-vector-tile-url",
    }
    if layer_bounds is not None:
        source["bounds"] = layer_bounds
        metadata["bounds"] = layer_bounds
    layer["source"] = source
    layer["metadata"] = metadata
    layer["sourcePath"] = service_url
    return layer
