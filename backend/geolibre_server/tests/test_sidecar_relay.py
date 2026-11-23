"""Tests for the Live MCP relay hosted on the sidecar (``app/relay.py``)."""

from __future__ import annotations

import json
import os
import stat
import threading

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from geolibre_server import relay_protocol
from geolibre_server.app import main, relay

SIDECAR_TOKEN = "sidecar-secret"


@pytest.fixture
def enabled(monkeypatch, tmp_path):
    """Enable the relay with a sidecar token and an isolated discovery file."""
    monkeypatch.setenv(relay.PORT_ENV, "8765")
    monkeypatch.setenv(relay.DISCOVERY_FILE_ENV, str(tmp_path / "runtime" / "live-relay.json"))
    monkeypatch.setattr(main, "SIDECAR_TOKEN", SIDECAR_TOKEN)
    monkeypatch.setattr(main, "_SIDECAR_TOKEN_BYTES", SIDECAR_TOKEN.encode())
    monkeypatch.setattr(relay, "_hub", relay._Hub())
    return tmp_path


@pytest.fixture
def client(enabled):
    """A client whose requests share one event loop (and run the lifespan).

    A bare ``TestClient`` gives each request its own portal and loop, so a POST
    waiting on a socket opened in another loop would never be resolved.
    """
    with TestClient(main.app) as shared:
        yield shared


def _client_headers(token: str | None = None) -> dict[str, str]:
    return {"Authorization": f"token {token or relay.relay_token()}"}


def test_relay_is_disabled_without_the_port_env(monkeypatch):
    monkeypatch.delenv(relay.PORT_ENV, raising=False)
    client = TestClient(main.app)
    assert client.get("/relay/status", headers=_client_headers()).status_code == 404
    assert relay.write_discovery_file() is None


def test_relay_is_disabled_in_multi_tenant_mode(enabled, monkeypatch):
    monkeypatch.setattr(relay, "is_multi_tenant_enabled", lambda: True)
    assert relay.relay_enabled() is False


def test_client_endpoints_take_the_relay_token_not_the_sidecar_token(client):
    assert client.get("/relay/status").status_code == 401
    assert client.get("/relay/status", headers=_client_headers("wrong")).status_code == 401
    # The sidecar token is not a relay credential.
    assert (
        client.get("/relay/status", headers={"X-GeoLibre-Token": SIDECAR_TOKEN}).status_code == 401
    )
    response = client.get("/relay/status", headers=_client_headers())
    assert response.status_code == 200
    assert response.json() == {"listeners": 0}
    bearer = {"Authorization": f"Bearer {relay.relay_token()}"}
    assert client.get("/relay/status", headers=bearer).status_code == 200


def test_the_relay_token_does_not_open_other_sidecar_routes(client):
    assert client.get("/algorithms", headers=_client_headers()).status_code == 401


def test_socket_requires_the_sidecar_token_and_an_app_origin(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/relay/socket?token=wrong") as socket:
            socket.receive_text()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            f"/relay/socket?token={SIDECAR_TOKEN}",
            headers={"Origin": "https://evil.example"},
        ) as socket:
            socket.receive_text()
    with client.websocket_connect(
        f"/relay/socket?token={SIDECAR_TOKEN}", headers={"Origin": "tauri://localhost"}
    ) as socket:
        assert json.loads(socket.receive_text()) == {"type": "geolibre:relay-ready"}
        status = client.get("/relay/status", headers=_client_headers()).json()
        assert status == {"listeners": 1}


def _post_in_thread(client: TestClient, body: dict) -> tuple[threading.Thread, dict]:
    outcome: dict = {}

    def run() -> None:
        response = client.post("/relay/command", json=body, headers=_client_headers())
        outcome["status"] = response.status_code
        outcome["body"] = response.json()

    thread = threading.Thread(target=run)
    thread.start()
    return thread, outcome


def test_correlated_command_round_trips_through_the_app_socket(client):
    with client.websocket_connect(f"/relay/socket?token={SIDECAR_TOKEN}") as socket:
        socket.receive_text()  # ready greeting
        thread, outcome = _post_in_thread(
            client,
            {"requestId": "caller-1", "method": "runAlgorithm", "params": {"id": "buffer"}},
        )
        command = json.loads(socket.receive_text())
        assert command["type"] == "geolibre:command"
        assert command["method"] == "runAlgorithm"
        assert command["params"] == {"id": "buffer"}
        # A server-side dispatch id, never the caller's, and no timeout field.
        assert command["requestId"] != "caller-1"
        assert "timeoutSeconds" not in command
        socket.send_text(
            json.dumps(
                {
                    "type": "geolibre:result",
                    "requestId": command["requestId"],
                    "ok": True,
                    "value": {"resultLayerIds": ["l1"]},
                }
            )
        )
        thread.join(5)
    assert outcome["status"] == 200
    assert outcome["body"] == {
        "delivered": 1,
        "requestId": "caller-1",
        "ok": True,
        "value": {"resultLayerIds": ["l1"]},
    }


def test_a_caller_timeout_answers_504(client):
    with client.websocket_connect(f"/relay/socket?token={SIDECAR_TOKEN}") as socket:
        socket.receive_text()
        thread, outcome = _post_in_thread(
            client,
            {"requestId": "slow", "method": "getView", "timeoutSeconds": 0.5},
        )
        socket.receive_text()  # the command; never answered
        thread.join(5)
    assert outcome["status"] == 504


def test_fire_and_forget_and_no_listener(client):
    response = client.post(
        "/relay/command",
        json={"requestId": "x", "method": "getView"},
        headers=_client_headers(),
    )
    assert response.json() == {"delivered": 0}
    with client.websocket_connect(f"/relay/socket?token={SIDECAR_TOKEN}") as socket:
        socket.receive_text()
        response = client.post(
            "/relay/command", json={"method": "flyTo"}, headers=_client_headers()
        )
        assert response.json() == {"delivered": 1}
        assert json.loads(socket.receive_text())["method"] == "flyTo"


def test_malformed_command_is_a_400(client):
    response = client.post("/relay/command", json={"params": {}}, headers=_client_headers())
    assert response.status_code == 400


def test_discovery_file_is_private_and_removed_by_its_writer(enabled):
    path = relay.write_discovery_file()
    assert path is not None
    info = json.loads(path.read_text())
    assert info == {
        "kind": "sidecar",
        "url": "http://127.0.0.1:8765/relay",
        "token": relay.relay_token(),
        "pid": os.getpid(),
    }
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    relay.remove_discovery_file()
    assert not path.exists()


def test_discovery_file_from_another_process_is_left_alone(enabled):
    path = relay.discovery_file()
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"pid": os.getpid() + 1}))
    relay.remove_discovery_file()
    assert path.exists()


def test_lifespan_writes_and_removes_the_discovery_file(enabled):
    path = relay.discovery_file()
    with TestClient(main.app):
        assert path.exists()
    assert not path.exists()


@pytest.mark.parametrize(
    ("method", "requested", "expected"),
    [
        ("getView", None, relay_protocol.DEFAULT_RESULT_TIMEOUT_SECONDS),
        ("runAlgorithm", None, 30 * 60.0),
        ("runWhiteboxTool", None, 30 * 60.0),
        ("runModelBuilder", None, 60 * 60.0),
        ("getView", 12, 12.0),
        ("runAlgorithm", 0.01, relay_protocol.MIN_RESULT_TIMEOUT_SECONDS),
        ("runAlgorithm", 10**9, relay_protocol.MAX_RESULT_TIMEOUT_SECONDS),
        ("getView", float("nan"), relay_protocol.DEFAULT_RESULT_TIMEOUT_SECONDS),
        ("getView", -3, relay_protocol.DEFAULT_RESULT_TIMEOUT_SECONDS),
        ("getView", True, relay_protocol.DEFAULT_RESULT_TIMEOUT_SECONDS),
        ("getView", "60", relay_protocol.DEFAULT_RESULT_TIMEOUT_SECONDS),
    ],
)
def test_result_timeout_is_per_method_and_clamped(method, requested, expected):
    assert relay_protocol.result_timeout_seconds(method, requested) == expected
