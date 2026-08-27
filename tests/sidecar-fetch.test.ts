import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  checkSidecarHealth,
  setSidecarAuthToken,
  setSidecarFetch,
} from "../packages/processing/src";
import { isNativeSidecarRequest } from "../apps/geolibre-desktop/src/lib/sidecar-fetch";

describe("sidecar fetch override", () => {
  afterEach(() => {
    setSidecarAuthToken(null);
    setSidecarFetch(null);
  });

  it("routes sidecar requests through the installed transport", async () => {
    let seenUrl: string | null = null;
    setSidecarFetch(((input: RequestInfo | URL) => {
      seenUrl = input.toString();
      return Promise.resolve(
        new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch);

    assert.deepEqual(await checkSidecarHealth(), { status: "ok" });
    assert.equal(seenUrl, "http://127.0.0.1:8765/health");
  });

  it("preserves the per-launch token with the native transport", async () => {
    let token: string | null = null;
    setSidecarAuthToken("desktop-token");
    setSidecarFetch(((_input: RequestInfo | URL, init?: RequestInit) => {
      token = new Headers(init?.headers).get("X-GeoLibre-Token");
      return Promise.resolve(
        new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch);

    await checkSidecarHealth();
    assert.equal(token, "desktop-token");
  });
});

describe("native sidecar scope", () => {
  it("matches only the configured loopback origin", () => {
    assert.equal(isNativeSidecarRequest("http://127.0.0.1:8765/whitebox/status"), true);
    assert.equal(isNativeSidecarRequest(new URL("http://127.0.0.1:8765/health")), true);
    assert.equal(isNativeSidecarRequest("http://127.0.0.1:9000/health"), false);
    assert.equal(isNativeSidecarRequest("http://localhost:8765/health"), false);
    assert.equal(isNativeSidecarRequest("not a url"), false);
  });
});
