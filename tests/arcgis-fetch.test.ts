import assert from "node:assert/strict";
import { it } from "node:test";
import { createNativeArcGISFetch } from "../apps/geolibre-desktop/src/lib/arcgis-fetch";

it("rejects token-bearing HTTP requests before calling native HTTP", async () => {
  let called = false;
  const fetchImpl = createNativeArcGISFetch(async () => {
    called = true;
    return new Response();
  });
  await assert.rejects(
    fetchImpl("http://example.com/FeatureServer/0?token=secret"),
    /tokens require HTTPS/,
  );
  assert.equal(called, false);
});

it("disables native redirects for authenticated requests and preserves cancellation", async () => {
  const controller = new AbortController();
  const fetchImpl = createNativeArcGISFetch(async (input, init) => {
    assert.equal(String(input), "https://example.com/FeatureServer/0?token=secret");
    assert.equal(init?.maxRedirections, 0);
    assert.equal(init?.signal, controller.signal);
    return new Response(null, {
      status: 302,
      headers: { Location: "http://example.com/FeatureServer/0?token=secret" },
    });
  });
  const response = await fetchImpl("https://example.com/FeatureServer/0?token=secret", {
    signal: controller.signal,
  });
  assert.equal(response.status, 302);
});

it("retains unauthenticated HTTP service support", async () => {
  const fetchImpl = createNativeArcGISFetch(async (input, init) => {
    assert.equal(String(input), "http://example.com/FeatureServer/0");
    assert.equal(init?.maxRedirections, undefined);
    return new Response("{}");
  });
  assert.equal((await fetchImpl("http://example.com/FeatureServer/0")).status, 200);
});
