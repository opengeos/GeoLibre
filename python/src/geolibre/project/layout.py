"""Dashboard widgets and print layout settings."""

from __future__ import annotations

import math
import re
import uuid
from typing import Any

from .raster import _resolve_bounds
from .scene import _hex_color

#: Dashboard widget types (``DashboardWidgetType`` in packages/core types.ts).
DASHBOARD_WIDGET_TYPES = frozenset(
    {"histogram", "scatter", "bar", "line", "box", "pie", "indicator", "selector", "list"}
)


#: Dashboard grid width bounds and default (``dashboardColumns``).
MIN_DASHBOARD_COLUMNS = 1


MAX_DASHBOARD_COLUMNS = 6


DEFAULT_DASHBOARD_COLUMNS = 2


_WIDGET_AGGREGATIONS = frozenset({"count", "sum", "mean"})


_INDICATOR_AGGREGATIONS = frozenset({"count", "sum", "mean", "min", "max", "median"})


_WIDGET_STRING_FIELDS = ("title", "field", "xField", "yField", "category", "valueField")


_WIDGET_OPTION_KEYS = frozenset(
    {
        *_WIDGET_STRING_FIELDS,
        "color",
        "bins",
        "aggregation",
        "indicatorAggregation",
        "prefix",
        "suffix",
        "multiple",
        "listFields",
        "sortBy",
        "sortDir",
        "limit",
    }
)


#: Options only one widget type reads; ``normalizeWidgets`` drops them elsewhere.
_WIDGET_TYPE_ONLY_OPTIONS = {
    "indicatorAggregation": "indicator",
    "prefix": "indicator",
    "suffix": "indicator",
    "multiple": "selector",
    "listFields": "list",
    "sortBy": "list",
    "sortDir": "list",
    "limit": "list",
}


_SNAKE_TO_CAMEL = re.compile(r"_([a-z])")


def _camel(key: str) -> str:
    """Convert a ``snake_case`` option name to the project's ``camelCase``."""
    return _SNAKE_TO_CAMEL.sub(lambda match: match.group(1).upper(), key)


def dashboard_widget(
    layer_id: str,
    widget_type: str,
    *,
    widget_id: str | None = None,
    **options: Any,
) -> dict[str, Any]:
    """Build one Dashboard widget (``DashboardWidget`` in packages/core types.ts).

    Options are validated the way ``normalizeWidgets`` reads them, so nothing
    written here is dropped when the project opens. They may be given in
    ``snake_case`` or ``camelCase``.

    Args:
        layer_id: Id of the (GeoJSON) layer the widget charts.
        widget_type: One of :data:`DASHBOARD_WIDGET_TYPES`.
        widget_id: Explicit widget id; a UUID by default.
        **options: ``title``, ``color`` (``#rgb``/``#rrggbb``), ``field``
            (histogram/box/indicator/selector), ``x_field``/``y_field``
            (scatter/line), ``bins`` (1-50), ``category``, ``aggregation``
            (``count``/``sum``/``mean``; no ``mean`` for pie), ``value_field``;
            indicator only: ``indicator_aggregation``, ``prefix``, ``suffix``;
            selector only: ``multiple``; list only: ``list_fields``,
            ``sort_by``, ``sort_dir`` (``asc``/``desc``), ``limit`` (1-500).

    Returns:
        A widget dict for the project's ``widgets`` array.

    Raises:
        ValueError: If the type, an option name, or an option value is invalid.
    """
    if widget_type not in DASHBOARD_WIDGET_TYPES:
        raise ValueError(
            f"widget_type must be one of {sorted(DASHBOARD_WIDGET_TYPES)}, got {widget_type!r}"
        )
    if not isinstance(layer_id, str) or not layer_id.strip():
        raise ValueError("layer_id must be a non-empty string")
    widget_id = str(widget_id).strip() if widget_id is not None else str(uuid.uuid4())
    if not widget_id:
        raise ValueError("widget_id must not be empty")
    widget: dict[str, Any] = {"id": widget_id, "layerId": layer_id.strip(), "type": widget_type}
    for raw_key, value in options.items():
        if value is None:
            continue
        key = _camel(raw_key)
        if key not in _WIDGET_OPTION_KEYS:
            raise ValueError(f"unknown dashboard widget option {raw_key!r}")
        only = _WIDGET_TYPE_ONLY_OPTIONS.get(key)
        if only is not None and only != widget_type:
            raise ValueError(f"{raw_key!r} applies only to {only} widgets")
        if key in _WIDGET_STRING_FIELDS or key == "sortBy":
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{raw_key!r} must be a non-empty string")
            widget[key] = value.strip()
        elif key in ("prefix", "suffix"):
            if not isinstance(value, str):
                raise ValueError(f"{raw_key!r} must be a string")
            if value:
                widget[key] = value
        elif key == "color":
            short = isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{3}", value.strip())
            color = value.strip().lower() if short else _hex_color(value)
            if color is None:
                raise ValueError(f"color must be #rgb or #rrggbb, got {value!r}")
            widget[key] = color
        elif key in ("bins", "limit"):
            high = 50 if key == "bins" else 500
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= high:
                raise ValueError(f"{raw_key!r} must be an integer from 1 to {high}")
            widget[key] = value
        elif key == "aggregation":
            if (
                not isinstance(value, str)
                or value not in _WIDGET_AGGREGATIONS
                or (widget_type == "pie" and value == "mean")
            ):
                raise ValueError(
                    f"aggregation must be count, sum, or mean (no mean for pie), got {value!r}"
                )
            widget[key] = value
        elif key == "indicatorAggregation":
            if not isinstance(value, str) or value not in _INDICATOR_AGGREGATIONS:
                raise ValueError(
                    f"indicator_aggregation must be one of {sorted(_INDICATOR_AGGREGATIONS)}"
                )
            widget[key] = value
        elif key == "multiple":
            if not isinstance(value, bool):
                raise ValueError("multiple must be true or false")
            if value:
                widget[key] = True
        elif key == "listFields":
            if (
                not isinstance(value, (list, tuple))
                or not value
                or not all(isinstance(item, str) and item.strip() for item in value)
            ):
                raise ValueError("list_fields must be a non-empty list of field names")
            widget[key] = [item.strip() for item in value]
        elif key == "sortDir":
            if value not in ("asc", "desc"):
                raise ValueError(f"sort_dir must be 'asc' or 'desc', got {value!r}")
            widget[key] = value
    return widget


#: The Print Layout settings a project stores, with their defaults
#: (``DEFAULT_PRINT_LAYOUT`` in packages/core/src/print-layout-config.ts).
PRINT_LAYOUT_DEFAULTS: dict[str, Any] = {
    "title": "",
    "subtitle": "",
    "titlePlacement": "outside",
    "titleAlign": "center",
    "paperSize": "a4",
    "orientation": "landscape",
    "customWidth": 1280,
    "customHeight": 720,
    "customUnit": "px",
    "pageMargin": "normal",
    "pageBackground": "#ffffff",
    "panelTheme": "light",
    "showPageBorder": False,
    "pageBorderColor": "#111827",
    "pageBorderWidth": 2,
    "exportDpi": 150,
    "mapBorderColor": "#9ca3af",
    "mapBorderWidth": 1,
    "mapBackground": "#e5e7eb",
    "showTitle": True,
    "showSubtitle": True,
    "showLegend": True,
    "showScaleBar": True,
    "showNorthArrow": True,
    "navigationGrouped": True,
    "showFooter": False,
    "footerText": "",
    "showDate": True,
    "dateText": "",
    "showAttribution": True,
    "showColorbar": False,
    "colorbarRamp": "viridis",
    "colorbarMin": "0",
    "colorbarMax": "100",
    "colorbarLabel": "",
    "colorbarOrientation": "vertical",
    "colorbarLength": 34,
    "colorbarPosition": "top-right",
    "showCustomLegend": False,
    "customLegendTitle": "Legend",
    "customLegendEntries": [
        {"id": "cl-1", "label": "Class 1", "color": "#2563eb"},
        {"id": "cl-2", "label": "Class 2", "color": "#16a34a"},
    ],
    "customLegendPosition": "top-left",
    "showDataTable": False,
    "tableLayerId": "",
    "tableTitle": "",
    "tableColumns": [],
    "tableSortField": "",
    "tableSortDesc": False,
    "tableMaxRows": 10,
    "tableFitRows": False,
    "tablePosition": "bottom-left",
    "tablePageFilter": "contained",
    "tableFilterToAtlasFeature": False,
    "showDataChart": False,
    "chartLayerId": "",
    "chartTitle": "",
    "chartType": "bar",
    "chartCategoryField": "",
    "chartAggregation": "count",
    "chartValueField": "",
    "chartPosition": "top-right",
    "chartPageFilter": "contained",
    "showInfoBlock": False,
    "author": "",
    "projectNumber": "",
    "crs": "",
    "revision": "",
    "showInset": False,
    "insetBasemap": "positron",
    "insetZoomOffset": -4,
    "insetExtentColor": "#dc2626",
    "insetBox": None,
    "showGrid": False,
    "gridType": "dms",
    "gridInterval": 0,
    "gridFontSize": 7,
    "gridLines": False,
    "mapFrameBox": None,
    "elementOffsets": {},
    "captureMode": "viewport",
    "extentBbox": None,
    "atlasEnabled": False,
    "atlasLayerId": "",
    "atlasCoverage": "features",
    "atlasSegmentKm": "20",
    "atlasNameField": "",
    "atlasExtentMode": "margin",
    "atlasMarginPct": 10,
    "atlasMaskEnabled": False,
    "atlasScale": "50000",
    "atlasSortField": "",
    "atlasSortDescending": False,
    "atlasFilter": "",
    "atlasFilenamePattern": "{atlas.pagenumber}-{atlas.name}",
}


_CORNERS = ("top-left", "top-right", "bottom-left", "bottom-right")


_PAGE_FILTERS = ("all", "contained", "intersecting")


#: Enumerated Print Layout settings and the values ``normalizePrintLayoutConfig`` keeps.
PRINT_LAYOUT_CHOICES: dict[str, tuple[Any, ...]] = {
    "insetBasemap": ("positron", "liberty", "bright", "dark", "fiord", "osm"),
    "gridType": ("dms", "decimal", "utm", "mgrs"),
    "titlePlacement": ("outside", "inside"),
    "titleAlign": ("left", "center", "right"),
    "paperSize": (
        "a4",
        "a3",
        "letter",
        "legal",
        "tabloid",
        "fullhd",
        "hd",
        "uhd4k",
        "square",
        "custom",
    ),
    "orientation": ("portrait", "landscape"),
    "customUnit": ("mm", "px"),
    "pageMargin": ("normal", "narrow", "none"),
    "panelTheme": ("light", "dark"),
    "exportDpi": (72, 150, 300),
    "colorbarOrientation": ("vertical", "horizontal"),
    "colorbarPosition": _CORNERS,
    "customLegendPosition": _CORNERS,
    "tablePosition": _CORNERS,
    "tablePageFilter": _PAGE_FILTERS,
    "chartType": ("bar", "pie", "line"),
    "chartAggregation": ("count", "sum", "mean"),
    "chartPosition": _CORNERS,
    "chartPageFilter": _PAGE_FILTERS,
    "captureMode": ("viewport", "extent"),
    "atlasCoverage": ("features", "line"),
    "atlasExtentMode": ("margin", "scale"),
}


#: Numeric Print Layout settings and the range ``normalizePrintLayoutConfig`` clamps to.
PRINT_LAYOUT_RANGES: dict[str, tuple[float, float]] = {
    "insetZoomOffset": (-12, 0),
    "gridInterval": (0, 10000000),
    "gridFontSize": (3, 36),
    "customWidth": (1, 100000),
    "customHeight": (1, 100000),
    "pageBorderWidth": (1, 20),
    "mapBorderWidth": (0, 10),
    "colorbarLength": (1, 100),
    "tableMaxRows": (1, 10000),
    "atlasMarginPct": (0, 100),
}


#: Print Layout settings that hold a layer id.
PRINT_LAYOUT_LAYER_FIELDS = ("tableLayerId", "chartLayerId", "atlasLayerId")


def _print_layout_number(value: Any, low: float, high: float) -> bool:
    """Check a bounded finite layout number without overflowing large integers.

    Args:
        value: The supplied setting.
        low: Inclusive lower bound.
        high: Inclusive upper bound.

    Returns:
        Whether the value is a finite number within the bounds.
    """
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and (not isinstance(value, float) or math.isfinite(value))
        and low <= value <= high
    )


def _print_layout_frame(value: Any, setting: str) -> dict[str, float] | None:
    """Validate and copy a frame that fits within the page.

    Args:
        value: A page-fraction box or None for automatic placement.
        setting: The setting name used in validation errors.

    Returns:
        A copied frame, or None.

    Raises:
        ValueError: If the app would discard or clamp the frame.
    """
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or set(value) != {"x", "y", "w", "h"}
        or not all(_print_layout_number(value[key], 0, 1) for key in ("x", "y"))
        or not all(_print_layout_number(value[key], 0.01, 1) for key in ("w", "h"))
        or value["x"] + value["w"] > 1 + 1e-12
        or value["y"] + value["h"] > 1 + 1e-12
    ):
        raise ValueError(f"{setting} must be a page-fraction box with x, y, w, h inside the page")
    return dict(value)


def print_layout_settings(**settings: Any) -> dict[str, Any]:
    """Validate a partial Print Layout config (``PrintLayoutConfig`` in core).

    Each value is checked the way ``normalizePrintLayoutConfig`` reads it, so
    the app keeps everything written here. Layer-id settings are taken as
    given; :func:`geolibre.authoring.set_print_layout` resolves layer names.

    Args:
        **settings: Settings in ``snake_case`` or ``camelCase``, e.g.
            ``title="Flood extent"``, ``paper_size="a3"``,
            ``orientation="portrait"``, ``show_legend=False``,
            ``extent_bbox=[w, s, e, n]``.

    Returns:
        The settings, keyed in ``camelCase``.

    Raises:
        ValueError: If a setting is unknown or its value would be discarded.
    """
    result: dict[str, Any] = {}
    for raw_key, value in settings.items():
        key = _camel(raw_key)
        if key not in PRINT_LAYOUT_DEFAULTS:
            raise ValueError(f"unknown print layout setting {raw_key!r}")
        default = PRINT_LAYOUT_DEFAULTS[key]
        if key in PRINT_LAYOUT_CHOICES:
            choices = PRINT_LAYOUT_CHOICES[key]
            if isinstance(value, bool) or value not in choices:
                raise ValueError(f"{raw_key} must be one of {list(choices)}, got {value!r}")
        elif key in ("mapFrameBox", "insetBox"):
            value = _print_layout_frame(value, raw_key)
        elif key == "elementOffsets":
            allowed = {"title", "legend", "scaleBar", "northArrow", "footer"}
            if not isinstance(value, dict) or set(value) - allowed:
                raise ValueError(
                    "element_offsets must map title, legend, scaleBar, northArrow, "
                    "or footer to offsets"
                )
            copied = {}
            for name, entry in value.items():
                if (
                    not isinstance(entry, dict)
                    or set(entry) != {"dx", "dy", "scale"}
                    or not all(_print_layout_number(entry[key], -1, 1) for key in ("dx", "dy"))
                    or not _print_layout_number(entry["scale"], 0.25, 4)
                ):
                    raise ValueError(
                        f"element_offsets[{name!r}] needs dx/dy in [-1, 1] and scale in [0.25, 4]"
                    )
                copied[name] = dict(entry)
            value = copied
        elif key == "extentBbox":
            if value is not None:
                box = _resolve_bounds(value)
                if box is None or box[0] >= box[2] or box[1] >= box[3]:
                    raise ValueError("extent_bbox must be [west, south, east, north] with area")
                value = box
        elif key == "customLegendEntries":
            if not isinstance(value, list) or not all(
                isinstance(entry, dict)
                and isinstance(entry.get("label", ""), str)
                and isinstance(entry.get("color", ""), str)
                for entry in value
            ):
                raise ValueError("custom_legend_entries must be a list of {label, color} dicts")
            reserved = [str(entry["id"]) for entry in value if entry.get("id")]
            if len(reserved) != len(set(reserved)):
                raise ValueError("custom_legend_entries must have unique ids")
            used = set(reserved)
            normalized = []
            for index, entry in enumerate(value):
                entry_id = str(entry.get("id") or "")
                if not entry_id:
                    suffix = index + 1
                    while f"cl-{suffix}" in used:
                        suffix += 1
                    entry_id = f"cl-{suffix}"
                    used.add(entry_id)
                normalized.append(
                    {
                        "id": entry_id,
                        "label": entry.get("label", ""),
                        "color": entry.get("color", "#2563eb"),
                    }
                )
            value = normalized
        elif key == "tableColumns":
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                raise ValueError("table_columns must be a list of field names")
            value = list(value)
        elif isinstance(default, bool):
            if not isinstance(value, bool):
                raise ValueError(f"{raw_key} must be true or false")
        elif isinstance(default, (int, float)):
            low, high = PRINT_LAYOUT_RANGES[key]
            if not _print_layout_number(value, low, high):
                raise ValueError(f"{raw_key} must be a number from {low:g} to {high:g}")
        elif isinstance(default, str):
            if not isinstance(value, str):
                raise ValueError(f"{raw_key} must be a string")
            if key in ("pageBackground", "insetExtentColor") and not re.fullmatch(
                r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})", value.strip()
            ):
                raise ValueError(f"{raw_key} must be #rgb or #rrggbb")
        result[key] = value
    if result.get("gridType") == "mgrs" and result.get("gridInterval", 0) > 0:
        result["gridInterval"] = math.ceil(result["gridInterval"] / 1000) * 1000
    return result
