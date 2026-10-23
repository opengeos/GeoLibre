"""Authentication ORM models for the projects and identity API.

The project models remain in ``main.py`` and share this module's ``Base``
metadata. Keeping the identity models here lets ``auth.py`` provide reusable
FastAPI dependencies and routes without importing ``main.py``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

if TYPE_CHECKING:
    from geolibre_server_api.project_models import Project  # noqa: F401


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str | None] = mapped_column(String(39), unique=True, nullable=True)
    # Optional contact address; organization and group invitations can target it.
    email: Mapped[str | None] = mapped_column(String(320), unique=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(32))
    # Projects carry two account FKs (owner_id, created_by_id), so the join is
    # explicit. Organization-owned projects outlive their creator: owner_id is
    # ON DELETE SET NULL rather than a delete-orphan cascade.
    projects: Mapped[list["Project"]] = relationship(
        back_populates="owner", foreign_keys="Project.owner_id"
    )


class Token(Base):
    """A personal API token's identity row.

    Only the SHA-256 digest of the raw token is stored. Scope, expiry, and
    revocation metadata live in ``PersonalTokenPolicy`` so existing databases
    do not need columns added to the legacy ``tokens`` table.
    """

    __tablename__ = "tokens"
    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[str] = mapped_column(String(32))


class OAuthAuthorizationCode(Base):
    """A pending or issued authorization-code interaction."""

    __tablename__ = "oauth_authorization_codes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_id: Mapped[str | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), nullable=True, index=True
    )
    client_id: Mapped[str] = mapped_column(String(64))
    redirect_uri: Mapped[str] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(Text)
    code_challenge: Mapped[str] = mapped_column(String(128))
    state: Mapped[str] = mapped_column(String(512))
    browser_cookie_digest: Mapped[str | None] = mapped_column(String(64), nullable=True)
    csrf_digest: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(100))
    interaction_expires_at: Mapped[int] = mapped_column(Integer)
    code_digest: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    code_expires_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    approved_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    consumed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    session_id: Mapped[str | None] = mapped_column(
        ForeignKey("oauth_sessions.id", ondelete="SET NULL"), nullable=True
    )
    authenticated_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class OAuthSession(Base):
    """One OAuth grant family and its absolute lifetime."""

    __tablename__ = "oauth_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    client_id: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16))
    scope: Mapped[str] = mapped_column(Text)
    label: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[int] = mapped_column(Integer)
    last_used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expires_at: Mapped[int] = mapped_column(Integer)
    revoked_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rotation_version: Mapped[int] = mapped_column(Integer, default=0)
    authenticated_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class OAuthAccessToken(Base):
    """A short-lived access token belonging to an OAuth session family."""

    __tablename__ = "oauth_access_tokens"

    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("oauth_sessions.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)


class OAuthRefreshToken(Base):
    """One refresh-token generation retained for replay detection."""

    __tablename__ = "oauth_refresh_tokens"

    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("oauth_sessions.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer)
    consumed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    successor_digest: Mapped[str | None] = mapped_column(String(64), nullable=True)


# Keep these indexes as separate metadata objects so startup can add them to
# existing OAuth tables as well as create them with fresh databases.
OAUTH_INDEXES = (
    Index(
        "ix_oauth_authorization_codes_browser_cookie_digest",
        OAuthAuthorizationCode.__table__.c.browser_cookie_digest,
    ),
    Index(
        "ix_oauth_authorization_codes_interaction_expires_at",
        OAuthAuthorizationCode.__table__.c.interaction_expires_at,
    ),
    Index(
        "ix_oauth_authorization_codes_session_id",
        OAuthAuthorizationCode.__table__.c.session_id,
    ),
    Index("ix_oauth_sessions_expires_at", OAuthSession.__table__.c.expires_at),
    Index("ix_oauth_access_tokens_expires_at", OAuthAccessToken.__table__.c.expires_at),
)


class PersonalTokenPolicy(Base):
    """Policy metadata for one personal API token.

    Pre-existing tokens receive a legacy policy with all project scopes and no
    expiry when first used, preserving their existing permissions.
    """

    __tablename__ = "personal_token_policies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    token_digest: Mapped[str] = mapped_column(
        ForeignKey("tokens.digest", ondelete="CASCADE"), unique=True
    )
    label: Mapped[str] = mapped_column(String(100))
    scope: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Checked on every PAT request but not yet written: PAT revocation deletes
    # the Token row and cascades this policy. OAuth revocation uses its separate
    # session family.
    revoked_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    legacy: Mapped[bool] = mapped_column(Boolean, default=False)
