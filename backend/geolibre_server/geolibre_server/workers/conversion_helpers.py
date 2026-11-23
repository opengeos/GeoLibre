"""Shared helpers imported by conversion worker modules."""

from __future__ import annotations

from collections.abc import Iterable


def shapefile_field_warnings(column_names: Iterable[str]) -> list[str]:
    """Return user-facing warnings for Shapefile 10-character field truncation."""
    names = list(column_names)
    long_names = [name for name in names if len(name) > 10]
    messages: list[str] = []
    if long_names:
        messages.append(
            "Shapefile truncates field names to 10 characters: " + ", ".join(long_names)
        )
    truncated: dict[str, list[str]] = {}
    for name in names:
        truncated.setdefault(name[:10].lower(), []).append(name)
    collisions = [group for group in truncated.values() if len(group) > 1]
    if collisions:
        messages.append(
            "Truncating to 10 characters produces duplicate field names: "
            + "; ".join(", ".join(group) for group in collisions)
        )
    return messages
