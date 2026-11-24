"""Built-in request-body ceiling and per-client rate limiting."""

from __future__ import annotations

import pytest
from conftest import PUBLIC_URL
from fastapi.testclient import TestClient
from geolibre_server_api.limits import FixedWindowLimiter, Rate, parse_rate
from geolibre_server_api.main import FileStorage, create_app
from helpers import account, auth


def _client(tmp_path, peer: str = "198.51.100.7") -> TestClient:
    app = create_app(
        f"sqlite:///{tmp_path / 'limits.db'}",
        public_url=PUBLIC_URL,
        storage=FileStorage(str(tmp_path / "objects")),
    )
    return TestClient(app, client=(peer, 50000))


def test_parse_rate(monkeypatch):
    monkeypatch.delenv("X_RATE", raising=False)
    assert parse_rate("X_RATE", "5/60") == Rate(5, 60)
    monkeypatch.setenv("X_RATE", " 10 / 1 ")
    assert parse_rate("X_RATE", "5/60") == Rate(10, 1)
    monkeypatch.setenv("X_RATE", "off")
    assert parse_rate("X_RATE", "5/60") is None
    for bad in ("ten/60", "5", "0/60", "5/0"):
        monkeypatch.setenv("X_RATE", bad)
        with pytest.raises(RuntimeError, match="X_RATE"):
            parse_rate("X_RATE", "5/60")


def test_fixed_window_limiter_resets_and_bounds_memory():
    now = [0.0]
    limiter = FixedWindowLimiter(clock=lambda: now[0], max_keys=3)
    rate = Rate(2, 10)
    assert limiter.hit(("auth", "a"), rate) is None
    assert limiter.hit(("auth", "a"), rate) is None
    assert limiter.hit(("auth", "a"), rate) == pytest.approx(10)
    now[0] = 4.0
    assert limiter.hit(("auth", "a"), rate) == pytest.approx(6)
    now[0] = 10.0
    assert limiter.hit(("auth", "a"), rate) is None
    for client in "bcdef":
        assert limiter.hit(("auth", client), rate) is None
    assert len(limiter._windows) <= 3


def test_auth_routes_are_rate_limited_per_client(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_RATE_LIMIT_AUTH", "3/60")
    with _client(tmp_path) as client:
        for _ in range(3):
            response = client.post("/api/auth/token", json={"username": "x", "password": "y"})
            assert response.status_code != 429
        limited = client.post("/api/auth/token", json={"username": "x", "password": "y"})
        assert limited.status_code == 429
        assert limited.json() == {"error": "too many requests; try again later"}
        assert 1 <= int(limited.headers["retry-after"]) <= 60
        # Other routes use the separate (disabled here) general budget.
        assert client.get("/api/projects").status_code == 200
        assert client.get("/health").status_code == 200


def test_general_rate_limit_and_health_exemption(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_RATE_LIMIT_API", "2/60")
    with _client(tmp_path) as client:
        assert client.get("/api/projects").status_code == 200
        assert client.get("/api/projects").status_code == 200
        assert client.get("/api/projects").status_code == 429
        for _ in range(5):
            assert client.get("/health").status_code == 200


def test_rate_limit_keys_on_forwarded_client_behind_trusted_proxy(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_RATE_LIMIT_API", "1/60")
    monkeypatch.setenv("GEOLIBRE_TRUSTED_PROXIES", "10.0.0.1")
    with _client(tmp_path, peer="10.0.0.1") as client:
        first = client.get("/api/projects", headers={"x-forwarded-for": "203.0.113.1"})
        second = client.get("/api/projects", headers={"x-forwarded-for": "203.0.113.2"})
        repeat = client.get("/api/projects", headers={"x-forwarded-for": "203.0.113.1"})
        assert (first.status_code, second.status_code, repeat.status_code) == (200, 200, 429)


def test_untrusted_peer_cannot_spoof_forwarded_for(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_RATE_LIMIT_API", "1/60")
    with _client(tmp_path) as client:
        first = client.get("/api/projects", headers={"x-forwarded-for": "203.0.113.1"})
        second = client.get("/api/projects", headers={"x-forwarded-for": "203.0.113.2"})
        assert (first.status_code, second.status_code) == (200, 429)


@pytest.mark.parametrize("bucket,path", [("API", "/api/projects"), ("AUTH", "/api/auth/token")])
def test_ipv6_rotating_addresses_share_a_subnet_budget(tmp_path, monkeypatch, bucket, path):
    """Addresses within one IPv6 /64 share limits while other networks remain independent.

    Args:
        tmp_path: Isolated database directory.
        monkeypatch: The pytest patch fixture.
        bucket: The rate-limit configuration bucket.
        path: A request path classified into that bucket.
    """
    monkeypatch.setenv(f"GEOLIBRE_RATE_LIMIT_{bucket}", "1/60")
    monkeypatch.setenv("GEOLIBRE_TRUSTED_PROXIES", "10.0.0.1")
    with _client(tmp_path, peer="10.0.0.1") as client:
        responses = [
            client.get(path, headers={"x-forwarded-for": address}).status_code
            for address in ("2001:db8:1::1", "2001:db8:1::ffff", "2001:db8:2::1")
        ]
        assert responses[0] != 429
        assert responses[1] == 429
        assert responses[2] != 429


def test_streamed_body_without_length_is_cut_off(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_MAX_REQUEST_BYTES", "4096")
    with _client(tmp_path) as client:
        token = account(client)

        def chunks():
            for _ in range(64):
                yield b"x" * 1024

        response = client.post(
            "/api/projects",
            headers={**auth(token), "content-type": "application/json"},
            content=chunks(),
        )
        assert response.status_code == 413
        assert response.json() == {"error": "request body too large"}


def test_declared_length_over_configured_ceiling_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOLIBRE_MAX_REQUEST_BYTES", "4096")
    with _client(tmp_path) as client:
        token = account(client)
        response = client.post(
            "/api/projects",
            headers={**auth(token), "content-type": "application/json"},
            content=b"{" + b" " * 5000 + b"}",
        )
        assert response.status_code == 413
        # Small bodies still go through.
        ok = client.post(
            "/api/projects",
            headers={**auth(token), "content-type": "application/json"},
            content=b"{}",
        )
        assert ok.status_code == 422


def test_eviction_keeps_each_buckets_own_expiry():
    """Short API windows must not reset a still-active authentication budget."""
    now = [0.0]
    limiter = FixedWindowLimiter(clock=lambda: now[0], max_keys=3)
    api_rate, auth_rate = Rate(1, 1), Rate(1, 60)
    for client in ("a", "b"):
        assert limiter.hit(("api", client), api_rate) is None
    now[0] = 1.0
    assert limiter.hit(("auth", "login"), auth_rate) is None
    now[0] = 2.0
    assert limiter.hit(("api", "c"), api_rate) is None
    assert limiter.hit(("auth", "login"), auth_rate) == pytest.approx(59)
    now[0] = 61.0
    assert limiter.hit(("auth", "login"), auth_rate) is None


def test_high_client_churn_amortizes_counter_cleanup(monkeypatch):
    """Many new clients share each cleanup pass instead of scanning on every hit.

    Args:
        monkeypatch: The pytest patch fixture.
    """
    limiter = FixedWindowLimiter(clock=lambda: 0.0, max_keys=100)
    rate = Rate(1, 60)
    for index in range(100):
        limiter.hit(("api", str(index)), rate)
    cleanups = []
    evict = limiter._evict

    def count_cleanup(*args):
        """Record one cleanup pass.

        Args:
            *args: Arguments passed to the limiter's cleanup method.
        """
        cleanups.append(True)
        return evict(*args)

    monkeypatch.setattr(limiter, "_evict", count_cleanup)
    for index in range(100, 120):
        assert limiter.hit(("api", str(index)), rate) is None
        assert len(limiter._windows) <= 100
    assert len(cleanups) <= 2


@pytest.mark.parametrize(
    "path",
    [
        "/api/auth/password-reset/request",
        "/api/auth/password-reset/confirm",
        "/api/auth/verify-email/request",
        "/api/auth/verify-email/confirm",
        "/api/account/mfa/totp",
        "/api/account/mfa/totp/enroll",
        "/api/account/mfa/totp/confirm",
    ],
)
def test_account_lifecycle_uses_credential_budget(tmp_path, monkeypatch, path):
    """Account recovery, mail and MFA use the stricter credential limit.

    Args:
        tmp_path: An isolated database directory.
        monkeypatch: The pytest environment patch fixture.
        path: A credential or email operation.
    """
    monkeypatch.setenv("GEOLIBRE_RATE_LIMIT_AUTH", "1/60")
    with _client(tmp_path) as client:
        assert client.post(path, json={}).status_code != 429
        assert client.post(path, json={}).status_code == 429
        assert client.get("/api/projects").status_code == 200


@pytest.mark.parametrize("trusted_proxy", ["", "198.51.100.7"])
def test_public_rate_limit_warns_without_trusted_proxy(
    tmp_path, monkeypatch, caplog, trusted_proxy
):
    """An enabled public limiter explains how proxy deployments preserve identity.

    Args:
        tmp_path: An isolated database directory.
        monkeypatch: The pytest environment patch fixture.
        caplog: Captured application logs.
        trusted_proxy: The configured trusted peer, or an empty configuration.
    """
    monkeypatch.setenv("GEOLIBRE_RATE_LIMIT_AUTH", "1/60")
    monkeypatch.setenv("GEOLIBRE_TRUSTED_PROXIES", trusted_proxy)
    with _client(tmp_path):
        assert ("configure GEOLIBRE_TRUSTED_PROXIES" in caplog.text) == (not trusted_proxy)


def test_unknown_peer_retains_limit_and_warns_once(tmp_path, monkeypatch, caplog):
    """Missing transport identity cannot disable limits or trust spoofed headers.

    Args:
        tmp_path: An isolated database directory.
        monkeypatch: The pytest environment patch fixture.
        caplog: Captured application logs.
    """
    monkeypatch.setenv("GEOLIBRE_RATE_LIMIT_API", "1/60")
    app = create_app(
        f"sqlite:///{tmp_path / 'unknown.db'}",
        public_url=PUBLIC_URL,
        storage=FileStorage(str(tmp_path / "objects")),
    )
    with TestClient(app, client=None) as client:
        assert (
            client.get("/api/projects", headers={"x-forwarded-for": "203.0.113.1"}).status_code
            == 200
        )
        assert (
            client.get("/api/projects", headers={"x-forwarded-for": "203.0.113.2"}).status_code
            == 429
        )
    assert sum("no client address" in record.message for record in caplog.records) == 1
