"""Layer metadata normalization."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

_METADATA_TEXT_KEYS = ("title", "abstract", "license", "attribution", "lineage")


_METADATA_LINK_PROTOCOLS = frozenset({"http", "https", "ftp", "s3", "gs", "mailto"})


_METADATA_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


_METADATA_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


_METADATA_DATETIME_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?"
    r"(Z|[+-]\d{2}:?\d{2})?$",
    re.IGNORECASE,
)


def _clean_text(value: Any) -> str | None:
    """Trim a value to a non-empty string.

    Args:
        value: Any value.

    Returns:
        The trimmed string, or ``None`` for a non-string or blank value.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def is_valid_metadata_date(value: str) -> bool:
    """Whether a string is an ISO 8601 date or date-time naming a real instant.

    Accepts ``YYYY-MM-DD`` and ``YYYY-MM-DDTHH:MM[:SS[.fff]][Z|+HH:MM]``, the
    same forms the app's Metadata dialog accepts.

    Args:
        value: The candidate date.

    Returns:
        ``True`` when the value is a valid date or date-time.
    """
    import datetime as _dt

    text = value.strip()
    match = _METADATA_DATE_RE.match(text) or _METADATA_DATETIME_RE.match(text)
    if not match:
        return False
    try:
        _dt.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return False
    if match.re is _METADATA_DATETIME_RE:
        hours, minutes = int(match.group(4)), int(match.group(5))
        seconds = int(match.group(6)) if match.group(6) else 0
        return hours < 24 and minutes < 60 and seconds < 60
    return True


def _metadata_instant(value: str, bound: str) -> Any:
    """Resolve a validated metadata date to a UTC instant.

    A date-only bound covers its whole day (a start is its first second, an end
    its last), and a date-time without an offset is read as UTC -- the rules
    the app's STAC export uses.

    Args:
        value: A date accepted by :func:`is_valid_metadata_date`.
        bound: ``"start"`` or ``"end"``.

    Returns:
        A timezone-aware :class:`datetime.datetime`.
    """
    import datetime as _dt

    text = value.strip()
    if _METADATA_DATE_RE.match(text):
        text = f"{text}T{'00:00:00' if bound == 'start' else '23:59:59'}+00:00"
    parsed = _dt.datetime.fromisoformat(text.upper().replace(" ", "T"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_dt.timezone.utc)


def _is_valid_metadata_url(value: str) -> bool:
    """Whether a string is an absolute URL with a scheme a metadata link may use.

    Args:
        value: The candidate URL.

    Returns:
        ``True`` for an http(s), ftp, s3, gs or mailto URL.
    """
    parts = urlsplit(value.strip())
    if parts.scheme.lower() not in _METADATA_LINK_PROTOCOLS:
        return False
    return bool(parts.netloc or parts.scheme.lower() == "mailto" and parts.path)


def normalize_layer_metadata(value: Any) -> dict[str, Any] | None:
    """Clean a raw descriptive-metadata mapping the way the app does on load.

    Keeps only string fields, trims them, drops blank fields, blank or
    duplicate (case-insensitive) keywords, and links without an ``href``. Values
    are not validated -- see :func:`layer_metadata` for the checked builder.

    Args:
        value: A ``descriptiveMetadata`` mapping (camelCase keys), or anything.

    Returns:
        The cleaned mapping, or ``None`` when nothing is left, so an empty block
        is never written to a project.
    """
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    for key in _METADATA_TEXT_KEYS:
        text = _clean_text(value.get(key))
        if text:
            out[key] = text
    keywords: list[str] = []
    seen: set[str] = set()
    raw_keywords = value.get("keywords")
    for entry in raw_keywords if isinstance(raw_keywords, list) else []:
        keyword = _clean_text(entry)
        if keyword and keyword.lower() not in seen:
            seen.add(keyword.lower())
            keywords.append(keyword)
    if keywords:
        out["keywords"] = keywords
    contact = value.get("contact")
    if isinstance(contact, dict):
        cleaned = {
            key: text
            for key in ("name", "email", "organization")
            if (text := _clean_text(contact.get(key)))
        }
        if cleaned:
            out["contact"] = cleaned
    extent = value.get("temporalExtent")
    if isinstance(extent, dict):
        cleaned = {key: text for key in ("start", "end") if (text := _clean_text(extent.get(key)))}
        if cleaned:
            out["temporalExtent"] = cleaned
    links: list[dict[str, str]] = []
    raw_links = value.get("links")
    for entry in raw_links if isinstance(raw_links, list) else []:
        if not isinstance(entry, dict):
            continue
        href = _clean_text(entry.get("href"))
        if not href:
            continue
        link = {"href": href}
        for key in ("rel", "title"):
            text = _clean_text(entry.get(key))
            if text:
                link[key] = text
        links.append(link)
    if links:
        out["links"] = links
    return out or None


def layer_metadata(
    *,
    title: str | None = None,
    abstract: str | None = None,
    keywords: str | list[str] | None = None,
    license: str | None = None,
    attribution: str | None = None,
    contact: dict[str, str] | None = None,
    lineage: str | None = None,
    temporal_extent: tuple[str | None, str | None] | dict[str, str] | None = None,
    links: list[str | dict[str, str]] | None = None,
) -> dict[str, Any] | None:
    """Build a layer's ``descriptiveMetadata`` block, validated like the app.

    This is the catalog description shown and edited in the app's layer
    Metadata dialog and exported as a STAC Item.

    Args:
        title: Human-readable title.
        abstract: Free-text summary of the data.
        keywords: Keywords, as a list or one comma-separated string.
        license: SPDX license identifier (e.g. ``"CC-BY-4.0"``) or free text.
        attribution: Credit line for the data's producers.
        contact: Mapping with any of ``name``, ``email``, ``organization``.
        lineage: How the data was produced (sources, processing steps).
        temporal_extent: ``(start, end)`` ISO 8601 dates or date-times (either
            may be ``None``), or a mapping with ``start``/``end``.
        links: URLs, or mappings with ``href`` plus optional ``rel`` and
            ``title``.

    Returns:
        The cleaned block, or ``None`` when every field is blank.

    Raises:
        ValueError: If the contact email, a temporal-extent date, or a link URL
            is malformed, or the extent ends before it starts.
    """
    if isinstance(keywords, str):
        keywords = keywords.split(",")
    if isinstance(temporal_extent, (tuple, list)):
        if len(temporal_extent) != 2:
            raise ValueError("temporal_extent must be a (start, end) pair")
        temporal_extent = {"start": temporal_extent[0], "end": temporal_extent[1]}
    link_entries = [{"href": entry} if isinstance(entry, str) else entry for entry in (links or [])]
    raw = {
        "title": title,
        "abstract": abstract,
        "keywords": list(keywords) if keywords is not None else None,
        "license": license,
        "attribution": attribution,
        "contact": contact,
        "lineage": lineage,
        "temporalExtent": temporal_extent,
        "links": link_entries,
    }
    metadata = normalize_layer_metadata(raw)
    if metadata is None:
        return None
    email = metadata.get("contact", {}).get("email")
    if email and not _METADATA_EMAIL_RE.match(email):
        raise ValueError(f"contact email is not a valid address: {email!r}")
    extent = metadata.get("temporalExtent", {})
    for key in ("start", "end"):
        if key in extent and not is_valid_metadata_date(extent[key]):
            raise ValueError(
                f"temporal extent {key} must be an ISO 8601 date or date-time: {extent[key]!r}"
            )
    if "start" in extent and "end" in extent:
        if _metadata_instant(extent["start"], "start") > _metadata_instant(extent["end"], "end"):
            raise ValueError("temporal extent end must not be before its start")
    for link in metadata.get("links", []):
        if not _is_valid_metadata_url(link["href"]):
            raise ValueError(
                "link href must be an absolute http(s), ftp, s3, gs or mailto URL: "
                f"{link['href']!r}"
            )
    return metadata
