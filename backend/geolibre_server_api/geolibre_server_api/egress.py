"""Identity-provider connections that cannot reach the server's own network.

Any signed-in user can create an organization and point its identity provider
at any URL, so unguarded IdP requests would let them probe internal services
(SSRF). The check runs on the address each socket actually connects to: the
host is resolved once, every non-public address is dropped, and the connection
goes to a checked address, so DNS cannot swap in another address between check
and connect. TLS still verifies the certificate against the URL's hostname.
"""

from __future__ import annotations

import ipaddress
import socket
import ssl
import typing
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network

import httpcore
import httpx

# Well-known NAT64 prefix: the low 32 bits are the IPv4 destination.
_NAT64 = ipaddress.ip_network("64:ff9b::/96")

Address = IPv4Address | IPv6Address
Networks = tuple[IPv4Network | IPv6Network, ...]


def _internal(address: Address) -> bool:
    if isinstance(address, IPv6Address):
        if address.ipv4_mapped is not None:
            return _internal(address.ipv4_mapped)
        if address in _NAT64:
            return _internal(IPv4Address(int(address) & 0xFFFFFFFF))
        # 6to4 and Teredo tunnel to an embedded IPv4 address; site-local is
        # deprecated private space that ``is_global`` misses.
        if address.sixtofour is not None or address.teredo is not None or address.is_site_local:
            return True
    # Not globally reachable covers loopback, private, link-local, CGNAT
    # (100.64.0.0/10), documentation, unspecified, and reserved ranges.
    return address.is_multicast or address.is_reserved or not address.is_global


def address_allowed(address: Address, allowed: Networks) -> bool:
    """True when *address* is public or inside an operator-allowed network."""
    forms = [address]
    if isinstance(address, IPv6Address):
        if address.ipv4_mapped is not None:
            forms.append(address.ipv4_mapped)
        elif address in _NAT64:
            # Mirror _internal: an allowed IPv4 network admits its NAT64 form too.
            forms.append(IPv4Address(int(address) & 0xFFFFFFFF))
    if any(form in network for form in forms for network in allowed):
        return True
    return not _internal(address)


class GuardedBackend(httpcore.NetworkBackend):
    """A network backend that connects only to addresses ``address_allowed`` accepts."""

    def __init__(self, allowed: Networks, inner: httpcore.NetworkBackend | None = None):
        self._allowed = allowed
        self._inner = inner or httpcore.SyncBackend()

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: typing.Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.NetworkStream:
        try:
            resolved = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise httpcore.ConnectError(f"cannot resolve {host}") from exc
        addresses = list(dict.fromkeys(ipaddress.ip_address(info[4][0]) for info in resolved))
        permitted = [address for address in addresses if address_allowed(address, self._allowed)]
        if not permitted:
            raise httpcore.ConnectError(f"{host} resolves only to blocked addresses")
        error: httpcore.ConnectError | httpcore.ConnectTimeout | None = None
        for address in permitted:
            try:
                return self._inner.connect_tcp(
                    str(address),
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                error = exc
        assert error is not None
        raise error

    def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: typing.Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.NetworkStream:
        raise httpcore.ConnectError("unix sockets are not allowed")

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


class GuardedTransport(httpx.HTTPTransport):
    """``httpx.HTTPTransport`` over a pool whose connections pass ``GuardedBackend``.

    ``HTTPTransport`` accepts no network backend, so its pool is rebuilt with
    one; request mapping and error translation stay httpx's own. ``_pool`` is
    private httpx API (see docs/maintenance.md): if it disappears, building the
    transport fails instead of silently keeping the unguarded pool.
    """

    def __init__(self, ssl_context: ssl.SSLContext, allowed: Networks):
        super().__init__(verify=ssl_context, trust_env=False)
        unguarded = getattr(self, "_pool", None)
        if not isinstance(unguarded, httpcore.ConnectionPool):
            raise RuntimeError(
                "httpx.HTTPTransport no longer keeps its pool in `_pool`; "
                "the identity-provider egress guard cannot be installed"
            )
        unguarded.close()
        self._pool = httpcore.ConnectionPool(
            ssl_context=ssl_context,
            max_connections=100,
            max_keepalive_connections=20,
            keepalive_expiry=5.0,
            network_backend=GuardedBackend(allowed),
        )
