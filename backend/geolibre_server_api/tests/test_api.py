import hashlib
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api.main import (
    FileStorage,
    create_app,
    postgresql_upgrade_statements,
)
from sqlalchemy.exc import IntegrityError


@pytest.fixture
def client(tmp_path):
    # Storage is constructed explicitly rather than left to make_storage(), which
    # reads GEOLIBRE_STORAGE/GEOLIBRE_STORAGE_PATH from the ambient environment:
    # that both created a ./data directory in the pytest working directory and
    # would hand back an S3Storage if GEOLIBRE_STORAGE=s3 happened to be set.
    app = create_app(
        f"sqlite:///{tmp_path / 'test.db'}",
        public_url="https://share.example",
        storage=FileStorage(str(tmp_path / "objects")),
    )
    with TestClient(app) as test_client:
        yield test_client


def account(client, username="ada", email=None):
    body = {"username": username, "password": "correct horse"}
    if email is not None:
        body["email"] = email
    response = client.post("/api/accounts", json=body)
    assert response.status_code == 201
    return response.json()["token"]


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def create_project(client, token, visibility="public", title="Wetlands"):
    content = json.dumps({"version": "1.0", "title": title, "layers": []})
    response = client.post(
        "/api/projects",
        headers=auth(token),
        json={
            "filename": "fallback.geolibre.json",
            "content": content,
            "visibility": visibility,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["project"], content


def create_member_organization_project(client):
    admin = account(client, "admin")
    member = account(client, "member")
    organization = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={"slug": "creator-lab", "name": "Creator Lab"},
    ).json()["organization"]
    assert (
        client.put(
            f"/api/organizations/{organization['id']}/members",
            headers=auth(admin),
            json={"username": "member", "role": "member"},
        ).status_code
        == 200
    )
    created = client.post(
        "/api/projects",
        headers=auth(member),
        json={
            "filename": "member-map.json",
            "content": '{"title":"Member map"}',
            "visibility": "organization",
            "organizationId": organization["id"],
        },
    )
    assert created.status_code == 201, created.text
    return admin, member, organization, created.json()["project"]


def test_member_creator_can_update_organization_project_but_viewer_cannot(client):
    admin, member, organization, project = create_member_organization_project(client)
    with client.app.state.engine.connect() as connection:
        row = connection.exec_driver_sql(
            "SELECT owner_id, created_by_id FROM projects WHERE id = ?",
            (project["id"],),
        ).one()
        member_id = connection.exec_driver_sql(
            "SELECT id FROM accounts WHERE username = 'member'"
        ).scalar_one()
    assert row.owner_id is None
    assert row.created_by_id == member_id
    assert project["username"] is None
    individual, _ = create_project(client, member, "private", "Member map")
    assert individual["slug"] == project["slug"]
    organization_collision = client.post(
        "/api/projects",
        headers=auth(member),
        json={
            "filename": "member-map.json",
            "content": '{"title":"Member map"}',
            "visibility": "organization",
            "organizationId": organization["id"],
        },
    )
    assert organization_collision.status_code == 201, organization_collision.text
    assert organization_collision.json()["project"]["slug"] == "member-map-2"
    assert (
        client.patch(
            f"/api/projects/{project['id']}",
            headers=auth(member),
            json={"description": "Creator update"},
        ).status_code
        == 200
    )

    assert (
        client.put(
            f"/api/organizations/{organization['id']}/members",
            headers=auth(admin),
            json={"username": "member", "role": "viewer"},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/projects/{project['id']}",
            headers=auth(member),
            json={"description": "Viewer update"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/projects",
            headers=auth(member),
            json={
                "filename": "viewer-map.json",
                "content": '{"title":"Viewer map"}',
                "visibility": "organization",
                "organizationId": organization["id"],
            },
        ).status_code
        == 403
    )


def test_removed_member_creator_loses_organization_project_access_and_edit(client):
    admin, member, organization, project = create_member_organization_project(client)
    assert (
        client.delete(
            f"/api/organizations/{organization['id']}/members/member",
            headers=auth(admin),
        ).status_code
        == 204
    )
    assert client.get(f"/api/projects/{project['id']}", headers=auth(member)).status_code == 404
    assert (
        client.patch(
            f"/api/projects/{project['id']}",
            headers=auth(member),
            json={"description": "After removal"},
        ).status_code
        == 403
    )
    assert (
        client.put(
            f"/api/projects/{project['id']}/content",
            headers=auth(member),
            json={"content": '{"title":"After removal"}'},
        ).status_code
        == 403
    )


def test_organization_admin_retains_control_after_creator_removal(client):
    admin, _, organization, project = create_member_organization_project(client)
    assert (
        client.delete(
            f"/api/organizations/{organization['id']}/members/member",
            headers=auth(admin),
        ).status_code
        == 204
    )
    assert (
        client.patch(
            f"/api/projects/{project['id']}",
            headers=auth(admin),
            json={"description": "Administrator update"},
        ).status_code
        == 200
    )
    assert (
        client.put(
            f"/api/projects/{project['id']}/content",
            headers=auth(admin),
            json={"content": '{"title":"Administrator update"}'},
        ).status_code
        == 201
    )


def test_accounts_login_current_user_and_hashed_secrets(client):
    assert client.get("/health").json() == {"ok": True, "service": "geolibre-server"}

    token = account(client)
    assert client.get("/api/account", headers=auth(token)).json()["account"]["username"] == "ada"
    me = client.get("/api/users/me", headers=auth(token)).json()["user"]
    # Asserted field-wise, not by exact equality: pinning the whole dict froze the
    # response to a single key and hid the drift from the published contract.
    assert me["username"] == "ada"
    assert me["id"] and me["createdAt"]
    login = client.post("/api/auth/token", json={"username": "ada", "password": "correct horse"})
    assert login.status_code == 200
    assert login.json()["token"] != token

    with client.app.state.engine.connect() as connection:
        password = connection.exec_driver_sql("select password_hash from accounts").scalar()
        digests = set(connection.exec_driver_sql("select digest from tokens").scalars())
    assert "correct horse" not in password
    assert hashlib.sha256(token.encode()).hexdigest() in digests
    assert token not in digests

    assert client.delete("/api/auth/token", headers=auth(token)).status_code == 204
    assert client.get("/api/account", headers=auth(token)).status_code == 401


def test_project_crud_visibility_listing_and_raw_views(client):
    owner = account(client)
    other = account(client, "grace")
    project, content = create_project(client, owner, "private")
    project_id = project["id"]
    assert project["rawJsonUrl"] == "https://share.example/ada/wetlands.geolibre.json"
    assert client.get(f"/api/projects/{project_id}").status_code == 404
    assert client.get(f"/api/projects/{project_id}", headers=auth(owner)).status_code == 200
    assert client.get("/api/projects").json()["projects"] == []
    assert len(client.get("/api/projects?mine=true", headers=auth(owner)).json()["projects"]) == 1
    assert len(client.get("/api/users/ada/projects", headers=auth(owner)).json()["projects"]) == 1
    assert client.get("/api/users/ada/projects", headers=auth(other)).json()["projects"] == []

    patched = client.patch(
        f"/api/projects/{project_id}",
        headers=auth(owner),
        json={
            "visibility": "public",
            "description": "A project",
            "tags": ["water"],
        },
    )
    assert patched.status_code == 200
    assert patched.json()["project"]["tags"] == ["water"]
    raw = client.get("/ada/wetlands.geolibre.json")
    assert raw.status_code == 200 and raw.json() == json.loads(content)
    assert client.get(f"/api/projects/{project_id}").json()["project"]["views"] == 1
    assert (
        client.patch(f"/api/projects/{project_id}", headers=auth(other), json={}).status_code == 403
    )

    updated = client.put(
        f"/api/projects/{project_id}/content",
        headers=auth(owner),
        json={"content": '{"version":"1.0","title":"Updated"}'},
    )
    assert updated.status_code == 201 and updated.json()["version"] == 2
    historical = client.get(f"/api/projects/{project_id}/versions/1")
    assert historical.headers["cache-control"] == "public, max-age=3600"
    assert historical.json() == json.loads(content)
    assert client.delete(f"/api/projects/{project_id}", headers=auth(owner)).status_code == 204
    assert client.get(f"/api/projects/{project_id}").status_code == 404


def test_unlisted_is_hidden_from_listings_but_readable_by_url(client):
    """`unlisted` sits between public and private and had no coverage: it is kept
    out of every listing a non-owner sees, yet anyone holding the URL can read it."""
    owner = account(client)
    other = account(client, "grace")
    project, content = create_project(client, owner, "unlisted", title="Hidden")

    assert client.get("/api/projects").json()["projects"] == []
    assert client.get("/api/users/ada/projects", headers=auth(other)).json()["projects"] == []
    assert len(client.get("/api/users/ada/projects", headers=auth(owner)).json()["projects"]) == 1
    assert len(client.get("/api/projects?mine=true", headers=auth(owner)).json()["projects"]) == 1

    anonymous = client.get(project["rawJsonUrl"].removeprefix("https://share.example"))
    assert anonymous.status_code == 200 and anonymous.json() == json.loads(content)


def test_organization_policy_and_group_access_are_enforced(client):
    """Organization and group access is checked on listings, raw reads, and writes.

    This specifically guards the two boundaries that cannot be left to the UI:
    a member cannot bypass a no-public policy with a direct POST, and a removed
    group member loses access to the already-known raw URL immediately.
    """
    admin = account(client, "admin")
    member = account(client, "member")
    outsider = account(client, "outsider")
    organization = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={
            "slug": "watershed-lab",
            "name": "Watershed Lab",
            "publicSharingPolicy": "no",
            "defaultVisibility": "organization",
        },
    )
    assert organization.status_code == 201, organization.text
    organization_id = organization.json()["organization"]["id"]
    assert (
        client.put(
            f"/api/organizations/{organization_id}/members",
            headers=auth(admin),
            json={"username": "member", "role": "member"},
        ).status_code
        == 200
    )

    content = json.dumps({"version": "1.0", "title": "Team map", "layers": []})
    blocked = client.post(
        "/api/projects",
        headers=auth(member),
        json={
            "filename": "team.geolibre.json",
            "content": content,
            "visibility": "public",
            "organizationId": organization_id,
        },
    )
    assert blocked.status_code == 403

    organization_project = client.post(
        "/api/projects",
        headers=auth(member),
        json={
            "filename": "internal.geolibre.json",
            "content": content,
            "visibility": "organization",
            "organizationId": organization_id,
        },
    )
    assert organization_project.status_code == 201, organization_project.text
    organization_project_body = organization_project.json()["project"]
    assert organization_project_body["username"] is None
    assert (
        client.patch(
            f"/api/projects/{organization_project_body['id']}",
            headers=auth(member),
            json={"description": "Creator update"},
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"/api/organizations/{organization_id}/members/member",
            headers=auth(admin),
        ).status_code
        == 204
    )
    assert (
        client.patch(
            f"/api/projects/{organization_project_body['id']}",
            headers=auth(member),
            json={"description": "After removal"},
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/api/projects/{organization_project_body['id']}",
            headers=auth(admin),
            json={"description": "Administrator update"},
        ).status_code
        == 200
    )

    group = client.post(
        "/api/groups",
        headers=auth(admin),
        json={
            "name": "Field team",
            "sharedUpdate": True,
        },
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["group"]["id"]
    assert (
        client.put(
            f"/api/groups/{group_id}/members",
            headers=auth(admin),
            json={"username": "member", "role": "member"},
        ).status_code
        == 200
    )

    created = client.post(
        "/api/projects",
        headers=auth(admin),
        json={
            "filename": "team.geolibre.json",
            "content": content,
            "visibility": "private",
            "groupIds": [group_id],
        },
    )
    assert created.status_code == 201, created.text
    project = created.json()["project"]
    raw_path = project["rawJsonUrl"].removeprefix("https://share.example")
    assert client.get(raw_path, headers=auth(member)).status_code == 200
    assert (
        client.put(
            f"/api/projects/{project['id']}/content",
            headers=auth(member),
            json={"content": json.dumps({"version": "1.0", "title": "Updated", "layers": []})},
        ).status_code
        == 201
    )
    assert client.get(raw_path, headers=auth(outsider)).status_code == 404
    assert (
        client.delete(f"/api/groups/{group_id}/members/member", headers=auth(admin)).status_code
        == 204
    )
    assert client.get(raw_path, headers=auth(member)).status_code == 404


def test_patch_rejects_explicit_nulls(client):
    """An explicit JSON null survives `exclude_unset`, so these must be 422s rather
    than a non-nullable column error or a len(None) crash at 500."""
    owner = account(client)
    project, _ = create_project(client, owner)
    path = f"/api/projects/{project['id']}"
    assert client.patch(path, headers=auth(owner), json={"visibility": None}).status_code == 422
    assert client.patch(path, headers=auth(owner), json={"tags": None}).status_code == 200
    assert client.get(path).json()["project"]["tags"] == []


def test_username_length_is_enforced(client):
    """The optional middle group in the old pattern let a 1-character username
    through, contradicting both the error text and the documented limits."""
    for name in ("a", "ab"):
        response = client.post(
            "/api/accounts", json={"username": name, "password": "correct horse"}
        )
        assert response.status_code == 422, name
    assert (
        client.post(
            "/api/accounts", json={"username": "abc", "password": "correct horse"}
        ).status_code
        == 201
    )


def test_oversized_body_is_rejected_before_parsing(client):
    """A declared Content-Length past the ceiling is refused up front, so the JSON
    `content` routes cannot have the whole payload materialized before the check.

    The request carries a two-byte body and only *claims* to be huge: the
    middleware decides from the header alone, so allocating the real payload here
    would prove nothing and cost hundreds of MiB in the test process.
    """
    owner = account(client)
    declared = str(1024 * 1024 * 1024)
    headers = {
        **auth(owner),
        "content-type": "application/json",
        "content-length": declared,
        "origin": "https://app.example",
    }
    request = client.build_request("POST", "/api/projects", headers=headers, content=b"{}")
    assert request.headers["content-length"] == declared
    response = client.send(request)
    assert response.status_code == 413
    # The rejection must still pass back out through CORSMiddleware, or a browser
    # cannot read the error body it just received.
    assert response.headers.get("access-control-allow-origin") is not None


def test_fully_escaped_json_within_the_limit_is_accepted(tmp_path, monkeypatch):
    """`parse_content` bounds the *decoded* string, but JSON may spend six wire
    bytes on one ASCII byte. The header ceiling has to allow for that, or a valid
    upload is refused before it is ever parsed.

    Limits are shrunk here so the factor is what decides the outcome: the wire
    body below lands above a 2x ceiling and under a 6x one, so this fails if the
    multiplier regresses.
    """
    monkeypatch.setenv("GEOLIBRE_MAX_PROJECT_BYTES", "1000")
    monkeypatch.setenv("GEOLIBRE_MAX_THUMBNAIL_BYTES", "1000")
    app = create_app(
        f"sqlite:///{tmp_path / 'esc.db'}",
        public_url="https://share.example",
        storage=FileStorage(str(tmp_path / "objects")),
    )
    with TestClient(app) as escaped_client:
        token = account(escaped_client)
        # Padding rides on an unvalidated field; `title` is separately capped at 100.
        document = json.dumps(
            {"version": "1.0", "title": "Escaped", "layers": [], "note": "p" * 600}
        )
        assert len(document.encode()) <= 1000
        # Every character spelled as \u00XX, which is what the ceiling must absorb.
        wire = "".join(f"\\u{ord(c):04x}" for c in document)
        body = '{"filename":"escaped.geolibre.json","visibility":"public","content":"' + wire + '"}'
        assert 1000 * 2 + 1024 < len(body.encode()) < 1000 * 6 + 1024
        response = escaped_client.post(
            "/api/projects",
            headers={**auth(token), "content-type": "application/json"},
            content=body.encode(),
        )
        assert response.status_code == 201, response.text


def test_thumbnail_fork_and_slug_collision(client):
    owner = account(client)
    recipient = account(client, "grace")
    project, _ = create_project(client, owner)
    second, _ = create_project(client, owner)
    assert second["slug"] == "wetlands-2"

    thumbnail = b"\x89PNG\r\n\x1a\nnot-a-full-image"
    path = f"/api/projects/{project['id']}/thumbnail"
    assert (
        client.put(
            path,
            headers={**auth(owner), "Content-Type": "image/png"},
            content=thumbnail,
        ).status_code
        == 204
    )
    result = client.get(path)
    assert result.content == thumbnail and result.headers["content-type"] == "image/png"
    assert (
        client.put(
            path, headers={**auth(owner), "Content-Type": "text/plain"}, content=b"x"
        ).status_code
        == 422
    )

    forked = client.post(
        f"/api/projects/{project['id']}/forks",
        headers=auth(recipient),
        json={"visibility": "private"},
    )
    assert forked.status_code == 201
    assert forked.json()["project"]["username"] == "grace"
    assert client.get(f"/api/projects/{project['id']}").json()["project"]["forkCount"] == 1

    # Forking with no body at all is the common "fork this project" call, and the
    # documented default is private. Sending a body here would not exercise it.
    bodyless = client.post(f"/api/projects/{project['id']}/forks", headers=auth(recipient))
    assert bodyless.status_code == 201
    assert bodyless.json()["project"]["visibility"] == "private"
    assert client.get(f"/api/projects/{project['id']}").json()["project"]["forkCount"] == 2
    assert client.delete(path, headers=auth(owner)).status_code == 204
    assert client.get(path).status_code == 404


def test_validation_and_errors_use_contract_shape(client):
    assert client.post(
        "/api/accounts", json={"username": "Bad Name", "password": "long enough"}
    ).json()["error"]
    token = account(client)
    bad = client.post(
        "/api/projects",
        headers=auth(token),
        json={"filename": "x.json", "content": "not json", "visibility": "public"},
    )
    assert bad.status_code == 422 and set(bad.json()) == {"error"}
    assert client.get("/api/projects?limit=101").status_code == 422


def test_organization_settings_patch_and_default_visibility(client):
    """Org admin can PATCH settings; defaultVisibility is exposed but not enforced
    by the server (client uses it to seed the share dialog)."""
    admin = account(client, "admin")
    org = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={
            "slug": "test-org",
            "name": "Test Org",
            "publicSharingPolicy": "publishers",
            "defaultVisibility": "organization",
        },
    )
    assert org.status_code == 201
    org_id = org.json()["organization"]["id"]

    # Only administrator can PATCH
    member = account(client, "member")
    client.put(
        f"/api/organizations/{org_id}/members",
        headers=auth(admin),
        json={"username": "member", "role": "member"},
    )
    blocked = client.patch(
        f"/api/organizations/{org_id}", headers=auth(member), json={"name": "Hacked"}
    )
    assert blocked.status_code == 403

    # Admin can change name, policy, defaultVisibility, categories
    patched = client.patch(
        f"/api/organizations/{org_id}",
        headers=auth(admin),
        json={
            "name": "Renamed",
            "publicSharingPolicy": "no",
            "defaultVisibility": "private",
            "categories": ["water", "land"],
        },
    )
    assert patched.status_code == 200
    assert patched.json()["organization"]["name"] == "Renamed"
    assert patched.json()["organization"]["publicSharingPolicy"] == "no"
    assert patched.json()["organization"]["defaultVisibility"] == "private"
    assert patched.json()["organization"]["categories"] == ["water", "land"]

    # Verify new policy blocks member from publishing public
    content = json.dumps({"version": "1.0", "title": "X", "layers": []})
    assert (
        client.post(
            "/api/projects",
            headers=auth(member),
            json={
                "filename": "x.json",
                "content": content,
                "visibility": "public",
                "organizationId": org_id,
            },
        ).status_code
        == 403
    )

    # But admin still can
    ok = client.post(
        "/api/projects",
        headers=auth(admin),
        json={
            "filename": "x.json",
            "content": content,
            "visibility": "public",
            "organizationId": org_id,
        },
    )
    assert ok.status_code == 201


def test_group_invitation_accept_revoke_and_join_policies(client):
    """Group invitations and join policies work end-to-end."""
    owner = account(client, "owner")
    alice = account(client, "alice")
    bob = account(client, "bob")
    carol = account(client, "carol")

    # Invite-only group: owner invites alice
    g1 = client.post(
        "/api/groups",
        headers=auth(owner),
        json={"name": "Invite-only", "joinPolicy": "invite"},
    )
    assert g1.status_code == 201
    g1_id = g1.json()["group"]["id"]

    invite = client.post(
        f"/api/groups/{g1_id}/invitations",
        headers=auth(owner),
        json={"username": "alice", "role": "manager"},
    )
    assert invite.status_code == 201
    token = invite.json()["invitation"]["token"]
    with client.app.state.engine.connect() as connection:
        stored_digest = connection.exec_driver_sql(
            "SELECT token_digest FROM group_invitations WHERE id = ?",
            (invite.json()["invitation"]["id"],),
        ).scalar_one()
        stored_row = connection.exec_driver_sql(
            "SELECT * FROM group_invitations WHERE id = ?",
            (invite.json()["invitation"]["id"],),
        ).one()
    assert stored_digest == hashlib.sha256(token.encode()).hexdigest()
    assert token not in {str(value) for value in stored_row}

    # Alice accepts
    assert (
        client.post(f"/api/groups/invitations/{token}/accept", headers=auth(alice)).status_code
        == 204
    )
    members = client.get(f"/api/groups/{g1_id}/members", headers=auth(owner)).json()["members"]
    assert next(member for member in members if member["username"] == "alice")["role"] == "manager"
    assert client.get(f"/api/groups/{g1_id}/projects", headers=auth(alice)).json() == {
        "projects": []
    }

    # Bob cannot accept (wrong token owner)
    invite2 = client.post(
        f"/api/groups/{g1_id}/invitations",
        headers=auth(owner),
        json={"username": "bob"},
    )
    assert invite2.status_code == 201
    token2 = invite2.json()["invitation"]["token"]
    assert (
        client.post(f"/api/groups/invitations/{token2}/accept", headers=auth(alice)).status_code
        == 403
    )

    # Owner revokes Carol's invite
    invite3 = client.post(
        f"/api/groups/{g1_id}/invitations",
        headers=auth(owner),
        json={"username": "carol"},
    )
    inv_id = invite3.json()["invitation"]["id"]
    assert (
        client.delete(f"/api/groups/{g1_id}/invitations/{inv_id}", headers=auth(owner)).status_code
        == 204
    )
    assert (
        client.post(
            f"/api/groups/invitations/{invite3.json()['invitation']['token']}/accept",
            headers=auth(carol),
        ).status_code
        == 404
    )
    revoked = client.get(f"/api/groups/{g1_id}/invitations", headers=auth(owner)).json()[
        "invitations"
    ]
    assert next(item for item in revoked if item["id"] == inv_id)["status"] == "revoked"
    assert all("token" not in item for item in revoked)

    # Request-to-join group: bob requests, owner accepts
    g2 = client.post(
        "/api/groups",
        headers=auth(owner),
        json={"name": "Request-join", "joinPolicy": "request"},
    )
    g2_id = g2.json()["group"]["id"]
    assert client.post(f"/api/groups/{g2_id}/join", headers=auth(bob)).status_code == 204
    # Request appears in invitations table with invited_by=bob
    # Owner accepts
    assert (
        client.post(
            f"/api/groups/{g2_id}/members/bob/decide",
            headers=auth(owner),
            json={"decision": "accept"},
        ).status_code
        == 204
    )
    assert client.get(f"/api/groups/{g2_id}/projects", headers=auth(bob)).json() == {"projects": []}

    # Open group: carol joins directly
    g3 = client.post(
        "/api/groups", headers=auth(owner), json={"name": "Open", "joinPolicy": "open"}
    )
    g3_id = g3.json()["group"]["id"]
    assert client.post(f"/api/groups/{g3_id}/join", headers=auth(carol)).status_code == 204
    assert client.get(f"/api/groups/{g3_id}/projects", headers=auth(carol)).json() == {
        "projects": []
    }

    # Owner cannot leave without transfer
    assert client.delete(f"/api/groups/{g1_id}/members/me", headers=auth(owner)).status_code == 409
    # Transferring to Alice demotes the prior owner to manager.
    client.put(
        f"/api/groups/{g1_id}/members",
        headers=auth(owner),
        json={"username": "alice", "role": "owner"},
    )
    # Now owner can leave
    assert client.delete(f"/api/groups/{g1_id}/members/me", headers=auth(owner)).status_code == 204


def test_organization_invitations_by_username_and_email(client):
    admin = account(client, "admin")
    alice = account(client, "alice")
    bob = account(client, "bob")
    outsider = account(client, "outsider")
    carol = account(client, "carol")
    assert (
        client.patch("/api/account", headers=auth(bob), json={"email": "BOB@example.org"}).json()[
            "account"
        ]["email"]
        == "bob@example.org"
    )

    organization = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={"slug": "invitation-lab", "name": "Invitation Lab"},
    ).json()["organization"]
    path = f"/api/organizations/{organization['id']}/invitations"

    username_invite = client.post(
        path,
        headers=auth(admin),
        json={"username": "alice", "role": "publisher"},
    )
    assert username_invite.status_code == 201, username_invite.text
    username_body = username_invite.json()["invitation"]
    username_token = username_body["token"]
    with client.app.state.engine.connect() as connection:
        stored_digest = connection.exec_driver_sql(
            "SELECT token_digest FROM organization_invitations WHERE id = ?",
            (username_body["id"],),
        ).scalar_one()
        stored_row = connection.exec_driver_sql(
            "SELECT * FROM organization_invitations WHERE id = ?",
            (username_body["id"],),
        ).one()
    assert stored_digest == hashlib.sha256(username_token.encode()).hexdigest()
    assert username_token not in {str(value) for value in stored_row}

    assert client.get(path, headers=auth(alice)).status_code == 403
    assert client.post(path, headers=auth(alice), json={"username": "carol"}).status_code == 403
    pending = client.get(path, headers=auth(admin))
    assert pending.headers["cache-control"] == "private, no-store"
    assert pending.json()["invitations"][0]["status"] == "pending"
    assert "token" not in pending.json()["invitations"][0]
    assert (
        client.post(
            f"/api/organizations/invitations/{username_token}/accept",
            headers=auth(outsider),
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/organizations/invitations/{username_token}/accept",
            headers=auth(alice),
        ).status_code
        == 204
    )
    assert (
        client.post(
            f"/api/organizations/invitations/{username_token}/accept",
            headers=auth(alice),
        ).status_code
        == 404
    )
    members = client.get(
        f"/api/organizations/{organization['id']}/members", headers=auth(admin)
    ).json()["members"]
    assert next(item for item in members if item["username"] == "alice")["role"] == "publisher"

    email_invite = client.post(
        path,
        headers=auth(admin),
        json={"email": "BOB@example.org", "role": "viewer"},
    ).json()["invitation"]
    email_token = email_invite["token"]
    assert (
        client.post(
            f"/api/organizations/invitations/{email_token}/accept",
            headers=auth(outsider),
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/organizations/invitations/{email_token}/accept",
            headers=auth(bob),
        ).status_code
        == 204
    )

    revoked_invite = client.post(path, headers=auth(admin), json={"username": "carol"}).json()[
        "invitation"
    ]
    assert client.delete(f"{path}/{revoked_invite['id']}", headers=auth(alice)).status_code == 403
    assert client.delete(f"{path}/{revoked_invite['id']}", headers=auth(admin)).status_code == 204
    assert (
        client.post(
            f"/api/organizations/invitations/{revoked_invite['token']}/accept",
            headers=auth(carol),
        ).status_code
        == 404
    )
    statuses = {
        item["id"]: item["status"]
        for item in client.get(path, headers=auth(admin)).json()["invitations"]
    }
    assert statuses[username_body["id"]] == "accepted"
    assert statuses[email_invite["id"]] == "accepted"
    assert statuses[revoked_invite["id"]] == "revoked"


def test_group_thumbnail_access_and_caching_follow_join_policy(client):
    owner = account(client, "owner")
    outsider = account(client, "outsider")
    thumbnail = b"\x89PNG\r\n\x1a\nteam"

    confined = client.post(
        "/api/groups",
        headers=auth(owner),
        json={"name": "Confined", "joinPolicy": "invite"},
    ).json()["group"]
    confined_path = f"/api/groups/{confined['id']}/thumbnail"
    assert (
        client.put(
            confined_path,
            headers={**auth(owner), "Content-Type": "image/png"},
            content=thumbnail,
        ).status_code
        == 204
    )
    assert client.get(confined_path).status_code == 404
    assert client.get(confined_path, headers=auth(outsider)).status_code == 404
    member_response = client.get(confined_path, headers=auth(owner))
    assert member_response.content == thumbnail
    assert member_response.headers["cache-control"] == "private, no-store"

    open_group = client.post(
        "/api/groups",
        headers=auth(owner),
        json={"name": "Open", "joinPolicy": "open"},
    ).json()["group"]
    open_path = f"/api/groups/{open_group['id']}/thumbnail"
    assert (
        client.put(
            open_path,
            headers={**auth(owner), "Content-Type": "image/png"},
            content=thumbnail,
        ).status_code
        == 204
    )
    public_response = client.get(open_path)
    assert public_response.content == thumbnail
    assert public_response.headers["cache-control"] == "public, max-age=3600"


def test_shared_with_me_includes_org_and_group_projects(client):
    """/api/projects?shared_with_me=true returns org-shared and group-shared projects."""
    admin = account(client, "admin")
    member = account(client, "member")
    outsider = account(client, "outsider")
    org = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={
            "slug": "lab",
            "name": "Lab",
            "publicSharingPolicy": "yes",
            "defaultVisibility": "organization",
        },
    )
    org_id = org.json()["organization"]["id"]
    client.put(
        f"/api/organizations/{org_id}/members",
        headers=auth(admin),
        json={"username": "member", "role": "member"},
    )

    group = client.post(
        "/api/groups", headers=auth(admin), json={"name": "Team", "sharedUpdate": False}
    )
    group_id = group.json()["group"]["id"]
    client.put(
        f"/api/groups/{group_id}/members",
        headers=auth(admin),
        json={"username": "member", "role": "member"},
    )

    content = json.dumps({"version": "1.0", "title": "X", "layers": []})

    # Admin creates org-visibility project
    org_proj = client.post(
        "/api/projects",
        headers=auth(admin),
        json={
            "filename": "org.json",
            "content": content,
            "visibility": "organization",
            "organizationId": org_id,
        },
    )
    org_proj_id = org_proj.json()["project"]["id"]
    org_private = client.post(
        "/api/projects",
        headers=auth(admin),
        json={
            "filename": "org-private.json",
            "content": content,
            "visibility": "private",
            "organizationId": org_id,
        },
    ).json()["project"]["id"]

    # Admin creates private project shared with group
    grp_proj = client.post(
        "/api/projects",
        headers=auth(admin),
        json={
            "filename": "grp.json",
            "content": content,
            "visibility": "private",
            "groupIds": [group_id],
        },
    )
    grp_proj_id = grp_proj.json()["project"]["id"]

    # Member sees both in shared_with_me
    shared = client.get("/api/projects?shared_with_me=true", headers=auth(member)).json()[
        "projects"
    ]
    shared_ids = {p["id"] for p in shared}
    assert org_proj_id in shared_ids
    assert grp_proj_id in shared_ids
    assert org_private not in shared_ids

    # Outsider sees neither
    assert (
        client.get("/api/projects?shared_with_me=true", headers=auth(outsider)).json()["projects"]
        == []
    )

    # Mine does not include org/shared projects (unless member owns them)
    mine = client.get("/api/projects?mine=true", headers=auth(member)).json()["projects"]
    assert all(p["id"] not in shared_ids for p in mine)


def test_expected_version_conflict_on_content_update(client):
    """A stale update is saved but carries the required last-write-wins warning."""
    owner = account(client)
    proj = client.post(
        "/api/projects",
        headers=auth(owner),
        json={"filename": "x.json", "content": '{"v":"1"}', "visibility": "public"},
    )
    proj_id = proj.json()["project"]["id"]

    # First update: version becomes 2
    u1 = client.put(
        f"/api/projects/{proj_id}/content",
        headers=auth(owner),
        json={"content": '{"v":"2"}', "expectedVersion": 1},
    )
    assert u1.status_code == 201
    assert u1.json()["version"] == 2

    # Second update with stale expectedVersion=1 succeeds with a warning.
    u2 = client.put(
        f"/api/projects/{proj_id}/content",
        headers=auth(owner),
        json={"content": '{"v":"3"}', "expectedVersion": 1},
    )
    assert u2.status_code == 201
    assert u2.json()["version"] == 3
    assert "version conflict" in u2.json()["warning"].lower()

    # Update with current expectedVersion=3 succeeds without a warning.
    u3 = client.put(
        f"/api/projects/{proj_id}/content",
        headers=auth(owner),
        json={"content": '{"v":"4"}', "expectedVersion": 3},
    )
    assert u3.status_code == 201
    assert u3.json()["version"] == 4
    assert "warning" not in u3.json()


def test_patch_project_with_organization_id_and_group_ids(client):
    """PATCH /projects supports changing organizationId and groupIds."""
    admin = account(client, "admin")
    member = account(client, "member")

    org = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={
            "slug": "lab2",
            "name": "Lab2",
            "publicSharingPolicy": "yes",
            "defaultVisibility": "organization",
        },
    )
    org_id = org.json()["organization"]["id"]
    client.put(
        f"/api/organizations/{org_id}/members",
        headers=auth(admin),
        json={"username": "member", "role": "member"},
    )

    g1 = client.post("/api/groups", headers=auth(admin), json={"name": "G1", "sharedUpdate": False})
    g1_id = g1.json()["group"]["id"]
    client.put(
        f"/api/groups/{g1_id}/members",
        headers=auth(admin),
        json={"username": "member", "role": "member"},
    )

    g2 = client.post("/api/groups", headers=auth(admin), json={"name": "G2", "sharedUpdate": False})
    g2_id = g2.json()["group"]["id"]
    # Note: member is NOT added to g2

    # Create private project
    proj = client.post(
        "/api/projects",
        headers=auth(admin),
        json={"filename": "x.json", "content": '{"v":"1"}', "visibility": "private"},
    )
    proj_id = proj.json()["project"]["id"]

    # Patch to organization visibility with orgId
    p1 = client.patch(
        f"/api/projects/{proj_id}",
        headers=auth(admin),
        json={"visibility": "organization", "organizationId": org_id},
    )
    assert p1.status_code == 200
    assert p1.json()["project"]["visibility"] == "organization"
    assert p1.json()["project"]["organization"]["id"] == org_id

    # Member can read via org
    assert client.get(f"/api/projects/{proj_id}", headers=auth(member)).status_code == 200

    # Now test groupIds on a separate PRIVATE project (no org)
    proj2 = client.post(
        "/api/projects",
        headers=auth(admin),
        json={"filename": "x2.json", "content": '{"v":"1"}', "visibility": "private"},
    )
    proj2_id = proj2.json()["project"]["id"]

    # Patch groupIds to g1
    p2 = client.patch(f"/api/projects/{proj2_id}", headers=auth(admin), json={"groupIds": [g1_id]})
    assert p2.status_code == 200
    assert p2.json()["project"]["groupIds"] == [g1_id]

    # Member can read via group
    assert client.get(f"/api/projects/{proj2_id}", headers=auth(member)).status_code == 200

    # Replace groupIds to g2 (member not in g2)
    p3 = client.patch(f"/api/projects/{proj2_id}", headers=auth(admin), json={"groupIds": [g2_id]})
    assert p3.status_code == 200
    assert p3.json()["project"]["groupIds"] == [g2_id]

    # Member can no longer read (not in g2, and project is private with no org)
    assert client.get(f"/api/projects/{proj2_id}", headers=auth(member)).status_code == 404


def test_group_settings_patch_does_not_allow_shared_update_change(client):
    """PATCH /groups/{id} does not expose sharedUpdate (immutable per issue #1669)."""
    owner = account(client, "owner")
    g = client.post("/api/groups", headers=auth(owner), json={"name": "Test", "sharedUpdate": True})
    g_id = g.json()["group"]["id"]
    assert g.json()["group"]["sharedUpdate"] is True

    # PATCH can change name and description
    p = client.patch(
        f"/api/groups/{g_id}",
        headers=auth(owner),
        json={"name": "Renamed", "description": "New desc"},
    )
    assert p.status_code == 200
    assert p.json()["group"]["name"] == "Renamed"
    assert p.json()["group"]["description"] == "New desc"

    # sharedUpdate is not in the patch model, so it stays true
    assert p.json()["group"]["sharedUpdate"] is True
    assert (
        client.patch(
            f"/api/groups/{g_id}",
            headers=auth(owner),
            json={"sharedUpdate": False},
        ).status_code
        == 422
    )


def test_organization_owned_raw_routes_roles_and_protected_caching(client):
    admin = account(client, "admin")
    member = account(client, "member")
    publisher = account(client, "publisher")
    viewer = account(client, "viewer")
    organization = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={
            "slug": "climate-lab",
            "name": "Climate Lab",
            "publicSharingPolicy": "publishers",
            "defaultVisibility": "organization",
        },
    ).json()["organization"]
    for username, role in (
        ("member", "member"),
        ("publisher", "publisher"),
        ("viewer", "viewer"),
    ):
        assert (
            client.put(
                f"/api/organizations/{organization['id']}/members",
                headers=auth(admin),
                json={"username": username, "role": role},
            ).status_code
            == 200
        )

    content = json.dumps({"version": "1.0", "title": "Internal climate", "layers": []})
    created = client.post(
        "/api/projects",
        headers=auth(member),
        json={
            "filename": "climate.json",
            "content": content,
            "visibility": "organization",
            "organizationId": organization["id"],
        },
    )
    assert created.status_code == 201, created.text
    project = created.json()["project"]
    assert project["username"] is None
    assert project["rawJsonUrl"].endswith("/org/climate-lab/internal-climate.geolibre.json")
    raw_path = project["rawJsonUrl"].removeprefix("https://share.example")
    assert client.get(raw_path).status_code == 404
    protected_raw = client.get(raw_path, headers=auth(viewer))
    assert protected_raw.status_code == 200
    assert protected_raw.headers["cache-control"] == "private, no-store"
    metadata = client.get(f"/api/projects/{project['id']}", headers=auth(viewer))
    assert metadata.headers["cache-control"] == "private, no-store"
    listing = client.get(f"/api/organizations/{organization['id']}/projects", headers=auth(viewer))
    assert listing.headers["cache-control"] == "private, no-store"

    public_body = {
        "filename": "public.json",
        "content": content,
        "visibility": "public",
        "organizationId": organization["id"],
    }
    assert client.post("/api/projects", headers=auth(member), json=public_body).status_code == 403
    assert (
        client.post("/api/projects", headers=auth(publisher), json=public_body).status_code == 201
    )
    assert client.post("/api/projects", headers=auth(viewer), json=public_body).status_code == 403

    assert (
        client.delete(
            f"/api/organizations/{organization['id']}/members/viewer",
            headers=auth(admin),
        ).status_code
        == 204
    )
    assert client.get(raw_path, headers=auth(viewer)).status_code == 404


def test_group_owner_transfer_moderation_and_read_only_shares(client):
    owner = account(client, "owner")
    manager = account(client, "manager")
    member = account(client, "member")
    requester = account(client, "requester")
    group = client.post(
        "/api/groups",
        headers=auth(owner),
        json={"name": "Review team", "joinPolicy": "request", "sharedUpdate": False},
    ).json()["group"]
    for username, role in (("manager", "manager"), ("member", "member")):
        assert (
            client.put(
                f"/api/groups/{group['id']}/members",
                headers=auth(owner),
                json={"username": username, "role": role},
            ).status_code
            == 200
        )
    assert (
        client.put(
            f"/api/groups/{group['id']}/members",
            headers=auth(manager),
            json={"username": "member", "role": "owner"},
        ).status_code
        == 403
    )
    assert (
        client.put(
            f"/api/groups/{group['id']}/members",
            headers=auth(owner),
            json={"username": "owner", "role": "manager"},
        ).status_code
        == 409
    )

    assert (
        client.post(f"/api/groups/{group['id']}/join", headers=auth(requester)).status_code == 204
    )
    ordinary_members = client.get(
        f"/api/groups/{group['id']}/members", headers=auth(member)
    ).json()["members"]
    assert "requester" not in {item["username"] for item in ordinary_members}
    manager_members = client.get(
        f"/api/groups/{group['id']}/members", headers=auth(manager)
    ).json()["members"]
    assert (
        next(item for item in manager_members if item["username"] == "requester")["status"]
        == "pending"
    )

    content = json.dumps({"version": "1.0", "title": "Review map", "layers": []})
    project = client.post(
        "/api/projects",
        headers=auth(owner),
        json={
            "filename": "review.json",
            "content": content,
            "visibility": "private",
            "groupIds": [group["id"]],
        },
    ).json()["project"]
    assert (
        client.put(
            f"/api/projects/{project['id']}/content",
            headers=auth(member),
            json={"content": content},
        ).status_code
        == 403
    )
    group_projects = client.get(f"/api/groups/{group['id']}/projects", headers=auth(member))
    assert group_projects.headers["cache-control"] == "private, no-store"
    assert [item["id"] for item in group_projects.json()["projects"]] == [project["id"]]
    assert (
        client.delete(
            f"/api/groups/{group['id']}/projects/{project['id']}", headers=auth(manager)
        ).status_code
        == 204
    )
    assert client.get(f"/api/projects/{project['id']}", headers=auth(member)).status_code == 404

    transfer = client.put(
        f"/api/groups/{group['id']}/members",
        headers=auth(owner),
        json={"username": "member", "role": "owner"},
    )
    assert transfer.status_code == 200
    roles = {
        item["username"]: item["role"]
        for item in client.get(f"/api/groups/{group['id']}/members", headers=auth(member)).json()[
            "members"
        ]
    }
    assert roles["member"] == "owner"
    assert roles["owner"] == "manager"
    assert list(roles.values()).count("owner") == 1

    owner_id = next(
        item["id"]
        for item in client.get(f"/api/groups/{group['id']}/members", headers=auth(member)).json()[
            "members"
        ]
        if item["username"] == "owner"
    )
    with pytest.raises(IntegrityError), client.app.state.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE group_members SET role = 'owner' WHERE group_id = ? AND account_id = ?",
            (group["id"], owner_id),
        )


def test_private_organization_projects_follow_admin_creator_and_group_access(client):
    admin = account(client, "admin")
    creator = account(client, "creator")
    member = account(client, "member")
    viewer = account(client, "viewer")
    organization = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={"slug": "private-lab", "name": "Private Lab"},
    ).json()["organization"]
    for username, role in (
        ("creator", "publisher"),
        ("member", "member"),
        ("viewer", "viewer"),
    ):
        client.put(
            f"/api/organizations/{organization['id']}/members",
            headers=auth(admin),
            json={"username": username, "role": role},
        )
    project = client.post(
        "/api/projects",
        headers=auth(creator),
        json={
            "filename": "private.json",
            "content": '{"title":"Private organization map"}',
            "visibility": "private",
            "organizationId": organization["id"],
        },
    ).json()["project"]

    for token in (admin, creator):
        response = client.get(f"/api/projects/{project['id']}", headers=auth(token))
        assert response.status_code == 200
        assert response.json()["project"]["canEdit"] is True
        assert response.headers["cache-control"] == "private, no-store"
    for token in (member, viewer):
        assert client.get(f"/api/projects/{project['id']}", headers=auth(token)).status_code == 404

    group = client.post(
        "/api/groups",
        headers=auth(creator),
        json={"name": "Readers", "sharedUpdate": False},
    ).json()["group"]
    client.put(
        f"/api/groups/{group['id']}/members",
        headers=auth(creator),
        json={"username": "member", "role": "member"},
    )
    client.patch(
        f"/api/projects/{project['id']}",
        headers=auth(creator),
        json={"groupIds": [group["id"]]},
    )
    shared = client.get(f"/api/projects/{project['id']}", headers=auth(member))
    assert shared.status_code == 200
    assert shared.json()["project"]["canEdit"] is False


def test_shared_sources_filter_before_pagination_and_report_can_edit(client):
    admin = account(client, "admin")
    creator = account(client, "creator")
    member = account(client, "member")
    organization = client.post(
        "/api/organizations",
        headers=auth(admin),
        json={"slug": "source-lab", "name": "Source Lab"},
    ).json()["organization"]
    for username in ("creator", "member"):
        client.put(
            f"/api/organizations/{organization['id']}/members",
            headers=auth(admin),
            json={"username": username, "role": "member"},
        )
    group = client.post(
        "/api/groups",
        headers=auth(admin),
        json={"name": "Editors", "sharedUpdate": True},
    ).json()["group"]
    client.put(
        f"/api/groups/{group['id']}/members",
        headers=auth(admin),
        json={"username": "member", "role": "member"},
    )

    def create(token, title, visibility, organization_id=None, group_ids=None) -> dict[str, object]:
        return client.post(
            "/api/projects",
            headers=auth(token),
            json={
                "filename": f"{title}.json",
                "content": json.dumps({"title": title}),
                "visibility": visibility,
                "organizationId": organization_id,
                "groupIds": group_ids or [],
            },
        ).json()["project"]

    public = create(admin, "Public org", "public", organization["id"])
    organization_map = create(admin, "Organization map", "organization", organization["id"])
    admin_private = create(admin, "Admin private", "private", organization["id"])
    creator_private = create(creator, "Creator private", "private", organization["id"])
    creator_unlisted = create(creator, "Creator unlisted", "unlisted", organization["id"])
    group_projects = [
        create(admin, f"Group {number}", "private", group_ids=[group["id"]]) for number in range(3)
    ]

    member_org = client.get(
        "/api/projects?shared_with_me=true&shared_source=organizations",
        headers=auth(member),
    ).json()
    assert {item["id"] for item in member_org["projects"]} == {
        public["id"],
        organization_map["id"],
    }
    assert all(item["canEdit"] is False for item in member_org["projects"])

    creator_org = client.get(
        "/api/projects?shared_with_me=true&shared_source=organizations",
        headers=auth(creator),
    ).json()["projects"]
    assert {item["id"] for item in creator_org} == {
        public["id"],
        organization_map["id"],
        creator_private["id"],
        creator_unlisted["id"],
    }
    assert admin_private["id"] not in {item["id"] for item in creator_org}
    assert (
        next(item for item in creator_org if item["id"] == creator_private["id"])["canEdit"] is True
    )

    admin_org = client.get(
        "/api/projects?shared_with_me=true&shared_source=organizations",
        headers=auth(admin),
    ).json()["projects"]
    assert {item["id"] for item in admin_org} == {
        public["id"],
        organization_map["id"],
        admin_private["id"],
        creator_private["id"],
        creator_unlisted["id"],
    }
    assert all(item["canEdit"] is True for item in admin_org)

    pages = [
        client.get(
            f"/api/projects?shared_with_me=true&shared_source=groups&limit=1&offset={offset}",
            headers=auth(member),
        ).json()
        for offset in range(3)
    ]
    assert all(page["total"] == 3 and len(page["projects"]) == 1 for page in pages)
    assert {page["projects"][0]["id"] for page in pages} == {
        project["id"] for project in group_projects
    }
    assert all(page["projects"][0]["canEdit"] is True for page in pages)
    assert client.get("/api/projects?shared_source=groups", headers=auth(member)).status_code == 422


def test_account_email_creation_update_validation_and_uniqueness(client):
    first = account(client, "first", " First@Example.org ")
    current = client.get("/api/account", headers=auth(first))
    assert current.json()["account"]["email"] == "first@example.org"
    assert current.headers["cache-control"] == "private, no-store"
    second = account(client, "second")
    assert (
        client.patch(
            "/api/account", headers=auth(second), json={"email": "not-an-email"}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            "/api/account",
            headers=auth(second),
            json={"email": "FIRST@example.org"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/accounts",
            json={
                "username": "third",
                "password": "correct horse",
                "email": "first@example.org",
            },
        ).status_code
        == 409
    )
    cleared = client.patch("/api/account", headers=auth(first), json={"email": None})
    assert cleared.json()["account"]["email"] is None


def test_authenticated_version_metadata_listing(client):
    owner = account(client, "owner")
    outsider = account(client, "outsider")
    project, _ = create_project(client, owner, "private", "Versioned")
    client.put(
        f"/api/projects/{project['id']}/content",
        headers=auth(owner),
        json={"content": '{"title":"Version two"}'},
    )
    path = f"/api/projects/{project['id']}/versions"
    assert client.get(path).status_code == 401
    assert client.get(path, headers=auth(outsider)).status_code == 404
    response = client.get(path, headers=auth(owner))
    assert response.headers["cache-control"] == "private, no-store"
    assert [item["number"] for item in response.json()["versions"]] == [2, 1]
    assert all(
        item["createdAt"] and item["url"].startswith("https://")
        for item in response.json()["versions"]
    )
    assert (
        client.get(f"/api/projects/{project['id']}/versions/1", headers=auth(owner)).status_code
        == 200
    )


def test_organization_transfer_allocates_conflict_free_slug(client):
    owner = account(client, "owner")
    organization = client.post(
        "/api/organizations",
        headers=auth(owner),
        json={"slug": "transfer-lab", "name": "Transfer Lab"},
    ).json()["organization"]
    individual, _ = create_project(client, owner, "private", "Collision")
    organization_project = client.post(
        "/api/projects",
        headers=auth(owner),
        json={
            "filename": "collision.json",
            "content": '{"title":"Collision"}',
            "visibility": "private",
            "organizationId": organization["id"],
        },
    ).json()["project"]
    transferred = client.patch(
        f"/api/projects/{organization_project['id']}",
        headers=auth(owner),
        json={"organizationId": None},
    )
    assert transferred.status_code == 200, transferred.text
    assert transferred.json()["project"]["slug"] == f"{individual['slug']}-2"


def test_postgresql_upgrade_sql_is_idempotent_and_covers_legacy_constraints():
    sql = "\n".join(postgresql_upgrade_statements()).lower()
    assert "add column if not exists email" in sql
    assert "visibility type varchar(16)" in sql
    assert "owner_id drop not null" in sql
    assert "on delete set null" in sql
    assert "uq_project_org_slug" in sql
    assert "uq_group_accepted_owner" in sql
    assert "where role = 'owner' and status = 'accepted'" in sql


def test_existing_sqlite_schema_is_upgraded_additively(tmp_path):
    database = tmp_path / "legacy.db"
    connection = sqlite3.connect(database)
    connection.executescript("""
        CREATE TABLE accounts (
            id VARCHAR(36) PRIMARY KEY,
            username VARCHAR(39) UNIQUE,
            password_hash TEXT NOT NULL,
            created_at VARCHAR(32) NOT NULL
        );
        CREATE TABLE projects (
            id VARCHAR(36) PRIMARY KEY,
            owner_id VARCHAR(36) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            slug VARCHAR(100) NOT NULL,
            title VARCHAR(100) NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            visibility VARCHAR(10) NOT NULL,
            tags_json TEXT NOT NULL DEFAULT '[]',
            thumbnail_type VARCHAR(20),
            views INTEGER NOT NULL DEFAULT 0,
            fork_count INTEGER NOT NULL DEFAULT 0,
            featured BOOLEAN NOT NULL DEFAULT 0,
            created_at VARCHAR(32) NOT NULL,
            updated_at VARCHAR(32) NOT NULL,
            CONSTRAINT uq_project_owner_slug UNIQUE (owner_id, slug)
        );
        CREATE TABLE groups (
            id VARCHAR(36) PRIMARY KEY,
            organization_id VARCHAR(36),
            owner_id VARCHAR(36) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            name VARCHAR(100) NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            thumbnail_type VARCHAR(20),
            join_policy VARCHAR(16) NOT NULL DEFAULT 'invite',
            shared_update BOOLEAN NOT NULL DEFAULT 0,
            created_at VARCHAR(32) NOT NULL
        );
        CREATE TABLE versions (
            project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            number INTEGER NOT NULL,
            object_key TEXT NOT NULL,
            created_at VARCHAR(32) NOT NULL,
            PRIMARY KEY (project_id, number)
        );
        CREATE TABLE project_groups (
            project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            group_id VARCHAR(36) NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            PRIMARY KEY (project_id, group_id)
        );
        INSERT INTO accounts (id, username, password_hash, created_at)
        VALUES ('old-account', 'old-owner', 'unused', '2026-01-01T00:00:00Z');
        INSERT INTO projects (
            id, owner_id, slug, title, visibility, created_at, updated_at
        ) VALUES (
            'old-project', 'old-account', 'old-map', 'Old map', 'private',
            '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        );
        INSERT INTO groups (id, owner_id, name, created_at)
        VALUES ('old-group', 'old-account', 'Old group', '2026-01-01T00:00:00Z');
        INSERT INTO versions (project_id, number, object_key, created_at)
        VALUES ('old-project', 1, 'old-object', '2026-01-01T00:00:00Z');
        INSERT INTO project_groups (project_id, group_id)
        VALUES ('old-project', 'old-group');
        """)
    connection.close()

    app = create_app(
        f"sqlite:///{database}",
        public_url="https://share.example",
        storage=FileStorage(str(tmp_path / "objects")),
    )
    with TestClient(app) as legacy_client:
        token = account(legacy_client, "legacy-admin")
        organization = legacy_client.post(
            "/api/organizations",
            headers=auth(token),
            json={"slug": "legacy-org", "name": "Legacy Org"},
        ).json()["organization"]
        project = legacy_client.post(
            "/api/projects",
            headers=auth(token),
            json={
                "filename": "legacy.json",
                "content": '{"title":"Legacy"}',
                "visibility": "organization",
                "organizationId": organization["id"],
            },
        )
        assert project.status_code == 201, project.text
        assert "/org/legacy-org/legacy.geolibre.json" in project.json()["project"]["rawJsonUrl"]
        individual = legacy_client.post(
            "/api/projects",
            headers=auth(token),
            json={
                "filename": "legacy.json",
                "content": '{"title":"Legacy"}',
                "visibility": "private",
            },
        )
        assert individual.status_code == 201, individual.text
        assert individual.json()["project"]["slug"] == "legacy"
        assert (
            legacy_client.get("/legacy-admin/legacy.geolibre.json", headers=auth(token)).status_code
            == 200
        )
    with app.state.engine.connect() as upgraded:
        account_columns = {
            row[1] for row in upgraded.exec_driver_sql("PRAGMA table_info(accounts)")
        }
        project_columns = {
            row[1] for row in upgraded.exec_driver_sql("PRAGMA table_info(projects)")
        }
        backfilled_creator = upgraded.exec_driver_sql(
            "SELECT created_by_id FROM projects WHERE id = 'old-project'"
        ).scalar_one()
        compatibility_owner, creator = upgraded.exec_driver_sql(
            "SELECT owner_id, created_by_id FROM projects WHERE id = ?",
            (project.json()["project"]["id"],),
        ).one()
        owner_info = next(
            row
            for row in upgraded.exec_driver_sql("PRAGMA table_info(projects)")
            if row[1] == "owner_id"
        )
        owner_delete_action = next(
            row[6]
            for row in upgraded.exec_driver_sql("PRAGMA foreign_key_list(projects)")
            if row[3] == "owner_id"
        )
        assert (
            upgraded.exec_driver_sql(
                "SELECT COUNT(*) FROM versions WHERE project_id = 'old-project'"
            ).scalar_one()
            == 1
        )
        assert (
            upgraded.exec_driver_sql(
                "SELECT COUNT(*) FROM project_groups WHERE project_id = 'old-project'"
            ).scalar_one()
            == 1
        )
    assert "email" in account_columns
    assert "organization_id" in project_columns
    assert "created_by_id" in project_columns
    assert backfilled_creator == "old-account"
    assert compatibility_owner is None
    assert creator is not None
    assert owner_info[3] == 0
    assert owner_delete_action == "SET NULL"

    creator_id = creator
    with app.state.engine.begin() as upgraded:
        upgraded.exec_driver_sql("DELETE FROM accounts WHERE id = ?", (creator_id,))
    with app.state.engine.connect() as upgraded:
        assert upgraded.exec_driver_sql(
            "SELECT organization_id, owner_id, created_by_id FROM projects WHERE id = ?",
            (project.json()["project"]["id"],),
        ).one() == (organization["id"], None, None)
        assert (
            upgraded.exec_driver_sql(
                "SELECT COUNT(*) FROM versions WHERE project_id = ?",
                (project.json()["project"]["id"],),
            ).scalar_one()
            == 1
        )
