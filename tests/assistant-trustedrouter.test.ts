import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverTrustedRouterModels } from "../apps/geolibre-desktop/src/lib/assistant/trustedrouter";

describe("discoverTrustedRouterModels", () => {
  function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
    const { promise, reject } = Promise.withResolvers<Response>();
    const onAbort = () => reject(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return promise;
  }

  const chat = {
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools", "max_tokens"],
  };

  it("requests the public catalog and keeps tool-capable text models", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let hasAuthorization = true;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requestUrl = request.url;
      hasAuthorization = request.headers.has("authorization");
      return Response.json({
        data: [
          { ...chat, id: " trustedrouter/auto ", name: "TrustedRouter Auto" },
          { ...chat, id: "anthropic/claude-sonnet-4.5", name: "  " },
          { ...chat, id: "trustedrouter/auto", name: "Duplicate" },
          { ...chat, id: "  ", name: "Missing ID" },
          { ...chat, id: 42, name: "Malformed ID" },
          {
            ...chat,
            id: "vendor/embed",
            name: "Embed",
            architecture: { output_modalities: ["embeddings"] },
          },
          {
            ...chat,
            id: "vendor/no-tools",
            name: "No tools",
            supported_parameters: ["max_tokens"],
          },
          {
            id: "vendor/no-architecture",
            name: "No architecture",
            supported_parameters: ["tools"],
          },
          null,
          "malformed entry",
          {},
        ],
      });
    };

    try {
      assert.deepEqual(await discoverTrustedRouterModels(), [
        { id: "trustedrouter/auto", name: "TrustedRouter Auto" },
        { id: "anthropic/claude-sonnet-4.5", name: "anthropic/claude-sonnet-4.5" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(requestUrl);
    assert.equal(url.origin, "https://api.trustedrouter.com");
    assert.equal(url.pathname, "/v1/models");
    assert.equal(hasAuthorization, false);
  });

  it("accepts an empty catalog and rejects missing or malformed data", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: [] });
    try {
      assert.deepEqual(await discoverTrustedRouterModels(), []);

      globalThis.fetch = async () => Response.json({});
      await assert.rejects(discoverTrustedRouterModels(), /invalid model catalog/);

      globalThis.fetch = async () => Response.json({ data: null });
      await assert.rejects(discoverTrustedRouterModels(), /invalid model catalog/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports non-success HTTP status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    try {
      await assert.rejects(discoverTrustedRouterModels(), /HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts an in-flight catalog request when the caller cancels", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = async (_input, init) => waitForAbort(init?.signal);

    try {
      const pending = discoverTrustedRouterModels(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
