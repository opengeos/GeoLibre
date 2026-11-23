"""Add enterprise account lifecycle, TOTP MFA, audit log, and storage quota tables.

Revision ID: 0002_enterprise_lifecycle
Revises: 0001_initial_schema
Create Date: 2026-11-23 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_enterprise_lifecycle"
down_revision: str | Sequence[str] | None = "0001_initial_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "account_email_verifications",
        sa.Column("account_id", sa.String(length=36), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("verified_at", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("account_id"),
    )
    op.create_table(
        "account_lifecycle_tokens",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("account_id", sa.String(length=36), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("token_digest", sa.String(length=64), nullable=False),
        sa.Column("target_email", sa.String(length=320), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("consumed_at", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_digest"),
    )
    op.create_index(
        "ix_account_lifecycle_tokens_account_id", "account_lifecycle_tokens", ["account_id"]
    )
    op.create_index("ix_account_lifecycle_tokens_purpose", "account_lifecycle_tokens", ["purpose"])
    op.create_index(
        "ix_account_lifecycle_tokens_expires_at", "account_lifecycle_tokens", ["expires_at"]
    )
    op.create_table(
        "account_mfa_totp",
        sa.Column("account_id", sa.String(length=36), nullable=False),
        sa.Column("secret_b32", sa.String(length=64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("backup_code_hashes_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("confirmed_at", sa.Integer(), nullable=True),
        sa.Column("last_used_totp_step", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("account_id"),
    )
    op.create_table(
        "audit_log_entries",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("timestamp", sa.Integer(), nullable=False),
        sa.Column("actor_account_id", sa.String(length=36), nullable=True),
        sa.Column("organization_id", sa.String(length=36), nullable=True),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("resource_type", sa.String(length=64), nullable=False),
        sa.Column("resource_id", sa.String(length=64), nullable=True),
        sa.Column("detail_json", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_log_entries_timestamp", "audit_log_entries", ["timestamp"])
    op.create_index(
        "ix_audit_log_entries_actor_account_id", "audit_log_entries", ["actor_account_id"]
    )
    op.create_index(
        "ix_audit_log_entries_organization_id", "audit_log_entries", ["organization_id"]
    )
    op.create_index("ix_audit_log_entries_action", "audit_log_entries", ["action"])
    op.create_table(
        "project_version_usage",
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id", "number"),
    )


def downgrade() -> None:
    op.drop_table("project_version_usage")
    op.drop_index("ix_audit_log_entries_action", table_name="audit_log_entries")
    op.drop_index("ix_audit_log_entries_organization_id", table_name="audit_log_entries")
    op.drop_index("ix_audit_log_entries_actor_account_id", table_name="audit_log_entries")
    op.drop_index("ix_audit_log_entries_timestamp", table_name="audit_log_entries")
    op.drop_table("audit_log_entries")
    op.drop_table("account_mfa_totp")
    op.drop_index("ix_account_lifecycle_tokens_expires_at", table_name="account_lifecycle_tokens")
    op.drop_index("ix_account_lifecycle_tokens_purpose", table_name="account_lifecycle_tokens")
    op.drop_index("ix_account_lifecycle_tokens_account_id", table_name="account_lifecycle_tokens")
    op.drop_table("account_lifecycle_tokens")
    op.drop_table("account_email_verifications")
