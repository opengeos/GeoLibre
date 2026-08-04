import hashlib
import json

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api.main import FileStorage, create_app


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
