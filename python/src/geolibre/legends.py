"""Built-in legend presets for :meth:`geolibre.Map.add_legend`.

Each preset is a list of ``(label, color)`` pairs in display order, mirroring the
land-cover legends shipped by leafmap/geemap so the embedded Legend control can
render a recognizable legend (e.g. NLCD, ESA WorldCover) from a single name.
"""

from __future__ import annotations

from typing import TypedDict


class _LegendPreset(TypedDict):
    """A built-in legend preset: a title and ordered (label, color) pairs."""

    title: str
    items: list[tuple[str, str]]


# Each value is an ordered list of (label, hex color) pairs. Colors follow the
# official product color tables (NLCD legend, ESA WorldCover class palette).
BUILTIN_LEGENDS: dict[str, _LegendPreset] = {
    "nlcd": {
        "title": "NLCD Land Cover",
        "items": [
            ("Open Water", "#466b9f"),
            ("Perennial Ice/Snow", "#d1def8"),
            ("Developed, Open Space", "#dec5c5"),
            ("Developed, Low Intensity", "#d99282"),
            ("Developed, Medium Intensity", "#eb0000"),
            ("Developed, High Intensity", "#ab0000"),
            ("Barren Land", "#b3ac9f"),
            ("Deciduous Forest", "#68ab5f"),
            ("Evergreen Forest", "#1c5f2c"),
            ("Mixed Forest", "#b5c58f"),
            ("Dwarf Scrub", "#af963c"),
            ("Shrub/Scrub", "#ccb879"),
            ("Grassland/Herbaceous", "#dfdfc2"),
            ("Sedge/Herbaceous", "#d1d182"),
            ("Lichens", "#a3cc51"),
            ("Moss", "#82ba9e"),
            ("Pasture/Hay", "#dcd939"),
            ("Cultivated Crops", "#ab6c28"),
            ("Woody Wetlands", "#b8d9eb"),
            ("Emergent Herbaceous Wetlands", "#6c9fb8"),
        ],
    },
    "esa_worldcover": {
        "title": "ESA WorldCover",
        "items": [
            ("Tree cover", "#006400"),
            ("Shrubland", "#ffbb22"),
            ("Grassland", "#ffff4c"),
            ("Cropland", "#f096ff"),
            ("Built-up", "#fa0000"),
            ("Bare / sparse vegetation", "#b4b4b4"),
            ("Snow and ice", "#f0f0f0"),
            ("Permanent water bodies", "#0064c8"),
            ("Herbaceous wetland", "#0096a0"),
            ("Mangroves", "#00cf75"),
            ("Moss and lichen", "#fae6a0"),
        ],
    },
}

# Friendly aliases so common names resolve to a canonical preset key.
_LEGEND_ALIASES: dict[str, str] = {
    "esa": "esa_worldcover",
    "worldcover": "esa_worldcover",
    "esa_world_cover": "esa_worldcover",
    "nlcd_land_cover": "nlcd",
}


def builtin_legend_names() -> list[str]:
    """Return the available built-in legend preset names (canonical keys)."""
    return sorted(BUILTIN_LEGENDS)


def get_builtin_legend(name: str) -> _LegendPreset:
    """Return a built-in legend preset by name.

    Args:
        name: A preset name (e.g. ``"nlcd"``, ``"esa_worldcover"``, ``"esa"``).
            Matching is case-insensitive and a small set of aliases is accepted.

    Returns:
        A dict with ``"title"`` (str) and ``"items"`` (a list of
        ``(label, color)`` pairs).

    Raises:
        ValueError: If no preset matches ``name``.
    """
    key = str(name).strip().lower()
    key = _LEGEND_ALIASES.get(key, key)
    preset = BUILTIN_LEGENDS.get(key)
    if preset is None:
        raise ValueError(
            f"Unknown built-in legend {name!r}. Available presets: {builtin_legend_names()}"
        )
    return preset
