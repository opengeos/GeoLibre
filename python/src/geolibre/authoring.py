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
import uuid
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
    map_legend = project.get("legend")
    if isinstance(map_legend, dict) and map_legend.get("panelVisible") is True:
        controls.append("map-legend")
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
        **({"bookmarks": bookmark_summary(project)} if project.get("bookmarks") else {}),
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


def set_popup(
    project: dict[str, Any],
    ref: str,
    fields: Any = None,
    *,
    click: bool | None = None,
    hover: bool | None = None,
    title: str | None = None,
    title_expression: str | None = None,
    body_expression: str | None = None,
    show_feature_id: bool | None = None,
    max_width: int | None = None,
    image_height: int | None = None,
    tooltip: Any = None,
    merge: bool = False,
) -> dict[str, Any]:
    """Configure what a layer shows when a feature is clicked or hovered.

    A layer with no popup config keeps the app's default: the layer name as the
    heading, then every visible property as a key/value row, and no hover
    tooltip. Configuring one narrows and formats that -- see
    :func:`geolibre.project.popup_config` for the field vocabulary.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.
        fields: The fields to show and their order; property names and/or
            :func:`geolibre.project.popup_field` mappings.
        click: ``False`` suppresses the click popup.
        hover: ``True`` shows a hover tooltip built from the ``hover`` fields.
        title: Property whose value titles the popup.
        title_expression: MapLibre expression source producing the title.
        body_expression: MapLibre expression source producing the popup body.
        show_feature_id: ``False`` drops the synthetic ``id`` row.
        max_width: Widest the click popup may draw, in CSS pixels.
        image_height: Tallest an ``"image"`` field may draw, in CSS pixels.
        tooltip: Hover shorthand -- a property name, a sequence of names,
            ``True`` to flag every configured field, or ``False`` to turn the
            tooltip off.
        merge: Merge into the layer's existing popup config instead of
            replacing it, so a tooltip can be added without restating the
            fields.

    Returns:
        The layer's popup config after the change.

    Raises:
        ValueError: If the reference does not resolve to exactly one layer, or
            the popup specification is unusable.
    """
    layer = find_layer(project, ref)
    config = _project.popup_config(
        fields,
        click=click,
        hover=hover,
        title=title,
        title_expression=title_expression,
        body_expression=body_expression,
        show_feature_id=show_feature_id,
        max_width=max_width,
        image_height=image_height,
    )
    if merge:
        current = layer.get("popup")
        if isinstance(current, dict):
            config = {**copy.deepcopy(current), **config}
    # Apply the tooltip shorthand after the merge so `merge=True` can flag a
    # field the existing config already carries rather than appending a
    # duplicate entry for it.
    config = _project.apply_tooltip(config, tooltip)
    layer["popup"] = config
    return config


def clear_popup(project: dict[str, Any], ref: str) -> dict[str, Any]:
    """Drop a layer's popup config, restoring the app's default popup.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.

    Returns:
        A summary of the updated layer.

    Raises:
        ValueError: If the reference does not resolve to exactly one layer.
    """
    layer = find_layer(project, ref)
    layer.pop("popup", None)
    return layer_summary(layer)


def set_layer_metadata(
    project: dict[str, Any],
    ref: str,
    *,
    merge: bool = False,
    **fields: Any,
) -> dict[str, Any] | None:
    """Set a layer's descriptive (catalog) metadata.

    This is what the app's layer Metadata dialog edits and exports as a STAC
    Item: title, abstract, keywords, license, attribution, contact, lineage,
    temporal extent and links. See :func:`geolibre.project.layer_metadata`.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.
        merge: Keep the layer's existing fields that ``fields`` does not name,
            instead of replacing the whole block.
        **fields: Keyword arguments of :func:`geolibre.project.layer_metadata`
            (``title``, ``abstract``, ``keywords``, ``license``,
            ``attribution``, ``contact``, ``lineage``, ``temporal_extent``,
            ``links``).

    Returns:
        The layer's metadata block after the change, or ``None`` when it ended
        up empty (and was removed).

    Raises:
        ValueError: If the reference does not resolve to exactly one layer, a
            field name is unknown, or a value fails validation.
    """
    unknown = sorted(set(fields) - set(_METADATA_FIELD_KEYS))
    if unknown:
        raise ValueError(f"unknown layer metadata field(s): {', '.join(unknown)}")
    layer = find_layer(project, ref)
    built = _project.layer_metadata(**fields) or {}
    if merge:
        current = _project.normalize_layer_metadata(layer.get("descriptiveMetadata")) or {}
        # The keys the caller named replace the stored ones -- including a key
        # passed as blank, which clears it.
        named = {_METADATA_FIELD_KEYS[name] for name in fields}
        built = {
            **{key: value for key, value in current.items() if key not in named},
            **built,
        }
    metadata = _project.normalize_layer_metadata(built)
    if metadata is None:
        layer.pop("descriptiveMetadata", None)
    else:
        layer["descriptiveMetadata"] = metadata
    return copy.deepcopy(metadata)


#: Keyword argument of :func:`set_layer_metadata` -> stored camelCase key.
_METADATA_FIELD_KEYS = {
    "title": "title",
    "abstract": "abstract",
    "keywords": "keywords",
    "license": "license",
    "attribution": "attribution",
    "contact": "contact",
    "lineage": "lineage",
    "temporal_extent": "temporalExtent",
    "links": "links",
}


def clear_layer_metadata(project: dict[str, Any], ref: str) -> dict[str, Any]:
    """Drop a layer's descriptive metadata.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.

    Returns:
        A summary of the updated layer.

    Raises:
        ValueError: If the reference does not resolve to exactly one layer.
    """
    layer = find_layer(project, ref)
    layer.pop("descriptiveMetadata", None)
    return layer_summary(layer)


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


_RENDERERS = frozenset({"maplibre", "cesium", "mapbox", "arcgis"})


def _is_renderer(value: Any) -> bool:
    """Whether ``value`` names a supported renderer (a non-string is never one)."""
    return isinstance(value, str) and value in _RENDERERS


def secondary_panes(project: dict[str, Any]) -> list[dict[str, Any]]:
    """Return ``secondaryMapViews`` validated as a list of renderable panes.

    Args:
        project: The project dict.

    Returns:
        The pane list (empty when the project has none).

    Raises:
        ValueError: If the field is not a list of pane objects carrying a
            unique string ``id`` and, when present, a ``maplibre``/``cesium``/``mapbox``/
            ``arcgis`` ``viewKind`` (an omitted ``viewKind`` means ``maplibre``), e.g.
            from a hand-edited project file.
    """
    panes = project.get("secondaryMapViews", [])
    if not isinstance(panes, list) or any(
        not isinstance(p, dict)
        or not isinstance(p.get("id"), str)
        or not _is_renderer(p.get("viewKind", "maplibre"))
        for p in panes
    ):
        raise ValueError(
            "secondaryMapViews must be a list of pane objects with an id "
            "and a maplibre, cesium, mapbox, or arcgis viewKind"
        )
    if len({p["id"] for p in panes}) != len(panes):
        raise ValueError("secondaryMapViews pane ids must be unique")
    return panes


def set_renderer(project: dict[str, Any], renderer: str, *, pane_id: str | None = None) -> str:
    """Select ``maplibre``, ``cesium``, ``mapbox``, or ``arcgis`` for the primary map or a pane."""
    if not _is_renderer(renderer):
        raise ValueError("renderer must be maplibre, cesium, mapbox, or arcgis")
    if pane_id is None:
        project["primaryRenderer"] = renderer
    else:
        pane = next((p for p in secondary_panes(project) if p["id"] == pane_id), None)
        if pane is None:
            raise ValueError(f"Unknown pane: {pane_id}")
        pane["viewKind"] = renderer
    return renderer


def set_map_layout(
    project: dict[str, Any],
    rows: int,
    cols: int,
    *,
    view_kinds: list[str] | None = None,
    sync_view: bool = True,
) -> list[dict[str, Any]]:
    """Set a 1–4 row/column grid. ``view_kinds`` lists every pane, primary first."""
    if any(isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 4 for v in (rows, cols)):
        raise ValueError("rows and cols must be integers between 1 and 4")
    count = rows * cols
    if view_kinds is not None and (
        len(view_kinds) != count or not all(_is_renderer(k) for k in view_kinds)
    ):
        raise ValueError(
            "view_kinds must contain one maplibre, cesium, mapbox, or arcgis renderer per pane"
        )
    panes = copy.deepcopy(secondary_panes(project)[: count - 1])
    while len(panes) < count - 1:
        panes.append(
            {
                "id": str(uuid.uuid4()),
                "view": copy.deepcopy(project.get("mapView", _project.default_map_view())),
                "layerVisibility": {},
            }
        )
    if view_kinds is not None:
        set_renderer(project, view_kinds[0])
        for pane, kind in zip(panes, view_kinds[1:]):
            pane["viewKind"] = kind
    project["mapLayout"] = {"rows": rows, "cols": cols, "syncView": bool(sync_view)}
    project["secondaryMapViews"] = panes
    return panes


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


def set_point_cloud_classes(
    project: dict[str, Any], classes: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Set the point cloud annotator's custom classes (its label schema).

    Replaces the custom classes and keeps the saved point labels, instance ids
    and 3D boxes. The annotator applies them when the project opens, so the
    LiDAR layer draws those codes in their colour and names them in its
    legend, and the classes can be assigned from the annotator's panel.

    Args:
        project: The project dict (mutated in place).
        classes: ``{"code", "name", "color"}`` dicts; see
            :func:`geolibre.project.point_cloud_class_schema`. An empty list
            clears them.

    Returns:
        The validated classes as saved.

    Raises:
        ValueError: For an invalid class.
    """
    schema = _project.point_cloud_class_schema(classes)
    plugins = _project.ensure_plugins_block(project)
    current = plugins["settings"].get(_project.POINT_CLOUD_ANNOTATION_PLUGIN_ID)
    state = dict(current) if isinstance(current, dict) else {}
    state.setdefault("version", 1)
    state.setdefault("sources", [])
    state.setdefault("cuboids", [])
    state["customClasses"] = schema
    # The annotator restores its state whether or not its panel is open, so
    # the classes apply without opening the panel.
    _project.set_plugin_state(
        project, _project.POINT_CLOUD_ANNOTATION_PLUGIN_ID, state, activate=False
    )
    return schema


def lidar_source_urls(project: dict[str, Any]) -> list[str]:
    """The URLs of the project's LiDAR point cloud layers.

    Args:
        project: The project dict.

    Returns:
        Each LiDAR layer's source URL, in layer order.
    """
    urls: list[str] = []
    for layer in layers_of(project):
        source = layer.get("source")
        if (
            isinstance(source, dict)
            and source.get("type") == "lidar"
            and isinstance(source.get("url"), str)
        ):
            urls.append(source["url"])
    return urls


def merge_point_labels(
    project: dict[str, Any],
    url: str,
    labels: dict[str, dict[int, int]],
    instances: dict[str, dict[int, int]] | None = None,
) -> int:
    """Merge point labels into the annotator's saved state for one source.

    New edits override any saved edit for the same point; other saved labels,
    boxes, vectors and custom classes are kept.

    Args:
        project: The project dict (mutated in place).
        url: The point cloud's source URL (its LiDAR layer's URL).
        labels: Node key -> {index within node: class}.
        instances: Node key -> {index within node: instance id}, optional.

    Returns:
        How many point edits were merged.
    """
    from . import pointcloud as _pointcloud

    plugins = _project.ensure_plugins_block(project)
    current = plugins["settings"].get(_project.POINT_CLOUD_ANNOTATION_PLUGIN_ID)
    state = dict(current) if isinstance(current, dict) else {}
    state.setdefault("version", 1)
    state.setdefault("cuboids", [])

    def merge(key: str, edits_by_node: dict[str, dict[int, int]], wide: bool) -> None:
        entries = [entry for entry in state.get(key) or [] if isinstance(entry, dict)]
        entry = next((item for item in entries if item.get("url") == url), None)
        if entry is None:
            entry = {"url": url, "nodes": {}}
            entries.append(entry)
        nodes = dict(entry.get("nodes") or {})
        for node_key, edits in edits_by_node.items():
            existing: dict[int, int] = {}
            if isinstance(nodes.get(node_key), str):
                try:
                    existing = _project._decode_point_label_node_sized(
                        nodes[node_key], _project.MAX_POINT_LABEL_NODE_BYTES, wide
                    )[0]
                except ValueError:
                    existing = {}
            existing.update(edits)
            nodes[node_key] = _pointcloud.encode_point_label_node(existing, wide=wide)
        entry["nodes"] = nodes
        state[key] = entries

    merge("sources", labels, wide=False)
    if instances:
        merge("instances", instances, wide=True)
    _project.set_plugin_state(
        project, _project.POINT_CLOUD_ANNOTATION_PLUGIN_ID, state, activate=False
    )
    return sum(len(edits) for edits in labels.values()) + sum(
        len(edits) for edits in (instances or {}).values()
    )


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


def set_map_legend(
    project: dict[str, Any],
    title: str | None = None,
    *,
    position: str | None = None,
    group_by_layer: bool | None = None,
    visible: bool | None = None,
    collapsed: bool | None = None,
) -> dict[str, Any]:
    """Show the map legend, the panel behind the app's Controls -> Legend.

    Unlike :func:`add_legend`, which draws hand-written entries, the map legend
    derives its rows from each visible layer's symbology (graduated classes,
    categories, heatmap ramps, ...), so it stays in step with the layers
    without restating their colors. A project has one; calling this again
    updates it and keeps any item order, label overrides, and custom entries
    already saved on it.

    Args:
        project: The project dict (mutated in place).
        title: Heading drawn above the entries. Keeps the current one (the
            app default is ``"Legend"``) when omitted.
        position: Map corner, one of :data:`CONTROL_POSITIONS`. Keeps the
            current one (the app default is ``"top-left"``) when omitted.
        group_by_layer: Group each layer's classes under a layer heading. Keeps
            the current setting (the app default groups) when omitted.
        visible: Whether the on-map panel is open. Keeps the current state
            when omitted, and opens it when the project has no legend yet.
        collapsed: Whether the open panel is collapsed to its header bar.
            Keeps the current state when omitted.

    Returns:
        The project's legend config.

    Raises:
        ValueError: If ``position`` is not a map corner.
    """
    if position is not None and position not in CONTROL_POSITIONS:
        raise ValueError(f"position must be one of {sorted(CONTROL_POSITIONS)}, got {position!r}")
    existing = project.get("legend")
    if visible is None and not isinstance(existing, dict):
        visible = True
    legend: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
    legend.setdefault("title", "Legend")
    legend.setdefault("groupByLayer", True)
    legend.setdefault("order", [])
    legend.setdefault("overrides", {})
    if title is not None:
        legend["title"] = str(title)
    if group_by_layer is not None:
        legend["groupByLayer"] = bool(group_by_layer)
    if position is not None:
        legend["panelPosition"] = position
    # The app persists these two flags only when set (normalizeLegendConfig).
    for key, flag in (("panelVisible", visible), ("panelCollapsed", collapsed)):
        if flag is None:
            continue
        if flag:
            legend[key] = True
        else:
            legend.pop(key, None)
    project["legend"] = legend
    return legend


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


# -- filters, labels, plugin state ---------------------------------------------


def set_layer_filter(project: dict[str, Any], ref: str, expression: Any) -> dict[str, Any]:
    """Set or clear a layer's persistent feature filter.

    The filter is the project's ``filterExpression`` -- the same one the app's
    **Select by Expression -> Filter layer** writes. It hides the features that
    do not match without changing the data, and combines with quick filters
    and the Time Slider window.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.
        expression: A boolean MapLibre expression (list or JSON string), e.g.
            ``[">=", ["get", "population"], 100000]``; ``None`` or ``[]``
            clears the filter.

    Returns:
        A summary of the layer, with the filter that is now set (or ``None``).

    Raises:
        ValueError: If the reference does not resolve to exactly one layer, or
            the expression is not a boolean expression array.
    """
    layer = find_layer(project, ref)
    if expression is None or expression == [] or expression == "":
        layer.pop("filterExpression", None)
    else:
        layer["filterExpression"] = _project.filter_expression(expression)
    return {**layer_summary(layer), "filterExpression": layer.get("filterExpression")}


def set_labels(
    project: dict[str, Any],
    ref: str,
    field: str | None = None,
    *,
    expression: Any = None,
    enabled: bool | None = None,
    **options: Any,
) -> dict[str, Any]:
    """Label a vector layer's features from an attribute or an expression.

    Unspecified options keep the layer's current label settings, so a call can
    restyle labels without restating the field.

    Args:
        project: The project dict (mutated in place).
        ref: A layer id or display name.
        field: Property whose value becomes the label text.
        expression: MapLibre expression (list or JSON string) for the label
            text; overrides ``field``. ``""`` clears it.
        enabled: ``False`` hides the labels but keeps their settings, ``True``
            shows them; omitted, labels keep their current state (on for a
            layer that had none).
        **options: Label options; see :func:`geolibre.project.label_style`.

    Returns:
        The layer's labels object after the change.

    Raises:
        ValueError: If the reference does not resolve to exactly one layer, or
            an option is invalid.
    """
    layer = find_layer(project, ref)
    style = layer.get("style")
    if not isinstance(style, dict):
        style = copy.deepcopy(_project.DEFAULT_LAYER_STYLE)
        layer["style"] = style
    current = style.get("labels")
    labels = _project.label_style(
        field,
        expression=expression,
        enabled=enabled,
        base=current if isinstance(current, dict) else None,
        **options,
    )
    style["labels"] = labels
    return copy.deepcopy(labels)


def set_plugin_state(
    project: dict[str, Any],
    plugin_id: str,
    state: Any = None,
    *,
    position: str | None = None,
    activate: bool = True,
    allow_unknown: bool = False,
    clear: bool = False,
) -> dict[str, Any]:
    """Store a plugin's saved state in the project, the way the app saves it.

    The blob is opaque to GeoLibre: each plugin reads its own shape in
    ``applyProjectState`` (for example the Time Slider's timeline config). The
    swipe, legend and colorbar have dedicated, validated builders --
    :func:`add_swipe`, :func:`add_legend`, :func:`add_colorbar` -- and are the
    better choice for those.

    Args:
        project: The project dict (mutated in place).
        plugin_id: A built-in plugin id from
            :data:`geolibre.project.PLUGIN_STATE_IDS`, or an external plugin's
            id with ``allow_unknown=True``.
        state: The plugin's settings blob; must be plain JSON. ``None``
            keeps the stored settings, so ``position``/``activate`` can be
            changed without resending them.
        position: Optional control corner, one of :data:`CONTROL_POSITIONS`.
        activate: Add the plugin to ``activePluginIds`` so it starts active.
        allow_unknown: Accept an id that is not a built-in plugin with saved
            state (an external plugin loaded from a manifest URL).
        clear: Remove the stored settings and nothing else (``state``,
            ``position`` and ``activate`` are then not applied, so clearing
            cannot switch the plugin on).

    Returns:
        ``{"pluginId", "active", "position", "state"}`` as now stored.

    Raises:
        ValueError: If the id is unknown (and not allowed), the position is
            invalid, the state is not plain JSON, or ``clear`` is combined
            with a ``state``.
    """
    if clear and state is not None:
        raise ValueError("pass either a state or clear=True, not both")
    if not isinstance(plugin_id, str) or not plugin_id.strip():
        raise ValueError("plugin_id must be a non-empty string")
    plugin_id = plugin_id.strip()
    if plugin_id not in _project.PLUGIN_STATE_IDS and not allow_unknown:
        raise ValueError(
            f"{plugin_id!r} is not a built-in plugin that saves project state. "
            f"Known ids: {', '.join(sorted(_project.PLUGIN_STATE_IDS))}. "
            "For an external plugin, pass allow_unknown=True."
        )
    if position is not None and position not in CONTROL_POSITIONS:
        raise ValueError(f"position must be one of {sorted(CONTROL_POSITIONS)}, got {position!r}")
    plugins = _project.ensure_plugins_block(project)
    if clear:
        # Clearing is only that: activation and the corner are left alone, so
        # wiping a plugin's settings cannot switch it on as a side effect.
        plugins["settings"].pop(plugin_id, None)
    elif state is None:
        # Reposition or (de)activate without touching the stored settings.
        if activate and plugin_id not in plugins["activePluginIds"]:
            plugins["activePluginIds"].append(plugin_id)
        if position is not None:
            plugins["mapControlPositions"][plugin_id] = position
    else:
        _project.set_plugin_state(
            project,
            plugin_id,
            _project.json_compatible(state, "state"),
            position=position,
            activate=activate,
        )
    return {
        "pluginId": plugin_id,
        "active": plugin_id in plugins["activePluginIds"],
        "position": plugins["mapControlPositions"].get(plugin_id),
        "state": copy.deepcopy(plugins["settings"].get(plugin_id)),
    }


# -- story maps ----------------------------------------------------------------


def _story_map(project: dict[str, Any]) -> dict[str, Any]:
    """Return the project's story map, creating a default one when absent.

    Args:
        project: The project dict (mutated in place when a story is created).

    Returns:
        The live ``storymap`` dict, with every ``StoryMap`` key present.
    """
    story = project.get("storymap")
    if not isinstance(story, dict):
        story = copy.deepcopy(_project.DEFAULT_STORY_MAP)
        project["storymap"] = story
    for key, value in _project.DEFAULT_STORY_MAP.items():
        story.setdefault(key, copy.deepcopy(value))
    chapters = story["chapters"]
    story["chapters"] = (
        [chapter for chapter in chapters if isinstance(chapter, dict)]
        if isinstance(chapters, list)
        else []
    )
    return story


def _story_summary(story: dict[str, Any]) -> dict[str, Any]:
    """Summarize a story map: its settings plus one line per chapter.

    Args:
        story: A ``storymap`` dict.

    Returns:
        The settings with ``chapters`` reduced to ``{"id", "title"}`` entries.
    """
    return {
        **{key: value for key, value in story.items() if key != "chapters"},
        "chapters": [
            {"id": chapter.get("id"), "title": chapter.get("title")}
            for chapter in story["chapters"]
            if isinstance(chapter, dict)
        ],
    }


def find_story_chapter(project: dict[str, Any], ref: str | int) -> int:
    """Resolve a story chapter by id, title, or 0-based position.

    Args:
        project: The project dict.
        ref: A chapter id, a chapter title (exact, then case-insensitive), or
            an integer index.

    Returns:
        The chapter's index in ``storymap.chapters``.

    Raises:
        ValueError: If nothing matches, or a title matches several chapters.
    """
    story = project.get("storymap")
    chapters = story.get("chapters") if isinstance(story, dict) else None
    chapters = [c for c in chapters if isinstance(c, dict)] if isinstance(chapters, list) else []
    if isinstance(ref, int) and not isinstance(ref, bool):
        if -len(chapters) <= ref < len(chapters):
            return ref % len(chapters)
        raise ValueError(f"No chapter at index {ref}; the story has {len(chapters)} chapter(s)")
    for index, chapter in enumerate(chapters):
        if chapter.get("id") == ref:
            return index
    for match in (
        lambda chapter: chapter.get("title") == ref,
        lambda chapter: str(chapter.get("title", "")).casefold() == str(ref).casefold(),
    ):
        hits = [index for index, chapter in enumerate(chapters) if match(chapter)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise ValueError(f"{len(hits)} chapters are titled {ref!r}; reference one by id")
    known = ", ".join(repr(chapter.get("title")) for chapter in chapters) or "none"
    raise ValueError(f"No chapter matches {ref!r}. Chapters: {known}")


def set_story_map(project: dict[str, Any], **settings: Any) -> dict[str, Any]:
    """Set the story map's title block and presentation settings.

    Args:
        project: The project dict (mutated in place).
        **settings: Any of :data:`geolibre.project.STORY_SETTING_NAMES` --
            ``title``, ``subtitle``, ``byline``, ``footer``, ``theme``
            (``"light"``/``"dark"``), ``show_markers``, ``marker_color``,
            ``inset``, ``inset_position``, ``hide_chapter_nav``,
            ``start_slide`` and ``end_slide`` (``"none"``, ``"blank"``,
            ``"black"``, ``"global"``, ``"adjacent"``).

    Returns:
        A summary of the story map (settings plus chapter ids and titles).

    Raises:
        ValueError: If a setting is unknown or invalid.
    """
    updates = _project.story_map_settings(**settings)
    story = _story_map(project)
    story.update(updates)
    return _story_summary(story)


def _resolve_opacity_layers(project: dict[str, Any], entries: Any) -> Any:
    """Resolve the layer references in chapter opacity changes to layer ids.

    Args:
        project: The project dict.
        entries: ``None`` or a list of opacity-change mappings.

    Returns:
        The entries with ``layer`` replaced by the resolved ``layerId``.

    Raises:
        ValueError: If a layer reference does not resolve.
    """
    if not isinstance(entries, (list, tuple)):
        return entries
    resolved = []
    for entry in entries:
        if isinstance(entry, dict):
            ref = entry.get("layerId", entry.get("layer_id", entry.get("layer")))
            if isinstance(ref, str) and ref:
                entry = {
                    **{k: v for k, v in entry.items() if k not in ("layer", "layer_id")},
                    "layerId": str(find_layer(project, ref)["id"]),
                }
        resolved.append(entry)
    return resolved


def add_story_chapter(
    project: dict[str, Any],
    title: str,
    *,
    description: str = "",
    center: Iterable[float] | None = None,
    zoom: float | None = None,
    pitch: float | None = None,
    bearing: float | None = None,
    image: str | None = None,
    alignment: str = "left",
    hidden: bool = False,
    map_animation: str = "flyTo",
    rotate_animation: bool = False,
    on_enter: Any = None,
    on_exit: Any = None,
    index: int | None = None,
    chapter_id: str | None = None,
) -> dict[str, Any]:
    """Add a chapter to the project's story map (Project -> Story Map).

    A camera value left out is taken from the project's saved view, the way
    the app's **Add chapter** button captures the current map.

    Args:
        project: The project dict (mutated in place).
        title: Chapter heading.
        description: Chapter body text.
        center: Camera target ``[lng, lat]``.
        zoom: Camera zoom, 0-24.
        pitch: Camera tilt in degrees, 0-85.
        bearing: Camera rotation in degrees.
        image: Optional image URL shown in the chapter panel.
        alignment: ``"left"``, ``"center"``, ``"right"``, or ``"full"``.
        hidden: Hide the text panel while still moving the map.
        map_animation: ``"flyTo"``, ``"easeTo"``, or ``"jumpTo"``.
        rotate_animation: Slowly rotate the camera once the move settles.
        on_enter: Layer opacity changes on entering, as ``{"layer": <id or
            name>, "opacity": 0-1, "duration": ms}`` entries.
        on_exit: Layer opacity changes on leaving, in the same form.
        index: Position to insert at (clamped); appended when omitted.
        chapter_id: Explicit chapter id; a UUID by default.

    Returns:
        The chapter that was added.

    Raises:
        ValueError: If a value is invalid, a layer reference does not resolve,
            or ``chapter_id`` is already used.
    """
    view = project.get("mapView") if isinstance(project.get("mapView"), dict) else {}
    view_center = view.get("center") or [0, 0]
    chapter = _project.story_chapter(
        title,
        center=list(center) if center is not None else list(view_center),
        zoom=zoom if zoom is not None else view.get("zoom", 2),
        pitch=pitch if pitch is not None else view.get("pitch", 0),
        bearing=bearing if bearing is not None else view.get("bearing", 0),
        description=description,
        image=image,
        alignment=alignment,
        hidden=hidden,
        map_animation=map_animation,
        rotate_animation=rotate_animation,
        on_enter=_resolve_opacity_layers(project, on_enter),
        on_exit=_resolve_opacity_layers(project, on_exit),
        chapter_id=chapter_id,
    )
    story = _story_map(project)
    chapters = story["chapters"]
    if any(isinstance(c, dict) and c.get("id") == chapter["id"] for c in chapters):
        raise ValueError(f"a chapter with id {chapter['id']!r} already exists")
    position = len(chapters) if index is None else max(0, min(len(chapters), int(index)))
    chapters.insert(position, chapter)
    return copy.deepcopy(chapter)


def remove_story_chapter(project: dict[str, Any], ref: str | int) -> dict[str, Any]:
    """Remove a story chapter by id, title, or index.

    Args:
        project: The project dict (mutated in place).
        ref: A chapter id, title, or 0-based index.

    Returns:
        A summary of the story map after the removal.

    Raises:
        ValueError: If the reference does not resolve to exactly one chapter.
    """
    story = _story_map(project)
    story["chapters"].pop(find_story_chapter(project, ref))
    return _story_summary(story)


def move_story_chapter(project: dict[str, Any], ref: str | int, index: int) -> dict[str, Any]:
    """Move a story chapter to a new position.

    Args:
        project: The project dict (mutated in place).
        ref: A chapter id, title, or 0-based index.
        index: The destination position (clamped to the chapter list).

    Returns:
        A summary of the story map after the move.

    Raises:
        ValueError: If the reference does not resolve to exactly one chapter.
    """
    story = _story_map(project)
    chapter = story["chapters"].pop(find_story_chapter(project, ref))
    destination = max(0, min(len(story["chapters"]), int(index)))
    story["chapters"].insert(destination, chapter)
    return _story_summary(story)


# -- bookmarks ------------------------------------------------------------------


def _bookmark_lists(project: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return the project's bookmark and folder lists, creating them if absent.

    Args:
        project: The project dict (mutated in place when a list is created).

    Returns:
        The live ``bookmarks`` and ``bookmarkGroups`` lists.
    """
    lists = []
    for key in ("bookmarks", "bookmarkGroups"):
        value = project.get(key)
        if not isinstance(value, list):
            value = []
            project[key] = value
        lists.append(value)
    return lists[0], lists[1]


def _drop_empty_bookmark_lists(project: dict[str, Any]) -> None:
    """Remove empty bookmark lists, as the app omits them when saving."""
    for key in ("bookmarks", "bookmarkGroups"):
        if project.get(key) == []:
            del project[key]


def bookmark_summary(project: dict[str, Any]) -> list[dict[str, Any]]:
    """List the project's bookmarks with the name of the folder each is in.

    Args:
        project: The project dict.

    Returns:
        ``{"id", "name", "folder"}`` entries in panel order.
    """
    folders = {
        folder.get("id"): folder.get("name")
        for folder in project.get("bookmarkGroups") or []
        if isinstance(folder, dict)
    }
    return [
        {
            "id": entry.get("id"),
            "name": entry.get("name"),
            "folder": folders.get(entry.get("groupId")),
        }
        for entry in project.get("bookmarks") or []
        if isinstance(entry, dict)
    ]


def find_bookmark(project: dict[str, Any], ref: str | int) -> int:
    """Resolve a bookmark by id, name, or 0-based position.

    Args:
        project: The project dict.
        ref: A bookmark id, a bookmark name (exact, then case-insensitive), or
            an integer index.

    Returns:
        The bookmark's index in ``bookmarks``.

    Raises:
        ValueError: If nothing matches, or a name matches several bookmarks.
    """
    entries = [entry for entry in project.get("bookmarks") or [] if isinstance(entry, dict)]
    if isinstance(ref, int) and not isinstance(ref, bool):
        if 0 <= ref < len(entries):
            return ref
        raise ValueError(f"bookmark index {ref} is out of range (0-{len(entries) - 1})")
    text = str(ref)
    for index, entry in enumerate(entries):
        if entry.get("id") == text:
            return index
    for matcher in (lambda name: name == text, lambda name: name.lower() == text.lower()):
        matches = [i for i, entry in enumerate(entries) if matcher(str(entry.get("name", "")))]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError(f"several bookmarks are named {text!r}; use the id")
    raise ValueError(f"no bookmark matches {text!r}")


def add_bookmark(
    project: dict[str, Any],
    name: str,
    *,
    center: Iterable[float] | None = None,
    zoom: float | None = None,
    pitch: float | None = None,
    bearing: float | None = None,
    folder: str | None = None,
    visible_layers: Iterable[str] | None = None,
    bookmark_id: str | None = None,
    created_at: int | None = None,
) -> dict[str, Any]:
    """Add a saved map view to the project's Bookmarks panel.

    A camera value left out is taken from the project's saved view, the way
    the panel's **Add** button captures the current map.

    Args:
        project: The project dict (mutated in place).
        name: Bookmark name.
        center: Camera target ``[lng, lat]``.
        zoom: Camera zoom, 0-24.
        pitch: Camera tilt in degrees, 0-85.
        bearing: Camera rotation in degrees.
        folder: A folder id or name to file it under; a new name creates the
            folder. Ungrouped when omitted.
        visible_layers: Layers (ids or names) to show when the bookmark is
            opened; the others are hidden. Omit to leave visibility alone.
        bookmark_id: Explicit bookmark id; a UUID by default.
        created_at: Creation time in milliseconds since the epoch; now by
            default.

    Returns:
        The bookmark that was added.

    Raises:
        ValueError: If a value is invalid, a layer does not resolve,
            ``bookmark_id`` is already used, or the project already holds
            :data:`geolibre.project.MAX_BOOKMARKS` bookmarks.
    """
    existing = [b for b in project.get("bookmarks") or [] if isinstance(b, dict)]
    if len(existing) >= _project.MAX_BOOKMARKS:
        raise ValueError(
            f"the project already has {len(existing)} bookmarks, the most the app keeps "
            f"({_project.MAX_BOOKMARKS}); remove one first"
        )
    view = project.get("mapView") if isinstance(project.get("mapView"), dict) else {}
    existing_folders = [f for f in project.get("bookmarkGroups") or [] if isinstance(f, dict)]
    new_folder: dict[str, Any] | None = None
    group_id: str | None = None
    if folder is not None:
        match = next((f for f in existing_folders if folder in (f.get("id"), f.get("name"))), None)
        if match is None:
            new_folder = match = _project.bookmark_folder(str(folder))
        group_id = str(match["id"])
    # Validate everything before touching the project, so a refused bookmark
    # leaves it unchanged.
    entry = _project.bookmark(
        name,
        center=list(center) if center is not None else list(view.get("center") or [0, 0]),
        zoom=zoom if zoom is not None else view.get("zoom", 2),
        pitch=pitch if pitch is not None else view.get("pitch", 0),
        bearing=bearing if bearing is not None else view.get("bearing", 0),
        group_id=group_id,
        visible_layer_ids=(
            resolve_layer_ids(project, visible_layers) if visible_layers is not None else None
        ),
        bookmark_id=bookmark_id,
        created_at=created_at,
    )
    if any(
        isinstance(b, dict) and b.get("id") == entry["id"] for b in project.get("bookmarks") or []
    ):
        raise ValueError(f"a bookmark with id {entry['id']!r} already exists")
    bookmarks, folders = _bookmark_lists(project)
    if new_folder is not None:
        folders.append(new_folder)
    # The panel keeps a folder's bookmarks together: file a new member right
    # after the folder's last one.
    position = len(bookmarks)
    if group_id is not None:
        members = [
            i
            for i, b in enumerate(bookmarks)
            if isinstance(b, dict) and b.get("groupId") == group_id
        ]
        if members:
            position = members[-1] + 1
    bookmarks.insert(position, entry)
    _drop_empty_bookmark_lists(project)
    return copy.deepcopy(entry)


def remove_bookmark(project: dict[str, Any], ref: str | int) -> list[dict[str, Any]]:
    """Remove a bookmark by id, name, or index.

    Args:
        project: The project dict (mutated in place).
        ref: A bookmark id, name, or 0-based index.

    Returns:
        The remaining bookmarks, as :func:`bookmark_summary` lists them.

    Raises:
        ValueError: If the reference does not resolve to exactly one bookmark.
    """
    index = find_bookmark(project, ref)
    bookmarks, _ = _bookmark_lists(project)
    entries = [i for i, entry in enumerate(bookmarks) if isinstance(entry, dict)]
    bookmarks.pop(entries[index])
    _drop_empty_bookmark_lists(project)
    return bookmark_summary(project)
