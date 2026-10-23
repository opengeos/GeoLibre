"""Trusted reverse proxies: the client address and the signed-in user seen through them."""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network

from fastapi import Request


@dataclass(frozen=True)
class TrustedProxyConfig:
    networks: tuple[IPv4Network | IPv6Network, ...]
    identity_enabled: bool
    user_header: str
    email_header: str


def parse_networks(variable: str) -> tuple[IPv4Network | IPv6Network, ...]:
    """Parse the comma-separated IPs or CIDRs in env *variable*; an invalid entry fails startup."""
    networks: list[IPv4Network | IPv6Network] = []
    for raw in os.getenv(variable, "").split(","):
        entry = raw.strip()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError as exc:
            raise RuntimeError(f"{variable} entry {entry!r} is not an IP network") from exc
    return tuple(networks)


def load_trusted_proxy_config() -> TrustedProxyConfig:
    """Read ``GEOLIBRE_TRUSTED_PROXIES``, ``GEOLIBRE_PROXY_AUTH``, and the identity header names."""
    return TrustedProxyConfig(
        networks=parse_networks("GEOLIBRE_TRUSTED_PROXIES"),
        identity_enabled=os.getenv("GEOLIBRE_PROXY_AUTH", "").strip().lower()
        in {"1", "true", "yes"},
        user_header=os.getenv("GEOLIBRE_PROXY_USER_HEADER") or "Remote-User",
        email_header=os.getenv("GEOLIBRE_PROXY_EMAIL_HEADER") or "Remote-Email",
    )


def _parse_ip(value: str | None) -> IPv4Address | IPv6Address | None:
    if value is None:
        return None
    try:
        return ipaddress.ip_address(value.strip())
    except ValueError:
        return None


def _trusted(config: TrustedProxyConfig, address: IPv4Address | IPv6Address) -> bool:
    return any(address in network for network in config.networks)


def peer_trusted(request: Request) -> bool:
    """True when the direct peer is one of the configured trusted proxies."""
    if request.client is None:
        return False
    address = _parse_ip(request.client.host)
    if address is None:
        return False
    return _trusted(request.app.state.trusted_proxy, address)


def client_ip(request: Request) -> IPv4Address | IPv6Address | None:
    """Return the originating client address, honoring trusted ``X-Forwarded-For``."""
    if request.client is None:
        return None
    peer = _parse_ip(request.client.host)
    if not peer_trusted(request):
        return peer
    config: TrustedProxyConfig = request.app.state.trusted_proxy
    # An empty header line names no hop; it must not read as an unparseable one.
    forwarded = [
        part
        for value in request.headers.getlist("x-forwarded-for")
        if value
        for part in value.split(",")
    ]
    for raw in reversed(forwarded):
        address = _parse_ip(raw)
        if address is None:
            return None
        if not _trusted(config, address):
            return address
    return peer


@dataclass(frozen=True)
class ProxyIdentity:
    user: str
    email: str | None


def proxy_identity(request: Request) -> ProxyIdentity | None:
    """Return the user a trusted proxy vouches for; an untrusted peer's headers are never read.

    Proxy sign-in is off unless ``GEOLIBRE_PROXY_AUTH`` enables it: trusting a
    proxy's ``X-Forwarded-For`` does not imply trusting its identity headers.

    Raises:
        ValueError: the trusted proxy sent an empty, overlong, or control-character user.
    """
    config: TrustedProxyConfig = request.app.state.trusted_proxy
    if not config.identity_enabled or not peer_trusted(request):
        return None
    raw = request.headers.get(config.user_header)
    if raw is None:
        return None
    user = raw.strip()
    if not user or len(user) > 255 or any(ord(ch) < 32 for ch in user):
        raise ValueError("invalid proxy identity")
    return ProxyIdentity(user=user, email=request.headers.get(config.email_header))
