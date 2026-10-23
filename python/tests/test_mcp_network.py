"""Security-boundary tests for consent-scoped MCP preview resource fetching."""

from __future__ import annotations

import asyncio
import base64
import http.server
import ipaddress
import json
import shutil
import socket
import ssl
import subprocess
import threading
import time
from contextlib import contextmanager

import pytest

pytest.importorskip("mcp", reason="the MCP preview server is an optional extra")

import certifi
import httpcore

from geolibre.mcp import network
from geolibre.mcp.server import build_server
from geolibre.mcp.workspace import Workspace


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    payload: bytes = b"ok"
    status: int = 200
    response_headers: dict[str, str] = {}
    delay = 0.0
    send_length = True

    def do_GET(self):
        if self.path == "/slow":
            time.sleep(self.delay)
        payload = self.payload
        if self.path == "/json":
            payload = json.dumps({"type": "FeatureCollection", "features": []}).encode()
        self.send_response(self.status)
        self.send_header(
            "Content-Type", self.response_headers.get("Content-Type", "application/octet-stream")
        )
        for key, value in self.response_headers.items():
            if key.lower() != "content-type":
                self.send_header(key, value)
        if self.send_length and not any(
            key.lower() == "content-length" for key in self.response_headers
        ):
            self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        pass


@contextmanager
def resource_server(
    *, payload=b"ok", status=200, headers=None, delay=0.0, send_length=True, ssl_context=None
):
    handler = type(
        "PreviewTestHandler",
        (_Handler,),
        {
            "payload": payload,
            "status": status,
            "response_headers": headers or {},
            "delay": delay,
            "send_length": send_length,
        },
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    if ssl_context is not None:
        server.socket = ssl_context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


def patch_public_dns(monkeypatch, port):
    """Resolve to a public IP and connect its checked address to the local fixture."""
    real_getaddrinfo = network.anyio.getaddrinfo
    calls = []

    async def resolve(host, service, *args, **kwargs):
        if host == "tiles.example.test":
            calls.append(host)
            return [
                (
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                    "",
                    ("93.184.216.34", port),
                )
            ]
        return await real_getaddrinfo(host, service, *args, **kwargs)

    real_connect = httpcore.AnyIOBackend.connect_tcp

    async def connect(
        self, host, remote_port, timeout=None, local_address=None, socket_options=None
    ):
        if host == "93.184.216.34":
            return await real_connect(
                self, "127.0.0.1", port, timeout, local_address, socket_options
            )
        return await real_connect(self, host, remote_port, timeout, local_address, socket_options)

    monkeypatch.setattr(network.anyio, "getaddrinfo", resolve)
    monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", connect)
    return calls


def authorized_session(clock=time.monotonic):
    sessions = network.PreviewSessions(clock)
    preview = sessions.create()
    grant = sessions.approve(preview, "http://tiles.example.test")["grant"]
    return sessions, preview, grant


@pytest.fixture
def tls_resource_server(tmp_path, request):
    """Serve HTTPS with a test certificate, without relying on system trust."""
    openssl = shutil.which("openssl")
    if openssl is None:
        pytest.skip("the local HTTPS fixture requires openssl")
    hostname = request.param
    certificate = tmp_path / "certificate.pem"
    key = tmp_path / "key.pem"
    subprocess.run(
        [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(certificate),
            "-days",
            "1",
            "-subj",
            f"/CN={hostname}",
            "-addext",
            f"subjectAltName=DNS:{hostname}",
        ],
        check=True,
        capture_output=True,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)
    with resource_server(payload=b"verified HTTPS tile", ssl_context=context) as port:
        yield port, certificate, hostname


@pytest.mark.parametrize(
    ("tls_resource_server", "trusted"),
    [
        ("tiles.example.test", True),
        ("tiles.example.test", False),
        ("wrong.example.test", True),
    ],
    indirect=["tls_resource_server"],
)
def test_https_uses_bundle_without_system_cas_and_verifies_hostname(
    monkeypatch, tls_resource_server, trusted
):
    port, certificate, hostname = tls_resource_server
    patch_public_dns(monkeypatch, port)
    # Simulate a Python installation whose default context has no CA certificates.
    monkeypatch.setattr(
        network.ssl,
        "create_default_context",
        lambda: ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
    )
    if trusted:
        monkeypatch.setattr(certifi, "where", lambda: str(certificate))
    sessions = network.PreviewSessions()
    preview = sessions.create()
    grant = sessions.approve(preview, "https://tiles.example.test")["grant"]
    request = network.fetch_resource(sessions, preview, grant, "https://tiles.example.test/tile")
    if trusted and hostname == "tiles.example.test":
        result = asyncio.run(request)
        assert base64.b64decode(result["data"]) == b"verified HTTPS tile"
    else:
        with pytest.raises(network.PreviewNetworkError, match="fetched safely"):
            asyncio.run(request)


def test_oversized_content_length_is_rejected_before_reading_body(monkeypatch):
    with resource_server(
        payload=b"", headers={"Content-Length": str(network.MAX_RESPONSE_BYTES + 1)}
    ) as port:
        patch_public_dns(monkeypatch, port)
        sessions, preview, grant = authorized_session()
        with pytest.raises(network.PreviewNetworkError, match="4 MiB"):
            asyncio.run(
                network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/tile")
            )


def test_response_at_the_size_limit_is_accepted(monkeypatch):
    payload = b"x" * network.MAX_RESPONSE_BYTES
    with resource_server(payload=payload) as port:
        patch_public_dns(monkeypatch, port)
        sessions, preview, grant = authorized_session()
        result = asyncio.run(
            network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/tile")
        )
        assert base64.b64decode(result["data"]) == payload


def test_credential_like_query_rejection_is_actionable_and_does_not_echo_values():
    sessions, preview, grant = authorized_session()
    query = "api_key=PRIVATE_SECRET"
    with pytest.raises(network.PreviewNetworkError, match="Credential-like") as error:
        sessions.authorize(preview, grant, f"http://tiles.example.test/tile?{query}")
    assert query not in str(error.value)
    assert "PRIVATE_SECRET" not in str(error.value)


def test_fetches_real_binary_and_json_responses(monkeypatch):
    payload = b"\x00\xffbinary\x80"
    headers = {"Cache-Control": "public, max-age=30", "Expires": "Wed, 21 Oct 2030 07:28:00 GMT"}
    with resource_server(payload=payload, headers=headers) as port:
        calls = patch_public_dns(monkeypatch, port)
        sessions, preview, grant = authorized_session()
        binary = asyncio.run(
            network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/tile")
        )
        assert base64.b64decode(binary["data"]) == payload
        document = asyncio.run(
            network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/json")
        )
        assert json.loads(base64.b64decode(document["data"])) == {
            "type": "FeatureCollection",
            "features": [],
        }
        assert len(calls) == 2


def test_missing_grant_fails_before_dns(monkeypatch):
    sessions = network.PreviewSessions()
    preview = sessions.create()
    monkeypatch.setattr(
        network.socket, "getaddrinfo", lambda *a, **k: pytest.fail("DNS must not run")
    )
    with pytest.raises(network.PreviewNetworkError, match="consent grant"):
        asyncio.run(network.fetch_resource(sessions, preview, "bad", "http://tiles.example.test/a"))


def test_grants_are_origin_scoped_and_renewable_only_within_preview():
    sessions = network.PreviewSessions()
    preview = sessions.create()
    grant = sessions.approve(preview, "https://tiles.example.test")["grant"]
    with pytest.raises(network.PreviewNetworkError, match="not approved"):
        sessions.authorize(preview, grant, "http://tiles.example.test/tile")
    with pytest.raises(network.PreviewNetworkError, match="not approved"):
        sessions.authorize(preview, grant, "https://other.example.test/tile")
    renewed = sessions.approve(preview, "https://tiles.example.test")["grant"]
    assert (
        sessions.authorize(preview, renewed, "https://tiles.example.test/tile")[0]
        == "https://tiles.example.test"
    )
    with pytest.raises(network.PreviewNetworkError, match="Unknown or expired"):
        sessions.authorize("other-preview", renewed, "https://tiles.example.test/tile")


def test_renewal_preserves_an_in_flight_resource_grant(monkeypatch):
    now = [0.0]
    sessions, preview, grant = authorized_session(lambda: now[0])
    now[0] = network.GRANT_TTL - 1
    with resource_server(payload=b"pending tile") as port:
        patch_public_dns(monkeypatch, port)
        resolve = network.anyio.getaddrinfo

        async def renew_during_dns(host, service, **kwargs):
            sessions.approve(preview, "http://tiles.example.test")
            return await resolve(host, service, **kwargs)

        monkeypatch.setattr(network.anyio, "getaddrinfo", renew_during_dns)
        result = asyncio.run(
            network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/tile")
        )
        assert base64.b64decode(result["data"]) == b"pending tile"


@pytest.mark.parametrize("activity", ["approve", "authorize"])
def test_successful_preview_activity_refreshes_idle_timeout(monkeypatch, activity):
    monkeypatch.setattr(network, "SESSION_TTL", 10)
    now = [0.0]
    sessions, preview, grant = authorized_session(lambda: now[0])
    for checkpoint in (9.0, 18.0):
        now[0] = checkpoint
        if activity == "approve":
            grant = sessions.approve(preview, "http://tiles.example.test")["grant"]
        else:
            assert sessions.authorize(preview, grant, "http://tiles.example.test/tile") == (
                "http://tiles.example.test",
                "tiles.example.test",
                80,
            )
    now[0] += network.SESSION_TTL
    with pytest.raises(network.PreviewNetworkError):
        sessions.approve(preview, "http://tiles.example.test")


@pytest.mark.parametrize(
    ("valid_token", "url"),
    [
        (False, "http://tiles.example.test/tile"),
        (True, "http://other.example.test/tile"),
        (True, "http://user:password@tiles.example.test/tile"),
    ],
)
def test_rejected_resource_authorization_does_not_extend_session(monkeypatch, valid_token, url):
    monkeypatch.setattr(network, "SESSION_TTL", 10)
    now = [0.0]
    sessions, preview, grant = authorized_session(lambda: now[0])
    now[0] = 9.0
    with pytest.raises(network.PreviewNetworkError):
        sessions.authorize(preview, grant if valid_token else "wrong", url)
    now[0] = 10.0
    with pytest.raises(network.PreviewNetworkError):
        sessions.approve(preview, "http://tiles.example.test")


def test_preview_and_grant_expiry_and_idempotent_close():
    now = [0.0]
    sessions = network.PreviewSessions(lambda: now[0])
    preview = sessions.create()
    grant = sessions.approve(preview, "https://tiles.example.test")["grant"]
    now[0] = network.GRANT_TTL - 1
    sessions.authorize(preview, grant, "https://tiles.example.test/tile")
    now[0] = network.GRANT_TTL
    with pytest.raises(network.PreviewNetworkError):
        sessions.authorize(preview, grant, "https://tiles.example.test/tile")
    grant = sessions.approve(preview, "https://tiles.example.test")["grant"]
    now[0] += network.SESSION_TTL
    with pytest.raises(network.PreviewNetworkError):
        sessions.authorize(preview, grant, "https://tiles.example.test/tile")
    assert sessions.close(preview) == {"closed": True}
    assert sessions.close(preview) == {"closed": True}


def test_session_and_origin_caps_are_enforced():
    sessions = network.PreviewSessions()
    previews = [sessions.create() for _ in range(network.MAX_SESSIONS)]
    with pytest.raises(network.PreviewNetworkError, match="Too many active"):
        sessions.create()
    for index in range(network.MAX_ORIGINS):
        sessions.approve(previews[0], f"https://h{index}.example.test")
    with pytest.raises(network.PreviewNetworkError, match="too many approved"):
        sessions.approve(previews[0], "https://extra.example.test")
    sessions.approve(previews[0], "https://h0.example.test")


@pytest.mark.parametrize(
    "value",
    [
        "http://127.0.0.1/",
        "http://10.0.0.1/",
        "http://169.254.169.254/",
        "http://[::1]/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[64:ff9b::7f00:1]/",
        "http://[2002:7f00:1::1]/",
        "http://[2001:0000::1]/",
        "http://localhost/",
        "http://a.localhost/",
        "ftp://tiles.example.test/",
        "https://u:p@tiles.example.test/",
        "https://tiles.example.test/?api_key=secret",
        "https://tiles.example.test/?X-Amz-Credential=a",
        "https://tiles.example.test/path#fragment",
        "https://tiles.example.test:bad/",
        "https://tiles.example.test/\nHost: internal",
    ],
)
def test_unsafe_urls_rejected_at_approval(value):
    sessions = network.PreviewSessions()
    preview = sessions.create()
    with pytest.raises(network.PreviewNetworkError):
        sessions.approve(preview, value)


def test_dns_rebinding_mixed_answer_fails_before_connect(monkeypatch):
    sessions, preview, grant = authorized_session()
    dns_calls = []

    async def resolve(host, port, **kwargs):
        dns_calls.append(host)
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)),
        ]

    async def forbidden_connect(*args, **kwargs):
        pytest.fail("mixed public/private answers must be rejected before TCP")

    monkeypatch.setattr(network.anyio, "getaddrinfo", resolve)
    monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", forbidden_connect)
    with pytest.raises(network.PreviewNetworkError, match="non-public"):
        asyncio.run(network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/a"))
    assert len(dns_calls) == 1


def test_dns_rebinding_cannot_replace_the_checked_socket_address(monkeypatch):
    with resource_server(payload=b"pinned") as port:
        real_getaddrinfo = network.anyio.getaddrinfo
        patch_public_dns(monkeypatch, port)
        resolutions = []

        async def rebinding(host, service, *args, **kwargs):
            if host == "tiles.example.test":
                resolutions.append(host)
                address = "93.184.216.34" if len(resolutions) == 1 else "127.0.0.1"
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]
            return await real_getaddrinfo(host, service, *args, **kwargs)

        monkeypatch.setattr(network.anyio, "getaddrinfo", rebinding)
        sessions, preview, grant = authorized_session()
        response = asyncio.run(
            network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/tile")
        )
        assert base64.b64decode(response["data"]) == b"pinned"
        assert resolutions == ["tiles.example.test"]


def test_grant_expiring_during_resolution_fails_before_socket(monkeypatch):
    now = [0.0]
    sessions, preview, grant = authorized_session(lambda: now[0])

    async def expire_after_dns(host, port, **kwargs):
        now[0] = network.GRANT_TTL
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]

    async def forbidden_connect(*args, **kwargs):
        pytest.fail("expired grant must be rechecked before TCP")

    monkeypatch.setattr(network.anyio, "getaddrinfo", expire_after_dns)
    monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", forbidden_connect)
    with pytest.raises(network.PreviewNetworkError, match="consent grant"):
        asyncio.run(network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/a"))


def test_redirects_are_not_followed(monkeypatch):
    with resource_server(status=302, headers={"Location": "http://127.0.0.1/private"}) as port:
        calls = patch_public_dns(monkeypatch, port)
        sessions, preview, grant = authorized_session()
        with pytest.raises(network.PreviewNetworkError, match="redirects"):
            asyncio.run(
                network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/a")
            )
        assert calls == ["tiles.example.test"]


def test_compressed_and_oversized_responses_are_rejected(monkeypatch):
    with resource_server(payload=b"compressed", headers={"Content-Encoding": "gzip"}) as port:
        patch_public_dns(monkeypatch, port)
        sessions, preview, grant = authorized_session()
        with pytest.raises(network.PreviewNetworkError, match="Compressed"):
            asyncio.run(
                network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/a")
            )
    with resource_server(
        payload=b"x" * (network.MAX_RESPONSE_BYTES + 1), send_length=False
    ) as port:
        patch_public_dns(monkeypatch, port)
        sessions, preview, grant = authorized_session()
        with pytest.raises(network.PreviewNetworkError, match="4 MiB"):
            asyncio.run(
                network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/a")
            )


def test_slow_response_obeys_total_deadline(monkeypatch):
    monkeypatch.setattr(network, "TOTAL_TIMEOUT", 0.03)
    with resource_server(delay=0.15) as port:
        patch_public_dns(monkeypatch, port)
        sessions, preview, grant = authorized_session()
        with pytest.raises(network.PreviewNetworkError, match="15-second time limit"):
            asyncio.run(
                network.fetch_resource(sessions, preview, grant, "http://tiles.example.test/slow")
            )


def test_public_address_filter_blocks_reserved_and_tunnel_forms():
    blocked = [
        "0.0.0.0",
        "100.64.0.1",
        "192.0.2.1",
        "224.0.0.1",
        "240.0.0.1",
        "::",
        "::1",
        "::ffff:10.0.0.1",
        "64:ff9b::a00:1",
        "64:ff9b:1::a00:1",
        "2002:a00:1::1",
        "2001:0::1",
        "2001:4860:4860::5efe:7f00:1",
        "fe80::1",
        "fc00::1",
    ]
    for raw in blocked:
        assert not network._public(ipaddress.ip_address(raw)), raw


def test_app_tool_route_returns_actual_resource_bytes(monkeypatch, tmp_path):
    payload = b"\x00binary through MCP"
    with resource_server(payload=payload, headers={"Content-Type": "image/png"}) as port:
        calls = patch_public_dns(monkeypatch, port)
        server = build_server(Workspace([tmp_path]))
        asyncio.run(
            server.call_tool("create_project", {"path": "map.geolibre.json", "name": "Preview"})
        )
        preview = asyncio.run(
            server.call_tool("get_map_preview", {"path": "map.geolibre.json"})
        ).structured_content
        grant = asyncio.run(
            server.call_tool(
                "approve_map_origin",
                {"preview_id": preview["previewId"], "origin": "http://tiles.example.test"},
            )
        ).structured_content["grant"]
        response = asyncio.run(
            server.call_tool(
                "fetch_map_resource",
                {
                    "preview_id": preview["previewId"],
                    "grant": grant,
                    "url": "http://tiles.example.test/tile",
                },
            )
        )
        assert response.content == []
        assert response.structured_content["mimeType"] == "image/png"
        assert base64.b64decode(response.structured_content["data"]) == payload
        assert calls == ["tiles.example.test"]
        asyncio.run(server.call_tool("close_map_preview", {"preview_id": preview["previewId"]}))
