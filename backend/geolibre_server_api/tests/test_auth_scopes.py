"""Project authorization boundaries for scoped personal API tokens."""

from __future__ import annotations

from helpers import auth, create_project, pat


def _content(title="Wetlands"):
    return f'{{"version":"1.0","title":"{title}","layers":[]}}'


def _private_project(client, token, title="Wetlands"):
    return create_project(client, token, "private", title)[0]


def test_read_scope_allows_owner_reads_and_blocks_mutations(client):
    owner = pat(client, scopes=["read:projects"])
    writer = pat(client, scopes=["write:projects"])
    project = _private_project(client, writer, "Private read")
    project_id = project["id"]

    assert client.get(f"/api/projects/{project_id}", headers=auth(owner)).status_code == 200
    assert (
        client.get(f"/api/projects/{project_id}/versions/1", headers=auth(owner)).status_code == 200
    )
    assert client.get("/ada/private-read.geolibre.json", headers=auth(owner)).status_code == 200
    assert client.get("/api/projects?mine=true", headers=auth(owner)).status_code == 200
    assert (
        client.get(f"/api/projects/{project_id}/activity", headers=auth(owner)).status_code == 200
    )

    mutation_cases = [
        (
            "post",
            "/api/projects",
            {"filename": "x.geolibre.json", "content": _content(), "visibility": "private"},
        ),
        ("patch", f"/api/projects/{project_id}", {"title": "Renamed"}),
        ("put", f"/api/projects/{project_id}/content", {"content": _content("v2")}),
        ("delete", f"/api/projects/{project_id}", None),
    ]
    for method, path, body in mutation_cases:
        kwargs = {"headers": auth(owner)}
        if body is not None:
            kwargs["json"] = body
        response = getattr(client, method)(path, **kwargs)
        assert response.status_code == 403, (method, path, response.text)
        assert response.json() == {
            "error": "insufficient_scope",
            "requiredScope": "write:projects",
        }
        assert response.headers["www-authenticate"] == 'Bearer error="insufficient_scope"'


def test_publishing_requires_share_public(client):
    write = pat(client, scopes=["write:projects"])
    private = create_project(client, write, "private", "Private ok")[0]
    create_project(client, write, "unlisted", "Unlisted ok")

    response = client.post(
        "/api/projects",
        headers=auth(write),
        json={
            "filename": "public.geolibre.json",
            "content": _content("Public"),
            "visibility": "public",
        },
    )
    assert response.status_code == 403
    assert response.json()["requiredScope"] == "share:public"

    response = client.patch(
        f"/api/projects/{private['id']}",
        headers=auth(write),
        json={"visibility": "public"},
    )
    assert response.status_code == 403
    assert response.json()["requiredScope"] == "share:public"

    publisher = pat(client, scopes=["write:projects", "share:public"])
    public = create_project(client, publisher, "public", "Public demote")[0]
    response = client.patch(
        f"/api/projects/{public['id']}",
        headers=auth(write),
        json={"visibility": "private"},
    )
    assert response.status_code == 200


def test_write_only_token_cannot_read_private_source(client):
    write = pat(client, scopes=["write:projects"])
    project = _private_project(client, write, "Source private")
    response = client.post(
        f"/api/projects/{project['id']}/forks",
        headers=auth(write),
        json={"visibility": "private"},
    )
    assert response.status_code == 403
    assert response.json()["requiredScope"] == "read:projects"

    response = client.get("/api/projects?mine=true", headers=auth(write))
    assert response.status_code == 403
    assert response.json()["requiredScope"] == "read:projects"


def test_forking_public_output_requires_share_public(client):
    publisher = pat(client, scopes=["write:projects", "share:public"])
    public = create_project(client, publisher, "public", "Fork me")[0]
    write = pat(client, scopes=["write:projects"])

    response = client.post(
        f"/api/projects/{public['id']}/forks",
        headers=auth(write),
        json={"visibility": "public"},
    )
    assert response.status_code == 403
    assert response.json()["requiredScope"] == "share:public"
    assert (
        client.post(
            f"/api/projects/{public['id']}/forks",
            headers=auth(write),
            json={"visibility": "private"},
        ).status_code
        == 201
    )


def test_ownership_is_separate_from_scope(client):
    grace = pat(
        client,
        username="grace",
        scopes=["read:projects", "write:projects"],
    )
    ada = pat(client, scopes=["read:projects", "write:projects"])
    project = _private_project(client, ada, "Mine")

    assert client.get(f"/api/projects/{project['id']}", headers=auth(grace)).status_code == 404
    response = client.patch(
        f"/api/projects/{project['id']}",
        headers=auth(grace),
        json={"title": "Theirs"},
    )
    assert response.status_code == 403
    assert response.json()["error"] == "project ownership required"


def test_credentials_do_not_broaden_public_listing(client):
    writer = pat(client, scopes=["write:projects"])
    _private_project(client, writer, "Hidden")
    assert client.get("/api/projects").json()["projects"] == []
    assert client.get("/api/projects", headers=auth(writer)).json()["projects"] == []

    response = client.get("/api/projects?mine=true")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_default_pat_preserves_existing_project_powers(client):
    token = pat(client)
    project = create_project(client, token, "public", "Default public")[0]
    assert project["visibility"] == "public"
    assert client.get(f"/api/projects/{project['id']}", headers=auth(token)).status_code == 200
    assert client.get("/api/projects?mine=true", headers=auth(token)).status_code == 200


def test_organization_and_group_routes_follow_project_scopes(client):
    """Org/group reads need read:projects; org/group writes need write:projects."""
    full = pat(client)
    reader = pat(client, scopes=["read:projects"])
    writer = pat(client, scopes=["write:projects"])

    org = client.post(
        "/api/organizations", headers=auth(full), json={"slug": "scoped-org", "name": "Scoped"}
    )
    assert org.status_code == 201
    org_id = org.json()["organization"]["id"]
    group = client.post("/api/groups", headers=auth(full), json={"name": "Scoped group"})
    assert group.status_code == 201
    group_id = group.json()["group"]["id"]

    # A read-only token can list but cannot create or change membership.
    assert client.get("/api/organizations/mine", headers=auth(reader)).status_code == 200
    assert client.get(f"/api/groups/{group_id}/members", headers=auth(reader)).status_code == 200
    assert client.get("/api/projects?shared_with_me=true", headers=auth(reader)).status_code == 200
    for method, path, body in [
        ("post", "/api/organizations", {"slug": "another-org", "name": "Another"}),
        ("post", "/api/groups", {"name": "Another group"}),
        ("patch", f"/api/organizations/{org_id}", {"name": "Renamed"}),
        ("patch", f"/api/groups/{group_id}", {"name": "Renamed"}),
        ("patch", "/api/account", {"email": "ada@example.org"}),
    ]:
        response = client.request(method, path, headers=auth(reader), json=body)
        assert response.status_code == 403, (method, path)
        assert response.json() == {"error": "insufficient_scope", "requiredScope": "write:projects"}

    # A write-only token can mutate but cannot read membership listings.
    assert (
        client.patch(
            f"/api/organizations/{org_id}", headers=auth(writer), json={"name": "Renamed"}
        ).status_code
        == 200
    )
    for path in [
        "/api/organizations/mine",
        "/api/groups/mine",
        f"/api/organizations/{org_id}/members",
        f"/api/groups/{group_id}/projects",
        "/api/projects?shared_with_me=true",
    ]:
        response = client.get(path, headers=auth(writer))
        assert response.status_code == 403, path
        assert response.json()["requiredScope"] == "read:projects"
