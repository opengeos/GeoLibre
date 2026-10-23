"""Authentication and OAuth for the GeoLibre projects and identity API.

This module owns:

- the password/token primitives (scrypt hashing, SHA-256 digests),
- the ``AuthPrincipal`` identity context and its FastAPI dependencies
  (``get_session``, ``optional_principal``, ``required_principal``,
  ``require_scope``, ``ensure_scope``),
- the identity routes (account creation, personal-token login/revocation,
  ``/api/account``, ``/api/users/me``),
- the OAuth 2.0 Authorization Code + PKCE (S256-only) flow: the server-owned
  login/consent form, token exchange with rotating refresh tokens and reuse
  detection, revocation, and RFC 8414 discovery,
- the consent form's organization single sign-on (the OIDC relying-party work
  lives in ``oidc``) and trusted-proxy sign-in branches.

The flow is deliberately small and pinned to the reference server rather than
delegated to an OAuth framework: public clients only, no client secrets, no
JWTs, no dynamic registration. "authorized" always derives from the consent
form's credential verification; the browser binding and CSRF digests bound
that authorization to the browser that started it.

Security deadlines and state timestamps are integer UTC epoch seconds obtained
from ``request.app.state.clock`` (a callable returning ``int``), which
``main.create_app`` seeds from the wall clock; tests inject a fixed clock
instead of sleeping.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Callable, Iterator
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, sessionmaker

from geolibre_server_api.auth_models import (
    Account,
    OAuthAccessToken,
    OAuthAuthorizationCode,
    OAuthRefreshToken,
    OAuthSession,
    PersonalTokenPolicy,
    Token,
)
from geolibre_server_api.enterprise_models import (
    AccountSecurity,
    OidcLoginState,
    OrganizationIdentityProvider,
    OrganizationSecurityPolicy,
)
from geolibre_server_api.org_models import Organization
from geolibre_server_api.policy import (
    credential_expired,
    effective_policy,
    ensure_account_security,
    is_deactivated,
    password_login_allowed,
    password_policy_error,
    record_failed_login,
    record_successful_login,
)
from geolibre_server_api.proxy_identity import proxy_identity

# ---------------------------------------------------------------------------
# Scope vocabulary and grant lifetimes
# ---------------------------------------------------------------------------

PROJECT_SCOPES = ("read:projects", "write:projects", "share:public")
MANAGEMENT_SCOPE = "manage:sessions"
RESERVED_SCOPES = ("admin:org",)
KNOWN_SCOPES = (*PROJECT_SCOPES, MANAGEMENT_SCOPE)
SCOPE_ORDER = KNOWN_SCOPES
PAT_MAX_DAYS = 365

DEFAULT_CODE_TTL_SECONDS = 60
DEFAULT_ACCESS_TTL_SECONDS = 600
MANAGEMENT_TTL_SECONDS = 300
DEFAULT_REFRESH_TTL_SECONDS = 2592000  # 30 days; rotation never extends it.
INTERACTION_TTL_SECONDS = 600
MAX_FORM_BYTES = 16 * 1024
MAX_PENDING_PER_BINDING = 5

DESKTOP_CLIENT_ID = "geolibre-desktop"
DESKTOP_REDIRECT = "org.geolibre.desktop:/oauth/callback"
BROWSER_COOKIE = "__Host-geolibre_oauth_browser"

# 3-39 chars, starting and ending alphanumeric. The middle group is *not*
# optional: making it so would let a single character through, which contradicts
# both the error text and the limits table in docs/server-api.md.
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,37}[a-z0-9]$")
# 43 base64url chars (unpadded SHA-256), per RFC 7636.
PKCE_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9._~-]{43}$")
# 43-128 RFC 7636 unreserved chars.
PKCE_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
# URL-safe state used for CSRF binding between the app and the server.
STATE_RE = re.compile(r"^[A-Za-z0-9._~-]{16,512}$")


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def now() -> str:
    """Current UTC time as an ISO-8601 string with a trailing Z."""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def iso_ts(epoch_seconds: int) -> str:
    """Format an epoch-seconds timestamp as an ISO-8601 string with a trailing Z."""
    return datetime.fromtimestamp(epoch_seconds, UTC).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Password and token primitives
# ---------------------------------------------------------------------------


def password_hash(password: str, salt: bytes | None = None) -> str:
    """Hash a password with scrypt, optionally reusing a caller-provided salt."""
    if not password:
        raise ValueError("password is required")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def password_matches(password: str, encoded: str) -> bool:
    """Return whether ``password`` matches an scrypt-encoded hash, in constant time."""
    try:
        _, salt, expected = encoded.split("$")
        return hmac.compare_digest(
            password_hash(password, bytes.fromhex(salt)).split("$")[2], expected
        )
    except (ValueError, TypeError):
        return False


def token_digest(token: str) -> str:
    """Hash a raw token to its stored-value SHA-256 digest."""
    return hashlib.sha256(token.encode()).hexdigest()


def base64url_sha256(value: str) -> str:
    digest = hashlib.sha256(value.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def account_json(account: Account) -> dict:
    """Serialize an account with the API's camelCase field names."""
    return {
        "id": account.id,
        "username": account.username,
        "email": account.email,
        "createdAt": account.created_at,
    }


def normalize_email(value: str | None) -> str | None:
    """Lower-case and validate an optional email address.

    Args:
        value: The submitted address, or ``None`` to clear it.

    Returns:
        The normalized address, or ``None`` when no address was given.

    Raises:
        HTTPException: 422 when the address is not a plausible email.
    """
    if value is None:
        return None
    email = value.strip().lower()
    if (
        len(email) > 320
        or not re.fullmatch(
            r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
            r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}",
            email,
        )
        or ".." in email
    ):
        raise HTTPException(422, "email must be a valid email address")
    return email


# ---------------------------------------------------------------------------
# OAuth client registration and issuer configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OAuthClient:
    client_id: str
    name: str
    redirect_uris: tuple[str, ...]
    scopes: frozenset[str]


@dataclass(frozen=True)
class OAuthConfig:
    issuer: str
    clients: dict[str, OAuthClient]
    code_ttl: int
    access_ttl: int
    refresh_ttl: int
    interaction_ttl: int = INTERACTION_TTL_SECONDS


def positive_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive integer, got {raw!r}") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer, got {raw!r}")
    return value


def validate_redirect_uri(client_id: str, uri: str) -> None:
    """Validate one exact public-client redirect URI."""
    if "*" in uri:
        raise RuntimeError(f"client {client_id!r} redirect_uri must not be a wildcard: {uri!r}")
    if client_id == DESKTOP_CLIENT_ID:
        if uri != DESKTOP_REDIRECT:
            raise RuntimeError(
                f"client {client_id!r} redirect_uri must be exactly {DESKTOP_REDIRECT!r}"
            )
        return
    try:
        parsed = urlparse(uri)
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError(f"client {client_id!r} has an invalid redirect_uri: {uri!r}") from exc
    if parsed.scheme not in ("https", "http") or not parsed.netloc or not parsed.hostname:
        raise RuntimeError(
            f"client {client_id!r} redirect_uri must be an absolute https URL "
            f"(or loopback http): {uri!r}"
        )
    if parsed.username or parsed.password:
        raise RuntimeError(f"client {client_id!r} redirect_uri must not embed credentials: {uri!r}")
    if parsed.query or parsed.fragment:
        raise RuntimeError(
            f"client {client_id!r} redirect_uri must not contain a query or fragment: {uri!r}"
        )
    if not parsed.path.endswith("/oauth-callback.html"):
        raise RuntimeError(
            f"client {client_id!r} redirect_uri must end in /oauth-callback.html: {uri!r}"
        )
    if parsed.scheme == "http" and (
        parsed.hostname not in ("localhost", "127.0.0.1") or port is None
    ):
        raise RuntimeError(
            f"client {client_id!r} http redirect_uri must be loopback with an explicit port: "
            f"{uri!r}"
        )


def parse_oauth_clients(raw: str | None) -> dict[str, OAuthClient]:
    """Parse exact OAuth public-client registrations; an empty array disables OAuth."""
    if not raw or not raw.strip():
        return {}
    try:
        entries = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"GEOLIBRE_OAUTH_CLIENTS is not valid JSON: {exc}") from exc
    if not isinstance(entries, list):
        raise RuntimeError("GEOLIBRE_OAUTH_CLIENTS must be a JSON array")
    clients: dict[str, OAuthClient] = {}
    required_keys = {"client_id", "name", "redirect_uris", "scopes"}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != required_keys:
            raise RuntimeError(
                "GEOLIBRE_OAUTH_CLIENTS entries must contain exactly "
                "client_id, name, redirect_uris, and scopes"
            )
        client_id = entry["client_id"]
        name = entry["name"]
        redirect_uris = entry["redirect_uris"]
        scopes = entry["scopes"]
        if client_id not in ("geolibre-web", DESKTOP_CLIENT_ID):
            raise RuntimeError(f"unsupported OAuth client_id: {client_id!r}")
        if client_id in clients:
            raise RuntimeError(f"duplicate OAuth client_id: {client_id!r}")
        if not isinstance(name, str) or not name.strip():
            raise RuntimeError(f"client {client_id!r} needs a non-empty name")
        if (
            not isinstance(redirect_uris, list)
            or not redirect_uris
            or not all(isinstance(uri, str) and uri for uri in redirect_uris)
            or len(redirect_uris) != len(set(redirect_uris))
        ):
            raise RuntimeError(f"client {client_id!r} needs unique, non-empty redirect_uris")
        if (
            not isinstance(scopes, list)
            or not scopes
            or not all(isinstance(scope, str) and scope for scope in scopes)
            or len(scopes) != len(set(scopes))
        ):
            raise RuntimeError(f"client {client_id!r} needs unique, non-empty scopes")
        for uri in redirect_uris:
            validate_redirect_uri(client_id, uri)
        for scope in scopes:
            if scope not in KNOWN_SCOPES:
                raise RuntimeError(f"client {client_id!r} requests unknown scope {scope!r}")
        clients[client_id] = OAuthClient(
            client_id=client_id,
            name=name.strip(),
            redirect_uris=tuple(redirect_uris),
            scopes=frozenset(scopes),
        )
    return clients


def parse_issuer(raw: str) -> str:
    """Validate and normalize the canonical OAuth issuer."""
    try:
        parsed = urlparse(raw)
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError(f"GEOLIBRE_PUBLIC_URL is not a valid URL: {raw!r}") from exc
    if parsed.scheme not in ("https", "http") or not parsed.netloc or not parsed.hostname:
        raise RuntimeError("GEOLIBRE_PUBLIC_URL must be an absolute https URL (or loopback http)")
    if parsed.username or parsed.password:
        raise RuntimeError("GEOLIBRE_PUBLIC_URL must not embed credentials")
    if parsed.query or parsed.fragment:
        raise RuntimeError("GEOLIBRE_PUBLIC_URL must not contain a query or fragment")
    if parsed.scheme == "http" and (
        parsed.hostname not in ("localhost", "127.0.0.1") or port is None
    ):
        raise RuntimeError(
            "GEOLIBRE_PUBLIC_URL http is only allowed on loopback with an explicit port"
        )
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = 443 if parsed.scheme == "https" else 80
    netloc = host if port in (None, default_port) else f"{host}:{port}"
    return urlunparse((parsed.scheme, netloc, parsed.path.rstrip("/"), "", "", ""))


def make_oauth_config(public_url: str | None) -> OAuthConfig | None:
    clients = parse_oauth_clients(os.getenv("GEOLIBRE_OAUTH_CLIENTS", "[]"))
    if not clients:
        return None
    issuer = parse_issuer(public_url or os.getenv("GEOLIBRE_PUBLIC_URL", "http://localhost:8000"))
    return OAuthConfig(
        issuer=issuer,
        clients=clients,
        code_ttl=positive_int_env("GEOLIBRE_OAUTH_CODE_TTL_SECONDS", DEFAULT_CODE_TTL_SECONDS),
        access_ttl=positive_int_env(
            "GEOLIBRE_OAUTH_ACCESS_TTL_SECONDS", DEFAULT_ACCESS_TTL_SECONDS
        ),
        refresh_ttl=positive_int_env(
            "GEOLIBRE_OAUTH_REFRESH_TTL_SECONDS", DEFAULT_REFRESH_TTL_SECONDS
        ),
    )


# ---------------------------------------------------------------------------
# Identity context
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AuthPrincipal:
    """The account and effective scopes resolved from one Bearer credential.

    ``session_id`` is set for OAuth access tokens and absent for personal
    tokens. ``credential_id`` is the OAuth family ID or personal-token digest.
    """

    account: Account
    scopes: frozenset[str]
    credential_id: str
    session_id: str | None
    authenticated_at: int


class InsufficientScopeError(HTTPException):
    """403 raised when an authenticated principal lacks a required scope."""

    def __init__(self, scope: str):
        super().__init__(
            status_code=403,
            detail="insufficient_scope",
            headers={"WWW-Authenticate": 'Bearer error="insufficient_scope"'},
        )
        self.required_scope = scope


def get_clock(request: Request) -> Callable[[], int]:
    """Return the app's injected epoch-seconds clock (testable time source)."""
    return request.app.state.clock


def get_session(request: Request) -> Iterator[Session]:
    """Yield a request-scoped SQLAlchemy session from the app's factory."""
    factory: sessionmaker = request.app.state.session_factory
    with factory() as session:
        yield session


def bearer_challenge(error: str | None = None) -> dict[str, str]:
    """Build the ``WWW-Authenticate`` challenge for a request."""
    value = "Bearer" if error is None else f'Bearer error="{error}"'
    return {"WWW-Authenticate": value}


def touch_session(session: Session, session_id: str, now_ts: int) -> None:
    """Update an OAuth family's ``last_used_at`` at most once per minute."""
    result = session.execute(
        update(OAuthSession)
        .where(
            OAuthSession.id == session_id,
            or_(OAuthSession.last_used_at.is_(None), OAuthSession.last_used_at < now_ts - 60),
        )
        .values(last_used_at=now_ts)
    )
    if result.rowcount:
        session.commit()


def touch_policy(session: Session, token_digest: str, now_ts: int) -> None:
    """Update a PAT policy's ``last_used_at`` at most once per minute."""
    result = session.execute(
        update(PersonalTokenPolicy)
        .where(
            PersonalTokenPolicy.token_digest == token_digest,
            or_(
                PersonalTokenPolicy.last_used_at.is_(None),
                PersonalTokenPolicy.last_used_at < now_ts - 60,
            ),
        )
        .values(last_used_at=now_ts)
    )
    if result.rowcount:
        session.commit()


def backfill_policy(session: Session, digest: str, *, commit: bool = True) -> PersonalTokenPolicy:
    """Create legacy PAT metadata without racing another request doing the same.

    Args:
        session: The request session.
        digest: Digest of the legacy personal token.
        commit: Commit afterwards; pass False when the caller owns the transaction.

    Returns:
        The new or already-existing policy row.
    """
    policy = PersonalTokenPolicy(
        id=str(uuid.uuid4()),
        token_digest=digest,
        label="Legacy personal token",
        scope=" ".join(PROJECT_SCOPES),
        legacy=True,
    )
    try:
        # The savepoint keeps the request transaction usable when another
        # process wins the unique token_digest insert.
        with session.begin_nested():
            session.add(policy)
            session.flush()
    except IntegrityError:
        existing = session.scalar(
            select(PersonalTokenPolicy).where(PersonalTokenPolicy.token_digest == digest)
        )
        if existing is None:
            raise
        return existing
    if commit:
        session.commit()
    return policy


class PasswordLoginError(Exception):
    """A rejected password sign-in; ``code`` is one of the documented reasons."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# Password-login rejection codes mapped to the token API's status and error.
LOGIN_ERRORS: dict[str, tuple[int, str]] = {
    "invalid": (401, "invalid username or password"),
    "locked": (401, "account temporarily locked"),
    "expired": (403, "password expired"),
    "sso_required": (403, "single sign-on required"),
}
# The same codes as shown on the OAuth consent page.
CONSENT_LOGIN_ERRORS: dict[str, str] = {
    "invalid": "Invalid username or password",
    "locked": "Too many failed sign-in attempts. Try again later.",
    "expired": "Your password has expired. Change it, then sign in again.",
    "sso_required": (
        "Your organization requires single sign-on. Use “Sign in with your organization”."
    ),
}
# Single sign-on and proxy sign-in of a SCIM-deactivated account. Password
# sign-in reports "invalid" instead, so it reveals nothing to a password guesser.
DEACTIVATED_MESSAGE = "This account has been deactivated."


def verify_password_login(
    session: Session,
    username: str,
    password: str,
    now_ts: int,
    *,
    allow_expired: bool = False,
) -> Account:
    """Verify built-in credentials under the account's effective security policy."""
    account = session.scalar(select(Account).where(Account.username == username))
    if account is None:
        # Hash anyway before failing. Short-circuiting here would skip the
        # scrypt call that a real username always pays for, and the timing
        # difference enumerates accounts one request at a time, which a
        # request-count rate limiter does not address.
        password_hash(password or "unused")
        raise PasswordLoginError("invalid")
    security = session.get(AccountSecurity, account.id)
    locked_until = security.locked_until if security is not None else None
    if locked_until is not None and locked_until > now_ts:
        raise PasswordLoginError("locked")
    policy = effective_policy(session, account.id)
    if not password_matches(password, account.password_hash):
        record_failed_login(session, account.id, now_ts, policy)
        raise PasswordLoginError("invalid")
    if is_deactivated(session, account.id):
        raise PasswordLoginError("invalid")
    if not password_login_allowed(session, account.id):
        raise PasswordLoginError("sso_required")
    if (
        policy.password_max_age_days
        and security is not None
        and security.password_changed_at is not None
        and security.password_changed_at + policy.password_max_age_days * 86400 <= now_ts
        and not allow_expired
    ):
        raise PasswordLoginError("expired")
    record_successful_login(session, account.id, now_ts)
    return account


def optional_principal(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    session: Session = Depends(get_session),
) -> AuthPrincipal | None:
    """Resolve the Bearer credential, or None for anonymous access.

    A supplied but invalid credential is always a 401, even on an optionally
    authenticated route: that is the documented behavior the public listing
    relies on.
    """
    if not authorization:
        return None
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "invalid authorization", headers=bearer_challenge("invalid_token"))
    token = authorization[7:]
    digest = token_digest(token)
    now_ts = get_clock(request)()

    access = session.get(OAuthAccessToken, digest)
    if access is not None:
        oauth_session = session.get(OAuthSession, access.session_id)
        if (
            oauth_session is None
            or oauth_session.revoked_at is not None
            or oauth_session.expires_at <= now_ts
            or access.expires_at <= now_ts
        ):
            raise HTTPException(
                401, "invalid or expired token", headers=bearer_challenge("invalid_token")
            )
        account = session.get(Account, oauth_session.account_id)
        if account is None or is_deactivated(session, account.id):
            raise HTTPException(
                401, "invalid or expired token", headers=bearer_challenge("invalid_token")
            )
        authenticated_at = oauth_session.authenticated_at or oauth_session.created_at
        if credential_expired(
            effective_policy(session, account.id),
            authenticated_at=authenticated_at,
            last_activity_at=oauth_session.last_used_at or oauth_session.created_at,
            now_ts=now_ts,
        ):
            session.execute(
                update(OAuthSession)
                .where(OAuthSession.id == oauth_session.id)
                .values(revoked_at=now_ts)
            )
            session.commit()
            raise HTTPException(
                401, "invalid or expired token", headers=bearer_challenge("invalid_token")
            )
        touch_session(session, oauth_session.id, now_ts)
        return AuthPrincipal(
            account=account,
            scopes=frozenset(oauth_session.scope.split()),
            credential_id=oauth_session.id,
            session_id=oauth_session.id,
            authenticated_at=authenticated_at,
        )
    token_row = session.get(Token, digest)
    if token_row is None:
        raise HTTPException(
            401, "invalid or expired token", headers=bearer_challenge("invalid_token")
        )

    policy = session.scalar(
        select(PersonalTokenPolicy).where(PersonalTokenPolicy.token_digest == digest)
    )
    if policy is None:
        policy = backfill_policy(session, digest)
    if policy.revoked_at is not None:
        raise HTTPException(
            401, "invalid or expired token", headers=bearer_challenge("invalid_token")
        )
    if policy.expires_at is not None and policy.expires_at <= now_ts:
        raise HTTPException(
            401, "invalid or expired token", headers=bearer_challenge("invalid_token")
        )
    account = session.get(Account, token_row.account_id)
    if account is None or is_deactivated(session, account.id):
        raise HTTPException(
            401, "invalid or expired token", headers=bearer_challenge("invalid_token")
        )
    token_created = int(
        datetime.fromisoformat(token_row.created_at.replace("Z", "+00:00")).timestamp()
    )
    if credential_expired(
        effective_policy(session, account.id),
        authenticated_at=token_created,
        last_activity_at=policy.last_used_at or token_created,
        now_ts=now_ts,
    ):
        session.execute(
            update(PersonalTokenPolicy)
            .where(PersonalTokenPolicy.id == policy.id)
            .values(revoked_at=now_ts)
        )
        session.commit()
        raise HTTPException(
            401, "invalid or expired token", headers=bearer_challenge("invalid_token")
        )

    touch_policy(session, digest, now_ts)
    return AuthPrincipal(
        account=account,
        scopes=frozenset(policy.scope.split()),
        credential_id=digest,
        session_id=None,
        authenticated_at=token_created,
    )


def cleanup_expired_security_rows(session: Session, now_ts: int, *, batch_size: int = 200) -> None:
    """Delete bounded batches of expired OAuth state.

    Consumed refresh generations remain attached to active families for reuse
    detection. Deleting an expired family cascades its access/refresh tokens
    and clears the authorization row's session reference; that row can then be
    removed safely.
    """
    changed = False

    expired_session_ids = list(
        session.scalars(
            select(OAuthSession.id).where(OAuthSession.expires_at <= now_ts).limit(batch_size)
        )
    )
    if expired_session_ids:
        session.execute(delete(OAuthSession).where(OAuthSession.id.in_(expired_session_ids)))
        changed = True

    expired_access_digests = list(
        session.scalars(
            select(OAuthAccessToken.digest)
            .where(OAuthAccessToken.expires_at <= now_ts)
            .limit(batch_size)
        )
    )
    if expired_access_digests:
        session.execute(
            delete(OAuthAccessToken).where(OAuthAccessToken.digest.in_(expired_access_digests))
        )
        changed = True

    # Expired single sign-on redirects; deleting an interaction below also
    # cascades any of its login states that are still unexpired.
    expired_login_state_ids = list(
        session.scalars(
            select(OidcLoginState.id).where(OidcLoginState.expires_at <= now_ts).limit(batch_size)
        )
    )
    if expired_login_state_ids:
        session.execute(
            delete(OidcLoginState).where(OidcLoginState.id.in_(expired_login_state_ids))
        )
        changed = True

    expired_interaction_ids = list(
        session.scalars(
            select(OAuthAuthorizationCode.id)
            .where(
                or_(
                    and_(
                        OAuthAuthorizationCode.approved_at.is_(None),
                        OAuthAuthorizationCode.interaction_expires_at <= now_ts,
                    ),
                    and_(
                        OAuthAuthorizationCode.approved_at.is_not(None),
                        OAuthAuthorizationCode.consumed_at.is_(None),
                        OAuthAuthorizationCode.code_expires_at <= now_ts,
                    ),
                    and_(
                        OAuthAuthorizationCode.consumed_at.is_not(None),
                        OAuthAuthorizationCode.session_id.is_(None),
                    ),
                )
            )
            .limit(batch_size)
        )
    )
    if expired_interaction_ids:
        session.execute(
            delete(OAuthAuthorizationCode).where(
                OAuthAuthorizationCode.id.in_(expired_interaction_ids)
            )
        )
        changed = True

    if changed:
        session.commit()


def required_principal(
    principal: AuthPrincipal | None = Depends(optional_principal),
) -> AuthPrincipal:
    """Resolve a Bearer PAT, or reject the request with a Bearer challenge."""
    if principal is None:
        raise HTTPException(401, "authentication required", headers=bearer_challenge())
    return principal


def ensure_scope(principal: AuthPrincipal, scope: str) -> None:
    """Raise ``InsufficientScopeError`` unless ``principal`` holds ``scope``."""
    if scope not in principal.scopes:
        raise InsufficientScopeError(scope)


def require_scope(scope: str):
    """Dependency factory guarding a route with one required project scope."""

    def dependency(principal: AuthPrincipal = Depends(required_principal)) -> AuthPrincipal:
        ensure_scope(principal, scope)
        return principal

    return dependency


# ---------------------------------------------------------------------------
# Personal token issuance (scoped and expiring)
# ---------------------------------------------------------------------------


def validate_pat_scopes(scopes: list[str] | None) -> str:
    """Canonical space-separated scope string for a personal API token.

    None means "old clients, project powers": all three project scopes.
    Management scopes are never granted to PATs; requesting one is a 400
    invalid_scope, never a silent drop.
    """
    if scopes is None:
        selected = list(PROJECT_SCOPES)
    else:
        if not scopes or any(not isinstance(scope, str) or not scope for scope in scopes):
            raise HTTPException(400, "invalid_scope")
        for scope in scopes:
            if scope not in PROJECT_SCOPES:
                raise HTTPException(400, "invalid_scope")
        selected = list(dict.fromkeys(scopes))
    return " ".join(selected)


def issue_token(
    session: Session,
    account: Account,
    *,
    name: str | None = None,
    scopes: list[str] | None = None,
    expires_in_days: int | None = None,
    clock: Callable[[], int],
    commit: bool = True,
) -> tuple[str, dict]:
    """Mint a PAT and its policy row in one transaction.

    An omitted lifetime keeps the v1 delete-only token lifecycle: the token does
    not expire.
    """
    value = secrets.token_urlsafe(32)
    digest = token_digest(value)
    now_ts = clock()
    expires_at = None if expires_in_days is None else now_ts + expires_in_days * 86400
    scope_str = validate_pat_scopes(scopes)
    policy = PersonalTokenPolicy(
        id=str(uuid.uuid4()),
        token_digest=digest,
        label=(name or "Personal token")[:100],
        scope=scope_str,
        expires_at=expires_at,
        legacy=False,
    )
    session.add(Token(digest=digest, account_id=account.id, created_at=now()))
    # Flush the referencing table before the dependent one: there is no ORM
    # relationship between Token and PersonalTokenPolicy, so the unit of work
    # cannot order these inserts itself, and SQLite's enforced FK would reject
    # the policy row (with no foreign keys the flush order would be arbitrary).
    session.flush()
    session.add(policy)
    if commit:
        session.commit()
    return value, {
        "scopes": sorted(scope_str.split(), key=SCOPE_ORDER.index),
        "expiresAt": iso_ts(expires_at) if expires_at is not None else None,
        "tokenId": policy.id,
    }


# ---------------------------------------------------------------------------
# OAuth scope/URL helpers shared by the authorize and exchange paths
# ---------------------------------------------------------------------------


def canonical_scope(scope: str) -> str:
    return " ".join(sorted(scope.split(), key=SCOPE_ORDER.index))


def parse_scope_set(scope: str) -> frozenset[str] | None:
    parts = scope.split()
    if not parts or len(parts) != len(set(parts)):
        return None
    if any(part not in KNOWN_SCOPES or part in RESERVED_SCOPES for part in parts):
        return None
    if MANAGEMENT_SCOPE in parts and len(parts) != 1:
        return None
    return frozenset(parts)


def validate_authorize_scope(client: OAuthClient, scope: str) -> str | None:
    """Return the OAuth error code, or None when the scope set is acceptable."""
    parts = parse_scope_set(scope)
    if parts is None or not parts.issubset(client.scopes):
        return "invalid_scope"
    return None


def scope_description(scope: str) -> str:
    return {
        "read:projects": "List and open your projects, including private ones",
        "write:projects": "Create, update, and delete your projects",
        "share:public": "Make your projects publicly visible",
        MANAGEMENT_SCOPE: (
            "List and revoke every sign-in session and personal token on your account"
        ),
    }[scope]


def no_store_redirect(url: str) -> RedirectResponse:
    response = RedirectResponse(url, status_code=303)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def append_redirect_params(redirect_uri: str, params: list[tuple[str, str]]) -> str:
    separator = "&" if "?" in redirect_uri else "?"
    return redirect_uri + separator + urlencode(params)


def oauth_success_url(issuer: str, redirect_uri: str, code: str, state: str) -> str:
    return append_redirect_params(redirect_uri, [("code", code), ("state", state), ("iss", issuer)])


def oauth_error_redirect(
    issuer: str, redirect_uri: str, error: str, state: str
) -> RedirectResponse:
    params: list[tuple[str, str]] = [("error", error)]
    if state:
        params.append(("state", state))
    params.append(("iss", issuer))
    return no_store_redirect(append_redirect_params(redirect_uri, params))


def authorization_html_response(
    body: str,
    status: int = 200,
    *,
    form_redirect_uri: str | None = None,
    sso_form_action: bool = False,
) -> HTMLResponse:
    response = HTMLResponse(body, status_code=status)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    # Send only the issuer origin to the consent POST (needed for browser
    # validation), never the authorization URL's state/challenge query.
    response.headers["Referrer-Policy"] = "origin"
    # Some browsers apply form-action to the 303 after the consent POST, so the
    # registered callback origin must be allowed even though the form posts here.
    form_action = "'self'"
    if form_redirect_uri is not None:
        redirect = urlparse(form_redirect_uri)
        callback_source = (
            f"{redirect.scheme}://{redirect.netloc}" if redirect.netloc else f"{redirect.scheme}:"
        )
        form_action += f" {callback_source}"
    if sso_form_action:
        # The single sign-on POST is answered with a 303 to the organization's
        # identity provider, whose endpoints are https-only.
        form_action += " https:"
    response.headers["Content-Security-Policy"] = (
        f"default-src 'none'; form-action {form_action}; frame-ancestors 'none'; base-uri 'none'"
    )
    response.headers["X-Frame-Options"] = "DENY"
    return response


def oauth_error_page(status: int, code: str, message: str) -> HTMLResponse:
    body = (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<title>Sign-in error</title></head><body>"
        f"<h1>Sign-in error</h1><p>{html.escape(code)}: {html.escape(message)}</p>"
        "</body></html>"
    )
    return authorization_html_response(body, status)


def render_consent_form(
    config: OAuthConfig,
    client: OAuthClient,
    redirect_uri: str,
    interaction_id: str,
    csrf_value: str,
    label: str,
    scope: str,
    error: str | None,
    *,
    sso_available: bool = False,
    proxy_user: str | None = None,
) -> str:
    scope_items = "".join(
        f"<li>{html.escape(scope_description(s))}</li>" for s in canonical_scope(scope).split()
    )
    error_html = f"<p role='alert'>{html.escape(error)}</p>" if error else ""
    if proxy_user is not None:
        credentials_html = (
            "<p>Signed in through your organization's proxy as "
            f"<strong>{html.escape(proxy_user)}</strong>.</p>"
        )
        allow_text = "Allow"
    else:
        credentials_html = (
            "<label>Username <input type='text' name='username' "
            "autocomplete='username' required></label>"
            "<label>Password <input type='password' name='password' "
            "autocomplete='current-password' required></label>"
        )
        allow_text = "Sign in and allow"
    sso_html = ""
    if sso_available and proxy_user is None:
        sso_html = (
            "<form method='post'>"
            f"<input type='hidden' name='interaction' value='{html.escape(interaction_id)}'>"
            f"<input type='hidden' name='csrf' value='{html.escape(csrf_value)}'>"
            f"<input type='hidden' name='label' value='{html.escape(label)}'>"
            "<label>Organization <input type='text' name='organization' "
            "autocomplete='organization' required></label>"
            "<button type='submit' name='decision' value='sso'>"
            "Sign in with your organization</button>"
            "</form>"
        )
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<title>Authorize GeoLibre</title></head><body>"
        f"<h1>Authorize {html.escape(client.name)}</h1>"
        f"<p>Sign in to <strong>{html.escape(config.issuer)}</strong> and allow "
        f"<strong>{html.escape(client.name)}</strong> to access your account.</p>"
        f"<p>You will be returned to <strong>{html.escape(redirect_uri)}</strong>.</p>"
        "<h2>Requested access</h2>"
        f"<ul>{scope_items}</ul>"
        f"{error_html}"
        "<form method='post'>"
        f"<input type='hidden' name='interaction' value='{html.escape(interaction_id)}'>"
        f"<input type='hidden' name='csrf' value='{html.escape(csrf_value)}'>"
        "<label>Device label <input type='text' name='label' maxlength='100' "
        f"value='{html.escape(label)}'></label>"
        f"{credentials_html}"
        f"<button type='submit' name='decision' value='allow'>{allow_text}</button>"
        "<button type='submit' name='decision' value='cancel' formnovalidate>Cancel</button>"
        "</form>"
        f"{sso_html}"
        "</body></html>"
    )


def oauth_token_error(status: int, error: str) -> JSONResponse:
    response = JSONResponse({"error": error}, status_code=status)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def oauth_token_response(payload: dict, status: int = 200) -> JSONResponse:
    response = JSONResponse(payload, status_code=status)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def is_sqlite_lock_error(session: Session, exc: OperationalError) -> bool:
    """True only for SQLite lock exhaustion, never unrelated database faults."""
    return session.get_bind().dialect.name == "sqlite" and "locked" in str(exc.orig).lower()


# ---------------------------------------------------------------------------
# Bounded form parsing for the OAuth endpoints
# ---------------------------------------------------------------------------


def _is_form_content_type(request: Request) -> bool:
    return (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        == "application/x-www-form-urlencoded"
    )


async def read_form_body(request: Request) -> bytes | None:
    """Read a bounded URL-encoded body asynchronously, if the content type matches."""
    if not _is_form_content_type(request):
        return None
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_FORM_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def parse_form_fields(body: bytes) -> dict[str, str] | None:
    """Parse form fields, rejecting duplicate keys (None)."""
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return None
    parsed = parse_qs(text, keep_blank_values=True)
    fields: dict[str, str] = {}
    for key, values in parsed.items():
        if len(values) > 1:
            return None
        fields[key] = values[0]
    return fields


def same_origin_allowed(config: OAuthConfig, origin: str | None, referer: str | None) -> bool:
    """The consent POST must come from the issuer's own origin."""
    parsed_issuer = urlparse(config.issuer)
    issuer_origin = f"{parsed_issuer.scheme}://{parsed_issuer.netloc}"
    if origin:
        return origin == issuer_origin
    if referer:
        try:
            parsed = urlparse(referer)
            return f"{parsed.scheme}://{parsed.netloc}" == issuer_origin
        except ValueError:
            return False
    return False


def require_issuer_host(config: OAuthConfig):
    """Reject OAuth requests whose Host differs from the canonical issuer authority."""
    allowed_host = urlparse(config.issuer).netloc.lower()

    def dependency(request: Request) -> None:
        if (request.headers.get("host") or "").lower() != allowed_host:
            raise HTTPException(400, "invalid request host")

    return dependency


def metadata_json(config: OAuthConfig) -> dict:
    base = config.issuer
    return {
        "issuer": config.issuer,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "revocation_endpoint": f"{base}/oauth/revoke",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["none"],
        "revocation_endpoint_auth_methods_supported": ["none"],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": list(SCOPE_ORDER),
        "authorization_response_iss_parameter_supported": True,
    }


# ---------------------------------------------------------------------------
# Identity routes (accounts and personal tokens)
# ---------------------------------------------------------------------------


class TokenIssueRequest(BaseModel):
    """Credential body for account creation and token login.

    The scope/lifetime fields are additive so old clients keep working. The
    plan's documented ``invalid_scope`` (400) rejection for scope/lifetime
    values is enforced in the routes, not by Pydantic, so the error
    vocabulary matches the contract.
    """

    username: str = Field(max_length=39)
    password: str = Field(max_length=1024)
    name: str | None = Field(default=None, max_length=100)
    scopes: list[str] | None = None
    expiresInDays: int | None = None


class AccountCreateRequest(TokenIssueRequest):
    """Account-creation body: the token-login fields plus an optional email."""

    email: str | None = Field(default=None, max_length=320)


class AccountPatch(BaseModel):
    """Editable account settings. Only the email address is mutable today."""

    email: str | None = Field(max_length=320)

    model_config = {"extra": "forbid"}


class RevokeOtherSessionsRequest(BaseModel):
    currentSessionId: str

    model_config = {"extra": "forbid"}


class PasswordChangeRequest(BaseModel):
    """Body for ``POST /api/account/password``."""

    username: str
    current_password: str = Field(alias="currentPassword", max_length=1024)
    new_password: str = Field(alias="newPassword", max_length=1024)

    model_config = {"extra": "forbid", "populate_by_name": True}


def owned_project_session(
    session: Session, account_id: str, session_id: str, now_ts: int, *, lock: bool = False
) -> OAuthSession:
    query = select(OAuthSession).where(
        OAuthSession.id == session_id,
        OAuthSession.account_id == account_id,
        OAuthSession.kind == "project",
        OAuthSession.revoked_at.is_(None),
        OAuthSession.expires_at > now_ts,
    )
    if lock:
        query = query.with_for_update()
    project = session.scalar(query)
    if project is None:
        raise HTTPException(404, "not found")
    return project


def backfill_account_policies(session: Session, account_id: str, *, commit: bool = True) -> None:
    """Give every legacy token of the account a policy row.

    Args:
        session: The request session.
        account_id: Account whose legacy tokens are backfilled.
        commit: Commit per row; pass False when the caller owns the transaction.
    """
    missing = session.scalars(
        select(Token.digest)
        .outerjoin(PersonalTokenPolicy, PersonalTokenPolicy.token_digest == Token.digest)
        .where(Token.account_id == account_id, PersonalTokenPolicy.id.is_(None))
    ).all()
    for digest in missing:
        backfill_policy(session, digest, commit=commit)


def _validate_pat_lifetime(days: int | None) -> None:
    """Reject an explicit token lifetime outside the accepted 1-365 day range."""
    if days is not None and not (1 <= days <= PAT_MAX_DAYS):
        raise HTTPException(400, "invalid_request")


def build_identity_router() -> APIRouter:
    """Build the identity routes (accounts, token issuance, /api/users/me)."""
    router = APIRouter()

    @router.post("/api/accounts", status_code=201)
    def create_account(
        body: AccountCreateRequest,
        request: Request,
        session: Session = Depends(get_session),
    ):
        """Create an account and return its bootstrap personal API token once."""
        _validate_pat_lifetime(body.expiresInDays)
        # Validate the token policy before creating anything. A bad scope
        # request must not reserve the username without returning a credential.
        validate_pat_scopes(body.scopes)
        username = body.username.strip()
        if not USERNAME_RE.fullmatch(username):
            raise HTTPException(422, "username must be 3-39 lowercase letters, digits, or hyphens")
        if len(body.password) < 8:
            raise HTTPException(422, "password must be at least 8 characters")
        email = normalize_email(body.email)
        if session.scalar(select(Account.id).where(Account.username == username)):
            raise HTTPException(409, "username already exists")
        if email and session.scalar(select(Account.id).where(Account.email == email)):
            raise HTTPException(409, "email already exists")

        account = Account(
            id=str(uuid.uuid4()),
            username=username,
            email=email,
            password_hash=password_hash(body.password),
            created_at=now(),
        )
        session.add(account)
        session.add(
            AccountSecurity(account_id=account.id, password_changed_at=get_clock(request)())
        )
        try:
            session.flush()
        except IntegrityError:
            # The check above and this flush are not atomic, so two requests
            # racing for one username can both pass it. The loser rolls the
            # whole account/token transaction back and receives the stable 409.
            session.rollback()
            raise HTTPException(409, "username or email already exists") from None
        token, extra = issue_token(
            session,
            account,
            name=body.name,
            scopes=body.scopes,
            expires_in_days=body.expiresInDays,
            clock=get_clock(request),
            commit=False,
        )
        session.commit()
        return {"account": account_json(account), "token": token, **extra}

    @router.post("/api/auth/token")
    def login(
        body: TokenIssueRequest,
        request: Request,
        session: Session = Depends(get_session),
    ):
        """Exchange account credentials for a personal API token."""
        _validate_pat_lifetime(body.expiresInDays)
        try:
            account = verify_password_login(
                session, body.username, body.password, get_clock(request)()
            )
        except PasswordLoginError as exc:
            status, message = LOGIN_ERRORS[exc.code]
            raise HTTPException(status, message) from None
        token, extra = issue_token(
            session,
            account,
            name=body.name,
            scopes=body.scopes,
            expires_in_days=body.expiresInDays,
            clock=get_clock(request),
        )
        return {"account": account_json(account), "token": token, **extra}

    @router.post("/api/account/password", status_code=204)
    def change_password(
        body: PasswordChangeRequest,
        request: Request,
        session: Session = Depends(get_session),
    ):
        """Change a password with the current one; works after the password expired."""
        now_ts = get_clock(request)()
        try:
            account = verify_password_login(
                session, body.username, body.current_password, now_ts, allow_expired=True
            )
        except PasswordLoginError as exc:
            status, message = LOGIN_ERRORS[exc.code]
            raise HTTPException(status, message) from None
        if body.new_password == body.current_password:
            raise HTTPException(422, "new password must differ from the current password")
        error = password_policy_error(body.new_password, effective_policy(session, account.id))
        if error:
            raise HTTPException(422, error)
        account.password_hash = password_hash(body.new_password)
        ensure_account_security(session, account.id).password_changed_at = now_ts
        session.commit()
        return Response(status_code=204)

    @router.delete("/api/auth/token", status_code=204)
    def revoke(
        request: Request,
        principal: AuthPrincipal = Depends(required_principal),
        session: Session = Depends(get_session),
    ):
        """Revoke a PAT or the presented OAuth access token's entire family."""
        if principal.session_id is not None:
            # Revoke the whole session family, never just the presented access
            # token row.
            session.execute(
                update(OAuthSession)
                .where(OAuthSession.id == principal.session_id, OAuthSession.revoked_at.is_(None))
                .values(revoked_at=get_clock(request)())
            )
        else:
            session.execute(delete(Token).where(Token.digest == principal.credential_id))
            session.execute(
                delete(PersonalTokenPolicy).where(
                    PersonalTokenPolicy.token_digest == principal.credential_id
                )
            )
        session.commit()

    @router.get("/api/account")
    def get_account(response: Response, principal: AuthPrincipal = Depends(required_principal)):
        """Return the authenticated account."""
        response.headers["Cache-Control"] = "private, no-store"
        return {"account": account_json(principal.account)}

    @router.patch("/api/account")
    def patch_account(
        body: AccountPatch,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        """Change the account's email address (``null`` clears it).

        The email decides which email-addressed invitations the account may
        accept, so changing it is a write and needs write:projects, the only
        write scope a token can hold.
        """
        email = normalize_email(body.email)
        account = session.get(Account, principal.account.id)
        assert account is not None
        if email and session.scalar(
            select(Account.id).where(Account.email == email, Account.id != account.id)
        ):
            raise HTTPException(409, "email already exists")
        account.email = email
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "email already exists") from None
        response.headers["Cache-Control"] = "private, no-store"
        return {"account": account_json(account)}

    @router.get("/api/users/me")
    def get_current_user(
        response: Response, principal: AuthPrincipal = Depends(required_principal)
    ):
        """Return the account, effective scopes, and OAuth session ID when present."""
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "user": account_json(principal.account),
            "sessionId": principal.session_id,
            "scopes": sorted(principal.scopes, key=SCOPE_ORDER.index),
        }

    @router.get("/api/auth/sessions")
    def list_auth_sessions(
        response: Response,
        request: Request,
        limit: int = Query(50, ge=1, le=100),
        offset: int = Query(0, ge=0),
        currentSessionId: str | None = None,
        principal: AuthPrincipal = Depends(require_scope(MANAGEMENT_SCOPE)),
        session: Session = Depends(get_session),
    ):
        """List active project grants and personal tokens, never manager grants.

        Legacy PATs are backfilled before exposure because their policy row
        carries the public revocable ID; the per-account SELECT plus any
        single-row commits is deliberate and cheap for typical accounts. Rows
        are then sorted and sliced in Python rather than in SQL so the
        mixed-kind ordering (oauth + personal-token) stays deterministic and
        the total reflects every active credential family.
        """
        now_ts = get_clock(request)()
        account_id = principal.account.id
        if currentSessionId is not None:
            owned_project_session(session, account_id, currentSessionId, now_ts)
        backfill_account_policies(session, account_id)

        rows: list[tuple[float, dict]] = []
        for grant in session.scalars(
            select(OAuthSession).where(
                OAuthSession.account_id == account_id,
                OAuthSession.kind == "project",
                OAuthSession.revoked_at.is_(None),
                OAuthSession.expires_at > now_ts,
            )
        ):
            rows.append(
                (
                    float(grant.created_at),
                    {
                        "id": grant.id,
                        "kind": "oauth",
                        "clientId": grant.client_id,
                        "label": grant.label,
                        "scopes": grant.scope.split(),
                        "createdAt": iso_ts(grant.created_at),
                        "lastUsedAt": iso_ts(grant.last_used_at)
                        if grant.last_used_at is not None
                        else None,
                        "expiresAt": iso_ts(grant.expires_at),
                        "current": grant.id == currentSessionId,
                        "legacy": False,
                    },
                )
            )
        policies = session.execute(
            select(Token, PersonalTokenPolicy)
            .join(PersonalTokenPolicy, PersonalTokenPolicy.token_digest == Token.digest)
            .where(
                Token.account_id == account_id,
                PersonalTokenPolicy.revoked_at.is_(None),
                or_(
                    PersonalTokenPolicy.expires_at.is_(None),
                    PersonalTokenPolicy.expires_at > now_ts,
                ),
            )
        )
        for token, policy in policies:
            rows.append(
                (
                    datetime.fromisoformat(token.created_at.replace("Z", "+00:00")).timestamp(),
                    {
                        "id": policy.id,
                        "kind": "personal-token",
                        "clientId": None,
                        "label": policy.label,
                        "scopes": policy.scope.split(),
                        "createdAt": token.created_at,
                        "lastUsedAt": iso_ts(policy.last_used_at)
                        if policy.last_used_at is not None
                        else None,
                        "expiresAt": iso_ts(policy.expires_at)
                        if policy.expires_at is not None
                        else None,
                        "current": False,
                        "legacy": policy.legacy,
                    },
                )
            )
        rows.sort(key=lambda entry: (entry[0], entry[1]["id"]), reverse=True)
        response.headers["Cache-Control"] = "private, no-store"
        return {
            "sessions": [item for _, item in rows[offset : offset + limit]],
            "limit": limit,
            "offset": offset,
            "total": len(rows),
        }

    @router.delete("/api/auth/sessions/{session_id}", status_code=204)
    def revoke_auth_session(
        session_id: str,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope(MANAGEMENT_SCOPE)),
        session: Session = Depends(get_session),
    ):
        """Revoke an owned session family or a PAT by its public UUID."""
        account_id = principal.account.id
        grant = session.scalar(
            select(OAuthSession.id).where(
                OAuthSession.id == session_id,
                OAuthSession.account_id == account_id,
                OAuthSession.kind == "project",
            )
        )
        if grant is not None:
            session.execute(
                update(OAuthSession)
                .where(OAuthSession.id == grant, OAuthSession.revoked_at.is_(None))
                .values(revoked_at=get_clock(request)())
            )
        else:
            backfill_account_policies(session, account_id)
            policy = session.scalar(
                select(PersonalTokenPolicy.id)
                .join(Token, Token.digest == PersonalTokenPolicy.token_digest)
                .where(PersonalTokenPolicy.id == session_id, Token.account_id == account_id)
            )
            if policy is None:
                raise HTTPException(404, "not found")
            session.execute(
                update(PersonalTokenPolicy)
                .where(PersonalTokenPolicy.id == policy, PersonalTokenPolicy.revoked_at.is_(None))
                .values(revoked_at=get_clock(request)())
            )
        session.commit()

    @router.post("/api/auth/sessions/revoke-others", status_code=204)
    def revoke_other_auth_sessions(
        body: RevokeOtherSessionsRequest,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope(MANAGEMENT_SCOPE)),
        session: Session = Depends(get_session),
    ):
        """Atomically retire all other credential families and every PAT."""
        account_id = principal.account.id
        now_ts = get_clock(request)()
        backfill_account_policies(session, account_id)
        # Lock the calling manager and the kept project family before mutating
        # anything; refresh and revocation serialize on OAuthSession rows.
        manager = session.scalar(
            select(OAuthSession)
            .where(
                OAuthSession.id == principal.session_id,
                OAuthSession.account_id == account_id,
                OAuthSession.kind == "management",
                OAuthSession.revoked_at.is_(None),
                OAuthSession.expires_at > now_ts,
            )
            .with_for_update()
        )
        if manager is None:
            raise HTTPException(
                401, "invalid or expired token", headers=bearer_challenge("invalid_token")
            )
        owned_project_session(session, account_id, body.currentSessionId, now_ts, lock=True)
        session.execute(
            update(OAuthSession)
            .where(
                OAuthSession.account_id == account_id,
                OAuthSession.id.not_in((body.currentSessionId, manager.id)),
                OAuthSession.revoked_at.is_(None),
            )
            .values(revoked_at=now_ts)
        )
        session.execute(
            update(PersonalTokenPolicy)
            .where(
                PersonalTokenPolicy.token_digest.in_(
                    select(Token.digest).where(Token.account_id == account_id)
                ),
                PersonalTokenPolicy.revoked_at.is_(None),
            )
            .values(revoked_at=now_ts)
        )
        session.commit()

    return router


# ---------------------------------------------------------------------------
# OAuth router: authorize (server-owned consent), token, revoke, discovery
# ---------------------------------------------------------------------------


def build_oauth_router(config: OAuthConfig) -> APIRouter:
    """Build the Authorization Code + S256 PKCE surface for an enabled server."""

    # The OIDC relying party layers above this module; import it here, not at
    # module load, so ``oidc`` can depend on ``auth``.
    from geolibre_server_api import oidc

    router = APIRouter(dependencies=[Depends(require_issuer_host(config))])
    # __Host- cookies require Secure; Safari rejects Secure cookies on HTTP
    # loopback, which is permitted only for local development by parse_issuer.
    secure_cookie = config.issuer.startswith("https://")
    browser_cookie = BROWSER_COOKIE if secure_cookie else "geolibre_oauth_browser"
    sso_redirect_uri = f"{config.issuer}/oauth/sso/callback"

    def _sso_available(session: Session, proxy_user: str | None) -> bool:
        """Offer organization sign-in when any provider is enabled (never in proxy mode)."""
        if proxy_user is not None:
            return False
        enabled = session.scalar(
            select(func.count())
            .select_from(OrganizationIdentityProvider)
            .where(OrganizationIdentityProvider.enabled.is_(True))
        )
        return (enabled or 0) > 0

    # -- GET /oauth/authorize: start a pending interaction and render consent --

    def _begin_authorization(
        request: Request,
        session: Session,
    ):
        params = request.query_params
        for key in (
            "response_type",
            "client_id",
            "redirect_uri",
            "scope",
            "state",
            "code_challenge",
            "code_challenge_method",
            "device_label",
        ):
            if len(params.getlist(key)) > 1:
                return oauth_error_page(400, "invalid_request", "duplicate parameter")
        client_id = params.get("client_id", "")
        redirect_uri = params.get("redirect_uri", "")
        client = config.clients.get(client_id)
        # Validate client and redirect before any redirect response: an unknown
        # client or redirect never gets a Location header.
        if client is None or redirect_uri not in client.redirect_uris:
            return oauth_error_page(400, "invalid_request", "unknown client or redirect URI")
        state = params.get("state", "")
        # Never reflect an unbounded value into a redirect, including the
        # unsupported-response-type branch that precedes state validation.
        if len(state) > 512:
            return oauth_error_page(400, "invalid_request", "state too long")
        if params.get("response_type") != "code":
            return oauth_error_redirect(
                config.issuer, redirect_uri, "unsupported_response_type", state
            )
        if not STATE_RE.fullmatch(state):
            return oauth_error_redirect(config.issuer, redirect_uri, "invalid_request", state)
        scope = params.get("scope", "")
        scope_error = validate_authorize_scope(client, scope)
        if scope_error:
            return oauth_error_redirect(config.issuer, redirect_uri, scope_error, state)
        challenge = params.get("code_challenge", "")
        if not PKCE_CHALLENGE_RE.fullmatch(challenge):
            return oauth_error_redirect(config.issuer, redirect_uri, "invalid_request", state)
        if params.get("code_challenge_method") != "S256":
            return oauth_error_redirect(config.issuer, redirect_uri, "invalid_request", state)
        label = params.get("device_label", "") or client.name
        if len(label) > 100:
            return oauth_error_redirect(config.issuer, redirect_uri, "invalid_request", state)
        try:
            identity = proxy_identity(request)
        except ValueError:
            return oauth_error_page(400, "invalid_request", "invalid proxy identity")
        proxy_user = identity.user if identity is not None else None

        now_ts = get_clock(request)()
        cleanup_expired_security_rows(session, now_ts)
        cookie_value: str | None = None
        cookie_digest: str | None = None
        existing = request.cookies.get(browser_cookie)
        if existing:
            existing_digest = token_digest(existing)
            # One browser cookie binds simultaneous consent forms for every
            # registered client; only the pending cap is per client.
            reusable = session.scalar(
                select(OAuthAuthorizationCode.id).where(
                    OAuthAuthorizationCode.browser_cookie_digest == existing_digest,
                    OAuthAuthorizationCode.interaction_expires_at > now_ts,
                )
            )
            if reusable is not None:
                cookie_value = existing
                cookie_digest = existing_digest
        if cookie_value is None:
            cookie_value = secrets.token_urlsafe(32)
            cookie_digest = token_digest(cookie_value)

        pending = session.scalar(
            select(func.count())
            .select_from(OAuthAuthorizationCode)
            .where(
                OAuthAuthorizationCode.client_id == client_id,
                OAuthAuthorizationCode.browser_cookie_digest == cookie_digest,
                OAuthAuthorizationCode.interaction_expires_at > now_ts,
                OAuthAuthorizationCode.consumed_at.is_(None),
            )
        )
        if (pending or 0) >= MAX_PENDING_PER_BINDING:
            return oauth_error_page(429, "too_many_requests", "too many pending authorizations")

        csrf_value = secrets.token_urlsafe(32)
        interaction = OAuthAuthorizationCode(
            id=str(uuid.uuid4()),
            client_id=client_id,
            redirect_uri=redirect_uri,
            scope=canonical_scope(scope),
            code_challenge=challenge,
            state=state,
            browser_cookie_digest=cookie_digest,
            csrf_digest=token_digest(csrf_value),
            label=label[:100],
            interaction_expires_at=now_ts + config.interaction_ttl,
        )
        session.add(interaction)
        session.commit()

        sso_available = _sso_available(session, proxy_user)
        response = authorization_html_response(
            render_consent_form(
                config,
                client,
                redirect_uri,
                interaction.id,
                csrf_value,
                label,
                scope,
                None,
                sso_available=sso_available,
                proxy_user=proxy_user,
            ),
            form_redirect_uri=redirect_uri,
            sso_form_action=sso_available,
        )
        response.set_cookie(
            browser_cookie,
            cookie_value,
            max_age=config.interaction_ttl,
            httponly=True,
            secure=secure_cookie,
            samesite="lax",
            path="/",
        )
        return response

    @router.get("/oauth/authorize")
    def oauth_authorize(
        request: Request,
        session: Session = Depends(get_session),
    ):
        try:
            return _begin_authorization(request, session)
        except OperationalError as exc:
            session.rollback()
            if not is_sqlite_lock_error(session, exc):
                raise
            return oauth_error_page(503, "temporarily_unavailable", "please try again")

    # -- POST /oauth/authorize: verify credentials and consent, mint the code --

    def _complete_authorization(
        request: Request,
        session: Session,
        body: bytes | None,
    ):
        origin = request.headers.get("origin")
        referer = request.headers.get("referer")
        if not same_origin_allowed(config, origin, referer):
            return oauth_error_page(400, "invalid_request", "cross-origin request rejected")
        if not _is_form_content_type(request):
            return oauth_error_page(400, "invalid_request", "invalid content type")
        if body is None:
            return oauth_error_page(400, "invalid_request", "request body too large")
        fields = parse_form_fields(body)
        if fields is None:
            return oauth_error_page(400, "invalid_request", "malformed form body")

        interaction_id = fields.get("interaction", "")
        csrf = fields.get("csrf", "")
        decision = fields.get("decision", "")
        label = fields.get("label", "").strip()
        username = fields.get("username", "").strip()
        password = fields.get("password", "")
        if not interaction_id or not csrf or decision not in ("allow", "cancel", "sso"):
            return oauth_error_page(400, "invalid_request", "invalid form")
        if not (1 <= len(label) <= 100) or any(ord(c) < 32 for c in label):
            return oauth_error_page(400, "invalid_request", "invalid label")

        now_ts = get_clock(request)()
        cleanup_expired_security_rows(session, now_ts)
        interaction = session.get(OAuthAuthorizationCode, interaction_id)
        if (
            interaction is None
            or interaction.interaction_expires_at <= now_ts
            or interaction.consumed_at is not None
            or interaction.approved_at is not None
        ):
            return oauth_error_page(
                400, "invalid_request", "authorization request expired or already processed"
            )
        cookie = request.cookies.get(browser_cookie)
        if (
            not cookie
            or interaction.browser_cookie_digest is None
            or not hmac.compare_digest(token_digest(cookie), interaction.browser_cookie_digest)
        ):
            return oauth_error_page(400, "invalid_request", "browser session mismatch")
        if not hmac.compare_digest(token_digest(csrf), interaction.csrf_digest):
            return oauth_error_page(400, "invalid_request", "invalid form token")
        client = config.clients.get(interaction.client_id)
        if client is None:
            return oauth_error_page(400, "invalid_request", "unknown client")

        if decision == "cancel":
            # A simultaneous approval may have committed since the pending row
            # was read. Only the winner may claim to have denied consent.
            cancelled = session.execute(
                update(OAuthAuthorizationCode)
                .where(
                    OAuthAuthorizationCode.id == interaction.id,
                    OAuthAuthorizationCode.approved_at.is_(None),
                    OAuthAuthorizationCode.consumed_at.is_(None),
                    OAuthAuthorizationCode.interaction_expires_at > now_ts,
                )
                .values(consumed_at=now_ts)
            ).rowcount
            if not cancelled:
                session.rollback()
                return oauth_error_page(
                    400, "invalid_request", "authorization request already processed"
                )
            session.commit()
            return oauth_error_redirect(
                config.issuer, interaction.redirect_uri, "access_denied", interaction.state
            )

        try:
            identity = proxy_identity(request)
        except ValueError:
            return oauth_error_page(400, "invalid_request", "invalid proxy identity")
        proxy_user = identity.user if identity is not None else None

        if decision == "sso":
            if identity is not None:
                # The proxy's identity is authoritative; the consent form never
                # offers organization sign-in alongside it.
                return oauth_error_page(
                    400, "invalid_request", "single sign-on is unavailable behind the proxy"
                )
            return _start_single_sign_on(
                session,
                interaction,
                client,
                csrf,
                label,
                fields.get("organization", "").strip().lower(),
                now_ts,
                proxy_user=proxy_user,
            )

        if identity is not None:
            # The trusted proxy already authenticated this user.
            try:
                account = oidc.resolve_proxy_account(session, identity, now_ts)
            except oidc.OidcError as exc:
                session.rollback()
                oidc.logger.warning("proxy sign-in rejected: %s", exc)
                return oauth_error_page(400, "invalid_request", "proxy sign-in failed")
            if is_deactivated(session, account.id):
                return _consent_error(
                    session,
                    interaction,
                    client,
                    csrf,
                    label,
                    DEACTIVATED_MESSAGE,
                    proxy_user=proxy_user,
                )
            return _approve_interaction(
                session, interaction, account.id, label, now_ts, authenticated_at=now_ts
            )

        # Credential verification: the same scrypt work and lockout/rotation
        # policy as /api/auth/token, but no PAT is minted.
        try:
            account = verify_password_login(session, username, password, now_ts)
        except PasswordLoginError as exc:
            return _consent_error(
                session,
                interaction,
                client,
                csrf,
                label,
                CONSENT_LOGIN_ERRORS[exc.code],
                proxy_user=proxy_user,
            )
        return _approve_interaction(
            session, interaction, account.id, label, now_ts, authenticated_at=now_ts
        )

    def _start_single_sign_on(
        session: Session,
        interaction: OAuthAuthorizationCode,
        client: OAuthClient,
        csrf: str,
        label: str,
        slug: str,
        now_ts: int,
        *,
        proxy_user: str | None,
    ) -> Response:
        """Redirect the browser to the named organization's identity provider."""
        provider = None
        if slug:
            provider = session.scalar(
                select(OrganizationIdentityProvider)
                .join(Organization, Organization.id == OrganizationIdentityProvider.organization_id)
                .where(Organization.slug == slug, OrganizationIdentityProvider.enabled.is_(True))
            )
        if provider is None:
            return _consent_error(
                session,
                interaction,
                client,
                csrf,
                label,
                "Single sign-on is not configured for that organization",
                proxy_user=proxy_user,
            )
        org_policy = session.get(OrganizationSecurityPolicy, provider.organization_id)
        max_age = org_policy.admin_reauth_seconds if org_policy is not None else None
        state = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(32)
        code_verifier = secrets.token_urlsafe(64)
        session.add(
            OidcLoginState(
                id=str(uuid.uuid4()),
                state_digest=token_digest(state),
                nonce=nonce,
                code_verifier=code_verifier,
                provider_id=provider.id,
                interaction_id=interaction.id,
                label=label,
                max_age=max_age,
                expires_at=now_ts + config.interaction_ttl,
            )
        )
        session.commit()
        return no_store_redirect(
            oidc.build_authorization_redirect(
                provider,
                redirect_uri=sso_redirect_uri,
                state=state,
                nonce=nonce,
                code_challenge=base64url_sha256(code_verifier),
                max_age=max_age,
            )
        )

    def _consent_error(
        session: Session,
        interaction: OAuthAuthorizationCode,
        client: OAuthClient,
        csrf: str,
        label: str,
        message: str,
        *,
        proxy_user: str | None,
    ) -> HTMLResponse:
        """Re-render the consent form for this interaction with an error message."""
        sso_available = _sso_available(session, proxy_user)
        return authorization_html_response(
            render_consent_form(
                config,
                client,
                interaction.redirect_uri,
                interaction.id,
                csrf,
                label,
                interaction.scope,
                message,
                sso_available=sso_available,
                proxy_user=proxy_user,
            ),
            form_redirect_uri=interaction.redirect_uri,
            sso_form_action=sso_available,
        )

    def _approve_interaction(
        session: Session,
        interaction: OAuthAuthorizationCode,
        account_id: str,
        label: str,
        now_ts: int,
        authenticated_at: int,
    ) -> Response:
        """Approve a pending interaction for an authenticated account and mint the code."""
        code_value = secrets.token_urlsafe(32)
        # Atomic consume-on-approve: a double submission cannot issue two live
        # codes (the unique code_digest column backs the same guarantee).
        updated = session.execute(
            update(OAuthAuthorizationCode)
            .where(
                OAuthAuthorizationCode.id == interaction.id,
                OAuthAuthorizationCode.approved_at.is_(None),
                OAuthAuthorizationCode.consumed_at.is_(None),
                OAuthAuthorizationCode.interaction_expires_at > now_ts,
            )
            .values(
                account_id=account_id,
                label=label,
                approved_at=now_ts,
                code_digest=token_digest(code_value),
                code_expires_at=now_ts + config.code_ttl,
                authenticated_at=authenticated_at,
            )
        ).rowcount
        if not updated:
            session.rollback()
            return oauth_error_page(
                400, "invalid_request", "authorization request already processed"
            )
        session.commit()
        return no_store_redirect(
            oauth_success_url(
                config.issuer, interaction.redirect_uri, code_value, interaction.state
            )
        )

    @router.post("/oauth/authorize")
    def oauth_authorize_post(
        request: Request,
        body: bytes | None = Depends(read_form_body),
        session: Session = Depends(get_session),
    ):
        try:
            return _complete_authorization(request, session, body)
        except OperationalError as exc:
            session.rollback()
            if not is_sqlite_lock_error(session, exc):
                raise
            return oauth_error_page(503, "temporarily_unavailable", "please try again")

    # -- GET /oauth/sso/callback: the organization IdP returns to the consent --

    def _sso_rejected() -> HTMLResponse:
        # One generic page: the reason is logged, never shown to the browser.
        return oauth_error_page(400, "invalid_request", "single sign-on response rejected")

    def _finish_single_sign_on(request: Request, session: Session):
        params = request.query_params
        if any(len(params.getlist(key)) > 1 for key in ("state", "code", "error")):
            return _sso_rejected()
        state = params.get("state", "")
        if not state:
            return _sso_rejected()
        now_ts = get_clock(request)()
        login_state = session.scalar(
            select(OidcLoginState).where(OidcLoginState.state_digest == token_digest(state))
        )
        if (
            login_state is None
            or login_state.expires_at <= now_ts
            or login_state.consumed_at is not None
        ):
            return _sso_rejected()
        interaction = session.get(OAuthAuthorizationCode, login_state.interaction_id)
        if (
            interaction is None
            or interaction.interaction_expires_at <= now_ts
            or interaction.consumed_at is not None
            or interaction.approved_at is not None
        ):
            return _sso_rejected()
        # The IdP redirect must land in the browser that started consent.
        cookie = request.cookies.get(browser_cookie)
        if (
            not cookie
            or interaction.browser_cookie_digest is None
            or not hmac.compare_digest(token_digest(cookie), interaction.browser_cookie_digest)
        ):
            return _sso_rejected()

        if params.get("error"):
            session.execute(
                update(OidcLoginState)
                .where(OidcLoginState.id == login_state.id, OidcLoginState.consumed_at.is_(None))
                .values(consumed_at=now_ts)
            )
            session.execute(
                update(OAuthAuthorizationCode)
                .where(
                    OAuthAuthorizationCode.id == interaction.id,
                    OAuthAuthorizationCode.approved_at.is_(None),
                    OAuthAuthorizationCode.consumed_at.is_(None),
                )
                .values(consumed_at=now_ts)
            )
            session.commit()
            return oauth_error_redirect(
                config.issuer, interaction.redirect_uri, "access_denied", interaction.state
            )

        code = params.get("code", "")
        if not code:
            return _sso_rejected()
        # Single use: of two concurrent callbacks for one state, only one
        # redeems the provider's code.
        claimed = session.execute(
            update(OidcLoginState)
            .where(OidcLoginState.id == login_state.id, OidcLoginState.consumed_at.is_(None))
            .values(consumed_at=now_ts)
        ).rowcount
        if not claimed:
            session.rollback()
            return _sso_rejected()
        session.commit()

        provider = session.get(OrganizationIdentityProvider, login_state.provider_id)
        if provider is None or not provider.enabled:
            return _sso_rejected()
        http = request.app.state.oidc_http
        # The settings this sign-in validates against; linking re-checks them.
        validated_with = (provider.issuer, provider.jwks_uri)
        try:
            id_token = oidc.exchange_authorization_code(
                http, provider, code, login_state.code_verifier, sso_redirect_uri
            )
            claims = oidc.validate_id_token(
                session,
                http,
                provider,
                id_token,
                nonce=login_state.nonce,
                now_ts=now_ts,
                max_age=login_state.max_age,
            )
            account = oidc.resolve_oidc_account(
                session, provider, claims, now_ts, validated_with=validated_with
            )
        except oidc.OidcError as exc:
            session.rollback()
            oidc.logger.warning("oidc sign-in rejected: %s", exc)
            return _sso_rejected()
        if is_deactivated(session, account.id):
            return oauth_error_page(403, "access_denied", DEACTIVATED_MESSAGE)
        auth_time = claims.get("auth_time")
        authenticated_at = (
            min(auth_time, now_ts)
            if isinstance(auth_time, int) and not isinstance(auth_time, bool)
            else now_ts
        )
        return _approve_interaction(
            session,
            interaction,
            account.id,
            login_state.label,
            now_ts,
            authenticated_at=authenticated_at,
        )

    @router.get("/oauth/sso/callback")
    def oauth_sso_callback(
        request: Request,
        session: Session = Depends(get_session),
    ):
        try:
            return _finish_single_sign_on(request, session)
        except OperationalError as exc:
            session.rollback()
            if not is_sqlite_lock_error(session, exc):
                raise
            return oauth_error_page(503, "temporarily_unavailable", "please try again")

    # -- POST /oauth/token: exchange a code, or rotate a refresh token --

    def exchange_code(
        fields: dict[str, str], client: OAuthClient, session: Session, now_ts: int
    ) -> JSONResponse:
        code = fields.get("code", "")
        redirect_uri = fields.get("redirect_uri", "")
        verifier = fields.get("code_verifier", "")
        if not code or not redirect_uri or not verifier:
            return oauth_token_error(400, "invalid_request")
        if not PKCE_VERIFIER_RE.fullmatch(verifier):
            return oauth_token_error(400, "invalid_grant")
        code_row = session.scalar(
            select(OAuthAuthorizationCode).where(
                OAuthAuthorizationCode.code_digest == token_digest(code)
            )
        )
        if (
            code_row is None
            or code_row.client_id != client.client_id
            or code_row.redirect_uri != redirect_uri
        ):
            return oauth_token_error(400, "invalid_grant")
        computed = base64url_sha256(verifier)
        if not hmac.compare_digest(computed, code_row.code_challenge):
            # Wrong verifier: not an authenticated replay, so no revocation.
            return oauth_token_error(400, "invalid_grant")
        if code_row.consumed_at is not None:
            # Authenticated replay (correct verifier + binding): revoke the
            # family previously issued for this code, then report invalid_grant.
            if code_row.session_id is not None:
                session.execute(
                    update(OAuthSession)
                    .where(OAuthSession.id == code_row.session_id)
                    .values(revoked_at=now_ts)
                )
                session.commit()
            return oauth_token_error(400, "invalid_grant")
        if (
            code_row.approved_at is None
            or code_row.account_id is None
            or code_row.code_expires_at is None
            or code_row.code_expires_at <= now_ts
            # Deactivated between approval and exchange.
            or is_deactivated(session, code_row.account_id)
        ):
            return oauth_token_error(400, "invalid_grant")

        session_id = str(uuid.uuid4())
        management = code_row.scope == MANAGEMENT_SCOPE
        family_expires = now_ts + (MANAGEMENT_TTL_SECONDS if management else config.refresh_ttl)
        if not management:
            policy = effective_policy(session, code_row.account_id)
            if policy.absolute_lifetime:
                family_expires = min(
                    family_expires,
                    (code_row.authenticated_at or now_ts) + policy.absolute_lifetime,
                )
        access_expires = min(now_ts + config.access_ttl, family_expires)
        oauth_session = OAuthSession(
            id=session_id,
            account_id=code_row.account_id,
            client_id=client.client_id,
            kind="management" if management else "project",
            scope=code_row.scope,
            label=code_row.label,
            created_at=now_ts,
            expires_at=family_expires,
            rotation_version=0,
            authenticated_at=code_row.authenticated_at,
        )
        access_value = secrets.token_urlsafe(32)
        session.add(oauth_session)
        # The FK requires the family row before its access token.
        session.flush()
        session.add(
            OAuthAccessToken(
                digest=token_digest(access_value),
                session_id=session_id,
                created_at=now_ts,
                expires_at=access_expires,
            )
        )
        if not management:
            refresh_value = secrets.token_urlsafe(32)
            session.add(
                OAuthRefreshToken(
                    digest=token_digest(refresh_value),
                    session_id=session_id,
                    created_at=now_ts,
                    expires_at=family_expires,
                )
            )
        code_id = code_row.id
        consumed = session.execute(
            update(OAuthAuthorizationCode)
            .where(
                OAuthAuthorizationCode.id == code_id,
                OAuthAuthorizationCode.consumed_at.is_(None),
            )
            .values(consumed_at=now_ts, session_id=session_id)
        ).rowcount
        if not consumed:
            # Another correctly bound exchange consumed the code after our
            # initial read. Roll back the provisional family, reload the
            # winner's family ID, and treat this authenticated replay exactly
            # like a sequential replay.
            session.rollback()
            replayed = session.get(OAuthAuthorizationCode, code_id)
            if replayed is not None and replayed.session_id is not None:
                session.execute(
                    update(OAuthSession)
                    .where(OAuthSession.id == replayed.session_id)
                    .values(revoked_at=now_ts)
                )
                session.commit()
            return oauth_token_error(400, "invalid_grant")
        session.commit()
        payload = {
            "access_token": access_value,
            "token_type": "Bearer",
            "expires_in": access_expires - now_ts,
            "scope": code_row.scope,
        }
        if not management:
            payload["refresh_token"] = refresh_value
        return oauth_token_response(payload)

    def refresh_tokens(
        fields: dict[str, str], client: OAuthClient, session: Session, now_ts: int
    ) -> JSONResponse:
        refresh_token = fields.get("refresh_token", "")
        if not refresh_token:
            return oauth_token_error(400, "invalid_request")
        requested_scope = fields.get("scope")
        refresh = session.get(OAuthRefreshToken, token_digest(refresh_token))
        if refresh is None:
            return oauth_token_error(400, "invalid_grant")
        oauth_session = session.get(OAuthSession, refresh.session_id)
        if (
            oauth_session is None
            or oauth_session.client_id != client.client_id
            or oauth_session.kind != "project"
        ):
            return oauth_token_error(400, "invalid_grant")
        if (
            oauth_session.revoked_at is not None
            or oauth_session.expires_at <= now_ts
            or refresh.expires_at <= now_ts
        ):
            return oauth_token_error(400, "invalid_grant")
        policy = effective_policy(session, oauth_session.account_id)
        if is_deactivated(session, oauth_session.account_id) or credential_expired(
            policy,
            authenticated_at=oauth_session.authenticated_at or oauth_session.created_at,
            last_activity_at=oauth_session.last_used_at or oauth_session.created_at,
            now_ts=now_ts,
        ):
            session.execute(
                update(OAuthSession)
                .where(OAuthSession.id == oauth_session.id)
                .values(revoked_at=now_ts)
            )
            session.commit()
            return oauth_token_error(400, "invalid_grant")
        if refresh.consumed_at is not None:
            # Reuse: a consumed generation presented with its correct binding
            # revokes the whole family (including any tokens minted by the
            # rotation that consumed it), then reports invalid_grant.
            session.execute(
                update(OAuthSession)
                .where(OAuthSession.id == oauth_session.id)
                .values(revoked_at=now_ts)
            )
            session.commit()
            return oauth_token_error(400, "invalid_grant")
        if requested_scope is not None:
            requested_scope_set = parse_scope_set(requested_scope)
            if requested_scope_set is None or requested_scope_set != frozenset(
                oauth_session.scope.split()
            ):
                return oauth_token_error(400, "invalid_scope")

        # Serialization point shared with revocation: a conditional UPDATE on
        # the family row. If a concurrent revoke wins, this matches 0 rows and
        # no new tokens are issued.
        # The increment is the write that locks this family row, serializing
        # refreshes with each other and with revocation; no reader needs its value.
        rotated = session.execute(
            update(OAuthSession)
            .where(
                OAuthSession.id == oauth_session.id,
                OAuthSession.revoked_at.is_(None),
                OAuthSession.expires_at > now_ts,
            )
            .values(rotation_version=OAuthSession.rotation_version + 1, last_used_at=now_ts)
        ).rowcount
        if not rotated:
            session.rollback()
            return oauth_token_error(400, "invalid_grant")

        active_sessions = select(OAuthSession.id).where(
            OAuthSession.id == oauth_session.id,
            OAuthSession.revoked_at.is_(None),
            OAuthSession.expires_at > now_ts,
        )
        new_refresh_value = secrets.token_urlsafe(32)
        new_refresh_digest = token_digest(new_refresh_value)
        consumed = session.execute(
            update(OAuthRefreshToken)
            .where(
                OAuthRefreshToken.digest == refresh.digest,
                OAuthRefreshToken.consumed_at.is_(None),
                OAuthRefreshToken.session_id.in_(active_sessions),
            )
            .values(consumed_at=now_ts, successor_digest=new_refresh_digest)
        ).rowcount
        if not consumed:
            # Reuse: revoke the whole family, commit, then report invalid_grant.
            session.execute(
                update(OAuthSession)
                .where(OAuthSession.id == oauth_session.id)
                .values(revoked_at=now_ts)
            )
            session.commit()
            return oauth_token_error(400, "invalid_grant")

        access_value = secrets.token_urlsafe(32)
        access_expires = min(now_ts + config.access_ttl, oauth_session.expires_at)
        session.add(
            OAuthAccessToken(
                digest=token_digest(access_value),
                session_id=oauth_session.id,
                created_at=now_ts,
                expires_at=access_expires,
            )
        )
        session.add(
            OAuthRefreshToken(
                digest=new_refresh_digest,
                session_id=oauth_session.id,
                created_at=now_ts,
                expires_at=oauth_session.expires_at,
            )
        )
        session.commit()
        return oauth_token_response(
            {
                "access_token": access_value,
                "token_type": "Bearer",
                "expires_in": access_expires - now_ts,
                "refresh_token": new_refresh_value,
                "scope": oauth_session.scope,
            }
        )

    @router.post("/oauth/token")
    def oauth_token(
        request: Request,
        body: bytes | None = Depends(read_form_body),
        session: Session = Depends(get_session),
    ):
        if not _is_form_content_type(request):
            return oauth_token_error(400, "invalid_request")
        if body is None:
            return oauth_token_error(400, "invalid_request")
        fields = parse_form_fields(body)
        if fields is None:
            return oauth_token_error(400, "invalid_request")
        grant_type = fields.get("grant_type")
        client = config.clients.get(fields.get("client_id", ""))
        if client is None:
            return oauth_token_error(400, "invalid_client")
        now_ts = get_clock(request)()
        try:
            cleanup_expired_security_rows(session, now_ts)
            if grant_type == "authorization_code":
                return exchange_code(fields, client, session, now_ts)
            if grant_type == "refresh_token":
                return refresh_tokens(fields, client, session, now_ts)
        except OperationalError as exc:
            session.rollback()
            if not is_sqlite_lock_error(session, exc):
                raise
            return oauth_token_error(503, "temporarily_unavailable")
        return oauth_token_error(400, "unsupported_grant_type")

    # -- POST /oauth/revoke: revoke an access or refresh token's family --

    @router.post("/oauth/revoke")
    def oauth_revoke(
        request: Request,
        body: bytes | None = Depends(read_form_body),
        session: Session = Depends(get_session),
    ):
        if not _is_form_content_type(request):
            return oauth_token_error(400, "invalid_request")
        if body is None:
            return oauth_token_error(400, "invalid_request")
        fields = parse_form_fields(body)
        if fields is None:
            return oauth_token_error(400, "invalid_request")
        client_id = fields.get("client_id", "")
        token = fields.get("token", "")
        hint = fields.get("token_type_hint")
        if not client_id or not token:
            return oauth_token_error(400, "invalid_request")
        if hint not in (None, "access_token", "refresh_token"):
            return oauth_token_error(400, "unsupported_token_type")
        client = config.clients.get(client_id)
        if client is None:
            return oauth_token_error(400, "invalid_client")
        try:
            digest = token_digest(token)
            session_id: str | None = None
            access = session.get(OAuthAccessToken, digest)
            if access is not None:
                session_id = access.session_id
            else:
                refresh = session.get(OAuthRefreshToken, digest)
                if refresh is not None:
                    session_id = refresh.session_id
            if session_id is not None:
                oauth_session = session.get(OAuthSession, session_id)
                if oauth_session is not None and oauth_session.client_id == client.client_id:
                    session.execute(
                        update(OAuthSession)
                        .where(
                            OAuthSession.id == session_id,
                            OAuthSession.revoked_at.is_(None),
                        )
                        .values(revoked_at=get_clock(request)())
                    )
                    session.commit()
        except OperationalError as exc:
            session.rollback()
            if not is_sqlite_lock_error(session, exc):
                raise
            return oauth_token_error(503, "temporarily_unavailable")
        response = Response(status_code=200)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    # -- RFC 8414 discovery --

    def oauth_metadata():
        return metadata_json(config)

    metadata_path = "/.well-known/oauth-authorization-server" + urlparse(config.issuer).path
    router.add_api_route(metadata_path, oauth_metadata, methods=["GET"])

    return router
