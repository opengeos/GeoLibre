"""SCIM 2.0 (RFC 7643/7644) provisioning of one organization's users and groups.

An identity provider authenticates with a SCIM token an organization
administrator minted (``enterprise_admin``). Bodies are parsed by hand so every
failure is an RFC 7644 error message, and every response is
``application/scim+json``.

Deactivation is the load-bearing rule. An account the organization manages
(provisioned by its SCIM or created by its single sign-on) is deactivated
outright, which revokes every credential in the same transaction. Any other
account only loses its membership in this organization and its groups, so one
organization can never lock an account out of another.
"""

from __future__ import annotations

import json
import re
import uuid

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from geolibre_server_api import auth
from geolibre_server_api.auth import get_clock, get_session, iso_ts, token_digest
from geolibre_server_api.auth_models import Account
from geolibre_server_api.enterprise_models import (
    AccountSecurity,
    FederatedIdentity,
    OrganizationIdentityProvider,
    ScimGroup,
    ScimToken,
    ScimUser,
)
from geolibre_server_api.oidc import SSO_PASSWORD_HASH, derive_username
from geolibre_server_api.org_models import Group, GroupMember, Organization, OrganizationMember
from geolibre_server_api.policy import (
    deactivate_account,
    is_deactivated,
    is_last_active_admin,
    organization_role,
    reactivate_account,
)
from geolibre_server_api.projects import demote_disallowed_public_projects

SCIM_MEDIA_TYPE = "application/scim+json"
USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group"
LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
SERVICE_PROVIDER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"
RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType"
SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema"
MAX_RESULTS = 100
# Token last-use is recorded at most once a minute, like OAuth sessions.
TOUCH_SECONDS = 60

_QUOTED = r'"((?:[^"\\]|\\.)*)"'
USER_FILTER_RE = re.compile(rf"^(userName|externalId) eq {_QUOTED}$")
GROUP_FILTER_RE = re.compile(rf"^(displayName|externalId) eq {_QUOTED}$")
MEMBER_PATH_RE = re.compile(rf"^members\[value eq {_QUOTED}\]$", re.IGNORECASE)
# Attribute names are case-insensitive (RFC 7643 section 2.1). Entra ID
# addresses the work email with a value-filter path.
USER_ATTRIBUTES = {
    "username": "userName",
    "externalid": "externalId",
    "displayname": "displayName",
    "emails": "emails",
    'emails[type eq "work"].value': "workEmail",
    "active": "active",
}
GROUP_ATTRIBUTES = {"displayname": "displayName", "externalid": "externalId", "members": "members"}


class ScimError(Exception):
    """A SCIM failure, serialized by ``create_app`` as an RFC 7644 error message."""

    def __init__(
        self,
        status: int,
        detail: str,
        scim_type: str | None = None,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.scim_type = scim_type
        self.headers = headers


def _unsupported_patch() -> ScimError:
    return ScimError(400, "unsupported patch operation", "invalidSyntax")


def scim_response(
    content: dict, status_code: int = 200, headers: dict[str, str] | None = None
) -> JSONResponse:
    return JSONResponse(
        content, status_code=status_code, media_type=SCIM_MEDIA_TYPE, headers=headers
    )


def scim_organization(
    organization_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> ScimToken:
    """Authenticate the identity provider's SCIM token for this organization."""
    header = request.headers.get("authorization", "")
    token = header[7:] if header.startswith("Bearer ") else ""
    row = None
    if token:
        row = session.scalar(
            select(ScimToken).where(
                ScimToken.digest == token_digest(token),
                ScimToken.organization_id == organization_id,
                ScimToken.revoked_at.is_(None),
            )
        )
    # The token acts for its creator (who owns SCIM groups): it stops working
    # while the creator is not an active administrator of the organization.
    if row is not None and (
        organization_role(session, organization_id, row.created_by_id) != "administrator"
        or is_deactivated(session, row.created_by_id)
    ):
        row = None
    if row is None:
        raise ScimError(401, "invalid SCIM token", None, {"WWW-Authenticate": "Bearer"})
    now_ts = get_clock(request)()
    if row.last_used_at is None or row.last_used_at < now_ts - TOUCH_SECONDS:
        session.execute(update(ScimToken).where(ScimToken.id == row.id).values(last_used_at=now_ts))
        session.commit()
    return row


async def scim_body(request: Request) -> dict:
    """The request's JSON object (``application/scim+json`` or ``application/json``)."""
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type not in (SCIM_MEDIA_TYPE, "application/json"):
        raise ScimError(415, "content type must be application/scim+json")
    try:
        body = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        raise ScimError(400, "invalid JSON body", "invalidSyntax") from None
    if not isinstance(body, dict):
        raise ScimError(400, "invalid JSON body", "invalidSyntax")
    return body


def _unescape(value: str) -> str:
    return re.sub(r"\\(.)", r"\1", value)


def _pagination(request: Request) -> tuple[int, int]:
    """``startIndex`` and ``count``, clamped to 1.. and 0..100 (RFC 7644 section 3.4.2.4)."""

    def read(name: str, default: int) -> int:
        raw = request.query_params.get(name)
        if raw is None:
            return default
        try:
            return int(raw)
        except ValueError:
            raise ScimError(400, f"{name} must be an integer", "invalidValue") from None

    start = max(1, read("startIndex", 1))
    count = min(max(0, read("count", MAX_RESULTS)), MAX_RESULTS)
    return start, count


def _list_response(resources: list[dict], total: int, start: int) -> dict:
    return {
        "schemas": [LIST_SCHEMA],
        "totalResults": total,
        "startIndex": start,
        "itemsPerPage": len(resources),
        "Resources": resources,
    }


def _location(request: Request, organization_id: str, path: str) -> str:
    return f"{request.app.state.base_url}/scim/v2/{organization_id}/{path}"


# ---------------------------------------------------------------------------
# Attribute parsing
# ---------------------------------------------------------------------------


def _optional_string(name: str, value: object, max_length: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > max_length:
        raise ScimError(
            400, f"{name} must be a string of at most {max_length} characters", "invalidValue"
        )
    return value or None


def _user_name(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 255:
        raise ScimError(400, "userName must be a string of 1 to 255 characters", "invalidValue")
    return value.lower()


def _active(value: object) -> bool:
    # Entra ID sends "True"/"False" strings in PATCH operations.
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in ("true", "false"):
        return value.lower() == "true"
    raise ScimError(400, "active must be a boolean", "invalidValue")


def _primary_email(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ScimError(400, "emails must be a list of objects", "invalidValue")
    if not value:
        return None
    primary = next(
        (item for item in value if item.get("primary") is True or item.get("primary") == "true"),
        value[0],
    )
    return _optional_string("emails.value", primary.get("value"), 320)


def _user_change(attribute: str, value: object) -> dict:
    """One user attribute as a column update."""
    if attribute == "userName":
        return {"user_name": _user_name(value)}
    if attribute == "externalId":
        return {"external_id": _optional_string("externalId", value, 255)}
    if attribute == "displayName":
        return {"display_name": _optional_string("displayName", value, 255)}
    if attribute == "emails":
        return {"email": _primary_email(value)}
    if attribute == "workEmail":
        return {"email": _optional_string("emails.value", value, 320)}
    return {"active": _active(value)}


def _user_changes(values: dict) -> dict:
    """Column updates for the supported attributes of a user object; others are ignored."""
    changes: dict = {}
    for key, value in values.items():
        attribute = USER_ATTRIBUTES.get(key.lower()) if isinstance(key, str) else None
        if attribute is not None:
            changes.update(_user_change(attribute, value))
    return changes


def _patch_operations(body: dict) -> list[tuple[str, str | None, object]]:
    """``(op, path, value)`` triples of a PatchOp request; ``op`` lowercased."""
    schemas = body.get("schemas")
    operations = body.get("Operations")
    if not isinstance(schemas, list) or PATCH_SCHEMA not in schemas:
        raise ScimError(400, "PatchOp schema required", "invalidSyntax")
    if not isinstance(operations, list):
        raise ScimError(400, "Operations must be a list", "invalidSyntax")
    parsed = []
    for operation in operations:
        if not isinstance(operation, dict) or not isinstance(operation.get("op"), str):
            raise _unsupported_patch()
        path = operation.get("path")
        if path is not None and not isinstance(path, str):
            raise _unsupported_patch()
        parsed.append(
            (operation["op"].lower(), path.strip() if path else None, operation.get("value"))
        )
    return parsed


def _member_ids(value: object) -> list[str]:
    if not isinstance(value, list) or not all(
        isinstance(item, dict) and isinstance(item.get("value"), str) for item in value
    ):
        raise ScimError(400, "members must be a list of objects with a value", "invalidValue")
    return list(dict.fromkeys(item["value"] for item in value))


def _group_changes(values: dict) -> dict:
    changes: dict = {}
    for key, value in values.items():
        attribute = GROUP_ATTRIBUTES.get(key.lower()) if isinstance(key, str) else None
        if attribute == "displayName":
            if not isinstance(value, str) or not value.strip():
                raise ScimError(400, "displayName is required", "invalidValue")
            changes["name"] = value.strip()[:100]
        elif attribute == "externalId":
            changes["external_id"] = _optional_string("externalId", value, 255)
        elif attribute == "members":
            changes["members"] = _member_ids(value)
    return changes


# ---------------------------------------------------------------------------
# Membership and deactivation
# ---------------------------------------------------------------------------


def _default_role(session: Session, organization_id: str) -> str:
    role = session.scalar(
        select(OrganizationIdentityProvider.default_role).where(
            OrganizationIdentityProvider.organization_id == organization_id
        )
    )
    return role or "member"


def _guard_removal(session: Session, organization_id: str, account_id: str) -> None:
    """Refuse to remove or deactivate the last active administrator or the break-glass account."""
    if is_last_active_admin(session, organization_id, account_id):
        raise ScimError(409, "cannot remove the last organization administrator", "mutability")
    break_glass = session.scalar(
        select(OrganizationIdentityProvider.id).where(
            OrganizationIdentityProvider.organization_id == organization_id,
            OrganizationIdentityProvider.break_glass_account_id == account_id,
        )
    )
    if break_glass is not None:
        raise ScimError(
            409, "cannot remove the organization's break-glass administrator", "mutability"
        )


def _remove_memberships(session: Session, organization_id: str, account_id: str) -> None:
    """Drop the account's membership in the organization and its groups (not ownership).

    The caller runs ``_guard_removal`` first.
    """
    session.execute(
        delete(OrganizationMember).where(
            OrganizationMember.organization_id == organization_id,
            OrganizationMember.account_id == account_id,
        )
    )
    # A group's owner row is kept: removing it would leave the group ownerless.
    session.execute(
        delete(GroupMember).where(
            GroupMember.account_id == account_id,
            GroupMember.role != "owner",
            GroupMember.group_id.in_(
                select(Group.id).where(Group.organization_id == organization_id)
            ),
        )
    )
    # Same as leaving through the members API: a non-member may not keep projects public.
    organization = session.get(Organization, organization_id)
    if organization is not None:
        demote_disallowed_public_projects(session, organization, account_id)


def _is_managed(session: Session, organization_id: str, account_id: str) -> bool:
    managed_by = session.scalar(
        select(AccountSecurity.managed_by_organization_id).where(
            AccountSecurity.account_id == account_id
        )
    )
    return managed_by == organization_id


def _deactivate(session: Session, organization_id: str, account_id: str, now_ts: int) -> None:
    _guard_removal(session, organization_id, account_id)
    if _is_managed(session, organization_id, account_id):
        deactivate_account(session, account_id, now_ts)
    else:
        # Authorization reads memberships live, so access ends on the next request.
        _remove_memberships(session, organization_id, account_id)


def _ensure_member(session: Session, organization_id: str, account_id: str) -> None:
    if session.get(OrganizationMember, (organization_id, account_id)) is None:
        session.add(
            OrganizationMember(
                organization_id=organization_id,
                account_id=account_id,
                role=_default_role(session, organization_id),
                created_at=auth.now(),
            )
        )


def _activate(session: Session, organization_id: str, account_id: str, now_ts: int) -> None:
    if _is_managed(session, organization_id, account_id):
        reactivate_account(session, account_id, now_ts)
    _ensure_member(session, organization_id, account_id)


# ---------------------------------------------------------------------------
# Resources
# ---------------------------------------------------------------------------


def _user_query(organization_id: str):
    """ScimUser rows with the account's status and whether it is still a member."""
    return (
        select(ScimUser, AccountSecurity.status, OrganizationMember.account_id)
        .outerjoin(AccountSecurity, AccountSecurity.account_id == ScimUser.account_id)
        .outerjoin(
            OrganizationMember,
            and_(
                OrganizationMember.organization_id == ScimUser.organization_id,
                OrganizationMember.account_id == ScimUser.account_id,
            ),
        )
        .where(ScimUser.organization_id == organization_id)
    )


def _user_json(request: Request, row) -> dict:
    scim_user, status, member_id = row
    location = _location(request, scim_user.organization_id, f"Users/{scim_user.account_id}")
    resource: dict = {
        "schemas": [USER_SCHEMA],
        "id": scim_user.account_id,
        "userName": scim_user.user_name,
        # A non-managed account is deactivated here by losing its membership.
        "active": status != "deactivated" and member_id is not None,
        "meta": {
            "resourceType": "User",
            "created": iso_ts(scim_user.created_at),
            "lastModified": iso_ts(scim_user.updated_at),
            "location": location,
        },
    }
    if scim_user.external_id is not None:
        resource["externalId"] = scim_user.external_id
    if scim_user.display_name is not None:
        resource["displayName"] = scim_user.display_name
    if scim_user.email is not None:
        resource["emails"] = [{"value": scim_user.email, "primary": True}]
    return resource


def _load_user(session: Session, organization_id: str, account_id: str):
    row = session.execute(
        _user_query(organization_id).where(ScimUser.account_id == account_id)
    ).one_or_none()
    if row is None:
        raise ScimError(404, "resource not found")
    return row


def _user_name_taken(
    session: Session, organization_id: str, user_name: str, account_id: str | None = None
) -> bool:
    query = select(ScimUser.account_id).where(
        ScimUser.organization_id == organization_id, ScimUser.user_name == user_name
    )
    if account_id is not None:
        query = query.where(ScimUser.account_id != account_id)
    return session.scalar(query) is not None


def _duplicate_user_name() -> ScimError:
    return ScimError(409, "userName already exists", "uniqueness")


def _adoptable_account(session: Session, organization_id: str, user_name: str) -> str | None:
    """The one account this organization's single sign-on created for ``user_name``.

    Users who signed in before SCIM was set up already have an account: SCIM
    takes it over instead of creating a second one. Only accounts this
    organization manages, linked to its provider, and not yet provisioned here
    qualify, so another organization's, password, or proxy accounts never do.
    The username claim decides first, then the verified email claim; an
    ambiguous match adopts nothing.
    """
    provider_id = session.scalar(
        select(OrganizationIdentityProvider.id).where(
            OrganizationIdentityProvider.organization_id == organization_id
        )
    )
    if provider_id is None:
        return None
    candidates = (
        select(FederatedIdentity.account_id)
        .distinct()
        .join(AccountSecurity, AccountSecurity.account_id == FederatedIdentity.account_id)
        .where(
            FederatedIdentity.provider_id == provider_id,
            AccountSecurity.managed_by_organization_id == organization_id,
            FederatedIdentity.account_id.not_in(
                select(ScimUser.account_id).where(ScimUser.organization_id == organization_id)
            ),
        )
        .limit(2)
    )
    for claimed in (FederatedIdentity.claimed_username, FederatedIdentity.claimed_email):
        matches = session.scalars(candidates.where(claimed == user_name)).all()
        if matches:
            return matches[0] if len(matches) == 1 else None
    return None


def _new_scim_user(organization_id: str, account_id: str, changes: dict, now_ts: int) -> ScimUser:
    return ScimUser(
        organization_id=organization_id,
        account_id=account_id,
        user_name=changes["user_name"],
        external_id=changes["external_id"],
        email=changes["email"],
        display_name=changes["display_name"],
        created_at=now_ts,
        updated_at=now_ts,
    )


def _adopt_account(
    session: Session, organization_id: str, account_id: str, changes: dict, now_ts: int
) -> None:
    """Provision an existing single sign-on account instead of creating one."""
    session.add(_new_scim_user(organization_id, account_id, changes, now_ts))
    session.flush()
    if changes["active"]:
        _activate(session, organization_id, account_id, now_ts)
    else:
        _ensure_member(session, organization_id, account_id)
        _deactivate(session, organization_id, account_id, now_ts)


def _apply_user_changes(session: Session, scim_user: ScimUser, changes: dict, now_ts: int) -> None:
    organization_id = scim_user.organization_id
    user_name = changes.get("user_name")
    if user_name is not None and user_name != scim_user.user_name:
        if _user_name_taken(session, organization_id, user_name, scim_user.account_id):
            raise _duplicate_user_name()
        scim_user.user_name = user_name
    for column in ("external_id", "display_name", "email"):
        if column in changes:
            setattr(scim_user, column, changes[column])
    if "active" in changes:
        if changes["active"]:
            _activate(session, organization_id, scim_user.account_id, now_ts)
        else:
            _deactivate(session, organization_id, scim_user.account_id, now_ts)
    scim_user.updated_at = now_ts


def _commit_user(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise _duplicate_user_name() from None


def _group_member_rows(session: Session, group_id: str) -> list[tuple[str, str | None]]:
    return list(
        session.execute(
            select(GroupMember.account_id, Account.username)
            .join(Account, Account.id == GroupMember.account_id)
            .where(
                GroupMember.group_id == group_id,
                GroupMember.role == "member",
                GroupMember.status == "accepted",
            )
            .order_by(GroupMember.created_at, GroupMember.account_id)
        ).all()
    )


def _group_json(request: Request, session: Session, group: Group, scim_group: ScimGroup) -> dict:
    members = []
    for account_id, username in _group_member_rows(session, group.id):
        member = {"value": account_id}
        if username is not None:
            member["display"] = username
        members.append(member)
    resource: dict = {
        "schemas": [GROUP_SCHEMA],
        "id": group.id,
        "displayName": group.name,
        "members": members,
        "meta": {
            "resourceType": "Group",
            "created": iso_ts(scim_group.created_at),
            "lastModified": iso_ts(scim_group.updated_at),
            "location": _location(request, scim_group.organization_id, f"Groups/{group.id}"),
        },
    }
    if scim_group.external_id is not None:
        resource["externalId"] = scim_group.external_id
    return resource


def _load_group(session: Session, organization_id: str, group_id: str) -> tuple[Group, ScimGroup]:
    row = session.execute(
        select(Group, ScimGroup)
        .join(ScimGroup, ScimGroup.group_id == Group.id)
        .where(
            Group.id == group_id,
            Group.organization_id == organization_id,
            ScimGroup.organization_id == organization_id,
        )
    ).one_or_none()
    if row is None:
        raise ScimError(404, "resource not found")
    return row[0], row[1]


def _require_provisioned(session: Session, organization_id: str, account_ids: list[str]) -> None:
    """Group members must be provisioned users who are active members of the organization."""
    if not account_ids:
        return
    found = set(
        session.scalars(
            select(ScimUser.account_id)
            .join(
                OrganizationMember,
                and_(
                    OrganizationMember.organization_id == ScimUser.organization_id,
                    OrganizationMember.account_id == ScimUser.account_id,
                ),
            )
            .outerjoin(AccountSecurity, AccountSecurity.account_id == ScimUser.account_id)
            .where(
                ScimUser.organization_id == organization_id,
                ScimUser.account_id.in_(account_ids),
                or_(AccountSecurity.status.is_(None), AccountSecurity.status != "deactivated"),
            )
        )
    )
    if found != set(account_ids):
        raise ScimError(400, "member is not provisioned in this organization", "invalidValue")


def _add_members(session: Session, group_id: str, account_ids: list[str]) -> None:
    """Add plain members; owner and manager rows are never modified."""
    for account_id in account_ids:
        row = session.get(GroupMember, (group_id, account_id))
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
        elif row.role == "member" and row.status != "accepted":
            row.status = "accepted"
    session.flush()


def _remove_members(session: Session, group_id: str, account_ids: list[str] | None) -> None:
    """Remove plain members (all of them when ``account_ids`` is None)."""
    statement = delete(GroupMember).where(
        GroupMember.group_id == group_id, GroupMember.role == "member"
    )
    if account_ids is not None:
        statement = statement.where(GroupMember.account_id.in_(account_ids))
    session.execute(statement)


def _replace_members(session: Session, group_id: str, account_ids: list[str]) -> None:
    session.execute(
        delete(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.role == "member",
            GroupMember.account_id.not_in(account_ids),
        )
    )
    _add_members(session, group_id, account_ids)


# ---------------------------------------------------------------------------
# Discovery documents
# ---------------------------------------------------------------------------


def _attribute(
    name: str,
    type_: str = "string",
    *,
    multi_valued: bool = False,
    required: bool = False,
    mutability: str = "readWrite",
    uniqueness: str = "none",
    sub_attributes: list[dict] | None = None,
) -> dict:
    attribute = {
        "name": name,
        "type": type_,
        "multiValued": multi_valued,
        "required": required,
        "caseExact": False,
        "mutability": mutability,
        "returned": "default",
        "uniqueness": uniqueness,
    }
    if sub_attributes is not None:
        attribute["subAttributes"] = sub_attributes
    return attribute


SCHEMA_DEFINITIONS = [
    {
        "id": USER_SCHEMA,
        "name": "User",
        "description": "User account",
        "attributes": [
            _attribute("userName", required=True, uniqueness="server"),
            _attribute("displayName"),
            _attribute("active", "boolean"),
            _attribute(
                "emails",
                "complex",
                multi_valued=True,
                sub_attributes=[
                    _attribute("value"),
                    _attribute("type"),
                    _attribute("primary", "boolean"),
                ],
            ),
        ],
    },
    {
        "id": GROUP_SCHEMA,
        "name": "Group",
        "description": "Group",
        "attributes": [
            _attribute("displayName", required=True),
            _attribute(
                "members",
                "complex",
                multi_valued=True,
                sub_attributes=[
                    _attribute("value", mutability="immutable"),
                    _attribute("display", mutability="readOnly"),
                ],
            ),
        ],
    },
]


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def build_scim_router() -> APIRouter:
    """Build the SCIM 2.0 service provider for ``/scim/v2/{organization_id}``."""
    router = APIRouter(
        prefix="/scim/v2/{organization_id}", dependencies=[Depends(scim_organization)]
    )

    # -- discovery --

    @router.get("/ServiceProviderConfig")
    def service_provider_config(organization_id: str, request: Request):
        return scim_response(
            {
                "schemas": [SERVICE_PROVIDER_SCHEMA],
                "patch": {"supported": True},
                "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
                "filter": {"supported": True, "maxResults": MAX_RESULTS},
                "changePassword": {"supported": False},
                "sort": {"supported": False},
                "etag": {"supported": False},
                "authenticationSchemes": [
                    {
                        "type": "oauthbearertoken",
                        "name": "OAuth Bearer Token",
                        "description": "SCIM token issued by an organization administrator",
                    }
                ],
                "meta": {
                    "resourceType": "ServiceProviderConfig",
                    "location": _location(request, organization_id, "ServiceProviderConfig"),
                },
            }
        )

    @router.get("/ResourceTypes")
    def resource_types(organization_id: str, request: Request):
        resources = [
            {
                "schemas": [RESOURCE_TYPE_SCHEMA],
                "id": name,
                "name": name,
                "endpoint": f"/{name}s",
                "schema": schema,
                "meta": {
                    "resourceType": "ResourceType",
                    "location": _location(request, organization_id, f"ResourceTypes/{name}"),
                },
            }
            for name, schema in (("User", USER_SCHEMA), ("Group", GROUP_SCHEMA))
        ]
        return scim_response(_list_response(resources, len(resources), 1))

    @router.get("/Schemas")
    def schemas(organization_id: str, request: Request):
        resources = [
            {
                "schemas": [SCHEMA_SCHEMA],
                **definition,
                "meta": {
                    "resourceType": "Schema",
                    "location": _location(request, organization_id, f"Schemas/{definition['id']}"),
                },
            }
            for definition in SCHEMA_DEFINITIONS
        ]
        return scim_response(_list_response(resources, len(resources), 1))

    # -- users --

    @router.get("/Users")
    def list_users(organization_id: str, request: Request, session: Session = Depends(get_session)):
        start, count = _pagination(request)
        query = _user_query(organization_id)
        raw_filter = request.query_params.get("filter")
        if raw_filter is not None:
            match = USER_FILTER_RE.fullmatch(raw_filter.strip())
            if match is None:
                raise ScimError(400, "unsupported filter", "invalidFilter")
            attribute, value = match.group(1), _unescape(match.group(2))
            if attribute == "userName":
                query = query.where(ScimUser.user_name == value.lower())
            else:
                query = query.where(ScimUser.external_id == value)
        total = session.scalar(select(func.count()).select_from(query.subquery()))
        rows = session.execute(
            query.order_by(ScimUser.created_at, ScimUser.account_id).offset(start - 1).limit(count)
        ).all()
        return scim_response(
            _list_response([_user_json(request, row) for row in rows], total or 0, start)
        )

    @router.post("/Users")
    def create_user(
        organization_id: str,
        request: Request,
        body: dict = Depends(scim_body),
        session: Session = Depends(get_session),
    ):
        changes = {
            "external_id": None,
            "display_name": None,
            "email": None,
            "active": True,
            **_user_changes(body),
        }
        if "user_name" not in changes:
            raise ScimError(400, "userName is required", "invalidValue")
        user_name = changes["user_name"]
        now_ts = get_clock(request)()

        def created(account_id: str):
            resource = _user_json(request, _load_user(session, organization_id, account_id))
            return scim_response(resource, 201, headers={"Location": resource["meta"]["location"]})

        # A concurrent request may win the userName (409), the adopted account
        # (re-checked), or the derived account username (retried with a fresh one).
        for _ in range(3):
            if _user_name_taken(session, organization_id, user_name):
                raise _duplicate_user_name()
            adopted_id = _adoptable_account(session, organization_id, user_name)
            if adopted_id is not None:
                try:
                    _adopt_account(session, organization_id, adopted_id, changes, now_ts)
                    session.commit()
                except IntegrityError:
                    session.rollback()
                    continue
                return created(adopted_id)
            account = Account(
                id=str(uuid.uuid4()),
                username=derive_username(session, user_name),
                password_hash=SSO_PASSWORD_HASH,
                created_at=auth.now(),
            )
            active = changes["active"]
            try:
                session.add(account)
                session.flush()
                session.add(
                    AccountSecurity(
                        account_id=account.id,
                        status="active" if active else "deactivated",
                        deactivated_at=None if active else now_ts,
                        failed_login_count=0,
                        managed_by_organization_id=organization_id,
                    )
                )
                session.add(_new_scim_user(organization_id, account.id, changes, now_ts))
                session.add(
                    OrganizationMember(
                        organization_id=organization_id,
                        account_id=account.id,
                        role=_default_role(session, organization_id),
                        created_at=auth.now(),
                    )
                )
                session.commit()
            except IntegrityError:
                session.rollback()
                continue
            return created(account.id)
        if _user_name_taken(session, organization_id, user_name):
            raise _duplicate_user_name()
        raise ScimError(409, "could not allocate an account for this user", "uniqueness")

    @router.get("/Users/{user_id}")
    def get_user(
        organization_id: str,
        user_id: str,
        request: Request,
        session: Session = Depends(get_session),
    ):
        return scim_response(_user_json(request, _load_user(session, organization_id, user_id)))

    @router.put("/Users/{user_id}")
    def replace_user(
        organization_id: str,
        user_id: str,
        request: Request,
        body: dict = Depends(scim_body),
        session: Session = Depends(get_session),
    ):
        scim_user = _load_user(session, organization_id, user_id)[0]
        changes = {"external_id": None, "display_name": None, "email": None, **_user_changes(body)}
        if "user_name" not in changes:
            raise ScimError(400, "userName is required", "invalidValue")
        _apply_user_changes(session, scim_user, changes, get_clock(request)())
        _commit_user(session)
        return scim_response(_user_json(request, _load_user(session, organization_id, user_id)))

    @router.patch("/Users/{user_id}")
    def patch_user(
        organization_id: str,
        user_id: str,
        request: Request,
        body: dict = Depends(scim_body),
        session: Session = Depends(get_session),
    ):
        scim_user = _load_user(session, organization_id, user_id)[0]
        changes: dict = {}
        for op, path, value in _patch_operations(body):
            if op in ("add", "replace"):
                if path is None:
                    if not isinstance(value, dict):
                        raise ScimError(400, "patch value must be an object", "invalidValue")
                    changes.update(_user_changes(value))
                    continue
                attribute = USER_ATTRIBUTES.get(path.lower())
                # Entra ID also sends attributes this server does not keep
                # (name.givenName, enterprise extension, ...): ignored.
                if attribute is not None:
                    changes.update(_user_change(attribute, value))
            elif op == "remove" and path is not None:
                attribute = USER_ATTRIBUTES.get(path.lower())
                if attribute == "externalId":
                    changes["external_id"] = None
                elif attribute == "displayName":
                    changes["display_name"] = None
                else:
                    raise _unsupported_patch()
            else:
                raise _unsupported_patch()
        _apply_user_changes(session, scim_user, changes, get_clock(request)())
        _commit_user(session)
        return scim_response(_user_json(request, _load_user(session, organization_id, user_id)))

    @router.delete("/Users/{user_id}", status_code=204)
    def delete_user(
        organization_id: str,
        user_id: str,
        request: Request,
        session: Session = Depends(get_session),
    ):
        scim_user = _load_user(session, organization_id, user_id)[0]
        # The account keeps its single sign-on link, so a deprovisioned user who
        # can still authenticate at the provider reaches this deactivated account
        # (403) instead of a new one.
        _deactivate(session, organization_id, user_id, get_clock(request)())
        _remove_memberships(session, organization_id, user_id)
        session.delete(scim_user)
        session.commit()
        return Response(status_code=204)

    # -- groups --

    @router.get("/Groups")
    def list_groups(
        organization_id: str, request: Request, session: Session = Depends(get_session)
    ):
        start, count = _pagination(request)
        query = (
            select(Group, ScimGroup)
            .join(ScimGroup, ScimGroup.group_id == Group.id)
            .where(
                Group.organization_id == organization_id,
                ScimGroup.organization_id == organization_id,
            )
        )
        raw_filter = request.query_params.get("filter")
        if raw_filter is not None:
            match = GROUP_FILTER_RE.fullmatch(raw_filter.strip())
            if match is None:
                raise ScimError(400, "unsupported filter", "invalidFilter")
            attribute, value = match.group(1), _unescape(match.group(2))
            if attribute == "displayName":
                query = query.where(func.lower(Group.name) == value.lower())
            else:
                query = query.where(ScimGroup.external_id == value)
        total = session.scalar(select(func.count()).select_from(query.subquery()))
        rows = session.execute(
            query.order_by(ScimGroup.created_at, Group.id).offset(start - 1).limit(count)
        ).all()
        resources = [_group_json(request, session, group, scim_group) for group, scim_group in rows]
        return scim_response(_list_response(resources, total or 0, start))

    @router.post("/Groups")
    def create_group(
        organization_id: str,
        request: Request,
        body: dict = Depends(scim_body),
        scim_token: ScimToken = Depends(scim_organization),
        session: Session = Depends(get_session),
    ):
        changes = _group_changes(body)
        if "name" not in changes:
            raise ScimError(400, "displayName is required", "invalidValue")
        member_ids = changes.get("members", [])
        _require_provisioned(session, organization_id, member_ids)
        now_ts = get_clock(request)()
        # The shape of POST /api/groups, owned by the token's creator.
        group = Group(
            id=str(uuid.uuid4()),
            organization_id=organization_id,
            owner_id=scim_token.created_by_id,
            name=changes["name"],
            join_policy="invite",
            created_at=auth.now(),
        )
        session.add(group)
        session.flush()
        session.add(
            GroupMember(
                group_id=group.id,
                account_id=scim_token.created_by_id,
                role="owner",
                status="accepted",
                created_at=auth.now(),
            )
        )
        scim_group = ScimGroup(
            group_id=group.id,
            organization_id=organization_id,
            external_id=changes.get("external_id"),
            created_at=now_ts,
            updated_at=now_ts,
        )
        session.add(scim_group)
        session.flush()
        _add_members(session, group.id, member_ids)
        session.commit()
        resource = _group_json(request, session, group, scim_group)
        return scim_response(resource, 201, headers={"Location": resource["meta"]["location"]})

    @router.get("/Groups/{group_id}")
    def get_group(
        organization_id: str,
        group_id: str,
        request: Request,
        session: Session = Depends(get_session),
    ):
        group, scim_group = _load_group(session, organization_id, group_id)
        return scim_response(_group_json(request, session, group, scim_group))

    @router.put("/Groups/{group_id}")
    def replace_group(
        organization_id: str,
        group_id: str,
        request: Request,
        body: dict = Depends(scim_body),
        session: Session = Depends(get_session),
    ):
        group, scim_group = _load_group(session, organization_id, group_id)
        changes = {"external_id": None, "members": [], **_group_changes(body)}
        if "name" not in changes:
            raise ScimError(400, "displayName is required", "invalidValue")
        _require_provisioned(session, organization_id, changes["members"])
        group.name = changes["name"]
        scim_group.external_id = changes["external_id"]
        _replace_members(session, group.id, changes["members"])
        scim_group.updated_at = get_clock(request)()
        session.commit()
        return scim_response(_group_json(request, session, group, scim_group))

    @router.patch("/Groups/{group_id}")
    def patch_group(
        organization_id: str,
        group_id: str,
        request: Request,
        body: dict = Depends(scim_body),
        session: Session = Depends(get_session),
    ):
        group, scim_group = _load_group(session, organization_id, group_id)

        def apply(changes: dict, *, replace_members: bool) -> None:
            if "name" in changes:
                group.name = changes["name"]
            if "external_id" in changes:
                scim_group.external_id = changes["external_id"]
            if "members" in changes:
                _require_provisioned(session, organization_id, changes["members"])
                if replace_members:
                    _replace_members(session, group.id, changes["members"])
                else:
                    _add_members(session, group.id, changes["members"])

        for op, path, value in _patch_operations(body):
            if op not in ("add", "replace", "remove"):
                raise _unsupported_patch()
            if op == "remove":
                if path is None:
                    raise _unsupported_patch()
                match = MEMBER_PATH_RE.fullmatch(path)
                if match is not None:
                    _remove_members(session, group.id, [_unescape(match.group(1))])
                elif path.lower() == "members":
                    _remove_members(
                        session, group.id, None if value is None else _member_ids(value)
                    )
                elif path.lower() == "externalid":
                    scim_group.external_id = None
                else:
                    raise _unsupported_patch()
                continue
            if path is None:
                if not isinstance(value, dict):
                    raise ScimError(400, "patch value must be an object", "invalidValue")
                changes = _group_changes(value)
            else:
                attribute = GROUP_ATTRIBUTES.get(path.lower())
                if attribute is None:
                    raise _unsupported_patch()
                changes = _group_changes({attribute: value})
            apply(changes, replace_members=op == "replace")
        scim_group.updated_at = get_clock(request)()
        session.commit()
        return scim_response(_group_json(request, session, group, scim_group))

    @router.delete("/Groups/{group_id}", status_code=204)
    def delete_group(
        organization_id: str,
        group_id: str,
        session: Session = Depends(get_session),
    ):
        _load_group(session, organization_id, group_id)
        # The foreign keys cascade members, invitations, project shares, and the SCIM row.
        session.execute(delete(Group).where(Group.id == group_id))
        session.commit()
        return Response(status_code=204)

    return router
