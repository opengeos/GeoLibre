"""OAuth startup validation, host binding, and SQLite lock handling."""

from __future__ import annotations

import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api import auth as auth_module
from geolibre_server_api.auth import parse_issuer
from geolibre_server_api.auth_models import OAUTH_INDEXES
from geolibre_server_api.main import FileStorage, create_app
from helpers import approve, sign_in, start_authorize
from sqlalchemy import inspect

PUBLIC_URL = "https://share.example"
VALID_CLIENTS = [
    {
        "client_id": "geolibre-web",
        "name": "GeoLibre Web",
        "redirect_uris": [f"{PUBLIC_URL}/oauth-callback.html"],
        "scopes": ["read:projects", "write:projects", "share:public"],
    }
]


def make_app(tmp_path, database_url=None, public_url=PUBLIC_URL):
    return create_app(
        database_url or f"sqlite:///{tmp_path / 'test.db'}",
        public_url=public_url,
        storage=FileStorage(str(tmp_path / "objects")),
    )


def test_disabled_oauth_ignores_oauth_only_configuration(tmp_path, monkeypatch):
    monkeypatch.delenv("GEOLIBRE_OAUTH_CLIENTS", raising=False)
    monkeypatch.setenv("GEOLIBRE_OAUTH_ACCESS_TTL_SECONDS", "not-an-integer")
    app = make_app(tmp_path, public_url="not-an-oauth-issuer")
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/.well-known/oauth-authorization-server").status_code == 404


def test_oauth_cors_needs_explicit_desktop_origin_even_with_wildcard_api(tmp_path, monkeypatch):
    desktop = {
        "client_id": "geolibre-desktop",
        "name": "GeoLibre Desktop",
        "redirect_uris": ["org.geolibre.desktop:/oauth/callback"],
        "scopes": ["read:projects"],
    }
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps([*VALID_CLIENTS, desktop]))
    monkeypatch.delenv("GEOLIBRE_CORS_ORIGINS", raising=False)
    headers = {"Origin": "tauri://localhost", "Access-Control-Request-Method": "POST"}
    default = make_app(tmp_path)
    with TestClient(default, base_url=PUBLIC_URL) as client:
        assert (
            client.get("/health", headers={"Origin": "tauri://localhost"}).headers[
                "access-control-allow-origin"
            ]
            == "*"
        )
        blocked = client.options("/oauth/token", headers=headers)
        assert blocked.status_code == 400
        assert "access-control-allow-origin" not in blocked.headers
    default.state.engine.dispose()

    monkeypatch.setenv("GEOLIBRE_CORS_ORIGINS", "*,tauri://localhost")
    explicit = make_app(tmp_path)
    with TestClient(explicit, base_url=PUBLIC_URL) as client:
        allowed = client.options("/oauth/token", headers=headers)
        assert allowed.status_code == 200
        assert allowed.headers["access-control-allow-origin"] == "tauri://localhost"
    explicit.state.engine.dispose()


@pytest.mark.parametrize(
    "issuer",
    [
        "https:///missing-host",
        "http://localhost/no-explicit-port",
        "https://share.example:bad-port",
        "ftp://share.example",
    ],
)
def test_enabled_oauth_rejects_invalid_issuers(tmp_path, monkeypatch, issuer):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(VALID_CLIENTS))
    with pytest.raises(RuntimeError, match="GEOLIBRE_PUBLIC_URL"):
        make_app(tmp_path, public_url=issuer)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://SHARE.Example:443/services/", "https://share.example/services"),
        ("http://LOCALHOST:80", "http://localhost"),
        ("https://share.example:8443", "https://share.example:8443"),
        ("https://[2001:DB8::1]:443/path/", "https://[2001:db8::1]/path"),
    ],
)
def test_parse_issuer_normalizes_authority(raw, expected):
    assert parse_issuer(raw) == expected


@pytest.mark.parametrize(
    "client",
    [
        {
            "client_id": "geolibre-web",
            "name": "Web",
            "redirect_uris": ["https:///oauth-callback.html"],
            "scopes": ["read:projects"],
        },
        {
            "client_id": "geolibre-web",
            "name": "Web",
            "redirect_uris": ["http://localhost/oauth-callback.html"],
            "scopes": ["read:projects"],
        },
        {
            "client_id": "geolibre-web",
            "name": "Web",
            "redirect_uris": ["https://share.example/not-the-callback"],
            "scopes": ["read:projects"],
        },
        {
            "client_id": "geolibre-desktop",
            "name": "Desktop",
            "redirect_uris": ["org.geolibre.desktop:/other"],
            "scopes": ["read:projects"],
        },
    ],
)
def test_registration_rejects_unsafe_redirects(tmp_path, monkeypatch, client):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps([client]))
    with pytest.raises(RuntimeError, match="redirect_uri"):
        make_app(tmp_path)


def test_oauth_host_binding_includes_the_issuer_port(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(VALID_CLIENTS))
    app = make_app(tmp_path, public_url="https://share.example:8443")
    with TestClient(app, base_url="https://share.example:8443") as client:
        assert client.get("/.well-known/oauth-authorization-server").status_code == 200
        rejected = client.get(
            "/.well-known/oauth-authorization-server",
            headers={"Host": "share.example"},
        )
        assert rejected.status_code == 400


def test_consent_password_check_does_not_block_other_requests(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(VALID_CLIENTS))
    app = make_app(tmp_path)
    entered = threading.Event()
    release = threading.Event()

    def hold_password_check(_password, _stored_hash):
        entered.set()
        assert release.wait(timeout=10)
        return False

    with TestClient(app, base_url=PUBLIC_URL) as client:
        page, _, interaction, csrf = start_authorize(client)
        assert page.status_code == 200 and interaction and csrf
        monkeypatch.setattr(auth_module, "password_matches", hold_password_check)
        with ThreadPoolExecutor(max_workers=2) as executor:
            consent = executor.submit(approve, client, interaction, csrf)
            try:
                assert entered.wait(timeout=5)
                health = executor.submit(client.get, "/health")
                assert health.result(timeout=3).status_code == 200
            finally:
                release.set()
            assert consent.result(timeout=5).status_code == 200


def test_existing_oauth_database_gains_indexes_without_losing_sessions(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(VALID_CLIENTS))
    app = make_app(tmp_path)
    with TestClient(app, base_url=PUBLIC_URL) as client:
        tokens = sign_in(client)
    for index in OAUTH_INDEXES:
        index.drop(app.state.engine)
    app.state.engine.dispose()

    upgraded = make_app(tmp_path)
    with TestClient(upgraded, base_url=PUBLIC_URL) as client:
        response = client.get(
            "/api/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )
        assert response.status_code == 200
        for index in OAUTH_INDEXES:
            assert index.name in {
                item["name"]
                for item in inspect(upgraded.state.engine).get_indexes(index.table.name)
            }
    upgraded.state.engine.dispose()

    # The same persisted database must also survive another application startup.
    again = make_app(tmp_path)
    with TestClient(again, base_url=PUBLIC_URL) as client:
        assert (
            client.post(
                "/oauth/token",
                data={
                    "grant_type": "refresh_token",
                    "client_id": "geolibre-web",
                    "refresh_token": tokens["refresh_token"],
                },
            ).status_code
            == 200
        )
    again.state.engine.dispose()


def test_sqlite_lock_exhaustion_is_a_controlled_oauth_error(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(VALID_CLIENTS))
    database = tmp_path / "locked.db"
    app = make_app(tmp_path, f"sqlite:///{database}?timeout=0.05")
    with TestClient(app, base_url=PUBLIC_URL) as client:
        tokens = sign_in(client)
        page, _, interaction, csrf = start_authorize(client)
        assert interaction and csrf
        lock = sqlite3.connect(database)
        try:
            lock.execute("BEGIN EXCLUSIVE")
            authorize_response = client.get(page.request.url)
            consent_response = approve(client, interaction, csrf)
            refresh_response = client.post(
                "/oauth/token",
                data={
                    "grant_type": "refresh_token",
                    "client_id": "geolibre-web",
                    "refresh_token": tokens["refresh_token"],
                },
            )
            revoke_response = client.post(
                "/oauth/revoke",
                data={
                    "client_id": "geolibre-web",
                    "token": tokens["access_token"],
                },
            )
        finally:
            lock.rollback()
            lock.close()
    assert refresh_response.status_code == 503
    assert refresh_response.json() == {"error": "temporarily_unavailable"}
    for response in (authorize_response, consent_response):
        assert response.status_code == 503
        assert "temporarily_unavailable" in response.text
        assert "location" not in response.headers
    assert revoke_response.status_code == 503
    assert revoke_response.json() == {"error": "temporarily_unavailable"}
