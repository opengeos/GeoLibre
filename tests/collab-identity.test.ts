import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isIdentityConfigured,
  signIdentityToken,
  verifyIdentityToken,
} from "../packages/collab-core/src/index.ts";

const SECRET = "relay-issuer-secret";

describe("collaboration identity tokens", () => {
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
