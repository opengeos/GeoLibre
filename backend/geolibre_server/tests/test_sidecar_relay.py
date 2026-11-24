"""Tests for the Live MCP relay hosted on the sidecar (``app/relay.py``)."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from geolibre_server import relay_protocol
from geolibre_server.app import main, relay

SIDECAR_TOKEN = "sidecar-secret"


@pytest.mark.parametrize("origin", ["http://[::1", "http://[invalid]", "https://[::1"])
def test_malformed_origin_is_rejected(origin):
    """Reject malformed URL headers without leaking a parse exception.

    Args:
        origin: A malformed browser Origin header.
    """
    assert not relay_protocol.is_allowed_origin(origin)


@pytest.mark.parametrize("previous", [False, True])
def test_access_reports_failed_discovery_and_can_retry(client, monkeypatch, previous):
    """Surface publication failure to the desktop's retry path.

    Args:
        client: The shared-loop relay HTTP client.
        monkeypatch: The pytest patch fixture.
        previous: The access state before attempting publication.
    """
    write = relay.write_discovery_file
    monkeypatch.setattr(relay, "_access_allowed", previous)
    monkeypatch.setattr(relay, "write_discovery_file", lambda: None)
    headers = {"X-GeoLibre-Token": SIDECAR_TOKEN}
    assert client.post("/relay/access", json={"enabled": True}, headers=headers).status_code == 503
    assert relay.relay_enabled() is previous
    monkeypatch.setattr(relay, "write_discovery_file", write)
    assert client.post("/relay/access", json={"enabled": True}, headers=headers).status_code == 200


@pytest.mark.parametrize("port", ["²", "invalid", "-1", "65536", "9" * 5000])
def test_invalid_port_configuration_fails_closed(monkeypatch, port):
    """Reject malformed port configuration without raising on relay requests.

    Args:
        monkeypatch: The pytest patch fixture.
        port: Invalid port text, including nondecimal digit-like characters.
    """
    monkeypatch.setenv(relay.PORT_ENV, port)
    assert relay._configured_port() is None


def test_revocation_closes_all_peers_concurrently(client, monkeypatch):
    """Let every close handshake start before awaiting any peer's completion.

    Args:
        client: The shared-loop relay HTTP client.
        monkeypatch: The pytest patch fixture.
    """
    barrier = asyncio.Event()
    started, completed = [], []

    async def close(*, code):
        """Wait until all peers have entered their close handshake.

        Args:
            code: The WebSocket close status.
        """
        assert code == 1008
        started.append(code)
        if len(started) == 3:
            barrier.set()
        await barrier.wait()
        completed.append(code)

    monkeypatch.setattr(relay, "SEND_TIMEOUT_SECONDS", 0.2)
    relay._hub.listeners.extend(SimpleNamespace(label=i, close=close) for i in range(3))
    result = client.post(
        "/relay/access", json={"enabled": False}, headers={"X-GeoLibre-Token": SIDECAR_TOKEN}
    )
    assert result.status_code == 200
    assert len(completed) == 3
    assert not relay._hub.listeners


@pytest.mark.parametrize("reenabled", [False, True])
def test_handshake_cannot_subscribe_after_access_is_revoked(enabled, monkeypatch, reenabled):
    """Reject a socket whose handshake finishes after revocation.

    Args:
        enabled: An enabled relay fixture.
        monkeypatch: The pytest patch fixture.
        reenabled: Whether a new grant follows revocation before acceptance.
    """
    closed = []

    async def accept(**_kwargs):
        """Revoke access while the handshake yields to another task.

        Args:
            **_kwargs: The requested WebSocket subprotocol.
        """
        monkeypatch.setattr(relay, "_access_allowed", reenabled)
        monkeypatch.setattr(relay, "_access_generation", relay._access_generation + 1)

    async def close(*, code):
        """Capture the rejected connection's close status.

        Args:
            code: The policy violation status code.
        """
        closed.append(code)

    socket = SimpleNamespace(
        headers={"origin": "http://localhost:5173"},
        scope={"subprotocols": ["geolibre-relay", f"geolibre-token.{SIDECAR_TOKEN}"]},
        accept=accept,
        close=close,
    )
    asyncio.run(relay.relay_socket(socket))
    assert closed == [1008]
    assert not relay._hub.listeners


def test_pending_command_fails_when_all_its_recipients_disconnect():
    """Fail promptly after losing the last original recipient, preserving live peers."""

    async def exercise():
        """Deliver a correlated command and disconnect its two recipients."""
        hub = relay._Hub()

        class Socket:
            """An app window that accepts a frame without returning a result."""

            async def send_text(self, _encoded):
                """Accept the encoded command frame.

                Args:
                    _encoded: The outgoing JSON envelope.
                """

        first, second = Socket(), Socket()
        hub.listeners.extend([first, second])
        future = asyncio.get_running_loop().create_future()
        hub.pending["dispatch"] = future
        assert await hub.broadcast({"requestId": "dispatch", "method": "runAlgorithm"}) == 2
        hub.drop(first)
        assert not future.done()
        hub.drop(second)
        result = await asyncio.wait_for(future, 0.1)
        assert result["ok"] is False
        assert "disconnected" in result["error"]

    asyncio.run(exercise())


def test_discovery_publication_waits_for_conditional_removal(enabled, monkeypatch):
    """Keep a different process's replacement record after revoking this owner.

    Args:
        enabled: An isolated enabled relay fixture.
        monkeypatch: The pytest patch fixture.
    """
    target = relay.write_discovery_file()
    original_read = Path.read_text
    processes = []

    def read_while_publisher_waits(path, *args, **kwargs):
        """Start a competing publisher during the ownership read.

        Args:
            path: The file being read.
            *args: Positional read arguments.
            **kwargs: Keyword read arguments.

        Returns:
            The current file contents before the competing publication.
        """
        data = original_read(path, *args, **kwargs)
        if path == target:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    (
                        "from geolibre_server.app import relay; "
                        "relay._access_allowed = True; "
                        "print('publishing', flush=True); "
                        "assert relay.write_discovery_file() is not None"
                    ),
                ],
                stdout=subprocess.PIPE,
                text=True,
            )
            processes.append(process)
            assert process.stdout.readline().strip() == "publishing"
            with pytest.raises(subprocess.TimeoutExpired):
                process.wait(timeout=0.2)
        return data

    monkeypatch.setattr(Path, "read_text", read_while_publisher_waits)
    try:
        relay.remove_discovery_file()
        assert len(processes) == 1
        assert processes[0].wait(timeout=10) == 0
        assert json.loads(original_read(target))["pid"] == processes[0].pid
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)


@pytest.fixture
def enabled(monkeypatch, tmp_path):
    """Enable the relay with a sidecar token and an isolated discovery file."""
    monkeypatch.setenv(relay.PORT_ENV, "8765")
    monkeypatch.setenv(relay.DISCOVERY_FILE_ENV, str(tmp_path / "runtime" / "live-relay.json"))
    monkeypatch.setattr(main, "SIDECAR_TOKEN", SIDECAR_TOKEN)
    monkeypatch.setattr(main, "_SIDECAR_TOKEN_BYTES", SIDECAR_TOKEN.encode())
    monkeypatch.setattr(relay, "_hub", relay._Hub())
    monkeypatch.setattr(relay, "_access_allowed", True)
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


def test_processing_start_requires_explicit_relay_opt_in(client, monkeypatch):
    """Only the sidecar-authenticated desktop can enable or revoke access."""
    monkeypatch.setattr(relay, "_access_allowed", False)
    relay.remove_discovery_file()
    assert relay.write_discovery_file() is None
    assert client.get("/relay/status", headers=_client_headers()).status_code == 404
    assert (
        client.post("/relay/access", json={"enabled": True}, headers=_client_headers()).status_code
        == 401
    )
    headers = {"X-GeoLibre-Token": SIDECAR_TOKEN}
    assert client.post("/relay/access", json={"enabled": "yes"}, headers=headers).status_code == 400
    assert client.post("/relay/access", json={"enabled": True}, headers=headers).json() == {
        "enabled": True
    }
    assert relay.discovery_file().exists()
    with client.websocket_connect(
        "/relay/socket", subprotocols=["geolibre-relay", f"geolibre-token.{SIDECAR_TOKEN}"]
    ) as socket:
        socket.receive_text()
        assert (
            client.post("/relay/access", json={"enabled": False}, headers=headers).status_code
            == 200
        )
        with pytest.raises(WebSocketDisconnect):
            socket.receive_text()
    assert not relay.discovery_file().exists()
    assert client.get("/relay/status", headers=_client_headers()).status_code == 404


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
            "/relay/socket",
            subprotocols=["geolibre-relay", f"geolibre-token.{SIDECAR_TOKEN}"],
            headers={"Origin": "https://evil.example"},
        ) as socket:
            socket.receive_text()
    with client.websocket_connect(
        "/relay/socket",
        subprotocols=["geolibre-relay", f"geolibre-token.{SIDECAR_TOKEN}"],
        headers={"Origin": "tauri://localhost"},
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


def test_binary_socket_frames_close_cleanly(client):
    """Reject binary app frames without a KeyError traceback.

    Args:
        client: The shared-loop relay client.
    """
    with client.websocket_connect(
        "/relay/socket", subprotocols=["geolibre-relay", f"geolibre-token.{SIDECAR_TOKEN}"]
    ) as socket:
        socket.receive_text()
        socket.send_bytes(b"not a text command result")
        with pytest.raises(WebSocketDisconnect) as error:
            socket.receive_text()
        assert error.value.code == 1003
    assert client.get("/relay/status", headers=_client_headers()).json() == {"listeners": 0}


def test_discovery_lock_wait_does_not_block_http_requests(client, monkeypatch):
    """Keep the event loop available while publication waits on file I/O.

    Args:
        client: The shared-loop relay client.
        monkeypatch: The pytest patch fixture.
    """
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    write = relay.write_discovery_file
    outcome = {}

    def blocked_write():
        """Pause the publisher until the concurrent health request returns.

        Returns:
            The path published by the original helper.
        """
        started.set()
        release.wait(timeout=5)
        finished.set()
        return write()

    def enable_access():
        """Apply access from a concurrent HTTP client thread."""
        outcome["response"] = client.post(
            "/relay/access", json={"enabled": True}, headers={"X-GeoLibre-Token": SIDECAR_TOKEN}
        )

    monkeypatch.setattr(relay, "write_discovery_file", blocked_write)
    thread = threading.Thread(target=enable_access)
    thread.start()
    try:
        assert started.wait(timeout=2)
        assert client.get("/relay/status", headers=_client_headers()).status_code == 200
        assert not finished.is_set()
    finally:
        release.set()
        thread.join(timeout=10)
    assert not thread.is_alive()
    assert outcome["response"].status_code == 200


def test_deadline_works_without_asyncio_timeout(client, monkeypatch):
    """Handle correlated requests without the Python 3.11 timeout API.

    Args:
        client: The shared-loop HTTP client.
        monkeypatch: The pytest patch fixture.
    """
    monkeypatch.setattr(
        relay,
        "asyncio",
        SimpleNamespace(**{key: value for key, value in vars(asyncio).items() if key != "timeout"}),
    )
    response = client.post(
        "/relay/command",
        headers=_client_headers(),
        json={"method": "getView", "requestId": "compatibility"},
    )
    assert response.json() == {"delivered": 0}


def test_correlated_command_round_trips_through_the_app_socket(client):
    with client.websocket_connect(
        "/relay/socket", subprotocols=["geolibre-relay", f"geolibre-token.{SIDECAR_TOKEN}"]
    ) as socket:
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


def test_fast_window_result_survives_a_stalled_peer_and_short_deadline(client):
    """Consume an immediate result before another peer exhausts the deadline.

    Args:
        client: The shared-loop HTTP client.
    """

    class StalledSocket:
        """A blocked app window that records the relay closing it."""

        closed = False

        async def send_text(self, _encoded):
            """Simulate backpressure.

            Args:
                _encoded: The command payload.
            """
            await asyncio.Event().wait()

        async def close(self, code):
            """Record a server close, allowing the app to reconnect.

            Args:
                code: The WebSocket close code.
            """
            self.closed = True

    stalled = StalledSocket()
    with client.websocket_connect(
        "/relay/socket", subprotocols=["geolibre-relay", f"geolibre-token.{SIDECAR_TOKEN}"]
    ) as socket:
        socket.receive_text()
        relay._hub.listeners.insert(0, stalled)
        thread, outcome = _post_in_thread(
            client,
            {
                "requestId": "short",
                "method": "getView",
                "timeoutSeconds": 0.5,
            },
        )
        command = json.loads(socket.receive_text())
        socket.send_text(
            json.dumps(
                {
                    "type": "geolibre:result",
                    "requestId": command["requestId"],
                    "ok": True,
                    "value": "ready",
                }
            )
        )
        thread.join(2)
        assert outcome["status"] == 200
        assert outcome["body"]["value"] == "ready"
        assert stalled.closed
        assert stalled not in relay._hub.listeners


def test_a_caller_timeout_answers_504(client):
    with client.websocket_connect(
        "/relay/socket", subprotocols=["geolibre-relay", f"geolibre-token.{SIDECAR_TOKEN}"]
    ) as socket:
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
    with client.websocket_connect(
        "/relay/socket", subprotocols=["geolibre-relay", f"geolibre-token.{SIDECAR_TOKEN}"]
    ) as socket:
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


def test_discovery_cleanup_does_not_create_unused_runtime_files(enabled):
    """Leave an unused runtime directory absent during ordinary shutdown.

    Args:
        enabled: An isolated discovery path whose parent does not yet exist.
    """
    parent = relay.discovery_file().parent
    assert not parent.exists()
    relay.remove_discovery_file()
    assert not parent.exists()


def test_lifespan_writes_and_removes_the_discovery_file(enabled):
    """Publish only after explicit access and remove the record at shutdown.

    Args:
        enabled: The isolated relay configuration.
    """
    path = relay.discovery_file()
    with TestClient(main.app) as shared:
        assert not path.exists()
        assert (
            shared.post(
                "/relay/access", json={"enabled": True}, headers={"X-GeoLibre-Token": SIDECAR_TOKEN}
            ).status_code
            == 200
        )
        assert path.exists()
    assert not path.exists()


def test_shutdown_discovery_cleanup_runs_off_the_event_loop(monkeypatch):
    """Move potentially contended discovery locking to a worker thread.

    Args:
        monkeypatch: The pytest patch fixture.
    """
    cleanup_threads = []
    monkeypatch.setattr(
        main, "remove_discovery_file", lambda: cleanup_threads.append(threading.get_ident())
    )
    loop_thread = threading.get_ident()

    async def exercise():
        """Enter and exit the actual application lifespan."""
        async with main._lifespan(main.app):
            assert not cleanup_threads

    asyncio.run(exercise())
    assert len(cleanup_threads) == 1
    assert cleanup_threads[0] != loop_thread


def test_command_stream_is_bounded_before_json_decode(client, monkeypatch):
    """Reject an oversized chunked command without buffering its remaining body.

    Args:
        client: The shared-loop relay HTTP client.
        monkeypatch: The pytest patch fixture.
    """
    monkeypatch.setattr(relay, "MAX_COMMAND_BYTES", 32)
    response = client.post(
        "/relay/command", content=iter([b" " * 20, b" " * 20]), headers=_client_headers()
    )
    assert response.status_code == 413


def test_socket_fails_closed_without_a_configured_token(client, monkeypatch):
    """Reject app subscriptions when the sidecar credential is missing."""
    monkeypatch.setattr(main, "SIDECAR_TOKEN", "")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/relay/socket") as socket:
            socket.receive_text()


def test_discovery_preserves_parent_permissions_and_ignores_staging_symlink(enabled):
    """Keep an existing override directory and unrelated files intact."""
    target = relay.discovery_file()
    target.parent.mkdir(mode=0o755)
    original_mode = stat.S_IMODE(target.parent.stat().st_mode)
    victim = enabled / "untouched.txt"
    victim.write_text("keep")
    predictable = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    predictable.symlink_to(victim)
    assert relay.write_discovery_file() == target
    assert victim.read_text() == "keep"
    assert stat.S_IMODE(target.parent.stat().st_mode) == original_mode


def test_broadcast_drops_stalled_peers_without_blocking_healthy_windows(monkeypatch):
    """Bound concurrent sends while preserving a healthy window's response."""
    monkeypatch.setattr(relay, "SEND_TIMEOUT_SECONDS", 0.02)

    async def exercise():
        """Exercise a stalled first peer and a responding second peer."""
        hub = relay._Hub()
        response = asyncio.get_running_loop().create_future()
        hub.pending["request"] = response

        class Socket:
            """Minimal app socket with optional simulated backpressure."""

            def __init__(self, stalled):
                """Store whether writes should remain blocked.

                Args:
                    stalled: Whether the socket blocks every write.
                """
                self.stalled = stalled

            async def send_text(self, encoded):
                """Resolve the command or simulate a stalled write.

                Args:
                    encoded: The serialized command.
                """
                if self.stalled:
                    await asyncio.Event().wait()
                else:
                    hub.resolve(
                        json.dumps(
                            {
                                "type": "geolibre:result",
                                "requestId": "request",
                                "ok": True,
                                "value": "ready",
                            }
                        )
                    )

        stalled, healthy = Socket(True), Socket(False)
        hub.listeners.extend([stalled, healthy])
        assert await asyncio.wait_for(hub.broadcast({"method": "getView"}), 0.2) == 1
        assert response.result()["value"] == "ready"
        assert hub.listeners == [healthy]

    asyncio.run(exercise())


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
        ("runAlgorithm", 10**400, relay_protocol.MAX_RESULT_TIMEOUT_SECONDS),
        ("getView", float("nan"), relay_protocol.DEFAULT_RESULT_TIMEOUT_SECONDS),
        ("getView", -3, relay_protocol.DEFAULT_RESULT_TIMEOUT_SECONDS),
        ("getView", True, relay_protocol.DEFAULT_RESULT_TIMEOUT_SECONDS),
        ("getView", "60", relay_protocol.DEFAULT_RESULT_TIMEOUT_SECONDS),
    ],
)
def test_result_timeout_is_per_method_and_clamped(method, requested, expected):
    assert relay_protocol.result_timeout_seconds(method, requested) == expected


def test_discovery_write_failure_is_reported_without_disabling_explicit_transport(
    enabled, monkeypatch, caplog
):
    """File publication failures stay visible while configured clients remain usable.

    Args:
        enabled: An isolated, enabled relay fixture.
        monkeypatch: The pytest patch fixture.
        caplog: Captured server logs.
    """

    def fail_file(*args, **kwargs):
        """Simulate a directory that cannot accept the private discovery file.

        Args:
            *args: Temporary-file positional arguments.
            **kwargs: Temporary-file keyword arguments.

        Raises:
            PermissionError: Always, to simulate denied filesystem access.
        """
        raise PermissionError("unwritable directory")

    monkeypatch.setattr(relay.tempfile, "NamedTemporaryFile", fail_file)
    assert relay.write_discovery_file() is None
    assert "Could not publish Live MCP discovery file (PermissionError)" in caplog.text
    assert relay.relay_token() not in caplog.text
    assert relay.relay_enabled()
    with TestClient(main.app) as client:
        assert client.get("/relay/status", headers=_client_headers()).status_code == 200


def test_large_frames_receive_a_bounded_proportional_send_budget(monkeypatch):
    """A healthy socket can drain a large frame beyond the small-command deadline.

    Args:
        monkeypatch: The pytest patch fixture.
    """
    monkeypatch.setattr(relay, "SEND_TIMEOUT_SECONDS", 0.01)

    async def exercise():
        """Send a larger command over a temporarily busy socket."""
        hub = relay._Hub()

        class Socket:
            """An app connection that takes longer than the base budget to drain."""

            closed = False

            async def send_text(self, encoded):
                """Consume the frame after a brief simulated period of backpressure.

                Args:
                    encoded: The outgoing JSON frame.
                """
                await asyncio.sleep(0.04)
                assert len(encoded) > 128 * 1024

            async def close(self, code):
                """Record whether the otherwise healthy connection was closed.

                Args:
                    code: The WebSocket close status.
                """
                self.closed = True

        socket = Socket()
        hub.listeners.append(socket)
        assert (
            await hub.broadcast(
                {"method": "addRasterBytes", "params": {"data": "x" * (128 * 1024)}}
            )
            == 1
        )
        assert not socket.closed
        assert hub.listeners == [socket]

    asyncio.run(exercise())
