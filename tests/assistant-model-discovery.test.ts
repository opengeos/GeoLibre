import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  bedrockAuthFromConfig,
  clearModelDiscoveryCache,
  discoverProviderModels,
  hasModelPicker,
  parseAnthropicModels,
  parseBedrockModels,
  parseGeminiModels,
  parseOpenAIModels,
  supportsKeyedModelDiscovery,
  withDeadline,
} from "../apps/geolibre-desktop/src/lib/assistant/model-discovery";

describe("parseOpenAIModels", () => {
  it("keeps chat models newest first and drops non-chat variants and dated snapshots", () => {
    const models = parseOpenAIModels({
      data: [
        { id: "gpt-5.6", created: 300 },
        { id: "gpt-5.7", created: 400 },
        { id: "gpt-5.6-2026-05-01", created: 299 },
        { id: "gpt-3.5-turbo-0125", created: 100 },
        { id: "gpt-5.3-chat-latest", created: 350 },
        { id: "gpt-live-1", created: 500 },
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
        {
          name: "models/gemini-omni-flash-preview",
          supportedGenerationMethods: ["generateContent"],
        },
        { name: "models/gemini-3.5-transcribe", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.6-flash" },
      ],
    });
    assert.deepEqual(models, [
      { id: "gemini-3.10-pro", name: "Gemini 3.10 Pro" },
      { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    ]);
  });
});

describe("parseBedrockModels", () => {
  const foundation = [
    {
      modelId: "anthropic.claude-opus-5-5",
      modelName: "Claude Opus 5.5",
      inferenceTypesSupported: ["INFERENCE_PROFILE"],
      inputModalities: ["TEXT", "IMAGE"],
      modelLifecycle: { status: "ACTIVE" },
    },
    {
      modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
      modelName: "Claude Sonnet 4",
      inferenceTypesSupported: ["INFERENCE_PROFILE"],
      modelLifecycle: { status: "LEGACY" },
    },
    {
      modelId: "amazon.nova-pro-v1:0",
      modelName: "Nova Pro",
      inferenceTypesSupported: ["ON_DEMAND", "INFERENCE_PROFILE"],
      modelLifecycle: { status: "ACTIVE" },
    },
    { modelId: "amazon.nova-pro-v1:0:300k", inferenceTypesSupported: ["PROVISIONED"] },
    {
      modelId: "qwen.qwen3-32b-v1:0",
      modelName: "Qwen3 32B",
      inferenceTypesSupported: ["ON_DEMAND"],
    },
    { modelId: "zzz.unnamed-model", modelName: "", inferenceTypesSupported: ["ON_DEMAND"] },
    { modelId: "cohere.rerank-v3-5:0", inferenceTypesSupported: ["ON_DEMAND"] },
    { modelId: "mistral.mixtral-8x7b-instruct-v0:1", inferenceTypesSupported: ["ON_DEMAND"] },
    { modelId: "meta.llama3-8b-instruct-v1:0", inferenceTypesSupported: ["ON_DEMAND"] },
    { modelId: "twelvelabs.pegasus-1-2-v1:0", inferenceTypesSupported: ["ON_DEMAND"] },
    {
      modelId: "vendor.speech-only",
      inferenceTypesSupported: ["ON_DEMAND"],
      inputModalities: ["SPEECH"],
    },
  ];
  const profiles = [
    {
      inferenceProfileId: "us-gov.amazon.nova-pro-v1:0",
      inferenceProfileName: "US-GOV Nova Pro",
      status: "ACTIVE",
    },
    {
      inferenceProfileId: "us.anthropic.claude-opus-5-5",
      inferenceProfileName: "US Anthropic Claude Opus 5.5",
      status: "ACTIVE",
    },
    {
      inferenceProfileId: "global.anthropic.claude-opus-5-5",
      inferenceProfileName: "GLOBAL Anthropic Claude Opus 5.5",
      status: "ACTIVE",
    },
    {
      inferenceProfileId: "us.amazon.nova-pro-v1:0",
      inferenceProfileName: "US Nova Pro",
      status: "ACTIVE",
    },
    {
      inferenceProfileId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      inferenceProfileName: "US Claude Sonnet 4",
    },
    {
      inferenceProfileId: "us.stability.stable-image-inpaint-v1:0",
      inferenceProfileName: "US Stable Image Inpaint",
    },
    {
      inferenceProfileId: "global.cohere.embed-v4:0",
      inferenceProfileName: "Global Cohere Embed v4",
    },
  ];

  it("keeps active text profiles and on-demand models, global profiles first", () => {
    assert.deepEqual(parseBedrockModels(profiles, foundation), [
      { id: "global.anthropic.claude-opus-5-5", name: "Global Anthropic Claude Opus 5.5" },
      { id: "us.anthropic.claude-opus-5-5", name: "US Anthropic Claude Opus 5.5" },
      { id: "us.amazon.nova-pro-v1:0", name: "US Nova Pro" },
      { id: "us-gov.amazon.nova-pro-v1:0", name: "US-GOV Nova Pro" },
      { id: "amazon.nova-pro-v1:0", name: "Nova Pro" },
      { id: "qwen.qwen3-32b-v1:0", name: "Qwen3 32B" },
      { id: "zzz.unnamed-model", name: "zzz.unnamed-model" },
    ]);
  });
});

describe("bedrockAuthFromConfig", () => {
  it("extracts region and credentials from a Bedrock config only", () => {
    assert.deepEqual(
      bedrockAuthFromConfig({
        provider: "bedrock",
        modelId: "m",
        region: "us-west-2",
        credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "TK" },
      }),
      { region: "us-west-2", accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "TK" },
    );
    assert.equal(bedrockAuthFromConfig({ provider: "openai", modelId: "m", apiKey: "k" }), null);
    assert.equal(bedrockAuthFromConfig(null), null);
  });
});

describe("hasModelPicker", () => {
  it("covers the providers with a live catalog", () => {
    for (const id of ["openrouter", "bedrock", "openai", "anthropic", "google"] as const) {
      assert.equal(hasModelPicker(id), true, id);
    }
    assert.equal(hasModelPicker("ollama"), false);
    assert.equal(hasModelPicker("custom"), false);
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

describe("withDeadline", () => {
  it("forwards the caller's abort when AbortSignal.any is unavailable", () => {
    const original = AbortSignal.any;
    try {
      (AbortSignal as { any?: unknown }).any = undefined;
      const controller = new AbortController();
      const signal = withDeadline(controller.signal, 60_000);
      assert.equal(signal.aborted, false);
      controller.abort(new Error("superseded"));
      assert.equal(signal.aborted, true);
      assert.equal((signal.reason as Error).message, "superseded");
    } finally {
      AbortSignal.any = original;
    }
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
    await assert.rejects(
      discoverProviderModels("anthropic", "bad"),
      /Anthropic returned HTTP 401: invalid x-api-key/,
    );
    await assert.rejects(discoverProviderModels("anthropic", "bad"), /HTTP 401/);
    assert.equal(requests.length, 2);
  });
});
