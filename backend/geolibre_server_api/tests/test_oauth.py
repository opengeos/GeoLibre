"""OAuth 2.0 Authorization Code + S256 PKCE protocol tests.

These pin the security contract of the reference server's consent flow, token
exchange, refresh rotation/reuse detection, revocation, and RFC 8414
discovery. The clock fixture replaces sleeping: time advances only through
``clock.advance``.
"""

from __future__ import annotations

import hashlib
import json
import threading

import pytest
from fastapi.testclient import TestClient
from geolibre_server_api import main as server_main
from geolibre_server_api.main import FileStorage, create_app
from helpers import (
    ORIGIN,
    approve,
    b64url,
    ensure_account,
    exchange_code,
    make_verifier_and_challenge,
    redirect_params,
    refresh,
    sign_in,
    start_authorize,
)

pytestmark = pytest.mark.usefixtures("clock")


def _code(client, *, scope="read:projects", **kwargs):
    """Start a flow, approve it, and return the raw authorization code."""
    ensure_account(client)
    response, verifier, interaction, csrf = start_authorize(client, scope=scope, **kwargs)
    assert response.status_code == 200, response.text
    approved = approve(client, interaction, csrf)
    assert approved.status_code == 303, (approved.status_code, approved.text[:200])
    return redirect_params(approved)["code"], verifier


# ---------------------------------------------------------------------------
# Happy path and the identity contract
# ---------------------------------------------------------------------------


def test_full_flow_and_me_shape(oauth_client, clock):
    response, verifier, interaction, csrf = start_authorize(oauth_client)
    assert response.status_code == 200
    assert "https://share.example" in response.text  # issuer shown
    assert "https://share.example/oauth-callback.html" in response.text
    assert "formnovalidate" in response.text
    assert "geolibre-desktop" not in response.text

    # Wrong password re-renders the form and consumes nothing.
    denied = approve(oauth_client, interaction, csrf, password="wrong")
    assert denied.status_code == 200
    assert "Invalid username or password" in denied.text
    assert "name='password'" in denied.text

    approved = approve(oauth_client, interaction, csrf)
    assert approved.status_code == 303
    params = redirect_params(approved)
    assert params["iss"] == "https://share.example"
    assert params["state"] == "s" * 32

    exchanged = exchange_code(oauth_client, params["code"], verifier=verifier)
    assert exchanged.status_code == 200, exchanged.text
    tokens = exchanged.json()
    assert tokens["token_type"] == "Bearer"
    assert tokens["expires_in"] == 600
    assert tokens["scope"] == "read:projects"
    assert tokens["access_token"] and tokens["refresh_token"]

    me = oauth_client.get(
        "/api/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )
    assert me.status_code == 200, me.text
    body = me.json()
    assert body["user"]["username"] == "ada"
    assert body["sessionId"]
    assert body["scopes"] == ["read:projects"]


def test_authorization_html_has_security_headers(oauth_client):
    response, _, interaction, csrf = start_authorize(oauth_client)
    expected = {
        "cache-control": "no-store",
        "pragma": "no-cache",
        "referrer-policy": "origin",
        "x-frame-options": "DENY",
    }
    for header, value in expected.items():
        assert response.headers[header] == value
    assert response.headers["content-security-policy"] == (
        "default-src 'none'; form-action 'self' https://share.example; "
        "frame-ancestors 'none'; base-uri 'none'"
    )

    denied = approve(oauth_client, interaction, csrf, password="wrong")
    assert denied.status_code == 200
    for header, value in expected.items():
        assert denied.headers[header] == value
    assert denied.headers["content-security-policy"] == response.headers["content-security-policy"]


def test_consent_login_mints_no_pat(oauth_client):
    from helpers import ensure_account, exchange_code, redirect_params

    ensure_account(oauth_client)
    with oauth_client.app.state.engine.connect() as connection:
        before = connection.exec_driver_sql("select count(*) from tokens").scalar()
    response, verifier, interaction, csrf = start_authorize(oauth_client)
    approved = approve(oauth_client, interaction, csrf)
    code = redirect_params(approved)["code"]
    assert exchange_code(oauth_client, code, verifier=verifier).status_code == 200
    with oauth_client.app.state.engine.connect() as connection:
        after = connection.exec_driver_sql("select count(*) from tokens").scalar()
    assert before == 1 and after == 1  # the consent login never mints a PAT


def test_no_raw_secrets_are_persisted(oauth_client):
    tokens = sign_in(oauth_client)
    raw = {tokens["access_token"], tokens["refresh_token"]}
    with oauth_client.app.state.engine.connect() as connection:
        access_digests = set(
            connection.exec_driver_sql("select digest from oauth_access_tokens").scalars()
        )
        refresh_digests = set(
            connection.exec_driver_sql("select digest from oauth_refresh_tokens").scalars()
        )
        code_rows = connection.exec_driver_sql(
            "select code_digest, code_challenge, state from oauth_authorization_codes"
        ).fetchall()
    assert raw.isdisjoint(access_digests)
    assert raw.isdisjoint(refresh_digests)
    assert all(row.code_digest for row in code_rows)
    assert all(row.code_challenge for row in code_rows)


# ---------------------------------------------------------------------------
# GET /oauth/authorize validation
# ---------------------------------------------------------------------------


def test_unknown_client_and_redirect_never_get_location(oauth_client):
    query = {
        "response_type": "code",
        "client_id": "unknown",
        "redirect_uri": "https://evil.example/cb",
        "scope": "read:projects",
        "state": "s" * 32,
        "code_challenge": b64url(b"v" * 48).replace("v", "w"),
        "code_challenge_method": "S256",
    }
    response = oauth_client.get("/oauth/authorize", params=query)
    assert response.status_code == 400
    assert "location" not in response.headers
    assert "evil.example" not in response.text

    # Registered client with an unregistered redirect is equally refused.
    response, _, interaction, _ = start_authorize(
        oauth_client, redirect_uri="https://share.example/other.html"
    )
    assert response.status_code == 400
    assert "location" not in response.headers


@pytest.mark.parametrize(
    "mutator, error",
    [
        (lambda q: q | {"response_type": "token"}, "unsupported_response_type"),
        (lambda q: q | {"state": "short"}, "invalid_request"),
        (lambda q: q | {"code_challenge": "short"}, "invalid_request"),
        (lambda q: q | {"code_challenge_method": "plain"}, "invalid_request"),
        (lambda q: q | {"scope": "admin:org"}, "invalid_scope"),
        (lambda q: q | {"scope": "admin:org read:projects"}, "invalid_scope"),
        (lambda q: q | {"scope": "unknown:scope"}, "invalid_scope"),
        (lambda q: q | {"scope": ""}, "invalid_scope"),
        (lambda q: q | {"scope": "manage:sessions read:projects"}, "invalid_scope"),
        (lambda q: q | {"scope": "read:projects read:projects"}, "invalid_scope"),
    ],
)
def test_authorize_rejects_bad_requests_with_redirect_error(oauth_client, mutator, error):
    verifier, challenge = make_verifier_and_challenge()
    query = {
        "response_type": "code",
        "client_id": "geolibre-web",
        "redirect_uri": "https://share.example/oauth-callback.html",
        "scope": "read:projects",
        "state": "s" * 32,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    response = oauth_client.get("/oauth/authorize", params=mutator(query), follow_redirects=False)
    assert response.status_code == 303
    params = redirect_params(response)
    assert params["error"] == error
    assert params["iss"] == "https://share.example"
    assert params["state"] == mutator(query)["state"]
    # The redirect target is always the registered callback, never the attacker.
    assert response.headers["location"].startswith("https://share.example/oauth-callback.html")


def test_oversized_state_never_enters_an_error_redirect(oauth_client):
    response, _, _, _ = start_authorize(
        oauth_client, state="s" * 8192, params_extra={"response_type": "token"}
    )
    assert response.status_code == 400
    assert "location" not in response.headers
    assert "s" * 8192 not in response.text


def test_authorize_rejects_duplicate_security_parameters(oauth_client):
    verifier, challenge = make_verifier_and_challenge()
    base = {
        "response_type": "code",
        "client_id": "geolibre-web",
        "redirect_uri": "https://share.example/oauth-callback.html",
        "scope": "read:projects",
        "state": "s" * 32,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    url = "/oauth/authorize?" + "&".join(f"{k}={v}" for k, v in base.items()) + "&state=dup"
    response = oauth_client.get(url, follow_redirects=False)
    assert response.status_code == 400
    assert "location" not in response.headers


def test_invalid_scope_combination_is_rejected_for_desktop_too(oauth_client):
    response, _, _, _ = start_authorize(
        oauth_client, client_id="geolibre-desktop", scope="manage:sessions read:projects"
    )
    assert response.status_code == 303
    assert redirect_params(response)["error"] == "invalid_scope"


def test_pending_authorizations_are_capped(oauth_client):
    for _ in range(5):
        response, _, _, _ = start_authorize(oauth_client)
        assert response.status_code == 200
    response, _, _, _ = start_authorize(oauth_client)
    assert response.status_code == 429


def test_browser_cookie_survives_parallel_web_and_desktop_flows(oauth_client):
    web, web_verifier, web_interaction, web_csrf = start_authorize(oauth_client)
    assert web.status_code == 200
    assert "__Host-geolibre_oauth_browser=" in web.headers["set-cookie"]
    assert "secure" in web.headers["set-cookie"].lower()
    original_cookie = oauth_client.cookies.get("__Host-geolibre_oauth_browser")

    desktop, desktop_verifier, desktop_interaction, desktop_csrf = start_authorize(
        oauth_client, client_id="geolibre-desktop"
    )
    assert desktop.status_code == 200
    assert oauth_client.cookies.get("__Host-geolibre_oauth_browser") == original_cookie

    web_approval = approve(oauth_client, web_interaction, web_csrf)
    desktop_approval = approve(oauth_client, desktop_interaction, desktop_csrf)
    assert web_approval.status_code == desktop_approval.status_code == 303
    assert (
        exchange_code(
            oauth_client, redirect_params(web_approval)["code"], verifier=web_verifier
        ).status_code
        == 200
    )
    assert (
        exchange_code(
            oauth_client,
            redirect_params(desktop_approval)["code"],
            client_id="geolibre-desktop",
            verifier=desktop_verifier,
        ).status_code
        == 200
    )


def test_loopback_desktop_consent_works_without_https_only_cookie(tmp_path, monkeypatch, clock):
    from conftest import OAUTH_CLIENTS

    issuer = "http://127.0.0.1:8768"
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    app = create_app(
        f"sqlite:///{tmp_path / 'loopback.db'}",
        public_url=issuer,
        storage=FileStorage(str(tmp_path / "objects")),
        clock=clock.now,
    )
    with TestClient(app, base_url=issuer) as client:
        response, verifier, interaction, csrf = start_authorize(
            client, client_id="geolibre-desktop"
        )
        assert response.status_code == 200
        assert "geolibre_oauth_browser=" in response.headers["set-cookie"]
        assert "__Host-" not in response.headers["set-cookie"]
        assert "secure" not in response.headers["set-cookie"].lower()
        approved = approve(client, interaction, csrf, origin=issuer)
        assert approved.status_code == 303
        assert (
            exchange_code(
                client,
                redirect_params(approved)["code"],
                client_id="geolibre-desktop",
                verifier=verifier,
            ).status_code
            == 200
        )


def test_bad_host_is_rejected(oauth_client):
    response = oauth_client.get(
        "/.well-known/oauth-authorization-server", headers={"Host": "other.example"}
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid request host"


# ---------------------------------------------------------------------------
# POST /oauth/authorize (consent)
# ---------------------------------------------------------------------------


def test_consent_requires_origin_and_cookie_and_csrf(oauth_client):
    response, verifier, interaction, csrf = start_authorize(oauth_client)

    # No Origin header -> rejected.
    missing_origin = oauth_client.post(
        "/oauth/authorize",
        data={
            "interaction": interaction,
            "csrf": csrf,
            "label": "x",
            "username": "ada",
            "password": "correct horse",
            "decision": "allow",
        },
        follow_redirects=False,
    )
    assert missing_origin.status_code == 400

    # Cross-origin Origin -> rejected.
    cross = approve(oauth_client, interaction, csrf, origin="https://evil.example")
    assert cross.status_code == 400

    # Wrong CSRF -> rejected.
    tampered = approve(oauth_client, interaction, "x" * 43)
    assert tampered.status_code == 400

    # Fresh client without the browser cookie -> rejected.
    response2, _, interaction2, csrf2 = start_authorize(oauth_client)
    no_cookie = oauth_client.post(
        "/oauth/authorize",
        data={
            "interaction": interaction2,
            "csrf": csrf2,
            "label": "x",
            "username": "ada",
            "password": "correct horse",
            "decision": "allow",
        },
        headers={"Origin": ORIGIN, "Cookie": "none=1"},
        follow_redirects=False,
    )
    assert no_cookie.status_code == 400

    # The first interaction is still usable after all those rejections.
    ok = approve(oauth_client, interaction, csrf)
    assert ok.status_code == 303


def test_cancel_consumes_and_denies(oauth_client):
    code, verifier = _code(oauth_client)
    response, _, interaction, csrf = start_authorize(oauth_client)
    cancelled = approve(oauth_client, interaction, csrf, decision="cancel")
    assert cancelled.status_code == 303
    assert redirect_params(cancelled)["error"] == "access_denied"
    # The cancelled interaction cannot be re-approved.
    re_approved = approve(oauth_client, interaction, csrf)
    assert re_approved.status_code == 400
    # The original grant is untouched.
    me = oauth_client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {sign_in(oauth_client)['access_token']}"},
    )
    assert me.status_code == 200


def test_double_submission_cannot_mint_two_codes(oauth_client):
    response, verifier, interaction, csrf = start_authorize(oauth_client)
    first = approve(oauth_client, interaction, csrf)
    assert first.status_code == 303
    second = approve(oauth_client, interaction, csrf)
    assert second.status_code == 400
    assert "already processed" in second.text
    first_code = redirect_params(first)["code"]
    with oauth_client.app.state.engine.connect() as connection:
        digests = list(
            connection.exec_driver_sql(
                "select code_digest from oauth_authorization_codes where code_digest is not null"
            ).scalars()
        )
    assert hashlib.sha256(first_code.encode()).hexdigest() in digests
    assert len(digests) == 1


def test_label_is_editable_and_replaces_the_request_label(oauth_client):
    response, verifier, _, _ = start_authorize(oauth_client, label="Requested label")
    assert "value='Requested label'" in response.text
    response, verifier2, interaction, csrf = start_authorize(oauth_client, label="Requested label")
    approved = approve(oauth_client, interaction, csrf, label="  Edited label  ")
    assert approved.status_code == 303
    code = redirect_params(approved)["code"]
    assert exchange_code(oauth_client, code, verifier=verifier2).status_code == 200
    with oauth_client.app.state.engine.connect() as connection:
        labels = list(connection.exec_driver_sql("select label from oauth_sessions").scalars())
    assert labels == ["Edited label"]


def test_expired_interaction_is_rejected(oauth_client, clock):
    response, _, interaction, csrf = start_authorize(oauth_client)
    clock.advance(601)
    denied = approve(oauth_client, interaction, csrf)
    assert denied.status_code == 400
    assert "expired" in denied.text


# ---------------------------------------------------------------------------
# POST /oauth/token: code exchange
# ---------------------------------------------------------------------------


def test_exchange_requires_verifier_and_redirect_uri(oauth_client):
    code, verifier = _code(oauth_client)
    assert exchange_code(oauth_client, code).status_code == 400  # no verifier
    assert (
        exchange_code(
            oauth_client, code, verifier=verifier, redirect_uri="https://evil.example/cb"
        ).status_code
        == 400
    )
    # Client binding matters.
    assert (
        exchange_code(
            oauth_client, code, verifier=verifier, client_id="geolibre-desktop"
        ).status_code
        == 400
    )
    # The code is still valid for the correct exchange afterwards.
    assert exchange_code(oauth_client, code, verifier=verifier).status_code == 200


def test_wrong_verifier_is_invalid_grant_without_revoking(oauth_client):
    code, verifier = _code(oauth_client)
    wrong_verifier = make_verifier_and_challenge(b"w")[0]
    rejected = exchange_code(oauth_client, code, verifier=wrong_verifier)
    assert rejected.status_code == 400
    assert rejected.json()["error"] == "invalid_grant"
    # No family to revoke yet, and the code was not consumed.
    assert exchange_code(oauth_client, code, verifier=verifier).status_code == 200


def test_expired_code_is_rejected(oauth_client, clock):
    code, verifier = _code(oauth_client)
    clock.advance(61)
    assert exchange_code(oauth_client, code, verifier=verifier).status_code == 400


def test_authenticated_replay_of_a_code_revokes_the_issued_family(oauth_client):
    code, verifier = _code(oauth_client)
    first = exchange_code(oauth_client, code, verifier=verifier)
    assert first.status_code == 200
    tokens = first.json()
    me = oauth_client.get(
        "/api/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )
    assert me.status_code == 200
    replay = exchange_code(oauth_client, code, verifier=verifier)
    assert replay.status_code == 400
    assert replay.json()["error"] == "invalid_grant"
    # The whole family (access AND refresh) is dead.
    assert (
        oauth_client.get(
            "/api/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
        ).status_code
        == 401
    )
    assert refresh(oauth_client, tokens["refresh_token"]).status_code == 400


def test_token_endpoint_requires_form_urlencoded(oauth_client):
    code, verifier = _code(oauth_client)
    response = oauth_client.post(
        "/oauth/token",
        json={
            "grant_type": "authorization_code",
            "client_id": "geolibre-web",
            "redirect_uri": "https://share.example/oauth-callback.html",
            "code": code,
            "code_verifier": verifier,
        },
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_oauth_post_endpoints_accept_case_insensitive_form_media_type(oauth_client):
    page, verifier, interaction, csrf = start_authorize(oauth_client)
    assert page.status_code == 200 and interaction and csrf
    headers = {"Content-Type": "Application/X-WWW-Form-Urlencoded ; charset=UTF-8"}
    approved = oauth_client.post(
        "/oauth/authorize",
        data={
            "interaction": interaction,
            "csrf": csrf,
            "label": "Test device",
            "username": "ada",
            "password": "correct horse",
            "decision": "allow",
        },
        headers=headers | {"Origin": ORIGIN},
        follow_redirects=False,
    )
    assert approved.status_code == 303

    exchanged = oauth_client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": "geolibre-web",
            "redirect_uri": "https://share.example/oauth-callback.html",
            "code": redirect_params(approved)["code"],
            "code_verifier": verifier,
        },
        headers=headers,
    )
    assert exchanged.status_code == 200
    access_token = exchanged.json()["access_token"]
    revoked = oauth_client.post(
        "/oauth/revoke",
        data={"client_id": "geolibre-web", "token": access_token},
        headers=headers,
    )
    assert revoked.status_code == 200
    assert (
        oauth_client.get(
            "/api/users/me", headers={"Authorization": f"Bearer {access_token}"}
        ).status_code
        == 401
    )


def test_unknown_client_gets_invalid_client(oauth_client):
    response = oauth_client.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": "nope",
            "refresh_token": "x",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_client"


# ---------------------------------------------------------------------------
# Refresh rotation and reuse detection
# ---------------------------------------------------------------------------


def test_refresh_rotation_consumes_and_mints(oauth_client, clock):
    tokens = sign_in(oauth_client)
    access1 = tokens["access_token"]
    clock.advance(601)  # access expires
    assert (
        oauth_client.get(
            "/api/users/me", headers={"Authorization": f"Bearer {access1}"}
        ).status_code
        == 401
    )
    rotated = refresh(oauth_client, tokens["refresh_token"])
    assert rotated.status_code == 200, (rotated.status_code, rotated.text)
    rotated_json = rotated.json()
    assert rotated_json["refresh_token"] != tokens["refresh_token"]
    assert rotated_json["access_token"] != access1
    assert rotated_json["scope"] == "read:projects"
    # The old refresh is consumed: reusing it revokes the family.
    assert refresh(oauth_client, tokens["refresh_token"]).status_code == 400
    assert (
        oauth_client.get(
            "/api/users/me", headers={"Authorization": f"Bearer {rotated_json['access_token']}"}
        ).status_code
        == 401
    )
    assert refresh(oauth_client, rotated_json["refresh_token"]).status_code == 400


def test_consumed_refresh_with_changed_scope_still_revokes_family(oauth_client):
    tokens = sign_in(oauth_client)
    rotated = refresh(oauth_client, tokens["refresh_token"])
    assert rotated.status_code == 200
    successor = rotated.json()

    replay = refresh(oauth_client, tokens["refresh_token"], extra_form={"scope": "write:projects"})
    assert replay.status_code == 400
    assert replay.json()["error"] == "invalid_grant"
    assert (
        oauth_client.get(
            "/api/users/me",
            headers={"Authorization": f"Bearer {successor['access_token']}"},
        ).status_code
        == 401
    )
    assert refresh(oauth_client, successor["refresh_token"]).status_code == 400


def test_refresh_scope_compares_canonical_sets(oauth_client):
    tokens = sign_in(oauth_client, scope="read:projects write:projects")
    mismatched = refresh(
        oauth_client, tokens["refresh_token"], extra_form={"scope": "share:public"}
    )
    assert mismatched.status_code == 400
    assert mismatched.json()["error"] == "invalid_scope"
    # Equivalent order is accepted and preserves the canonical response.
    rotated = refresh(
        oauth_client,
        tokens["refresh_token"],
        extra_form={"scope": "write:projects read:projects"},
    )
    assert rotated.status_code == 200
    assert rotated.json()["scope"] == "read:projects write:projects"


def test_refresh_records_the_new_generation_as_the_successor(oauth_client):
    tokens = sign_in(oauth_client)
    old_digest = hashlib.sha256(tokens["refresh_token"].encode()).hexdigest()
    rotated = refresh(oauth_client, tokens["refresh_token"])
    assert rotated.status_code == 200
    new_digest = hashlib.sha256(rotated.json()["refresh_token"].encode()).hexdigest()
    with oauth_client.app.state.engine.connect() as connection:
        old_successor = connection.exec_driver_sql(
            "select successor_digest from oauth_refresh_tokens where digest = ?",
            (old_digest,),
        ).scalar_one()
        new_successor = connection.exec_driver_sql(
            "select successor_digest from oauth_refresh_tokens where digest = ?",
            (new_digest,),
        ).scalar_one()
    assert old_successor == new_digest
    assert new_successor is None


def test_refresh_expiry_and_access_lifetime_are_anchored_to_family(oauth_client, clock):
    tokens = sign_in(oauth_client)
    clock.advance(30 * 86400 - 100)
    rotated_response = refresh(oauth_client, tokens["refresh_token"])
    assert rotated_response.status_code == 200
    rotated = rotated_response.json()
    assert rotated["expires_in"] == 100
    # Past the absolute family expiry neither token can extend the family.
    clock.advance(101)
    assert refresh(oauth_client, rotated["refresh_token"]).status_code == 400
    assert (
        oauth_client.get(
            "/api/users/me",
            headers={"Authorization": f"Bearer {rotated['access_token']}"},
        ).status_code
        == 401
    )


def test_oauth_operations_cleanup_expired_state_and_keep_active_reuse_history(oauth_client, clock):
    tokens = sign_in(oauth_client)
    rotated = refresh(oauth_client, tokens["refresh_token"])
    assert rotated.status_code == 200
    rotated_tokens = rotated.json()
    _, _, expired_interaction, _ = start_authorize(oauth_client)
    expired_access = hashlib.sha256(tokens["access_token"].encode()).hexdigest()

    clock.advance(601)
    fresh, _, _, _ = start_authorize(oauth_client)
    assert fresh.status_code == 200
    with oauth_client.app.state.engine.connect() as connection:
        assert (
            connection.exec_driver_sql(
                "select count(*) from oauth_authorization_codes where id = ?",
                (expired_interaction,),
            ).scalar()
            == 0
        )
        assert (
            connection.exec_driver_sql(
                "select count(*) from oauth_access_tokens where digest = ?",
                (expired_access,),
            ).scalar()
            == 0
        )
        # The consumed generation remains while its family is active, so reuse
        # can still revoke every descendant.
        assert connection.exec_driver_sql("select count(*) from oauth_refresh_tokens").scalar() == 2

    clock.advance(2_592_001)
    assert refresh(oauth_client, rotated_tokens["refresh_token"]).status_code == 400
    with oauth_client.app.state.engine.connect() as connection:
        for table in (
            "oauth_sessions",
            "oauth_access_tokens",
            "oauth_refresh_tokens",
            "oauth_authorization_codes",
        ):
            assert connection.exec_driver_sql(f"select count(*) from {table}").scalar() == 0


def test_idle_server_periodically_cleans_expired_rows(tmp_path, monkeypatch, clock):
    from conftest import OAUTH_CLIENTS, PUBLIC_URL

    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    monkeypatch.setattr(server_main, "OAUTH_CLEANUP_INTERVAL_SECONDS", 0.01)
    expired_at = clock.now() + 601
    swept = threading.Event()
    original_cleanup = server_main.cleanup_expired_security_rows

    def observe_cleanup(session, now_ts):
        original_cleanup(session, now_ts)
        if now_ts >= expired_at:
            swept.set()

    monkeypatch.setattr(server_main, "cleanup_expired_security_rows", observe_cleanup)
    app = create_app(
        f"sqlite:///{tmp_path / 'idle.db'}",
        storage=FileStorage(str(tmp_path / "objects")),
        public_url=PUBLIC_URL,
        clock=clock.now,
    )
    with TestClient(app, base_url=PUBLIC_URL) as test_client:
        tokens = sign_in(test_client)
        assert refresh(test_client, tokens["refresh_token"]).status_code == 200
        page, _, _, _ = start_authorize(test_client)
        assert page.status_code == 200
        clock.advance(601)
        # No more HTTP requests: only the lifespan task can trigger cleanup.
        assert swept.wait(2), "idle OAuth cleanup did not run"
        with app.state.engine.connect() as connection:
            assert (
                connection.exec_driver_sql("select count(*) from oauth_access_tokens").scalar() == 0
            )
            assert (
                connection.exec_driver_sql(
                    "select count(*) from oauth_authorization_codes where approved_at is null"
                ).scalar()
                == 0
            )
            assert (
                connection.exec_driver_sql("select count(*) from oauth_refresh_tokens").scalar()
                == 2
            )
    app.state.engine.dispose()


def test_wrong_client_cannot_revoke_or_use_a_family(oauth_client):
    tokens = sign_in(oauth_client)
    # Desktop client presenting the web family's refresh: unknown to it.
    assert (
        refresh(oauth_client, tokens["refresh_token"], client_id="geolibre-desktop").status_code
        == 400
    )
    # The family still works for its own client.
    assert refresh(oauth_client, tokens["refresh_token"]).status_code == 200


# ---------------------------------------------------------------------------
# POST /oauth/revoke
# ---------------------------------------------------------------------------


def _revoke(client, token, *, client_id="geolibre-web", hint=None):
    data = {"client_id": client_id, "token": token}
    if hint is not None:
        data["token_type_hint"] = hint
    return client.post(
        "/oauth/revoke",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )


def test_revoke_unknown_token_returns_empty_200(oauth_client):
    response = _revoke(oauth_client, "no-such-token")
    assert response.status_code == 200
    assert response.text == ""


def test_revoke_access_token_kills_the_whole_family(oauth_client):
    tokens = sign_in(oauth_client)
    assert (
        oauth_client.get(
            "/api/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
        ).status_code
        == 200
    )
    assert _revoke(oauth_client, tokens["access_token"]).status_code == 200
    assert (
        oauth_client.get(
            "/api/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
        ).status_code
        == 401
    )
    assert refresh(oauth_client, tokens["refresh_token"]).status_code == 400
    # Idempotent.
    assert _revoke(oauth_client, tokens["refresh_token"]).status_code == 200


def test_revoke_hint_is_advisory(oauth_client):
    tokens = sign_in(oauth_client)
    # Correct hint; wrong hint; both must revoke the same family.
    response = _revoke(oauth_client, tokens["refresh_token"], hint="refresh_token")
    assert response.status_code == 200
    assert (
        oauth_client.get(
            "/api/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
        ).status_code
        == 401
    )
    tokens2 = sign_in(oauth_client)
    assert _revoke(oauth_client, tokens2["access_token"], hint="refresh_token").status_code == 200
    assert refresh(oauth_client, tokens2["refresh_token"]).status_code == 400
    # Unsupported hint value is its own error.
    assert _revoke(oauth_client, "x", hint="identity_token").status_code == 400


def test_wrong_client_revoke_is_a_noop(oauth_client):
    tokens = sign_in(oauth_client)
    assert (
        _revoke(oauth_client, tokens["access_token"], client_id="geolibre-desktop").status_code
        == 200
    )
    assert (
        oauth_client.get(
            "/api/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
        ).status_code
        == 200
    )


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def test_discovery_metadata(oauth_client):
    response = oauth_client.get("/.well-known/oauth-authorization-server")
    assert response.status_code == 200
    metadata = response.json()
    assert metadata["issuer"] == "https://share.example"
    assert metadata["authorization_endpoint"] == "https://share.example/oauth/authorize"
    assert metadata["token_endpoint"] == "https://share.example/oauth/token"
    assert metadata["revocation_endpoint"] == "https://share.example/oauth/revoke"
    assert metadata["response_types_supported"] == ["code"]
    assert metadata["grant_types_supported"] == ["authorization_code", "refresh_token"]
    assert metadata["code_challenge_methods_supported"] == ["S256"]
    assert metadata["authorization_response_iss_parameter_supported"] is True


def test_discovery_supports_a_nested_issuer_path(pathed_client):
    response = pathed_client.get("/.well-known/oauth-authorization-server/services/projects")
    assert response.status_code == 200
    assert response.json()["issuer"] == "https://share.example/services/projects"
    assert (
        response.json()["authorization_endpoint"]
        == "https://share.example/services/projects/oauth/authorize"
    )
    # The bare metadata route does not claim a root issuer that is not this one.
    assert pathed_client.get("/.well-known/oauth-authorization-server").status_code == 404


def test_discovery_is_404_when_oauth_disabled(client):
    response = client.get(
        "/.well-known/oauth-authorization-server", headers={"Host": "share.example"}
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Desktop custom-scheme flow
# ---------------------------------------------------------------------------


def test_desktop_custom_scheme_flow(oauth_client):
    response, verifier, interaction, csrf = start_authorize(
        oauth_client, client_id="geolibre-desktop"
    )
    assert response.status_code == 200
    assert "org.geolibre.desktop:/oauth/callback" in response.text
    approved = approve(oauth_client, interaction, csrf)
    assert approved.status_code == 303
    location = approved.headers["location"]
    assert location.startswith("org.geolibre.desktop:/oauth/callback?")
    code = redirect_params(approved)["code"]
    exchanged = exchange_code(oauth_client, code, client_id="geolibre-desktop", verifier=verifier)
    assert exchanged.status_code == 200, exchanged.text
    assert exchanged.json()["scope"] == "read:projects"
