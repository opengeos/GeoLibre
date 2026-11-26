"""Marker and label styles."""

from __future__ import annotations

import copy
import json
import math
from typing import Any

from ._constants import _PROJECT_CONSTANTS
from .expressions import _parse_expression
from .popups import MARKER_SHAPES, normalize_hex_color


def marker_style(
    *,
    color: str | None = None,
    opacity: float | None = None,
    radius: float | None = None,
    stroke_color: str | None = None,
    stroke_width: float | None = None,
    shape: str | None = None,
    size: float | None = None,
    icon: str | None = None,
) -> dict[str, Any]:
    """Translate friendly marker arguments into layer style keys.

    A point layer draws one of two ways. By default it is a MapLibre circle
    sized by ``radius`` and filled with ``color``. Passing ``shape``, ``size``
    or ``icon`` switches it to a baked marker sprite instead, sized by ``size``
    and colored by ``color``; ``radius`` no longer applies to it.

    Args:
        color: Marker color. Applied to both the circle fill and the sprite, so
            it takes effect either way.
        opacity: Circle fill opacity in ``[0, 1]``.
        radius: Circle radius in pixels (circle rendering only).
        stroke_color: Outline color.
        stroke_width: Outline width in pixels.
        shape: One of :data:`MARKER_SHAPES`. Switches to sprite rendering.
        size: Sprite size in pixels. Switches to sprite rendering.
        icon: Raw SVG markup, or a data/https URL to an SVG, PNG, JPEG, or
            GIF image, for a ``"custom"`` sprite. Only SVG takes ``color``.
            Switches to sprite rendering and implies ``shape="custom"``.

    Returns:
        A dict of camelCase layer style keys, empty when nothing was passed.

    Raises:
        ValueError: If ``shape`` is not a known shape, a numeric argument is
            out of range, ``shape="custom"`` is asked for without ``icon``, or
            sprite rendering is requested with a non-hex ``color``.
    """
    style: dict[str, Any] = {}
    if shape is not None and shape not in MARKER_SHAPES:
        raise ValueError(f"shape must be one of {sorted(MARKER_SHAPES)}, got {shape!r}")
    if icon is not None and not str(icon).strip():
        raise ValueError("icon must be non-empty SVG markup or a data URL")
    if shape == "custom" and icon is None:
        raise ValueError('shape="custom" needs icon= with the SVG markup to draw')
    if icon is not None and shape not in (None, "custom"):
        # The app reads markerSvg only for markerShape "custom", so an icon can
        # only render as a custom sprite. Honoring the icon would silently
        # discard the shape the caller asked for; say so instead.
        raise ValueError(f'icon= implies shape="custom", but shape={shape!r} was given too')

    # Any of these three means "render a marker sprite, not a plain circle".
    sprite = shape is not None or size is not None or icon is not None

    if sprite:
        # A sprite layer replaces the circle layer outright (layer-sync removes
        # it), and the sprite's own outline is a fixed white halo drawn by
        # drawBuiltinMarker. So the circle-only settings are not merely
        # overridden here, they are unreachable -- writing them would leave the
        # caller looking at a marker that ignored what they asked for.
        inert = {
            "opacity": opacity,
            "radius": radius,
            "stroke_color": stroke_color,
            "stroke_width": stroke_width,
        }
        given = sorted(name for name, value in inert.items() if value is not None)
        if given:
            applies = "applies" if len(given) == 1 else "apply"
            raise ValueError(
                f"{', '.join(given)} only {applies} to circle markers, but shape/size/icon "
                "selected a marker sprite; use size= for the sprite's size and drop the rest"
            )

    if color is not None:
        style["fillColor"] = str(color)
        if sprite:
            # The sprite baker runs markerColor through normalizeHexColor and
            # falls back to blue on anything it rejects, so a CSS color name
            # would silently draw the wrong marker. Fail loudly instead.
            hex_color = normalize_hex_color(str(color))
            if hex_color is None:
                raise ValueError(
                    f"marker sprites need a hex color such as '#e11d48'; got {color!r}"
                )
            style["markerColor"] = hex_color
        else:
            # Only mirror onto markerColor when the app could actually use it:
            # the sprite baker takes hex only, and writing "red" there would
            # leave a value that draws the default blue the moment someone
            # switches this layer to a marker shape in the UI.
            hex_color = normalize_hex_color(str(color))
            if hex_color is not None:
                style["markerColor"] = hex_color
    if opacity is not None:
        value = float(opacity)
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError(f"opacity must be between 0 and 1, got {opacity!r}")
        style["fillOpacity"] = value
    if radius is not None:
        value = float(radius)
        if not math.isfinite(value) or value <= 0:
            raise ValueError("radius must be a finite number greater than zero")
        style["circleRadius"] = value
    if stroke_color is not None:
        style["strokeColor"] = str(stroke_color)
    if stroke_width is not None:
        value = float(stroke_width)
        if not math.isfinite(value) or value < 0:
            raise ValueError("stroke_width must be a finite non-negative number")
        style["strokeWidth"] = value
    if size is not None:
        value = float(size)
        if not math.isfinite(value) or value <= 0:
            raise ValueError("size must be a finite number greater than zero")
        style["markerSize"] = value
    if icon is not None:
        style["markerSvg"] = str(icon)
    if sprite:
        style["markerEnabled"] = True
        style["markerShape"] = "custom" if icon is not None else (shape or "circle")
    return style


#: Loaded from ``project-constants.json`` ``DEFAULT_LAYER_STYLE["labels"]``.
#: The app merges a stored ``labels`` object over these field by field when it
#: renders, so a written object carries every key to stay stable on round trip.
DEFAULT_LABEL_STYLE: dict[str, Any] = copy.deepcopy(
    _PROJECT_CONSTANTS["DEFAULT_LAYER_STYLE"]["labels"]
)


LABEL_PLACEMENTS = frozenset({"point", "line"})


LABEL_ANCHORS = frozenset(
    {
        "center",
        "left",
        "right",
        "top",
        "bottom",
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
    }
)


LABEL_TRANSFORMS = frozenset({"none", "uppercase", "lowercase"})


LABEL_DEDUPE_MODES = frozenset({"off", "unique", "concatenate"})


#: ``LABEL_NUMBER_LOCALES`` in ``packages/core/src/label-number-format.ts``;
#: the empty string follows the app's own language.
LABEL_NUMBER_LOCALES = frozenset({"", "en-US", "de-DE", "ru-RU", "hi-IN"})


# snake_case keyword -> LabelStyle key, with how to check the value.
_LABEL_OPTIONS: dict[str, tuple[str, str]] = {
    "placement": ("placement", "placement"),
    "line_gap": ("lineGap", "bool"),
    "line_gap_padding": ("lineGapPadding", "non_negative"),
    "line_spacing": ("lineSpacing", "positive"),
    "one_per_polygon": ("onePerPolygon", "bool"),
    "size": ("size", "positive"),
    "color": ("color", "color"),
    "halo_color": ("haloColor", "color"),
    "halo_width": ("haloWidth", "non_negative"),
    "min_zoom": ("minZoom", "zoom"),
    "max_zoom": ("maxZoom", "zoom"),
    "allow_overlap": ("allowOverlap", "bool"),
    "anchor": ("anchor", "anchor"),
    "offset_x": ("offsetX", "number"),
    "offset_y": ("offsetY", "number"),
    "rotation": ("rotation", "number"),
    "max_width": ("maxWidth", "positive"),
    "transform": ("transform", "transform"),
    "number_format": ("numberFormatEnabled", "bool"),
    "number_decimals": ("numberDecimals", "decimals"),
    "number_locale": ("numberLocale", "locale"),
    "dedupe": ("dedupe", "dedupe"),
    "size_expression": ("sizeExpression", "expression"),
    "color_expression": ("colorExpression", "expression"),
    "opacity_expression": ("opacityExpression", "expression"),
    "visibility_expression": ("visibilityExpression", "expression"),
    "priority_expression": ("priorityExpression", "expression"),
}


#: The keyword options :func:`label_style` accepts besides field/expression.
LABEL_OPTION_NAMES = tuple(_LABEL_OPTIONS)


_LABEL_ENUMS = {
    "placement": LABEL_PLACEMENTS,
    "anchor": LABEL_ANCHORS,
    "transform": LABEL_TRANSFORMS,
    "dedupe": LABEL_DEDUPE_MODES,
    "locale": LABEL_NUMBER_LOCALES,
}


def _label_value(name: str, kind: str, value: Any) -> Any:
    """Validate one label option and return the value to store.

    Args:
        name: The keyword name, for error messages.
        kind: The check to apply (see ``_LABEL_OPTIONS``).
        value: The caller's value.

    Returns:
        The value as the app stores it.

    Raises:
        ValueError: If the value is out of range or of the wrong kind.
    """
    if kind in _LABEL_ENUMS:
        allowed = _LABEL_ENUMS[kind]
        if value not in allowed:
            raise ValueError(f"{name} must be one of {sorted(allowed)}, got {value!r}")
        return value
    if kind == "bool":
        if not isinstance(value, bool):
            raise ValueError(f"{name} must be true or false, got {value!r}")
        return value
    if kind == "color":
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a CSS color string, got {value!r}")
        return value.strip()
    if kind == "expression":
        if value is None or value == "":
            return ""
        return json.dumps(_parse_expression(value, name), separators=(",", ":"))
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number, got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite, got {value!r}")
    if kind == "positive" and number <= 0:
        raise ValueError(f"{name} must be greater than 0, got {value!r}")
    if kind == "non_negative" and number < 0:
        raise ValueError(f"{name} must be 0 or more, got {value!r}")
    if kind == "zoom" and not 0 <= number <= 24:
        raise ValueError(f"{name} must be between 0 and 24, got {value!r}")
    if kind == "decimals":
        if number != int(number) or not 0 <= number <= 10:
            raise ValueError(f"{name} must be a whole number from 0 to 10, got {value!r}")
        return int(number)
    return int(number) if number == int(number) else number


def label_style(
    field: str | None = None,
    *,
    expression: Any = None,
    enabled: bool | None = None,
    base: dict[str, Any] | None = None,
    **options: Any,
) -> dict[str, Any]:
    """Build a layer's ``style.labels`` object (``LabelStyle`` in types.ts).

    Args:
        field: Attribute whose value becomes the label text.
        expression: A MapLibre expression (list or JSON string) for the label
            text; overrides ``field`` when set, e.g.
            ``["concat", ["get", "name"], " (", ["get", "pop"], ")"]``. Pass
            ``""`` to clear an existing one.
        enabled: Whether labels are shown. ``False`` keeps the configuration
            but hides the labels. ``None`` keeps ``base``'s value, or turns
            labels on when there is no ``base``.
        base: An existing labels object to update; unspecified options keep
            its values. Defaults to :data:`DEFAULT_LABEL_STYLE`.
        **options: Any of :data:`LABEL_OPTION_NAMES` -- ``placement``
            (``"point"``/``"line"``), ``line_gap`` (cut the line under a
            line-placed label, contour style), ``line_gap_padding``,
            ``line_spacing``, ``one_per_polygon`` (label each polygon once,
            inside its largest part; on by default), ``size``, ``color``,
            ``halo_color``, ``halo_width``, ``min_zoom``, ``max_zoom``, ``allow_overlap``,
            ``anchor``, ``offset_x``, ``offset_y``, ``rotation``, ``max_width``,
            ``transform``, ``number_format``, ``number_decimals``,
            ``number_locale``, ``dedupe``, and the data-defined
            ``size_expression``, ``color_expression``, ``opacity_expression``,
            ``visibility_expression``, ``priority_expression``. ``None``
            values are skipped. Expressions are checked for shape only (a
            JSON array with an operator), not for their result type; the app
            reports a mistyped one when it renders.

    Returns:
        A complete labels object.

    Raises:
        ValueError: If an option is unknown or invalid, or labels are enabled
            with neither a field nor an expression to draw.
    """
    unknown = sorted(set(options) - set(_LABEL_OPTIONS))
    if unknown:
        raise ValueError(
            f"unknown label option(s) {unknown}; expected any of {list(LABEL_OPTION_NAMES)}"
        )
    labels = copy.deepcopy(DEFAULT_LABEL_STYLE)
    if isinstance(base, dict):
        labels.update(copy.deepcopy(base))
    if enabled is None:
        # A stored labels object with no `enabled` key (`{}` in a hand-edited
        # project) counts as on, not as the default's False.
        enabled = bool(base.get("enabled", True)) if isinstance(base, dict) else True
    if not isinstance(enabled, bool):
        raise ValueError(f"enabled must be true or false, got {enabled!r}")
    labels["enabled"] = enabled
    if field is not None:
        if not isinstance(field, str):
            raise ValueError(f"field must be a property name, got {field!r}")
        labels["field"] = field.strip()
    if expression is not None:
        labels["expression"] = _label_value("expression", "expression", expression)
    for name, value in options.items():
        if value is None:
            continue
        key, kind = _LABEL_OPTIONS[name]
        labels[key] = _label_value(name, kind, value)
    if labels["minZoom"] > labels["maxZoom"]:
        raise ValueError(
            f"min_zoom ({labels['minZoom']}) must not exceed max_zoom ({labels['maxZoom']})"
        )
    if labels["enabled"] and not labels["field"] and not labels["expression"]:
        raise ValueError("labels need a field or an expression to draw")
    return labels
