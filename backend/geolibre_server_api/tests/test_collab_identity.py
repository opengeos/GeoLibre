"""Collaboration identity tokens minted for the live-collaboration relay."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest
from conftest import PUBLIC_URL, _make_app
from fastapi.testclient import TestClient
from geolibre_server_api.collab_identity import (
    COLLAB_IDENTITY_SECRET_ENV,
    COLLAB_IDENTITY_TTL_ENV,
    collab_identity_ttl,
    sign_collab_identity_token,
)
from helpers import account, auth, pat

SECRET = "relay-shared-secret-at-least-32-characters"


def _decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _client(tmp_path, monkeypatch, clock, fake_idp, secret: str | None):
    monkeypatch.delenv("GEOLIBRE_OAUTH_CLIENTS", raising=False)
    if secret is None:
        monkeypatch.delenv(COLLAB_IDENTITY_SECRET_ENV, raising=False)
    else:
        monkeypatch.setenv(COLLAB_IDENTITY_SECRET_ENV, secret)
    app = _make_app(tmp_path, PUBLIC_URL, clock=clock.now, oidc_transport=fake_idp.transport)
    return TestClient(app)


def test_mints_a_relay_token_for_the_signed_in_account(tmp_path, monkeypatch, clock, fake_idp):
    with _client(tmp_path, monkeypatch, clock, fake_idp, SECRET) as client:
        token = account(client, "ada")
        me = client.get("/api/users/me", headers=auth(token)).json()["user"]
        response = client.post("/api/collab/identity-token", headers=auth(token))
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "no-store"
        body = response.json()
        assert body["provider"] == "geolibre"
        payload, signature = body["token"].split(".")
        expected = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest()
        assert _decode(signature) == expected
        claims = json.loads(_decode(payload))
        assert claims == {
            "provider": "geolibre",
            "userId": me["id"],
            "username": "ada",
            "exp": clock.now() + 300,
        }
        assert body["expiresAt"].endswith("Z")


def test_requires_an_authenticated_project_scope(tmp_path, monkeypatch, clock, fake_idp):
    with _client(tmp_path, monkeypatch, clock, fake_idp, SECRET) as client:
        assert client.post("/api/collab/identity-token").status_code == 401
        account(client, "ada")
        share_only = pat(client, "ada", scopes=["share:public"])
        assert (
            client.post("/api/collab/identity-token", headers=auth(share_only)).status_code == 403
        )
        reader = pat(client, "ada", scopes=["read:projects"])
        assert client.post("/api/collab/identity-token", headers=auth(reader)).status_code == 403
        writer = pat(client, "ada", scopes=["write:projects"])
        assert client.post("/api/collab/identity-token", headers=auth(writer)).status_code == 200


def test_refuses_an_account_without_a_username(tmp_path, monkeypatch, clock, fake_idp):
    with _client(tmp_path, monkeypatch, clock, fake_idp, SECRET) as client:
        token = account(client, "ada")
        engine = client.app.state.engine
        with engine.begin() as connection:
            connection.exec_driver_sql("UPDATE accounts SET username = NULL")
        response = client.post("/api/collab/identity-token", headers=auth(token))
        assert response.status_code == 400
        assert response.json() == {"error": "username required"}


def test_refuses_a_short_secret(tmp_path, monkeypatch, clock, fake_idp):
    with pytest.raises(ValueError, match="at least 32"):
        _client(tmp_path, monkeypatch, clock, fake_idp, "short")


def test_is_disabled_without_a_shared_secret(tmp_path, monkeypatch, clock, fake_idp):
    with _client(tmp_path, monkeypatch, clock, fake_idp, None) as client:
        token = account(client, "ada")
        response = client.post("/api/collab/identity-token", headers=auth(token))
        assert response.status_code == 404
        assert response.json() == {"error": "collaboration identity is not configured"}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("", 300), ("120", 120), ("0", 300), ("-5", 300), ("nope", 300), ("99999", 3600)],
)
def test_ttl_is_bounded(monkeypatch, raw, expected):
    monkeypatch.setenv(COLLAB_IDENTITY_TTL_ENV, raw)
    assert collab_identity_ttl() == expected


def test_signature_matches_the_relay_format():
    # Pinned against `signIdentityToken` in packages/collab-core (see
    # tests/collab-identity.test.ts, which verifies this exact token).
    token = sign_collab_identity_token(
        {"provider": "geolibre", "userId": "u-1", "username": "Ada Lovelace", "exp": 4102444800},
        "pinned-secret",
    )
    assert token == PINNED_TOKEN
    # Non-ASCII usernames travel as raw UTF-8 on both sides.
    unicode_token = sign_collab_identity_token(
        {"provider": "geolibre", "userId": "u-2", "username": "Zoë", "exp": 4102444800},
        "pinned-secret",
    )
    assert unicode_token == PINNED_UNICODE_TOKEN


PINNED_TOKEN = (
    "eyJwcm92aWRlciI6Imdlb2xpYnJlIiwidXNlcklkIjoidS0xIiwidXNlcm5hbWUiOiJBZGEgTG92ZWxhY2UiLCJleHAiOjQxMDI0NDQ4MDB9"
    ".cgXPTdcpCie9rzq7rrl8xtYIUYEONhRQxQ-9nq-Cy0s"
)

PINNED_UNICODE_TOKEN = (
    "eyJwcm92aWRlciI6Imdlb2xpYnJlIiwidXNlcklkIjoidS0yIiwidXNlcm5hbWUiOiJab8OrIiwiZXhwIjo0MTAyNDQ0ODAwfQ"
    ".hMbtKwWLurrnpkQLVr3kSroEaxJKZ8nj_KtYCrsDSLg"
)
