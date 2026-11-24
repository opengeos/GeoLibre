"""Encrypt organization identity provider client secrets at rest.

Rewrites every plaintext ``organization_identity_providers.client_secret`` as a
Fernet ciphertext under the first key in ``GEOLIBRE_SECRET_KEYS`` (and re-keys
values written under an older key). Without a key the upgrade refuses to run
against stored secrets unless ``GEOLIBRE_ALLOW_PLAINTEXT_SECRETS`` explicitly
opts out and ``GEOLIBRE_PUBLIC_URL`` names a loopback development host.

The column type is unchanged (TEXT), so the downgrade decrypts back to
plaintext with the same key.

Revision ID: 0003_encrypt_idp_secrets
Revises: 0002_enterprise_lifecycle
Create Date: 2026-11-23 00:00:00.000000
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op
from geolibre_server_api.secret_crypto import (
    SECRET_KEYS_ENV,
    SecretKeyError,
    decrypt_secret,
    is_encrypted,
    is_production_url,
    plaintext_secrets_enabled,
    reencrypt_stored_secrets,
    secret_ciphers,
)

revision: str = "0003_encrypt_idp_secrets"
down_revision: str | Sequence[str] | None = "0002_enterprise_lifecycle"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger("alembic.runtime.migration")

_providers = sa.table(
    "organization_identity_providers",
    sa.column("id", sa.String(36)),
    sa.column("client_secret", sa.Text()),
)


def _has_table(bind) -> bool:
    return sa.inspect(bind).has_table("organization_identity_providers")


def upgrade() -> None:
    """Encrypt stored identity provider client secrets in place."""
    if context.is_offline_mode():
        # Encryption needs the key and the row values; emit no SQL for them.
        return
    bind = op.get_bind()
    if not _has_table(bind):
        return
    if secret_ciphers() is None:
        stored = bind.scalar(
            sa.select(sa.func.count())
            .select_from(_providers)
            .where(_providers.c.client_secret.is_not(None))
        )
        public_url = os.getenv("GEOLIBRE_PUBLIC_URL", "http://localhost:8000")
        plaintext_allowed = not is_production_url(public_url) and plaintext_secrets_enabled()
        if stored and not plaintext_allowed:
            raise SecretKeyError(
                f"set {SECRET_KEYS_ENV} before upgrading: {stored} identity provider "
                "secret(s) would stay unencrypted. Only loopback development may "
                "opt out with GEOLIBRE_ALLOW_PLAINTEXT_SECRETS=1"
            )
        if stored:
            logger.warning(
                "%s is not set; leaving %d development identity provider secret(s) unencrypted",
                SECRET_KEYS_ENV,
                stored,
            )
    reencrypt_stored_secrets(bind, _providers, _providers.c.client_secret)


def downgrade() -> None:
    """Decrypt stored identity provider client secrets back to plaintext."""
    if context.is_offline_mode():
        return
    bind = op.get_bind()
    if not _has_table(bind):
        return
    rows = bind.execute(sa.select(_providers.c.id, _providers.c.client_secret)).all()
    for row_id, value in rows:
        if is_encrypted(value):
            bind.execute(
                sa.update(_providers)
                .where(_providers.c.id == row_id)
                .values(client_secret=decrypt_secret(value))
            )
