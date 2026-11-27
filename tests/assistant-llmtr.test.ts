import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverLlmtrModels } from "../apps/geolibre-desktop/src/lib/assistant/llmtr";

describe("discoverLlmtrModels", () => {
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

  it("requests the public catalog and keeps OpenAI-shaped models", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let hasAuthorization = true;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requestUrl = request.url;
      hasAuthorization = request.headers.has("authorization");
      return Response.json({
        data: [
          { id: " qwen/qwen3.8-flash ", name: "Qwen3.8 Flash" },
          { id: "qwen/qwen3.8-max" },
          { id: "qwen/qwen3.8-flash", name: "Duplicate" },
          { id: "  ", name: "Missing ID" },
          { id: 42, name: "Malformed ID" },
          { id: "mistral/devstral-medium-latest", name: "  " },
          null,
          "malformed entry",
          {},
        ],
      });
    };

    try {
      assert.deepEqual(await discoverLlmtrModels(), [
        { id: "qwen/qwen3.8-flash", name: "Qwen3.8 Flash" },
        { id: "qwen/qwen3.8-max", name: "qwen/qwen3.8-max" },
        { id: "mistral/devstral-medium-latest", name: "mistral/devstral-medium-latest" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(requestUrl);
    assert.equal(url.origin, "https://llmtr.com");
    assert.equal(url.pathname, "/v1/models");
    assert.equal(hasAuthorization, false);
  });

  it("drops non-text or tool-less rows when catalog metadata is present", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        data: [
          { ...chat, id: "qwen/qwen3.8-flash", name: "Qwen3.8 Flash" },
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
        ],
      });

    try {
      assert.deepEqual(await discoverLlmtrModels(), [
        { id: "qwen/qwen3.8-flash", name: "Qwen3.8 Flash" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts an empty catalog and rejects missing or malformed data", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: [] });
    try {
      assert.deepEqual(await discoverLlmtrModels(), []);

      globalThis.fetch = async () => Response.json({});
      await assert.rejects(discoverLlmtrModels(), /invalid model catalog/);

      globalThis.fetch = async () => Response.json({ data: null });
      await assert.rejects(discoverLlmtrModels(), /invalid model catalog/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports non-success HTTP status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    try {
      await assert.rejects(discoverLlmtrModels(), /HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts an in-flight catalog request when the caller cancels", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = async (_input, init) => waitForAbort(init?.signal);

    try {
      const pending = discoverLlmtrModels(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
