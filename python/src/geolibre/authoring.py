"""Widget-free operations on whole GeoLibre project dicts.

``project.py`` *builds* pieces (a layer, a plugin-state blob). This module
*applies* them to a project: adding and restyling layers, moving the camera,
composing the map controls, and reading a project back as a summary.

Everything here is pure Python on plain dicts, with no widget, no browser, and
no network. :class:`geolibre.Map` delegates to these functions so the Jupyter
widget and the MCP server (:mod:`geolibre.mcp`) share one implementation rather
than growing two copies of the same composition rules.
"""

from __future__ import annotations

import copy
import json
import math
import os
import stat
import tempfile
from pathlib import Path
from typing import Any, Callable, Iterable

from . import project as _project
from .basemaps import BASEMAPS, resolve_basemap
from .color_ramp import VECTOR_COLOR_RAMPS, graduated_stops
from .legends import get_builtin_legend

# Control placement/orientation vocabularies, shared with Map so the widget and
# the MCP server reject the same values.
CONTROL_POSITIONS = _project.CONTROL_POSITIONS
ORIENTATIONS = frozenset({"vertical", "horizontal"})
LEGEND_SHAPES = frozenset({"square", "circle", "line"})

# The pseudo-id the swipe control uses for the basemap (maplibre-swipe.ts).
BASEMAP_LAYER_ID = "__basemap__"

# Layer types the app always draws through a single MapLibre raster style layer
# named `layer-<id>-raster` (see the style layer id helpers in the core layer
# sync). `mbtiles` and `pmtiles` reach the same shape only when they carry
# raster tiles, and `video` uses its own suffix, so those are resolved per
# layer in `_style_layer_ids` rather than listed here.
RASTER_STYLE_LAYER_TYPES = frozenset({"raster", "wms", "wmts", "xyz"})

# Cap a project file read from disk. A project inlines its GeoJSON, so the
# ceiling has to clear _MAX_GEOJSON_BYTES for a single layer with room for a few
# more; past that the caller is better served by a tiled source than by loading
# the whole thing into memory.
MAX_PROJECT_BYTES = 256 * 1024 * 1024


# -- file I/O -----------------------------------------------------------------


def _finite(value: Any, field: str) -> float:
    """Coerce to float, rejecting the values JSON cannot represent.

    ``json.loads`` turns an out-of-range literal like ``1e400`` into ``inf``
    without raising, and ``json.dumps`` writes it back as a bare ``Infinity``
    token, which is not valid JSON per RFC 8259 and fails the app's
    ``JSON.parse``. Every camera field a client can set goes through here so
    that never reaches the file.

    Args:
        value: The client-supplied number.
        field: The field name, for the error message.

    Returns:
        The value as a float.

    Raises:
        ValueError: If the value is not finite.
    """
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field} must be a finite number, got {number}")
    return number


def load_project(path: str | Path) -> dict[str, Any]:
    """Read a ``.geolibre.json`` file into a project dict.

    Args:
        path: Path to the project file.

    Returns:
        The parsed project dict.

    Raises:
        ValueError: If the file is missing, oversized, not JSON, or not a
            project object.
    """
    file = Path(path).expanduser()
    if not file.is_file():
        raise ValueError(f"Project file not found: {file}")
    if file.stat().st_size > MAX_PROJECT_BYTES:
        raise ValueError(f"Project file exceeds the {MAX_PROJECT_BYTES // (1024 * 1024)} MB limit")
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Project file is not valid JSON: {file} ({exc})") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Project file must contain a JSON object: {file}")
    # `layers` is the one field every operation here indexes into. Seeding it
    # keeps a hand-written or truncated project usable instead of raising a
    # KeyError from deep inside an unrelated call.
    if not isinstance(data.get("layers"), list):
        data["layers"] = []
    return data


def save_project(path: str | Path, project: dict[str, Any]) -> Path:
    """Write a project dict to disk as formatted JSON.

    Parent directories are created. The file is written with a trailing newline
    and two-space indentation so it reads and diffs like the rest of the repo's
    JSON.

    The write goes to a temporary file alongside the destination and is then
    moved into place, so an interrupted write cannot leave a half-written
    project where a complete one used to be. A project inlines its GeoJSON and
    can approach ``MAX_PROJECT_BYTES``, and the MCP server rewrites the whole
    file on every edit, so a truncating write is a real way to lose work.

    Note:
        This writes *verbatim*, credentials included. It is the lossless
        primitive the MCP server round-trips a user's own project file through,
        where stripping an API key on every small edit would quietly destroy the
        file's usefulness. :meth:`geolibre.Map.save_project` is the counterpart
        for producing a file to share: it redacts unless
        ``keep_credentials=True``. Run a project through
        :func:`geolibre.project.redact_credentials` before calling this if the
        result is going anywhere untrusted.

    Args:
        path: Destination path.
        project: The project dict to serialize, written as given.

    Returns:
        The resolved path written to.
    """
    file = Path(path).expanduser()
    file.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=file.parent, prefix=f".{file.name}.", delete=False
    )
    temporary = Path(handle.name)
    try:
        with handle:
            # allow_nan=False so an Infinity/NaN that reached the dict by some
            # other path fails loudly here rather than being written as a bare
            # token the app's JSON.parse rejects. Camera fields are already
            # checked at the setter (see _finite); this is the backstop.
            handle.write(json.dumps(project, indent=2, allow_nan=False) + "\n")
        # NamedTemporaryFile creates at 0600. Carry the destination's mode over
        # so re-saving an existing project does not quietly make it private —
        # the MCP server calls this on every edit, however small. S_IMODE drops
        # the file-type bits, keeping only the permissions.
        if file.exists():
            os.chmod(temporary, stat.S_IMODE(file.stat().st_mode))
        os.replace(temporary, file)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return file


# -- layer lookup -------------------------------------------------------------


def layers_of(project: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the project's layer list, creating it when absent."""
    layers = project.get("layers")
    if not isinstance(layers, list):
        layers = []
        project["layers"] = layers
    return layers


def find_layer(project: dict[str, Any], ref: str) -> dict[str, Any]:
    """Resolve a layer by id or by display name.

    An exact id match wins outright, so a layer whose *name* happens to equal
    another layer's *id* cannot shadow it. Name matching is tried next, exact
    first and then case-insensitively.

    Args:
        project: The project dict.
        ref: A layer id or display name.

    Returns:
        The matching layer dict (the live object, not a copy).

    Raises:
        ValueError: If nothing matches, or if a name matches several layers.
    """
    layers = [layer for layer in layers_of(project) if isinstance(layer, dict)]
    for layer in layers:
        if layer.get("id") == ref:
            return layer
    for match_name in (
        lambda layer: layer.get("name") == ref,
        lambda layer: str(layer.get("name", "")).casefold() == ref.casefold(),
    ):
        matches = [layer for layer in layers if match_name(layer)]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError(
                f"{len(matches)} layers are named {ref!r}; reference it by id instead "
                f"(ids: {', '.join(str(layer.get('id')) for layer in matches)})"
            )
    known = ", ".join(f"{layer.get('name')!r}" for layer in layers) or "none"
    raise ValueError(f"No layer matches {ref!r}. Layers in this project: {known}")


def resolve_layer_ids(project: dict[str, Any], refs: Iterable[str]) -> list[str]:
    """Resolve layer ids/names to ids, passing the basemap pseudo-id through.

    Args:
        project: The project dict.
        refs: Layer ids, layer names, or ``"__basemap__"``.

    Returns:
        The resolved layer ids, in input order.

    Raises:
        ValueError: If a reference matches no layer or several.
    """
    return [ref if ref == BASEMAP_LAYER_ID else str(find_layer(project, ref)["id"]) for ref in refs]


# -- reading ------------------------------------------------------------------


def layer_summary(layer: dict[str, Any]) -> dict[str, Any]:
    """Summarize one layer for display, omitting any inlined data.

    A GeoJSON layer's ``geojson`` blob can be tens of megabytes, so it is
    reported as a feature count rather than echoed back. The source URL is
    reported with its credentials stripped: a summary exists to be shown, and
    both callers show it somewhere untrusted (a notebook cell that gets
    committed, an MCP tool result that goes to a model client).

    Args:
        layer: A layer dict.

    Returns:
        A small dict of the layer's identity, visibility, and source.
    """
    summary: dict[str, Any] = {
        "id": layer.get("id"),
        "name": layer.get("name"),
        "type": layer.get("type"),
        "visible": bool(layer.get("visible", True)),
        "opacity": layer.get("opacity", 1),
    }
    source = layer.get("source")
    if isinstance(source, dict):
        url = source.get("url") or (source.get("tiles") or [None])[0]
        if url:
            summary["source"] = _project.redact_url(str(url))
    geojson = layer.get("geojson")
    if isinstance(geojson, dict):
        features = geojson.get("features")
        summary["featureCount"] = len(features) if isinstance(features, list) else 0
    style = layer.get("style")
    if isinstance(style, dict) and style.get("vectorStyleMode") not in (None, "single"):
        summary["symbology"] = {
            "mode": style.get("vectorStyleMode"),
            "property": style.get("vectorStyleProperty"),
            "colorRamp": style.get("vectorStyleColorRamp"),
        }
    return summary


def describe_project(project: dict[str, Any]) -> dict[str, Any]:
    """Summarize a project: its camera, basemap, layers, and map controls.

    URLs come back with their credentials stripped, as in :func:`layer_summary`;
    several basemap providers put an API key in the style URL itself.

    Args:
        project: The project dict.

    Returns:
        A compact, JSON-serializable overview.
    """
    plugins = project.get("plugins")
    controls: list[str] = []
    if isinstance(plugins, dict):
        settings = plugins.get("settings")
        active = plugins.get("activePluginIds")
        active_ids = set(active) if isinstance(active, list) else set()
        if isinstance(settings, dict):
            # Swipe renders only while its plugin is active, so a settings blob
            # left behind by a deactivated control is not a live control. The
            # legend and colorbar are drawn by the components plugin from their
            # settings alone, so they are read from settings only.
            if _project.SWIPE_PLUGIN_ID in settings and _project.SWIPE_PLUGIN_ID in active_ids:
                controls.append("swipe")
            components = settings.get(_project.COMPONENTS_PLUGIN_ID)
            if isinstance(components, dict):
                controls.extend(key for key in ("legend", "colorbar") if key in components)
    basemap_url = project.get("basemapStyleUrl")
    return {
        "name": project.get("name"),
        "version": project.get("version"),
        "mapView": project.get("mapView"),
        "basemapStyleUrl": (
            _project.redact_url(str(basemap_url)) if basemap_url is not None else basemap_url
        ),
        "layerCount": len(layers_of(project)),
        "layers": [layer_summary(layer) for layer in layers_of(project) if isinstance(layer, dict)],
        "mapControls": controls,
    }


def layer_properties(layer: dict[str, Any]) -> dict[str, list[Any]]:
    """Collect the distinct property values of an inlined GeoJSON layer.

    Lets a caller discover what a layer can be styled or filtered by without
    reading the whole feature collection back.

    Args:
        layer: A layer dict carrying an inlined ``geojson`` FeatureCollection.

    Returns:
        A mapping of property name to up to 25 sample values (in first-seen
        order).

    Raises:
        ValueError: If the layer carries no inlined GeoJSON.
    """
    geojson = layer.get("geojson")
    if not isinstance(geojson, dict):
        raise ValueError(
            f"Layer {layer.get('name')!r} has no inlined GeoJSON, so its properties "
            "cannot be read without fetching the source."
        )
    samples: dict[str, list[Any]] = {}
    for feature in geojson.get("features", []):
        if not isinstance(feature, dict):
            continue
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            continue
        for key, value in properties.items():
            seen = samples.setdefault(key, [])
            if len(seen) < 25 and value not in seen:
                seen.append(value)
    return samples


def column_values(layer: dict[str, Any], column: str) -> list[Any]:
    """Read one property's values across an inlined GeoJSON layer's features.

    Args:
        layer: A layer dict carrying an inlined ``geojson`` FeatureCollection.
        column: The feature property name.

    Returns:
        The raw values, one per feature (``None`` where the property is absent).

    Raises:
        ValueError: If the layer has no inlined GeoJSON, or the property is
            absent from every feature, or present but null in all of them.
    """
    geojson = layer.get("geojson")
    if not isinstance(geojson, dict):
        raise ValueError(
            f"Layer {layer.get('name')!r} has no inlined GeoJSON, so column "
            f"{column!r} cannot be read."
        )
    values = []
    present = False
    for feature in geojson.get("features", []):
        if not isinstance(feature, dict):
            continue
        # GeoJSON permits `"properties": null`, so this cannot assume a dict.
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            values.append(None)
            continue
        present = present or column in properties
        values.append(properties.get(column))
    if all(value is None for value in values):
        # A column that exists but is null everywhere is a different problem
        # from a misspelled one, and only one of the two is worth retrying with
        # a different name.
        if present:
            raise ValueError(f"Column {column!r} is null in every feature")
        raise ValueError(f"Column {column!r} not found in any feature's properties")
    return values


# -- layer mutation -----------------------------------------------------------


def _reject_reserved_name(name: Any) -> None:
    """Refuse the basemap pseudo-id as a layer's display name.

    :func:`resolve_layer_ids` passes this sentinel straight through before it
    consults the layer list, so a layer wearing it would be unaddressable by
    name there — the swipe control would silently target the basemap instead of
    the layer. Enforced at creation as well as on rename, since a layer can
    acquire the name either way.

    Raises:
        ValueError: If *name* is the reserved pseudo-id.
    """
    if name is not None and str(name) == BASEMAP_LAYER_ID:
        raise ValueError(
            f"{BASEMAP_LAYER_ID!r} is reserved for the basemap and cannot name a layer"
        )


def add_layer(project: dict[str, Any], layer: dict[str, Any], *, index: int | None = None) -> str:
    """Insert a built layer into the project's draw order.

    Args:
        project: The project dict (mutated in place).
        layer: A layer dict from one of the ``project.py`` builders.
        index: Draw-order position; appended (drawn on top) when omitted.

    Returns:
        The layer's id.

    Raises:
        ValueError: If the layer's name is the reserved basemap pseudo-id.
    """
    _reject_reserved_name(layer.get("name"))
    layers = layers_of(project)
    if index is None:
        layers.append(layer)
    else:
        layers.insert(max(0, min(len(layers), int(index))), layer)
    return str(layer["id"])


def remove_layer(project: dict[str, Any], ref: str) -> str:
    """Remove a layer by id or name.

    Any swipe control referencing the layer drops it from its side, so the
    saved project cannot carry a split pointing at a layer that is gone.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.

    Returns:
        The removed layer's id.

    Raises:
        ValueError: If the reference does not resolve to exactly one layer.
    """
    layer = find_layer(project, ref)
    layers_of(project).remove(layer)
    layer_id = str(layer["id"])
    _drop_swipe_reference(project, layer)
    return layer_id


def _drop_swipe_reference(project: dict[str, Any], layer: dict[str, Any]) -> None:
    """Remove a layer's ids from the swipe control's two sides.

    Mirrors `_expand_swipe_side`: whatever that adds to a side, this takes back
    out, so removing a layer cannot leave a derived style layer id behind.
    """
    plugins = project.get("plugins")
    settings = plugins.get("settings") if isinstance(plugins, dict) else None
    swipe = settings.get(_project.SWIPE_PLUGIN_ID) if isinstance(settings, dict) else None
    if not isinstance(swipe, dict):
        return
    dropped = {str(layer.get("id", "")), *_style_layer_ids(layer)}
    for side in ("leftLayers", "rightLayers"):
        ids = swipe.get(side)
        if isinstance(ids, list):
            swipe[side] = [value for value in ids if value not in dropped]


def update_layer(
    project: dict[str, Any],
    ref: str,
    *,
    name: str | None = None,
    visible: bool | None = None,
    opacity: float | None = None,
    index: int | None = None,
) -> dict[str, Any]:
    """Change a layer's identity, visibility, or draw order.

    Only the arguments you pass are applied; the rest are left alone.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.
        name: New display name.
        visible: New visibility.
        opacity: New opacity, clamped to ``[0, 1]``.
        index: New draw-order position, clamped to the layer list's bounds.

    Returns:
        A summary of the updated layer.

    Raises:
        ValueError: If the reference does not resolve to exactly one layer, or
            ``name`` is the reserved basemap pseudo-id.
    """
    layer = find_layer(project, ref)
    if name is not None:
        _reject_reserved_name(name)
        layer["name"] = str(name)
    if visible is not None:
        layer["visible"] = bool(visible)
    if opacity is not None:
        layer["opacity"] = min(1.0, max(0.0, float(opacity)))
    if index is not None:
        layers = layers_of(project)
        layers.remove(layer)
        layers.insert(max(0, min(len(layers), int(index))), layer)
    return layer_summary(layer)


def apply_style(project: dict[str, Any], ref: str, style: dict[str, Any]) -> dict[str, Any]:
    """Merge style overrides into a layer's existing style.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.
        style: Style keys to set (e.g. ``{"fillColor": "#ff0000"}``). Keys not
            mentioned keep their current values.

    Returns:
        The layer's full style after the merge.

    Raises:
        ValueError: If the reference does not resolve to exactly one layer, or
            ``style`` is not a mapping.
    """
    if not isinstance(style, dict):
        raise ValueError(f"style must be an object of style keys, got {type(style).__name__}")
    layer = find_layer(project, ref)
    current = layer.get("style")
    merged = (
        dict(current) if isinstance(current, dict) else copy.deepcopy(_project.DEFAULT_LAYER_STYLE)
    )
    merged.update(style)
    layer["style"] = merged
    return merged


def build_choropleth_style(
    values: list[Any],
    column: str,
    *,
    class_count: int = 5,
    colormap: str = "viridis",
    scheme: str = "equal-interval",
) -> dict[str, Any]:
    """Build the ``vectorStyle*`` keys for a graduated (choropleth) symbology.

    Mirrors what the app's Style panel writes for a graduated fill, so a
    classification computed here renders the same as one built in the UI.

    Args:
        values: The column's raw values across the features.
        column: The feature property being classified.
        class_count: Number of classes (clamped to 2-12 by the stop builder).
        colormap: A ramp name from :data:`geolibre.color_ramp.VECTOR_COLOR_RAMPS`.
        scheme: ``"equal-interval"`` or ``"quantile"``.

    Returns:
        A style fragment to merge into a layer's style.

    Raises:
        ValueError: If no value is numeric, or ``scheme`` is unsupported.
    """
    if not any(_is_finite_number(value) for value in values):
        raise ValueError(
            f"Column {column!r} must contain at least one numeric value for a graduated choropleth"
        )
    stops = graduated_stops(
        values,
        class_count=class_count,
        color_ramp=colormap,
        classification_scheme=scheme,
    )
    return {
        "vectorStyleMode": "graduated",
        "vectorStyleProperty": column,
        "vectorStyleClassCount": min(12, max(2, int(class_count))),
        "vectorStyleColorRamp": colormap,
        "vectorStyleClassificationScheme": scheme,
        "vectorStyleStops": stops,
    }


def _is_finite_number(value: Any) -> bool:
    """Return True when *value* coerces to a finite float (mirrors isFinite)."""
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def classify_layer(
    project: dict[str, Any],
    ref: str,
    column: str,
    *,
    class_count: int = 5,
    colormap: str = "viridis",
    scheme: str = "equal-interval",
) -> dict[str, Any]:
    """Symbolize an inlined GeoJSON layer as a choropleth on one column.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.
        column: The numeric feature property to classify.
        class_count: Number of classes.
        colormap: A ramp name.
        scheme: ``"equal-interval"`` or ``"quantile"``.

    Returns:
        The computed ``vectorStyle*`` fragment.

    Raises:
        ValueError: If the layer has no inlined GeoJSON, the column is missing
            or non-numeric, or ``scheme`` is unsupported.
    """
    layer = find_layer(project, ref)
    values = column_values(layer, column)
    fragment = build_choropleth_style(
        values,
        column,
        class_count=class_count,
        colormap=colormap,
        scheme=scheme,
    )
    apply_style(project, str(layer["id"]), fragment)
    return fragment


# -- camera and basemap -------------------------------------------------------


def set_view(
    project: dict[str, Any],
    *,
    center: Iterable[float] | None = None,
    zoom: float | None = None,
    bearing: float | None = None,
    pitch: float | None = None,
) -> dict[str, Any]:
    """Set the saved camera the project opens at.

    Args:
        project: The project dict (mutated in place).
        center: ``[lng, lat]``.
        zoom: Zoom level, clamped to ``[0, 24]``.
        bearing: Rotation in degrees.
        pitch: Tilt in degrees, clamped to ``[0, 85]``.

    Note:
        Setting ``center`` or ``zoom`` clears any ``bbox`` a previous
        :func:`fit_bounds` recorded, since it no longer describes the camera.

    Returns:
        The project's ``mapView`` after the change.

    Raises:
        ValueError: If ``center`` is not a 2-element ``[lng, lat]``, or any
            value is not finite.
    """
    view = project.get("mapView")
    if not isinstance(view, dict):
        view = _project.default_map_view()
        project["mapView"] = view
    if center is not None:
        coords = [float(value) for value in center]
        if len(coords) != 2 or not all(math.isfinite(value) for value in coords):
            raise ValueError("center must be a [lng, lat] sequence of exactly 2 finite numbers")
        view["center"] = coords
    if zoom is not None:
        view["zoom"] = min(24.0, max(0.0, _finite(zoom, "zoom")))
    if center is not None or zoom is not None:
        # `bbox` is recorded by fit_bounds to describe the camera it computed.
        # Moving the camera by hand leaves it describing a different extent, and
        # the app reads it (the status bar's BBox readout), so drop it rather
        # than persist a stale one. Bearing and pitch do not change the extent.
        view.pop("bbox", None)
    if bearing is not None:
        view["bearing"] = _finite(bearing, "bearing")
    if pitch is not None:
        view["pitch"] = min(85.0, max(0.0, _finite(pitch, "pitch")))
    return view


# The viewport the bbox fit assumes. The app sizes the map to its container, so
# the true value is only known at runtime; this is a typical desktop map pane and
# keeps the computed zoom within about half a level of what the app settles on.
_FIT_VIEWPORT = (1024, 768)
_FIT_PADDING_PX = 40
_TILE_SIZE = 512


def fit_bounds(
    project: dict[str, Any],
    bbox: Iterable[float],
    *,
    padding: int = _FIT_PADDING_PX,
) -> dict[str, Any]:
    """Frame a bounding box by computing a center and zoom for it.

    The saved project records a center/zoom, not a bbox to fit: the app applies
    ``mapView.center``/``zoom`` verbatim when it opens a project and never fits
    the stored ``bbox``. So this resolves the box to a camera here, using an
    assumed viewport (see ``_FIT_VIEWPORT``), and records the box alongside it
    for reference. The result is approximate by construction; expect the app's
    own "zoom to layer" to land within roughly half a zoom level.

    Args:
        project: The project dict (mutated in place).
        bbox: ``[min_lng, min_lat, max_lng, max_lat]``. Per RFC 7946 section
            5.2, ``min_lng > max_lng`` means the box crosses the antimeridian
            (Fiji is ``[170, -20, -170, -10]``) and is framed as such.
        padding: Pixels of margin to leave around the box.

    Returns:
        The project's ``mapView`` after the change.

    Raises:
        ValueError: If the box is not 4 finite numbers, has its latitudes
            inverted, or falls outside the Web Mercator latitude limits.
    """
    box = [float(value) for value in bbox]
    if len(box) != 4:
        raise ValueError("bbox must be [min_lng, min_lat, max_lng, max_lat]")
    if not all(math.isfinite(value) for value in box):
        raise ValueError(f"bbox must be finite numbers, got {box}")
    min_lng, min_lat, max_lng, max_lat = box
    if min_lat > max_lat:
        raise ValueError(f"bbox is inverted: {box}")
    if not (-85.051129 <= min_lat and max_lat <= 85.051129):
        raise ValueError(f"bbox latitudes must lie within +/-85.051129 (Web Mercator), got {box}")
    # RFC 7946 section 5.2: a box crossing the antimeridian is written with
    # min_lng > max_lng, so Fiji is [170, -20, -170, -10] rather than an error.
    # Its longitude span wraps through 180, and the center follows it out past
    # the meridian and back into [-180, 180].
    lng_span = (max_lng - min_lng) % 360 if min_lng > max_lng else max_lng - min_lng
    center_lng = min_lng + lng_span / 2
    if center_lng > 180:
        center_lng -= 360

    width, height = _FIT_VIEWPORT
    usable_width = max(1, width - 2 * padding)
    usable_height = max(1, height - 2 * padding)
    # Web Mercator world fractions spanned by the box, at zoom 0.
    lng_fraction = lng_span / 360
    lat_fraction = abs(_mercator_y(max_lat) - _mercator_y(min_lat))
    # A degenerate (point) box has no extent to fit; fall back to a close-in
    # zoom rather than dividing by zero.
    zoom_candidates = [
        math.log2(usable / (_TILE_SIZE * fraction))
        for usable, fraction in ((usable_width, lng_fraction), (usable_height, lat_fraction))
        if fraction > 0
    ]
    zoom = min(zoom_candidates) if zoom_candidates else 14.0
    view = set_view(
        project,
        center=[
            center_lng,
            _inverse_mercator_y((_mercator_y(min_lat) + _mercator_y(max_lat)) / 2),
        ],
        zoom=zoom,
    )
    view["bbox"] = box
    return view


def _mercator_y(lat: float) -> float:
    """Project a latitude to its Web Mercator world fraction in ``[0, 1]``."""
    sin_lat = math.sin(math.radians(lat))
    return 0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)


def _inverse_mercator_y(y: float) -> float:
    """Invert :func:`_mercator_y` back to a latitude in degrees."""
    return math.degrees(2 * math.atan(math.exp((0.5 - y) * 2 * math.pi)) - math.pi / 2)


def set_basemap(project: dict[str, Any], basemap: str) -> str:
    """Set the project's background basemap style.

    Args:
        project: The project dict (mutated in place).
        basemap: A known basemap name (see :data:`geolibre.basemaps.BASEMAPS`)
            or a MapLibre style JSON URL.

    Returns:
        The resolved style URL.

    Raises:
        ValueError: If the name is unknown and the value is not a URL.
    """
    url = resolve_basemap(basemap)
    project["basemapStyleUrl"] = url
    return url


def basemap_catalog() -> dict[str, str]:
    """Return the named basemaps, mapping friendly name to style URL."""
    return dict(BASEMAPS)


def color_ramp_names() -> list[str]:
    """Return the color-ramp names accepted for choropleths and colorbars."""
    return list(VECTOR_COLOR_RAMPS)


# -- map controls -------------------------------------------------------------


def merge_components_state(
    project: dict[str, Any],
    key: str,
    entry_state_builder: Callable[[Any], dict[str, Any]],
) -> None:
    """Merge one feature's state into the Components plugin settings.

    The Components plugin (legend / colorbar / html) stores all its features
    under a single settings blob keyed by feature name, so a new legend must be
    merged in without dropping an existing colorbar (and vice versa).

    Args:
        project: The project dict (mutated in place).
        key: The feature key (``"legend"`` or ``"colorbar"``).
        entry_state_builder: Called with the feature's current state (or
            ``None``) and returns its new state.
    """
    plugins = _project.ensure_plugins_block(project)
    current = plugins["settings"].get(_project.COMPONENTS_PLUGIN_ID)
    components = dict(current) if isinstance(current, dict) else {}
    components[key] = entry_state_builder(components.get(key))
    # The legend/colorbar restore from their settings blob alone, so the plugin
    # is configured but not added to activePluginIds (activating it would also
    # mount the full Components toolbar).
    _project.set_plugin_state(project, _project.COMPONENTS_PLUGIN_ID, components, activate=False)


def add_legend(
    project: dict[str, Any],
    title: str | None = None,
    *,
    legend_dict: dict[str, str] | None = None,
    labels: list[str] | None = None,
    colors: list[str] | None = None,
    builtin: str | None = None,
    position: str = "bottom-left",
    shape: str = "square",
) -> dict[str, Any]:
    """Add a legend control to the project.

    Supply the entries exactly one of three ways: a built-in preset
    (``builtin``), a ``{label: color}`` mapping (``legend_dict``), or parallel
    ``labels`` and ``colors`` lists. Each call adds another legend.

    Args:
        project: The project dict (mutated in place).
        title: Legend title. Defaults to ``"Legend"``, or the preset's title
            when ``builtin`` is given without one.
        legend_dict: A mapping of label to CSS color (order preserved).
        labels: Item labels, paired position-wise with ``colors``.
        colors: Item CSS colors, paired position-wise with ``labels``.
        builtin: A preset name (e.g. ``"nlcd"``, ``"esa_worldcover"``).
        position: One of :data:`CONTROL_POSITIONS`.
        shape: Swatch shape for every item; one of :data:`LEGEND_SHAPES`.

    Returns:
        The legend entry that was added.

    Raises:
        ValueError: If no entries are supplied, several sources are combined,
            ``labels``/``colors`` lengths differ, or ``position``/``shape``/
            ``builtin`` is invalid.
    """
    if position not in CONTROL_POSITIONS:
        raise ValueError(f"position must be one of {sorted(CONTROL_POSITIONS)}, got {position!r}")
    if shape not in LEGEND_SHAPES:
        raise ValueError(f"shape must be one of {sorted(LEGEND_SHAPES)}, got {shape!r}")

    # The three ways to supply entries are mutually exclusive; reject a
    # combination rather than silently letting one win by check order.
    sources = (
        builtin is not None,
        legend_dict is not None,
        labels is not None or colors is not None,
    )
    if sum(sources) > 1:
        raise ValueError(
            "Provide legend entries via exactly one of: builtin=, "
            "legend_dict=, or labels= and colors=."
        )

    pairs: list[tuple[str, str]]
    if builtin is not None:
        preset = get_builtin_legend(builtin)
        pairs = list(preset["items"])
        if title is None:
            title = preset["title"]
    elif legend_dict is not None:
        pairs = [(str(label), str(color)) for label, color in legend_dict.items()]
    elif labels is not None or colors is not None:
        if labels is None or colors is None:
            raise ValueError("labels and colors must be provided together")
        if len(labels) != len(colors):
            raise ValueError(
                f"labels and colors must have the same length ({len(labels)} != {len(colors)})"
            )
        pairs = [(str(label), str(color)) for label, color in zip(labels, colors)]
    else:
        raise ValueError(
            "Provide legend entries via builtin=, legend_dict=, or labels= and colors=."
        )
    if not pairs:
        raise ValueError("Legend has no items")

    items = [{"label": label, "color": color, "shape": shape} for label, color in pairs]
    entry = _project.legend_gui_entry(title or "Legend", items, position)
    merge_components_state(
        project,
        "legend",
        lambda existing: _project.legend_gui_state(entry, existing=existing),
    )
    return entry


def add_colorbar(
    project: dict[str, Any],
    *,
    colormap: str = "viridis",
    vmin: float = 0.0,
    vmax: float = 1.0,
    label: str = "",
    units: str = "",
    colors: list[str] | None = None,
    orientation: str = "vertical",
    position: str = "bottom-right",
) -> dict[str, Any]:
    """Add a colorbar control for a continuous (single-band) raster.

    Args:
        project: The project dict (mutated in place).
        colormap: A named colormap. Ignored when ``colors`` is given.
        vmin: Value at the low end.
        vmax: Value at the high end.
        label: Title shown alongside the colorbar.
        units: Units suffix shown with the values.
        colors: Optional CSS colors defining a custom gradient.
        orientation: One of :data:`ORIENTATIONS`.
        position: One of :data:`CONTROL_POSITIONS`.

    Returns:
        The colorbar entry that was added.

    Raises:
        ValueError: If ``orientation`` or ``position`` is invalid, ``vmin`` is
            not less than ``vmax``, or ``colors`` is given but empty.
    """
    if orientation not in ORIENTATIONS:
        raise ValueError(f"orientation must be one of {sorted(ORIENTATIONS)}, got {orientation!r}")
    if position not in CONTROL_POSITIONS:
        raise ValueError(f"position must be one of {sorted(CONTROL_POSITIONS)}, got {position!r}")
    vmin_f, vmax_f = float(vmin), float(vmax)
    # The app's normalizer only fixes vmin == vmax; an inverted range would
    # otherwise render a reversed gradient, so reject it here.
    if vmin_f >= vmax_f:
        raise ValueError(f"vmin ({vmin_f}) must be less than vmax ({vmax_f})")
    if colors is not None:
        if not colors:
            raise ValueError("colors must be a non-empty list when provided")
        mode = "custom"
        custom_colors = ", ".join(str(color) for color in colors)
    else:
        mode = "named"
        custom_colors = ""
    entry = _project.colorbar_gui_entry(
        mode=mode,
        colormap=colormap,
        custom_colors=custom_colors,
        vmin=vmin_f,
        vmax=vmax_f,
        label=label,
        units=units,
        orientation=orientation,
        position=position,
    )
    merge_components_state(
        project,
        "colorbar",
        lambda existing: _project.colorbar_gui_state(entry, existing=existing),
    )
    return entry


def _style_layer_ids(layer: dict[str, Any]) -> list[str]:
    """The MapLibre style layer ids a layer is drawn as, when they are derivable.

    Only layers the app draws through a single style layer with a predictable
    id qualify. `pmtiles` vector layers are deliberately absent: their ids are
    `<sourceId>-<sourceLayer>-<kind>` (``pmtilesNativeLayerIds`` in
    pmtiles-layer.ts), which the layer dict alone cannot spell out.

    Args:
        layer: A layer dict from the project's ``layers`` array.

    Returns:
        The style layer ids, or an empty list when none are derivable.
    """
    layer_id = str(layer.get("id", ""))
    layer_type = layer.get("type")
    metadata = layer.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    source = layer.get("source")
    source = source if isinstance(source, dict) else {}
    # syncMbtilesLayer/syncRasterTileLayer in layer-sync.ts read both.
    is_raster = metadata.get("tileType") == "raster" or source.get("type") == "raster"

    if layer_type == "pmtiles":
        if not is_raster:
            return []
        # The archive's source id, which pmtiles_layer defaults to the layer id
        # but callers may override, and without the `layer-` prefix the other
        # raster paths carry.
        return [f"{metadata.get('sourceId') or layer_id}-raster"]
    if layer_type == "video":
        return [f"layer-{layer_id}-video"]
    if layer_type == "mbtiles":
        return [f"layer-{layer_id}-raster"] if is_raster else []
    if layer_type in RASTER_STYLE_LAYER_TYPES:
        return [f"layer-{layer_id}-raster"]
    return []


def _expand_swipe_side(project: dict[str, Any], layer_ids: list[str]) -> list[str]:
    """Add the derived style layer ids of every listed layer to one swipe side.

    The swipe control drives what each half shows by toggling MapLibre style
    layer ids. A layer drawn through a style layer of its own — a raster tile
    source as ``layer-<id>-raster``, a video as ``layer-<id>-video`` — leaves a
    side holding only the project layer id matching no style layer: the control
    treats the layer as assigned to neither side, which it renders on both
    halves. Listing both ids keeps the project layer id (what the panel
    checkboxes read) and adds the ids the control acts on.
    """
    layers = {
        layer.get("id"): layer for layer in project.get("layers", []) if isinstance(layer, dict)
    }
    expanded: list[str] = []
    for layer_id in layer_ids:
        if layer_id not in expanded:
            expanded.append(layer_id)
        layer = layers.get(layer_id)
        if not isinstance(layer, dict):
            continue
        for style_id in _style_layer_ids(layer):
            if style_id not in expanded:
                expanded.append(style_id)
    return expanded


def add_swipe(
    project: dict[str, Any],
    *,
    left_layers: list[str],
    right_layers: list[str],
    orientation: str = "vertical",
    position: float = 50,
    control_position: str = "top-right",
) -> dict[str, Any]:
    """Configure the split-map (swipe) control.

    Args:
        project: The project dict (mutated in place).
        left_layers: Layer ids shown on the left/top of the slider.
            ``"__basemap__"`` selects the basemap.
        right_layers: Layer ids shown on the right/bottom of the slider.
        orientation: One of :data:`ORIENTATIONS`.
        position: Initial slider position as a percentage, clamped to
            ``[0, 100]``.
        control_position: One of :data:`CONTROL_POSITIONS`.

    Returns:
        The swipe plugin state that was written.

    Raises:
        ValueError: If ``orientation`` or ``control_position`` is invalid.
    """
    if orientation not in ORIENTATIONS:
        raise ValueError(f"orientation must be one of {sorted(ORIENTATIONS)}, got {orientation!r}")
    if control_position not in CONTROL_POSITIONS:
        raise ValueError(
            f"control_position must be one of {sorted(CONTROL_POSITIONS)}, got {control_position!r}"
        )
    state = _project.swipe_state(
        left_layers=_expand_swipe_side(project, list(left_layers)),
        right_layers=_expand_swipe_side(project, list(right_layers)),
        orientation=orientation,
        position=min(100.0, max(0.0, float(position))),
    )
    _project.set_plugin_state(
        project,
        _project.SWIPE_PLUGIN_ID,
        state,
        position=control_position,
    )
    return state
