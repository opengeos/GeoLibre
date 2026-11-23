"""Per-request tenant / session isolation for multi-tenant sidecar deployments.

When ``X-GeoLibre-Tenant`` (or ``X-GeoLibre-Session``) is provided, or when
``GEOLIBRE_MULTI_TENANT=1`` requires it, sidecar jobs, MSSQL sessions, and
optional per-tenant workspaces (``GEOLIBRE_TENANT_WORKSPACES_ROOT``) are
strictly partitioned so tenants cannot inspect, cancel, or hijack each other's
state.
"""

from __future__ import annotations

import os
import re
from contextvars import ContextVar, Token
from pathlib import Path

from fastapi import HTTPException

_TENANT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_CURRENT_TENANT: ContextVar[str | None] = ContextVar("geolibre_tenant", default=None)


def is_multi_tenant_enabled() -> bool:
    """Return True when the sidecar requires an explicit tenant header."""
    return os.environ.get("GEOLIBRE_MULTI_TENANT", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def normalize_tenant_id(raw: str | None) -> str | None:
    """Validate and return a normalized tenant identifier, or None if absent."""
    if raw is None:
        return None
    cleaned = raw.strip()
    if not cleaned:
        return None
    if not _TENANT_ID_RE.fullmatch(cleaned):
        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid X-GeoLibre-Tenant header; expected 1-64 ASCII letters, "
                "digits, hyphens, or underscores."
            ),
        )
    return cleaned


def get_current_tenant() -> str | None:
    """Return the active request's tenant id, or None in single-user mode."""
    return _CURRENT_TENANT.get()


def set_current_tenant(tenant_id: str | None) -> Token[str | None]:
    """Bind ``tenant_id`` to the current execution context."""
    return _CURRENT_TENANT.set(tenant_id)


def reset_current_tenant(token: Token[str | None]) -> None:
    """Restore the previous tenant context binding."""
    _CURRENT_TENANT.reset(token)


def is_tenant_workspaces_configured() -> bool:
    """Return True when per-tenant workspace confinement is configured."""
    return bool(os.environ.get("GEOLIBRE_TENANT_WORKSPACES_ROOT", "").strip())


def tenant_workspace_root(tenant_id: str | None = None) -> Path | None:
    """Return the confined workspace directory for the active tenant, if configured."""
    root = os.environ.get("GEOLIBRE_TENANT_WORKSPACES_ROOT", "").strip()
    if not root:
        return None
    active = tenant_id if tenant_id is not None else get_current_tenant()
    if not active:
        return None
    base = Path(root).expanduser().resolve()
    candidate = (base / active).resolve()
    if not candidate.is_relative_to(base):
        raise HTTPException(status_code=400, detail="Invalid tenant workspace path")
    return candidate
