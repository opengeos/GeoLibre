import type { Model } from "@strands-agents/sdk";

/**
 * Supported LLM providers for the natural-language assistant. The boundary is
 * kept deliberately small and provider-pluggable: each provider maps to a
 * Strands model class that is dynamically imported so only the selected
 * provider's SDK is pulled into the bundle. `ollama` and `custom` reuse the
 * OpenAI-compatible client against a configurable base URL.
 */
export type AssistantProviderId =
  | "google"
  | "anthropic"
  | "openai"
  | "ollama"
  | "bedrock"
  | "custom";

/** All provider ids, in auto-selection preference order. */
export const ASSISTANT_PROVIDER_IDS: readonly AssistantProviderId[] = [
  "google",
  "anthropic",
  "openai",
  "ollama",
  "bedrock",
  "custom",
];

/** AWS credentials for the Bedrock provider. */
export interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** A fully resolved provider selection ready to build a model from. */
export interface AssistantProviderConfig {
  provider: AssistantProviderId;
  modelId: string;
  /** API key for key-based providers (a placeholder for ollama/custom). */
  apiKey?: string;
  /** OpenAI-compatible base URL (ollama, custom). */
  baseURL?: string;
  /** AWS region (bedrock). */
  region?: string;
  /** AWS credentials (bedrock). */
  credentials?: BedrockCredentials;
}

/**
 * Environment-variable names that supply an API key for the key-based providers.
 * The first present, non-empty value wins. Read from the user's
 * Settings → Environment variables (never hard-coded).
 */
const PROVIDER_KEY_NAMES: Partial<Record<AssistantProviderId, readonly string[]>> = {
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};

/**
 * The environment variables GeoLibre sources from the user's OS environment (via
 * the `read_env_vars` Tauri command) so API keys can live in the system/shell
 * environment instead of the saved project file (issue #1141).
 *
 * This is deliberately a **curated subset** of the names the assistant can read,
 * not every one. It is limited to variables whose presence is a strong signal of
 * intent to use that provider with GeoLibre: the hosted AI keys, the
 * GeoLibre/Ollama/OpenAI-compatible-specific names, and the web-search key.
 *
 * Generic cloud credentials that developers routinely have in their shell for
 * unrelated work are **excluded** so GeoLibre never silently adopts them — most
 * importantly `AWS_*` (which would otherwise auto-activate Amazon Bedrock and
 * bill the user's AWS account for LLM calls they never intended) and the ambient
 * `OLLAMA_HOST`. Those providers remain available by entering credentials in
 * Settings → Environment Variables. The Rust `read_env_vars` command enforces
 * the same allowlist server-side (the `assistant-os-env` test asserts the two
 * lists match); that test also guards the inclusions and the exclusions.
 */
export const OS_ENV_VAR_NAMES: readonly string[] = [
  // Provider / model selection overrides.
  "GEOLIBRE_ASSISTANT_PROVIDER",
  "GEOLIBRE_ASSISTANT_MODEL",
  // Google Gemini.
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  // Anthropic.
  "ANTHROPIC_API_KEY",
  // OpenAI.
  "OPENAI_API_KEY",
  // Ollama (local). `OLLAMA_HOST` is intentionally omitted — it is the ambient
  // Ollama variable; `OLLAMA_BASE_URL` is GeoLibre's own documented setting.
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  // Custom OpenAI-compatible endpoint.
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_MODEL",
  // Web-search tool (Tavily).
  "TAVILY_API_KEY",
];

/**
 * Groups of {@link OS_ENV_VAR_NAMES} that are interchangeable aliases for one
 * credential. {@link firstValue} resolves aliases by *order*, not by source, so
 * without this a project value set under a different alias than the OS value
 * would not win — e.g. OS `GEMINI_API_KEY` would shadow a project `GOOGLE_API_KEY`
 * because it is checked first. {@link scopeOsEnvToProject} uses these groups so a
 * credential the project defines under any alias shadows every OS-sourced alias
 * of the same credential, keeping the "project always wins" precedence true.
 */
export const OS_ENV_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
  // ollamaBaseUrl() resolves OLLAMA_BASE_URL then OLLAMA_HOST for one credential.
  ["OLLAMA_BASE_URL", "OLLAMA_HOST"],
];

/**
 * Drop OS-sourced variables that the project already provides. An exact-name
 * collision is left to the caller's spread order, but an alias collision (the
 * project set a *different* alias of the same credential) is resolved here by
 * removing the whole OS-sourced alias group — see {@link OS_ENV_ALIAS_GROUPS}.
 *
 * @param osEnv Variables read from the OS environment.
 * @param projectKeys The names the project's Environment variables define.
 * @returns `osEnv` without any variable the project already covers.
 */
export function scopeOsEnvToProject(
  osEnv: RuntimeEnv,
  projectKeys: ReadonlySet<string>,
): RuntimeEnv {
  const scoped: RuntimeEnv = {};
  for (const [key, value] of Object.entries(osEnv)) {
    const group = OS_ENV_ALIAS_GROUPS.find((names) => names.includes(key));
    const shadowed = group ? group.some((name) => projectKeys.has(name)) : projectKeys.has(key);
    if (!shadowed) scoped[key] = value;
  }
  return scoped;
}

/** The environment sources merged into the runtime env, from lowest to highest precedence. */
export interface RuntimeEnvSources {
  /** Variables read from the OS environment (desktop only). Lowest precedence. */
  osEnv: RuntimeEnv;
  /** Device-local AI provider credentials (Settings -> AI Providers). */
  aiEnv: Record<string, string>;
  /** Derived `VITE_GEOCODER_*` variables from the geocoding preference. */
  geocoderEnv: Record<string, string>;
  /** The device-local Cesium Ion token as `VITE_CESIUM_TOKEN`, or empty. */
  cesiumEnv: Record<string, string>;
  /** The project's explicit Environment variables. Highest precedence. */
  projectEnv: Record<string, string>;
}

/**
 * Merge the runtime environment sources into a single record, applying the
 * precedence the app relies on: an explicit project Environment variable wins,
 * then the device-local AI provider keys, and the OS environment only fills the
 * remaining gaps. {@link scopeOsEnvToProject} additionally drops OS aliases that
 * a project or device credential already covers under a different alias, so the
 * "explicit value always wins" guarantee holds across alias collisions too.
 *
 * Extracted from `useRuntimeEnvironmentVariables` so the precedence ordering can
 * be unit-tested directly (swapping two spreads here is an easy silent bug).
 */
export function mergeRuntimeEnv({
  osEnv,
  aiEnv,
  geocoderEnv,
  cesiumEnv,
  projectEnv,
}: RuntimeEnvSources): RuntimeEnv {
  return {
    ...scopeOsEnvToProject(osEnv, new Set([...Object.keys(projectEnv), ...Object.keys(aiEnv)])),
    ...aiEnv,
    ...geocoderEnv,
    ...cesiumEnv,
    ...projectEnv,
  };
}

/**
 * Selectable models per provider, recommended/newest first. The first entry is
 * the provider default. Users can pin any other id via `GEOLIBRE_ASSISTANT_MODEL`
 * (or the per-provider env var) or the model picker. The hosted-model ids were
 * verified against the providers' docs as of 2026-06; the `ollama`/`bedrock`
 * lists are common examples (use your own via the env vars). `custom` has no
 * preset — supply the model with `OPENAI_COMPATIBLE_MODEL`.
 */
export const PROVIDER_MODELS: Record<AssistantProviderId, readonly string[]> = {
  google: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
  anthropic: ["claude-opus-4-8", "claude-fable-5", "claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
  ollama: ["llama3.2", "llama3.1", "qwen2.5", "mistral", "gemma2"],
  bedrock: [
    "global.anthropic.claude-sonnet-4-6",
    "global.anthropic.claude-opus-4-8",
    "global.anthropic.claude-haiku-4-5",
  ],
  custom: [],
};

/** Default model per provider (empty for `custom`, which requires its own). */
const DEFAULT_MODEL: Record<AssistantProviderId, string> = {
  google: PROVIDER_MODELS.google[0],
  anthropic: PROVIDER_MODELS.anthropic[0],
  openai: PROVIDER_MODELS.openai[0],
  ollama: PROVIDER_MODELS.ollama[0],
  bedrock: PROVIDER_MODELS.bedrock[0],
  custom: "",
};

/** Human-readable provider labels for the UI. */
export const PROVIDER_LABELS: Record<AssistantProviderId, string> = {
  google: "Google Gemini",
  anthropic: "Anthropic",
  openai: "OpenAI",
  ollama: "Ollama (local)",
  bedrock: "Amazon Bedrock",
  custom: "Custom (OpenAI-compatible)",
};

/**
 * Runtime environment map, populated from the user's Settings environment
 * variables by {@link ../../hooks/useRuntimeEnvironmentVariables}. Reading the
 * global keeps the assistant decoupled from React state and lets it pick up the
 * latest keys whenever a prompt is sent.
 */
export type RuntimeEnv = Record<string, string>;

/** Read the live runtime environment map, or `{}` outside the browser. */
export function readRuntimeEnv(): RuntimeEnv {
  if (typeof window === "undefined") return {};
  return (
    (window as unknown as { __GEOLIBRE_RUNTIME_ENV__?: RuntimeEnv }).__GEOLIBRE_RUNTIME_ENV__ ?? {}
  );
}

/** First non-empty value among `names` in `env`, or null. */
function firstValue(env: RuntimeEnv, ...names: string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** Normalize an Ollama host into an OpenAI-compatible `…/v1` base URL. */
function ollamaBaseUrl(env: RuntimeEnv): string | null {
  const raw = firstValue(env, "OLLAMA_BASE_URL", "OLLAMA_HOST");
  if (!raw) return null;
  let url = raw.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (!/\/v1$/i.test(url)) url = `${url}/v1`;
  return url;
}

/** The configured API key for a key-based provider, or null. */
export function getApiKey(
  provider: AssistantProviderId,
  env: RuntimeEnv = readRuntimeEnv(),
): string | null {
  const names = PROVIDER_KEY_NAMES[provider];
  return names ? firstValue(env, ...names) : null;
}

/** The default model id for a provider. */
export function defaultModelFor(provider: AssistantProviderId): string {
  return DEFAULT_MODEL[provider];
}

/** Resolve the model id for a provider: explicit → env → provider default. */
function resolveModelId(
  provider: AssistantProviderId,
  model: string | undefined,
  env: RuntimeEnv,
): string {
  const perProvider =
    provider === "ollama"
      ? env.OLLAMA_MODEL
      : provider === "bedrock"
        ? env.BEDROCK_MODEL
        : provider === "custom"
          ? env.OPENAI_COMPATIBLE_MODEL
          : undefined;
  return (
    model?.trim() ||
    env.GEOLIBRE_ASSISTANT_MODEL?.trim() ||
    perProvider?.trim() ||
    DEFAULT_MODEL[provider]
  );
}

/**
 * Build a config for an explicitly chosen provider/model (the UI picker path),
 * or null when that provider is not configured. Each provider type reads its own
 * Settings → Environment variables:
 *
 * - google / anthropic / openai — an API key (see {@link PROVIDER_KEY_NAMES}).
 * - ollama — `OLLAMA_BASE_URL` (or `OLLAMA_HOST`); keyless, local.
 * - bedrock — `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_REGION`,
 *   `AWS_SESSION_TOKEN`).
 * - custom — `OPENAI_COMPATIBLE_BASE_URL` (+ optional `OPENAI_COMPATIBLE_API_KEY`)
 *   and a model via `OPENAI_COMPATIBLE_MODEL`.
 */
export function configForProvider(
  provider: AssistantProviderId,
  model?: string,
  env: RuntimeEnv = readRuntimeEnv(),
): AssistantProviderConfig | null {
  const modelId = resolveModelId(provider, model, env);

  switch (provider) {
    case "google":
    case "anthropic":
    case "openai": {
      const apiKey = getApiKey(provider, env);
      if (!apiKey) return null;
      return { provider, apiKey, modelId };
    }
    case "ollama": {
      const baseURL = ollamaBaseUrl(env);
      if (!baseURL) return null;
      return { provider, apiKey: "ollama", baseURL, modelId };
    }
    case "custom": {
      const baseURL = firstValue(env, "OPENAI_COMPATIBLE_BASE_URL");
      if (!baseURL || !modelId) return null;
      const apiKey = firstValue(env, "OPENAI_COMPATIBLE_API_KEY") ?? "not-needed";
      return {
        provider,
        apiKey,
        baseURL: baseURL.replace(/\/+$/, ""),
        modelId,
      };
    }
    case "bedrock": {
      const accessKeyId = firstValue(env, "AWS_ACCESS_KEY_ID");
      const secretAccessKey = firstValue(env, "AWS_SECRET_ACCESS_KEY");
      if (!accessKeyId || !secretAccessKey) return null;
      const region = firstValue(env, "AWS_REGION", "AWS_DEFAULT_REGION") ?? "us-east-1";
      const sessionToken = firstValue(env, "AWS_SESSION_TOKEN") ?? undefined;
      return {
        provider,
        modelId,
        region,
        credentials: { accessKeyId, secretAccessKey, sessionToken },
      };
    }
  }
}

/**
 * Resolve which provider/model to use from a runtime environment map. Honors an
 * explicit `GEOLIBRE_ASSISTANT_PROVIDER` override, otherwise picks the first
 * configured provider in {@link ASSISTANT_PROVIDER_IDS} order.
 *
 * @param env Runtime environment variables (defaults to {@link readRuntimeEnv}).
 * @returns A resolved config, or null when no provider is configured.
 */
export function resolveProviderConfig(
  env: RuntimeEnv = readRuntimeEnv(),
): AssistantProviderConfig | null {
  const requested = env.GEOLIBRE_ASSISTANT_PROVIDER?.trim().toLowerCase();
  const order =
    requested && ASSISTANT_PROVIDER_IDS.includes(requested as AssistantProviderId)
      ? [requested as AssistantProviderId]
      : ASSISTANT_PROVIDER_IDS;

  for (const provider of order) {
    const config = configForProvider(provider, undefined, env);
    if (config) return config;
  }
  return null;
}

/** True when at least one provider is configured. */
export function hasProviderKey(env: RuntimeEnv = readRuntimeEnv()): boolean {
  return resolveProviderConfig(env) !== null;
}

/** Providers that are currently configured, in preference order. */
export function availableProviders(env: RuntimeEnv = readRuntimeEnv()): AssistantProviderId[] {
  return ASSISTANT_PROVIDER_IDS.filter(
    (provider) => configForProvider(provider, undefined, env) !== null,
  );
}

/**
 * Build a Strands {@link Model} for the resolved provider. The provider SDK is
 * dynamically imported so unused providers never enter the initial bundle.
 *
 * GeoLibre runs entirely client-side and the credentials are the user's own
 * (entered in their local Settings), so the OpenAI/Anthropic SDKs are opted into
 * browser mode — the same model as the existing GeoAgent plugin.
 *
 * @param config A resolved provider selection.
 * @returns A ready-to-use Strands model instance.
 */
export async function createModel(config: AssistantProviderConfig): Promise<Model> {
  switch (config.provider) {
    case "google": {
      const { GoogleModel } = await import("@strands-agents/sdk/models/google");
      return new GoogleModel({
        apiKey: config.apiKey,
        modelId: config.modelId,
      }) as unknown as Model;
    }
    case "anthropic": {
      const { AnthropicModel } = await import("@strands-agents/sdk/models/anthropic");
      return new AnthropicModel({
        apiKey: config.apiKey,
        modelId: config.modelId,
        clientConfig: { dangerouslyAllowBrowser: true },
      }) as unknown as Model;
    }
    case "openai": {
      const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
      return new OpenAIModel({
        apiKey: config.apiKey,
        modelId: config.modelId,
        clientConfig: { dangerouslyAllowBrowser: true },
      }) as unknown as Model;
    }
    case "ollama":
    case "custom": {
      // Ollama and custom endpoints speak the OpenAI Chat Completions API; the
      // Responses API (OpenAI's default) is not generally supported there.
      const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
      return new OpenAIModel({
        api: "chat",
        apiKey: config.apiKey ?? "not-needed",
        modelId: config.modelId,
        clientConfig: {
          baseURL: config.baseURL,
          dangerouslyAllowBrowser: true,
        },
      }) as unknown as Model;
    }
    case "bedrock": {
      const { BedrockModel } = await import("@strands-agents/sdk/models/bedrock");
      return new BedrockModel({
        modelId: config.modelId,
        region: config.region,
        clientConfig: {
          region: config.region,
          credentials: config.credentials,
        },
      }) as unknown as Model;
    }
  }
}
