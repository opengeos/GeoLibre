"""Add enterprise account lifecycle, TOTP MFA, audit log, and storage quota tables.

Revision ID: 0002_enterprise_lifecycle_and_audit
Revises: 0001_initial_schema
Create Date: 2026-11-23 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import geolibre_server_api.account_lifecycle as _lifecycle
from alembic import op

revision: str = "0002_enterprise_lifecycle_and_audit"
down_revision: str | Sequence[str] | None = "0001_initial_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW_TABLES = (
    _lifecycle.AccountEmailVerification.__table__,
    _lifecycle.AccountLifecycleToken.__table__,
    _lifecycle.AccountMfaTotp.__table__,
    _lifecycle.AuditLogEntry.__table__,
    _lifecycle.ProjectVersionUsage.__table__,
)


def upgrade() -> None:
    bind = op.get_bind()
    for table in _NEW_TABLES:
        table.create(bind=bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_NEW_TABLES):
        table.drop(bind=bind, checkfirst=True)
