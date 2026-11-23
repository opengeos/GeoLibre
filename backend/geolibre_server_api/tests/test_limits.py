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
