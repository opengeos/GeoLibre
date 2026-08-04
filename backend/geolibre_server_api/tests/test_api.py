import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(
        f"sqlite:///{tmp_path / 'test.db'}",
        public_url="https://share.example",
        storage=None,
    )
    # create_app reads the storage path only if no implementation is passed.
    app.state.storage.root = tmp_path / "objects"
    app.state.storage.root.mkdir()
    with TestClient(app) as test_client:
        yield test_client


def account(client, username="ada"):
    response = client.post(
        "/api/accounts", json={"username": username, "password": "correct horse"}
    )
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


def test_accounts_login_current_user_and_hashed_secrets(client):
    assert client.get("/health").json() == {"ok": True, "service": "geolibre-server"}

    token = account(client)
    assert client.get("/api/account", headers=auth(token)).json()["account"]["username"] == "ada"
    assert client.get("/api/users/me", headers=auth(token)).json() == {"user": {"username": "ada"}}
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
            path, headers={**auth(owner), "Content-Type": "image/png"}, content=thumbnail
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
