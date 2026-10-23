"""Enterprise sign-in ORM models: account security, org policy, and federated identity.

Foreign keys are plain strings with no relationships, like ``auth_models``.
"""

from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from geolibre_server_api.auth_models import Base


class AccountSecurity(Base):
    """Per-account security state, created lazily (no row = active, no counters)."""

    __tablename__ = "account_security"

    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    status: Mapped[str] = mapped_column(String(16), default="active")
    deactivated_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    password_changed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[int | None] = mapped_column(Integer, nullable=True)
    managed_by_organization_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True
    )


class OrganizationSecurityPolicy(Base):
    """One organization's security policy; unset values impose no constraint."""

    __tablename__ = "organization_security_policies"

    organization_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    idle_timeout_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    absolute_session_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    admin_reauth_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    password_min_length: Mapped[int | None] = mapped_column(Integer, nullable=True)
    password_min_classes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    password_max_age_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lockout_threshold: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lockout_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    admin_ip_allowlist_json: Mapped[str] = mapped_column(Text, default="[]")
    updated_at: Mapped[int] = mapped_column(Integer)


class OrganizationIdentityProvider(Base):
    """An organization's OpenID Connect provider (one per organization)."""

    __tablename__ = "organization_identity_providers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE"), unique=True
    )
    protocol: Mapped[str] = mapped_column(String(8), default="oidc")
    issuer: Mapped[str] = mapped_column(String(512))
    client_id: Mapped[str] = mapped_column(String(255))
    # Stored unencrypted, at the same trust level as the rest of the database.
    client_secret: Mapped[str] = mapped_column(Text)
    authorization_endpoint: Mapped[str] = mapped_column(Text)
    token_endpoint: Mapped[str] = mapped_column(Text)
    jwks_uri: Mapped[str] = mapped_column(Text)
    token_endpoint_auth_method: Mapped[str] = mapped_column(String(32))
    scopes: Mapped[str] = mapped_column(Text)
    username_claim: Mapped[str] = mapped_column(String(64))
    email_claim: Mapped[str] = mapped_column(String(64))
    groups_claim: Mapped[str | None] = mapped_column(String(64), nullable=True)
    default_role: Mapped[str] = mapped_column(String(16))
    role_mappings_json: Mapped[str] = mapped_column(Text, default="[]")
    group_mappings_json: Mapped[str] = mapped_column(Text, default="[]")
    require_mfa: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_builtin_accounts: Mapped[bool] = mapped_column(Boolean, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    break_glass_account_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    jwks_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    jwks_fetched_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[int] = mapped_column(Integer)


class FederatedIdentity(Base):
    """Links an external subject (an OIDC ``sub`` or a proxy user) to an account."""

    __tablename__ = "federated_identities"
    __table_args__ = (UniqueConstraint("provider_key", "subject", name="uq_federated_identity"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    # The provider id, or the literal "trusted-proxy".
    provider_key: Mapped[str] = mapped_column(String(64))
    provider_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("organization_identity_providers.id", ondelete="CASCADE"),
        nullable=True,
    )
    subject: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[int] = mapped_column(Integer)
    last_login_at: Mapped[int] = mapped_column(Integer)
    # Refreshed at every OIDC sign-in so SCIM can adopt the account (never set
    # for proxy identities): the lowercased username claim, and the lowercased
    # email claim only while the provider asserts ``email_verified``.
    claimed_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    claimed_email: Mapped[str | None] = mapped_column(String(320), nullable=True)


# Separate metadata objects so startup can add them to an existing table too.
FEDERATED_IDENTITY_INDEXES = (
    # One link per account and provider: SSO never links a second subject to an
    # account (a concurrent second link fails here).
    Index(
        "uq_federated_identity_account_provider",
        FederatedIdentity.__table__.c.account_id,
        FederatedIdentity.__table__.c.provider_key,
        unique=True,
    ),
    Index(
        "ix_federated_identities_claimed_username",
        FederatedIdentity.__table__.c.provider_id,
        FederatedIdentity.__table__.c.claimed_username,
    ),
    Index(
        "ix_federated_identities_claimed_email",
        FederatedIdentity.__table__.c.provider_id,
        FederatedIdentity.__table__.c.claimed_email,
    ),
)


class OidcLoginState(Base):
    """One outstanding redirect to an identity provider, bound to a consent interaction."""

    __tablename__ = "oidc_login_states"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    state_digest: Mapped[str] = mapped_column(String(64), unique=True)
    nonce: Mapped[str] = mapped_column(String(64))
    code_verifier: Mapped[str] = mapped_column(String(128))
    provider_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("organization_identity_providers.id", ondelete="CASCADE")
    )
    interaction_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("oauth_authorization_codes.id", ondelete="CASCADE")
    )
    label: Mapped[str] = mapped_column(String(100))
    max_age: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expires_at: Mapped[int] = mapped_column(Integer, index=True)
    consumed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ScimToken(Base):
    """A bearer token an identity provider uses to provision one organization over SCIM."""

    __tablename__ = "scim_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    created_by_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("accounts.id", ondelete="CASCADE")
    )
    digest: Mapped[str] = mapped_column(String(64), unique=True)
    label: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[int] = mapped_column(Integer)
    last_used_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    revoked_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ScimUser(Base):
    """An account provisioned into (or linked to) an organization over SCIM."""

    __tablename__ = "scim_users"
    __table_args__ = (UniqueConstraint("organization_id", "user_name", name="uq_scim_user_name"),)

    organization_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    # Stored lowercased; SCIM userName comparisons are case-insensitive.
    user_name: Mapped[str] = mapped_column(String(255))
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # The SCIM representation only; never copied to Account.email.
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[int] = mapped_column(Integer)


class ScimGroup(Base):
    """Marks a group as provisioned over SCIM by its organization's identity provider."""

    __tablename__ = "scim_groups"

    group_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    organization_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[int] = mapped_column(Integer)
