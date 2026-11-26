"""Fetching remote GeoJSON safely: public-address checks, redirects and size limits."""

from __future__ import annotations

import ipaddress
import json
import socket
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

from .credentials import _redact_url

# Cap GeoJSON inputs (URL fetches and local files alike) so a huge source cannot
# silently exhaust kernel memory when inlined into the project.
_MAX_GEOJSON_BYTES = 50 * 1024 * 1024  # 50 MB


_NAT64_WELL_KNOWN = ipaddress.IPv6Network("64:ff9b::/96")


_NAT64_LOCAL = ipaddress.IPv6Network("64:ff9b:1::/48")


def _is_public_ip(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return True only for globally routable unicast IP addresses."""
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return _is_public_ip(address.ipv4_mapped)
        if address in _NAT64_WELL_KNOWN:
            return _is_public_ip(ipaddress.IPv4Address(int(address) & 0xFFFFFFFF))
        if (
            address in _NAT64_LOCAL
            or address.sixtofour is not None
            or address.teredo is not None
            or address.is_site_local
        ):
            return False
        # ISATAP embeds an IPv4 address in the interface identifier.
        if int(address) & 0xFFFFFFFF00000000 in {0x00005EFE00000000, 0x02005EFE00000000}:
            return False
    return address.is_global and not address.is_multicast and not address.is_reserved


def _assert_public_url(url: str) -> None:
    """Reject a URL with a non-HTTP(S) scheme or a host resolving to a non-public address.

    Guards the kernel-side fetch against SSRF: without this a redirect (or a
    crafted URL) could reach a private/loopback/link-local address such as a
    cloud metadata endpoint (``169.254.169.254``) and inline the response into
    the project. Every address the host resolves to must be globally routable.

    Args:
        url: The URL about to be fetched (or a redirect target).

    Raises:
        ValueError: If the scheme is not HTTP(S), or the host is missing,
            unresolvable, or maps to any non-public address.
    """
    safe_url = _redact_url(url)
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise ValueError(f"Refusing to fetch non-HTTP(S) URL: {safe_url}")
    host = parsed.hostname
    if not host:
        raise ValueError(f"URL has no host: {safe_url}")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve host for URL: {safe_url}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not _is_public_ip(ip):
            raise ValueError(f"Refusing to fetch from a non-public address ({ip}): {safe_url}")


class _PublicOnlyRedirectHandler(HTTPRedirectHandler):
    """Redirect handler that re-validates every hop against ``_assert_public_url``."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        _assert_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# Opener used for public JSON fetches: follows redirects but rejects any
# hop that points at a non-public address (SSRF defence).
_GEOJSON_OPENER = build_opener(_PublicOnlyRedirectHandler)


def load_featurecollection(data: Any) -> dict[str, Any]:
    """Coerce assorted inputs into a GeoJSON FeatureCollection dict.

    Accepts a FeatureCollection/Feature/geometry dict, a file path or URL to a
    GeoJSON file, a JSON string, or any object exposing ``__geo_interface__``
    (e.g. a GeoPandas GeoDataFrame/GeoSeries or a Shapely geometry).

    Args:
        data: The input geometry/collection in one of the supported forms.

    Returns:
        A GeoJSON FeatureCollection dict.

    Raises:
        ValueError: If the input cannot be interpreted as GeoJSON.
    """
    if hasattr(data, "__geo_interface__"):
        data = data.__geo_interface__

    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8")

    if isinstance(data, str):
        text = data.strip()
        if text.startswith(("http://", "https://")):
            # Reject non-public hosts up front, then fetch through an opener that
            # re-checks every redirect hop, so a redirect to a private/metadata
            # address cannot be followed (SSRF defence).
            _assert_public_url(text)
            # Bound the request so a slow or oversized response cannot hang the
            # kernel or exhaust memory. read(limit + 1) detects an over-limit
            # body without buffering the whole thing.
            try:
                with _GEOJSON_OPENER.open(text, timeout=30) as response:  # noqa: S310 - user URL
                    raw = response.read(_MAX_GEOJSON_BYTES + 1)
            except (URLError, TimeoutError) as exc:
                # Normalize transport failures to the documented ValueError
                # contract (decode/JSON errors are already ValueError-derived).
                raise ValueError(f"Could not load GeoJSON from URL: {text}") from exc
            if len(raw) > _MAX_GEOJSON_BYTES:
                raise ValueError("GeoJSON response exceeds the 50 MB size limit")
            data = json.loads(raw.decode("utf-8"))
        elif text.startswith(("{", "[")):
            # Literal text is capped like the URL and file forms. It arrives
            # already in memory, so this bounds the parse (and the copy the
            # parse builds), not the read.
            if len(text.encode("utf-8")) > _MAX_GEOJSON_BYTES:
                raise ValueError("GeoJSON text exceeds the 50 MB size limit")
            data = json.loads(text)
        else:
            path = Path(text).expanduser()
            if not path.is_file():
                raise ValueError(f"GeoJSON file not found: {text}")
            if path.stat().st_size > _MAX_GEOJSON_BYTES:
                raise ValueError(f"GeoJSON file exceeds the 50 MB size limit: {text}")
            data = json.loads(path.read_text(encoding="utf-8"))

    if not isinstance(data, dict) or "type" not in data:
        raise ValueError("Could not interpret input as GeoJSON")

    geom_type = data["type"]
    if geom_type == "FeatureCollection":
        if not isinstance(data.get("features"), list):
            raise ValueError("FeatureCollection must have a 'features' list")
        return data
    if geom_type == "Feature":
        return {"type": "FeatureCollection", "features": [data]}
    # A bare geometry: wrap it in a feature.
    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": data}],
    }
