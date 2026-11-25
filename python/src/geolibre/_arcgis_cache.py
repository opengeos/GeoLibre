"""Translate a validated ArcGIS raster cache into the app's XYZ source shape."""

from __future__ import annotations

import math
from typing import Any


def _number(value: Any) -> float:
    """Read a finite cache coordinate or resolution.

    Args:
        value: A numeric field from the service description.

    Returns:
        The finite numeric value.

    Raises:
        ValueError: If the field is not a finite number.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("ArcGIS cache coordinates and resolutions must be numbers")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError("ArcGIS cache coordinates and resolutions must be finite") from exc
    if not math.isfinite(number):
        raise ValueError("ArcGIS cache coordinates and resolutions must be finite")
    return number


def cached_arcgis_source(info: Any, service_url: str) -> dict[str, Any]:
    """Build a raster source only for an image cache using the standard XYZ grid.

    The projection, both origin coordinates, tile dimensions and each level's
    resolution must agree. A source min/max range cannot represent missing
    intermediate levels, and ordinary raster renderers cannot decode raw LERC.

    Args:
        info: The service's public REST JSON description.
        service_url: The normalized MapServer or ImageServer URL.

    Returns:
        A raster source with literal tile placeholders, tile size and zoom range.

    Raises:
        ValueError: If the service does not expose a compatible fused image cache.
    """
    if not isinstance(info, dict) or info.get("singleFusedMapCache") is not True:
        raise ValueError("ArcGIS service does not expose a fused raster cache")
    tile_info = info.get("tileInfo")
    if not isinstance(tile_info, dict):
        raise ValueError("ArcGIS cache metadata is missing tileInfo")
    reference = tile_info.get("spatialReference")
    wkid = (
        reference.get("latestWkid", reference.get("wkid")) if isinstance(reference, dict) else None
    )
    if wkid not in (3857, 102100, 102113):
        raise ValueError("ArcGIS cache must use the standard Web Mercator XYZ grid")
    size = tile_info.get("cols")
    if isinstance(size, bool) or size not in (256, 512) or tile_info.get("rows") != size:
        raise ValueError("ArcGIS cache tiles must be square 256 or 512 pixel images")
    image_format = str(tile_info.get("format", "")).strip().upper()
    if image_format not in {"PNG", "PNG8", "PNG24", "PNG32", "JPG", "JPEG", "MIXED", "WEBP"}:
        raise ValueError("ArcGIS cache must contain rendered images, rather than raw LERC or PBF")
    origin = tile_info.get("origin")
    if not isinstance(origin, dict):
        raise ValueError("ArcGIS cache metadata is missing its XYZ origin")
    if (
        abs(_number(origin.get("x")) + 20037508.342787) > 1
        or abs(_number(origin.get("y")) - 20037508.342787) > 1
    ):
        raise ValueError("ArcGIS cache must use the standard Web Mercator XYZ origin")
    lods = tile_info.get("lods")
    if not isinstance(lods, list) or not lods:
        raise ValueError("ArcGIS cache metadata must list its zoom levels")
    levels = []
    for lod in lods:
        if not isinstance(lod, dict):
            raise ValueError("ArcGIS cache zoom levels must be objects")
        level_number = _number(lod.get("level"))
        if level_number < 0 or not level_number.is_integer():
            raise ValueError("ArcGIS cache zoom levels must be nonnegative integers")
        level = int(level_number)
        try:
            expected = math.ldexp(156543.03392800014 * (256 / size), -level)
        except OverflowError as exc:
            raise ValueError("ArcGIS cache zoom level exceeds the XYZ resolution range") from exc
        resolution = _number(lod.get("resolution"))
        if expected <= 0 or resolution <= 0 or abs(resolution - expected) / expected >= 0.01:
            raise ValueError("ArcGIS cache resolutions do not match the standard XYZ zoom levels")
        levels.append(level)
    ordered = sorted(set(levels))
    if len(ordered) != len(levels) or ordered[-1] - ordered[0] + 1 != len(ordered):
        raise ValueError("ArcGIS cache zoom levels must be unique and contiguous")
    source: dict[str, Any] = {
        "type": "raster",
        "tiles": [f"{service_url}/tile/{{z}}/{{y}}/{{x}}"],
        "tileSize": int(size),
        "minzoom": ordered[0],
        "maxzoom": ordered[-1],
    }
    credit = info.get("copyrightText")
    if isinstance(credit, str) and credit.strip():
        source["attribution"] = credit.strip()
    return source
