"""Single sign-on against a real OpenID Connect server (the CI interop job).

Runs only under ``python -m pytest -m oidc_interop`` with
``GEOLIBRE_TEST_OIDC_ISSUER`` naming a running mock-oauth2-server issuer
configured from ``tests/interop/mock-oauth2-config.json``, and
``GEOLIBRE_OIDC_CA_BUNDLE`` trusting its certificate. Discovery, JWKS, and the
back-channel code exchange use the server's real HTTP client over TLS.
"""

from __future__ import annotations

import json
import os
import ssl
from urllib.parse import parse_qsl, urlparse

import httpx
import pytest
from conftest import OAUTH_CLIENTS, PUBLIC_URL, WEB_REDIRECT
from fastapi.testclient import TestClient
from geolibre_server_api.main import FileStorage, create_app
from helpers import (
    admin_token,
    auth,
    configure_idp,
    create_org,
    exchange_code,
    redirect_params,
    start_sso,
)

pytestmark = pytest.mark.oidc_interop


@pytest.fixture
def interop_client(tmp_path, monkeypatch):
    issuer = os.getenv("GEOLIBRE_TEST_OIDC_ISSUER")
    if not issuer:
        pytest.fail("GEOLIBRE_TEST_OIDC_ISSUER is required for oidc_interop-marked tests")
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    app = create_app(
        f"sqlite:///{tmp_path / 'test.db'}",
        public_url=PUBLIC_URL,
        storage=FileStorage(str(tmp_path / "objects")),
    )
    try:
        with TestClient(app, base_url=PUBLIC_URL) as client:
            yield client, issuer
    finally:
        app.state.engine.dispose()


def test_sso_against_a_real_identity_provider(interop_client):
    client, issuer = interop_client
    token = admin_token(client)
    org_id = create_org(client, token)
    configured = configure_idp(
        client,
        token,
        org_id,
        issuer=issuer,
        clientId="geolibre-interop",
        clientSecret="interop-secret",
        requireMfa=True,
        roleMappings=[{"value": "gis-admins", "role": "publisher"}],
    )
    assert configured.status_code == 200, configured.text
    provider = configured.json()["identityProvider"]

    verifier, _, location = start_sso(
        client, "acme", authorization_endpoint=provider["authorizationEndpoint"]
    )
    cafile = os.environ["GEOLIBRE_OIDC_CA_BUNDLE"]
    idp_response = httpx.get(
        location, verify=ssl.create_default_context(cafile=cafile), follow_redirects=False
    )
    assert idp_response.status_code == 302, idp_response.text
    returned = urlparse(idp_response.headers["location"])
    assert f"{returned.scheme}://{returned.netloc}{returned.path}" == (
        f"{PUBLIC_URL}/oauth/sso/callback"
    )

    callback = client.get(
        "/oauth/sso/callback", params=parse_qsl(returned.query), follow_redirects=False
    )
    assert callback.status_code == 303, callback.text
    assert callback.headers["location"].startswith(f"{WEB_REDIRECT}?")
    exchanged = exchange_code(client, redirect_params(callback)["code"], verifier=verifier)
    assert exchanged.status_code == 200, exchanged.text
    access = exchanged.json()["access_token"]

    orgs = client.get("/api/organizations/mine", headers=auth(access)).json()["organizations"]
    assert [(org["slug"], org["role"]) for org in orgs] == [("acme", "publisher")]
    me = client.get("/api/users/me", headers=auth(access)).json()["user"]
    assert me["email"] == "interop@example.org"
    assert me["username"] == "interop-user"
