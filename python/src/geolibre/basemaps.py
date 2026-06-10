"""Named MapLibre basemap styles for the GeoLibre Python API."""

from __future__ import annotations

# The app's default basemap (packages/core/src/types.ts: DEFAULT_BASEMAP).
DEFAULT_BASEMAP = "https://tiles.openfreemap.org/styles/liberty"

# Friendly name -> MapLibre style JSON URL. These are vector basemap styles
# (set as the project's `basemapStyleUrl`). Raster tile basemaps such as
# OpenStreetMap are added as layers via `Map.add_tile_layer` instead.
BASEMAPS: dict[str, str] = {
    "liberty": "https://tiles.openfreemap.org/styles/liberty",
    "bright": "https://tiles.openfreemap.org/styles/bright",
    "positron": "https://tiles.openfreemap.org/styles/positron",
    "dark": "https://tiles.openfreemap.org/styles/dark",
    "fiord": "https://tiles.openfreemap.org/styles/fiord",
}


def resolve_basemap(basemap: str) -> str:
    """Resolve a basemap name or URL to a MapLibre style URL.

    Args:
        basemap: A known basemap name (e.g. ``"liberty"``, ``"dark"``) or a
            full MapLibre style JSON URL.

    Returns:
        The resolved style URL.

    Raises:
        ValueError: If ``basemap`` is neither a known name nor a URL.
    """
    if not isinstance(basemap, str) or not basemap.strip():
        raise ValueError("basemap must be a non-empty string")
    value = basemap.strip()
    if value.startswith(("http://", "https://")):
        return value
    key = value.lower()
    if key in BASEMAPS:
        return BASEMAPS[key]
    raise ValueError(
        f"Unknown basemap {basemap!r}. Pass a style URL or one of: "
        + ", ".join(sorted(BASEMAPS))
    )
