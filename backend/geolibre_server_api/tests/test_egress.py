"""Identity-provider requests never reach internal addresses unless allowlisted."""

from __future__ import annotations

import ipaddress
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from geolibre_server_api import egress, oidc

BLOCKED = [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fec0::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "2002:7f00:1::",
    "64:ff9b::a9fe:a9fe",
]
PUBLIC = ["93.184.215.14", "2606:4700::1111", "::ffff:93.184.215.14", "64:ff9b::5db8:d70e"]


@pytest.mark.parametrize("address", BLOCKED)
def test_internal_addresses_are_blocked(address):
    assert not egress.address_allowed(ipaddress.ip_address(address), ())


@pytest.mark.parametrize("address", PUBLIC)
def test_public_addresses_pass(address):
    assert egress.address_allowed(ipaddress.ip_address(address), ())


def test_allowlist_admits_internal_networks():
    loopback = (ipaddress.ip_network("127.0.0.0/8"),)
    assert egress.address_allowed(ipaddress.ip_address("127.0.0.1"), loopback)
    assert egress.address_allowed(ipaddress.ip_address("::ffff:127.0.0.1"), loopback)
    assert egress.address_allowed(ipaddress.ip_address("64:ff9b::7f00:1"), loopback)
    assert not egress.address_allowed(ipaddress.ip_address("64:ff9b::a00:1"), loopback)
    assert not egress.address_allowed(ipaddress.ip_address("10.0.0.1"), loopback)


class _Json(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def local_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Json)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1]
    server.shutdown()
    server.server_close()


def _fetch(url: str) -> dict:
    with oidc.build_http_client(oidc.build_transport()) as http:
        return oidc.fetch_json(http, "GET", url)


def test_identity_provider_client_refuses_loopback(local_server, monkeypatch):
    monkeypatch.delenv("GEOLIBRE_OIDC_ALLOWED_NETWORKS", raising=False)
    with pytest.raises(oidc.OidcError, match="transport error"):
        _fetch(f"http://localhost:{local_server}/")
    monkeypatch.setenv("GEOLIBRE_OIDC_ALLOWED_NETWORKS", "127.0.0.0/8")
    assert _fetch(f"http://localhost:{local_server}/") == {"ok": True}


def test_connection_goes_to_the_checked_address(local_server, monkeypatch):
    # The name resolves once; a second lookup could return another address.
    lookups = []
    real_getaddrinfo = socket.getaddrinfo

    def resolve(host, port, *args, **kwargs):
        if host != "idp.internal.test":
            return real_getaddrinfo(host, port, *args, **kwargs)
        lookups.append(host)
        address = "127.0.0.1" if len(lookups) == 1 else "192.0.2.1"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setenv("GEOLIBRE_OIDC_ALLOWED_NETWORKS", "127.0.0.1/32")
    assert _fetch(f"http://idp.internal.test:{local_server}/") == {"ok": True}
    assert lookups == ["idp.internal.test"]


def test_invalid_allowed_network_fails_startup(monkeypatch):
    monkeypatch.setenv("GEOLIBRE_OIDC_ALLOWED_NETWORKS", "127.0.0.1/32, nope")
    with pytest.raises(RuntimeError, match="GEOLIBRE_OIDC_ALLOWED_NETWORKS entry 'nope'"):
        oidc.build_transport()
