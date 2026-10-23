"""Scoped and expiring personal API token behavior."""

from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient
from geolibre_server_api.auth import now, password_hash, token_digest
from geolibre_server_api.main import FileStorage, create_app
from helpers import account, auth, ensure_account, pat


def test_default_pat_has_all_project_scopes_and_no_default_expiry(client):
    ensure_account(client)
    response = client.post("/api/auth/token", json={"username": "ada", "password": "correct horse"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["scopes"] == ["read:projects", "write:projects", "share:public"]
    assert body["tokenId"]
    # An omitted lifetime preserves the v1 delete-only token lifecycle.
    assert body["expiresAt"] is None
    with client.app.state.engine.connect() as connection:
        row = connection.exec_driver_sql(
            "select legacy, scope, expires_at from personal_token_policies where token_digest = ?",
            (token_digest(body["token"]),),
        ).fetchone()
    assert row == (0, "read:projects write:projects share:public", None)


def test_requested_pat_policy_is_honored(client):
    response = client.post(
        "/api/accounts",
        json={
            "username": "ada",
            "password": "correct horse",
            "name": "CI deploy",
            "scopes": ["read:projects"],
            "expiresInDays": 7,
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["scopes"] == ["read:projects"]
    assert body["expiresAt"] == "2023-11-21T22:13:20Z"

    me = client.get("/api/users/me", headers=auth(body["token"]))
    assert me.status_code == 200
    assert me.json()["scopes"] == ["read:projects"]

    with client.app.state.engine.connect() as connection:
        policy = connection.exec_driver_sql(
            "select label, scope from personal_token_policies where id = ?",
            (body["tokenId"],),
        ).fetchone()
    assert policy == ("CI deploy", "read:projects")


def test_invalid_pat_policy_is_rejected(client):
    ensure_account(client)
    for extra in (
        {"scopes": []},
        {"scopes": ["unknown:scope"]},
        {"scopes": ["admin:org"]},
    ):
        response = client.post(
            "/api/auth/token",
            json={"username": "ada", "password": "correct horse", **extra},
        )
        assert response.status_code == 400, extra
        assert response.json() == {"error": "invalid_scope"}

    for extra in (
        {"expiresInDays": 0},
        {"expiresInDays": 366},
        {"expiresInDays": -1},
    ):
        response = client.post(
            "/api/auth/token",
            json={"username": "ada", "password": "correct horse", **extra},
        )
        assert response.status_code == 400, extra
        assert response.json() == {"error": "invalid_request"}

    for days in (1, 365):
        response = client.post(
            "/api/auth/token",
            json={
                "username": "ada",
                "password": "correct horse",
                "expiresInDays": days,
            },
        )
        assert response.status_code == 200


def test_invalid_bootstrap_policy_does_not_reserve_account(client):
    rejected = client.post(
        "/api/accounts",
        json={
            "username": "charlie",
            "password": "correct horse",
            "scopes": ["admin:org"],
        },
    )
    assert rejected.status_code == 400
    assert rejected.json() == {"error": "invalid_scope"}

    accepted = client.post(
        "/api/accounts",
        json={"username": "charlie", "password": "correct horse"},
    )
    assert accepted.status_code == 201


def test_delete_auth_token_revokes_pat(client):
    token = pat(client)
    assert client.get("/api/users/me", headers=auth(token)).status_code == 200
    assert client.delete("/api/auth/token", headers=auth(token)).status_code == 204
    assert client.get("/api/users/me", headers=auth(token)).status_code == 401


def test_expired_pat_is_rejected(client, clock):
    token = pat(client, expiresInDays=1)
    assert client.get("/api/users/me", headers=auth(token)).status_code == 200
    clock.advance(86401)
    response = client.get("/api/users/me", headers=auth(token))
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == 'Bearer error="invalid_token"'


def test_legacy_token_without_policy_is_backfilled_on_use(client):
    ensure_account(client)
    legacy = "legacy-token-value"
    with client.app.state.engine.connect() as connection:
        connection.exec_driver_sql(
            "insert into tokens (digest, account_id, created_at) "
            "values (?, (select id from accounts limit 1), ?)",
            (token_digest(legacy), now()),
        )
        connection.commit()

    me = client.get("/api/users/me", headers=auth(legacy))
    assert me.status_code == 200, me.text
    assert me.json()["scopes"] == ["read:projects", "write:projects", "share:public"]
    with client.app.state.engine.connect() as connection:
        row = connection.exec_driver_sql(
            "select legacy, scope, expires_at, revoked_at from personal_token_policies "
            "where token_digest = ?",
            (token_digest(legacy),),
        ).fetchone()
    assert row == (1, "read:projects write:projects share:public", None, None)


def test_pre_policy_database_is_upgraded_additively(tmp_path, clock):
    database = tmp_path / "legacy.db"
    raw_token = "pre-policy-token"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            create table accounts (
                id varchar(36) primary key,
                username varchar(39) unique,
                password_hash text not null,
                created_at varchar(32) not null
            );
            create table tokens (
                digest varchar(64) primary key,
                account_id varchar(36) not null references accounts(id) on delete cascade,
                created_at varchar(32) not null
            );
            """
        )
        connection.execute(
            "insert into accounts values (?, ?, ?, ?)",
            ("account-1", "ada", password_hash("correct horse"), now()),
        )
        connection.execute(
            "insert into tokens values (?, ?, ?)",
            (token_digest(raw_token), "account-1", now()),
        )

    app = create_app(
        f"sqlite:///{database}",
        public_url="https://share.example",
        storage=FileStorage(str(tmp_path / "objects")),
        clock=clock.now,
    )
    with TestClient(app) as upgraded:
        response = upgraded.get("/api/users/me", headers=auth(raw_token))
        assert response.status_code == 200, response.text
        assert response.json()["user"]["username"] == "ada"
        assert response.json()["scopes"] == [
            "read:projects",
            "write:projects",
            "share:public",
        ]


def test_account_bootstrap_token_is_scoped_and_non_expiring(client):
    raw = account(client, "bob")
    response = client.get("/api/users/me", headers=auth(raw))
    assert response.status_code == 200
    assert response.json()["scopes"] == [
        "read:projects",
        "write:projects",
        "share:public",
    ]
