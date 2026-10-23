"""Consent-scoped, public-only network access for MCP map previews.

Each preview receives a short-lived session. The UI must obtain an origin grant
before it can fetch a URL, and every socket connects to a checked DNS result
while HTTP core retains the original hostname for the Host header and TLS SNI.
"""

from __future__ import annotations

import base64
import ipaddress
import secrets
import socket
import ssl
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import parse_qsl, urlsplit

import anyio
import httpcore

SESSION_TTL = 30 * 60
GRANT_TTL = 5 * 60
MAX_SESSIONS = 64
MAX_ORIGINS = 128
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
TOTAL_TIMEOUT = 15
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_NAT64_LOCAL = ipaddress.ip_network("64:ff9b:1::/48")
_CREDENTIAL_QUERY_NAMES = {
    "requestheaders",
    "headers",
    "authorization",
    "apikey",
    "apikeys",
    "accesstoken",
    "token",
    "password",
    "clientsecret",
    "connectionstring",
    "secret",
    "bearer",
    "auth",
    "authkey",
    "sastoken",
    "subscriptionkey",
    "signature",
    "pwd",
    "key",
    "sig",
    "se",
    "sp",
    "sv",
    "sr",
    "st",
    "skoid",
    "sktid",
    "skt",
    "ske",
    "sks",
    "skv",
    "si",
    "scid",
    "awsaccesskeyid",
    "googleaccessid",
    "accesskey",
    "secretkey",
    "privatekey",
    "credential",
    "credentials",
    "clientid",
    "consumerkey",
    "consumersecret",
    "oauthsecret",
}


class PreviewNetworkError(ValueError):
    """A deliberately non-sensitive preview network failure."""


def _public(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return _public(address.ipv4_mapped)
        if address in _NAT64:
            return _public(ipaddress.IPv4Address(int(address) & 0xFFFFFFFF))
        if (
            address in _NAT64_LOCAL
            or address.sixtofour is not None
            or address.teredo is not None
            or address.is_site_local
        ):
            return False
        # ISATAP embeds an IPv4 address in the interface identifier.
        if int(address) & 0xFFFFFFFF00000000 in {0x00005EFE00000000, 0x02005EFE00000000}:
            return False
    return address.is_global and not address.is_multicast and not address.is_reserved


def _canonical_origin(url: str, *, require_origin: bool = False) -> tuple[str, str, int]:
    if (
        not isinstance(url, str)
        or not url
        or any(ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F for char in url)
    ):
        raise PreviewNetworkError("Invalid preview resource URL.")
    try:
        parsed = urlsplit(url)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"} or not parsed.netloc or parsed.fragment:
            raise ValueError
        if require_origin and (parsed.path not in ("", "/") or parsed.query):
            raise ValueError
        if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
            raise ValueError
        host = parsed.hostname
        port = parsed.port
        if not host or "%" in host or not host.isascii():
            raise ValueError
        host = host.rstrip(".").lower()
        if (
            not host
            or host == "localhost"
            or host.endswith(".localhost")
            or "%" in host
            or not host.isascii()
            or (
                ":" not in host
                and (
                    len(host) > 253
                    or any(
                        not label
                        or len(label) > 63
                        or label.startswith("-")
                        or label.endswith("-")
                        or any(
                            not (char.isascii() and (char.isalnum() or char == "-"))
                            for char in label
                        )
                        for label in host.split(".")
                    )
                )
            )
        ):
            raise ValueError
        port = port or (443 if scheme == "https" else 80)
        if not 1 <= port <= 65535:
            raise ValueError
        for key, _ in parse_qsl(parsed.query, keep_blank_values=True):
            normalized = key.lower().replace("-", "").replace("_", "")
            if normalized.startswith(("xamz", "xgoog")) or normalized in _CREDENTIAL_QUERY_NAMES:
                raise PreviewNetworkError(
                    "Credential-like query parameters are not supported; "
                    "use a public URL without authentication parameters."
                )
        expected_host = f"[{host}]" if ":" in host else host
        expected_netloc = expected_host + (f":{port}" if parsed.port is not None else "")
        if parsed.netloc.lower() != expected_netloc.lower():
            raise ValueError
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None and not _public(literal):
            raise ValueError
        origin_host = f"[{host}]" if ":" in host else host
        origin = f"{scheme}://{origin_host}" + (
            f":{port}" if port != (443 if scheme == "https" else 80) else ""
        )
        return origin, host, port
    except PreviewNetworkError:
        raise
    except (ValueError, UnicodeError):
        raise PreviewNetworkError("Invalid or unsafe preview resource URL.") from None


@dataclass
class _Grant:
    token: str
    expires_at: float


@dataclass
class _Session:
    expires_at: float
    grants: dict[str, _Grant] = field(default_factory=dict)


class PreviewSessions:
    """Bounded preview sessions with an idle timeout and exact-origin grants."""

    def __init__(self, clock: Any = time.monotonic):
        self._clock = clock
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.RLock()

    def _session(self, preview_id: str) -> _Session:
        now = self._clock()
        expired = [key for key, session in self._sessions.items() if session.expires_at <= now]
        for key in expired:
            del self._sessions[key]
        session = self._sessions.get(preview_id)
        if session is None:
            raise PreviewNetworkError("Unknown or expired map preview.")
        return session

    def create(self) -> str:
        with self._lock:
            now = self._clock()
            for key in [
                key for key, session in self._sessions.items() if session.expires_at <= now
            ]:
                del self._sessions[key]
            if len(self._sessions) >= MAX_SESSIONS:
                raise PreviewNetworkError("Too many active map previews.")
            preview_id = secrets.token_urlsafe(32)
            self._sessions[preview_id] = _Session(now + SESSION_TTL)
            return preview_id

    def approve(self, preview_id: str, origin_url: str) -> dict[str, Any]:
        origin, _, _ = _canonical_origin(origin_url, require_origin=True)
        with self._lock:
            session = self._session(preview_id)
            now = self._clock()
            for key, existing in list(session.grants.items()):
                if existing.expires_at <= now:
                    del session.grants[key]
            grant = session.grants.get(origin)
            if grant is None and len(session.grants) >= MAX_ORIGINS:
                raise PreviewNetworkError("This map preview has too many approved origins.")
            # Refresh consent without invalidating tiles already using the live grant.
            token = grant.token if grant is not None else secrets.token_urlsafe(32)
            session.grants[origin] = _Grant(token, now + GRANT_TTL)
            session.expires_at = now + SESSION_TTL
            return {"grant": token, "expiresIn": GRANT_TTL}

    def authorize(self, preview_id: str, token: str, url: str) -> tuple[str, str, int]:
        # Validate session and token before URL parsing triggers any DNS/network work.
        with self._lock:
            session = self._session(preview_id)
            now = self._clock()
            for origin, grant in list(session.grants.items()):
                if grant.expires_at <= now:
                    del session.grants[origin]
            if (
                not isinstance(token, str)
                or not token.isascii()
                or not any(
                    secrets.compare_digest(grant.token, token) for grant in session.grants.values()
                )
            ):
                raise PreviewNetworkError("No valid consent grant for this map preview.")
            origin, host, port = _canonical_origin(url)
            grant = session.grants.get(origin)
            if grant is None or not secrets.compare_digest(grant.token, token):
                raise PreviewNetworkError(
                    "This resource origin is not approved for this map preview."
                )
            session.expires_at = now + SESSION_TTL
            return origin, host, port

    def close(self, preview_id: str) -> dict[str, bool]:
        with self._lock:
            self._sessions.pop(preview_id, None)
        return {"closed": True}


class _AuthorizedStream(httpcore.AsyncNetworkStream):
    """Revalidate the grant immediately before sending HTTP request bytes."""

    def __init__(self, stream: httpcore.AsyncNetworkStream, reauthorize: Callable[[], None]):
        self._stream = stream
        self._reauthorize = reauthorize

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return await self._stream.read(max_bytes, timeout)

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self._reauthorize()
        await self._stream.write(buffer, timeout)

    async def aclose(self) -> None:
        await self._stream.aclose()

    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        stream = await self._stream.start_tls(ssl_context, server_hostname, timeout)
        return _AuthorizedStream(stream, self._reauthorize)

    def get_extra_info(self, info: str) -> Any:
        return self._stream.get_extra_info(info)


class _PinnedBackend(httpcore.AsyncNetworkBackend):
    """Resolves once and connects only to checked addresses, never the hostname."""

    def __init__(self, reauthorize: Callable[[], None]):
        self._inner = httpcore.AnyIOBackend()
        self._reauthorize = reauthorize

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        try:
            self._reauthorize()
            records = await anyio.getaddrinfo(host, port, type=socket.SOCK_STREAM)
            addresses = list(
                dict.fromkeys(ipaddress.ip_address(row[4][0].split("%", 1)[0]) for row in records)
            )
            if not addresses or any(not _public(address) for address in addresses):
                raise PreviewNetworkError("The resource host resolves to a non-public address.")
            error = None
            for address in addresses:
                try:
                    self._reauthorize()
                    stream = await self._inner.connect_tcp(
                        str(address),
                        port,
                        timeout=timeout,
                        local_address=local_address,
                        socket_options=socket_options,
                    )
                    try:
                        self._reauthorize()
                    except PreviewNetworkError:
                        await stream.aclose()
                        raise
                    return _AuthorizedStream(stream, self._reauthorize)
                except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                    error = exc
            if error is not None:
                raise error
            raise PreviewNetworkError("The resource host could not be reached.")
        except PreviewNetworkError:
            raise
        except (OSError, ValueError, httpcore.NetworkError):
            raise PreviewNetworkError("The resource host could not be safely reached.") from None

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise PreviewNetworkError("Local sockets are not allowed for map previews.")

    async def sleep(self, seconds):
        await anyio.sleep(seconds)


async def fetch_resource(
    sessions: PreviewSessions, preview_id: str, grant: str, url: str
) -> dict[str, Any]:
    """Fetch one consented public HTTP resource and return bounded binary bytes."""
    sessions.authorize(preview_id, grant, url)

    def reauthorize() -> None:
        sessions.authorize(preview_id, grant, url)

    ssl_context = httpcore.default_ssl_context()
    pool = httpcore.AsyncConnectionPool(
        ssl_context=ssl_context,
        max_connections=1,
        max_keepalive_connections=0,
        retries=0,
        http2=False,
        network_backend=_PinnedBackend(reauthorize),
    )
    body = bytearray()
    started = time.monotonic()
    try:
        with anyio.fail_after(TOTAL_TIMEOUT):
            async with pool.stream(
                "GET",
                url,
                headers=[
                    (b"accept-encoding", b"identity"),
                    (b"user-agent", b"GeoLibre-MCP-Preview"),
                ],
                extensions={
                    "timeout": {
                        "connect": TOTAL_TIMEOUT,
                        "read": TOTAL_TIMEOUT,
                        "write": TOTAL_TIMEOUT,
                    }
                },
            ) as response:
                if response.status >= 300 and response.status < 400:
                    raise PreviewNetworkError(
                        "Resource redirects are not allowed; use the direct destination URL."
                    )
                if response.status < 200 or response.status >= 300:
                    raise PreviewNetworkError(
                        f"The resource server returned HTTP {response.status}."
                    )
                headers = {key.lower(): value for key, value in response.headers}
                encoding = headers.get(b"content-encoding", b"identity").strip().lower()
                if encoding not in {b"", b"identity"}:
                    raise PreviewNetworkError("Compressed resource responses are not supported.")
                if int(headers.get(b"content-length", b"0")) > MAX_RESPONSE_BYTES:
                    raise PreviewNetworkError("The resource response exceeds the 4 MiB limit.")
                async for chunk in response.aiter_stream():
                    if time.monotonic() - started > TOTAL_TIMEOUT:
                        raise PreviewNetworkError("The resource response exceeded its time limit.")
                    if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise PreviewNetworkError("The resource response exceeds the 4 MiB limit.")
                    body.extend(chunk)
                mime = (
                    headers.get(b"content-type", b"application/octet-stream")
                    .decode("ascii", "ignore")
                    .split(";", 1)[0]
                    .strip()
                )
                result: dict[str, Any] = {
                    "data": base64.b64encode(body).decode("ascii"),
                    "mimeType": mime or "application/octet-stream",
                }
                for key, field_name in (
                    (b"cache-control", "cacheControl"),
                    (b"expires", "expires"),
                ):
                    value = headers.get(key)
                    if (
                        value
                        and len(value) <= 1024
                        and all(byte >= 0x20 and byte != 0x7F for byte in value)
                    ):
                        result[field_name] = value.decode("ascii", "ignore")
                return result
    except (TimeoutError, httpcore.TimeoutException):
        raise PreviewNetworkError(
            "The resource response exceeded its 15-second time limit."
        ) from None
    except PreviewNetworkError:
        raise
    except (httpcore.NetworkError, httpcore.ProtocolError, OSError, ssl.SSLError, ValueError):
        raise PreviewNetworkError("The resource could not be fetched safely.") from None
    finally:
        await pool.aclose()
