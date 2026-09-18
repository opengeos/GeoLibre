import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  checkSidecarHealth,
  setSidecarAuthToken,
  setSidecarFetch,
} from "../packages/processing/src";
import {
  createNativeSidecarFetch,
  isNativeSidecarRequest,
} from "../apps/geolibre-desktop/src/lib/sidecar-fetch";

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

describe("native sidecar transport", () => {
  afterEach(() => {
    setSidecarAuthToken(null);
    setSidecarFetch(null);
  });

  it("disables native redirects so the token is never replayed off-host", async () => {
    let seenInit:
      | (RequestInit & {
          maxRedirections?: number;
          proxy?: { all?: { url: string; noProxy?: string } };
        })
      | undefined;
    const transport = createNativeSidecarFetch((_input, init) => {
      seenInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    setSidecarAuthToken("desktop-token");
    setSidecarFetch(transport);

    assert.deepEqual(await checkSidecarHealth(), { status: "ok" });
    assert.equal(seenInit?.maxRedirections, 0);
    // Any proxy entry disables reqwest's system-proxy lookup, and `*` stops the
    // supplied one from intercepting, so the request stays on the loopback.
    assert.equal(seenInit?.proxy?.all?.noProxy, "*");
    assert.equal(new Headers(seenInit?.headers).get("X-GeoLibre-Token"), "desktop-token");
  });

  it("forwards a multipart body to the native transport untouched", async () => {
    let seenBody: BodyInit | null | undefined;
    let seenMethod: string | undefined;
    const transport = createNativeSidecarFetch((_input, init) => {
      seenBody = init?.body;
      seenMethod = init?.method;
      return Promise.resolve(new Response(null));
    });

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "scene.tif");
    form.append("model_version", "sam3");

    await transport("http://127.0.0.1:8765/ml/segment/text", { method: "POST", body: form });

    // The adapter must hand the FormData through by reference: Tauri's native
    // fetch serializes it with `new Request(...)`, which is what generates the
    // multipart boundary and the matching Content-Type header.
    assert.equal(seenMethod, "POST");
    assert.equal(seenBody, form);
  });

  it("falls back to the browser fetch outside the native capability scope", async () => {
    let nativeCalls = 0;
    const transport = createNativeSidecarFetch(() => {
      nativeCalls += 1;
      return Promise.resolve(new Response(null));
    });

    const originalFetch = globalThis.fetch;
    let browserUrl: string | null = null;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      browserUrl = input.toString();
      return Promise.resolve(new Response(null));
    }) as typeof globalThis.fetch;
    try {
      await transport("http://127.0.0.1:9000/health");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(nativeCalls, 0);
    assert.equal(browserUrl, "http://127.0.0.1:9000/health");
  });
});
