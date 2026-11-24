"""Built-in request-body size limit and per-client rate limiting.

Both are plain ASGI middleware with no extra dependencies. They are a baseline
for small deployments, not a replacement for an ingress limiter: rate-limit
counters live in each worker process, so N workers (or N replicas) admit up to
N times the configured rate.
"""

from __future__ import annotations

import ipaddress
import logging
import math
import os
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from itertools import islice

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse

from geolibre_server_api.proxy_identity import client_ip

# Routes that run credential operations, send mail, or call an identity provider:
# the same set docs/server-api.md tells operators to rate-limit at the ingress.
AUTH_PATH_RE = re.compile(
    r"^/(oauth/(authorize|token|sso/callback)|api/(auth/(token|password-reset/(request|confirm)|verify-email/(request|confirm))|accounts|account/(password|mfa/totp(/(enroll|confirm))?)))$"
)
DEFAULT_AUTH_RATE = "30/60"
DEFAULT_API_RATE = "600/60"
MAX_TRACKED_CLIENTS = 100_000
logger = logging.getLogger(__name__)


class RequestBodyTooLarge(HTTPException):
    """Raised from the wrapped ``receive`` once a body passes the ceiling.

    A FastAPI ``HTTPException`` so the body parser re-raises it unchanged and
    the app's handler renders the usual ``{"error": ...}`` 413.
    """

    def __init__(self) -> None:
        super().__init__(413, "request body too large")


class BodySizeLimitMiddleware:
    """Reject request bodies larger than ``max_bytes``.

    A declared ``Content-Length`` past the limit is refused before any byte is
    read. A body without one (chunked, HTTP/2) is counted as it streams and
    refused as soon as it crosses the limit, so it is never buffered in full.
    """

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        for name, value in scope.get("headers", ()):
            if name == b"content-length":
                if value.isdigit() and int(value) > self.max_bytes:
                    await _too_large(scope, receive, send)
                    return
                break

        received = 0
        limit = self.max_bytes

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise RequestBodyTooLarge()
            return message

        started = False

        async def tracking_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except RequestBodyTooLarge:
            if started:
                raise
            await _too_large(scope, receive, send)


async def _too_large(scope, receive, send) -> None:
    response = JSONResponse({"error": "request body too large"}, status_code=413)
    response.headers["Connection"] = "close"
    await response(scope, receive, send)


@dataclass(frozen=True)
class Rate:
    """A request budget: ``limit`` requests per ``window`` seconds."""

    limit: int
    window: int


def parse_rate(name: str, default: str) -> Rate | None:
    """Read a ``<requests>/<seconds>`` rate from the environment.

    Args:
        name: The environment variable.
        default: The value used when the variable is unset or blank.

    Returns:
        The parsed rate, or ``None`` when the value is ``0`` or ``off``
        (limiting disabled).

    Raises:
        RuntimeError: If the value is malformed, so a typo fails startup
            instead of silently disabling the limit.
    """
    raw = os.getenv(name, "").strip() or default
    if raw.lower() in {"0", "off", "false", "no", "none"}:
        return None
    match = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", raw)
    if not match or int(match.group(1)) <= 0 or int(match.group(2)) <= 0:
        raise RuntimeError(
            f"{name} must be '<requests>/<seconds>' (for example {default!r}) or 'off': {raw!r}"
        )
    return Rate(int(match.group(1)), int(match.group(2)))


class FixedWindowLimiter:
    """Thread-safe fixed-window counters keyed by client and route class.

    Memory is bounded: once ``max_keys`` clients are tracked, expired windows
    are dropped, and if that is not enough the oldest windows go first.
    Eviction frees at least a tenth of capacity to amortize cleanup under churn.
    """

    def __init__(
        self,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = MAX_TRACKED_CLIENTS,
    ):
        self._clock = clock
        self._max_keys = max_keys
        self._windows: dict[tuple[str, str], tuple[float, int]] = {}
        self._lock = threading.Lock()

    def hit(self, key: tuple[str, str], rate: Rate) -> float | None:
        """Count one request.

        Args:
            key: ``(bucket, client)`` identifying the counter.
            rate: The budget for this bucket.

        Returns:
            ``None`` when the request is allowed, otherwise the seconds until
            the window resets.
        """
        now = self._clock()
        with self._lock:
            expiry, count = self._windows.get(key, (now + rate.window, 0))
            if now >= expiry:
                expiry, count = now + rate.window, 0
                # Reinserting keeps dictionary order aligned with window starts.
                self._windows.pop(key, None)
            if count >= rate.limit:
                return max(0.0, expiry - now)
            if key not in self._windows and len(self._windows) >= self._max_keys:
                self._evict(now)
            self._windows[key] = (expiry, count + 1)
            return None

    def _evict(self, now: float) -> None:
        """Free a batch of slots using each window's own expiry.

        Args:
            now: The current monotonic time. The caller must hold the lock.
        """
        expired = [k for k, (expiry, _count) in self._windows.items() if now >= expiry]
        for k in expired:
            del self._windows[k]
        target = self._max_keys - max(1, self._max_keys // 10)
        overflow = len(self._windows) - target
        if overflow > 0:
            # All expired windows were removed above using their own expiry.
            # Shed the earliest-started remaining windows regardless of their
            # configured duration, without sorting on the request-path lock.
            for k in list(islice(self._windows, overflow)):
                del self._windows[k]


class RateLimitMiddleware:
    """Per-client-IP rate limiting with a stricter budget for credential routes.

    The client is the direct peer, or the ``X-Forwarded-For`` address when the
    peer is in ``GEOLIBRE_TRUSTED_PROXIES``. CORS preflights and ``/health``
    are never counted. IPv6 addresses in one /64 share a budget, preventing
    clients from resetting their budget by rotating host addresses.
    """

    def __init__(
        self,
        app,
        auth_rate: Rate | None,
        api_rate: Rate | None,
        limiter: FixedWindowLimiter | None = None,
    ):
        self.app = app
        self.auth_rate = auth_rate
        self.api_rate = api_rate
        self.limiter = limiter or FixedWindowLimiter()
        self._warned_missing_client = False

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if path == "/health":
            await self.app(scope, receive, send)
            return
        if AUTH_PATH_RE.match(path):
            bucket, rate = "auth", self.auth_rate
        else:
            bucket, rate = "api", self.api_rate
        if rate is None:
            await self.app(scope, receive, send)
            return
        address = client_ip(Request(scope))
        if address is None and not self._warned_missing_client:
            self._warned_missing_client = True
            logger.warning(
                "Rate limiting has no client address; requests share the unknown-client "
                "budget. Configure the ASGI server to supply the original peer address."
            )
        if isinstance(address, ipaddress.IPv6Address):
            address = ipaddress.IPv6Network((address, 64), strict=False)
        retry_after = self.limiter.hit((bucket, str(address or "unknown")), rate)
        if retry_after is None:
            await self.app(scope, receive, send)
            return
        response = JSONResponse(
            {"error": "too many requests; try again later"},
            status_code=429,
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )
        await response(scope, receive, send)
