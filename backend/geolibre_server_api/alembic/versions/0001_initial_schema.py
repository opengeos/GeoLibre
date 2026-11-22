"""Initial baseline schema for geolibre-server-api.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-11-22 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import geolibre_server_api.auth_models  # noqa: F401
import geolibre_server_api.enterprise_models  # noqa: F401
import geolibre_server_api.org_models  # noqa: F401
import geolibre_server_api.project_models  # noqa: F401
from alembic import context, op
from geolibre_server_api.auth_models import OAUTH_INDEXES, Base
from geolibre_server_api.enterprise_models import FEDERATED_IDENTITY_INDEXES
from geolibre_server_api.main import upgrade_postgresql_schema, upgrade_sqlite_schema
from geolibre_server_api.project_models import PENDING_TRANSFER_INDEX

revision: str = "0001_initial_schema"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind, checkfirst=True)
    if context.is_offline_mode():
        # In offline --sql mode, create_all already emits table-associated indexes;
        # emitting them again creates duplicate CREATE INDEX statements.
        return
    if bind.dialect.name == "sqlite":
        upgrade_sqlite_schema(bind.engine)
    elif bind.dialect.name == "postgresql":
        upgrade_postgresql_schema(bind.engine)
    for index in (*OAUTH_INDEXES, PENDING_TRANSFER_INDEX, *FEDERATED_IDENTITY_INDEXES):
        index.create(bind=bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind, checkfirst=True)
