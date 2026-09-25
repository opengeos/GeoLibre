import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearModelDiscoveryCache,
  discoverProviderModels,
  parseAnthropicModels,
  parseGeminiModels,
  parseOpenAIModels,
  supportsKeyedModelDiscovery,
} from "../apps/geolibre-desktop/src/lib/assistant/model-discovery";

describe("parseOpenAIModels", () => {
  it("keeps chat models newest first and drops non-chat variants and dated snapshots", () => {
    const models = parseOpenAIModels({
      data: [
        { id: "gpt-5.6", created: 300 },
        { id: "gpt-5.7", created: 400 },
        { id: "gpt-5.6-2026-05-01", created: 299 },
        { id: "o5-mini", created: 200 },
        { id: "gpt-realtime", created: 500 },
        { id: "gpt-4o-mini-tts", created: 500 },
        { id: "gpt-image-2", created: 500 },
        { id: "text-embedding-3-large", created: 500 },
        { id: "whisper-1", created: 500 },
        { id: "gpt-5.6", created: 300 },
        null,
        { created: 1 },
      ],
    });
    assert.deepEqual(
      models.map((model) => model.id),
      ["gpt-5.7", "gpt-5.6", "o5-mini"],
    );
    assert.equal(models[0].name, "gpt-5.7");
  });

  it("rejects a payload without a data array", () => {
    assert.throws(() => parseOpenAIModels({ error: "nope" }), /invalid model catalog/);
  });
});

describe("parseAnthropicModels", () => {
  it("keeps API order and display names", () => {
    assert.deepEqual(
      parseAnthropicModels({
        data: [
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
          { id: "claude-haiku-4-5", display_name: "" },
          { id: "claude-opus-5-5", display_name: "Duplicate" },
        ],
      }),
      [
        { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { id: "claude-haiku-4-5", name: "claude-haiku-4-5" },
      ],
    );
  });
});

describe("parseGeminiModels", () => {
  it("keeps generateContent Gemini text models, highest version first", () => {
    const models = parseGeminiModels({
      models: [
        {
          name: "models/gemini-3.5-flash",
          displayName: "Gemini 3.5 Flash",
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
        {
          name: "models/gemini-3.10-pro",
          displayName: "Gemini 3.10 Pro",
          supportedGenerationMethods: ["generateContent"],
        },
        { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-3.5-flash-tts", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-flash-image", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemma-4-27b-it", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.6-flash" },
      ],
    });
    assert.deepEqual(models, [
      { id: "gemini-3.10-pro", name: "Gemini 3.10 Pro" },
      { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    ]);
  });
});

describe("supportsKeyedModelDiscovery", () => {
  it("covers the hosted key-based providers only", () => {
    assert.equal(supportsKeyedModelDiscovery("openai"), true);
    assert.equal(supportsKeyedModelDiscovery("anthropic"), true);
    assert.equal(supportsKeyedModelDiscovery("google"), true);
    assert.equal(supportsKeyedModelDiscovery("openrouter"), false);
    assert.equal(supportsKeyedModelDiscovery("bedrock"), false);
    assert.equal(supportsKeyedModelDiscovery("custom"), false);
  });
});

describe("discoverProviderModels", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearModelDiscoveryCache();
  });

  /** Stub fetch, recording each request, and answer with `body`. */
  function stubFetch(body: unknown, status = 200): Request[] {
    const requests: Request[] = [];
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(body, { status });
    };
    return requests;
  }

  it("sends each provider's auth headers", async () => {
    let requests = stubFetch({ data: [] });
    await discoverProviderModels("openai", " sk-openai ");
    assert.equal(requests[0].url, "https://api.openai.com/v1/models");
    assert.equal(requests[0].headers.get("authorization"), "Bearer sk-openai");

    requests = stubFetch({ data: [] });
    await discoverProviderModels("anthropic", "sk-ant");
    assert.equal(new URL(requests[0].url).pathname, "/v1/models");
    assert.equal(requests[0].headers.get("x-api-key"), "sk-ant");
    assert.equal(requests[0].headers.get("anthropic-version"), "2023-06-01");
    assert.equal(requests[0].headers.get("anthropic-dangerous-direct-browser-access"), "true");

    requests = stubFetch({ models: [] });
    await discoverProviderModels("google", "gm-key");
    assert.equal(new URL(requests[0].url).host, "generativelanguage.googleapis.com");
    assert.equal(requests[0].headers.get("x-goog-api-key"), "gm-key");
    assert.equal(new URL(requests[0].url).searchParams.has("key"), false);
  });

  it("caches per provider and key, and force bypasses the cache", async () => {
    const requests = stubFetch({ data: [{ id: "claude-opus-5-5" }] });
    await discoverProviderModels("anthropic", "key-a");
    await discoverProviderModels("anthropic", "key-a");
    assert.equal(requests.length, 1);
    await discoverProviderModels("anthropic", "key-b");
    assert.equal(requests.length, 2);
    await discoverProviderModels("anthropic", "key-a", { force: true });
    assert.equal(requests.length, 3);
  });

  it("reports the HTTP status and does not cache a failure", async () => {
    const requests = stubFetch({ error: { message: "invalid x-api-key" } }, 401);
    await assert.rejects(discoverProviderModels("anthropic", "bad"), /Anthropic returned HTTP 401/);
    await assert.rejects(discoverProviderModels("anthropic", "bad"), /HTTP 401/);
    assert.equal(requests.length, 2);
  });
});
