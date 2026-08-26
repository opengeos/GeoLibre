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

  it("falls back to model when name is blank", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        models: [
          { name: "   ", model: "llama3:8b" },
          { name: "   ", model: "   " },
          { name: "   " },
        ],
      });

    try {
      assert.deepEqual(await discoverOllamaModels("localhost:11434"), ["llama3:8b"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
