"""Active shares: listing, revocation, and enforcement of link expiry and password."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from geolibre_server_api.project_models import Project
from helpers import account, auth
from sqlalchemy.orm import Session


def share(client, token, title="Wetlands", **extra):
    content = json.dumps({"version": "1.0", "title": title, "layers": []})
    body = {"filename": "f.geolibre.json", "content": content, "visibility": "unlisted", **extra}
    response = client.post("/api/projects", headers=auth(token), json=body)
    assert response.status_code == 201, response.text
    return response.json()["project"], content


def test_list_shares_returns_only_callers_non_private_projects(client):
    ada = account(client, "ada")
    bob = account(client, "bob")
    shared, _ = share(client, ada, "Shared", role="view", expiresIn="7d", password="pw")
    share(client, ada, "Hidden", visibility="private")
    share(client, bob, "Bobs")

    response = client.get("/api/shares", headers=auth(ada))

    assert response.status_code == 200
    (item,) = response.json()["shares"]
    assert item["id"] == shared["id"]
    assert item["projectSlug"] == shared["slug"]
    assert item["role"] == "view"
    assert item["hasPassword"] is True
    assert item["expiresAt"] is not None


def test_shares_require_authentication(client):
    assert client.get("/api/shares").status_code == 401
    assert client.delete("/api/shares/anything").status_code == 401


def test_revoke_makes_project_private_and_keeps_content(client):
    ada = account(client, "ada")
    bob = account(client, "bob")
    project, _ = share(client, ada, password="pw", role="view")

    assert client.delete(f"/api/shares/{project['id']}", headers=auth(bob)).status_code == 403
    assert client.delete(f"/api/shares/{project['id']}", headers=auth(ada)).status_code == 204

    assert client.get(f"/ada/{project['slug']}.geolibre.json").status_code == 404
    assert client.get("/api/shares", headers=auth(ada)).json()["shares"] == []
    kept = client.get(f"/api/projects/{project['id']}", headers=auth(ada)).json()["project"]
    assert kept["visibility"] == "private"
    assert kept["hasPassword"] is False
    assert kept["role"] == "edit"
    # Revoking twice is a 404: there is no active share left.
    assert client.delete(f"/api/shares/{project['id']}", headers=auth(ada)).status_code == 404


def test_password_protects_raw_json_until_access_is_unlocked(client):
    ada = account(client, "ada")
    project, content = share(client, ada, password="s3cret", role="comment")
    raw = f"/ada/{project['slug']}.geolibre.json"
    access = f"/ada/{project['slug']}/access"

    assert client.get(raw).status_code == 401
    assert client.post(access, json={"password": "nope"}).status_code == 401

    unlocked = client.post(access, json={"password": "s3cret"})
    assert unlocked.status_code == 200
    assert unlocked.json() == {"content": content, "role": "comment"}
    assert unlocked.headers["cache-control"] == "private, no-store"
    # The owner reads their own project without the password.
    assert client.get(raw, headers=auth(ada)).status_code == 200


def test_expired_link_is_gone_for_readers_but_not_owner(client):
    ada = account(client, "ada")
    project, _ = share(client, ada, expiresIn="24h")
    raw = f"/ada/{project['slug']}.geolibre.json"
    assert client.get(raw).status_code == 200

    expired = (datetime.now(UTC) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    with Session(client.app.state.engine) as session:
        session.get(Project, project["id"]).share_expires_at = expired
        session.commit()

    assert client.get(raw).status_code == 410
    assert client.get(raw, headers=auth(ada)).status_code == 200
    # Still listed so the owner can revoke it.
    listed = client.get("/api/shares", headers=auth(ada)).json()["shares"]
    assert [s["id"] for s in listed] == [project["id"]]


def test_link_without_settings_is_unaffected(client):
    ada = account(client, "ada")
    project, content = share(client, ada)
    assert project["role"] == "edit"
    assert project["expiresAt"] is None
    assert project["hasPassword"] is False
    assert client.get(f"/ada/{project['slug']}.geolibre.json").text == content


def test_organization_visible_projects_are_not_link_shares(client):
    ada = account(client, "ada")
    organization = client.post(
        "/api/organizations", headers=auth(ada), json={"slug": "lab", "name": "Lab"}
    ).json()["organization"]
    project, _ = share(client, ada, visibility="organization", organizationId=organization["id"])

    assert client.get("/api/shares", headers=auth(ada)).json()["shares"] == []
    assert client.delete(f"/api/shares/{project['id']}", headers=auth(ada)).status_code == 404
    kept = client.get(f"/api/projects/{project['id']}", headers=auth(ada)).json()["project"]
    assert kept["visibility"] == "organization"


def test_password_gate_covers_project_api_and_organization_access(client):
    ada = account(client, "ada")
    organization = client.post(
        "/api/organizations", headers=auth(ada), json={"slug": "lab", "name": "Lab"}
    ).json()["organization"]
    project, content = share(
        client, ada, visibility="public", organizationId=organization["id"], password="pw"
    )

    assert client.get(f"/api/projects/{project['id']}").status_code == 401
    assert client.get(f"/org/lab/{project['slug']}.geolibre.json").status_code == 401
    unlocked = client.post(f"/org/lab/{project['slug']}/access", json={"password": "pw"})
    assert unlocked.json() == {"content": content, "role": "edit"}
    assert client.get(f"/api/projects/{project['id']}", headers=auth(ada)).status_code == 200


def test_access_enforces_expiry_before_password(client):
    ada = account(client, "ada")
    project, _ = share(client, ada, expiresIn="24h", password="pw")
    expired = (datetime.now(UTC) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    with Session(client.app.state.engine) as session:
        session.get(Project, project["id"]).share_expires_at = expired
        session.commit()

    response = client.post(f"/ada/{project['slug']}/access", json={"password": "pw"})
    assert response.status_code == 410


def test_wrong_passwords_are_throttled(client):
    ada = account(client, "ada")
    project, _ = share(client, ada, password="pw")
    access = f"/ada/{project['slug']}/access"

    statuses = [client.post(access, json={"password": "bad"}).status_code for _ in range(11)]

    assert statuses[:10] == [401] * 10
    assert statuses[10] == 429
    # Even the right password is refused while throttled.
    assert client.post(access, json={"password": "pw"}).status_code == 429


def test_version_list_is_gated_by_the_share_password(client):
    ada = account(client, "ada")
    bob = account(client, "bob")
    project, _ = share(client, ada, password="pw")

    assert (
        client.get(f"/api/projects/{project['id']}/versions", headers=auth(bob)).status_code == 401
    )
    assert (
        client.get(f"/api/projects/{project['id']}/versions", headers=auth(ada)).status_code == 200
    )


def test_organization_administrator_sees_and_revokes_shares_they_did_not_create(client):
    ada = account(client, "ada")
    organization = client.post(
        "/api/organizations", headers=auth(ada), json={"slug": "lab", "name": "Lab"}
    ).json()["organization"]
    project, _ = share(client, ada, visibility="public", organizationId=organization["id"])
    bob = account(client, "bob")
    invitation = client.put(
        f"/api/organizations/{organization['id']}/members",
        headers=auth(ada),
        json={"username": "bob", "role": "administrator"},
    )
    assert invitation.status_code in (200, 201), invitation.text

    listed = client.get("/api/shares", headers=auth(bob))
    assert [s["id"] for s in listed.json()["shares"]] == [project["id"]]
    assert client.delete(f"/api/shares/{project['id']}", headers=auth(bob)).status_code == 204


def test_invalid_share_settings_are_rejected(client):
    ada = account(client, "ada")
    content = json.dumps({"version": "1.0", "title": "T", "layers": []})
    for extra in ({"role": "owner"}, {"expiresIn": "1y"}, {"password": ""}):
        response = client.post(
            "/api/projects",
            headers=auth(ada),
            json={"filename": "f.json", "content": content, "visibility": "unlisted", **extra},
        )
        assert response.status_code == 422, extra


def test_concurrent_wrong_passwords_cannot_exceed_the_limit(client):
    from concurrent.futures import ThreadPoolExecutor

    ada = account(client, "ada")
    project, _ = share(client, ada, password="pw")
    access = f"/ada/{project['slug']}/access"

    with ThreadPoolExecutor(max_workers=12) as pool:
        statuses = list(
            pool.map(lambda _: client.post(access, json={"password": "bad"}).status_code, range(30))
        )

    assert statuses.count(401) == 10
    assert statuses.count(429) == 20


def test_link_settings_are_refused_on_non_link_visibility(client):
    ada = account(client, "ada")
    organization = client.post(
        "/api/organizations", headers=auth(ada), json={"slug": "lab", "name": "Lab"}
    ).json()["organization"]
    content = json.dumps({"version": "1.0", "title": "T", "layers": []})
    for visibility, extra in (
        ("organization", {"organizationId": organization["id"], "password": "pw"}),
        ("private", {"expiresIn": "7d"}),
        ("private", {"role": "view"}),
    ):
        response = client.post(
            "/api/projects",
            headers=auth(ada),
            json={"filename": "f.json", "content": content, "visibility": visibility, **extra},
        )
        assert response.status_code == 422, (visibility, extra)
    # Defaults are fine on any visibility.
    assert share(client, ada, visibility="private")[0]["hasPassword"] is False
