import type { Model } from "@strands-agents/sdk";

/**
 * Supported LLM providers for the natural-language assistant. The boundary is
 * kept deliberately small and provider-pluggable: each provider maps to a
 * Strands model class that is dynamically imported so only the selected
 * provider's SDK is pulled into the bundle.
 */
export type AssistantProviderId = "google" | "anthropic" | "openai";

/** A fully resolved provider selection ready to build a model from. */
export interface AssistantProviderConfig {
  provider: AssistantProviderId;
  apiKey: string;
  modelId: string;
}

/**
 * Environment-variable names that supply an API key for each provider. The
 * first present, non-empty key wins. These are read from the user's
 * Settings → Environment variables (never hard-coded).
 */
const PROVIDER_KEY_NAMES: Record<AssistantProviderId, readonly string[]> = {
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};

/**
 * Selectable models per provider, recommended/newest first. The first entry is
 * the provider default (a capable, broadly-available model). Users can still pin
 * any other id via `GEOLIBRE_ASSISTANT_MODEL` or the model picker. Verified
 * against the providers' model docs as of 2026-06.
 */
export const PROVIDER_MODELS: Record<AssistantProviderId, readonly string[]> = {
  google: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
  anthropic: [
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
};

/** Default model per provider; override with `GEOLIBRE_ASSISTANT_MODEL`. */
const DEFAULT_MODEL: Record<AssistantProviderId, string> = {
  google: PROVIDER_MODELS.google[0],
  anthropic: PROVIDER_MODELS.anthropic[0],
  openai: PROVIDER_MODELS.openai[0],
};

/** Human-readable provider labels for the UI. */
export const PROVIDER_LABELS: Record<AssistantProviderId, string> = {
  google: "Google Gemini",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** Provider preference order when several keys are configured. */
const PROVIDER_ORDER: readonly AssistantProviderId[] = [
  "google",
  "anthropic",
  "openai",
];

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
    (window as unknown as { __GEOLIBRE_RUNTIME_ENV__?: RuntimeEnv })
      .__GEOLIBRE_RUNTIME_ENV__ ?? {}
  );
}

/** First non-empty value among `names` in `env`, or null. */
function firstKey(env: RuntimeEnv, names: readonly string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Resolve which provider/model/key to use from a runtime environment map.
 *
 * Honors an explicit `GEOLIBRE_ASSISTANT_PROVIDER` override, otherwise picks the
 * first provider (in {@link PROVIDER_ORDER}) that has a configured API key. The
 * model is `GEOLIBRE_ASSISTANT_MODEL` when set, else the provider default.
 *
 * @param env Runtime environment variables (defaults to {@link readRuntimeEnv}).
 * @returns A resolved config, or null when no provider key is configured.
 */
export function resolveProviderConfig(
  env: RuntimeEnv = readRuntimeEnv(),
): AssistantProviderConfig | null {
  const requested = env.GEOLIBRE_ASSISTANT_PROVIDER?.trim().toLowerCase();
  const order =
    requested && requested in PROVIDER_KEY_NAMES
      ? [requested as AssistantProviderId]
      : PROVIDER_ORDER;

  for (const provider of order) {
    const apiKey = firstKey(env, PROVIDER_KEY_NAMES[provider]);
    if (!apiKey) continue;
    const modelId =
      env.GEOLIBRE_ASSISTANT_MODEL?.trim() || DEFAULT_MODEL[provider];
    return { provider, apiKey, modelId };
  }
  return null;
}

/** True when at least one provider key is configured. */
export function hasProviderKey(env: RuntimeEnv = readRuntimeEnv()): boolean {
  return resolveProviderConfig(env) !== null;
}

/** The configured API key for a specific provider, or null. */
export function getApiKey(
  provider: AssistantProviderId,
  env: RuntimeEnv = readRuntimeEnv(),
): string | null {
  return firstKey(env, PROVIDER_KEY_NAMES[provider]);
}

/** Providers that currently have an API key, in preference order. */
export function availableProviders(
  env: RuntimeEnv = readRuntimeEnv(),
): AssistantProviderId[] {
  return PROVIDER_ORDER.filter((provider) => getApiKey(provider, env) !== null);
}

/** The default model id for a provider. */
export function defaultModelFor(provider: AssistantProviderId): string {
  return DEFAULT_MODEL[provider];
}

/**
 * Build a config for an explicitly chosen provider/model (the UI picker path).
 * Falls back to the env model override then the provider default when `model`
 * is omitted. Returns null when the chosen provider has no API key.
 *
 * @param provider The provider the user selected.
 * @param model An explicit model id, or undefined for the default.
 * @param env Runtime environment variables.
 */
export function configForProvider(
  provider: AssistantProviderId,
  model?: string,
  env: RuntimeEnv = readRuntimeEnv(),
): AssistantProviderConfig | null {
  const apiKey = getApiKey(provider, env);
  if (!apiKey) return null;
  const modelId =
    model?.trim() ||
    env.GEOLIBRE_ASSISTANT_MODEL?.trim() ||
    DEFAULT_MODEL[provider];
  return { provider, apiKey, modelId };
}

/**
 * Build a Strands {@link Model} for the resolved provider. The provider SDK is
 * dynamically imported so unused providers never enter the initial bundle.
 *
 * @param config A resolved provider selection.
 * @returns A ready-to-use Strands model instance.
 */
export async function createModel(
  config: AssistantProviderConfig,
): Promise<Model> {
  switch (config.provider) {
    case "google": {
      const { GoogleModel } = await import("@strands-agents/sdk/models/google");
      return new GoogleModel({
        apiKey: config.apiKey,
        modelId: config.modelId,
      }) as unknown as Model;
    }
    case "anthropic": {
      const { AnthropicModel } = await import(
        "@strands-agents/sdk/models/anthropic"
      );
      return new AnthropicModel({
        apiKey: config.apiKey,
        modelId: config.modelId,
      }) as unknown as Model;
    }
    case "openai": {
      const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
      return new OpenAIModel({
        apiKey: config.apiKey,
        modelId: config.modelId,
      }) as unknown as Model;
    }
  }
}
