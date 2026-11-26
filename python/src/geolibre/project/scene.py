"""3D layer builders: 3D Tiles, I3S, LiDAR point clouds and annotations, Cesium
ion, CZML and KML."""

from __future__ import annotations

import base64
import math
import re
import zlib
from typing import Any
from urllib.parse import urlsplit

from .layers import _layer_base


def three_d_tiles_layer(
    name: str,
    url: str | None = None,
    *,
    ion_asset_id: int | None = None,
    altitude_offset: float = 0,
    request_headers: dict[str, str] | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a 3D Tiles layer from a ``tileset.json`` URL or a Cesium Ion asset.

    A URL layer matches what ``restoreThreeDTilesLayers`` replays from a saved
    project, so the deck.gl 3D-tiles overlay is rebuilt on load. An ArcGIS I3S
    scene layer URL (``.../SceneServer/layers/<n>``) is filed as a scene layer,
    the way the app's 3D Tiles panel files it, so it draws on the 2D map and the
    globe. An Ion asset (``ion_asset_id``) renders only on the 3D globe, which
    loads it with the app's Cesium Ion token; the token itself is never written
    to the project.

    Args:
        name: Layer display name.
        url: URL of the 3D Tiles ``tileset.json``, or of an ArcGIS I3S scene
            layer (``.../SceneServer/layers/<n>``). Omit for an Ion asset.
        ion_asset_id: A Cesium Ion asset id (for example 96188, Cesium OSM
            Buildings). Mutually exclusive with ``url``.
        altitude_offset: Vertical offset applied to the tileset, in meters.
        request_headers: Optional request headers (e.g. an auth token). Stored in
            the project file, so avoid persisting secrets you do not want saved.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If neither or both of ``url`` and ``ion_asset_id`` are given,
            the asset id is not a positive integer, or ``request_headers`` are
            combined with an Ion asset (Ion requests carry the token instead).
    """
    if (url is None) == (ion_asset_id is None):
        raise ValueError("pass exactly one of url or ion_asset_id")
    if ion_asset_id is not None:
        if request_headers:
            raise ValueError("request_headers do not apply to a Cesium Ion asset")
        return cesium_ion_layer(
            name, ion_asset_id, kind="3d-tiles", altitude_offset=altitude_offset, **style
        )
    layer = _layer_base(name, "3d-tiles", **style)
    source_id = layer["id"]
    if is_i3s_scene_layer_url(url):
        return _i3s_scene_layer(layer, url, altitude_offset, request_headers)
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


ARCGIS_I3S_SOURCE_KIND = "arcgis-i3s"
"""``source.type`` and ``metadata.sourceKind`` of an ArcGIS I3S scene layer."""


_I3S_SCENE_SERVER_PATH_RE = re.compile(
    r"/SceneServer(/layers/\d+(/sublayers/\d+)?)?/?$", re.IGNORECASE
)


def is_i3s_scene_layer_url(url: str) -> bool:
    """Return whether a URL points at an ArcGIS I3S scene service.

    Matches the same URLs as the project migration ``withI3sSceneLayerKind``
    in ``packages/core/src/project.ts``: the path of the service or one of its
    layers. That is narrower than the 3D Tiles panel's
    ``isArcgisI3sSceneLayerUrl`` on purpose, so a ``tileset.json`` stored under
    a ``SceneServer`` folder stays a tileset.

    Args:
        url: The tileset or scene layer URL.

    Returns:
        True for a ``.../SceneServer``, ``.../SceneServer/layers/<n>`` or
        Building Scene Layer ``.../layers/<n>/sublayers/<m>`` URL. Only the
        path is matched, so a query such as ``?ref=/SceneServer/x`` does not
        count, and a URL that does not parse is not a scene layer.
    """
    try:
        path = urlsplit(url.strip()).path
    except ValueError:
        return False
    return bool(_I3S_SCENE_SERVER_PATH_RE.search(path))


def _i3s_scene_layer(
    layer: dict[str, Any],
    url: str,
    altitude_offset: float,
    request_headers: dict[str, str] | None,
) -> dict[str, Any]:
    """Turn a 3D Tiles layer base into an ArcGIS I3S scene layer record.

    The record matches ``createArcgisI3sStoreLayer`` in the app: the app draws a
    scene layer only when its source kind is ``arcgis-i3s``, through its deck.gl
    overlay on the 2D map and ``I3SDataProvider`` on the globe. Filed as a plain
    tileset, the URL is loaded as a ``tileset.json`` and nothing draws.

    Args:
        layer: The layer from ``_layer_base``.
        url: The ``.../SceneServer/layers/<n>`` URL.
        altitude_offset: Vertical offset in metres.
        request_headers: Optional request headers (used by the globe).

    Returns:
        The completed layer dict.
    """
    source_id = layer["id"]
    url = url.strip()
    source: dict[str, Any] = {
        "type": ARCGIS_I3S_SOURCE_KIND,
        "url": url,
        "sourceId": source_id,
        "altitudeOffset": altitude_offset,
    }
    if request_headers:
        source["requestHeaders"] = request_headers
    layer["source"] = source
    layer["metadata"] = {
        "customLayerType": ARCGIS_I3S_SOURCE_KIND,
        "externalDeckLayer": True,
        "externalNativeLayer": True,
        "identifiable": False,
        "nativeLayerIds": [f"{source_id}-deck"],
        "sourceId": source_id,
        "sourceKind": ARCGIS_I3S_SOURCE_KIND,
        "altitudeOffset": altitude_offset,
    }
    layer["sourcePath"] = url
    return layer


LIDAR_SOURCE_KIND = "lidar-url"
"""``metadata.sourceKind`` of a LiDAR point cloud the app streams from a URL."""


def lidar_layer(name: str, url: str, **style: Any) -> dict[str, Any]:
    """Build a LiDAR point cloud layer from a LAS, LAZ, COPC or EPT URL.

    The layer matches what the app's LiDAR control writes, so a saved project
    re-streams the point cloud when it opens (COPC and EPT by level of detail,
    LAS/LAZ as a whole download).

    Args:
        name: Layer display name.
        url: HTTP(S) URL of a ``.las``, ``.laz``, ``.copc.laz`` file or an EPT
            ``ept.json``.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``url`` is not an HTTP(S) URL.
    """
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        raise ValueError("url must be an http(s) URL of a LAS/LAZ/COPC file or an EPT ept.json")
    layer = _layer_base(name, "lidar", **style)
    source_id = layer["id"]
    layer["source"] = {"type": "lidar", "url": url, "sourceId": source_id}
    layer["metadata"] = {
        "sourceKind": LIDAR_SOURCE_KIND,
        "externalNativeLayer": True,
        "customLayerType": "lidar",
        "identifiable": False,
        "sourceId": source_id,
    }
    layer["sourcePath"] = url
    return layer


POINT_CLOUD_ANNOTATION_PLUGIN_ID = "geolibre-point-cloud-annotation"
"""Plugin id under which the app saves point cloud labels and 3D boxes."""


MAX_POINT_LABEL_NODE_BYTES = 16 * 1024 * 1024
"""Largest inflated size of one node's saved labels (mirrors the app's cap)."""


MAX_POINT_LABEL_BYTES = 256 * 1024 * 1024
"""Largest total inflated size of all saved labels in one project."""


MAX_POINT_LABEL_EDITS = 20_000_000
"""Most decoded label entries across a project; bounds Python memory, since a
dict entry costs far more than the two inflated bytes behind it."""


def decode_point_label_node(text: str, limit: int = MAX_POINT_LABEL_NODE_BYTES) -> dict[int, int]:
    """Decode one node's saved point labels.

    The app stores a node's edits as raw-DEFLATE compressed pairs of
    (delta-varint point index, class byte), base64 encoded.

    Args:
        text: The base64 string from the project.
        limit: Maximum inflated size in bytes; a larger record is rejected
            without being inflated in full (a crafted decompression bomb).

    Returns:
        Point index within the node -> ASPRS class code.

    Raises:
        ValueError: If the record is truncated, not valid DEFLATE, or
            inflates past ``limit``.
    """
    return _decode_point_label_node_sized(text, limit)[0]


def _decode_point_label_node_sized(
    text: str, limit: int, wide: bool = False
) -> tuple[dict[int, int], int]:
    """Decode one node's saved point labels and report its inflated size.

    Args:
        text: The base64 string from the project.
        limit: Maximum inflated size in bytes.
        wide: Values are varints (instance ids, up to 32 bits) rather than
            class bytes.

    Returns:
        The edits (as :func:`decode_point_label_node`) and the number of bytes
        inflated to produce them.

    Raises:
        ValueError: As :func:`decode_point_label_node`.
    """
    try:
        inflater = zlib.decompressobj(-15)
        data = inflater.decompress(base64.b64decode(text), limit + 1)
    except (ValueError, zlib.error) as error:
        raise ValueError(f"invalid point label record: {error}") from error
    if len(data) > limit or inflater.unconsumed_tail:
        raise ValueError("point label record is too large")
    edits: dict[int, int] = {}
    previous = -1
    at = 0
    while at < len(data):
        delta = 0
        shift = 0
        while True:
            if at >= len(data):
                raise ValueError("truncated point label record")
            byte = data[at]
            at += 1
            delta += (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
            # A point index needs at most five varint bytes; a longer run is
            # malformed (and would make this bigint loop quadratic).
            if shift >= 35:
                raise ValueError("invalid point label record: varint too long")
        if at >= len(data):
            raise ValueError("truncated point label record")
        index = previous + 1 + delta
        previous = index
        if not wide:
            edits[index] = data[at]
            at += 1
            continue
        value = 0
        shift = 0
        while True:
            if at >= len(data):
                raise ValueError("truncated point label record")
            # An instance id is a uint32: at most five varint bytes.
            if shift > 28:
                raise ValueError("invalid point label record: varint too long")
            byte = data[at]
            at += 1
            value += (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        if value > 0xFFFFFFFF:
            raise ValueError("invalid point label record: id out of range")
        edits[index] = value
    return edits, len(data)


def _decode_label_sources(
    entries: Any, limits: dict[str, int], wide: bool
) -> dict[str, dict[str, dict[int, int]]]:
    """Decode one kind of saved per-source edits (classes or instance ids).

    Args:
        entries: The saved ``[{"url", "nodes"}]`` list.
        limits: Shared ``{"budget", "entries"}`` allowances, drawn down in place.
        wide: Decode varint values (instance ids) rather than class bytes.

    Returns:
        ``{url: {node_key: {index: value}}}``.
    """
    out: dict[str, dict[str, dict[int, int]]] = {}
    for source in entries if isinstance(entries, list) else []:
        if not isinstance(source, dict):
            continue
        url = source.get("url")
        nodes = source.get("nodes") or {}
        if not isinstance(url, str) or not isinstance(nodes, dict):
            continue
        decoded: dict[str, dict[int, int]] = {}
        for key, text in nodes.items():
            if not isinstance(text, str) or limits["budget"] <= 0 or limits["entries"] <= 0:
                continue
            cap = min(MAX_POINT_LABEL_NODE_BYTES, limits["budget"])
            try:
                edits, inflated = _decode_point_label_node_sized(text, cap, wide)
            except ValueError:
                # A rejected node may have inflated up to its cap before
                # failing, so charge the cap: bad nodes cannot bypass the budget.
                limits["budget"] -= cap
                continue
            # Charge what was actually inflated (varints run to five bytes).
            limits["budget"] -= inflated
            if len(edits) > limits["entries"]:
                continue
            limits["entries"] -= len(edits)
            decoded[key] = edits
        # Merge repeated entries for one URL rather than dropping the first.
        out.setdefault(url, {}).update(decoded)
    return out


def point_cloud_annotations(project: dict[str, Any]) -> dict[str, Any]:
    """Read the point labels and 3D boxes the annotator saved in a project.

    Labels are keyed by each point's stable identity: the source node key (a
    COPC/EPT octree key such as ``"2-1-0-1"``, or ``"file"`` for a LAS/LAZ
    loaded whole) and the point's index within that node.

    Args:
        project: A project dict (e.g. ``Map.project`` or a loaded file).

    Returns:
        ``{"labels": {url: {node_key: {index: class}}}, "instances": {url:
        {node_key: {index: instance_id}}}, "boxes": [...], "vectors": [...],
        "classes": [...]}``. ``vectors`` are the 3D polylines, polygons and
        keypoints (see :func:`_point_cloud_vectors`).
        ``classes`` is the project's custom class schema (see
        :func:`point_cloud_class_schema`), and each box is ``{"url", "id",
        "class_code", "center", "size", "yaw", "status", "attributes"}``:
        ``center`` is ``[lng, lat, elevation_m]``, ``size`` ``[length, width,
        height]`` in metres, ``yaw`` radians counter-clockwise from east,
        ``status`` one of ``"new"``, ``"reviewed"`` or ``"flagged"``, and
        ``attributes`` the box's free-form string name/value pairs.
    """
    plugins = project.get("plugins") if isinstance(project, dict) else None
    settings = plugins.get("settings") if isinstance(plugins, dict) else None
    state = settings.get(POINT_CLOUD_ANNOTATION_PLUGIN_ID) if isinstance(settings, dict) else None
    if not isinstance(state, dict):
        state = {}
    limits = {"budget": MAX_POINT_LABEL_BYTES, "entries": MAX_POINT_LABEL_EDITS}
    labels = _decode_label_sources(state.get("sources"), limits, wide=False)
    instances = _decode_label_sources(state.get("instances"), limits, wide=True)
    boxes: list[dict[str, Any]] = []
    cuboids = state.get("cuboids") if isinstance(state, dict) else None
    for entry in cuboids if isinstance(cuboids, list) else []:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not isinstance(url, str):
            continue
        entry_boxes = entry.get("boxes")
        for box in entry_boxes if isinstance(entry_boxes, list) else []:
            if not isinstance(box, dict):
                continue
            boxes.append(
                {
                    "url": url,
                    "id": box.get("id"),
                    "class_code": box.get("classCode"),
                    "center": box.get("center"),
                    "size": box.get("size"),
                    "yaw": box.get("yaw"),
                    "status": _box_status(box.get("status")),
                    "attributes": _box_attributes(box.get("attributes")),
                }
            )
    classes = point_cloud_class_schema(state.get("customClasses"), strict=False)
    vectors = _point_cloud_vectors(state.get("vectors"))
    return {
        "labels": labels,
        "instances": instances,
        "boxes": boxes,
        "vectors": vectors,
        "classes": classes,
    }


_VECTOR_KINDS = {"polyline": 2, "polygon": 3, "keypoint": 1}


_MAX_VECTOR_VERTICES = 10_000


def _point_cloud_vectors(entries: Any) -> list[dict[str, Any]]:
    """Read the annotator's saved 3D vectors, skipping malformed ones.

    Args:
        entries: The saved ``[{"url", "items"}]`` list.

    Returns:
        ``[{"url", "id", "kind", "class_code", "points"}]`` with ``kind`` one of
        ``"polyline"``, ``"polygon"`` or ``"keypoint"`` and ``points`` a list
        of ``[lng, lat, elevation_m]``.
    """

    def is_vertex(value: Any) -> bool:
        return (
            isinstance(value, list)
            and len(value) == 3
            and all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                for v in value
            )
        )

    out: list[dict[str, Any]] = []
    for entry in entries if isinstance(entries, list) else []:
        url = entry.get("url") if isinstance(entry, dict) else None
        items = entry.get("items") if isinstance(entry, dict) else None
        if not isinstance(url, str) or not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            kind = item.get("kind")
            points = item.get("points")
            if kind not in _VECTOR_KINDS or not isinstance(points, list):
                continue
            if not _VECTOR_KINDS[kind] <= len(points) <= _MAX_VECTOR_VERTICES:
                continue
            if not all(is_vertex(point) for point in points):
                continue
            out.append(
                {
                    "url": url,
                    "id": item.get("id"),
                    "kind": kind,
                    "class_code": item.get("classCode"),
                    "points": [
                        list(point) for point in points[: 1 if kind == "keypoint" else None]
                    ],
                }
            )
    return out


_BOX_STATUSES = ("new", "reviewed", "flagged")


_MAX_BOX_ATTRIBUTES = 32


def _box_status(value: Any) -> str:
    """Return a saved box status, or ``"new"`` for a missing or unknown one.

    Args:
        value: The saved ``status`` field.

    Returns:
        One of ``"new"``, ``"reviewed"`` or ``"flagged"``.
    """
    return value if value in _BOX_STATUSES else "new"


def _box_attributes(value: Any) -> dict[str, str]:
    """Return a saved box's string attributes, dropping anything else.

    Args:
        value: The saved ``attributes`` field.

    Returns:
        Up to 32 name/value pairs with string keys and values, as the app caps them.
    """
    if not isinstance(value, dict):
        return {}
    out: dict[str, str] = {}
    for key, item in value.items():
        if len(out) >= _MAX_BOX_ATTRIBUTES:
            break
        if isinstance(key, str) and key.strip() and isinstance(item, str):
            out[_clip_utf16(key.strip(), 64)] = _clip_utf16(item, 256)
    return out


def _clip_utf16(text: str, length: int) -> str:
    """Cut text to at most ``length`` UTF-16 code units, as the app does.

    JavaScript measures strings in UTF-16 code units, so an emoji counts as
    two; a pair that would be split is dropped whole, matching the app.

    Args:
        text: The text.
        length: Maximum UTF-16 code units.

    Returns:
        The prefix.
    """
    encoded = text.encode("utf-16-le", "surrogatepass")
    if len(encoded) <= 2 * length:
        return text
    cut = encoded[: 2 * length].decode("utf-16-le", "surrogatepass")
    # Drop only a high surrogate left dangling by the cut; interior unpaired
    # surrogates (valid in JSON) stay, as they do in the app.
    return cut[:-1] if "\ud800" <= cut[-1] <= "\udbff" else cut


CUSTOM_CLASS_MIN = 19
"""Lowest code a custom class may use (ASPRS reserves 19-63, 64-255 are user)."""


CUSTOM_CLASS_MAX = 255
"""Highest code a custom class may use (the LAS classification byte)."""


def _hex_color(value: Any) -> str | None:
    """Normalize ``#rrggbb`` text or an ``(r, g, b)`` triple to ``#rrggbb``.

    Args:
        value: The colour.

    Returns:
        Lower-case ``#rrggbb``, or None when malformed.
    """
    if isinstance(value, str):
        text = value.strip()
        # Strict, like the app's parseHexColor: int(..., 16) would also take a
        # sign or "_" separators, which the app then rejects on load.
        return text.lower() if re.fullmatch(r"#[0-9a-fA-F]{6}", text) else None
    if (
        isinstance(value, (list, tuple))
        and len(value) == 3
        and all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 255 for v in value)
    ):
        return "#{:02x}{:02x}{:02x}".format(*value)
    return None


def point_cloud_class_schema(classes: Any, *, strict: bool = True) -> list[dict[str, Any]]:
    """Validate custom point classes for the annotator (its label schema).

    Custom classes extend the ASPRS standard classes 0-18 with user codes the
    annotator can assign, drawn in their own colour and named in the LiDAR
    legend.

    Args:
        classes: A list of ``{"code", "name", "color"}`` dicts; ``code`` an
            integer 19-255, ``name`` non-empty text (clipped to 64 UTF-16
            units, as the app does), ``color`` ``"#rrggbb"`` or ``(r, g, b)``.
        strict: Raise on an invalid entry (authoring) instead of skipping it
            (reading a saved project).

    Returns:
        The classes as ``{"code", "name", "color": "#rrggbb"}``, ascending by
        code; a repeated code keeps its last definition.

    Raises:
        ValueError: With ``strict``, for a malformed list or entry.
    """
    if classes is None:
        return []
    if not isinstance(classes, list):
        if strict:
            raise ValueError("classes must be a list of {code, name, color} objects")
        return []
    by_code: dict[int, dict[str, Any]] = {}
    for entry in classes:
        code = entry.get("code") if isinstance(entry, dict) else None
        name = entry.get("name") if isinstance(entry, dict) else None
        color = _hex_color(entry.get("color")) if isinstance(entry, dict) else None
        problem = None
        if not isinstance(code, int) or isinstance(code, bool):
            problem = "code must be an integer"
        elif not CUSTOM_CLASS_MIN <= code <= CUSTOM_CLASS_MAX:
            problem = f"code must be {CUSTOM_CLASS_MIN}-{CUSTOM_CLASS_MAX}"
        elif not isinstance(name, str) or not name.strip():
            problem = "name must be non-empty text"
        elif color is None:
            problem = "color must be #rrggbb or an (r, g, b) triple"
        if problem:
            if strict:
                raise ValueError(f"invalid custom class {entry!r}: {problem}")
            continue
        by_code[code] = {"code": code, "name": _clip_utf16(name.strip(), 64), "color": color}
    return [by_code[code] for code in sorted(by_code)]


def apply_point_labels(classification: Any, nodes: dict[str, dict[int, int]]) -> int:
    """Apply saved labels to the classification of a LAS/LAZ loaded whole.

    Labels on a whole-file source are keyed ``"file"`` with the point's index
    in file order, so they map straight onto e.g. ``laspy``'s
    ``las.classification``. COPC/EPT labels are keyed by octree node and need
    the node's point order; export those from the app as LAS/LAZ instead.

    Args:
        classification: A mutable sequence or NumPy array of class codes in
            file order (modified in place).
        nodes: One source's labels, as returned in
            ``point_cloud_annotations(project)["labels"][url]``.

    Returns:
        The number of points whose class changed.

    Raises:
        ValueError: If the labels are keyed by COPC/EPT node, or an index is
            past the end of ``classification``.
    """
    # Validate everything first, so a rejected record changes nothing.
    for key, edits in nodes.items():
        if key != "file":
            raise ValueError(
                f"labels keyed by octree node {key!r} need the COPC node order; "
                "export the annotated cloud as LAS/LAZ from the app instead"
            )
        for index in edits:
            if index < 0 or index >= len(classification):
                raise ValueError(f"label index {index} is past the {len(classification)} points")
    changed = 0
    for edits in nodes.values():
        for index, code in edits.items():
            if int(classification[index]) != code:
                classification[index] = code
                changed += 1
    return changed


CESIUM_ION_SOURCE_KIND = "cesium-ion"
"""``metadata.sourceKind`` of a layer that references a Cesium Ion asset."""


def cesium_ion_layer(
    name: str,
    asset_id: int,
    *,
    kind: str = "3d-tiles",
    altitude_offset: float = 0,
    **style: Any,
) -> dict[str, Any]:
    """Build a layer that references a Cesium Ion asset by id.

    The shape matches ``createCesiumIonLayer`` in ``@geolibre/core``: a
    ``3d-tiles`` layer for a tileset, a ``raster`` layer for imagery, both
    marked external so the 2D map leaves them alone and badges them "3D only".
    The globe loads the asset with the app's Cesium Ion token.

    Args:
        name: Layer display name.
        asset_id: The Cesium Ion asset id (a positive integer).
        kind: ``"3d-tiles"`` for a tileset or ``"imagery"`` for an imagery asset.
        altitude_offset: Vertical offset applied to a tileset, in meters.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If ``kind`` is unknown or ``asset_id`` is not a positive integer.
    """
    if kind not in ("3d-tiles", "imagery"):
        raise ValueError(f"kind must be '3d-tiles' or 'imagery', got {kind!r}")
    if isinstance(asset_id, bool) or not isinstance(asset_id, int) or asset_id <= 0:
        raise ValueError(f"asset_id must be a positive integer, got {asset_id!r}")
    tileset = kind == "3d-tiles"
    layer = _layer_base(name, "3d-tiles" if tileset else "raster", **style)
    source_id = layer["id"]
    source: dict[str, Any] = {
        "type": "3d-tiles" if tileset else "raster",
        "ionAssetId": asset_id,
        "sourceId": source_id,
    }
    metadata: dict[str, Any] = {
        "sourceKind": CESIUM_ION_SOURCE_KIND,
        "externalNativeLayer": True,
        "identifiable": False,
        "sourceId": source_id,
        "nativeLayerIds": [source_id],
    }
    if tileset:
        source["altitudeOffset"] = altitude_offset
        metadata["customLayerType"] = "3d-tiles"
        metadata["altitudeOffset"] = altitude_offset
    layer["source"] = source
    layer["metadata"] = metadata
    return layer


CZML_SOURCE_KIND = "czml"
"""``metadata.sourceKind`` of a layer that references a CZML dynamic scene."""


def czml_layer(
    name: str,
    *,
    url: str | None = None,
    data: list[dict[str, Any]] | dict[str, Any] | None = None,
    source_path: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a layer that loads a CZML (Cesium Language) dynamic 3D scene.

    The shape matches ``createCzmlLayer`` in ``@geolibre/core``: a
    ``3d-tiles`` layer marked external so the 2D map leaves it alone and badges
    it "3D only". The globe renders dynamic orbits, vehicle paths, and time-varying
    scenes from CZML packets with clock synchronization.

    Args:
        name: Layer display name.
        url: URL endpoint serving the CZML document.
        data: Inline parsed CZML document (packets array or packet object).
        source_path: Optional local file path when loaded from disk.
        **style: Style overrides merged into the default layer style.

    Returns:
        A layer dict for the project's ``layers`` array.

    Raises:
        ValueError: If neither ``url`` nor a non-empty ``data`` is provided.
    """
    if not url and not data:
        raise ValueError("Either url or non-empty data must be provided for a CZML layer")
    layer = _layer_base(name, "3d-tiles", **style)
    source_id = layer["id"]
    source: dict[str, Any] = {
        "type": "3d-tiles",
        "sourceId": source_id,
    }
    if url:
        source["url"] = url
    if data:
        source["czmlData"] = data
    if source_path:
        source["sourcePath"] = source_path
        layer["sourcePath"] = source_path

    metadata: dict[str, Any] = {
        "sourceKind": CZML_SOURCE_KIND,
        "externalNativeLayer": True,
        # Cesium builds real entities from the document and the globe's layer
        # sync answers for them, so a click can read a packet's name and custom
        # properties. Mirrors ``createCzmlLayer`` in ``@geolibre/core``.
        "identifiable": True,
        "sourceId": source_id,
        "nativeLayerIds": [source_id],
    }
    layer["source"] = source
    layer["metadata"] = metadata
    return layer


def cesium_kml_layer(
    name: str,
    *,
    url: str | None = None,
    data: str | None = None,
    source_path: str | None = None,
    **style: Any,
) -> dict[str, Any]:
    """Build a native globe KML/KMZ layer preserving document styling.

    Supply a URL, inline KML XML, or a KMZ data URL. Package local resources
    inside KMZ archives so they remain available when sharing the project.
    """
    url = url.strip() if url else None
    data = data.strip() if data else None
    if not url and not data:
        raise ValueError("Provide a KML/KMZ document or URL.")
    layer = _layer_base(name, "3d-tiles", **style)
    layer["source"] = {
        "type": "3d-tiles",
        "sourceId": layer["id"],
        **({"kmlData": data} if data else {"url": url}),
    }
    if source_path:
        layer["sourcePath"] = source_path
    layer["metadata"] = {
        "sourceKind": "cesium-kml",
        "externalNativeLayer": True,
        "identifiable": False,
    }
    return layer
