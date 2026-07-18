"""Color-ramp and classification helpers for data-driven vector symbology.

Mirrors ``packages/core/src/color-ramp.ts`` and the graduated/categorized
stop-building in ``StylePanel.tsx`` so a choropleth built from Python produces
the same ``vectorStyleStops`` the app would compute from the UI. The ramp names
match ``VECTOR_COLOR_RAMPS`` exactly, so a ramp chosen here renders identically.
"""

from __future__ import annotations

import math
from typing import Any

# Mirror of VECTOR_COLOR_RAMPS in packages/core/src/color-ramp.ts. Keep the
# anchor colors byte-identical so Python-built stops match the UI's.
VECTOR_COLOR_RAMPS: dict[str, list[str]] = {
    "viridis": ["#440154", "#31688e", "#35b779", "#fde725"],
    "plasma": ["#0d0887", "#9c179e", "#ed7953", "#f0f921"],
    "inferno": ["#000004", "#781c6d", "#ed6925", "#fcffa4"],
    "magma": ["#000004", "#721f81", "#f1605d", "#fcfdbf"],
    "cividis": ["#00204d", "#575d6d", "#a59c74", "#ffea46"],
    "turbo": ["#30123b", "#4777ef", "#1ccfd0", "#b9e642", "#fb8022", "#7a0403"],
    "spectral": ["#9e0142", "#f46d43", "#ffffbf", "#66c2a5", "#5e4fa2"],
    "blues": ["#eff6ff", "#93c5fd", "#2563eb", "#1e3a8a"],
    "greens": ["#f0fdf4", "#86efac", "#16a34a", "#14532d"],
    "oranges": ["#fff7ed", "#fdba74", "#f97316", "#7c2d12"],
    "reds": ["#fff5f0", "#fcae91", "#fb6a4a", "#cb181d", "#67000d"],
    "purples": ["#fcfbfd", "#bcbddc", "#807dba", "#54278f", "#3f007d"],
    "terrain": ["#333399", "#21bcb3", "#79d05a", "#e8e85a", "#a87b54", "#ffffff"],
    "rdylgn": ["#a50026", "#f46d43", "#ffffbf", "#66bd63", "#006837"],
    "rdylbu": ["#a50026", "#f46d43", "#ffffbf", "#74add1", "#313695"],
    "rdbu": ["#b2182b", "#ef8a62", "#f7f7f7", "#67a9cf", "#2166ac"],
    "coolwarm": ["#3b4cc0", "#7b9ff9", "#dddcdc", "#f49a7b", "#b40426"],
    "jet": ["#000080", "#0000ff", "#00ffff", "#ffff00", "#ff0000", "#800000"],
    "greys": ["#ffffff", "#bdbdbd", "#636363", "#000000"],
    "gray": ["#000000", "#ffffff"],
}

# The first ramp is the default fallback, matching getVectorColorRamp.
_DEFAULT_RAMP = "viridis"

# Classification schemes supported for graduated (numeric) symbology, matching
# the StylePanel options that createGraduatedStops branches on.
_GRADUATED_SCHEMES = frozenset({"equal-interval", "quantile"})


def get_color_ramp(name: str) -> list[str]:
    """Return a ramp's anchor colors, falling back to the default ramp.

    Args:
        name: A ramp name (e.g. ``"viridis"``).

    Returns:
        A fresh list of the ramp's anchor hex colors, or the default ramp's when
        ``name`` is unknown. A copy is returned so callers cannot mutate the
        shared :data:`VECTOR_COLOR_RAMPS` entries.
    """
    return list(VECTOR_COLOR_RAMPS.get(name, VECTOR_COLOR_RAMPS[_DEFAULT_RAMP]))


def _parse_hex(value: str) -> tuple[int, int, int]:
    """Parse a ``#rrggbb`` color into ``(r, g, b)`` channels."""
    numeric = int(value.lstrip("#"), 16)
    return (numeric >> 16) & 255, (numeric >> 8) & 255, numeric & 255


def _to_hex(r: int, g: int, b: int) -> str:
    """Format ``(r, g, b)`` channels as ``#rrggbb``."""
    return "#" + "".join(f"{channel:02x}" for channel in (r, g, b))


def interpolate_hex(start: str, end: str, ratio: float) -> str:
    """Linearly interpolate between two ``#rrggbb`` colors.

    Args:
        start: Start hex color.
        end: End hex color.
        ratio: Blend factor in ``[0, 1]``.

    Returns:
        The interpolated ``#rrggbb`` color.
    """
    sr, sg, sb = _parse_hex(start)
    er, eg, eb = _parse_hex(end)
    return _to_hex(
        round(sr + (er - sr) * ratio),
        round(sg + (eg - sg) * ratio),
        round(sb + (eb - sb) * ratio),
    )


def interpolate_ramp_colors(name: str, count: int) -> list[str]:
    """Sample a ramp into ``count`` evenly spaced colors (mirror of TS helper).

    Args:
        name: The ramp name.
        count: Number of colors to produce.

    Returns:
        ``count`` hex colors (a single end color when ``count <= 1``).
    """
    colors = get_color_ramp(name)
    if count <= 1:
        return [colors[-1]]
    result = []
    for index in range(count):
        scaled = (index / (count - 1)) * (len(colors) - 1)
        lower = math.floor(scaled)
        upper = min(len(colors) - 1, math.ceil(scaled))
        result.append(interpolate_hex(colors[lower], colors[upper], scaled - lower))
    return result


def equal_interval_breaks(minimum: float, maximum: float, count: int) -> list[float]:
    """Build ``count`` evenly spaced breaks across ``[minimum, maximum]``."""
    return [
        minimum + (maximum - minimum) * (0 if count == 1 else index / (count - 1))
        for index in range(count)
    ]


def quantile_breaks(values: list[float], count: int) -> list[float]:
    """Build ``count`` quantile breaks from a numeric sample (mirror of TS helper)."""
    if count <= 0:
        return []
    sorted_values = sorted(values)
    if not sorted_values:
        return []
    breaks = []
    for index in range(count):
        position = 0 if count == 1 else (index / (count - 1)) * (len(sorted_values) - 1)
        lower = math.floor(position)
        upper = min(len(sorted_values) - 1, math.ceil(position))
        ratio = position - lower
        breaks.append(sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * ratio)
    return breaks


def graduated_stops(
    values: list[Any],
    *,
    class_count: int = 5,
    color_ramp: str = "viridis",
    classification_scheme: str = "equal-interval",
) -> list[dict[str, Any]]:
    """Build graduated ``vectorStyleStops`` from numeric values.

    Mirrors ``createGraduatedStops`` in ``StylePanel.tsx``: non-numeric values
    are dropped, breaks come from the chosen scheme, and colors are sampled from
    the ramp. The result is a list of ``{"value", "color"}`` stop dicts the app
    renders as an ``interpolate`` expression.

    Args:
        values: The column's raw values (non-numeric entries are ignored).
        class_count: Number of classes (clamped to at least 2).
        color_ramp: A ramp name from :data:`VECTOR_COLOR_RAMPS`.
        classification_scheme: ``"equal-interval"`` or ``"quantile"``.

    Returns:
        A list of ``{"value": float, "color": str}`` stops.

    Raises:
        ValueError: If ``classification_scheme`` is not supported.
    """
    if classification_scheme not in _GRADUATED_SCHEMES:
        raise ValueError(
            "classification_scheme must be one of "
            f"{sorted(_GRADUATED_SCHEMES)}, got {classification_scheme!r}"
        )
    # Mirror clampClassCount in StylePanel.tsx: graduated needs >= 2 classes and
    # caps at 12, so a huge class_count can't bloat the project with stops.
    count = min(12, max(2, int(class_count)))
    numeric: list[float] = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        # Match Number.isFinite: drop NaN/inf the way the TS filter does.
        if math.isfinite(number):
            numeric.append(number)
    colors = interpolate_ramp_colors(color_ramp, count)
    if not numeric:
        return [{"value": index, "color": color} for index, color in enumerate(colors)]

    minimum, maximum = min(numeric), max(numeric)
    if minimum == maximum:
        return [{"value": minimum, "color": colors[-1]}]

    # Both schemes return exactly `count` breaks, so the colors line up 1:1
    # (unlike the TS natural-breaks path, which can yield fewer).
    breaks = (
        quantile_breaks(numeric, count)
        if classification_scheme == "quantile"
        else equal_interval_breaks(minimum, maximum, count)
    )
    return [
        {"value": float(f"{value:.8g}"), "color": colors[index]}
        for index, value in enumerate(breaks)
    ]
