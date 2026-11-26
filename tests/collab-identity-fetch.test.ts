import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchCollabIdentityToken } from "../apps/geolibre-desktop/src/lib/collab-identity";

const ISSUER = "https://share.example";

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

describe("fetchCollabIdentityToken", () => {
  it("asks the server API for a relay token with the account's access token", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ token: "payload.sig" }));
    const token = await fetchCollabIdentityToken({
      issuer: ISSUER,
      getAccessToken: async () => "access-1",
      fetchImpl: impl,
    });
    assert.equal(token, "payload.sig");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ISSUER}/api/collab/identity-token`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer access-1");
  });

  it("stays anonymous when signed out, unconfigured, or failing", async () => {
    const never = fakeFetch(() => {
      throw new Error("must not be called");
    });
    assert.equal(
      await fetchCollabIdentityToken({
        issuer: ISSUER,
        getAccessToken: async () => null,
        fetchImpl: never.impl,
      }),
      null,
    );
    assert.equal(
      await fetchCollabIdentityToken({
        issuer: null,
        getAccessToken: async () => "a",
        fetchImpl: never.impl,
      }),
      null,
    );
    for (const response of [
      () => Response.json({ error: "collaboration identity is not configured" }, { status: 404 }),
      () => Response.json({ token: 42 }),
      () => new Response("not json"),
      () => {
        throw new TypeError("network down");
      },
    ]) {
      const { impl } = fakeFetch(response);
      assert.equal(
        await fetchCollabIdentityToken({
          issuer: ISSUER,
          getAccessToken: async () => "a",
          fetchImpl: impl,
        }),
        null,
      );
    }
  });
});
