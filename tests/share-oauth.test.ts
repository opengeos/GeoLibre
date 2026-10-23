// Security-boundary and refresh-failure tests for the share server's web OAuth
// client. The popup/message/exchange flow itself needs a browser and is covered
// by the live verification in the PR.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveCallbackUrl,
  getShareAccessToken,
  oauthEndpointUrl,
  randomUrlSafeToken,
  resolveShareIssuer,
  resolveShareRequestToken,
  s256Challenge,
  ShareOAuthError,
  signInToShare,
  signOutOfShare,
  useShareOAuthStore,
  validateCallbackPayload,
} from "../apps/geolibre-desktop/src/lib/share-oauth";

function installRefreshEnvironment(issuer: string, fetchImpl: typeof fetch) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const storage = new Map<string, string>([
    [`geolibre-share-oauth:${issuer}`, JSON.stringify({ refreshToken: "refresh-token" })],
  ]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost" },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      setTimeout,
      clearTimeout,
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  });
  return {
    storage,
    restore() {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
      else Reflect.deleteProperty(globalThis, "fetch");
    },
  };
}

describe("refresh failure handling", () => {
  it("keeps the session and reports a retryable error on network failure", async () => {
    const issuer = "https://network-failure.example";
    const env = installRefreshEnvironment(issuer, async () => {
      throw new TypeError("offline");
    });
    try {
      await assert.rejects(
        getShareAccessToken(issuer),
        (error: unknown) =>
          error instanceof ShareOAuthError && error.code === "refresh-unavailable",
      );
      assert.equal(
        env.storage.get(`geolibre-share-oauth:${issuer}`),
        JSON.stringify({ refreshToken: "refresh-token" }),
      );
    } finally {
      env.restore();
    }
  });

  it("keeps the session on temporary server errors", async () => {
    const issuer = "https://server-failure.example";
    const env = installRefreshEnvironment(
      issuer,
      async () =>
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    );
    try {
      await assert.rejects(
        getShareAccessToken(issuer),
        (error: unknown) =>
          error instanceof ShareOAuthError && error.code === "refresh-unavailable",
      );
      assert.equal(
        env.storage.get(`geolibre-share-oauth:${issuer}`),
        JSON.stringify({ refreshToken: "refresh-token" }),
      );
    } finally {
      env.restore();
    }
  });

  it("clears a session only after the server confirms an invalid grant", async () => {
    const issuer = "https://invalid-grant.example";
    const env = installRefreshEnvironment(
      issuer,
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    try {
      assert.equal(await getShareAccessToken(issuer), null);
      assert.equal(env.storage.has(`geolibre-share-oauth:${issuer}`), false);
    } finally {
      env.restore();
    }
  });

  it("cancels oversized token responses without dropping the session", async () => {
    const issuer = "https://oversized-response.example";
    let cancelled = false;
    const env = installRefreshEnvironment(
      issuer,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
    );
    try {
      await assert.rejects(
        getShareAccessToken(issuer),
        (error: unknown) =>
          error instanceof ShareOAuthError && error.code === "refresh-unavailable",
      );
      assert.equal(cancelled, true);
      assert.equal(
        env.storage.get(`geolibre-share-oauth:${issuer}`),
        JSON.stringify({ refreshToken: "refresh-token" }),
      );
    } finally {
      env.restore();
    }
  });
});

describe("resolveShareRequestToken", () => {
  it("returns the pasted personal token when OAuth is unsupported", async () => {
    // No window under the test loader, so the web OAuth flow is unavailable.
    assert.equal(await resolveShareRequestToken("  pat-token  "), "pat-token");
  });

  it("falls back to the personal token when the OAuth refresh is unavailable", async () => {
    const issuer = "https://request-token-fallback.example";
    const env = installRefreshEnvironment(issuer, async () => {
      throw new TypeError("offline");
    });
    try {
      assert.equal(await resolveShareRequestToken("pat-token", issuer), "pat-token");
    } finally {
      env.restore();
    }
  });

  it("rethrows a refresh failure when no personal token is configured", async () => {
    const issuer = "https://request-token-no-fallback.example";
    const env = installRefreshEnvironment(issuer, async () => {
      throw new TypeError("offline");
    });
    try {
      await assert.rejects(
        resolveShareRequestToken("", issuer),
        (error: unknown) =>
          error instanceof ShareOAuthError && error.code === "refresh-unavailable",
      );
    } finally {
      env.restore();
    }
  });
});

describe("sign-in stale result handling", () => {
  it("does not restore the session when sign-out races with token exchange", async () => {
    const issuer = "https://share.example";
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const storage = new Map<string, string>();
    const popup = {
      closed: false,
      location: { href: "about:blank" },
      close() {
        this.closed = true;
      },
    };
    const messageListenerReady = Promise.withResolvers<void>();
    const exchangeStarted = Promise.withResolvers<void>();
    const exchange = Promise.withResolvers<Response>();
    let messageHandler: ((event: MessageEvent) => void) | null = null;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "https://app.example" },
        crypto,
        open: () => popup,
        sessionStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
        addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
          messageHandler = listener;
          messageListenerReady.resolve();
        },
        removeEventListener: () => {},
        setTimeout: () => 1,
        clearTimeout: () => {},
        setInterval: () => 1,
        clearInterval: () => {},
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: () => {
        exchangeStarted.resolve();
        return exchange.promise;
      },
    });

    try {
      const signIn = signInToShare(issuer);
      await messageListenerReady.promise;

      // Assigned inside the addEventListener fake, which TS cannot see, so it
      // would otherwise narrow the `let` to its initial null.
      const handler = messageHandler as ((event: MessageEvent) => void) | null;
      assert.ok(handler, "consent callback listener was not installed");
      const authorizeUrl = new URL(popup.location.href);
      handler({
        origin: "https://app.example",
        source: popup,
        data: {
          type: "geolibre-share-oauth",
          code: "authorization-code",
          state: authorizeUrl.searchParams.get("state"),
          iss: issuer,
        },
      } as unknown as MessageEvent);
      await exchangeStarted.promise;

      await signOutOfShare(issuer);
      exchange.resolve(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
      await signIn;

      assert.equal(storage.has(`geolibre-share-oauth:${issuer}`), false);
      assert.equal(await getShareAccessToken(issuer), null);
      assert.equal(useShareOAuthStore.getState().issuer, null);
      assert.equal(useShareOAuthStore.getState().pending, false);
      assert.equal(popup.closed, true);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
      else Reflect.deleteProperty(globalThis, "fetch");
    }
  });
});

describe("randomUrlSafeToken", () => {
  // RFC 7636 requires a 43–128 character verifier. 32 bytes → 43 base64url
  // characters, exactly the server's PKCE_VERIFIER_RE floor.
  it("produces 43-character unpadded baseurl tokens", () => {
    const token = randomUrlSafeToken();
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(!token.includes("="));
  });

  it("is random across calls", () => {
    assert.notEqual(randomUrlSafeToken(), randomUrlSafeToken());
  });
});

describe("s256Challenge", () => {
  // RFC 7636 appendix B vector: proves the derivation is base64url(SHA-256),
  // not a near miss (e.g. padded, or hashing the wrong encoding).
  it("matches the RFC 7636 known-answer vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert.equal(await s256Challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("differs per verifier", async () => {
    assert.notEqual(await s256Challenge("a".repeat(43)), await s256Challenge("b".repeat(43)));
  });
});

describe("resolveShareIssuer", () => {
  it("normalizes hostname casing and explicit default ports", () => {
    assert.equal(
      resolveShareIssuer("https://SHARE.Example:443/services/"),
      "https://share.example/services",
    );
  });

  it("preserves non-default ports and IPv6 authority", () => {
    assert.equal(
      resolveShareIssuer("https://[2001:DB8::1]:8443/path"),
      "https://[2001:db8::1]:8443/path",
    );
  });

  it("returns null for missing or invalid issuers", () => {
    assert.equal(resolveShareIssuer(""), null);
    assert.equal(resolveShareIssuer("not a URL"), null);
  });

  it("validates explicit base URLs before resolving the issuer", () => {
    assert.equal(resolveShareIssuer("http://share.example"), null);
    assert.equal(resolveShareIssuer("https://user:pass@share.example"), null);
    assert.equal(resolveShareIssuer("https://share.example/?tenant=private"), null);
    assert.equal(resolveShareIssuer("https://share.example/#section"), null);
  });
});

describe("deriveCallbackUrl", () => {
  const APP = "https://app.example";

  it("lands on the app origin's callback at the root base", () => {
    assert.equal(deriveCallbackUrl(APP, "/"), `${APP}/oauth-callback.html`);
  });

  it("honors a subpath deployment base", () => {
    assert.equal(deriveCallbackUrl(APP, "/demo/"), `${APP}/demo/oauth-callback.html`);
  });

  it("repairs a base missing its trailing slash", () => {
    assert.equal(deriveCallbackUrl(APP, "/demo"), `${APP}/demo/oauth-callback.html`);
  });

  it("resolves a relative base from the current document path", () => {
    assert.equal(deriveCallbackUrl(APP, "./", `${APP}/demo/`), `${APP}/demo/oauth-callback.html`);
  });
});

describe("oauthEndpointUrl", () => {
  it("preserves a path-mounted issuer", () => {
    assert.equal(
      oauthEndpointUrl("https://share.example/geolibre", "authorize").toString(),
      "https://share.example/geolibre/oauth/authorize",
    );
  });
});

describe("validateCallbackPayload", () => {
  const expected = { state: "st".repeat(16), issuer: "https://share.example" };
  const message = (overrides: Record<string, unknown> = {}) => ({
    type: "geolibre-share-oauth",
    code: "abc123",
    state: expected.state,
    iss: expected.issuer,
    ...overrides,
  });

  it("accepts a well-formed message carrying the code", () => {
    const verdict = validateCallbackPayload(message(), expected);
    assert.deepEqual(verdict, { ok: true, code: "abc123" });
  });

  it("accepts a message without iss (the parameter is optional)", () => {
    const { iss: _iss, ...withoutIssuer } = message();
    const verdict = validateCallbackPayload(withoutIssuer, expected);
    assert.deepEqual(verdict, { ok: true, code: "abc123" });
  });

  it("rejects a foreign message type outright", () => {
    const verdict = validateCallbackPayload(message({ type: "something-else" }), expected);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "malformed");
  });

  it("rejects a state that does not match exactly", () => {
    for (const state of [`${expected.state}x`, expected.state.slice(1), ""]) {
      const verdict = validateCallbackPayload(message({ state }), expected);
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.code, "state-mismatch");
    }
  });

  it("rejects a mismatched issuer (mix-up defense)", () => {
    const verdict = validateCallbackPayload(message({ iss: "https://evil.example" }), expected);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "issuer-mismatch");
  });

  it("maps an error response to access-denied", () => {
    const verdict = validateCallbackPayload(
      message({ error: "access_denied", code: undefined }),
      expected,
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "access-denied");
  });

  it("rejects a payload without a usable code", () => {
    const verdict = validateCallbackPayload(message({ code: "" }), expected);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "malformed");
  });

  it("rejects non-object payloads", () => {
    for (const payload of [null, undefined, "geolibre-share-oauth", 42]) {
      const verdict = validateCallbackPayload(payload, expected);
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.code, "malformed");
    }
  });
});
