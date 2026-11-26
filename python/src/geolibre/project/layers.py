"""Core layer builders: GeoJSON, SQL query, tile, vector, vector tile, PMTiles,
video and layer groups."""

from __future__ import annotations

import copy
import math
import uuid
import warnings
from typing import Any
from urllib.parse import urlsplit

from ._constants import _PROJECT_CONSTANTS
from .fetch import load_featurecollection
from .popups import normalize_popup


def _assert_no_url_userinfo(url: str) -> None:
    """Reject embedded username/password URLs without echoing their credentials.

    Args:
        url: A source URL to persist in a layer.

    Raises:
        ValueError: If the URL embeds credentials unsupported by browser fetch.
    """
    parsed = urlsplit(url)
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL must not carry username/password credentials")


# Loaded from project-constants.json (synced with packages/core/src/project-constants.json).
DEFAULT_LAYER_STYLE: dict[str, Any] = copy.deepcopy(_PROJECT_CONSTANTS["DEFAULT_LAYER_STYLE"])


def _layer_base(name: str, layer_type: str, **style: Any) -> dict[str, Any]:
    # `popup`, `tooltip` and the `popup_*` size shorthands ride in with the
    # style overrides so every add_* builder accepts them without threading
    # four more arguments through each signature, but the popup config is a
    # top-level layer key -- left in `style` they would land somewhere the app
    # never reads.
    popup = normalize_popup(
        style.pop("popup", None),
        style.pop("tooltip", None),
        max_width=style.pop("popup_max_width", None),
        image_height=style.pop("popup_image_height", None),
    )
    # Deep-copy the defaults so nested values (e.g. the vectorStyleStops list)
    # are not shared with the module constant; a caller mutating a returned
    # layer's style must not corrupt DEFAULT_LAYER_STYLE for later layers.
    merged_style = {**copy.deepcopy(DEFAULT_LAYER_STYLE), **style}
    layer: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "name": name,
        "type": layer_type,
        "visible": True,
        "opacity": 1,
        "style": merged_style,
        "metadata": {},
    }
    if popup is not None:
        layer["popup"] = popup
    return layer


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


def sql_query_layer(name: str, data: Any, sql: str, **style: Any) -> dict[str, Any]:
    """Build a DuckDB SQL query layer with an embedded result snapshot.

    The snapshot renders immediately when the project opens. Refresh in the app
    re-executes SQL against the other project layers, using their table names.
    This builder stores the supplied result; it does not execute SQL in Python.

    Args:
        name: Layer display name.
        data: GeoJSON result, using the inputs accepted by load_featurecollection.
        sql: DuckDB SQL that produced the result. Source layers must be present
            in the project to refresh; table names follow the SQL Workspace.
        **style: Style overrides merged into the default layer style.

    Returns:
        A GeoJSON layer carrying the snapshot and a refreshable query definition.

    Raises:
        ValueError: If SQL is blank or is not a string, or GeoJSON is invalid.
    """
    if not isinstance(sql, str) or not sql.strip():
        raise ValueError("sql must be a non-empty DuckDB SQL string")
    snapshot = copy.deepcopy(load_featurecollection(data))
    for index, feature in enumerate(snapshot["features"]):
        if (
            not isinstance(feature, dict)
            or feature.get("type") != "Feature"
            or "geometry" not in feature
            or "properties" not in feature
            or (feature["geometry"] is not None and not isinstance(feature["geometry"], dict))
            or (feature["properties"] is not None and not isinstance(feature["properties"], dict))
        ):
            raise ValueError(
                f"Snapshot entry {index} must be a GeoJSON Feature with geometry and properties"
            )
    layer = _layer_base(name, "geojson", **style)
    layer["source"] = {"type": "geojson"}
    layer["geojson"] = snapshot
    # Mirror SQL_QUERY_SOURCE_KIND and sqlQueryLayerMetadata in the app. Keep
    # the snapshot independent of its input URL: refresh must run the query.
    layer["metadata"] = {"sourceKind": "sql-query", "sqlQuery": {"engine": "duckdb", "sql": sql}}
    return layer


def tile_layer(
    name: str,
    url: str,
    *,
    tile_size: int = 256,
    attribution: str | None = None,
    bounds: list[float] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a raster XYZ tile layer (e.g. an ``{z}/{x}/{y}`` template).

    Args:
        name: Layer display name.
        url: The XYZ tile URL template.
        tile_size: Tile size in pixels (typically 256).
        attribution: Optional attribution string.
        bounds: Optional ``[west, south, east, north]`` request bounds.
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
    if bounds:
        source["bounds"] = bounds
    layer["source"] = source
    layer["metadata"] = {"sourceKind": "xyz-url"}
    return layer


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
            is not four ``[lng, lat]`` pairs. Embedded URL credentials are refused.
    """
    if not urls:
        raise ValueError("video_layer requires at least one non-empty URL")
    # Validate strictly rather than silently dropping a None/non-string entry,
    # which would mask a malformed call and build a layer with fewer URLs.
    invalid = [u for u in urls if not (isinstance(u, str) and u)]
    if invalid:
        raise ValueError(f"video_layer: every URL must be a non-empty string; got {invalid!r}")
    clean_urls = list(urls)
    for url in clean_urls:
        _assert_no_url_userinfo(url)
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
        # The Add Data video form reads these back when the layer is edited.
        "sourceUrl": clean_urls[0],
        **({"fallbackSourceUrl": clean_urls[1]} if len(clean_urls) > 1 else {}),
        "bounds": [min(lngs), min(lats), max(lngs), max(lats)],
    }
    layer["sourcePath"] = clean_urls[0]
    return layer


def layer_group(
    name: str,
    *,
    parent_id: str | None = None,
    collapsed: bool = False,
    visible: bool = True,
    opacity: float = 1.0,
    group_id: str | None = None,
) -> dict[str, Any]:
    """Build one Layers panel group (``LayerGroup`` in packages/core types.ts).

    A layer joins a group through its own ``groupId``; see
    :func:`geolibre.authoring.set_layer_group`.

    Args:
        name: Group name shown in the Layers panel.
        parent_id: Id of the group this one nests in, or None for the root.
        collapsed: Start with the group collapsed in the panel.
        visible: Group visibility, ANDed with each member layer's own.
        opacity: Group opacity in [0, 1], multiplied into each member's.
        group_id: Explicit group id; a UUID by default.

    Returns:
        A group dict for the project's ``layerGroups`` array.

    Raises:
        ValueError: If a value is blank, not a bool, or out of range.
    """
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"group name must be a non-empty string, got {name!r}")
    for label, flag in (("collapsed", collapsed), ("visible", visible)):
        if not isinstance(flag, bool):
            raise ValueError(f"{label} must be true or false")
    if (
        isinstance(opacity, bool)
        or not isinstance(opacity, (int, float))
        or not math.isfinite(opacity)
        or not 0 <= opacity <= 1
    ):
        raise ValueError(f"opacity must be between 0 and 1, got {opacity!r}")
    group_id = str(group_id).strip() if group_id is not None else str(uuid.uuid4())
    if not group_id:
        raise ValueError("group_id must not be empty")
    group: dict[str, Any] = {
        "id": group_id,
        "name": name.strip(),
        "collapsed": collapsed,
        "visible": visible,
        "opacity": float(opacity),
    }
    if parent_id is not None:
        parent = str(parent_id).strip()
        if not parent or parent == group_id:
            raise ValueError("parent_id must name another group")
        group["parentId"] = parent
    return group
