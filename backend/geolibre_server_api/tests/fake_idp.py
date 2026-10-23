"""An in-process OpenID Connect provider served through ``httpx.MockTransport``.

Tests hand ``FakeIdp.transport`` to ``create_app(oidc_transport=...)`` so no
test reaches the network. ``issue`` registers the claims a code redeems to;
the token endpoint verifies client authentication and PKCE before signing them.
"""

from __future__ import annotations

import base64
import functools
import hashlib
import time
from collections.abc import Callable
from urllib.parse import parse_qs

import httpx
from joserfc import jwt
from joserfc.jwk import RSAKey


@functools.cache
def _default_key() -> RSAKey:
    # RSA generation is slow; every app fixture builds a FakeIdp, and only
    # rotation needs a fresh key.
    return RSAKey.generate_key(2048, parameters={"kid": "k1"})


def b64url_sha256(value: str) -> str:
    digest = hashlib.sha256(value.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


class FakeIdp:
    ISSUER = "https://idp.example"
    CLIENT_ID = "geolibre-sso"
    CLIENT_SECRET = "s3cret"

    def __init__(self, clock=None):
        """*clock* is the suite's ``TestClock``; ``None`` uses the wall clock."""
        self.clock = clock
        self.key = _default_key()
        self.codes: dict[str, tuple[dict, str]] = {}
        self.jwks_calls = 0
        # A raw token, or a function of the issued claims, returned by the next
        # token request instead of the normally signed claims.
        self.next_id_token: str | Callable[[dict], str] | None = None
        self.transport = httpx.MockTransport(self.handle)

    def now(self) -> int:
        return self.clock.now() if self.clock is not None else int(time.time())

    def rotate(self, kid: str) -> None:
        self.key = RSAKey.generate_key(2048, parameters={"kid": kid})

    def base_claims(self, sub: str, **extra) -> dict:
        now = self.now()
        claims = {"iss": self.ISSUER, "aud": self.CLIENT_ID, "iat": now, "exp": now + 300}
        return {**claims, "sub": sub, **extra}

    def sign(self, claims: dict, *, alg: str = "RS256", key=None, kid: str | None = None) -> str:
        key = key or self.key
        header = {"alg": alg}
        kid = kid if kid is not None else key.kid
        if kid is not None:
            header["kid"] = kid
        return jwt.encode(header, claims, key)

    def issue(self, code: str, claims: dict, code_challenge: str) -> None:
        self.codes[code] = (claims, code_challenge)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "GET" and url == f"{self.ISSUER}/.well-known/openid-configuration":
            return httpx.Response(
                200,
                json={
                    "issuer": self.ISSUER,
                    "authorization_endpoint": f"{self.ISSUER}/authorize",
                    "token_endpoint": f"{self.ISSUER}/token",
                    "jwks_uri": f"{self.ISSUER}/jwks",
                },
            )
        if request.method == "GET" and url == f"{self.ISSUER}/jwks":
            self.jwks_calls += 1
            return httpx.Response(200, json={"keys": [self.key.as_dict(private=False)]})
        if request.method == "POST" and url == f"{self.ISSUER}/token":
            return self._token(request)
        return httpx.Response(404)

    def _token(self, request: httpx.Request) -> httpx.Response:
        credentials = base64.b64encode(f"{self.CLIENT_ID}:{self.CLIENT_SECRET}".encode()).decode()
        if request.headers.get("authorization") != f"Basic {credentials}":
            return httpx.Response(401, json={"error": "invalid_client"})
        form = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
        entry = self.codes.pop(form.get("code", ""), None)
        if entry is None or form.get("grant_type") != "authorization_code":
            return httpx.Response(400, json={"error": "invalid_grant"})
        claims, challenge = entry
        if b64url_sha256(form.get("code_verifier", "")) != challenge:
            return httpx.Response(400, json={"error": "invalid_grant"})
        override, self.next_id_token = self.next_id_token, None
        if override is None:
            id_token = self.sign(claims)
        elif callable(override):
            id_token = override(claims)
        else:
            id_token = override
        return httpx.Response(200, json={"id_token": id_token, "token_type": "Bearer"})
