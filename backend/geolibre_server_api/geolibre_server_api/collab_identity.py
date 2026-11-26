"""Identity credentials for GeoLibre's live-collaboration relay.

The relay (``workers/collab`` or ``workers/collab-node``) attributes presence
and edits to an account when a joiner presents an ``identityToken`` it can
verify. This module lets a signed-in account obtain one: an authenticated
``POST /api/collab/identity-token`` returns a short-lived token in the relay's
format, signed with a secret this server shares with the relay:

    <base64url(payload JSON)>.<base64url(HMAC-SHA256(secret, base64url(payload JSON)))>

with claims ``{provider, userId, username, exp}`` (see
``packages/collab-core/src/identity.ts``). The relay never sees the account's
OAuth access token or personal token, only this narrowly scoped, minutes-long
credential, and needs no network access to this server to check it.

Disabled unless ``GEOLIBRE_COLLAB_IDENTITY_SECRET`` is set; the relay must be
configured with the same value as ``COLLAB_IDENTITY_SECRET``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from collections.abc import Callable

from fastapi import APIRouter, Depends, Response
from fastapi.responses import JSONResponse

from geolibre_server_api.auth import AuthPrincipal, get_clock, iso_ts, require_any_scope

COLLAB_IDENTITY_SECRET_ENV = "GEOLIBRE_COLLAB_IDENTITY_SECRET"
COLLAB_IDENTITY_TTL_ENV = "GEOLIBRE_COLLAB_IDENTITY_TTL_SECONDS"
DEFAULT_TTL_SECONDS = 300
MAX_TTL_SECONDS = 3600
PROVIDER = "geolibre"
MIN_SECRET_LENGTH = 32


def _b64url(data: bytes) -> str:
    """Encode bytes as unpadded base64url.

    Args:
        data: The bytes to encode.

    Returns:
        The base64url text without ``=`` padding.
    """
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_collab_identity_token(claims: dict, secret: str) -> str:
    """Sign identity claims in the relay's two-segment token format.

    The signature covers the encoded payload segment, as the relay's
    ``verifyIdentityToken`` checks it.

    Args:
        claims: The token claims (``provider``, ``userId``, ``username``, ``exp``).
        secret: The HMAC secret shared with the relay.

    Returns:
        The token string.
    """
    payload = _b64url(json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode())
    signature = hmac.new(secret.encode(), payload.encode("ascii"), hashlib.sha256).digest()
    return f"{payload}.{_b64url(signature)}"


def collab_identity_ttl() -> int:
    """Read the token lifetime from the environment.

    Returns:
        Seconds between issue and expiry: the configured positive integer,
        capped at one hour, or five minutes when unset or invalid.
    """
    raw = os.getenv(COLLAB_IDENTITY_TTL_ENV, "").strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_TTL_SECONDS
    return min(value, MAX_TTL_SECONDS) if value > 0 else DEFAULT_TTL_SECONDS


def build_collab_identity_router(secret: str | None, ttl_seconds: int) -> APIRouter:
    """Build the route that mints collaboration identity tokens.

    Args:
        secret: The HMAC secret shared with the relay; empty or ``None``
            disables the route (it answers 404).
        ttl_seconds: Lifetime of each token.

    Returns:
        The router to include in the app.
    """
    # Anyone with write access can mint tokens and so obtain known-plaintext
    # HMACs; a short secret could be brute-forced offline into forged
    # identities for every account.
    if secret and len(secret) < MIN_SECRET_LENGTH:
        raise ValueError(
            f"{COLLAB_IDENTITY_SECRET_ENV} must be at least {MIN_SECRET_LENGTH} characters"
        )
    router = APIRouter()

    @router.post("/api/collab/identity-token")
    def mint_collab_identity_token(
        response: Response,
        # A relay identity lets its holder join and edit sessions as the
        # account, so it needs the account's write grant, not read alone.
        principal: AuthPrincipal = Depends(require_any_scope("write:projects")),
        clock: Callable[[], int] = Depends(get_clock),
    ):
        """Return a short-lived relay identity token for the signed-in account."""
        if not secret:
            return JSONResponse(
                {"error": "collaboration identity is not configured"},
                status_code=404,
                headers={"Cache-Control": "no-store"},
            )
        account = principal.account
        # The relay requires a username claim; an identity-provider account
        # may not have one yet. Same sentinel as project creation.
        if not account.username:
            return JSONResponse(
                {"error": "username required"},
                status_code=400,
                headers={"Cache-Control": "no-store"},
            )
        expires_at = clock() + ttl_seconds
        token = sign_collab_identity_token(
            {
                "provider": PROVIDER,
                "userId": account.id,
                "username": account.username,
                "exp": expires_at,
            },
            secret,
        )
        response.headers["Cache-Control"] = "no-store"
        return {"token": token, "provider": PROVIDER, "expiresAt": iso_ts(expires_at)}

    return router
