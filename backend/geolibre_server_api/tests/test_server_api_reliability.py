"""Regression tests for server API reliability fixes."""

from __future__ import annotations

import ipaddress
import json

from conftest import OAUTH_CLIENTS, PUBLIC_URL, _make_app
from fastapi.testclient import TestClient
from geolibre_server_api.main import FileStorage
from geolibre_server_api.proxy_identity import _parse_ip
from helpers import (
    admin_token,
    auth,
    configure_idp,
    create_org,
    exchange_code,
    redirect_params,
    set_policy,
    sso_sign_in,
    start_authorize,
    start_sso,
)


def test_parse_ip_unwraps_ipv4_mapped_ipv6():
    parsed = _parse_ip("::ffff:10.0.0.5")
    assert parsed == ipaddress.IPv4Address("10.0.0.5")
    assert parsed in ipaddress.ip_network("10.0.0.0/8")


def test_trusted_proxy_and_allowlist_match_ipv4_mapped_ipv6(tmp_path, monkeypatch, clock):
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    monkeypatch.setenv("GEOLIBRE_TRUSTED_PROXIES", "10.0.0.0/8")
    app = _make_app(tmp_path / "dualstack", PUBLIC_URL, clock=clock.now)
    forwarded = {"X-Forwarded-For": "::ffff:203.0.113.50"}
    with TestClient(
        app, base_url=PUBLIC_URL, client=("::ffff:10.0.0.5", 5000), headers=forwarded
    ) as client:
        token = admin_token(client)
        org_id = create_org(client, token)
        assert (
            set_policy(client, token, org_id, adminIpAllowlist=["203.0.113.0/24"]).status_code
            == 200
        )
        allowed = client.get(f"/api/organizations/{org_id}/invitations", headers=auth(token))
        assert allowed.status_code == 200


def test_file_storage_put_is_atomic(tmp_path):
    storage = FileStorage(str(tmp_path / "store"))
    storage.put("projects/p1/thumbnail", b"first", "image/png")
    assert storage.get("projects/p1/thumbnail") == b"first"
    storage.put("projects/p1/thumbnail", b"second", "image/png")
    assert storage.get("projects/p1/thumbnail") == b"second"
    leftovers = list((tmp_path / "store" / "projects" / "p1").iterdir())
    assert [p.name for p in leftovers] == ["thumbnail"]


def test_password_login_is_case_insensitive(oauth_client):
    admin_token(oauth_client)
    res = oauth_client.post(
        "/api/auth/token", json={"username": "  ADA  ", "password": "correct horse"}
    )
    assert res.status_code == 200
    assert res.json()["account"]["username"] == "ada"


def test_exchange_code_rejects_expired_absolute_session_from_old_auth_time(
    oauth_client, fake_idp, clock
):
    token = admin_token(oauth_client)
    org_id = create_org(oauth_client, token)
    assert configure_idp(oauth_client, token, org_id).status_code == 200
    assert set_policy(oauth_client, token, org_id, absoluteSessionSeconds=900).status_code == 200

    # IdP reports an auth_time older than the organization's absolute session limit.
    claims = fake_idp.base_claims("u-stale", preferred_username="staleuser")
    claims["auth_time"] = clock.now() - 1800
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    assert callback.status_code == 303
    code = redirect_params(callback)["code"]

    exchanged = exchange_code(oauth_client, code, verifier=verifier)
    assert exchanged.status_code == 400
    assert exchanged.json()["error"] == "invalid_grant"


def test_sso_max_age_only_requested_for_reauth(oauth_client, fake_idp):
    token = admin_token(oauth_client)
    org_id = create_org(oauth_client, token)
    assert configure_idp(oauth_client, token, org_id).status_code == 200
    assert set_policy(oauth_client, token, org_id, adminReauthSeconds=60).status_code == 200

    # Regular SSO login should not force max_age on all users.
    _, params, _ = start_sso(oauth_client, "acme")
    assert "max_age" not in params

    # Explicit reauth request passes max_age to the IdP.
    _, _, interaction, csrf = start_authorize(oauth_client)
    redirect = oauth_client.post(
        "/oauth/authorize",
        data={
            "interaction": interaction,
            "csrf": csrf,
            "label": "Test device",
            "decision": "sso",
            "organization": "acme",
            "reauth": "1",
        },
        headers={"Origin": PUBLIC_URL},
        follow_redirects=False,
    )
    assert redirect.status_code == 303
    assert redirect_params(redirect).get("max_age") == "60"
