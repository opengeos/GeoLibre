"""Shared fixtures for the projects-and-identity API test suite."""

from __future__ import annotations

import json

import pytest
from fake_idp import FakeIdp
from fastapi.testclient import TestClient
from geolibre_server_api.main import FileStorage, create_app

PUBLIC_URL = "https://share.example"
WEB_REDIRECT = f"{PUBLIC_URL}/oauth-callback.html"
DESKTOP_REDIRECT = "org.geolibre.desktop:/oauth/callback"

OAUTH_CLIENTS = [
    {
        "client_id": "geolibre-web",
        "name": "GeoLibre Web",
        "redirect_uris": [WEB_REDIRECT],
        "scopes": ["read:projects", "write:projects", "share:public", "manage:sessions"],
    },
    {
        "client_id": "geolibre-desktop",
        "name": "GeoLibre Desktop",
        "redirect_uris": [DESKTOP_REDIRECT],
        "scopes": ["read:projects", "write:projects", "share:public", "manage:sessions"],
    },
]


class TestClock:
    """Mutable wall clock for deterministic credential expiry tests."""

    def __init__(self, start: int = 1_700_000_000):
        self.now_ts = start

    def now(self) -> int:
        return self.now_ts

    def advance(self, seconds: int) -> None:
        self.now_ts += seconds


@pytest.fixture
def clock() -> TestClock:
    return TestClock()


@pytest.fixture
def fake_idp(clock) -> FakeIdp:
    """The organization identity provider every app fixture talks to instead of the network."""
    return FakeIdp(clock)


@pytest.fixture
def fake_idp_realtime() -> FakeIdp:
    """A fake identity provider on the wall clock, for apps without an injected clock."""
    return FakeIdp(clock=None)


def _make_app(tmp_path, public_url: str, clock=None, oidc_transport=None):
    return create_app(
        f"sqlite:///{tmp_path / 'test.db'}",
        public_url=public_url,
        storage=FileStorage(str(tmp_path / "objects")),
        clock=clock,
        oidc_transport=oidc_transport,
    )


@pytest.fixture
def client(tmp_path, monkeypatch, clock, fake_idp):
    """Legacy environment: OAuth disabled and PAT behavior unchanged."""
    monkeypatch.delenv("GEOLIBRE_OAUTH_CLIENTS", raising=False)
    app = _make_app(tmp_path, PUBLIC_URL, clock=clock.now, oidc_transport=fake_idp.transport)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def oauth_client(tmp_path, monkeypatch, clock, fake_idp):
    """OAuth-enabled client speaking the canonical issuer origin."""
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    app = _make_app(tmp_path, PUBLIC_URL, clock=clock.now, oidc_transport=fake_idp.transport)
    with TestClient(app, base_url=PUBLIC_URL) as test_client:
        yield test_client


@pytest.fixture
def pathed_client(tmp_path, monkeypatch, clock, fake_idp):
    """OAuth enabled under a multi-segment issuer path."""
    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    app = _make_app(
        tmp_path,
        f"{PUBLIC_URL}/services/projects",
        clock=clock.now,
        oidc_transport=fake_idp.transport,
    )
    with TestClient(app, base_url=PUBLIC_URL) as test_client:
        yield test_client


@pytest.fixture
def postgres_url():
    """Return the disposable PostgreSQL DSN required by the concurrency gate."""
    import os

    url = os.getenv("GEOLIBRE_TEST_POSTGRES_URL")
    if not url:
        pytest.fail(
            "GEOLIBRE_TEST_POSTGRES_URL is required for postgres-marked tests "
            "(see backend/geolibre_server_api/tests/conftest.py)"
        )
    return url


@pytest.fixture
def postgres_app(tmp_path, postgres_url, monkeypatch, fake_idp_realtime):
    """Create the OAuth-enabled API in a unique disposable PostgreSQL schema."""
    import uuid

    from sqlalchemy import create_engine, text

    monkeypatch.setenv("GEOLIBRE_OAUTH_CLIENTS", json.dumps(OAUTH_CLIENTS))
    schema = f"geolibre_test_{uuid.uuid4().hex[:12]}"
    admin = create_engine(postgres_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    app = None
    try:
        option = f"-csearch_path={schema},public"
        quoted = option.replace("=", "%3D").replace(",", "%2C")
        separator = "&" if "?" in postgres_url else "?"
        app = create_app(
            f"{postgres_url}{separator}options={quoted}",
            public_url=PUBLIC_URL,
            storage=FileStorage(str(tmp_path / "objects")),
            oidc_transport=fake_idp_realtime.transport,
        )
        yield app
    finally:
        if app is not None:
            app.state.engine.dispose()
        with admin.connect() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
