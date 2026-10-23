"""SCIM 2.0 provisioning: tokens, users, groups, and deactivation everywhere."""

from __future__ import annotations

import json

import pytest
from conftest import OAUTH_CLIENTS, PUBLIC_URL, WEB_REDIRECT, _make_app
from fastapi.testclient import TestClient
from geolibre_server_api import auth as server_auth
from geolibre_server_api.auth_models import Account
from geolibre_server_api.enterprise_models import ScimUser
from geolibre_server_api.org_models import GroupMember, OrganizationMember
from geolibre_server_api.policy import deactivate_account
from helpers import (
    add_member,
    admin_token,
    approve,
    auth,
    configure_idp,
    create_org,
    ensure_account,
    exchange_code,
    pat,
    redirect_params,
    refresh,
    sso_sign_in,
    start_authorize,
)
from sqlalchemy import select

ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"
PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
DEACTIVATED = "This account has been deactivated."


def _scim_org(client, slug="acme") -> tuple[str, str, str]:
    """ada administers *slug* with the fake provider; returns (admin token, org id, SCIM token)."""
    token = admin_token(client)
    org_id = create_org(client, token, slug=slug, name=slug.title())
    assert configure_idp(client, token, org_id).status_code == 200
    minted = client.post(
        f"/api/organizations/{org_id}/scim-tokens", json={"label": "Entra"}, headers=auth(token)
    )
    assert minted.status_code == 201, minted.text
    assert minted.json()["baseUrl"] == f"{PUBLIC_URL}/scim/v2/{org_id}"
    return token, org_id, minted.json()["token"]


def _scim(client, scim_token, method, org_id, path, body=None, **kwargs):
    headers = {"Authorization": f"Bearer {scim_token}"}
    if body is not None:
        headers["Content-Type"] = "application/scim+json"
        kwargs["content"] = json.dumps(body)
    return client.request(method, f"/scim/v2/{org_id}{path}", headers=headers, **kwargs)


def _patch(*operations) -> dict:
    return {"schemas": [PATCH_SCHEMA], "Operations": list(operations)}


def _create_user(client, scim_token, org_id, user_name, **extra) -> dict:
    created = _scim(client, scim_token, "POST", org_id, "/Users", {"userName": user_name, **extra})
    assert created.status_code == 201, created.text
    return created.json()


def _sso_tokens(client, callback, verifier) -> dict:
    assert callback.status_code == 303, (callback.status_code, callback.text[:300])
    assert callback.headers["location"].startswith(f"{WEB_REDIRECT}?")
    exchanged = exchange_code(client, redirect_params(callback)["code"], verifier=verifier)
    assert exchanged.status_code == 200, exchanged.text
    return exchanged.json()


def _status(client, token) -> int:
    return client.get("/api/users/me", headers=auth(token)).status_code


def test_scim_token_admin_routes(oauth_client):
    token, org_id, _ = _scim_org(oauth_client)
    listed = oauth_client.get(f"/api/organizations/{org_id}/scim-tokens", headers=auth(token))
    assert listed.status_code == 200
    assert listed.headers["cache-control"] == "private, no-store"
    [entry] = listed.json()["scimTokens"]
    assert entry["label"] == "Entra"
    assert entry["revokedAt"] is None
    assert "token" not in entry

    other_org = create_org(oauth_client, token, slug="other", name="Other")
    foreign = oauth_client.delete(
        f"/api/organizations/{other_org}/scim-tokens/{entry['id']}", headers=auth(token)
    )
    assert foreign.status_code == 404
    assert foreign.json() == {"error": "SCIM token not found"}
    revoked = oauth_client.delete(
        f"/api/organizations/{org_id}/scim-tokens/{entry['id']}", headers=auth(token)
    )
    assert revoked.status_code == 204
    listed = oauth_client.get(f"/api/organizations/{org_id}/scim-tokens", headers=auth(token))
    assert listed.json()["scimTokens"][0]["revokedAt"] is not None

    add_member(oauth_client, token, org_id, "bob")
    member = admin_token(oauth_client, username="bob")
    denied = oauth_client.post(
        f"/api/organizations/{org_id}/scim-tokens", json={"label": "x"}, headers=auth(member)
    )
    assert denied.status_code == 403


def test_scim_token_stops_working_when_creator_loses_admin(oauth_client):
    token, org_id, scim_token = _scim_org(oauth_client)
    ensure_account(oauth_client, "otheradmin")
    add_member(oauth_client, token, org_id, "otheradmin", role="administrator")
    removed = oauth_client.put(
        f"/api/organizations/{org_id}/members",
        json={"username": "ada", "role": "member"},
        headers=auth(token),
    )
    assert removed.status_code == 200
    response = _scim(oauth_client, scim_token, "GET", org_id, "/Users")
    assert response.status_code == 401
    assert response.json()["detail"] == "invalid SCIM token"


def test_provisioned_user_links_to_sso_and_deactivation_revokes_everything(oauth_client, fake_idp):
    _, org_id, scim_token = _scim_org(oauth_client)
    created = _scim(
        oauth_client,
        scim_token,
        "POST",
        org_id,
        "/Users",
        {"userName": "Grace@Example.org", "active": True},
    )
    assert created.status_code == 201, created.text
    assert created.headers["content-type"] == "application/scim+json"
    user = created.json()
    assert user["userName"] == "grace@example.org"
    assert user["active"] is True
    assert created.headers["location"] == f"{PUBLIC_URL}/scim/v2/{org_id}/Users/{user['id']}"

    claims = fake_idp.base_claims("entra-oid-1", preferred_username="grace@example.org")
    tokens = _sso_tokens(oauth_client, *sso_sign_in(oauth_client, fake_idp, "acme", claims))
    me = oauth_client.get("/api/users/me", headers=auth(tokens["access_token"]))
    assert me.status_code == 200, me.text
    assert me.json()["user"]["id"] == user["id"]
    projects = oauth_client.get("/api/projects", headers=auth(tokens["access_token"]))
    assert projects.status_code == 200, projects.text

    app = oauth_client.app
    with app.state.session_factory() as session:
        account = session.get(Account, user["id"])
        personal_token, _ = server_auth.issue_token(
            session, account, name="CI", scopes=["read:projects"], clock=app.state.clock
        )
    assert _status(oauth_client, personal_token) == 200

    deactivated = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Users/{user['id']}",
        _patch({"op": "Replace", "value": {"active": "False"}}),
    )
    assert deactivated.status_code == 200, deactivated.text
    assert deactivated.json()["active"] is False
    # No clock advance: every credential is dead at once.
    assert _status(oauth_client, tokens["access_token"]) == 401
    refreshed = refresh(oauth_client, tokens["refresh_token"])
    assert refreshed.status_code == 400
    assert refreshed.json()["error"] == "invalid_grant"
    assert _status(oauth_client, personal_token) == 401
    blocked, _ = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    assert blocked.status_code == 403
    assert DEACTIVATED in blocked.text

    reactivated = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Users/{user['id']}",
        _patch({"op": "replace", "path": "active", "value": "True"}),
    )
    assert reactivated.status_code == 200, reactivated.text
    assert reactivated.json()["active"] is True
    fresh = _sso_tokens(oauth_client, *sso_sign_in(oauth_client, fake_idp, "acme", claims))
    assert _status(oauth_client, fresh["access_token"]) == 200
    assert _status(oauth_client, tokens["access_token"]) == 401
    assert refresh(oauth_client, tokens["refresh_token"]).status_code == 400
    assert _status(oauth_client, personal_token) == 401


def test_scim_post_adopts_existing_managed_sso_account(oauth_client, fake_idp):
    _, org_id, scim_token = _scim_org(oauth_client)
    claims = fake_idp.base_claims(
        "existing-sso-sub",
        preferred_username="existing@example.org",
        email="existing@example.org",
        email_verified=True,
    )
    tokens = _sso_tokens(oauth_client, *sso_sign_in(oauth_client, fake_idp, "acme", claims))
    account_id = oauth_client.get("/api/users/me", headers=auth(tokens["access_token"])).json()[
        "user"
    ]["id"]
    provisioned = _scim(
        oauth_client,
        scim_token,
        "POST",
        org_id,
        "/Users",
        {"userName": "existing@example.org"},
    )
    assert provisioned.status_code == 201, provisioned.text
    assert provisioned.json()["id"] == account_id
    deactivated = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Users/{account_id}",
        _patch({"op": "replace", "path": "active", "value": False}),
    )
    assert deactivated.status_code == 200
    assert _status(oauth_client, tokens["access_token"]) == 401


def test_scim_email_link_requires_verified_email_and_never_double_links(oauth_client, fake_idp):
    _, org_id, scim_token = _scim_org(oauth_client)
    provisioned = _create_user(oauth_client, scim_token, org_id, "mail@example.org")
    unverified = fake_idp.base_claims(
        "unverified-email-sub",
        preferred_username="different@example.org",
        email="mail@example.org",
        email_verified=False,
    )
    first = _sso_tokens(oauth_client, *sso_sign_in(oauth_client, fake_idp, "acme", unverified))
    first_id = oauth_client.get("/api/users/me", headers=auth(first["access_token"])).json()[
        "user"
    ]["id"]
    assert first_id != provisioned["id"]

    verified = fake_idp.base_claims(
        "first-link-sub",
        preferred_username="mail@example.org",
        email="mail@example.org",
        email_verified=True,
    )
    linked = _sso_tokens(oauth_client, *sso_sign_in(oauth_client, fake_idp, "acme", verified))
    linked_id = oauth_client.get("/api/users/me", headers=auth(linked["access_token"])).json()[
        "user"
    ]["id"]
    assert linked_id == provisioned["id"]
    second_subject = {**verified, "sub": "second-link-sub"}
    separate = _sso_tokens(
        oauth_client, *sso_sign_in(oauth_client, fake_idp, "acme", second_subject)
    )
    separate_id = oauth_client.get("/api/users/me", headers=auth(separate["access_token"])).json()[
        "user"
    ]["id"]
    assert separate_id not in {provisioned["id"], first_id}


def test_sign_in_adopts_orphan_scim_user_and_group_memberships(oauth_client, fake_idp):
    _, org_id, scim_token = _scim_org(oauth_client)
    claims = fake_idp.base_claims("adopter-sub", preferred_username="adopter@example.org")
    tokens = _sso_tokens(oauth_client, *sso_sign_in(oauth_client, fake_idp, "acme", claims))
    real_id = oauth_client.get("/api/users/me", headers=auth(tokens["access_token"])).json()[
        "user"
    ]["id"]
    orphan = _create_user(oauth_client, scim_token, org_id, "orphan@example.org")
    group = _scim(
        oauth_client,
        scim_token,
        "POST",
        org_id,
        "/Groups",
        {"displayName": "GIS", "members": [{"value": orphan["id"]}]},
    )
    assert group.status_code == 201, group.text
    assert orphan["id"] != real_id

    moved = {**claims, "preferred_username": "orphan@example.org"}
    _sso_tokens(oauth_client, *sso_sign_in(oauth_client, fake_idp, "acme", moved))
    with oauth_client.app.state.session_factory() as session:
        scim_user = session.scalar(
            select(ScimUser).where(ScimUser.user_name == "orphan@example.org")
        )
        assert scim_user.account_id == real_id
        assert session.get(GroupMember, (group.json()["id"], real_id)) is not None
        assert session.get(GroupMember, (group.json()["id"], orphan["id"])) is None
        assert session.get(OrganizationMember, (org_id, orphan["id"])) is None


def test_deleted_sso_user_can_be_reprovisioned_without_resurrecting_credentials(
    oauth_client, fake_idp
):
    _, org_id, scim_token = _scim_org(oauth_client)
    claims = fake_idp.base_claims("reprovision-sub", preferred_username="reprovision@example.org")
    old_tokens = _sso_tokens(oauth_client, *sso_sign_in(oauth_client, fake_idp, "acme", claims))
    old_id = oauth_client.get("/api/users/me", headers=auth(old_tokens["access_token"])).json()[
        "user"
    ]["id"]
    created = _scim(
        oauth_client,
        scim_token,
        "POST",
        org_id,
        "/Users",
        {"userName": "reprovision@example.org"},
    )
    assert created.status_code == 201
    assert created.json()["id"] == old_id
    deleted = _scim(oauth_client, scim_token, "DELETE", org_id, f"/Users/{old_id}")
    assert deleted.status_code == 204
    assert _status(oauth_client, old_tokens["access_token"]) == 401
    blocked, _ = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    assert blocked.status_code == 403
    with oauth_client.app.state.session_factory() as session:
        assert session.get(OrganizationMember, (org_id, old_id)) is None
    reprovisioned = _scim(
        oauth_client,
        scim_token,
        "POST",
        org_id,
        "/Users",
        {"userName": "reprovision@example.org"},
    )
    assert reprovisioned.status_code == 201, reprovisioned.text
    assert reprovisioned.json()["id"] == old_id
    fresh_callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    fresh = _sso_tokens(oauth_client, fresh_callback, verifier)
    assert _status(oauth_client, fresh["access_token"]) == 200


def test_group_add_rejects_scim_user_removed_from_organization(oauth_client):
    token, org_id, scim_token = _scim_org(oauth_client)
    user = _create_user(oauth_client, scim_token, org_id, "former@example.org")
    group = _scim(oauth_client, scim_token, "POST", org_id, "/Groups", {"displayName": "Team"})
    assert group.status_code == 201
    with oauth_client.app.state.session_factory() as session:
        account_name = session.get(Account, user["id"]).username
    removed = oauth_client.delete(
        f"/api/organizations/{org_id}/members/{account_name}", headers=auth(token)
    )
    assert removed.status_code == 204
    rejected = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Groups/{group.json()['id']}",
        _patch({"op": "add", "path": "members", "value": [{"value": user["id"]}]}),
    )
    assert rejected.status_code == 400
    assert rejected.json()["detail"] == "member is not provisioned in this organization"


def test_deactivating_an_unmanaged_account_only_removes_its_memberships(oauth_client):
    token, org_id, scim_token = _scim_org(oauth_client)
    ensure_account(oauth_client, "bob")
    add_member(oauth_client, token, org_id, "bob")
    group = oauth_client.post(
        "/api/groups", json={"name": "Field team", "organizationId": org_id}, headers=auth(token)
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["group"]["id"]
    added = oauth_client.put(
        f"/api/groups/{group_id}/members",
        json={"username": "bob", "role": "member"},
        headers=auth(token),
    )
    assert added.status_code in (200, 201), added.text
    bob_pat = pat(oauth_client, "bob")
    app = oauth_client.app
    with app.state.session_factory() as session:
        bob_id = session.scalar(select(Account.id).where(Account.username == "bob"))
        now = app.state.clock()
        session.add(
            ScimUser(
                organization_id=org_id,
                account_id=bob_id,
                user_name="bob",
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()

    patched = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Users/{bob_id}",
        _patch({"op": "replace", "value": {"active": False}}),
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["active"] is False
    assert _status(oauth_client, bob_pat) == 200
    orgs = oauth_client.get("/api/organizations/mine", headers=auth(bob_pat))
    assert orgs.status_code == 200
    assert org_id not in {org["id"] for org in orgs.json()["organizations"]}
    groups = oauth_client.get("/api/groups/mine", headers=auth(bob_pat))
    assert group_id not in {item["id"] for item in groups.json()["groups"]}


def test_user_filters_and_token_scoping(oauth_client, clock):
    _, org_id, scim_token = _scim_org(oauth_client)
    _create_user(oauth_client, scim_token, org_id, "grace@example.org", externalId="ext-1")
    clock.advance(1)  # Lists are ordered by creation time.
    _create_user(oauth_client, scim_token, org_id, "linus@example.org")

    by_name = _scim(
        oauth_client,
        scim_token,
        "GET",
        org_id,
        "/Users",
        params={"filter": 'userName eq "GRACE@example.org"'},
    )
    assert by_name.status_code == 200, by_name.text
    assert by_name.json()["totalResults"] == 1
    assert by_name.json()["Resources"][0]["externalId"] == "ext-1"
    page = _scim(
        oauth_client, scim_token, "GET", org_id, "/Users", params={"startIndex": 2, "count": 1}
    )
    assert page.json()["totalResults"] == 2
    assert [item["userName"] for item in page.json()["Resources"]] == ["linus@example.org"]
    unsupported = _scim(
        oauth_client, scim_token, "GET", org_id, "/Users", params={"filter": "title pr"}
    )
    assert unsupported.status_code == 400
    assert unsupported.json()["scimType"] == "invalidFilter"
    assert unsupported.json()["schemas"] == [ERROR_SCHEMA]
    assert unsupported.headers["content-type"] == "application/scim+json"

    duplicate = _scim(
        oauth_client, scim_token, "POST", org_id, "/Users", {"userName": "Grace@example.org"}
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["scimType"] == "uniqueness"

    admin = admin_token(oauth_client)
    other_org = create_org(oauth_client, admin, slug="other", name="Other")
    other = oauth_client.post(
        f"/api/organizations/{other_org}/scim-tokens", json={"label": "x"}, headers=auth(admin)
    ).json()
    foreign = _scim(oauth_client, other["token"], "GET", org_id, "/Users")
    assert foreign.status_code == 401
    assert foreign.headers["www-authenticate"] == "Bearer"
    assert foreign.json()["detail"] == "invalid SCIM token"

    tokens = oauth_client.get(f"/api/organizations/{org_id}/scim-tokens", headers=auth(admin))
    token_id = tokens.json()["scimTokens"][0]["id"]
    oauth_client.delete(f"/api/organizations/{org_id}/scim-tokens/{token_id}", headers=auth(admin))
    assert _scim(oauth_client, scim_token, "GET", org_id, "/Users").status_code == 401


def test_user_patch_quirks_and_put(oauth_client):
    _, org_id, scim_token = _scim_org(oauth_client)
    user = _create_user(oauth_client, scim_token, org_id, "grace@example.org")
    patched = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Users/{user['id']}",
        _patch(
            {"op": "Add", "path": 'emails[type eq "work"].value', "value": "g@example.org"},
            {"op": "Replace", "path": "displayName", "value": "Grace Hopper"},
            {"op": "Add", "path": "name.givenName", "value": "Grace"},
            {"op": "Add", "path": "externalId", "value": "oid-1"},
        ),
    )
    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["emails"] == [{"value": "g@example.org", "primary": True}]
    assert body["displayName"] == "Grace Hopper"
    assert body["externalId"] == "oid-1"
    removed = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Users/{user['id']}",
        _patch({"op": "Remove", "path": "externalId"}),
    )
    assert "externalId" not in removed.json()
    unsupported = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Users/{user['id']}",
        _patch({"op": "remove", "path": "userName"}),
    )
    assert unsupported.status_code == 400
    assert unsupported.json()["scimType"] == "invalidSyntax"
    not_patch = _scim(
        oauth_client, scim_token, "PATCH", org_id, f"/Users/{user['id']}", {"Operations": []}
    )
    assert not_patch.status_code == 400
    assert not_patch.json()["scimType"] == "invalidSyntax"

    replaced = _scim(
        oauth_client,
        scim_token,
        "PUT",
        org_id,
        f"/Users/{user['id']}",
        {"userName": "grace.hopper@example.org", "emails": [{"value": "gh@example.org"}]},
    )
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["userName"] == "grace.hopper@example.org"
    assert "displayName" not in replaced.json()
    assert replaced.json()["emails"][0]["value"] == "gh@example.org"
    # The SCIM email is the representation only, never the account's address.
    with oauth_client.app.state.session_factory() as session:
        assert session.get(Account, user["id"]).email is None

    missing = _scim(oauth_client, scim_token, "GET", org_id, "/Users/nope")
    assert missing.status_code == 404
    invalid = oauth_client.post(
        f"/scim/v2/{org_id}/Users",
        content=b"[1]",
        headers={"Authorization": f"Bearer {scim_token}", "Content-Type": "application/json"},
    )
    assert invalid.status_code == 400
    assert invalid.json()["scimType"] == "invalidSyntax"


def test_group_membership_provisioning(oauth_client):
    token, org_id, scim_token = _scim_org(oauth_client)
    grace = _create_user(oauth_client, scim_token, org_id, "grace@example.org")
    linus = _create_user(oauth_client, scim_token, org_id, "linus@example.org")

    stranger = _scim(
        oauth_client,
        scim_token,
        "POST",
        org_id,
        "/Groups",
        {"displayName": "GIS", "members": [{"value": "not-provisioned"}]},
    )
    assert stranger.status_code == 400
    assert stranger.json()["detail"] == "member is not provisioned in this organization"

    created = _scim(
        oauth_client,
        scim_token,
        "POST",
        org_id,
        "/Groups",
        {"displayName": "GIS", "externalId": "g-1", "members": [{"value": grace["id"]}]},
    )
    assert created.status_code == 201, created.text
    group = created.json()
    assert [member["value"] for member in group["members"]] == [grace["id"]]
    listed = _scim(
        oauth_client,
        scim_token,
        "GET",
        org_id,
        "/Groups",
        params={"filter": 'displayName eq "gis"'},
    )
    assert listed.json()["totalResults"] == 1

    added = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Groups/{group['id']}",
        _patch({"op": "Add", "path": "members", "value": [{"value": linus["id"]}]}),
    )
    assert {member["value"] for member in added.json()["members"]} == {grace["id"], linus["id"]}
    removed = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Groups/{group['id']}",
        _patch({"op": "Remove", "path": f'members[value eq "{grace["id"]}"]'}),
    )
    assert removed.status_code == 200, removed.text
    assert [member["value"] for member in removed.json()["members"]] == [linus["id"]]

    members = oauth_client.get(f"/api/groups/{group['id']}/members", headers=auth(token))
    assert members.status_code == 200, members.text
    usernames = {member["username"]: member["role"] for member in members.json()["members"]}
    assert "grace" not in usernames
    assert usernames["ada"] == "owner"
    assert usernames["linus"] == "member"

    renamed = _scim(
        oauth_client,
        scim_token,
        "PUT",
        org_id,
        f"/Groups/{group['id']}",
        {"displayName": "GIS team", "members": []},
    )
    assert renamed.json()["displayName"] == "GIS team"
    assert renamed.json()["members"] == []
    deleted = _scim(oauth_client, scim_token, "DELETE", org_id, f"/Groups/{group['id']}")
    assert deleted.status_code == 204
    gone = oauth_client.get(f"/api/groups/{group['id']}/members", headers=auth(token))
    assert gone.status_code == 404


def test_last_administrator_cannot_be_removed(oauth_client, fake_idp):
    token, org_id, scim_token = _scim_org(oauth_client)
    admin = _create_user(oauth_client, scim_token, org_id, "root@example.org")
    with oauth_client.app.state.session_factory() as session:
        username = session.get(Account, admin["id"]).username
    add_member(oauth_client, token, org_id, username, role="administrator")
    claims = fake_idp.base_claims("root-sub", preferred_username="root@example.org")
    owner_token = _sso_tokens(
        oauth_client,
        *sso_sign_in(oauth_client, fake_idp, "acme", claims, scope="read:projects write:projects"),
    )["access_token"]
    minted = oauth_client.post(
        f"/api/organizations/{org_id}/scim-tokens",
        json={"label": "Root"},
        headers=auth(owner_token),
    )
    assert minted.status_code == 201
    scim_token = minted.json()["token"]
    # ada steps down, leaving the provisioned account as the only administrator.
    stepped_down = oauth_client.put(
        f"/api/organizations/{org_id}/members",
        json={"username": "ada", "role": "member"},
        headers=auth(token),
    )
    assert stepped_down.status_code == 200, stepped_down.text

    refused_deactivation = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Users/{admin['id']}",
        _patch({"op": "replace", "path": "active", "value": False}),
    )
    assert refused_deactivation.status_code == 409
    assert refused_deactivation.json()["scimType"] == "mutability"
    assert (
        refused_deactivation.json()["detail"] == "cannot remove the last organization administrator"
    )
    refused = _scim(oauth_client, scim_token, "DELETE", org_id, f"/Users/{admin['id']}")
    assert refused.status_code == 409
    assert refused.json()["scimType"] == "mutability"
    assert refused.json()["detail"] == "cannot remove the last organization administrator"
    assert (
        _scim(oauth_client, scim_token, "GET", org_id, f"/Users/{admin['id']}").status_code == 200
    )

    member = _create_user(oauth_client, scim_token, org_id, "temp@example.org")
    assert (
        _scim(oauth_client, scim_token, "DELETE", org_id, f"/Users/{member['id']}").status_code
        == 204
    )
    assert (
        _scim(oauth_client, scim_token, "GET", org_id, f"/Users/{member['id']}").status_code == 404
    )


def test_break_glass_administrator_cannot_be_removed(oauth_client):
    token, org_id, scim_token = _scim_org(oauth_client)
    admin = _create_user(oauth_client, scim_token, org_id, "root@example.org")
    with oauth_client.app.state.session_factory() as session:
        username = session.get(Account, admin["id"]).username
    add_member(oauth_client, token, org_id, username, role="administrator")
    configured = configure_idp(oauth_client, token, org_id, breakGlassUsername=username)
    assert configured.status_code == 200, configured.text

    refused_deactivation = _scim(
        oauth_client,
        scim_token,
        "PATCH",
        org_id,
        f"/Users/{admin['id']}",
        _patch({"op": "replace", "path": "active", "value": False}),
    )
    assert refused_deactivation.status_code == 409
    assert (
        refused_deactivation.json()["detail"]
        == "cannot remove the organization's break-glass administrator"
    )

    refused = _scim(oauth_client, scim_token, "DELETE", org_id, f"/Users/{admin['id']}")
    assert refused.status_code == 409
    assert refused.json()["scimType"] == "mutability"
    assert refused.json()["detail"] == "cannot remove the organization's break-glass administrator"
    assert (
        _scim(oauth_client, scim_token, "GET", org_id, f"/Users/{admin['id']}").status_code == 200
    )


def test_removing_a_publisher_unpublishes_their_public_projects(oauth_client):
    token, org_id, scim_token = _scim_org(oauth_client)
    policy = oauth_client.patch(
        f"/api/organizations/{org_id}",
        json={"publicSharingPolicy": "publishers"},
        headers=auth(token),
    )
    assert policy.status_code == 200, policy.text
    ensure_account(oauth_client, "bob")
    add_member(oauth_client, token, org_id, "bob", role="publisher")
    bob_pat = pat(oauth_client, "bob")
    created = oauth_client.post(
        "/api/projects",
        headers=auth(bob_pat),
        json={
            "filename": "wetlands.geolibre.json",
            "content": json.dumps({"version": "1.0", "title": "Wetlands", "layers": []}),
            "visibility": "public",
            "organizationId": org_id,
        },
    )
    assert created.status_code == 201, created.text
    project_id = created.json()["project"]["id"]
    app = oauth_client.app
    with app.state.session_factory() as session:
        bob_id = session.scalar(select(Account.id).where(Account.username == "bob"))
        now = app.state.clock()
        session.add(
            ScimUser(
                organization_id=org_id,
                account_id=bob_id,
                user_name="bob",
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()

    removed = _scim(oauth_client, scim_token, "DELETE", org_id, f"/Users/{bob_id}")
    assert removed.status_code == 204, removed.text
    project = oauth_client.get(f"/api/projects/{project_id}", headers=auth(token))
    assert project.status_code == 200, project.text
    assert project.json()["project"]["visibility"] == "organization"


def test_discovery_documents(oauth_client):
    _, org_id, scim_token = _scim_org(oauth_client)
    config = _scim(oauth_client, scim_token, "GET", org_id, "/ServiceProviderConfig")
    assert config.status_code == 200
    assert config.json()["patch"] == {"supported": True}
    assert config.json()["filter"] == {"supported": True, "maxResults": 100}
    types = _scim(oauth_client, scim_token, "GET", org_id, "/ResourceTypes").json()
    assert {item["endpoint"] for item in types["Resources"]} == {"/Users", "/Groups"}
    schemas = _scim(oauth_client, scim_token, "GET", org_id, "/Schemas").json()
    assert schemas["totalResults"] == 2
    assert _scim(oauth_client, "wrong", "GET", org_id, "/Schemas").status_code == 401


@pytest.fixture
def proxied_app(tmp_path, monkeypatch, clock, fake_idp):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    monkeypatch.setenv("GEOLIBRE_TRUSTED_PROXIES", "10.0.0.0/8")
    monkeypatch.setenv("GEOLIBRE_PROXY_AUTH", "true")
    return _make_app(tmp_path, PUBLIC_URL, clock=clock.now, oidc_transport=fake_idp.transport)


def _deactivate(app, username):
    with app.state.session_factory() as session:
        account_id = session.scalar(select(Account.id).where(Account.username == username))
        deactivate_account(session, account_id, app.state.clock())
        session.commit()


def test_deactivated_account_cannot_sign_in_with_password_or_proxy(proxied_app):
    with TestClient(proxied_app, base_url=PUBLIC_URL) as direct:
        ensure_account(direct, "bob")
        _deactivate(proxied_app, "bob")
        login = direct.post(
            "/api/auth/token", json={"username": "bob", "password": "correct horse"}
        )
        assert login.status_code == 401
        assert login.json() == {"error": "invalid username or password"}
        _, _, interaction, csrf = start_authorize(direct)
        page = approve(direct, interaction, csrf, username="bob")
        assert "Invalid username or password" in page.text

    with TestClient(
        proxied_app,
        base_url=PUBLIC_URL,
        client=("10.0.0.5", 5000),
        headers={"Remote-User": "grace"},
    ) as proxy:
        _, _, interaction, csrf = start_authorize(proxy)
        first = approve(proxy, interaction, csrf, username="", password="")
        assert first.status_code == 303, first.text
        _deactivate(proxied_app, "grace")
        _, _, interaction, csrf = start_authorize(proxy)
        blocked = approve(proxy, interaction, csrf, username="", password="")
        assert blocked.status_code == 200
        assert DEACTIVATED in blocked.text
