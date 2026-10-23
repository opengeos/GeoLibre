"""Account-owned session management and step-up grant behavior."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from geolibre_server_api.auth import token_digest
from geolibre_server_api.auth_models import OAuthRefreshToken, PersonalTokenPolicy, Token
from helpers import auth, pat, redirect_params, refresh, sign_in, start_authorize


def _me(client, credential):
    return client.get("/api/users/me", headers=auth(credential))


def _session_id(client, credential):
    response = _me(client, credential)
    assert response.status_code == 200, response.text
    return response.json()["sessionId"]


def test_management_grant_is_short_lived_unrefreshable_and_isolated(oauth_client, clock):
    project = sign_in(oauth_client)
    manager = sign_in(oauth_client, scope="manage:sessions", client_id="geolibre-desktop")
    assert manager == {
        "access_token": manager["access_token"],
        "token_type": "Bearer",
        "expires_in": 300,
        "scope": "manage:sessions",
    }
    assert (
        refresh(oauth_client, manager["access_token"], client_id="geolibre-desktop").json()["error"]
        == "invalid_grant"
    )
    metadata = oauth_client.get("/.well-known/oauth-authorization-server").json()
    assert "manage:sessions" in metadata["scopes_supported"]
    assert "personal token" in start_authorize(oauth_client, scope="manage:sessions")[0].text
    assert _me(oauth_client, manager["access_token"]).json()["scopes"] == ["manage:sessions"]
    manager_id = _session_id(oauth_client, manager["access_token"])
    with oauth_client.app.state.session_factory() as session:
        assert session.query(OAuthRefreshToken).filter_by(session_id=manager_id).count() == 0
    assert (
        oauth_client.get("/api/auth/sessions", headers=auth(project["access_token"])).status_code
        == 403
    )
    assert (
        oauth_client.delete(
            "/api/auth/sessions/unknown", headers=auth(project["access_token"])
        ).status_code
        == 403
    )
    assert (
        oauth_client.post(
            "/api/auth/sessions/revoke-others",
            json={"currentSessionId": "bad"},
            headers=auth(project["access_token"]),
        ).status_code
        == 403
    )
    assert (
        oauth_client.post(
            "/api/auth/token",
            json={"username": "ada", "password": "correct horse", "scopes": ["manage:sessions"]},
        ).status_code
        == 400
    )
    assert (
        oauth_client.post(
            "/api/accounts",
            json={"username": "bea", "password": "correct horse", "scopes": ["manage:sessions"]},
        ).status_code
        == 400
    )
    for scope in ("manage:sessions read:projects", "share:public manage:sessions"):
        response, _, _, _ = start_authorize(oauth_client, scope=scope)
        assert redirect_params(response)["error"] == "invalid_scope"
    clock.advance(300)
    assert _me(oauth_client, manager["access_token"]).status_code == 401
    assert _me(oauth_client, project["access_token"]).status_code == 200


def test_listing_backfills_legacy_tokens_paginates_and_exposes_no_secrets(oauth_client, clock):
    project = sign_in(oauth_client, label="Workstation")
    session_id = _session_id(oauth_client, project["access_token"])
    personal = pat(oauth_client, name="CI", scopes=["read:projects"])
    legacy = "old-secret-legacy-token"
    account_id = _me(oauth_client, personal).json()["user"]["id"]
    with oauth_client.app.state.session_factory() as session:
        session.add(
            Token(
                digest=token_digest(legacy),
                account_id=account_id,
                created_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            )
        )
        session.commit()
    manager = sign_in(oauth_client, scope="manage:sessions")
    response = oauth_client.get(
        "/api/auth/sessions",
        params={"currentSessionId": session_id},
        headers=auth(manager["access_token"]),
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    rows = response.json()["sessions"]
    assert response.json()["total"] == 4  # account creation also issued a bootstrap PAT
    assert {row["kind"] for row in rows} == {"oauth", "personal-token"}
    assert [row["createdAt"] for row in rows] == sorted(
        (row["createdAt"] for row in rows), reverse=True
    )
    current = next(row for row in rows if row["current"])
    assert current == {
        "id": session_id,
        "kind": "oauth",
        "clientId": "geolibre-web",
        "label": "Workstation",
        "scopes": ["read:projects"],
        "createdAt": current["createdAt"],
        "lastUsedAt": current["lastUsedAt"],
        "expiresAt": current["expiresAt"],
        "current": True,
        "legacy": False,
    }
    ci = next(row for row in rows if row["label"] == "CI")
    assert (
        ci["kind"] == "personal-token"
        and ci["clientId"] is None
        and not ci["current"]
        and not ci["legacy"]
    )
    assert next(row for row in rows if row["legacy"])["label"] == "Legacy personal token"
    assert len({row["id"] for row in rows}) == 4
    for secret in (
        legacy,
        personal,
        project["access_token"],
        project["refresh_token"],
        manager["access_token"],
        token_digest(personal),
    ):
        assert secret not in response.text
    page = oauth_client.get(
        "/api/auth/sessions",
        params={"limit": 1, "offset": 1},
        headers=auth(manager["access_token"]),
    )
    assert page.json() == {
        "sessions": [rows[1] | {"current": False}],
        "limit": 1,
        "offset": 1,
        "total": 4,
    }
    for params in ({"limit": 0}, {"limit": 101}, {"offset": -1}):
        assert (
            oauth_client.get(
                "/api/auth/sessions", params=params, headers=auth(manager["access_token"])
            ).status_code
            == 422
        )


def test_ownership_single_revocation_and_bulk_preserves_current_and_manager(oauth_client):
    current = sign_in(oauth_client)
    current_id = _session_id(oauth_client, current["access_token"])
    other = sign_in(oauth_client, client_id="geolibre-desktop")
    other_id = _session_id(oauth_client, other["access_token"])
    another = sign_in(oauth_client)
    second_manager = sign_in(oauth_client, scope="manage:sessions")
    ci = pat(oauth_client, name="CI")
    legacy = "legacy-for-revoke"
    owner_id = _me(oauth_client, ci).json()["user"]["id"]
    with oauth_client.app.state.session_factory() as session:
        session.add(
            Token(
                digest=token_digest(legacy),
                account_id=owner_id,
                created_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            )
        )
        session.commit()
    foreign_pat = pat(oauth_client, username="bea", name="foreign")
    foreign_project = sign_in(oauth_client, username="bea", password="correct horse")
    foreign_id = _session_id(oauth_client, foreign_project["access_token"])
    with oauth_client.app.state.session_factory() as session:
        foreign_pat_id = (
            session.query(PersonalTokenPolicy)
            .filter_by(token_digest=token_digest(foreign_pat))
            .one()
            .id
        )
    manager = sign_in(oauth_client, scope="manage:sessions")
    headers = auth(manager["access_token"])
    for manager_token in (manager["access_token"], second_manager["access_token"]):
        manager_id = _session_id(oauth_client, manager_token)
        hidden = oauth_client.delete(f"/api/auth/sessions/{manager_id}", headers=headers)
        assert hidden.status_code == 404
        assert hidden.json() == {"error": "not found"}
        assert _me(oauth_client, manager_token).status_code == 200
    for id_ in ("unknown", foreign_id, foreign_pat_id):
        get = oauth_client.get(
            "/api/auth/sessions", params={"currentSessionId": id_}, headers=headers
        )
        delete = oauth_client.delete(f"/api/auth/sessions/{id_}", headers=headers)
        bulk = oauth_client.post(
            "/api/auth/sessions/revoke-others", json={"currentSessionId": id_}, headers=headers
        )
        assert (get.status_code, get.json()) == (404, {"error": "not found"})
        assert (delete.status_code, delete.json()) == (404, {"error": "not found"})
        assert (bulk.status_code, bulk.json()) == (404, {"error": "not found"})
    assert _me(oauth_client, other["access_token"]).status_code == 200
    assert oauth_client.delete(f"/api/auth/sessions/{other_id}", headers=headers).status_code == 204
    assert oauth_client.delete(f"/api/auth/sessions/{other_id}", headers=headers).status_code == 204
    assert _me(oauth_client, other["access_token"]).status_code == 401
    assert (
        refresh(oauth_client, other["refresh_token"], client_id="geolibre-desktop").status_code
        == 400
    )
    assert (
        oauth_client.post(
            "/api/auth/sessions/revoke-others",
            json={"currentSessionId": current_id},
            headers=headers,
        ).status_code
        == 204
    )
    assert _me(oauth_client, current["access_token"]).status_code == 200
    assert _me(oauth_client, manager["access_token"]).status_code == 200
    for token in (another["access_token"], second_manager["access_token"], ci, legacy):
        assert _me(oauth_client, token).status_code == 401
    assert refresh(oauth_client, another["refresh_token"]).status_code == 400
    assert _me(oauth_client, foreign_pat).status_code == 200
    assert _me(oauth_client, foreign_project["access_token"]).status_code == 200
    with oauth_client.app.state.session_factory() as session:
        assert (
            session.query(PersonalTokenPolicy)
            .filter_by(token_digest=token_digest(legacy))
            .one()
            .revoked_at
            is not None
        )
    assert (
        oauth_client.delete(f"/api/auth/sessions/{current_id}", headers=headers).status_code == 204
    )
    assert _me(oauth_client, current["access_token"]).status_code == 401
    assert refresh(oauth_client, current["refresh_token"]).status_code == 400
    assert (
        oauth_client.get(
            "/api/auth/sessions", params={"currentSessionId": current_id}, headers=headers
        ).status_code
        == 404
    )


def test_revoke_personal_policy_retains_metadata(oauth_client):
    ci = pat(oauth_client, name="CI")
    manager = sign_in(oauth_client, scope="manage:sessions")
    headers = auth(manager["access_token"])
    rows = oauth_client.get("/api/auth/sessions", headers=headers).json()["sessions"]
    id_ = next(row["id"] for row in rows if row["label"] == "CI")
    assert uuid.UUID(id_)
    for _ in range(2):
        assert oauth_client.delete(f"/api/auth/sessions/{id_}", headers=headers).status_code == 204
    assert _me(oauth_client, ci).status_code == 401
    assert id_ not in [
        row["id"]
        for row in oauth_client.get("/api/auth/sessions", headers=headers).json()["sessions"]
    ]
    with oauth_client.app.state.session_factory() as session:
        assert session.get(PersonalTokenPolicy, id_).revoked_at is not None
