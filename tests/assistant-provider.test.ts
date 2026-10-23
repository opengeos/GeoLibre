import { Agent } from "@strands-agents/sdk";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  availableProviders,
  configForProvider,
  createModel,
  hasManagedAssistantProxy,
  openAiCompatibleHeaders,
  OPENAI_COMPATIBLE_STRIPPED_HEADERS,
  readBuildTimeAssistantEnv,
  readDeploymentAssistantEnv,
  readRuntimeEnv,
  resolveProviderConfig,
  defaultModelFor,
  type AssistantProfile,
  type RuntimeEnv,
} from "../apps/geolibre-desktop/src/lib/assistant/provider";
import { configForProfile } from "../apps/geolibre-desktop/src/lib/assistant/profiles";
import { setDeploymentPolicy } from "../apps/geolibre-desktop/src/lib/deployment-env";

describe("build-time AI proxy", () => {
  it("does not configure a managed proxy unless its URL is explicitly set", () => {
    assert.deepEqual(readBuildTimeAssistantEnv({}), {});
    assert.deepEqual(
      readBuildTimeAssistantEnv({
        VITE_GEOLIBRE_AI_MODEL: "openai/gpt-5.6-terra",
      }),
      {},
    );
  });

  it("never imports provider API keys from the client build environment", () => {
    assert.deepEqual(
      readBuildTimeAssistantEnv({
        VITE_OPENAI_API_KEY: "must-not-enter-the-bundle",
        VITE_ANTHROPIC_API_KEY: "must-not-enter-the-bundle",
        VITE_GEMINI_API_KEY: "must-not-enter-the-bundle",
      }),
      {},
    );
  });

  it("maps the public proxy URL to an OpenAI-compatible runtime config", () => {
    assert.deepEqual(
      readBuildTimeAssistantEnv({
        VITE_GEOLIBRE_AI_URL: "https://ai.example.com/",
        VITE_GEOLIBRE_AI_MODEL: "gpt-5.6-terra",
      }),
      {
        OPENAI_COMPATIBLE_BASE_URL: "https://ai.example.com/v1",
        OPENAI_COMPATIBLE_MODEL: "gpt-5.6-terra",
      },
    );
  });

  it("defaults a managed Chat Completions proxy to GPT-5.6 Luna", () => {
    assert.equal(
      readBuildTimeAssistantEnv({ VITE_GEOLIBRE_AI_URL: "https://ai.example.com/v1" })
        .OPENAI_COMPATIBLE_MODEL,
      "openai/gpt-5.6-luna",
    );
  });

  it("resolves a same-origin managed proxy path against the deployment origin", () => {
    assert.deepEqual(
      readBuildTimeAssistantEnv(
        {
          VITE_GEOLIBRE_AI_URL: "/ai",
          VITE_GEOLIBRE_AI_MODEL: "openai/gpt-5.5",
        },
        "http://localhost:8081",
      ),
      {
        OPENAI_COMPATIBLE_BASE_URL: "http://localhost:8081/ai/v1",
        OPENAI_COMPATIBLE_MODEL: "openai/gpt-5.5",
      },
    );
  });

  it("reads Docker deployment config only when the entrypoint injects a URL", () => {
    const originalWindow = globalThis.window;
    try {
      globalThis.window = {
        location: { origin: "http://localhost:8081" },
        __GEOLIBRE_DEPLOYMENT_ENV__: {
          VITE_GEOLIBRE_AI_URL: "/ai",
          VITE_GEOLIBRE_AI_MODEL: "openai/gpt-5.5",
        },
      } as unknown as Window & typeof globalThis;
      assert.deepEqual(readDeploymentAssistantEnv(), {
        OPENAI_COMPATIBLE_BASE_URL: "http://localhost:8081/ai/v1",
        OPENAI_COMPATIBLE_MODEL: "openai/gpt-5.5",
        GEOLIBRE_AI_PROXY_BASE_URL: "http://localhost:8081/ai/v1",
        GEOLIBRE_AI_PROXY_OMIT_AUTHORIZATION: "1",
      });

      globalThis.window = {
        location: { origin: "http://localhost:8081" },
        __GEOLIBRE_DEPLOYMENT_ENV__: {
          VITE_GEOLIBRE_AI_MODEL: "openai/gpt-5.5",
        },
      } as unknown as Window & typeof globalThis;
      assert.deepEqual(readDeploymentAssistantEnv(), {});
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it("lets the saved runtime environment override the deployment's proxy config", () => {
    const originalWindow = globalThis.window;
    try {
      globalThis.window = {
        location: { origin: "http://localhost:8081" },
        __GEOLIBRE_DEPLOYMENT_ENV__: {
          VITE_GEOLIBRE_AI_URL: "/ai",
          VITE_GEOLIBRE_AI_MODEL: "openai/gpt-5.5",
        },
        __GEOLIBRE_RUNTIME_ENV__: {
          OPENAI_COMPATIBLE_MODEL: "anthropic/claude-opus-5",
        },
      } as unknown as Window & typeof globalThis;
      const env = readRuntimeEnv();
      // The deployment supplies the endpoint, the user's own setting wins on
      // the model: runtime beats deployment, deployment beats build defaults.
      assert.equal(env.OPENAI_COMPATIBLE_BASE_URL, "http://localhost:8081/ai/v1");
      assert.equal(env.OPENAI_COMPATIBLE_MODEL, "anthropic/claude-opus-5");
      assert.equal(env.GEOLIBRE_AI_PROXY_OMIT_AUTHORIZATION, "1");
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it("lets deployment.json switch the managed proxy off, on, and pick the model", () => {
    const build = {
      VITE_GEOLIBRE_AI_URL: "https://ai.example.com",
      VITE_GEOLIBRE_AI_MODEL: "m2",
    };
    const originalWindow = globalThis.window;
    try {
      setDeploymentPolicy({ version: 1, ai: { enabled: false } });
      assert.deepEqual(readBuildTimeAssistantEnv(build), {});
      assert.equal(hasManagedAssistantProxy(build), false);

      setDeploymentPolicy({ version: 1, ai: { model: "m1" } });
      assert.equal(readBuildTimeAssistantEnv(build).OPENAI_COMPATIBLE_MODEL, "m1");

      globalThis.window = {
        location: { origin: "https://app.example" },
      } as unknown as Window & typeof globalThis;
      setDeploymentPolicy({ version: 1, ai: { enabled: true } });
      assert.equal(
        readDeploymentAssistantEnv().GEOLIBRE_AI_PROXY_BASE_URL,
        "https://app.example/ai/v1",
      );
    } finally {
      setDeploymentPolicy(null);
      globalThis.window = originalWindow;
    }
  });
});

describe("hasManagedAssistantProxy", () => {
  it("recognizes a proxy baked in at build time, with no Docker injection", () => {
    assert.equal(
      hasManagedAssistantProxy({ VITE_GEOLIBRE_AI_URL: "https://ai.example.com" }),
      true,
    );
    assert.equal(hasManagedAssistantProxy({ VITE_GEOLIBRE_AI_MODEL: "openai/gpt-5.5" }), false);
  });

  it("recognizes a proxy injected by the Docker entrypoint", () => {
    const originalWindow = globalThis.window;
    try {
      globalThis.window = {
        location: { origin: "http://localhost:8081" },
        __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_AI_URL: "/ai" },
      } as unknown as Window & typeof globalThis;
      assert.equal(hasManagedAssistantProxy({}), true);
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it("ignores an endpoint the user typed into Settings", () => {
    const originalWindow = globalThis.window;
    try {
      // A custom OpenAI-compatible endpoint is the user's own provider, not an
      // operator-managed proxy, so it must not take over profile selection.
      globalThis.window = {
        location: { origin: "http://localhost:8081" },
        __GEOLIBRE_RUNTIME_ENV__: {
          OPENAI_COMPATIBLE_BASE_URL: "https://api.example.com/v1",
        },
      } as unknown as Window & typeof globalThis;
      assert.equal(hasManagedAssistantProxy({}), false);
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

describe("resolveProviderConfig", () => {
  it("returns null when no provider key is configured", () => {
    assert.equal(resolveProviderConfig({}), null);
    assert.equal(resolveProviderConfig({ UNRELATED: "x" } as RuntimeEnv), null);
  });

  it("selects Google from GEMINI_API_KEY with its default model", () => {
    const config = resolveProviderConfig({ GEMINI_API_KEY: "g-key" });
    assert.deepEqual(config, {
      provider: "google",
      apiKey: "g-key",
      modelId: "gemini-3.6-flash",
    });
  });

  it("accepts GOOGLE_API_KEY as a Google alias", () => {
    const config = resolveProviderConfig({ GOOGLE_API_KEY: "g2" });
    assert.equal(config?.provider, "google");
    assert.equal(config?.apiKey, "g2");
  });

  it("selects Anthropic when only its key is present", () => {
    const config = resolveProviderConfig({ ANTHROPIC_API_KEY: "a-key" });
    assert.equal(config?.provider, "anthropic");
    assert.equal(config?.modelId, "claude-opus-5");
  });

  it("prefers Google over others when several keys exist", () => {
    const config = resolveProviderConfig({
      OPENAI_API_KEY: "o",
      ANTHROPIC_API_KEY: "a",
      GEMINI_API_KEY: "g",
    });
    assert.equal(config?.provider, "google");
  });

  it("honors an explicit provider override", () => {
    const config = resolveProviderConfig({
      GEOLIBRE_ASSISTANT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "a",
      GEMINI_API_KEY: "g",
    });
    assert.equal(config?.provider, "anthropic");
  });

  it("returns null when the overridden provider has no key", () => {
    const config = resolveProviderConfig({
      GEOLIBRE_ASSISTANT_PROVIDER: "openai",
      GEMINI_API_KEY: "g",
    });
    assert.equal(config, null);
  });

  it("applies a model override", () => {
    const config = resolveProviderConfig({
      GEMINI_API_KEY: "g",
      GEOLIBRE_ASSISTANT_MODEL: "gemini-2.5-pro",
    });
    assert.equal(config?.modelId, "gemini-2.5-pro");
  });

  it("ignores blank key values", () => {
    assert.equal(resolveProviderConfig({ GEMINI_API_KEY: "   " }), null);
  });

  it("selects Ollama from OLLAMA_BASE_URL, normalizing to a /v1 base", () => {
    const config = resolveProviderConfig({ OLLAMA_BASE_URL: "localhost:11434" });
    assert.deepEqual(config, {
      provider: "ollama",
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
      modelId: "gemma4",
    });
  });

  it("selects Bedrock from AWS credentials with a default region", () => {
    const config = resolveProviderConfig({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    assert.deepEqual(config, {
      provider: "bedrock",
      modelId: "global.anthropic.claude-opus-5",
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
        sessionToken: undefined,
      },
    });
  });

  it("requires both a base URL and a model for the custom provider", () => {
    assert.equal(
      configForProvider("custom", undefined, {
        OPENAI_COMPATIBLE_BASE_URL: "https://api.example.com/v1",
      }),
      null,
    );
    const config = configForProvider("custom", undefined, {
      OPENAI_COMPATIBLE_BASE_URL: "https://api.example.com/v1/",
      OPENAI_COMPATIBLE_MODEL: "my-model",
      OPENAI_COMPATIBLE_API_KEY: "k",
    });
    assert.deepEqual(config, {
      provider: "custom",
      apiKey: "k",
      baseURL: "https://api.example.com/v1",
      modelId: "my-model",
      suppressAuthorizationHeader: false,
    });
  });

  it("suppresses Bearer auth only for the Docker-managed proxy endpoint", () => {
    assert.deepEqual(
      configForProvider("custom", undefined, {
        OPENAI_COMPATIBLE_BASE_URL: "http://localhost:8081/ai/v1",
        OPENAI_COMPATIBLE_MODEL: "openai/gpt-5.5",
        GEOLIBRE_AI_PROXY_BASE_URL: "http://localhost:8081/ai/v1",
        GEOLIBRE_AI_PROXY_OMIT_AUTHORIZATION: "1",
      }),
      {
        provider: "custom",
        apiKey: "not-needed",
        baseURL: "http://localhost:8081/ai/v1",
        modelId: "openai/gpt-5.5",
        suppressAuthorizationHeader: true,
      },
    );

    assert.equal(
      configForProvider("custom", undefined, {
        OPENAI_COMPATIBLE_BASE_URL: "https://api.example.com/v1",
        OPENAI_COMPATIBLE_MODEL: "my-model",
        OPENAI_COMPATIBLE_API_KEY: "k",
        GEOLIBRE_AI_PROXY_BASE_URL: "http://localhost:8081/ai/v1",
        GEOLIBRE_AI_PROXY_OMIT_AUTHORIZATION: "1",
      })?.suppressAuthorizationHeader,
      false,
    );
  });
});

describe("openAiCompatibleHeaders", () => {
  /**
   * Drive a real OpenAI client through a stub `fetch` and return the header
   * names it actually put on the wire. Using the installed SDK rather than a
   * hand-written expectation is the point: it is the SDK's own header set that
   * has to end up small enough for a third-party gateway's CORS preflight.
   */
  async function sentHeaderNames(defaultHeaders?: Record<string, null>): Promise<string[]> {
    const { default: OpenAI } = await import("openai");
    let names: string[] = [];
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://gateway.example.com/v1",
      defaultHeaders,
      fetch: async (_url, init) => {
        names = [...new Headers(init?.headers).keys()].sort();
        return new Response('{"id":"x","object":"chat.completion","choices":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.chat.completions.create({
      model: "test-model",
      messages: [{ role: "user", content: "show countries with pop over 50 million" }],
    });
    return names;
  }

  it("leaves only headers a third-party gateway's CORS preflight allows", async () => {
    // Baseline: the SDK's own telemetry headers are what break the preflight
    // against an OpenAI-compatible gateway that allows just the standard trio.
    const baseline = await sentHeaderNames();
    assert.ok(baseline.some((name) => name.startsWith("x-stainless-")));
    assert.ok(baseline.includes("user-agent"));

    // With the suppression map, nothing outside the trio is requested, so the
    // preflight asks only for headers such a gateway already allows (#1834).
    assert.deepEqual(await sentHeaderNames(openAiCompatibleHeaders(false)), [
      "accept",
      "authorization",
      "content-type",
    ]);
  });

  it("keeps Authorization unless the managed same-origin proxy asked to drop it", async () => {
    assert.ok((await sentHeaderNames(openAiCompatibleHeaders(false))).includes("authorization"));
    assert.deepEqual(await sentHeaderNames(openAiCompatibleHeaders(true)), [
      "accept",
      "content-type",
    ]);
  });

  it("maps every stripped header to null so the SDK removes rather than blanks it", () => {
    const headers = openAiCompatibleHeaders(false);
    assert.deepEqual(Object.keys(headers).sort(), [...OPENAI_COMPATIBLE_STRIPPED_HEADERS].sort());
    assert.ok(Object.values(headers).every((value) => value === null));
  });
});

describe("availableProviders", () => {
  it("lists only configured providers in preference order", () => {
    assert.deepEqual(availableProviders({}), []);
    assert.deepEqual(availableProviders({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" }), [
      "google",
      "openai",
    ]);
    assert.deepEqual(availableProviders({ ANTHROPIC_API_KEY: "a" }), ["anthropic"]);
    assert.deepEqual(availableProviders({ OPENROUTER_API_KEY: "r", OPENAI_API_KEY: "o" }), [
      "openai",
      "openrouter",
    ]);
    assert.deepEqual(availableProviders({ AI_GATEWAY_API_KEY: "v", OPENROUTER_API_KEY: "r" }), [
      "openrouter",
      "vercel",
    ]);
  });
});

describe("configForProvider", () => {
  it("returns null when the chosen provider has no key", () => {
    assert.equal(configForProvider("anthropic", undefined, { GEMINI_API_KEY: "g" }), null);
  });

  it("uses the explicit model when provided", () => {
    const config = configForProvider("google", "gemini-2.5-pro", {
      GEMINI_API_KEY: "g",
    });
    assert.deepEqual(config, {
      provider: "google",
      apiKey: "g",
      modelId: "gemini-2.5-pro",
    });
  });

  it("falls back to the env model override, then the provider default", () => {
    assert.equal(
      configForProvider("openai", undefined, {
        OPENAI_API_KEY: "o",
        GEOLIBRE_ASSISTANT_MODEL: "gpt-4.1",
      })?.modelId,
      "gpt-4.1",
    );
    assert.equal(
      configForProvider("anthropic", undefined, { ANTHROPIC_API_KEY: "a" })?.modelId,
      "claude-opus-5",
    );
  });
  it("resolves OpenRouter from a nonblank API key with its synchronous default model", () => {
    assert.deepEqual(configForProvider("openrouter", undefined, { OPENROUTER_API_KEY: "key" }), {
      provider: "openrouter",
      apiKey: "key",
      baseURL: "https://openrouter.ai/api/v1",
      modelId: "openai/gpt-5.6-luna",
    });
    assert.equal(configForProvider("openrouter", undefined, { OPENROUTER_API_KEY: "  " }), null);
  });

  it("resolves the OpenRouter model override and gives explicit profile models precedence", () => {
    assert.equal(
      configForProvider("openrouter", undefined, {
        OPENROUTER_API_KEY: "key",
        OPENROUTER_MODEL: "provider/model",
      })?.modelId,
      "provider/model",
    );
    assert.equal(
      configForProvider("openrouter", undefined, {
        OPENROUTER_API_KEY: "key",
        GEOLIBRE_ASSISTANT_MODEL: "global/model",
        OPENROUTER_MODEL: "provider/model",
      })?.modelId,
      "global/model",
    );
    const profile: AssistantProfile = {
      id: "openrouter-profile",
      name: "OpenRouter",
      provider: "openrouter",
      modelId: "saved/model",
      fieldValues: { OPENROUTER_API_KEY: "profile-key" },
    };
    const env = { OPENROUTER_MODEL: "provider/model" };
    const profileWithEnvDefault: AssistantProfile = {
      ...profile,
      modelId: defaultModelFor("openrouter", env),
    };
    assert.equal(defaultModelFor("openrouter", env), "provider/model");
    assert.equal(defaultModelFor("openrouter", {}), "openai/gpt-5.6-luna");
    assert.equal(configForProfile(profileWithEnvDefault, env)?.modelId, "provider/model");
    assert.equal(
      configForProfile(profile, {
        OPENROUTER_MODEL: "provider/model",
        GEOLIBRE_ASSISTANT_MODEL: "global/model",
      })?.modelId,
      "saved/model",
    );
  });

  it("sends a profile model to OpenRouter's Chat Completions endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestHeaders: string[] = [];
    let requestBody = "";
    let authorizationHeader: string | null = null;
    const chunks = [
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "openai/gpt-5.6-luna",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null },
        ],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "openai/gpt-5.6-luna",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];
    const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

    try {
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        requestUrl = request.url;
        requestHeaders = [...request.headers.keys()].sort();
        authorizationHeader = request.headers.get("authorization");
        requestBody = await request.clone().text();
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      const config = configForProvider("openrouter", "vendor/selected-model", {
        OPENROUTER_API_KEY: "profile-key",
      });
      assert.ok(config);
      const model = await createModel(config);
      for await (const _event of new Agent({ model }).stream("hello")) {
        // Consume the real Strands/OpenAI stream to exercise the request path.
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requestUrl, "https://openrouter.ai/api/v1/chat/completions");
    assert.deepEqual(requestHeaders, ["accept", "authorization", "content-type"]);
    assert.equal(authorizationHeader, "Bearer profile-key");
    assert.equal(JSON.parse(requestBody).model, "vendor/selected-model");
  });

  it("resolves Vercel AI Gateway from a nonblank API key with its synchronous default model", () => {
    assert.deepEqual(configForProvider("vercel", undefined, { AI_GATEWAY_API_KEY: "key" }), {
      provider: "vercel",
      apiKey: "key",
      baseURL: "https://ai-gateway.vercel.sh/v1",
      modelId: "openai/gpt-5.6-luna",
    });
    assert.equal(configForProvider("vercel", undefined, { AI_GATEWAY_API_KEY: "  " }), null);
  });

  it("resolves the Vercel AI Gateway model override and gives explicit profile models precedence", () => {
    assert.equal(
      configForProvider("vercel", undefined, {
        AI_GATEWAY_API_KEY: "key",
        AI_GATEWAY_MODEL: "provider/model",
      })?.modelId,
      "provider/model",
    );
    assert.equal(
      configForProvider("vercel", undefined, {
        AI_GATEWAY_API_KEY: "key",
        GEOLIBRE_ASSISTANT_MODEL: "global/model",
        AI_GATEWAY_MODEL: "provider/model",
      })?.modelId,
      "global/model",
    );
    const profile: AssistantProfile = {
      id: "vercel-profile",
      name: "Vercel AI Gateway",
      provider: "vercel",
      modelId: "saved/model",
      fieldValues: { AI_GATEWAY_API_KEY: "profile-key" },
    };
    const env = { AI_GATEWAY_MODEL: "provider/model" };
    const profileWithEnvDefault: AssistantProfile = {
      ...profile,
      modelId: defaultModelFor("vercel", env),
    };
    assert.equal(defaultModelFor("vercel", env), "provider/model");
    assert.equal(defaultModelFor("vercel", {}), "openai/gpt-5.6-luna");
    assert.equal(configForProfile(profileWithEnvDefault, env)?.modelId, "provider/model");
    assert.equal(
      configForProfile(profile, {
        AI_GATEWAY_MODEL: "provider/model",
        GEOLIBRE_ASSISTANT_MODEL: "global/model",
      })?.modelId,
      "saved/model",
    );
  });

  it("sends a profile model to Vercel AI Gateway's Chat Completions endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestHeaders: string[] = [];
    let requestBody = "";
    let authorizationHeader: string | null = null;
    const chunks = [
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "openai/gpt-5.6-luna",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null },
        ],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "openai/gpt-5.6-luna",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];
    const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

    try {
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        requestUrl = request.url;
        requestHeaders = [...request.headers.keys()].sort();
        authorizationHeader = request.headers.get("authorization");
        requestBody = await request.clone().text();
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      const config = configForProvider("vercel", "vendor/selected-model", {
        AI_GATEWAY_API_KEY: "profile-key",
      });
      assert.ok(config);
      const model = await createModel(config);
      for await (const _event of new Agent({ model }).stream("hello")) {
        // Consume the real Strands/OpenAI stream to exercise the request path.
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requestUrl, "https://ai-gateway.vercel.sh/v1/chat/completions");
    assert.deepEqual(requestHeaders, ["accept", "authorization", "content-type"]);
    assert.equal(authorizationHeader, "Bearer profile-key");
    assert.equal(JSON.parse(requestBody).model, "vendor/selected-model");
  });
});
