import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverOllamaModels } from "../apps/geolibre-desktop/src/lib/assistant/ollama";

describe("discoverOllamaModels", () => {
  it("normalizes hosts and parses unique model names", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      requested.push(String(input));
      return Response.json({
        models: [
          { name: "qwen3:8b" },
          { model: "smollm2:135m" },
          { name: "qwen3:8b" },
          { name: 42 },
        ],
      });
    };

    try {
      assert.deepEqual(await discoverOllamaModels("localhost:11434/v1/"), [
        "qwen3:8b",
        "smollm2:135m",
      ]);
      assert.deepEqual(await discoverOllamaModels("http://localhost:11434"), [
        "qwen3:8b",
        "smollm2:135m",
      ]);
      assert.deepEqual(requested, [
        "http://localhost:11434/api/tags",
        "http://localhost:11434/api/tags",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to model when name is blank and tolerates malformed entries", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        models: [
          { name: "   ", model: "llama3:8b" },
          { name: "   ", model: "   " },
          { name: "   " },
          null,
          "not-an-object",
        ],
      });

    try {
      assert.deepEqual(await discoverOllamaModels("localhost:11434"), ["llama3:8b"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats a null payload as an empty model list", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(null);

    try {
      assert.deepEqual(await discoverOllamaModels("localhost:11434"), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts the request when the caller's signal aborts", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });

    try {
      const pending = discoverOllamaModels("localhost:11434", controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
