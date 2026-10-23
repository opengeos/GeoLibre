import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverVercelGatewayModels } from "../apps/geolibre-desktop/src/lib/assistant/vercel-gateway";

describe("discoverVercelGatewayModels", () => {
  function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
    const { promise, reject } = Promise.withResolvers<Response>();
    const onAbort = () => reject(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return promise;
  }

  const language = {
    type: "language",
    modalities: { output: ["text"] },
    supported_parameters: ["tools", "temperature"],
  };

  it("requests the public catalog and keeps tool-capable language models", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let hasAuthorization = true;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requestUrl = request.url;
      hasAuthorization = request.headers.has("authorization");
      return Response.json({
        data: [
          { ...language, id: " vendor/first ", name: "First model" },
          { ...language, id: "vendor/second", name: "  " },
          { ...language, id: "vendor/first", name: "Duplicate" },
          { ...language, id: "  ", name: "Missing ID" },
          { ...language, id: 42, name: "Malformed ID" },
          { ...language, type: "embedding", id: "vendor/embed", name: "Embed" },
          {
            ...language,
            id: "vendor/image",
            name: "Image",
            modalities: { output: ["image"] },
          },
          {
            ...language,
            id: "vendor/no-tools",
            name: "No tools",
            supported_parameters: ["temperature"],
          },
          null,
          "malformed entry",
          {},
        ],
      });
    };

    try {
      assert.deepEqual(await discoverVercelGatewayModels(), [
        { id: "vendor/first", name: "First model" },
        { id: "vendor/second", name: "vendor/second" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(requestUrl);
    assert.equal(url.origin, "https://ai-gateway.vercel.sh");
    assert.equal(url.pathname, "/v1/models");
    assert.equal(hasAuthorization, false);
  });

  it("accepts an empty catalog and rejects missing or malformed data", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: [] });
    try {
      assert.deepEqual(await discoverVercelGatewayModels(), []);

      globalThis.fetch = async () => Response.json({});
      await assert.rejects(discoverVercelGatewayModels(), /invalid model catalog/);

      globalThis.fetch = async () => Response.json({ data: null });
      await assert.rejects(discoverVercelGatewayModels(), /invalid model catalog/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports non-success HTTP status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("forbidden", { status: 403 });
    try {
      await assert.rejects(discoverVercelGatewayModels(), /HTTP 403/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts an in-flight catalog request when the caller cancels", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = async (_input, init) => waitForAbort(init?.signal);

    try {
      const pending = discoverVercelGatewayModels(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
