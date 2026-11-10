import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverUberLLMModels } from "../apps/geolibre-desktop/src/lib/assistant/uberllm";

describe("discoverUberLLMModels", () => {
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
          { ...chat, id: " openai/gpt-5.6-luna ", display_name: "GPT-5.6 Luna" },
          { ...chat, id: "anthropic/claude-sonnet-4.5", display_name: "  " },
          { ...chat, id: "openai/gpt-5.6-luna", display_name: "Duplicate" },
          { ...chat, id: "  ", display_name: "Missing ID" },
          { ...chat, id: 42, display_name: "Malformed ID" },
          {
            ...chat,
            id: "vendor/embed",
            display_name: "Embed",
            architecture: { output_modalities: ["embeddings"] },
          },
          {
            ...chat,
            id: "vendor/no-tools",
            display_name: "No tools",
            supported_parameters: ["max_tokens"],
          },
          {
            id: "vendor/no-architecture",
            display_name: "No architecture",
            supported_parameters: ["tools"],
          },
          null,
          "malformed entry",
          {},
        ],
      });
    };

    try {
      assert.deepEqual(await discoverUberLLMModels(), [
        { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
        { id: "anthropic/claude-sonnet-4.5", name: "anthropic/claude-sonnet-4.5" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(requestUrl);
    assert.equal(url.origin, "https://api.uberllm.dev");
    assert.equal(url.pathname, "/v1/models");
    assert.equal(hasAuthorization, false);
  });

  it("accepts an empty catalog and rejects missing or malformed data", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: [] });
    try {
      assert.deepEqual(await discoverUberLLMModels(), []);

      globalThis.fetch = async () => Response.json({});
      await assert.rejects(discoverUberLLMModels(), /invalid model catalog/);

      globalThis.fetch = async () => Response.json({ data: null });
      await assert.rejects(discoverUberLLMModels(), /invalid model catalog/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports non-success HTTP status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    try {
      await assert.rejects(discoverUberLLMModels(), /HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts an in-flight catalog request when the caller cancels", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = async (_input, init) => waitForAbort(init?.signal);

    try {
      const pending = discoverUberLLMModels(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
