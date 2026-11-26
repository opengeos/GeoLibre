import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isIdentityConfigured,
  signIdentityToken,
  verifyIdentityToken,
} from "../packages/collab-core/src/index.ts";

const SECRET = "relay-issuer-secret";

// Minted by `sign_collab_identity_token` in backend/geolibre_server_api
// (pinned in tests/test_collab_identity.py there): the relay must accept the
// server API's tokens byte for byte.
const SERVER_API_TOKEN =
  "eyJwcm92aWRlciI6Imdlb2xpYnJlIiwidXNlcklkIjoidS0xIiwidXNlcm5hbWUiOiJBZGEgTG92ZWxhY2UiLCJleHAiOjQxMDI0NDQ4MDB9" +
  ".cgXPTdcpCie9rzq7rrl8xtYIUYEONhRQxQ-9nq-Cy0s";

const SERVER_API_UNICODE_TOKEN =
  "eyJwcm92aWRlciI6Imdlb2xpYnJlIiwidXNlcklkIjoidS0yIiwidXNlcm5hbWUiOiJab8OrIiwiZXhwIjo0MTAyNDQ0ODAwfQ" +
  ".hMbtKwWLurrnpkQLVr3kSroEaxJKZ8nj_KtYCrsDSLg";

describe("collaboration identity tokens", () => {
  it("matches the server API byte for byte for a non-ASCII username", async () => {
    assert.equal(
      (await verifyIdentityToken(SERVER_API_UNICODE_TOKEN, "pinned-secret"))?.username,
      "Zoë",
    );
    assert.equal(
      await signIdentityToken(
        { provider: "geolibre", userId: "u-2", username: "Zoë", exp: 4102444800 },
        "pinned-secret",
      ),
      SERVER_API_UNICODE_TOKEN,
    );
  });

  it("accepts a token minted by the server API, and mints the same bytes", async () => {
    assert.deepEqual(await verifyIdentityToken(SERVER_API_TOKEN, "pinned-secret"), {
      provider: "geolibre",
      userId: "u-1",
      username: "Ada Lovelace",
    });
    assert.equal(
      await signIdentityToken(
        { provider: "geolibre", userId: "u-1", username: "Ada Lovelace", exp: 4102444800 },
        "pinned-secret",
      ),
      SERVER_API_TOKEN,
    );
    assert.equal(await verifyIdentityToken(SERVER_API_TOKEN, "other-secret"), null);
  });

  it("round-trips a signed token", async () => {
    const token = await signIdentityToken(
      { provider: "geolibre", userId: "u-1", username: "Ada" },
      SECRET,
    );
    assert.deepEqual(await verifyIdentityToken(token, SECRET), {
      provider: "geolibre",
      userId: "u-1",
      username: "Ada",
    });
  });

  it("defaults a missing provider and sanitizes the display name", async () => {
    const token = await signIdentityToken({ userId: "u-2", username: "  Grace  " }, SECRET);
    assert.deepEqual(await verifyIdentityToken(token, SECRET), {
      provider: "geolibre",
      userId: "u-2",
      username: "Grace",
    });
  });

  it("preserves a non-ASCII username through the base64url round trip", async () => {
    const token = await signIdentityToken({ userId: "u-3", username: "Ada Ökonom 数据" }, SECRET);
    const identity = await verifyIdentityToken(token, SECRET);
    assert.equal(identity?.username, "Ada Ökonom 数据");
  });

  it("rejects a self-asserted token, the shape the relay used to trust", async () => {
    const raw = JSON.stringify({ provider: "geolibre", userId: "admin", username: "Admin" });
    assert.equal(await verifyIdentityToken(raw, SECRET), null);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signIdentityToken({ userId: "u-4", username: "Mallory" }, "other-secret");
    assert.equal(await verifyIdentityToken(token, SECRET), null);
  });

  it("rejects a token whose payload was edited after signing", async () => {
    const token = await signIdentityToken({ userId: "u-5", username: "Ada" }, SECRET);
    const signature = token.slice(token.indexOf(".") + 1);
    const forged = Buffer.from(JSON.stringify({ userId: "root", username: "Root" }))
      .toString("base64url")
      .concat(".", signature);
    assert.equal(await verifyIdentityToken(forged, SECRET), null);
  });

  it("returns null for every token when no secret is configured", async () => {
    const token = await signIdentityToken({ userId: "u-6", username: "Ada" }, SECRET);
    assert.equal(await verifyIdentityToken(token, undefined), null);
    assert.equal(await verifyIdentityToken(token, ""), null);
  });

  it("honors expiry", async () => {
    const nowMs = 1_700_000_000_000;
    const expired = await signIdentityToken(
      { userId: "u-7", username: "Ada", exp: nowMs / 1000 - 1 },
      SECRET,
    );
    assert.equal(await verifyIdentityToken(expired, SECRET, nowMs), null);

    const live = await signIdentityToken(
      { userId: "u-7", username: "Ada", exp: nowMs / 1000 + 60 },
      SECRET,
    );
    assert.equal((await verifyIdentityToken(live, SECRET, nowMs))?.userId, "u-7");
  });

  it("rejects malformed tokens without throwing", async () => {
    for (const token of [
      "",
      "no-dot",
      ".sig",
      "payload.",
      "a.b.c",
      "not base64!.sig",
      42,
      null,
      undefined,
      {},
    ]) {
      assert.equal(await verifyIdentityToken(token, SECRET), null);
    }
  });

  it("rejects a validly signed token missing required claims", async () => {
    for (const claims of [{}, { userId: "u-8" }, { username: "Ada" }, { userId: 1, username: 2 }]) {
      const token = await signIdentityToken(claims as never, SECRET);
      assert.equal(await verifyIdentityToken(token, SECRET), null);
    }
  });

  it("reports whether an issuer is configured", () => {
    assert.equal(isIdentityConfigured(SECRET), true);
    assert.equal(isIdentityConfigured(""), false);
    assert.equal(isIdentityConfigured(undefined), false);
    assert.equal(isIdentityConfigured(null), false);
  });
});
