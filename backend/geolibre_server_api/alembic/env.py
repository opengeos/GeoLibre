"""Alembic migration environment for geolibre-server-api."""

from __future__ import annotations

import os
from logging.config import fileConfig

# Import every model module so Base.metadata registers all tables and indexes.
import geolibre_server_api.auth_models  # noqa: F401
import geolibre_server_api.enterprise_models  # noqa: F401
import geolibre_server_api.org_models  # noqa: F401
import geolibre_server_api.project_models  # noqa: F401
from alembic import context
from geolibre_server_api.auth_models import Base
from sqlalchemy import engine_from_config, pool

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _database_url() -> str:
    return (
        os.getenv("GEOLIBRE_DATABASE_URL")
        or config.get_main_option("sqlalchemy.url")
        or "sqlite:///./geolibre-server-api.db"
    )


def run_migrations_offline() -> None:
    """Run migrations in offline mode without an active DB connection."""
    url = _database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=url.startswith("sqlite"),
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against a live SQLAlchemy engine."""
    url = _database_url()
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = url
    connectable = engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=url.startswith("sqlite"),
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
