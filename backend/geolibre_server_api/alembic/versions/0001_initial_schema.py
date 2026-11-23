"""Initial baseline schema for geolibre-server-api.

This baseline revision bootstraps fresh databases from the current SQLAlchemy
models via ``Base.metadata.create_all`` and applies the additive pre-Alembic
schema upgrades and indexes idempotently.

Legacy pre-Alembic databases must run ``alembic upgrade head`` so all additive
schema upgrades and indexes are applied. Use
``alembic stamp 0001_initial_schema`` only after verifying that the database
schema already matches this baseline in full. Before introducing a future
revision (``0002+``) that alters existing model tables, either freeze this
baseline to explicit ``op.*`` DDL or guard the additive operations in the new
revision so fresh-database upgrades remain idempotent.

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
    if bind.dialect.name in {"sqlite", "postgresql"}:
        from geolibre_server_api.main import (
            upgrade_postgresql_schema,
            upgrade_sqlite_schema,
        )

        if bind.dialect.name == "sqlite":
            upgrade_sqlite_schema(bind)
        else:
            upgrade_postgresql_schema(bind)
    for index in (*OAUTH_INDEXES, PENDING_TRANSFER_INDEX, *FEDERATED_IDENTITY_INDEXES):
        index.create(bind=bind, checkfirst=True)


def downgrade() -> None:
    raise NotImplementedError(
        "Downgrading the baseline schema would drop all data; restore from backup instead."
    )
