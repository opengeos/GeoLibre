"""Enterprise account lifecycle, TOTP MFA, immutable audit logging, and storage quotas.

Adds:
- Email verification and single-use password reset token flows (SHA-256 hashed
  tokens with configurable delivery callback).
- RFC 6238 TOTP MFA (stdlib ``hmac``/``hashlib``) with single-use hashed backup
  codes for local and break-glass accounts.
- Append-only immutable audit log table (``audit_log_entries``) and organization
  audit log query route.
- Per-user and per-organization project storage usage accounting and quota
  enforcement.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import struct
import uuid
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import ForeignKey, Integer, String, Text, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from geolibre_server_api.auth import (
    AuthPrincipal,
    get_clock,
    get_session,
    iso_ts,
    password_hash,
    password_matches,
    require_any_scope,
    required_principal,
    token_digest,
)
from geolibre_server_api.auth_models import Account, Base
from geolibre_server_api.policy import (
    effective_policy,
    ensure_account_security,
    is_deactivated,
    password_policy_error,
    require_organization_admin,
    revoke_account_credentials,
)
from geolibre_server_api.project_models import Project

logger = logging.getLogger(__name__)

EMAIL_VERIFY_TTL_SECONDS = 24 * 3600
PASSWORD_RESET_TTL_SECONDS = 3600
TOTP_STEP_SECONDS = 30
TOTP_DIGITS = 6
BACKUP_CODE_COUNT = 8


# ---------------------------------------------------------------------------
# ORM models
# ---------------------------------------------------------------------------


class AccountEmailVerification(Base):
    """Records the email address last verified by an account."""

    __tablename__ = "account_email_verifications"

    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    email: Mapped[str] = mapped_column(String(320))
    verified_at: Mapped[int] = mapped_column(Integer)


class AccountLifecycleToken(Base):
    """Single-use SHA-256 hashed token for email verification or password reset."""

    __tablename__ = "account_lifecycle_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    purpose: Mapped[str] = mapped_column(String(32), index=True)
    token_digest: Mapped[str] = mapped_column(String(64), unique=True)
    target_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[int] = mapped_column(Integer, index=True)
    consumed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AccountMfaTotp(Base):
    """Per-account RFC 6238 TOTP configuration and hashed backup codes."""

    __tablename__ = "account_mfa_totp"

    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    secret_b32: Mapped[str] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(default=False)
    backup_code_hashes_json: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[int] = mapped_column(Integer)
    confirmed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_used_totp_step: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AuditLogEntry(Base):
    """Append-only immutable audit log entry for enterprise security events."""

    __tablename__ = "audit_log_entries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    timestamp: Mapped[int] = mapped_column(Integer, index=True)
    actor_account_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    organization_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    resource_type: Mapped[str] = mapped_column(String(64))
    resource_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail_json: Mapped[str] = mapped_column(Text, default="{}")


class ProjectVersionUsage(Base):
    """Stored byte size per project version for per-user and per-org quotas."""

    __tablename__ = "project_version_usage"

    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    number: Mapped[int] = mapped_column(Integer, primary_key=True)
    size_bytes: Mapped[int] = mapped_column(Integer)


# ---------------------------------------------------------------------------
# Audit logging & storage quota helpers
# ---------------------------------------------------------------------------


def record_audit_event(
    session: Session,
    *,
    timestamp: int,
    actor_account_id: str | None,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    organization_id: str | None = None,
    detail: dict[str, Any] | None = None,
) -> AuditLogEntry:
    """Append an immutable audit log entry to the current database session."""
    entry = AuditLogEntry(
        id=str(uuid.uuid4()),
        timestamp=timestamp,
        actor_account_id=actor_account_id,
        organization_id=organization_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        detail_json=json.dumps(detail or {}, sort_keys=True),
    )
    session.add(entry)
    return entry


def audit_entry_json(entry: AuditLogEntry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "timestamp": iso_ts(entry.timestamp),
        "actorAccountId": entry.actor_account_id,
        "organizationId": entry.organization_id,
        "action": entry.action,
        "resourceType": entry.resource_type,
        "resourceId": entry.resource_id,
        "detail": json.loads(entry.detail_json or "{}"),
    }


def personal_storage_bytes(session: Session, account_id: str) -> int:
    total = session.scalar(
        select(func.coalesce(func.sum(ProjectVersionUsage.size_bytes), 0))
        .join(Project, Project.id == ProjectVersionUsage.project_id)
        .where(Project.owner_id == account_id, Project.organization_id.is_(None))
    )
    return int(total or 0)


def organization_storage_bytes(session: Session, organization_id: str) -> int:
    total = session.scalar(
        select(func.coalesce(func.sum(ProjectVersionUsage.size_bytes), 0))
        .join(Project, Project.id == ProjectVersionUsage.project_id)
        .where(Project.organization_id == organization_id)
    )
    return int(total or 0)


def backfill_project_version_usage(session: Session, object_storage: Any) -> int:
    """Populate ``project_version_usage`` rows for pre-upgrade versions using object storage.

    Skips versions whose object size cannot be read (so transient storage errors
    never record a permanent zero and are retried on the next startup) and wraps
    each insert in a savepoint so concurrent instance startups cannot fail on a
    duplicate primary key.
    """
    from geolibre_server_api.project_models import Version

    missing = session.scalars(
        select(Version)
        .outerjoin(
            ProjectVersionUsage,
            (ProjectVersionUsage.project_id == Version.project_id)
            & (ProjectVersionUsage.number == Version.number),
        )
        .where(ProjectVersionUsage.project_id.is_(None))
    ).all()
    if not missing:
        return 0
    inserted = 0
    size_fn = getattr(object_storage, "size", None)
    for version in missing:
        try:
            if callable(size_fn):
                measured = size_fn(version.object_key)
                if measured is None:
                    continue
                size_bytes = int(measured)
            else:
                payload = object_storage.get(version.object_key)
                if payload is None:
                    continue
                size_bytes = len(payload)
        except Exception:
            logger.warning(
                "Skipping storage usage backfill for %s v%s due to storage read error",
                version.project_id,
                version.number,
                exc_info=True,
            )
            continue
        try:
            with session.begin_nested():
                session.add(
                    ProjectVersionUsage(
                        project_id=version.project_id,
                        number=version.number,
                        size_bytes=size_bytes,
                    )
                )
                session.flush()
            inserted += 1
        except IntegrityError:
            # Another instance backfilled this version concurrently.
            continue
    session.commit()
    return inserted


def enforce_storage_quota(
    session: Session,
    *,
    account_id: str,
    organization_id: str | None,
    incoming_bytes: int,
    user_quota_bytes: int | None,
    org_quota_bytes: int | None,
) -> None:
    """Reject a project save with 413 when the user or org storage quota would be exceeded.

    Locks the owning ``Organization`` or ``Account`` row ``FOR UPDATE`` inside
    the active transaction before reading stored usage so concurrent saves for
    the same owner serialize cleanly under PostgreSQL ``READ COMMITTED``.
    """
    from geolibre_server_api.org_models import Organization

    if organization_id is not None:
        if org_quota_bytes is not None and org_quota_bytes > 0:
            session.get(Organization, organization_id, with_for_update=True)
            used = organization_storage_bytes(session, organization_id)
            if used + incoming_bytes > org_quota_bytes:
                raise HTTPException(
                    413,
                    (
                        "organization storage quota exceeded "
                        f"({used + incoming_bytes} > {org_quota_bytes} bytes)"
                    ),
                )
        return
    if user_quota_bytes is not None and user_quota_bytes > 0:
        session.get(Account, account_id, with_for_update=True)
        used = personal_storage_bytes(session, account_id)
        if used + incoming_bytes > user_quota_bytes:
            raise HTTPException(
                413,
                f"user storage quota exceeded ({used + incoming_bytes} > {user_quota_bytes} bytes)",
            )


# ---------------------------------------------------------------------------
# RFC 6238 TOTP MFA (stdlib only)
# ---------------------------------------------------------------------------


def generate_totp_secret() -> str:
    """Generate a 160-bit RFC 4648 base32 secret without padding."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _decode_b32(secret_b32: str) -> bytes:
    cleaned = secret_b32.strip().replace(" ", "").upper()
    pad = (-len(cleaned)) % 8
    return base64.b32decode(cleaned + ("=" * pad), casefold=True)


def totp_code(secret_b32: str, timestamp: int, step: int = TOTP_STEP_SECONDS) -> str:
    """Compute a 6-digit RFC 6238 TOTP code (HMAC-SHA1) for ``timestamp``."""
    key = _decode_b32(secret_b32)
    counter = int(timestamp) // step
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code_int = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{code_int % (10**TOTP_DIGITS):0{TOTP_DIGITS}d}"


def verify_totp_step(
    secret_b32: str,
    code: str,
    timestamp: int,
    *,
    window: int = 1,
    step: int = TOTP_STEP_SECONDS,
) -> int | None:
    """Verify a 6-digit TOTP code within ``+-window`` steps and return the matched counter."""
    cleaned = code.strip().replace(" ", "")
    if len(cleaned) != TOTP_DIGITS or not cleaned.isdigit():
        return None
    base_counter = int(timestamp) // step
    for delta in range(-window, window + 1):
        counter = base_counter + delta
        if counter < 0:
            continue
        candidate = totp_code(secret_b32, counter * step, step=step)
        if hmac.compare_digest(cleaned, candidate):
            return counter
    return None


def verify_totp_code(
    secret_b32: str,
    code: str,
    timestamp: int,
    *,
    window: int = 1,
    step: int = TOTP_STEP_SECONDS,
) -> bool:
    """Verify a 6-digit TOTP code within ``+-window`` time steps in constant time."""
    return verify_totp_step(secret_b32, code, timestamp, window=window, step=step) is not None


def generate_backup_codes(count: int = BACKUP_CODE_COUNT) -> list[str]:
    """Generate 80-bit human-readable single-use MFA backup codes."""
    return ["-".join(secrets.token_hex(2) for _ in range(5)).upper() for _ in range(count)]


def _normalize_backup_code(code: str) -> str:
    return code.strip().replace(" ", "").replace("-", "").upper()


def _hash_backup_code(code: str) -> str:
    """Hash a backup code with a per-code random salt using scrypt."""
    return password_hash(_normalize_backup_code(code))


def _matches_backup_code(code: str, stored: str) -> bool:
    normalized = _normalize_backup_code(code)
    if stored.startswith("scrypt$"):
        return password_matches(normalized, stored)
    # Backwards-compatible fallback for any legacy unsalted SHA-256 hashes.
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return hmac.compare_digest(digest, stored)


def verify_account_mfa(
    session: Session,
    account_id: str,
    code: str | None,
    now_ts: int,
    *,
    commit: bool = False,
) -> tuple[bool, str | None]:
    """Check MFA for ``account_id``.

    Locks the MFA row ``FOR UPDATE`` so concurrent logins cannot consume the
    same single-use backup code twice or replay a TOTP time step (RFC 6238
    section 5.2). By default leaves committing the updated state to the caller
    so token issuance / OAuth approval commits atomically.
    """
    mfa = session.get(
        AccountMfaTotp,
        account_id,
        with_for_update=True,
        populate_existing=True,
    )
    if mfa is None or not mfa.enabled:
        return True, None
    if not code or not code.strip():
        return False, "mfa_required"
    matched_step = verify_totp_step(mfa.secret_b32, code, now_ts)
    if matched_step is not None:
        if mfa.last_used_totp_step is not None and matched_step <= mfa.last_used_totp_step:
            return False, "invalid_mfa_code"
        mfa.last_used_totp_step = matched_step
        if commit:
            session.commit()
        return True, None
    hashes: list[str] = json.loads(mfa.backup_code_hashes_json or "[]")
    for idx, stored in enumerate(hashes):
        if _matches_backup_code(code, stored):
            remaining = hashes[:idx] + hashes[idx + 1 :]
            mfa.backup_code_hashes_json = json.dumps(remaining)
            if commit:
                session.commit()
            return True, None
    return False, "invalid_mfa_code"


# ---------------------------------------------------------------------------
# Request schemas & router
# ---------------------------------------------------------------------------


class TokenConfirmBody(BaseModel):
    token: str = Field(min_length=16, max_length=256)
    model_config = {"extra": "forbid"}


class PasswordResetRequestBody(BaseModel):
    identifier: str = Field(min_length=1, max_length=320)
    model_config = {"extra": "forbid"}


class PasswordResetConfirmBody(BaseModel):
    token: str = Field(min_length=16, max_length=256)
    new_password: str = Field(alias="newPassword", min_length=8, max_length=1000)
    model_config = {"extra": "forbid", "populate_by_name": True}


class TotpCodeBody(BaseModel):
    code: str = Field(min_length=4, max_length=32)
    model_config = {"extra": "forbid"}


def _deliver_lifecycle_token(
    request: Request,
    *,
    purpose: str,
    account: Account,
    email: str | None,
    raw_token: str,
    expires_at: int,
) -> None:
    callback = getattr(request.app.state, "lifecycle_delivery", None)
    if callable(callback):
        callback(
            {
                "purpose": purpose,
                "accountId": account.id,
                "username": account.username,
                "email": email,
                "token": raw_token,
                "expiresAt": iso_ts(expires_at),
            }
        )
    else:
        logger.info(
            "Issued %s lifecycle token for account=%s (no delivery handler configured)",
            purpose,
            account.id,
        )


def build_lifecycle_router() -> APIRouter:
    """Build email verification, password reset, TOTP MFA, and audit log routes."""
    router = APIRouter()

    @router.post("/api/auth/verify-email/request", status_code=202)
    def request_email_verification(
        request: Request,
        principal: AuthPrincipal = Depends(required_principal),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        if not account.email:
            raise HTTPException(400, "account has no email address")
        now_ts = get_clock(request)()
        expires_at = now_ts + EMAIL_VERIFY_TTL_SECONDS
        raw_token = secrets.token_urlsafe(32)
        session.add(
            AccountLifecycleToken(
                id=str(uuid.uuid4()),
                account_id=account.id,
                purpose="email_verify",
                token_digest=token_digest(raw_token),
                target_email=account.email,
                created_at=now_ts,
                expires_at=expires_at,
            )
        )
        record_audit_event(
            session,
            timestamp=now_ts,
            actor_account_id=account.id,
            action="account.email_verify.request",
            resource_type="account",
            resource_id=account.id,
        )
        session.commit()
        _deliver_lifecycle_token(
            request,
            purpose="email_verify",
            account=account,
            email=account.email,
            raw_token=raw_token,
            expires_at=expires_at,
        )
        return {"status": "sent", "expiresAt": iso_ts(expires_at)}

    @router.post("/api/auth/verify-email/confirm")
    def confirm_email_verification(
        body: TokenConfirmBody,
        request: Request,
        session: Session = Depends(get_session),
    ):
        now_ts = get_clock(request)()
        digest = token_digest(body.token)
        row = session.scalar(
            select(AccountLifecycleToken).where(
                AccountLifecycleToken.token_digest == digest,
                AccountLifecycleToken.purpose == "email_verify",
            )
        )
        if row is None or row.consumed_at is not None or row.expires_at < now_ts:
            raise HTTPException(400, "invalid or expired verification token")
        account = session.get(Account, row.account_id)
        if account is None or not account.email or account.email != row.target_email:
            raise HTTPException(400, "verification token does not match current account email")
        updated = session.execute(
            update(AccountLifecycleToken)
            .where(AccountLifecycleToken.id == row.id, AccountLifecycleToken.consumed_at.is_(None))
            .values(consumed_at=now_ts)
        )
        if updated.rowcount != 1:
            session.rollback()
            raise HTTPException(400, "verification token already used")
        existing = session.get(AccountEmailVerification, account.id)
        if existing is None:
            session.add(
                AccountEmailVerification(
                    account_id=account.id, email=account.email, verified_at=now_ts
                )
            )
        else:
            existing.email = account.email
            existing.verified_at = now_ts
        record_audit_event(
            session,
            timestamp=now_ts,
            actor_account_id=account.id,
            action="account.email_verify.confirm",
            resource_type="account",
            resource_id=account.id,
        )
        session.commit()
        return {"verified": True, "email": account.email, "verifiedAt": iso_ts(now_ts)}

    @router.post("/api/auth/password-reset/request", status_code=202)
    def request_password_reset(
        body: PasswordResetRequestBody,
        request: Request,
        session: Session = Depends(get_session),
    ):
        """Issue a single-use password reset token without revealing account existence."""
        ident = body.identifier.strip().lower()
        account = session.scalar(
            select(Account).where((Account.username == ident) | (Account.email == ident))
        )
        now_ts = get_clock(request)()
        if (
            account is not None
            and not is_deactivated(session, account.id)
            and account.password_hash.startswith("scrypt$")
        ):
            expires_at = now_ts + PASSWORD_RESET_TTL_SECONDS
            raw_token = secrets.token_urlsafe(32)
            session.add(
                AccountLifecycleToken(
                    id=str(uuid.uuid4()),
                    account_id=account.id,
                    purpose="password_reset",
                    token_digest=token_digest(raw_token),
                    target_email=account.email,
                    created_at=now_ts,
                    expires_at=expires_at,
                )
            )
            record_audit_event(
                session,
                timestamp=now_ts,
                actor_account_id=account.id,
                action="account.password_reset.request",
                resource_type="account",
                resource_id=account.id,
            )
            session.commit()
            _deliver_lifecycle_token(
                request,
                purpose="password_reset",
                account=account,
                email=account.email,
                raw_token=raw_token,
                expires_at=expires_at,
            )
        return {"status": "accepted"}

    @router.post("/api/auth/password-reset/confirm", status_code=204)
    def confirm_password_reset(
        body: PasswordResetConfirmBody,
        request: Request,
        session: Session = Depends(get_session),
    ):
        now_ts = get_clock(request)()
        digest = token_digest(body.token)
        row = session.scalar(
            select(AccountLifecycleToken).where(
                AccountLifecycleToken.token_digest == digest,
                AccountLifecycleToken.purpose == "password_reset",
            )
        )
        if row is None or row.consumed_at is not None or row.expires_at < now_ts:
            raise HTTPException(400, "invalid or expired password reset token")
        account = session.get(Account, row.account_id)
        if account is None or is_deactivated(session, account.id):
            raise HTTPException(400, "account is unavailable")
        current_email = (account.email or "").strip().lower()
        if row.target_email and row.target_email.strip().lower() != current_email:
            raise HTTPException(400, "password reset token does not match the current email")
        error = password_policy_error(body.new_password, effective_policy(session, account.id))
        if error:
            raise HTTPException(422, error)
        updated = session.execute(
            update(AccountLifecycleToken)
            .where(AccountLifecycleToken.id == row.id, AccountLifecycleToken.consumed_at.is_(None))
            .values(consumed_at=now_ts)
        )
        if updated.rowcount != 1:
            session.rollback()
            raise HTTPException(400, "password reset token already used")
        account.password_hash = password_hash(body.new_password)
        sec = ensure_account_security(session, account.id)
        sec.password_changed_at = now_ts
        sec.failed_login_count = 0
        sec.locked_until = None
        revoke_account_credentials(session, account.id, now_ts)
        record_audit_event(
            session,
            timestamp=now_ts,
            actor_account_id=account.id,
            action="account.password_reset.confirm",
            resource_type="account",
            resource_id=account.id,
        )
        session.commit()

    @router.get("/api/account/mfa/totp")
    def get_mfa_totp_status(
        principal: AuthPrincipal = Depends(required_principal),
        session: Session = Depends(get_session),
    ):
        mfa = session.get(AccountMfaTotp, principal.account.id)
        if mfa is None:
            return {"enabled": False, "confirmedAt": None, "backupCodesRemaining": 0}
        hashes = json.loads(mfa.backup_code_hashes_json or "[]")
        return {
            "enabled": bool(mfa.enabled),
            "confirmedAt": iso_ts(mfa.confirmed_at) if mfa.confirmed_at is not None else None,
            "backupCodesRemaining": len(hashes),
        }

    @router.post("/api/account/mfa/totp/enroll", status_code=201)
    def enroll_mfa_totp(
        request: Request,
        response: Response,
        principal: AuthPrincipal = Depends(required_principal),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        existing = session.get(AccountMfaTotp, account.id)
        if existing is not None and existing.enabled:
            raise HTTPException(409, "TOTP MFA is already enabled; disable it first to rotate")
        now_ts = get_clock(request)()
        secret_b32 = generate_totp_secret()
        backup_codes = generate_backup_codes()
        hashes_json = json.dumps([_hash_backup_code(code) for code in backup_codes])
        if existing is None:
            session.add(
                AccountMfaTotp(
                    account_id=account.id,
                    secret_b32=secret_b32,
                    enabled=False,
                    backup_code_hashes_json=hashes_json,
                    created_at=now_ts,
                    confirmed_at=None,
                    last_used_totp_step=None,
                )
            )
        else:
            existing.secret_b32 = secret_b32
            existing.enabled = False
            existing.backup_code_hashes_json = hashes_json
            existing.created_at = now_ts
            existing.confirmed_at = None
            existing.last_used_totp_step = None
        record_audit_event(
            session,
            timestamp=now_ts,
            actor_account_id=account.id,
            action="account.mfa_totp.enroll",
            resource_type="account",
            resource_id=account.id,
        )
        session.commit()
        label = quote(account.username or account.email or account.id)
        otpauth_uri = (
            f"otpauth://totp/GeoLibre:{label}?secret={secret_b32}&issuer=GeoLibre"
            f"&digits={TOTP_DIGITS}&period={TOTP_STEP_SECONDS}"
        )
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Pragma"] = "no-cache"
        return {
            "secret": secret_b32,
            "otpauthUri": otpauth_uri,
            "backupCodes": backup_codes,
        }

    @router.post("/api/account/mfa/totp/confirm")
    def confirm_mfa_totp(
        body: TotpCodeBody,
        request: Request,
        principal: AuthPrincipal = Depends(required_principal),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        mfa = session.get(AccountMfaTotp, account.id)
        if mfa is None:
            raise HTTPException(404, "no pending TOTP enrollment")
        now_ts = get_clock(request)()
        matched_step = verify_totp_step(mfa.secret_b32, body.code, now_ts)
        if matched_step is None:
            raise HTTPException(400, "invalid TOTP code")
        mfa.enabled = True
        mfa.confirmed_at = now_ts
        mfa.last_used_totp_step = matched_step
        record_audit_event(
            session,
            timestamp=now_ts,
            actor_account_id=account.id,
            action="account.mfa_totp.confirm",
            resource_type="account",
            resource_id=account.id,
        )
        session.commit()
        return {"enabled": True, "confirmedAt": iso_ts(now_ts)}

    @router.delete("/api/account/mfa/totp", status_code=204)
    def disable_mfa_totp(
        body: TotpCodeBody,
        request: Request,
        principal: AuthPrincipal = Depends(required_principal),
        session: Session = Depends(get_session),
    ):
        account = principal.account
        mfa = session.get(AccountMfaTotp, account.id)
        if mfa is None or not mfa.enabled:
            raise HTTPException(404, "TOTP MFA is not enabled")
        now_ts = get_clock(request)()
        ok, err = verify_account_mfa(session, account.id, body.code, now_ts)
        if not ok:
            raise HTTPException(400, err or "invalid MFA code")
        session.delete(mfa)
        record_audit_event(
            session,
            timestamp=now_ts,
            actor_account_id=account.id,
            action="account.mfa_totp.disable",
            resource_type="account",
            resource_id=account.id,
        )
        session.commit()

    @router.get("/api/organizations/{organization_id}/audit-log")
    def list_organization_audit_log(
        organization_id: str,
        request: Request,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
        action: str | None = None,
        principal: AuthPrincipal = Depends(require_any_scope("admin:org", "read:projects")),
        session: Session = Depends(get_session),
    ):
        """Return immutable audit log entries for an organization (administrators only)."""
        require_organization_admin(
            session,
            organization_id,
            principal,
            request,
            mutation=False,
        )
        stmt = select(AuditLogEntry).where(AuditLogEntry.organization_id == organization_id)
        count_stmt = (
            select(func.count())
            .select_from(AuditLogEntry)
            .where(AuditLogEntry.organization_id == organization_id)
        )
        if action:
            stmt = stmt.where(AuditLogEntry.action == action.strip())
            count_stmt = count_stmt.where(AuditLogEntry.action == action.strip())
        entries = session.scalars(
            stmt.order_by(AuditLogEntry.timestamp.desc(), AuditLogEntry.id.desc())
            .offset(offset)
            .limit(limit)
        ).all()
        total = int(session.scalar(count_stmt) or 0)
        return {
            "entries": [audit_entry_json(entry) for entry in entries],
            "limit": limit,
            "offset": offset,
            "total": total,
        }

    return router
