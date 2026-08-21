"""Google Encoded Polyline encoder and decoder supporting precision 5 and 6."""

from __future__ import annotations

import math
from typing import Any, Sequence


def unescape_polyline(encoded: str) -> str:
    """Unescape double-escaped backslashes in a polyline string.

    Args:
        encoded: Polyline string containing escaped characters like `\\\\`.

    Returns:
        Cleaned polyline string.
    """
    if not encoded or not isinstance(encoded, str):
        return ""
    return encoded.replace("\\\\", "\\").replace('\\"', '"').replace("\\'", "'")


def decode_polyline(
    encoded: str,
    precision: int = 5,
    unescape: bool = False,
) -> list[tuple[float, float]]:
    """Decode an encoded polyline string into a list of (longitude, latitude) coordinates.

    Args:
        encoded: The polyline ASCII string.
        precision: Decimal digits of precision (5 for Google/OSRM, 6 for Valhalla/Mapbox).
        unescape: Whether to unescape double-escaped backslashes before decoding.

    Returns:
        A list of `(lng, lat)` coordinate tuples in GeoJSON order.
    """
    if not encoded or not isinstance(encoded, str):
        return []

    clean_encoded = unescape_polyline(encoded) if unescape else encoded
    factor = 10**precision
    length = len(clean_encoded)
    coordinates: list[tuple[float, float]] = []
    index = 0
    lat = 0
    lon = 0

    while index < length:
        # Decode latitude delta
        shift = 0
        result = 0
        while True:
            if index >= length:
                return coordinates
            byte = ord(clean_encoded[index]) - 63
            index += 1
            if byte < 0 or byte > 63:
                return []
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break

        delta_lat = ~(result >> 1) if (result & 1) else (result >> 1)
        lat += delta_lat

        # Decode longitude delta
        shift = 0
        result = 0
        while True:
            if index >= length:
                return coordinates
            byte = ord(clean_encoded[index]) - 63
            index += 1
            if byte < 0 or byte > 63:
                return []
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break

        delta_lon = ~(result >> 1) if (result & 1) else (result >> 1)
        lon += delta_lon

        lat_deg = lat / factor
        lon_deg = lon / factor
        if not (-90.0 <= lat_deg <= 90.0 and -180.0 <= lon_deg <= 180.0):
            return []

        coordinates.append((lon_deg, lat_deg))

    return coordinates


def _encode_signed_number(num: int) -> str:
    sgn_num = ~(num << 1) if num < 0 else (num << 1)
    chars: list[str] = []
    while sgn_num >= 0x20:
        chars.append(chr((0x20 | (sgn_num & 0x1F)) + 63))
        sgn_num >>= 5
    chars.append(chr(sgn_num + 63))
    return "".join(chars)


def encode_polyline(
    coordinates: Sequence[Sequence[float]],
    precision: int = 5,
) -> str:
    """Encode a sequence of (longitude, latitude) coordinate pairs into a polyline string.

    Args:
        coordinates: A sequence of `[lng, lat]` or `(lng, lat)` coordinates.
        precision: Decimal digits of precision (5 for Google/OSRM, 6 for Valhalla/Mapbox).

    Returns:
        The encoded polyline ASCII string.
    """
    if not coordinates:
        return ""

    factor = 10**precision
    output_parts: list[str] = []
    prev_lat = 0
    prev_lon = 0

    for coord in coordinates:
        if len(coord) < 2:
            raise ValueError(f"Coordinate pair must have at least 2 elements, got {coord!r}")
        lon, lat = float(coord[0]), float(coord[1])
        if not (math.isfinite(lon) and math.isfinite(lat)):
            raise ValueError(f"Coordinates must be finite numbers, got ({lon}, {lat})")
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            raise ValueError(
                "Coordinates out of bounds: longitude must be in [-180, 180], "
                f"latitude in [-90, 90], got lon={lon}, lat={lat}"
            )

        round_lat = math.floor(lat * factor + 0.5)
        round_lon = math.floor(lon * factor + 0.5)

        delta_lat = round_lat - prev_lat
        delta_lon = round_lon - prev_lon

        output_parts.append(_encode_signed_number(delta_lat))
        output_parts.append(_encode_signed_number(delta_lon))

        prev_lat = round_lat
        prev_lon = round_lon

    return "".join(output_parts)


def polyline_to_geojson(
    polyline: str | Sequence[str],
    precision: int = 5,
    unescape: bool = False,
    delimiter: str | None = None,
    properties: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Convert one or more encoded polyline strings into a GeoJSON FeatureCollection.

    Args:
        polyline: A single polyline string or a sequence of polyline strings.
        precision: Decimal digits of precision (5 for Google/OSRM, 6 for Valhalla/Mapbox).
        unescape: Whether to automatically unescape double-escaped backslashes.
        delimiter: Optional delimiter to split a multiline string (defaults to newline).
        properties: Optional properties dict to attach to the GeoJSON feature(s).

    Returns:
        A GeoJSON FeatureCollection dict containing LineString features.
    """
    props = dict(properties or {})
    lines: list[str]
    if isinstance(polyline, str):
        if delimiter:
            lines = polyline.split(delimiter)
        elif "\n" in polyline:
            lines = polyline.splitlines()
        else:
            lines = [polyline]
    else:
        lines = list(polyline)

    features: list[dict[str, Any]] = []
    for i, line_str in enumerate(lines):
        clean_str = line_str.strip()
        if not clean_str:
            continue
        coords = decode_polyline(clean_str, precision=precision, unescape=unescape)
        if len(coords) >= 2:
            feature_props = dict(props)
            if len(lines) > 1 and "name" not in feature_props:
                feature_props["line_index"] = i + 1
            feature_props["points"] = len(coords)
            features.append(
                {
                    "type": "Feature",
                    "properties": feature_props,
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [list(c) for c in coords],
                    },
                }
            )

    return {
        "type": "FeatureCollection",
        "features": features,
    }
