"""Organization security policy: sessions, lockout, rotation, admin re-auth, IP allowlist."""

from __future__ import annotations

import json

from conftest import OAUTH_CLIENTS, PUBLIC_URL, _make_app
from fastapi.testclient import TestClient
from helpers import (
    add_member,
    admin_token,
    approve,
    auth,
    create_org,
    ensure_account,
    refresh,
    set_policy,
    sign_in,
    start_authorize,
)
from sqlalchemy import inspect, text


def _org_with_policy(client, **fields) -> tuple[str, str]:
    """Create an org administered by ada with *fields* set; bob is a member."""
    token = admin_token(client)
    org_id = create_org(client, token)
    response = set_policy(client, token, org_id, **fields)
    assert response.status_code == 200, response.text
    add_member(client, token, org_id, "bob")
    return token, org_id


def _login(client, password, username="bob"):
    return client.post("/api/auth/token", json={"username": username, "password": password})


def _change_password(client, current, new, username="bob"):
    return client.post(
        "/api/account/password",
        json={"username": username, "currentPassword": current, "newPassword": new},
    )


def test_idle_timeout_revokes_unused_session(oauth_client, clock):
    _org_with_policy(oauth_client, idleTimeoutSeconds=300)
    token = sign_in(oauth_client, username="bob")["access_token"]
    clock.advance(301)
    assert oauth_client.get("/api/users/me", headers=auth(token)).status_code == 401


def test_idle_timeout_is_extended_by_use(oauth_client, clock):
    _org_with_policy(oauth_client, idleTimeoutSeconds=300)
    token = sign_in(oauth_client, username="bob")["access_token"]
    clock.advance(200)
    assert oauth_client.get("/api/users/me", headers=auth(token)).status_code == 200
    clock.advance(200)
    assert oauth_client.get("/api/users/me", headers=auth(token)).status_code == 200


def test_absolute_session_lifetime_stops_refresh(oauth_client, clock):
    _org_with_policy(oauth_client, absoluteSessionSeconds=900)
    tokens = sign_in(oauth_client, username="bob")
    clock.advance(901)
    response = refresh(oauth_client, tokens["refresh_token"])
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_grant"


def test_lockout_after_threshold_then_expires(oauth_client, clock):
    _org_with_policy(oauth_client, lockoutThreshold=3, lockoutSeconds=60)
    for _ in range(3):
        response = _login(oauth_client, "wrong password")
        assert response.status_code == 401
        assert response.json() == {"error": "invalid username or password"}
    locked = _login(oauth_client, "correct horse")
    assert locked.status_code == 401
    assert locked.json() == {"error": "account temporarily locked"}
    clock.advance(61)
    assert _login(oauth_client, "correct horse").status_code == 200


def test_password_rotation_and_change(oauth_client, clock):
    _org_with_policy(oauth_client, passwordMaxAgeDays=1)
    assert _login(oauth_client, "correct horse").status_code == 200
    clock.advance(86401)
    expired = _login(oauth_client, "correct horse")
    assert expired.status_code == 403
    assert expired.json() == {"error": "password expired"}

    _, _, interaction, csrf = start_authorize(oauth_client)
    page = approve(oauth_client, interaction, csrf, username="bob")
    assert page.status_code == 200
    assert "Your password has expired" in page.text

    assert _change_password(oauth_client, "correct horse", "a new Passw0rd!").status_code == 204
    assert _login(oauth_client, "a new Passw0rd!").status_code == 200


def test_password_change_enforces_min_classes(oauth_client):
    _org_with_policy(oauth_client, passwordMinClasses=3)
    response = _change_password(oauth_client, "correct horse", "alllowercase1")
    assert response.status_code == 422
    assert "at least 3 of" in response.json()["error"]


def test_admin_reauthentication_required_for_mutations(oauth_client, clock):
    token = admin_token(oauth_client)
    org_id = create_org(oauth_client, token)
    assert set_policy(oauth_client, token, org_id, adminReauthSeconds=60).status_code == 200
    clock.advance(61)
    stale = oauth_client.patch(
        f"/api/organizations/{org_id}", json={"name": "X"}, headers=auth(token)
    )
    assert stale.status_code == 401
    assert stale.json() == {"error": "reauthentication_required"}
    assert "insufficient_user_authentication" in stale.headers["www-authenticate"]
    listed = oauth_client.get(f"/api/organizations/{org_id}/invitations", headers=auth(token))
    assert listed.status_code == 200
    fresh = admin_token(oauth_client)
    patched = oauth_client.patch(
        f"/api/organizations/{org_id}", json={"name": "X"}, headers=auth(fresh)
    )
    assert patched.status_code == 200


def test_admin_ip_allowlist(oauth_client):
    app = oauth_client.app
    with (
        TestClient(app, base_url=PUBLIC_URL, client=("203.0.113.9", 5000)) as c1,
        TestClient(app, base_url=PUBLIC_URL, client=("198.51.100.7", 5000)) as c2,
    ):
        token = admin_token(c1)
        org_id = create_org(c1, token)
        excluded = set_policy(c1, token, org_id, adminIpAllowlist=["198.51.100.0/24"])
        assert excluded.status_code == 422
        assert excluded.json() == {"error": "adminIpAllowlist must include your current address"}
        assert set_policy(c1, token, org_id, adminIpAllowlist=["203.0.113.0/24"]).status_code == 200
        add_member(c1, token, org_id, "bob", role="administrator")

        other = admin_token(c2, username="bob")
        denied = c2.get(f"/api/organizations/{org_id}/invitations", headers=auth(other))
        assert denied.status_code == 403
        assert denied.json() == {"error": "administrative access is not allowed from this network"}


def test_admin_ip_allowlist_through_trusted_proxy(tmp_path, monkeypatch, clock):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    monkeypatch.setenv("GEOLIBRE_TRUSTED_PROXIES", "10.0.0.0/8")
    proxied_dir = tmp_path / "proxied"
    proxied_dir.mkdir()
    app = _make_app(proxied_dir, PUBLIC_URL, clock=clock.now)
    forwarded = {"X-Forwarded-For": "203.0.113.50"}
    with (
        TestClient(app, base_url=PUBLIC_URL, client=("10.0.0.5", 5000), headers=forwarded) as ok,
        TestClient(app, base_url=PUBLIC_URL, client=("192.0.2.1", 5000), headers=forwarded) as bad,
    ):
        token = admin_token(ok)
        org_id = create_org(ok, token)
        assert set_policy(ok, token, org_id, adminIpAllowlist=["203.0.113.0/24"]).status_code == 200
        allowed = ok.get(f"/api/organizations/{org_id}/invitations", headers=auth(token))
        assert allowed.status_code == 200

        spoofed = admin_token(bad)
        denied = bad.get(f"/api/organizations/{org_id}/invitations", headers=auth(spoofed))
        assert denied.status_code == 403
        assert denied.json() == {"error": "administrative access is not allowed from this network"}


def test_strictest_policy_wins_across_organizations(oauth_client):
    token = admin_token(oauth_client)
    first = create_org(oauth_client, token, slug="first", name="First")
    second = create_org(oauth_client, token, slug="second", name="Second")
    assert set_policy(oauth_client, token, first, passwordMinLength=10).status_code == 200
    assert set_policy(oauth_client, token, second, passwordMinLength=14).status_code == 200
    add_member(oauth_client, token, first, "bob")
    add_member(oauth_client, token, second, "bob")
    response = _change_password(oauth_client, "correct horse", "Twelve chars")
    assert response.status_code == 422
    assert "at least 14 characters" in response.json()["error"]


def test_sqlite_schema_upgrade_adds_legacy_columns(oauth_client, tmp_path, clock):
    ensure_account(oauth_client)
    engine = oauth_client.app.state.engine
    with engine.begin() as connection:
        connection.execute(text("DROP INDEX ix_federated_identities_claimed_username"))
        connection.execute(text("DROP INDEX ix_federated_identities_claimed_email"))
        for table, column in (
            ("oauth_authorization_codes", "authenticated_at"),
            ("oauth_sessions", "authenticated_at"),
            ("federated_identities", "claimed_username"),
            ("federated_identities", "claimed_email"),
        ):
            connection.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))

    upgraded = _make_app(tmp_path, PUBLIC_URL, clock=clock.now)
    try:
        for table, expected in (
            ("oauth_authorization_codes", "authenticated_at"),
            ("oauth_sessions", "authenticated_at"),
            ("federated_identities", "claimed_username"),
            ("federated_identities", "claimed_email"),
        ):
            columns = {c["name"] for c in inspect(upgraded.state.engine).get_columns(table)}
            assert expected in columns
        with TestClient(upgraded, base_url=PUBLIC_URL) as client:
            assert sign_in(client)["access_token"]
    finally:
        upgraded.state.engine.dispose()
