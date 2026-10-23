"""Shared database target, error, JSON, and feature-diff helpers."""

from __future__ import annotations

import ipaddress
import os
import re
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from fastapi import HTTPException

from geolibre_server import vector_ops

# Explicit opt-in only. Desktop spawns a loopback-bound, token-authenticated
# sidecar for the same local user; shared deployments leave the variable
# unset and remain closed by default.
UNRESTRICTED = "*"
# Usernames may be empty (Postgres can use PGUSER); greedy matching redacts
# through the last @ so a literal @ inside a password cannot leak its suffix.
_PASSWORD_URL_RE = re.compile(r"(://[^:/\s@]*:)[^\s]+@")
# Keep substring matching to redact compound driver keys like db_password.
# Braced ODBC values may contain escaped closing braces (`}}`).
_PASSWORD_KV_RE = re.compile(
    r"(?i)((?:password|pwd|client_secret|access_token)\s*=\s*)"
    r"('[^']*'|\{(?:[^}]|\}\})*\}|[^\s]+)"
)


def normalize_host(host: str) -> str:
    """Normalize an IP/DNS host for exact allowlist matching."""
    candidate = host.strip()
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    # Check after unwrapping so a bracketed-empty host is rejected.
    if not candidate or candidate.startswith("/"):
        raise ValueError("host must be a TCP hostname or IP address")
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        # DNS names are case-insensitive; a final dot only marks the DNS root.
        return candidate.rstrip(".").lower()


def parse_host_allowlist(value: str) -> Optional[set[tuple[str, Optional[int]]]]:
    """Parse comma-separated host[:port] entries.

    ``None`` means the explicit unrestricted ``*`` setting; a host-only entry
    allows any port on that host.

    Raises:
        ValueError: An entry is malformed or ``*`` is mixed with hosts.
    """
    entries = [entry.strip() for entry in value.split(",") if entry.strip()]
    # Mixing * with hosts looks like a narrowing but actually disables the
    # restriction, so reject the ambiguous configuration.
    if UNRESTRICTED in entries:
        if len(entries) > 1:
            raise ValueError(f"'{UNRESTRICTED}' must be the only entry")
        return None
    targets: set[tuple[str, Optional[int]]] = set()
    for entry in entries:
        host, port = entry, None
        if entry.startswith("["):
            closing = entry.find("]")
            if closing < 0:
                raise ValueError("invalid bracketed IPv6 address")
            host, suffix = entry[1:closing], entry[closing + 1 :]
            if suffix:
                if not suffix.startswith(":"):
                    raise ValueError("invalid characters after IPv6 address")
                port = int(suffix[1:])
        elif entry.count(":") == 1:
            host, port_text = entry.rsplit(":", 1)
            port = int(port_text)
        elif entry.count(":") > 1:
            # Unbracketed IPv6 with a port is ambiguous with a valid IPv6
            # address; requiring brackets prevents silently widening access.
            raise ValueError("IPv6 entries must be bracketed, e.g. [2001:db8::1]:5432")
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("port must be between 1 and 65535")
        targets.add((normalize_host(host), port))
    return targets


def allowlist_from_env(
    env_var: str, disabled_detail: str
) -> Optional[set[tuple[str, Optional[int]]]]:
    """Read an exact-host allowlist from the environment.

    Returns ``None`` for the explicit unrestricted ``*`` setting. Raises
    HTTP 403 when unset/empty and HTTP 500 for an invalid configuration.
    """
    try:
        allowed = parse_host_allowlist(os.environ.get(env_var, ""))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"{env_var} is invalid") from exc
    if allowed == set():
        raise HTTPException(status_code=403, detail=disabled_detail)
    return allowed


def host_port_allowed(
    allowed: set[tuple[str, Optional[int]]], host: str, port: Optional[int]
) -> bool:
    """Check exact host/port; host-only entries allow any port.

    A ``None`` target port (used for SQL Server named instances) matches only
    an allowlist entry with no port.
    """
    host = normalize_host(host)
    return (host, port) in allowed or (host, None) in allowed


def scrub_secrets(message: str, secrets: Iterable[str] = ()) -> str:
    """Redact URL credentials, credential-like key/value pairs, and known literals."""
    # Match compound names too (e.g. db_password=); drivers may use them in
    # connection error text.
    scrubbed = _PASSWORD_URL_RE.sub(r"\1****@", message)
    scrubbed = _PASSWORD_KV_RE.sub(r"\1****", scrubbed)
    for secret in secrets:
        if secret:
            scrubbed = scrubbed.replace(secret, "****")
    return scrubbed


def json_safe(value: Any) -> Any:
    """Convert database values to JSON-safe equivalents.

    Integers outside JavaScript's safe range become strings so clients do not
    round primary keys and then submit a key that cannot match the source row.
    """
    if value is None or isinstance(value, (bool, float, str)):
        return value
    if isinstance(value, int):
        return value if -(2**53) < value < 2**53 else str(value)
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (bytes, memoryview)):
        return bytes(value).hex()
    return str(value)


def require_features(geojson: Optional[dict]) -> list[dict]:
    """Validate that a GeoJSON payload contains a non-empty, bounded feature list."""
    features = geojson.get("features") if geojson else None
    if not isinstance(features, list) or not features:
        raise HTTPException(status_code=400, detail="No features to write.")
    if len(features) > vector_ops.MAX_FEATURES:
        raise HTTPException(
            status_code=413, detail=f"Layer exceeds the {vector_ops.MAX_FEATURES}-feature limit"
        )
    return features


@dataclass(frozen=True)
class RowChange:
    """One planned insert or update, including which stored values need writing."""

    key: Any
    geometry: Optional[dict]
    values: dict[str, Any]
    geometry_changed: bool = True


@dataclass(frozen=True)
class FeatureDiff:
    """Ordered row changes for a write: updates, inserts, deletes, and skips."""

    updates: list[RowChange]
    inserts: list[RowChange]
    deletes: list[Any]
    skipped_fields: list[str]


def plan_feature_diff(
    features: list[dict],
    *,
    primary_key: str,
    writable_columns: list[str],
    existing_rows: dict[Any, tuple[Optional[dict], dict[str, Any]]],
    pk_is_generated: bool,
    insert_explicit_key: bool,
    baseline_keys: Optional[list],
    capabilities: Optional[dict[str, bool]],
    table_label: str,
    unchanged_geometry_keys: Optional[list] = None,
    changed_columns: Optional[dict[Any, list[str]]] = None,
) -> FeatureDiff:
    """Plan row-level changes without executing database-specific SQL.

    A feature's key is its primary-key property, falling back to ``feature.id``
    when an editor cleared the property; that key both matches existing rows and
    is inserted explicitly when ``insert_explicit_key`` allows. Deletes are
    scoped to the supplied baseline so concurrent inserts survive. Updates carry
    only changed writable columns and omit geometry when it is unchanged or its
    key is listed in ``unchanged_geometry_keys``. When ``changed_columns`` names
    a key, its update is further limited to those client-edited columns, so a
    stale loaded value cannot overwrite a newer stored one; inserts still use
    every submitted writable property. Capabilities are caller-provided
    consistency hints, not authorization; database grants remain the access-control
    boundary.
    """
    writable = set(writable_columns)
    existing = set(existing_rows)
    unchanged = set(unchanged_geometry_keys or [])
    edited_columns = {key: set(columns) for key, columns in (changed_columns or {}).items()}
    kept: set[Any] = set()
    updates: list[RowChange] = []
    inserts: list[RowChange] = []
    skipped: set[str] = set()
    # Callers may forward layer capabilities to prevent accidental edits, but
    # requests can omit or replace them; database grants must enforce access.
    caps = capabilities or {}
    for feature in features:
        properties = feature.get("properties") or {}
        skipped.update(key for key in properties if key not in writable and key != primary_key)
        columns = [column for column in writable_columns if column in properties]
        geometry = feature.get("geometry")
        # Editors may clear a key property while preserving feature.id for
        # matching an existing row.
        property_key = properties.get(primary_key)
        key = property_key if property_key is not None else feature.get("id")
        if key is not None and key in existing:
            kept.add(key)
            stored_geometry, stored_values = existing_rows[key]
            geometry_changed = key not in unchanged and geometry != stored_geometry
            edited = edited_columns.get(key)
            values = {
                column: properties[column]
                for column in columns
                if (edited is None or column in edited)
                and properties[column] != stored_values.get(column)
            }
            if not geometry_changed and not values:
                # The client submits the whole layer; skipping unchanged rows
                # avoids needless UPDATE triggers and MVCC churn.
                continue
            if not caps.get("update", True):
                raise HTTPException(
                    status_code=403, detail="Layer capability excludes feature updates."
                )
            updates.append(RowChange(key, geometry, values, geometry_changed))
        else:
            # A non-null key that is absent from the table is inserted
            # explicitly so client-assigned keys survive; identity/default
            # columns are left to the database when the key is dropped.
            values = {column: properties[column] for column in columns}
            explicit_key = key if key is not None and insert_explicit_key else None
            if explicit_key is None and not pk_is_generated:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Feature without a '{primary_key}' value cannot be inserted: "
                        f"{table_label}'s primary key has no default or identity."
                    ),
                )
            if not caps.get("create", True):
                raise HTTPException(
                    status_code=403, detail="Layer capability excludes feature creation."
                )
            if explicit_key is not None:
                kept.add(explicit_key)
            inserts.append(RowChange(explicit_key, geometry, values))
    deletable = existing if baseline_keys is None else existing & set(baseline_keys)
    deletes = sorted(deletable - kept, key=str)
    if deletes and not caps.get("delete", True):
        raise HTTPException(status_code=403, detail="Layer capability excludes feature deletion.")
    return FeatureDiff(updates, inserts, deletes, sorted(skipped))
