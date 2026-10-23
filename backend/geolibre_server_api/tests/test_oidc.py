"""Organization OpenID Connect sign-in: provider admin, consent SSO, and the callback."""

from __future__ import annotations

import json
import logging
import time
from uuid import uuid4

import httpx
import pytest
from conftest import PUBLIC_URL, WEB_REDIRECT
from fake_idp import FakeIdp
from fastapi.testclient import TestClient
from geolibre_server_api import enterprise_admin, oidc
from geolibre_server_api.enterprise_models import FederatedIdentity, OrganizationIdentityProvider
from helpers import (
    account,
    add_member,
    admin_token,
    approve,
    auth,
    configure_idp,
    create_org,
    exchange_code,
    redirect_params,
    sso_sign_in,
    start_authorize,
    start_sso,
)
from joserfc.jwk import OctKey
from sqlalchemy import func, select

REJECTED = "single sign-on response rejected"


def _org_with_idp(client, **overrides) -> tuple[str, str]:
    """ada administers org ``acme`` with the fake provider configured."""
    token = admin_token(client)
    org_id = create_org(client, token)
    response = configure_idp(client, token, org_id, **overrides)
    assert response.status_code == 200, response.text
    return token, org_id


def _signed_in(client, callback, verifier) -> str:
    """Exchange a successful callback's code and return the access token."""
    assert callback.status_code == 303, (callback.status_code, callback.text[:300])
    assert callback.headers["location"].startswith(f"{WEB_REDIRECT}?")
    exchanged = exchange_code(client, redirect_params(callback)["code"], verifier=verifier)
    assert exchanged.status_code == 200, exchanged.text
    return exchanged.json()["access_token"]


def _me(client, token) -> dict:
    response = client.get("/api/users/me", headers=auth(token))
    assert response.status_code == 200, response.text
    return response.json()["user"]


def _assert_rejected(response, caplog=None, reason=None):
    assert response.status_code == 400
    assert REJECTED in response.text
    if reason is not None:
        assert f"oidc sign-in rejected: {reason}" in caplog.text


def test_discovery_stores_endpoints_and_secret_is_never_returned(oauth_client, fake_idp):
    token = admin_token(oauth_client)
    org_id = create_org(oauth_client, token)
    put = configure_idp(oauth_client, token, org_id)
    assert put.status_code == 200, put.text
    assert put.headers["cache-control"] == "private, no-store"
    got = oauth_client.get(f"/api/organizations/{org_id}/identity-provider", headers=auth(token))
    assert got.status_code == 200
    provider = got.json()["identityProvider"]
    assert provider == put.json()["identityProvider"]
    assert provider["authorizationEndpoint"] == f"{FakeIdp.ISSUER}/authorize"
    assert provider["tokenEndpoint"] == f"{FakeIdp.ISSUER}/token"
    assert provider["jwksUri"] == f"{FakeIdp.ISSUER}/jwks"
    assert provider["clientSecretSet"] is True
    assert provider["redirectUri"] == f"{PUBLIC_URL}/oauth/sso/callback"
    assert provider["scopes"] == ["openid", "email", "profile"]

    # An update without clientSecret keeps the stored one: the fake IdP
    # still accepts the server's client authentication afterwards.
    updated = configure_idp(oauth_client, token, org_id, clientSecret=None)
    assert updated.status_code == 200, updated.text
    for response in (put, got, updated):
        assert FakeIdp.CLIENT_SECRET not in response.text
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", fake_idp.base_claims("u1"))
    _signed_in(oauth_client, callback, verifier)


def test_linked_identities_block_issuer_and_jwks_changes(oauth_client, fake_idp):
    token, org_id = _org_with_idp(oauth_client)
    callback, verifier = sso_sign_in(
        oauth_client, fake_idp, "acme", fake_idp.base_claims("stable-subject")
    )
    _signed_in(oauth_client, callback, verifier)

    changed_issuer = configure_idp(
        oauth_client,
        token,
        org_id,
        issuer="https://replacement-idp.example",
        authorizationEndpoint="https://replacement-idp.example/authorize",
        tokenEndpoint="https://replacement-idp.example/token",
        jwksUri="https://replacement-idp.example/jwks",
    )
    assert changed_issuer.status_code == 409

    changed_jwks = configure_idp(
        oauth_client,
        token,
        org_id,
        jwksUri=f"{FakeIdp.ISSUER}/replacement-jwks",
    )
    assert changed_jwks.status_code == 409

    current = oauth_client.get(
        f"/api/organizations/{org_id}/identity-provider",
        headers=auth(token),
    )
    assert current.status_code == 200
    assert current.json()["identityProvider"]["issuer"] == FakeIdp.ISSUER
    assert current.json()["identityProvider"]["jwksUri"] == f"{FakeIdp.ISSUER}/jwks"


def test_sign_in_is_refused_when_the_provider_moves_while_it_validates(
    oauth_client, fake_idp, monkeypatch, caplog
):
    _org_with_idp(oauth_client)
    validate = oidc.validate_id_token

    def validate_then_repoint(session, http, provider, *args, **kwargs):
        claims = validate(session, http, provider, *args, **kwargs)
        # An administrator's PUT commits while the sign-in is still validating:
        # no identity is linked yet, so its guard lets the change through.
        with oauth_client.app.state.session_factory() as admin:
            moved = admin.get(OrganizationIdentityProvider, provider.id)
            moved.jwks_uri = "https://replacement-idp.example/jwks"
            admin.commit()
        return claims

    monkeypatch.setattr(oidc, "validate_id_token", validate_then_repoint)
    callback, _ = sso_sign_in(oauth_client, fake_idp, "acme", fake_idp.base_claims("u1"))
    _assert_rejected(callback, caplog, "identity provider changed during sign-in")
    with oauth_client.app.state.session_factory() as session:
        assert session.scalar(select(func.count()).select_from(FederatedIdentity)) == 0


def test_put_rejects_provider_replaced_during_discovery(oauth_client, monkeypatch):
    token, org_id = _org_with_idp(oauth_client)
    lookup = enterprise_admin._provider_for
    discovery_complete = False

    def finish_discovery(_http, _issuer):
        nonlocal discovery_complete
        discovery_complete = True
        return (
            f"{FakeIdp.ISSUER}/authorize",
            f"{FakeIdp.ISSUER}/token",
            f"{FakeIdp.ISSUER}/jwks",
        )

    def lookup_provider(session, organization_id, *, lock=False):
        provider = lookup(session, organization_id, lock=lock)
        if not lock or not discovery_complete:
            return provider
        replacement = {
            column.name: getattr(provider, column.name)
            for column in OrganizationIdentityProvider.__table__.columns
        }
        session.delete(provider)
        session.flush()
        replacement["id"] = str(uuid4())
        replacement["issuer"] = "https://replacement-idp.example"
        replacement["jwks_uri"] = "https://replacement-idp.example/jwks"
        recreated = OrganizationIdentityProvider(**replacement)
        session.add(recreated)
        session.flush()
        return recreated

    monkeypatch.setattr(enterprise_admin, "discover_endpoints", finish_discovery)
    monkeypatch.setattr(enterprise_admin, "_provider_for", lookup_provider)
    response = configure_idp(oauth_client, token, org_id)

    assert response.status_code == 409
    assert response.json()["error"] == "identity provider was removed or replaced; try again"
    current = oauth_client.get(
        f"/api/organizations/{org_id}/identity-provider",
        headers=auth(token),
    )
    assert current.status_code == 200
    assert current.json()["identityProvider"]["issuer"] == FakeIdp.ISSUER


def test_identity_provider_validation(oauth_client):
    token = admin_token(oauth_client)
    org_id = create_org(oauth_client, token)

    def put(**overrides):
        return configure_idp(oauth_client, token, org_id, **overrides)

    http_issuer = put(issuer="http://idp.example")
    assert http_issuer.status_code == 422
    assert http_issuer.json() == {"error": "issuer must be an https URL without query or fragment"}
    partial = put(
        authorizationEndpoint=f"{FakeIdp.ISSUER}/authorize",
        tokenEndpoint=f"{FakeIdp.ISSUER}/token",
    )
    assert partial.status_code == 422
    assert partial.json() == {"error": "set all three endpoints or none"}
    undiscoverable = put(issuer="https://elsewhere.example")
    assert undiscoverable.status_code == 422
    assert undiscoverable.json() == {"error": "identity provider discovery failed"}
    no_secret = put(clientSecret=None)
    assert no_secret.status_code == 422
    assert no_secret.json() == {"error": "clientSecret is required"}

    no_break_glass = put(allowBuiltinAccounts=False)
    assert no_break_glass.status_code == 422
    assert no_break_glass.json() == {
        "error": "a break-glass administrator is required when built-in accounts are disallowed"
    }
    add_member(oauth_client, token, org_id, "bob")
    not_admin = put(allowBuiltinAccounts=False, breakGlassUsername="bob")
    assert not_admin.status_code == 422
    assert not_admin.json() == {
        "error": "break-glass account must be an organization administrator"
    }

    other_org = create_org(oauth_client, token, slug="other", name="Other")
    foreign = oauth_client.post(
        "/api/groups", json={"name": "Foreign", "organizationId": other_org}, headers=auth(token)
    )
    assert foreign.status_code == 201, foreign.text
    mapped = put(groupMappings=[{"value": "x", "groupId": foreign.json()["group"]["id"]}])
    assert mapped.status_code == 422
    assert mapped.json() == {"error": "group mapping must name a group in this organization"}

    member_token = admin_token(oauth_client, username="bob")
    assert configure_idp(oauth_client, member_token, org_id).status_code == 403
    missing = oauth_client.get(
        f"/api/organizations/{org_id}/identity-provider", headers=auth(token)
    )
    assert missing.status_code == 404
    assert missing.json() == {"error": "identity provider not configured"}


class _Trickle(httpx.SyncByteStream):
    """A body sent in two halves with a pause between them."""

    def __init__(self, body: bytes, pause: float):
        self.body = body
        self.pause = pause

    def __iter__(self):
        half = len(self.body) // 2
        yield self.body[:half]
        time.sleep(self.pause)
        yield self.body[half:]


def test_discovery_fails_past_the_total_deadline(oauth_client, fake_idp, monkeypatch):
    def trickling(request: httpx.Request) -> httpx.Response:
        response = fake_idp.handle(request)
        return httpx.Response(response.status_code, stream=_Trickle(response.read(), 0.2))

    http = oidc.build_http_client(httpx.MockTransport(trickling))
    monkeypatch.setattr(oauth_client.app.state, "oidc_http", http)
    token = admin_token(oauth_client)
    org_id = create_org(oauth_client, token)

    # Every read is fast; only the whole response is too slow.
    monkeypatch.setattr(oidc, "FETCH_DEADLINE_SECONDS", 0.1)
    late = configure_idp(oauth_client, token, org_id)
    assert late.status_code == 422
    assert late.json() == {"error": "identity provider discovery failed"}
    monkeypatch.setattr(oidc, "FETCH_DEADLINE_SECONDS", 10.0)
    assert configure_idp(oauth_client, token, org_id).status_code == 200


def test_sso_flow_maps_roles_and_groups(oauth_client, fake_idp):
    token = admin_token(oauth_client)
    org_id = create_org(oauth_client, token)
    group = oauth_client.post(
        "/api/groups", json={"name": "GIS", "organizationId": org_id}, headers=auth(token)
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["group"]["id"]
    configured = configure_idp(
        oauth_client,
        token,
        org_id,
        roleMappings=[{"value": "gis-admins", "role": "publisher"}],
        groupMappings=[{"value": "gis-admins", "groupId": group_id}],
    )
    assert configured.status_code == 200, configured.text

    claims = fake_idp.base_claims("u1", preferred_username="grace", groups=["gis-admins"])
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    first = _signed_in(oauth_client, callback, verifier)
    user = _me(oauth_client, first)
    assert user["username"] == "grace"
    orgs = oauth_client.get("/api/organizations/mine", headers=auth(first)).json()
    assert [(org["slug"], org["role"]) for org in orgs["organizations"]] == [("acme", "publisher")]
    groups = oauth_client.get("/api/groups/mine", headers=auth(first)).json()["groups"]
    assert group_id in {item["id"] for item in groups}

    claims = fake_idp.base_claims("u1", preferred_username="grace", groups=[])
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    second = _signed_in(oauth_client, callback, verifier)
    assert _me(oauth_client, second)["id"] == user["id"]
    orgs = oauth_client.get("/api/organizations/mine", headers=auth(second)).json()
    assert [(org["slug"], org["role"]) for org in orgs["organizations"]] == [("acme", "member")]
    groups = oauth_client.get("/api/groups/mine", headers=auth(second)).json()["groups"]
    assert group_id not in {item["id"] for item in groups}


def test_unknown_organization_rerenders_consent(oauth_client):
    _org_with_idp(oauth_client)
    _, _, interaction, csrf = start_authorize(oauth_client)
    page = oauth_client.post(
        "/oauth/authorize",
        data={
            "interaction": interaction,
            "csrf": csrf,
            "label": "Test device",
            "decision": "sso",
            "organization": "nope",
        },
        headers={"Origin": PUBLIC_URL},
        follow_redirects=False,
    )
    assert page.status_code == 200
    assert "Single sign-on is not configured for that organization" in page.text


@pytest.mark.parametrize(
    "case, reason",
    [
        ("wrong_nonce", "nonce"),
        ("wrong_audience", "audience"),
        ("foreign_azp", "authorized party"),
        ("expired", "expired"),
        ("hs256", "signature"),
    ],
)
def test_invalid_id_tokens_are_rejected(oauth_client, fake_idp, caplog, case, reason):
    _org_with_idp(oauth_client)
    claims = fake_idp.base_claims("u1")
    if case == "wrong_nonce":
        fake_idp.next_id_token = lambda issued: fake_idp.sign({**issued, "nonce": "wrong"})
    elif case == "wrong_audience":
        claims["aud"] = "someone-else"
    elif case == "foreign_azp":
        # A single audience still pins a present azp to this client.
        claims["azp"] = "someone-else"
    elif case == "expired":
        claims["exp"] = fake_idp.now() - 61
    elif case == "hs256":
        # Algorithm confusion: an HMAC token under the RSA key's kid.
        secret = OctKey.import_key(b"x" * 32)
        fake_idp.next_id_token = lambda issued: fake_idp.sign(
            issued, alg="HS256", key=secret, kid="k1"
        )
    with caplog.at_level(logging.WARNING, logger="geolibre_server_api.oidc"):
        callback, _ = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    _assert_rejected(callback, caplog, reason)


def test_mfa_required_rejects_tokens_without_amr(oauth_client, fake_idp, caplog):
    _org_with_idp(oauth_client, requireMfa=True)
    with caplog.at_level(logging.WARNING, logger="geolibre_server_api.oidc"):
        callback, _ = sso_sign_in(oauth_client, fake_idp, "acme", fake_idp.base_claims("u1"))
    _assert_rejected(callback, caplog, "mfa required")
    claims = fake_idp.base_claims("u1", amr=["pwd", "mfa"])
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    _signed_in(oauth_client, callback, verifier)


def test_state_is_single_use_and_must_be_known(oauth_client, fake_idp):
    _org_with_idp(oauth_client)
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", fake_idp.base_claims("u1"))
    _signed_in(oauth_client, callback, verifier)
    replayed = oauth_client.get(str(callback.request.url), follow_redirects=False)
    _assert_rejected(replayed)
    unknown = oauth_client.get(
        "/oauth/sso/callback", params={"code": "c-x", "state": "unknown"}, follow_redirects=False
    )
    _assert_rejected(unknown)


def test_callback_requires_the_browser_that_started_consent(oauth_client, fake_idp):
    _org_with_idp(oauth_client)
    verifier, params, _ = start_sso(oauth_client, "acme")
    fake_idp.issue(
        "c-1", fake_idp.base_claims("u1", nonce=params["nonce"]), params["code_challenge"]
    )
    query = {"code": "c-1", "state": params["state"]}
    with TestClient(oauth_client.app, base_url=PUBLIC_URL) as other_browser:
        stolen = other_browser.get("/oauth/sso/callback", params=query, follow_redirects=False)
    _assert_rejected(stolen)
    callback = oauth_client.get("/oauth/sso/callback", params=query, follow_redirects=False)
    _signed_in(oauth_client, callback, verifier)


def test_rotated_signing_key_is_refetched_once(oauth_client, fake_idp, clock):
    _org_with_idp(oauth_client)
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", fake_idp.base_claims("u1"))
    _signed_in(oauth_client, callback, verifier)
    assert fake_idp.jwks_calls == 1

    fake_idp.rotate("k2")
    # Within a minute of the last fetch an unknown kid does not refetch.
    callback, _ = sso_sign_in(oauth_client, fake_idp, "acme", fake_idp.base_claims("u1"))
    _assert_rejected(callback)
    assert fake_idp.jwks_calls == 1

    clock.advance(61)
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", fake_idp.base_claims("u1"))
    _signed_in(oauth_client, callback, verifier)
    assert fake_idp.jwks_calls == 2


def test_sso_never_takes_an_existing_email(oauth_client, fake_idp):
    account(oauth_client, "carol", email="x@example.org")
    _org_with_idp(oauth_client)
    claims = fake_idp.base_claims(
        "u2", preferred_username="xavier", email="x@example.org", email_verified=True
    )
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    user = _me(oauth_client, _signed_in(oauth_client, callback, verifier))
    assert user["email"] is None
    assert user["username"] == "xavier"

    claims = fake_idp.base_claims("u3", email="y@example.org", email_verified=True)
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    assert _me(oauth_client, _signed_in(oauth_client, callback, verifier))["email"] == (
        "y@example.org"
    )


def test_builtin_accounts_disallowed_except_break_glass(oauth_client):
    token = admin_token(oauth_client)
    org_id = create_org(oauth_client, token)
    add_member(oauth_client, token, org_id, "bob")
    configured = configure_idp(
        oauth_client, token, org_id, allowBuiltinAccounts=False, breakGlassUsername="ada"
    )
    assert configured.status_code == 200, configured.text
    assert configured.json()["identityProvider"]["breakGlassUsername"] == "ada"

    credentials = {"username": "bob", "password": "correct horse"}
    blocked = oauth_client.post("/api/auth/token", json=credentials)
    assert blocked.status_code == 403
    assert blocked.json() == {"error": "single sign-on required"}
    change = oauth_client.post(
        "/api/account/password",
        json={"username": "bob", "currentPassword": "correct horse", "newPassword": "Another1!"},
    )
    assert change.status_code == 403
    assert change.json() == {"error": "single sign-on required"}

    _, _, interaction, csrf = start_authorize(oauth_client)
    page = approve(oauth_client, interaction, csrf, username="bob")
    assert page.status_code == 200
    assert "Your organization requires single sign-on." in page.text
    assert "Sign in with your organization" in page.text

    allowed = oauth_client.post(
        "/api/auth/token", json={"username": "ada", "password": "correct horse"}
    )
    assert allowed.status_code == 200


def test_consent_csp_allows_the_idp_redirect_only_when_sso_is_enabled(oauth_client):
    token, org_id = _org_with_idp(oauth_client)
    page, *_ = start_authorize(oauth_client)
    assert page.headers["content-security-policy"] == (
        "default-src 'none'; form-action 'self' https://share.example https:; "
        "frame-ancestors 'none'; base-uri 'none'"
    )
    assert "name='organization'" in page.text

    disabled = configure_idp(oauth_client, token, org_id, enabled=False)
    assert disabled.status_code == 200
    page, *_ = start_authorize(oauth_client)
    assert "https:;" not in page.headers["content-security-policy"]
    assert "name='organization'" not in page.text


def test_delete_identity_provider_cascades_federated_identities(oauth_client, fake_idp):
    token, org_id = _org_with_idp(oauth_client)
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", fake_idp.base_claims("u1"))
    _signed_in(oauth_client, callback, verifier)

    url = f"/api/organizations/{org_id}/identity-provider"
    for _ in range(2):
        assert oauth_client.delete(url, headers=auth(token)).status_code == 204
    assert oauth_client.get(url, headers=auth(token)).status_code == 404
    with oauth_client.app.state.session_factory() as session:
        count = session.scalar(select(func.count()).select_from(FederatedIdentity))
    assert count == 0


def test_idp_error_returns_access_denied_to_the_client(oauth_client):
    _org_with_idp(oauth_client)
    _, params, _ = start_sso(oauth_client, "acme")
    response = oauth_client.get(
        "/oauth/sso/callback",
        params={"error": "access_denied", "state": params["state"]},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert response.headers["location"].startswith(f"{WEB_REDIRECT}?")
    assert redirect_params(response)["error"] == "access_denied"


def test_sso_role_drop_unpublishes_public_projects(oauth_client, fake_idp):
    token, org_id = _org_with_idp(
        oauth_client, roleMappings=[{"value": "gis-admins", "role": "publisher"}]
    )
    policy = oauth_client.patch(
        f"/api/organizations/{org_id}",
        json={"publicSharingPolicy": "publishers"},
        headers=auth(token),
    )
    assert policy.status_code == 200, policy.text
    scope = "read:projects write:projects share:public"
    claims = fake_idp.base_claims("u1", preferred_username="grace", groups=["gis-admins"])
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims, scope=scope)
    publisher = _signed_in(oauth_client, callback, verifier)
    created = oauth_client.post(
        "/api/projects",
        headers=auth(publisher),
        json={
            "filename": "wetlands.geolibre.json",
            "content": json.dumps({"version": "1.0", "title": "Wetlands", "layers": []}),
            "visibility": "public",
            "organizationId": org_id,
        },
    )
    assert created.status_code == 201, created.text
    project_id = created.json()["project"]["id"]

    claims = fake_idp.base_claims("u1", preferred_username="grace", groups=[])
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    _signed_in(oauth_client, callback, verifier)
    project = oauth_client.get(f"/api/projects/{project_id}", headers=auth(token))
    assert project.status_code == 200, project.text
    assert project.json()["project"]["visibility"] == "organization"


def test_break_glass_administrator_cannot_be_demoted_or_removed(oauth_client):
    token = admin_token(oauth_client)
    org_id = create_org(oauth_client, token)
    add_member(oauth_client, token, org_id, "bob", role="administrator")
    configured = configure_idp(oauth_client, token, org_id, breakGlassUsername="ada")
    assert configured.status_code == 200, configured.text
    bob = admin_token(oauth_client, username="bob")
    members = f"/api/organizations/{org_id}/members"
    refused = {"error": "account is the organization's break-glass administrator"}

    demoted = oauth_client.put(
        members, json={"username": "ada", "role": "member"}, headers=auth(bob)
    )
    assert (demoted.status_code, demoted.json()) == (422, refused)
    removed = oauth_client.delete(f"{members}/ada", headers=auth(bob))
    assert (removed.status_code, removed.json()) == (422, refused)
    left = oauth_client.delete(f"{members}/me", headers=auth(token))
    assert (left.status_code, left.json()) == (422, refused)

    # Clearing the break-glass account on the provider is the way out.
    cleared = configure_idp(oauth_client, token, org_id)
    assert cleared.status_code == 200, cleared.text
    demoted = oauth_client.put(
        members, json={"username": "ada", "role": "member"}, headers=auth(bob)
    )
    assert demoted.status_code == 200, demoted.text


def test_sso_mapping_keeps_the_break_glass_administrator(oauth_client, fake_idp):
    admins = [{"value": "gis-admins", "role": "administrator"}]
    token, org_id = _org_with_idp(oauth_client, roleMappings=admins)
    claims = fake_idp.base_claims("u1", preferred_username="grace", groups=["gis-admins"])
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    _signed_in(oauth_client, callback, verifier)
    configured = configure_idp(
        oauth_client, token, org_id, roleMappings=admins, breakGlassUsername="grace"
    )
    assert configured.status_code == 200, configured.text

    # ada is still an administrator, so only the break-glass rule keeps grace's role.
    claims = fake_idp.base_claims("u1", preferred_username="grace", groups=[])
    callback, verifier = sso_sign_in(oauth_client, fake_idp, "acme", claims)
    grace = _signed_in(oauth_client, callback, verifier)
    orgs = oauth_client.get("/api/organizations/mine", headers=auth(grace)).json()
    assert [(org["slug"], org["role"]) for org in orgs["organizations"]] == [
        ("acme", "administrator")
    ]
