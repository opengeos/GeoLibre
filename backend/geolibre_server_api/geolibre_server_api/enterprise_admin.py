"""Organization-administrator routes for enterprise sign-in settings."""

from __future__ import annotations

import ipaddress
import json
import re
import secrets
import uuid
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from geolibre_server_api.auth import (
    AuthPrincipal,
    get_clock,
    get_session,
    iso_ts,
    require_scope,
    token_digest,
)
from geolibre_server_api.auth_models import Account
from geolibre_server_api.enterprise_models import (
    FederatedIdentity,
    OrganizationIdentityProvider,
    OrganizationSecurityPolicy,
    ScimToken,
)
from geolibre_server_api.oidc import OidcError, fetch_json
from geolibre_server_api.org_models import Group, OrganizationRole
from geolibre_server_api.policy import organization_role, require_organization_admin
from geolibre_server_api.proxy_identity import client_ip

SCOPE_TOKEN_RE = re.compile(r"^[A-Za-z0-9:._-]{1,64}$")


class SecurityPolicyBody(BaseModel):
    """Full replacement of an organization's security policy; omitted = unset."""

    idle_timeout_seconds: int | None = Field(
        default=None, alias="idleTimeoutSeconds", ge=300, le=2592000
    )
    absolute_session_seconds: int | None = Field(
        default=None, alias="absoluteSessionSeconds", ge=900, le=31536000
    )
    admin_reauth_seconds: int | None = Field(
        default=None, alias="adminReauthSeconds", ge=60, le=86400
    )
    password_min_length: int | None = Field(default=None, alias="passwordMinLength", ge=8, le=128)
    password_min_classes: int | None = Field(default=None, alias="passwordMinClasses", ge=1, le=4)
    password_max_age_days: int | None = Field(
        default=None, alias="passwordMaxAgeDays", ge=1, le=3650
    )
    lockout_threshold: int | None = Field(default=None, alias="lockoutThreshold", ge=3, le=100)
    lockout_seconds: int | None = Field(default=None, alias="lockoutSeconds", ge=60, le=86400)
    admin_ip_allowlist: list[str] = Field(
        default_factory=list, alias="adminIpAllowlist", max_length=50
    )

    model_config = {"extra": "forbid", "populate_by_name": True}


def security_policy_json(row: OrganizationSecurityPolicy | None) -> dict:
    if row is None:
        return {
            "idleTimeoutSeconds": None,
            "absoluteSessionSeconds": None,
            "adminReauthSeconds": None,
            "adminIpAllowlist": [],
            "passwordMinLength": None,
            "passwordMinClasses": None,
            "passwordMaxAgeDays": None,
            "lockoutThreshold": None,
            "lockoutSeconds": None,
        }
    return {
        "idleTimeoutSeconds": row.idle_timeout_seconds,
        "absoluteSessionSeconds": row.absolute_session_seconds,
        "adminReauthSeconds": row.admin_reauth_seconds,
        "adminIpAllowlist": json.loads(row.admin_ip_allowlist_json or "[]"),
        "passwordMinLength": row.password_min_length,
        "passwordMinClasses": row.password_min_classes,
        "passwordMaxAgeDays": row.password_max_age_days,
        "lockoutThreshold": row.lockout_threshold,
        "lockoutSeconds": row.lockout_seconds,
    }


class RoleMappingBody(BaseModel):
    value: str = Field(min_length=1, max_length=255)
    role: OrganizationRole

    model_config = {"extra": "forbid", "populate_by_name": True}


class GroupMappingBody(BaseModel):
    value: str = Field(min_length=1, max_length=255)
    group_id: str = Field(alias="groupId")

    model_config = {"extra": "forbid", "populate_by_name": True}


class IdentityProviderBody(BaseModel):
    """An organization's OpenID Connect provider; omitted endpoints use discovery."""

    issuer: str = Field(max_length=512)
    client_id: str = Field(alias="clientId", min_length=1, max_length=255)
    client_secret: str | None = Field(
        default=None, alias="clientSecret", min_length=1, max_length=512
    )
    authorization_endpoint: str | None = Field(default=None, alias="authorizationEndpoint")
    token_endpoint: str | None = Field(default=None, alias="tokenEndpoint")
    jwks_uri: str | None = Field(default=None, alias="jwksUri")
    token_endpoint_auth_method: Literal["client_secret_basic", "client_secret_post"] = Field(
        default="client_secret_basic", alias="tokenEndpointAuthMethod"
    )
    scopes: list[str] = Field(default_factory=lambda: ["openid", "email", "profile"], max_length=20)
    username_claim: str = Field(default="preferred_username", alias="usernameClaim", max_length=64)
    email_claim: str = Field(default="email", alias="emailClaim", max_length=64)
    groups_claim: str | None = Field(default="groups", alias="groupsClaim", max_length=64)
    default_role: OrganizationRole = Field(default="member", alias="defaultRole")
    role_mappings: list[RoleMappingBody] = Field(
        default_factory=list, alias="roleMappings", max_length=100
    )
    group_mappings: list[GroupMappingBody] = Field(
        default_factory=list, alias="groupMappings", max_length=100
    )
    require_mfa: bool = Field(default=False, alias="requireMfa")
    allow_builtin_accounts: bool = Field(default=True, alias="allowBuiltinAccounts")
    enabled: bool = True
    break_glass_username: str | None = Field(default=None, alias="breakGlassUsername")

    model_config = {"extra": "forbid", "populate_by_name": True}


def _is_https_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        return parsed.scheme == "https" and bool(parsed.hostname)
    except ValueError:
        return False


def discover_endpoints(http: httpx.Client, issuer: str) -> tuple[str, str, str]:
    """Read (authorization, token, jwks) endpoints from the issuer's discovery document."""
    failed = HTTPException(422, "identity provider discovery failed")
    try:
        document = fetch_json(http, "GET", f"{issuer.rstrip('/')}/.well-known/openid-configuration")
    except OidcError:
        raise failed from None
    if document.get("issuer") != issuer:
        raise failed
    endpoints = tuple(
        document.get(key) for key in ("authorization_endpoint", "token_endpoint", "jwks_uri")
    )
    if not all(isinstance(value, str) and _is_https_url(value) for value in endpoints):
        raise failed
    return endpoints


def identity_provider_json(
    session: Session, request: Request, provider: OrganizationIdentityProvider
) -> dict:
    oauth_config = request.app.state.oauth_config
    break_glass_username = (
        session.scalar(
            select(Account.username).where(Account.id == provider.break_glass_account_id)
        )
        if provider.break_glass_account_id
        else None
    )
    return {
        "protocol": provider.protocol,
        "issuer": provider.issuer,
        "clientId": provider.client_id,
        "clientSecretSet": True,
        "authorizationEndpoint": provider.authorization_endpoint,
        "tokenEndpoint": provider.token_endpoint,
        "jwksUri": provider.jwks_uri,
        "tokenEndpointAuthMethod": provider.token_endpoint_auth_method,
        "scopes": provider.scopes.split(),
        "usernameClaim": provider.username_claim,
        "emailClaim": provider.email_claim,
        "groupsClaim": provider.groups_claim,
        "defaultRole": provider.default_role,
        "roleMappings": json.loads(provider.role_mappings_json or "[]"),
        "groupMappings": json.loads(provider.group_mappings_json or "[]"),
        "requireMfa": provider.require_mfa,
        "allowBuiltinAccounts": provider.allow_builtin_accounts,
        "breakGlassUsername": break_glass_username,
        "enabled": provider.enabled,
        "redirectUri": (
            f"{oauth_config.issuer}/oauth/sso/callback" if oauth_config is not None else None
        ),
        "updatedAt": iso_ts(provider.updated_at),
    }


def _provider_for(
    session: Session, organization_id: str, *, lock: bool = False
) -> OrganizationIdentityProvider | None:
    query = select(OrganizationIdentityProvider).where(
        OrganizationIdentityProvider.organization_id == organization_id
    )
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    return session.scalar(query)


def _require_no_linked_identities(session: Session, provider: OrganizationIdentityProvider) -> None:
    """Refuse a new issuer or key set while accounts are linked by `sub` to this provider."""
    linked = session.scalar(
        select(FederatedIdentity.id).where(FederatedIdentity.provider_id == provider.id).limit(1)
    )
    if linked is not None:
        raise HTTPException(
            409, "issuer or JWKS endpoint cannot change while federated identities are linked"
        )


class ScimTokenBody(BaseModel):
    """A new SCIM token for an organization's identity provider."""

    label: str = Field(min_length=1, max_length=100)

    model_config = {"extra": "forbid", "populate_by_name": True}


def scim_token_json(row: ScimToken) -> dict:
    return {
        "id": row.id,
        "label": row.label,
        "createdAt": iso_ts(row.created_at),
        "lastUsedAt": iso_ts(row.last_used_at) if row.last_used_at is not None else None,
        "revokedAt": iso_ts(row.revoked_at) if row.revoked_at is not None else None,
    }


def build_enterprise_admin_router() -> APIRouter:
    """Build the per-organization enterprise sign-in administration routes."""
    router = APIRouter()

    @router.get("/api/organizations/{organization_id}/security-policy")
    def get_security_policy(
        organization_id: str,
        request: Request,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=False)
        response.headers["Cache-Control"] = "private, no-store"
        row = session.get(OrganizationSecurityPolicy, organization_id)
        return {"securityPolicy": security_policy_json(row)}

    @router.put("/api/organizations/{organization_id}/security-policy")
    def put_security_policy(
        organization_id: str,
        body: SecurityPolicyBody,
        request: Request,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=True)
        response.headers["Cache-Control"] = "private, no-store"
        networks = []
        for entry in body.admin_ip_allowlist:
            try:
                networks.append(ipaddress.ip_network(entry.strip(), strict=False))
            except ValueError:
                raise HTTPException(
                    422, "adminIpAllowlist entries must be IP addresses or networks"
                ) from None
        if (body.lockout_threshold is None) != (body.lockout_seconds is None):
            raise HTTPException(422, "lockoutThreshold and lockoutSeconds must be set together")
        if networks:
            address = client_ip(request)
            if address is None or not any(address in network for network in networks):
                raise HTTPException(422, "adminIpAllowlist must include your current address")

        row = session.get(OrganizationSecurityPolicy, organization_id)
        if row is None:
            row = OrganizationSecurityPolicy(organization_id=organization_id)
            session.add(row)
        row.idle_timeout_seconds = body.idle_timeout_seconds
        row.absolute_session_seconds = body.absolute_session_seconds
        row.admin_reauth_seconds = body.admin_reauth_seconds
        row.password_min_length = body.password_min_length
        row.password_min_classes = body.password_min_classes
        row.password_max_age_days = body.password_max_age_days
        row.lockout_threshold = body.lockout_threshold
        row.lockout_seconds = body.lockout_seconds
        row.admin_ip_allowlist_json = json.dumps([str(network) for network in networks])
        row.updated_at = get_clock(request)()
        session.commit()
        return {"securityPolicy": security_policy_json(row)}

    @router.get("/api/organizations/{organization_id}/identity-provider")
    def get_identity_provider(
        organization_id: str,
        request: Request,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=False)
        response.headers["Cache-Control"] = "private, no-store"
        provider = _provider_for(session, organization_id)
        if provider is None:
            raise HTTPException(404, "identity provider not configured")
        return {"identityProvider": identity_provider_json(session, request, provider)}

    @router.put("/api/organizations/{organization_id}/identity-provider")
    def put_identity_provider(
        organization_id: str,
        body: IdentityProviderBody,
        request: Request,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=True)
        response.headers["Cache-Control"] = "private, no-store"
        # The issuer is compared exactly with the ID token's iss; never normalize it.
        if not _is_https_url(body.issuer) or "?" in body.issuer or "#" in body.issuer:
            raise HTTPException(422, "issuer must be an https URL without query or fragment")
        provider = _provider_for(session, organization_id)
        original_provider_id = provider.id if provider is not None else None
        if provider is not None and (
            provider.issuer != body.issuer
            or (body.jwks_uri is not None and provider.jwks_uri != body.jwks_uri)
        ):
            _require_no_linked_identities(session, provider)
        given = [
            value
            for value in (body.authorization_endpoint, body.token_endpoint, body.jwks_uri)
            if value is not None
        ]
        if given and len(given) != 3:
            raise HTTPException(422, "set all three endpoints or none")
        if not all(_is_https_url(value) for value in given):
            raise HTTPException(422, "identity provider endpoints must be https URLs")
        if "openid" not in body.scopes or not all(
            SCOPE_TOKEN_RE.fullmatch(scope) for scope in body.scopes
        ):
            raise HTTPException(422, "scopes must include openid and use simple scope tokens")
        if provider is None and body.client_secret is None:
            raise HTTPException(422, "clientSecret is required")
        group_ids = {mapping.group_id for mapping in body.group_mappings}
        if group_ids:
            found = set(
                session.scalars(
                    select(Group.id).where(
                        Group.id.in_(group_ids), Group.organization_id == organization_id
                    )
                )
            )
            if found != group_ids:
                raise HTTPException(422, "group mapping must name a group in this organization")
        break_glass_id = None
        if body.break_glass_username is not None:
            break_glass_id = session.scalar(
                select(Account.id).where(Account.username == body.break_glass_username)
            )
            if (
                break_glass_id is None
                or organization_role(session, organization_id, break_glass_id) != "administrator"
            ):
                raise HTTPException(
                    422, "break-glass account must be an organization administrator"
                )
        elif not body.allow_builtin_accounts:
            raise HTTPException(
                422, "a break-glass administrator is required when built-in accounts are disallowed"
            )
        if given:
            authorization_endpoint, token_endpoint, jwks_uri = given
        else:
            authorization_endpoint, token_endpoint, jwks_uri = discover_endpoints(
                request.app.state.oidc_http, body.issuer
            )

        now_ts = get_clock(request)()
        if original_provider_id is not None:
            # Lock the row an SSO callback locks while linking an identity, so
            # no identity links between the guard below and this commit. Taken
            # only now: discovery above must not hold it across a network call.
            provider = _provider_for(session, organization_id, lock=True)
            if provider is None or provider.id != original_provider_id:
                raise HTTPException(409, "identity provider was removed or replaced; try again")
        if provider is None:
            provider = OrganizationIdentityProvider(
                id=str(uuid.uuid4()),
                organization_id=organization_id,
                protocol="oidc",
                created_at=now_ts,
            )
            session.add(provider)
        elif provider.issuer != body.issuer or provider.jwks_uri != jwks_uri:
            # Discovery can name a different JWKS endpoint than the one stored.
            _require_no_linked_identities(session, provider)
            # Keys cached from another issuer or key set must never verify tokens.
            provider.jwks_json = None
            provider.jwks_fetched_at = None
        provider.issuer = body.issuer
        provider.client_id = body.client_id
        if body.client_secret is not None:
            provider.client_secret = body.client_secret
        provider.authorization_endpoint = authorization_endpoint
        provider.token_endpoint = token_endpoint
        provider.jwks_uri = jwks_uri
        provider.token_endpoint_auth_method = body.token_endpoint_auth_method
        provider.scopes = " ".join(body.scopes)
        provider.username_claim = body.username_claim
        provider.email_claim = body.email_claim
        provider.groups_claim = body.groups_claim
        provider.default_role = body.default_role
        provider.role_mappings_json = json.dumps(
            [{"value": mapping.value, "role": mapping.role} for mapping in body.role_mappings]
        )
        provider.group_mappings_json = json.dumps(
            [
                {"value": mapping.value, "groupId": mapping.group_id}
                for mapping in body.group_mappings
            ]
        )
        provider.require_mfa = body.require_mfa
        provider.allow_builtin_accounts = body.allow_builtin_accounts
        provider.enabled = body.enabled
        provider.break_glass_account_id = break_glass_id
        provider.updated_at = now_ts
        try:
            session.commit()
        except IntegrityError:
            # A concurrent first PUT created this organization's provider.
            session.rollback()
            raise HTTPException(409, "identity provider changed concurrently; retry") from None
        return {"identityProvider": identity_provider_json(session, request, provider)}

    @router.delete("/api/organizations/{organization_id}/identity-provider", status_code=204)
    def delete_identity_provider(
        organization_id: str,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=True)
        # The foreign keys cascade federated identities and pending login states.
        session.execute(
            delete(OrganizationIdentityProvider).where(
                OrganizationIdentityProvider.organization_id == organization_id
            )
        )
        session.commit()
        return Response(status_code=204, headers={"Cache-Control": "private, no-store"})

    @router.post("/api/organizations/{organization_id}/scim-tokens", status_code=201)
    def create_scim_token(
        organization_id: str,
        body: ScimTokenBody,
        request: Request,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=True)
        response.headers["Cache-Control"] = "private, no-store"
        token = secrets.token_urlsafe(32)
        row = ScimToken(
            id=str(uuid.uuid4()),
            organization_id=organization_id,
            created_by_id=principal.account.id,
            digest=token_digest(token),
            label=body.label,
            created_at=get_clock(request)(),
        )
        session.add(row)
        session.commit()
        return {
            "token": token,
            "scimToken": scim_token_json(row),
            "baseUrl": f"{request.app.state.base_url}/scim/v2/{organization_id}",
        }

    @router.get("/api/organizations/{organization_id}/scim-tokens")
    def list_scim_tokens(
        organization_id: str,
        request: Request,
        response: Response,
        principal: AuthPrincipal = Depends(require_scope("read:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=False)
        response.headers["Cache-Control"] = "private, no-store"
        rows = session.scalars(
            select(ScimToken)
            .where(ScimToken.organization_id == organization_id)
            .order_by(ScimToken.created_at.desc(), ScimToken.id)
        )
        return {"scimTokens": [scim_token_json(row) for row in rows]}

    @router.delete("/api/organizations/{organization_id}/scim-tokens/{token_id}", status_code=204)
    def revoke_scim_token(
        organization_id: str,
        token_id: str,
        request: Request,
        principal: AuthPrincipal = Depends(require_scope("write:projects")),
        session: Session = Depends(get_session),
    ):
        require_organization_admin(session, organization_id, principal, request, mutation=True)
        row = session.get(ScimToken, token_id)
        if row is None or row.organization_id != organization_id:
            raise HTTPException(404, "SCIM token not found")
        # Revoking again keeps the first revocation time.
        session.execute(
            update(ScimToken)
            .where(ScimToken.id == token_id, ScimToken.revoked_at.is_(None))
            .values(revoked_at=get_clock(request)())
        )
        session.commit()
        return Response(status_code=204, headers={"Cache-Control": "private, no-store"})

    return router
