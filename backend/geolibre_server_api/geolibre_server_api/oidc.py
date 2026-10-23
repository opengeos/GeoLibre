"""OpenID Connect federation: IdP HTTP, ID token validation, and federated accounts.

Every outbound call goes through ``app.state.oidc_http`` (bounded responses,
no redirects, no proxy environment, public addresses only; see ``egress``). ID
tokens are verified with joserfc against the provider's cached JWKS; claims
are then checked by hand because ``jwt.decode`` verifies only the signature.

Rejection reasons are short strings for the server log only; the browser sees
one generic page so a failed sign-in reveals nothing about which check failed.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import ssl
import time
import uuid
from collections.abc import Callable
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from joserfc import jwt
from joserfc.errors import InvalidKeyIdError, JoseError
from joserfc.jwk import KeySet
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from geolibre_server_api import auth
from geolibre_server_api.auth_models import Account
from geolibre_server_api.egress import GuardedTransport
from geolibre_server_api.enterprise_models import (
    AccountSecurity,
    FederatedIdentity,
    OrganizationIdentityProvider,
    ScimGroup,
    ScimUser,
)
from geolibre_server_api.org_models import (
    ROLE_RANK,
    Group,
    GroupMember,
    Organization,
    OrganizationMember,
)
from geolibre_server_api.policy import deactivate_account, is_deactivated, is_last_active_admin
from geolibre_server_api.projects import demote_disallowed_public_projects
from geolibre_server_api.proxy_identity import ProxyIdentity, parse_networks

logger = logging.getLogger(__name__)

MAX_BODY = 1_048_576
# Wall-clock budget for one IdP request: connecting, headers, and the body.
FETCH_DEADLINE_SECONDS = 10.0
ID_TOKEN_ALGORITHMS = ["RS256", "PS256", "ES256"]
CLOCK_LEEWAY_SECONDS = 60
# A JWKS fetched within this window is not refetched for an unknown key id, so
# forged key ids cannot turn every callback into an outbound request.
JWKS_REFRESH_SECONDS = 60
TRUSTED_PROXY_KEY = "trusted-proxy"
# Never a valid scrypt encoding, so federated accounts fail every password check.
SSO_PASSWORD_HASH = "!sso"


class OidcError(Exception):
    """A rejected OIDC step; the message is a short reason for the server log."""


def build_transport() -> httpx.HTTPTransport:
    """The IdP network transport: public addresses only, plus ``GEOLIBRE_OIDC_CA_BUNDLE``.

    ``GEOLIBRE_OIDC_ALLOWED_NETWORKS`` lists the internal networks an
    identity provider may still be reached on.
    """
    # httpx's default trust (certifi), plus the operator's private CAs.
    ssl_context = httpx.create_ssl_context(trust_env=False)
    path = os.getenv("GEOLIBRE_OIDC_CA_BUNDLE")
    if path:
        try:
            ssl_context.load_verify_locations(cafile=path)
        except (OSError, ssl.SSLError) as exc:
            raise RuntimeError(f"GEOLIBRE_OIDC_CA_BUNDLE {path!r} cannot be read") from exc
    return GuardedTransport(ssl_context, parse_networks("GEOLIBRE_OIDC_ALLOWED_NETWORKS"))


def build_http_client(transport: httpx.BaseTransport) -> httpx.Client:
    """The process-wide IdP client over *transport*."""
    return httpx.Client(
        transport=transport,
        timeout=FETCH_DEADLINE_SECONDS,
        follow_redirects=False,
        trust_env=False,
    )


def fetch_json(http: httpx.Client, method: str, url: str, **kwargs) -> dict:
    """Request *url* and return its JSON object body, bounded in size and total time.

    httpx's timeout bounds each connect and read; the deadline also stops a
    server that trickles bytes just fast enough to never trip it.
    """
    deadline = time.monotonic() + FETCH_DEADLINE_SECONDS
    body = bytearray()
    try:
        with http.stream(method, url, **kwargs) as response:
            if response.status_code != 200:
                raise OidcError("http status")
            for chunk in response.iter_bytes():
                if time.monotonic() > deadline:
                    raise OidcError("timeout")
                body.extend(chunk)
                if len(body) > MAX_BODY:
                    raise OidcError("response too large")
    except httpx.HTTPError as exc:
        raise OidcError("transport error") from exc
    try:
        document = json.loads(body)
    except (ValueError, RecursionError):
        raise OidcError("invalid json") from None
    if not isinstance(document, dict):
        raise OidcError("invalid json")
    return document


def build_authorization_redirect(
    provider: OrganizationIdentityProvider,
    *,
    redirect_uri: str,
    state: str,
    nonce: str,
    code_challenge: str,
    max_age: int | None,
) -> str:
    """The provider authorization URL for an Authorization Code + S256 PKCE request."""
    params = [
        ("response_type", "code"),
        ("client_id", provider.client_id),
        ("redirect_uri", redirect_uri),
        ("scope", provider.scopes),
        ("state", state),
        ("nonce", nonce),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
    ]
    if max_age is not None:
        params.append(("max_age", str(max_age)))
    return auth.append_redirect_params(provider.authorization_endpoint, params)


def exchange_authorization_code(
    http: httpx.Client,
    provider: OrganizationIdentityProvider,
    code: str,
    code_verifier: str,
    redirect_uri: str,
) -> str:
    """Redeem the provider's authorization code and return the raw ID token."""
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
        "client_id": provider.client_id,
    }
    client_auth = None
    if provider.token_endpoint_auth_method == "client_secret_post":
        form["client_secret"] = provider.client_secret
    else:
        # RFC 6749 section 2.3.1: form-encode both parts before Basic encoding.
        client_auth = httpx.BasicAuth(
            quote(provider.client_id, safe=""), quote(provider.client_secret, safe="")
        )
    try:
        document = fetch_json(
            http,
            "POST",
            provider.token_endpoint,
            data=form,
            auth=client_auth,
            headers={"Accept": "application/json"},
        )
    except OidcError:
        raise OidcError("token exchange failed") from None
    id_token = document.get("id_token")
    if not isinstance(id_token, str):
        raise OidcError("token exchange failed")
    return id_token


def _import_key_set(document: dict) -> KeySet:
    try:
        return KeySet.import_key_set(document)
    except (JoseError, KeyError, TypeError, ValueError):
        raise OidcError("invalid jwks") from None


def load_key_set(
    session: Session,
    http: httpx.Client,
    provider: OrganizationIdentityProvider,
    *,
    refresh: bool,
    now_ts: int,
) -> KeySet:
    """The provider's signing keys, fetched and cached on first use or on *refresh*."""
    if provider.jwks_json is None or refresh:
        document = fetch_json(http, "GET", provider.jwks_uri)
        key_set = _import_key_set(document)
        provider.jwks_json = json.dumps(document)
        provider.jwks_fetched_at = now_ts
        session.commit()
        return key_set
    return _import_key_set(json.loads(provider.jwks_json))


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_id_token(
    session: Session,
    http: httpx.Client,
    provider: OrganizationIdentityProvider,
    id_token: str,
    *,
    nonce: str,
    now_ts: int,
    max_age: int | None,
) -> dict:
    """Verify the ID token's signature and claims; return the claims."""
    key_set = load_key_set(session, http, provider, refresh=False, now_ts=now_ts)
    try:
        try:
            token = jwt.decode(id_token, key_set, algorithms=ID_TOKEN_ALGORITHMS)
        except InvalidKeyIdError:
            fetched_at = provider.jwks_fetched_at
            if fetched_at is not None and fetched_at >= now_ts - JWKS_REFRESH_SECONDS:
                raise
            # The provider may have rotated its signing key since the cache.
            key_set = load_key_set(session, http, provider, refresh=True, now_ts=now_ts)
            token = jwt.decode(id_token, key_set, algorithms=ID_TOKEN_ALGORITHMS)
    except (JoseError, ValueError):
        raise OidcError("signature") from None

    claims = token.claims
    if not isinstance(claims, dict):
        raise OidcError("claims")
    if claims.get("iss") != provider.issuer:
        raise OidcError("issuer")
    audience = claims.get("aud")
    audiences = [audience] if isinstance(audience, str) else audience
    if not isinstance(audiences, list) or provider.client_id not in audiences:
        raise OidcError("audience")
    # OIDC Core 3.1.3.7: azp is required with several audiences and must match
    # whenever present.
    authorized_party = claims.get("azp")
    if (len(audiences) > 1 or authorized_party is not None) and (
        authorized_party != provider.client_id
    ):
        raise OidcError("authorized party")
    expires = claims.get("exp")
    if not _is_int(expires) or expires <= now_ts - CLOCK_LEEWAY_SECONDS:
        raise OidcError("expired")
    issued = claims.get("iat")
    if not _is_int(issued) or issued > now_ts + CLOCK_LEEWAY_SECONDS:
        raise OidcError("issued in the future")
    if not hmac.compare_digest(str(claims.get("nonce", "")).encode(), nonce.encode()):
        raise OidcError("nonce")
    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject or len(subject) > 255:
        raise OidcError("subject")
    if provider.require_mfa:
        methods = claims.get("amr", [])
        if not isinstance(methods, list) or "mfa" not in methods:
            raise OidcError("mfa required")
    if max_age is not None:
        auth_time = claims.get("auth_time")
        if not _is_int(auth_time) or auth_time < now_ts - max_age - CLOCK_LEEWAY_SECONDS:
            raise OidcError("authentication too old")
    return claims


def _username_taken(session: Session, username: str) -> bool:
    return session.scalar(select(Account.id).where(Account.username == username)) is not None


def derive_username(session: Session, raw: str) -> str | None:
    """A free username derived from an external name, or None when none fits."""
    base = re.sub(r"[^a-z0-9-]+", "-", raw.lower().split("@", 1)[0]).strip("-")
    base = base[:39].rstrip("-")
    if not auth.USERNAME_RE.fullmatch(base):
        return None
    if not _username_taken(session, base):
        return base
    stem = base[:36].rstrip("-")
    for n in range(2, 100):
        candidate = f"{stem}-{n}"
        if auth.USERNAME_RE.fullmatch(candidate) and not _username_taken(session, candidate):
            return candidate
    return None


def _unused_email(session: Session, value: str) -> str | None:
    try:
        email = auth.normalize_email(value)
    except HTTPException:
        return None
    if email is None:
        return None
    if session.scalar(select(Account.id).where(Account.email == email)) is not None:
        return None
    return email


def _verified_email(session: Session, claims: dict, claim_name: str) -> str | None:
    value = claims.get(claim_name)
    if claims.get("email_verified") is not True or not isinstance(value, str):
        return None
    return _unused_email(session, value)


def _claim_groups(claims: dict, provider: OrganizationIdentityProvider) -> list[str]:
    if not provider.groups_claim:
        return []
    value = claims.get(provider.groups_claim)
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def apply_org_mapping(
    session: Session,
    provider: OrganizationIdentityProvider,
    account_id: str,
    groups: list[str],
) -> None:
    """Sync the account's org role and mapped group memberships from its IdP groups."""
    organization_id = provider.organization_id
    claimed = set(groups)
    role_mappings = json.loads(provider.role_mappings_json or "[]")
    matched = [mapping["role"] for mapping in role_mappings if mapping["value"] in claimed]
    mapped_role = max(matched, key=ROLE_RANK.__getitem__) if matched else provider.default_role

    member = session.get(OrganizationMember, (organization_id, account_id))
    if member is None:
        session.add(
            OrganizationMember(
                organization_id=organization_id,
                account_id=account_id,
                role=mapped_role,
                created_at=auth.now(),
            )
        )
    elif role_mappings and member.role != mapped_role:
        keeps_admin = member.role == "administrator" and (
            # The break-glass account must stay an administrator to keep its
            # password sign-in; clearing it on the provider is the way out.
            provider.break_glass_account_id == account_id
            or is_last_active_admin(session, organization_id, account_id)
        )
        if not keeps_admin:
            lowered = ROLE_RANK[mapped_role] < ROLE_RANK[member.role]
            member.role = mapped_role
            if lowered:
                # The lowered role may no longer publish what the member made public.
                organization = session.get(Organization, organization_id)
                demote_disallowed_public_projects(session, organization, account_id)

    group_mappings = json.loads(provider.group_mappings_json or "[]")
    if not group_mappings:
        return
    # Several values may map to one group: membership follows any match.
    wanted = {mapping["groupId"] for mapping in group_mappings if mapping["value"] in claimed}
    mapped_ids = {mapping["groupId"] for mapping in group_mappings}
    # A mapped group deleted since the provider was saved is skipped.
    live_ids = set(
        session.scalars(
            select(Group.id).where(
                Group.id.in_(mapped_ids), Group.organization_id == organization_id
            )
        )
    )
    for group_id in sorted(live_ids):
        row = session.get(GroupMember, (group_id, account_id))
        if group_id in wanted:
            if row is None:
                session.add(
                    GroupMember(
                        group_id=group_id,
                        account_id=account_id,
                        role="member",
                        status="accepted",
                        created_at=auth.now(),
                    )
                )
        elif row is not None and row.role == "member":
            session.delete(row)


def _find_identity(session: Session, provider_key: str, subject: str) -> FederatedIdentity | None:
    return session.scalar(
        select(FederatedIdentity).where(
            FederatedIdentity.provider_key == provider_key,
            FederatedIdentity.subject == subject,
        )
    )


def _resolve_identity(
    session: Session,
    *,
    provider_key: str,
    provider_id: str | None,
    subject: str,
    username_source: str,
    new_email: Callable[[], str | None],
    managed_by: str | None,
    now_ts: int,
    claimed_username: str | None = None,
    claimed_email: str | None = None,
) -> Account:
    """The account linked to (provider_key, subject), created just in time when missing."""
    identity = _find_identity(session, provider_key, subject)
    # A concurrent first sign-in may win the identity, username, or email
    # insert; the loser re-reads the winner's link or derives fresh values.
    for _ in range(3):
        if identity is not None:
            break
        account = Account(
            id=str(uuid.uuid4()),
            username=derive_username(session, username_source),
            email=new_email(),
            password_hash=SSO_PASSWORD_HASH,
            created_at=auth.now(),
        )
        created = FederatedIdentity(
            id=str(uuid.uuid4()),
            account_id=account.id,
            provider_key=provider_key,
            provider_id=provider_id,
            subject=subject,
            created_at=now_ts,
            last_login_at=now_ts,
            claimed_username=claimed_username,
            claimed_email=claimed_email,
        )
        try:
            with session.begin_nested():
                session.add(account)
                session.add(
                    AccountSecurity(
                        account_id=account.id,
                        status="active",
                        failed_login_count=0,
                        managed_by_organization_id=managed_by,
                    )
                )
                session.add(created)
                session.flush()
        except IntegrityError:
            identity = _find_identity(session, provider_key, subject)
            continue
        return account
    if identity is None:
        raise OidcError("account creation conflict")
    identity.last_login_at = now_ts
    identity.claimed_username = claimed_username
    identity.claimed_email = claimed_email
    account = session.get(Account, identity.account_id)
    if account is None:  # pragma: no cover - the FK cascades account deletion
        raise RuntimeError("federated identity without an account")
    return account


def _first_string(*values: object) -> str:
    for value in values:
        if isinstance(value, str) and value:
            return value
    return ""


def _claimed_values(
    claims: dict, provider: OrganizationIdentityProvider
) -> tuple[str | None, str | None]:
    """The lowercased username claim, and the lowercased email claim when verified."""
    username = claims.get(provider.username_claim)
    email = claims.get(provider.email_claim)
    claimed_username = (
        username.lower() if isinstance(username, str) and 0 < len(username) <= 255 else None
    )
    claimed_email = (
        email.lower()
        if claims.get("email_verified") is True and isinstance(email, str) and 0 < len(email) <= 320
        else None
    )
    return claimed_username, claimed_email


def _managed_here(session: Session, organization_id: str, account_id: str) -> bool:
    managed_by = session.scalar(
        select(AccountSecurity.managed_by_organization_id).where(
            AccountSecurity.account_id == account_id
        )
    )
    return managed_by == organization_id


def _has_identity(session: Session, account_id: str, provider_key: str | None = None) -> bool:
    query = select(FederatedIdentity.id).where(FederatedIdentity.account_id == account_id)
    if provider_key is not None:
        query = query.where(FederatedIdentity.provider_key == provider_key)
    return session.scalar(query.limit(1)) is not None


def _has_scim_user(session: Session, organization_id: str, account_id: str) -> bool:
    return session.get(ScimUser, (organization_id, account_id), populate_existing=True) is not None


def _adopt_orphan(
    session: Session,
    provider: OrganizationIdentityProvider,
    account_id: str,
    orphan: ScimUser,
    now_ts: int,
) -> None:
    """Hand the SCIM user of an unused account SCIM created to the subject's real account.

    The orphan was provisioned while the user already had a single sign-on
    account, so it never had a way to sign in. The real account takes over the
    SCIM user, its deactivation, and its plain memberships in the organization's
    SCIM groups; the orphan is deactivated and leaves the organization.
    """
    organization_id = provider.organization_id
    orphan_id = orphan.account_id
    orphan_deactivated = is_deactivated(session, orphan_id)
    try:
        with session.begin_nested():
            # Conditional on the orphan still holding it: of two concurrent
            # sign-ins, only one moves the SCIM user.
            moved = session.execute(
                update(ScimUser)
                .where(
                    ScimUser.organization_id == organization_id,
                    ScimUser.account_id == orphan_id,
                )
                .values(account_id=account_id)
                .execution_options(synchronize_session=False)
            ).rowcount
    except IntegrityError:
        # The real account was provisioned concurrently.
        return
    session.expunge(orphan)
    if not moved:
        return

    scim_group_ids = select(ScimGroup.group_id).where(ScimGroup.organization_id == organization_id)
    orphan_rows = session.scalars(
        select(GroupMember).where(
            GroupMember.account_id == orphan_id,
            GroupMember.role == "member",
            GroupMember.group_id.in_(scim_group_ids),
        )
    ).all()
    for row in orphan_rows:
        if session.get(GroupMember, (row.group_id, account_id)) is not None:
            continue
        try:
            with session.begin_nested():
                session.add(
                    GroupMember(
                        group_id=row.group_id,
                        account_id=account_id,
                        role="member",
                        status=row.status,
                        created_at=row.created_at,
                    )
                )
                session.flush()
        except IntegrityError:
            pass

    if orphan_deactivated:
        if provider.break_glass_account_id == account_id or is_last_active_admin(
            session, organization_id, account_id
        ):
            # SCIM itself refuses this deactivation (409); the provider sees
            # the account active and its next update is refused the same way.
            logger.warning("scim deactivation not carried over to the last administrator")
        else:
            deactivate_account(session, account_id, now_ts)

    if provider.break_glass_account_id == orphan_id or is_last_active_admin(
        session, organization_id, orphan_id
    ):
        # Removing it would leave the organization without an administrator, the
        # removal SCIM refuses with a 409; the orphan keeps its membership.
        logger.warning("scim orphan kept: it is the last administrator")
        return
    deactivate_account(session, orphan_id, now_ts)
    session.execute(
        delete(OrganizationMember).where(
            OrganizationMember.organization_id == organization_id,
            OrganizationMember.account_id == orphan_id,
        )
    )
    session.execute(
        delete(GroupMember).where(
            GroupMember.account_id == orphan_id,
            GroupMember.role == "member",
            GroupMember.group_id.in_(
                select(Group.id).where(Group.organization_id == organization_id)
            ),
        )
    )


def _link_scim_user(
    session: Session,
    provider: OrganizationIdentityProvider,
    subject: str,
    claimed: tuple[str | None, str | None],
    now_ts: int,
) -> None:
    """Connect the subject with the account SCIM provisioned for its claimed user name.

    The SCIM user is found by the username claim, else the verified email claim.

    - A first sign-in links to that account, unless another subject of this
      provider already holds it (then the sign-in creates its own account).
    - A subject whose account SCIM deleted (deactivated, no SCIM user) moves to
      the account SCIM provisioned again, when no subject holds that one yet.
    - A subject whose account predates SCIM (managed here, no SCIM user) takes
      over the SCIM user of an account SCIM created for it that never signed in.
    """
    organization_id = provider.organization_id
    scim_user = None
    for value in claimed:
        if value is None:
            continue
        scim_user = session.scalar(
            select(ScimUser).where(
                ScimUser.organization_id == organization_id, ScimUser.user_name == value
            )
        )
        if scim_user is not None:
            break
    if scim_user is None:
        return
    target_id = scim_user.account_id
    identity = _find_identity(session, provider.id, subject)
    if identity is None:
        if _has_identity(session, target_id, provider.id):
            return
        try:
            with session.begin_nested():
                session.add(
                    FederatedIdentity(
                        id=str(uuid.uuid4()),
                        account_id=target_id,
                        provider_key=provider.id,
                        provider_id=provider.id,
                        subject=subject,
                        created_at=now_ts,
                        last_login_at=now_ts,
                    )
                )
                session.flush()
        except IntegrityError:
            # A concurrent sign-in linked the subject or the account; the caller
            # re-reads the subject's link or creates its own account.
            pass
        return

    current_id = identity.account_id
    if (
        current_id == target_id
        or _has_scim_user(session, organization_id, current_id)
        or not _managed_here(session, organization_id, current_id)
        or not _managed_here(session, organization_id, target_id)
    ):
        return
    if is_deactivated(session, current_id):
        if _has_identity(session, target_id, provider.id):
            return
        try:
            with session.begin_nested():
                session.execute(
                    update(FederatedIdentity)
                    .where(
                        FederatedIdentity.id == identity.id,
                        FederatedIdentity.account_id == current_id,
                    )
                    .values(account_id=target_id)
                    .execution_options(synchronize_session=False)
                )
        except IntegrityError:
            # A concurrent sign-in linked another subject to the account.
            pass
        session.expire(identity)
        return
    if not _has_identity(session, target_id):
        _adopt_orphan(session, provider, current_id, scim_user, now_ts)


def resolve_oidc_account(
    session: Session,
    provider: OrganizationIdentityProvider,
    claims: dict,
    now_ts: int,
    *,
    validated_with: tuple[str, str | None],
) -> Account:
    """Find or JIT-create the account for validated claims and apply the org mapping.

    Sign-in reconciles with the provider's own organization's SCIM users
    (``_link_scim_user``). It never links to any other existing account by
    email: that would let any IdP that asserts an address take over a local
    account. A deactivated account gets no mapping, so its memberships stay gone.

    *validated_with* is the provider's ``(issuer, jwks_uri)`` read before the
    token was validated. The provider row stays locked from the check below
    through the commit, the same lock the admin ``PUT`` takes, so an identity is
    never linked under settings an administrator replaced mid-sign-in.
    """
    locked = session.scalar(
        select(OrganizationIdentityProvider)
        .where(OrganizationIdentityProvider.id == provider.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked is None or (locked.issuer, locked.jwks_uri) != validated_with:
        raise OidcError("identity provider changed during sign-in")
    claimed_username, claimed_email = _claimed_values(claims, provider)
    _link_scim_user(session, provider, claims["sub"], (claimed_username, claimed_email), now_ts)
    account = _resolve_identity(
        session,
        provider_key=provider.id,
        provider_id=provider.id,
        subject=claims["sub"],
        username_source=_first_string(
            claims.get(provider.username_claim), claims.get(provider.email_claim)
        ),
        new_email=lambda: _verified_email(session, claims, provider.email_claim),
        managed_by=provider.organization_id,
        now_ts=now_ts,
        claimed_username=claimed_username,
        claimed_email=claimed_email,
    )
    if not is_deactivated(session, account.id):
        apply_org_mapping(session, provider, account.id, _claim_groups(claims, provider))
    session.commit()
    return account


def resolve_proxy_account(session: Session, identity: ProxyIdentity, now_ts: int) -> Account:
    """Find or JIT-create the account for a trusted proxy's user; no org mapping applies."""
    account = _resolve_identity(
        session,
        provider_key=TRUSTED_PROXY_KEY,
        provider_id=None,
        subject=identity.user,
        username_source=identity.user,
        new_email=lambda: _unused_email(session, identity.email) if identity.email else None,
        managed_by=None,
        now_ts=now_ts,
    )
    session.commit()
    return account
