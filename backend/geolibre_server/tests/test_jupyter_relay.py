"""Tests for the Jupyter map-command relay (issue #1442).

The relay is what lets a kernel driven by an EXTERNAL Jupyter frontend (VS
Code's Jupyter extension) control the live map, so the cases that matter are:
the command envelope it will broadcast, who may open the socket, the URL and
environment it publishes to kernels, and the broadcast bookkeeping itself.
"""

from __future__ import annotations

import asyncio
import json
import os

import pytest

jupyter_relay = pytest.importorskip(
    "geolibre_server.jupyter_relay",
    reason="needs the `notebook` extra (jupyter-server)",
)


class FakeSocket:
    """Stands in for a connected app window."""

    def __init__(self, *, fails: bool = False) -> None:
        self.received: list[str] = []
        self.fails = fails

    def write_message(self, message: str) -> None:
        if self.fails:
            raise RuntimeError("socket is closed")
        self.received.append(message)


@pytest.fixture(autouse=True)
def _isolate_listeners():
    """Keep each test's listener list independent of the module-level one."""
    saved = list(jupyter_relay._listeners)
    saved_pending = dict(jupyter_relay._pending_results)
    saved_owners = dict(jupyter_relay._pending_owners)
    jupyter_relay._listeners.clear()
    jupyter_relay._pending_results.clear()
    jupyter_relay._pending_owners.clear()
    yield
    jupyter_relay._listeners.clear()
    jupyter_relay._listeners.extend(saved)
    jupyter_relay._pending_results.clear()
    jupyter_relay._pending_results.update(saved_pending)
    jupyter_relay._pending_owners.clear()
    jupyter_relay._pending_owners.update(saved_owners)


# -- the command envelope ----------------------------------------------------


def test_normalize_command_fills_in_the_bridge_envelope():
    message = jupyter_relay.normalize_command({"method": "flyTo", "params": {"zoom": 4}})
    assert message == {
        "type": "geolibre:command",
        "requestId": "",
        "method": "flyTo",
        "params": {"zoom": 4},
    }


def test_normalize_command_keeps_a_string_request_id():
    message = jupyter_relay.normalize_command({"method": "flyTo", "requestId": "abc"})
    assert message["requestId"] == "abc"


def test_normalize_command_defaults_missing_params_to_an_empty_object():
    assert jupyter_relay.normalize_command({"method": "getView"})["params"] == {}


def test_normalize_result_keeps_a_success_value():
    assert jupyter_relay.normalize_result(
        {
            "type": "geolibre:result",
            "requestId": "abc",
            "ok": True,
            "value": [{"id": "layer-1"}],
        }
    ) == {
        "requestId": "abc",
        "ok": True,
        "value": [{"id": "layer-1"}],
    }


def test_normalize_result_keeps_an_error_message():
    assert jupyter_relay.normalize_result(
        {
            "type": "geolibre:result",
            "requestId": "abc",
            "ok": False,
            "error": "No layer",
        }
    ) == {"requestId": "abc", "ok": False, "error": "No layer"}


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"type": "geolibre:result", "requestId": "", "ok": True},
        {"type": "geolibre:result", "requestId": "abc", "ok": "yes"},
    ],
)
def test_normalize_result_rejects_malformed_payloads(payload):
    with pytest.raises(ValueError):
        jupyter_relay.normalize_result(payload)


def test_the_client_outwaits_this_modules_result_timeout():
    # notebook_client's read-back waits _RELAY_TIMEOUT_SECONDS + 1 (see
    # _request_from_relay). That has to stay above the budget here, or the
    # kernel's own socket gives up first and the precise 504 -> GeoLibreTimeoutError
    # ("still running in the app") degrades into GeoLibreNotConnectedError
    # ("could not be reached"), which is both wrong and differently handled.
    # The two constants live in separate modules, so pin their ordering here.
    notebook_client = pytest.importorskip(
        "notebook_client", reason="the notebook client renders IPython displays"
    )

    assert notebook_client._RELAY_TIMEOUT_SECONDS + 1 > jupyter_relay.RESULT_TIMEOUT_SECONDS


@pytest.mark.parametrize(
    "payload",
    [
        ["not", "an", "object"],
        {},
        {"method": ""},
        {"method": 42},
        {"method": "flyTo", "params": [1, 2]},
    ],
)
def test_normalize_command_rejects_malformed_payloads(payload):
    with pytest.raises(ValueError):
        jupyter_relay.normalize_command(payload)


# -- who may drive the map ---------------------------------------------------


@pytest.mark.parametrize(
    "origin",
    [
        None,
        "",
        "tauri://localhost",
        # Windows: http is the real scheme (Tauri v2's useHttpsScheme defaults
        # to false); https covers it being turned on.
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:5173",
        "http://127.0.0.1:8766",
    ],
)
def test_allows_the_app_origins(origin):
    assert jupyter_relay.is_allowed_origin(origin) is True


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example.com",
        "http://localhost.evil.example.com",
        "file://",
        "ftp://127.0.0.1",
    ],
)
def test_rejects_foreign_origins(origin):
    assert jupyter_relay.is_allowed_origin(origin) is False


# -- what kernels are told ---------------------------------------------------


def test_relay_base_url_joins_the_server_base_url():
    assert (
        jupyter_relay.relay_base_url("127.0.0.1", 8766, "/")
        == "http://127.0.0.1:8766/geolibre/relay"
    )


def test_relay_base_url_honors_a_prefixed_server():
    assert (
        jupyter_relay.relay_base_url("127.0.0.1", 8766, "/jupyter/")
        == "http://127.0.0.1:8766/jupyter/geolibre/relay"
    )


@pytest.mark.parametrize("host", ["", "0.0.0.0", "::"])
def test_relay_base_url_falls_back_to_loopback(host):
    # A wildcard bind is not an address a kernel can POST to.
    assert jupyter_relay.relay_base_url(host, 8766, "/").startswith("http://127.0.0.1:8766")


# -- broadcasting ------------------------------------------------------------


def test_broadcast_reaches_every_listener_and_counts_them():
    first, second = FakeSocket(), FakeSocket()
    jupyter_relay._listeners.extend([first, second])

    delivered = jupyter_relay._broadcast({"type": "geolibre:command", "method": "flyTo"})

    assert delivered == 2
    assert json.loads(first.received[0])["method"] == "flyTo"
    assert json.loads(second.received[0])["method"] == "flyTo"


def test_broadcast_drops_a_dead_listener_instead_of_failing():
    alive, dead = FakeSocket(), FakeSocket(fails=True)
    jupyter_relay._listeners.extend([alive, dead])

    delivered = jupyter_relay._broadcast({"type": "geolibre:command", "method": "flyTo"})

    assert delivered == 1
    assert dead not in jupyter_relay._listeners
    assert alive in jupyter_relay._listeners


def test_broadcast_with_no_listeners_reports_zero():
    # This zero is what the kernel client turns into a "nothing is listening"
    # warning rather than a silent no-op.
    assert jupyter_relay._broadcast({"type": "geolibre:command", "method": "flyTo"}) == 0


# -- single-window dispatch (correlated read-back) ---------------------------


def test_dispatch_one_reaches_only_one_listener():
    first, second = FakeSocket(), FakeSocket()
    jupyter_relay._listeners.extend([first, second])

    owner = jupyter_relay._dispatch_one({"type": "geolibre:command", "method": "listLayers"})

    assert owner is first
    assert len(first.received) + len(second.received) == 1


def test_dispatch_one_keeps_picking_the_same_window():
    # A mutation and the read-back that follows it must reach the same map, so
    # the single-window pick has to be the oldest connection every time — not
    # whichever one an unordered set happened to yield.
    first, second = FakeSocket(), FakeSocket()
    jupyter_relay._listeners.extend([first, second])

    for method in ("addGeoJsonLayer", "listLayers"):
        jupyter_relay._dispatch_one({"type": "geolibre:command", "method": method})

    assert len(first.received) == 2
    assert second.received == []


def test_dispatch_one_falls_through_a_dead_first_window():
    dead, alive = FakeSocket(fails=True), FakeSocket()
    jupyter_relay._listeners.extend([dead, alive])

    owner = jupyter_relay._dispatch_one({"type": "geolibre:command", "method": "listLayers"})

    assert owner is alive
    assert len(alive.received) == 1
    assert jupyter_relay._listeners == [alive]


def test_dispatch_one_reports_no_window():
    assert jupyter_relay._dispatch_one({"type": "geolibre:command", "method": "listLayers"}) is None


def test_only_the_owning_window_may_answer_a_request():
    loop = asyncio.new_event_loop()
    try:
        owner, other = FakeSocket(), FakeSocket()
        future = loop.create_future()
        jupyter_relay._listeners.extend([owner, other])
        jupyter_relay._pending_results["mine"] = future
        jupyter_relay._pending_owners["mine"] = owner
        reply = json.dumps(
            {"type": "geolibre:result", "requestId": "mine", "ok": True, "value": "layer-1"}
        )

        jupyter_relay.GeoLibreRelaySocket.on_message(other, reply)
        assert not future.done()

        jupyter_relay.GeoLibreRelaySocket.on_message(owner, reply)
        assert future.result()["value"] == "layer-1"
    finally:
        loop.close()


def test_closing_the_owning_window_fails_its_request_at_once():
    # Without this the kernel would sit out the full RESULT_TIMEOUT_SECONDS for
    # an answer the relay already knows can never arrive.
    loop = asyncio.new_event_loop()
    try:
        socket, other = FakeSocket(), FakeSocket()
        future, untouched = loop.create_future(), loop.create_future()
        jupyter_relay._listeners.extend([socket, other])
        jupyter_relay._pending_results.update({"mine": future, "theirs": untouched})
        jupyter_relay._pending_owners.update({"mine": socket, "theirs": other})

        jupyter_relay.GeoLibreRelaySocket.on_close(socket)

        assert jupyter_relay._listeners == [other]
        assert future.result() == {
            "requestId": "mine",
            "ok": False,
            "error": "The GeoLibre window running this command closed.",
        }
        # Another window's in-flight request is none of this socket's business.
        assert not untouched.done()
    finally:
        loop.close()


# -- extension load ----------------------------------------------------------


class FakeWebApp:
    def __init__(self) -> None:
        self.settings = {"base_url": "/"}
        self.added: list[tuple[str, object]] = []

    def add_handlers(self, host_pattern, handlers):  # noqa: ARG002 - signature parity
        self.added.extend(handlers)


class FakeLog:
    def info(self, *args, **kwargs) -> None:
        """Swallow the startup log line."""


class FakeIdentityProvider:
    def __init__(self, token: str) -> None:
        self.token = token


class FakeServerApp:
    def __init__(self, token: str = "s3cret") -> None:
        self.web_app = FakeWebApp()
        self.ip = "127.0.0.1"
        self.port = 8766
        self.log = FakeLog()
        self.identity_provider = FakeIdentityProvider(token)


def test_load_registers_the_endpoints_and_publishes_them_to_kernels(monkeypatch):
    monkeypatch.delenv(jupyter_relay.ENV_RELAY_URL, raising=False)
    monkeypatch.delenv(jupyter_relay.ENV_RELAY_TOKEN, raising=False)
    serverapp = FakeServerApp()

    jupyter_relay._load_jupyter_server_extension(serverapp)

    routes = [route for route, _ in serverapp.web_app.added]
    assert routes == [
        "/geolibre/relay/socket",
        "/geolibre/relay/command",
        "/geolibre/relay/status",
    ]
    # Kernels the server spawns inherit these, which is what makes an externally
    # driven kernel able to find the map with no configuration.
    assert os.environ[jupyter_relay.ENV_RELAY_URL] == "http://127.0.0.1:8766/geolibre/relay"
    assert os.environ[jupyter_relay.ENV_RELAY_TOKEN] == "s3cret"


def test_load_tolerates_a_tokenless_server(monkeypatch):
    monkeypatch.delenv(jupyter_relay.ENV_RELAY_TOKEN, raising=False)
    serverapp = FakeServerApp()
    serverapp.identity_provider = FakeIdentityProvider(None)  # type: ignore[arg-type]
    serverapp.token = None

    jupyter_relay._load_jupyter_server_extension(serverapp)

    assert os.environ[jupyter_relay.ENV_RELAY_TOKEN] == ""


def test_extension_points_declare_this_module():
    assert jupyter_relay._jupyter_server_extension_points() == [
        {"module": "geolibre_server.jupyter_relay"}
    ]
